import { createSystem, defineActor } from 'nodejs-actor-framework';

import {
  bridgeKernelEvents,
  normalizeDeadLetter,
  type ActorCrashHook,
  type DeadLetterLike,
  type ErrorHooks,
} from './errors.ts';
import { createAppLogger, type AppLogger, type LoggingConfig } from './logging.ts';
import {
  defineConfig,
  type ConfigSchema,
  type ConfigSchemaInput,
  loadConfig,
  type ConfigDefinition,
  type LoadedConfig,
} from './config.ts';

/**
 * 应用层装配（M1 步骤 2）。
 *
 * 用户只声明「有哪些 Actor、它们需要什么依赖、模块启动/停止时做什么」；
 * 内核（system / spawn / 监督 / 持久化）由本层负责，用户代码不接触内核细节。
 *
 * 依赖是**按名字**解析的，因此未知依赖与循环依赖都能在 `start()` 时立刻报错，
 * 而不是等到运行期才炸。
 */

/** 配置读取器（结构上与 LoadedConfig 一致，便于用户在自己的 Actor 里声明类型）。 */
export interface ConfigReader {
  get<T = unknown>(dottedPath: string): T;
  all(): Record<string, unknown>;
  redacted(): Record<string, unknown>;
  readonly sources: readonly string[];
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 注入给 Actor/provider 的依赖上下文：内置 config/log + 已解析的 provider。 */
export interface AppDeps {
  config: ConfigReader;
  log: Logger;
  [providerName: string]: unknown;
}

/** 应用层可见的 Actor 句柄（结构化类型，避免把内核类型暴露给用户）。 */
export interface ActorHandle {
  /** 与内核一致：第二个参数是超时毫秒数（不是 options 对象）。 */
  ask(message: unknown, timeoutMs?: number): Promise<unknown>;
  tell(message: unknown): void;
}

export type ProviderFactory = (deps: Record<string, unknown>) => unknown;

export interface ProviderSpec {
  /** 依赖的 provider 名字（会做未知依赖与循环依赖检查）。 */
  deps?: readonly string[];
  factory: ProviderFactory;
  /** 停止时释放资源（逆序调用）。 */
  dispose?: (value: unknown) => void | Promise<void>;
}

export interface ActorSpec {
  /** 普通类实例方法形态（receive/preStart/...）或普通函数，或内核 defineActor 的结果。 */
  definition: unknown;
  /** Actor 路径，默认取声明时的键名。 */
  id?: string;
  /** 构造函数需要的依赖名字；省略则传入完整依赖上下文。 */
  deps?: readonly string[];
  /** 透传给内核 spawn 的选项（监督策略、持久化、隔离等）。 */
  options?: Record<string, unknown>;
  /**
   * 该 Actor 崩溃时的回执（**只通知，不干预监督**）。
   *
   * 为什么不给"返回 stop/restart 决定重启"的形态：重启强度/升级策略是内核监督的职责，
   * 应用层再开一个控制面会让"到底谁决定重启"变得说不清。要改行为就调 `options.restart`
   * （透传给内核的监督策略），要停机就自己 `app.stop()`。
   */
  onCrash?: ActorCrashHook;
}

export interface PluginSpec {
  name: string;
  /**
   * 依赖的**插件能力名**（`name` 或别的插件 `provides` 出来的名字）。
   *
   * 审计（里程碑 M1）：`definePlugin` 一直没有 `requires`/`provides`，于是"插件依赖成环时启动失败
   * 并打印环"这条验收根本没实现（当时只有 **provider/DI** 级的环检测）。现在两者都有。
   */
  requires?: readonly string[];
  /** 除 `name` 之外额外提供的能力名（给"同一实现提供多个能力"留口子）。 */
  provides?: readonly string[];
  /** 依赖该插件的其它插件必须先于它 setup；声明顺序不再重要（会被拓扑排序）。 */
  description?: string;
  /**
   * 插件自己的配置 schema：会被合并进应用配置的 `plugins.<name>.*` 下（一套配置体系）。
   *
   * 允许 `Record<string, unknown>`：**底层包（db / mail 等）不依赖 `@actor/app`**，
   * 拿不到 `ConfigSchema`/`FieldSpec` 这两个类型，只能声明成宽形状。装配时本来就按 schema 用
   * （`plugin.config as ConfigSchema`）并在配置加载期做校验，所以这里放宽**不会**让错配置通过 ——
   * 错配置仍然在启动期被拒。修这个是因为：不放宽的话，用户直接把 `databasePlugin(...)` /
   * `mailPlugin(...)` 放进 `plugins: []` 会吃到类型错误（examples 接进 typecheck 时实测到）。
   */
  config?: ConfigSchema | Record<string, unknown>;
  /**
   * 贡献给内核的能力插件（不透明类型：应用层不暴露内核内部类型）。
   * 内置能力用 packages/app/src/plugins.ts 的包装函数生成。
   */
  kernelPlugins?: readonly unknown[];
  /** 在 provider 解析与 Actor spawn 之前执行。 */
  setup?: (app: Application, config: Record<string, unknown>) => void | Promise<void>;
  /** 全部 Actor 已 spawn、模块 onStart 已完成之后执行（此时端口监听等"就绪"动作才安全）。 */
  onReady?: (app: Application) => void | Promise<void>;
  /** 停止流程的**第一步**：先停收新请求 / 释放入口，再等内核收尾。 */
  onStopping?: (app: Application) => void | Promise<void>;
  /** 在模块 onStop 与内核停止之后执行（逆序）。 */
  teardown?: (app: Application) => void | Promise<void>;
  /**
   * 插件贡献的路由（**不透明类型**：应用层不依赖 Web 层，由 httpPlugin 解释）。
   * 配合 `routePrefix` 使用；与模块路由同样进 `app.routes`。
   */
  routes?: readonly unknown[];
  /** 插件路由前缀（由 Web 层的 `defineWebPlugin` 在定义时套到每个模式上）。 */
  routePrefix?: string;
  /**
   * **框架自带**标记（只有 `@actor/*` 的插件工厂会设它）。
   *
   * 用途是一个安全判断：装配期"保留路由前缀"校验只放行框架自己的插件占用 `/uploads`、`/__debug`
   * ——没有这个标记就无法区分"框架插件"与"恰好同名的第三方插件"（`PluginSpec.name` 是自由字符串）。
   * 用户插件请勿设置：设了就等于宣称自己是框架插件。
   */
  framework?: true;
  /**
   * 插件贡献的中间件（**不透明类型**）：可以是函数，也可以是
   * `{ handler, phase }`（Web 层按阶段排序；见 `defineWebPlugin`）。
   */
  middleware?: readonly unknown[];
}

export interface ModuleSpec {
  name: string;
  imports?: readonly ModuleSpec[];
  providers?: Record<string, ProviderSpec | ProviderFactory>;
  actors?: Record<string, ActorSpec | unknown>;
  onStart?: (app: Application) => void | Promise<void>;
  onStop?: (app: Application) => void | Promise<void>;
  plugins?: readonly PluginSpec[];
  /** 扁平路由声明（不透明类型：应用层不依赖 Web 层，由 httpPlugin 解释）。 */
  routes?: readonly unknown[];
  /** 嵌套路由器（不透明类型，与 routes 互斥——R3：显式优于隐式）。 */
  router?: unknown;
  /** 模块级中间件：作用于本模块声明的所有路由（子树语义，R1）。 */
  middleware?: readonly unknown[];
  /**
   * 模块级的**诊断可见性**（M9g 的 debug 四层作用域之一；由 `debugPlugin` 解释）。
   *
   * 结构（不透明，避免应用层依赖 Web 层）：`{ expose?: false, hidePrefixes?: string[] }`。
   * 语义边界：**只影响诊断输出暴露什么，不影响路由是否可用、也不改变鉴权** —— 见设计文档 §6。
   */
  debug?: unknown;
}

export interface AppSpec<S extends ConfigSchemaInput = ConfigSchemaInput> {
  /** 应用配置定义：schema 支持全量写法与**简写（值即 schema）**混用。 */
  config?: ConfigDefinition;
  modules: readonly ModuleSpec[];
  plugins?: readonly PluginSpec[];
  /** 全局中间件（不透明类型：应用层不依赖 Web 层，由 web 插件解释）。 */
  middleware?: readonly unknown[];
}

export interface CreateAppOptions {
  configDir?: string;
  /**
   * **错误出口**（P1）：把内核与 Web 层的失败显式送到应用层。
   *
   * 不注册任何钩子 = 不转发（默认静默，行为与从前一致）；细节见 `./errors.ts`。
   */
  errors?: ErrorHooks;
  /**
   * **统一日志入口**（P2）：一处配好级别/过滤/脱敏/上下文字段，三类事件汇到一个出口。
   * 不给 `logger` 就走 console 兜底（与从前行为一致）；细节见 `./logging.ts`。
   */
  logging?: LoggingConfig;
  env?: Record<string, string | undefined>;
  envPrefix?: string;
  overrides?: Record<string, unknown>;
  /** 透传给内核 createSystem 的选项。 */
  kernel?: Record<string, unknown>;
}

export interface AssemblyIssue {
  message: string;
  /** 谁提出的这个依赖（便于定位）。 */
  requester?: string;
}

export class AssemblyError extends Error {
  readonly issues: AssemblyIssue[];
  constructor(issues: AssemblyIssue[]) {
    super(
      `装配失败（${issues.length} 项）：\n` +
        issues.map((i) => `  - ${i.message}${i.requester ? `（来自 ${i.requester}）` : ''}`).join('\n'),
    );
    this.name = 'AssemblyError';
    this.issues = issues;
  }
}

/**
 * **框架保留的服务名**（唯一来源：装配期校验与文档都读它）。
 *
 * 为什么要有它：服务名是**全局命名空间**（`app.provide(name, value)` → `ctx.get(name)`），
 * 而框架自己也占着几个名字。用户插件用同一个名字注册时，装配期会变成"同一作用域里的两次注册"，
 * 后果取决于顺序 —— 属于静默覆盖那一类。所以这里显式守住，撞上就**明确报错**。
 *
 * 两段组成：
 *   1. `config` / `log` 是**内置依赖**（`resolveProvider` 直接短路，任何人都不该重注册）；
 *   2. 框架插件注册的服务名（`httpServer` / `wsConnections` 由 Web 层提供）；
 *   3. 命名空间 `@actor/` —— 框架内部服务一律带这个前缀（`@actor/web:contextHooks` 等），
 *      所以"以 `@actor/` 开头"本身就是保留规则，不需要逐个登记（新加内部服务也不会漏）。
 */
export const RESERVED_SERVICE_NAMES: readonly string[] = [
  // 内置依赖
  'config',
  'log',
  // 框架插件占用
  'httpServer',
  'wsConnections',
  // 命名空间（框架内部服务都在这儿；登记一个是为了让"规则"本身可被断言）
  '@actor/',
];

/**
 * 服务名是否保留（前缀以 `/` 结尾的按**命名空间**匹配，其余按精确名匹配）。
 *
 * 导出它是因为"保留规则"必须能被门禁与文档读到 —— 而不是散在 `provide()` 的 if 里。
 */
export function isReservedServiceName(name: string): boolean {
  return RESERVED_SERVICE_NAMES.some((reserved) =>
    reserved.endsWith('/') ? name.startsWith(reserved) : name === reserved,
  );
}

function isPluginSpecLike(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    ((value as { name: string }).name.length > 0)
  );
}

/**
 * 在"看起来像插件 spec / 内核插件"的对象图里找**保留服务名**（有界深度遍历，绝不猜）。
 *
 * 为什么需要：用户写的是 `plugin({ name: '@actor/http', kernelPlugins: [httpPlugin()] })` —— 撞名在
 * 内层插件对象上，而装配期只知道外层。深度上限 + try/catch 保证"遍历失败就不报错"，
 * 不会因为某个对象有副作用 getter 就把启动搞崩（宁可漏报，不可误杀启动）。
 */
export function reservedServiceNamesIn(value: unknown, depth = 4): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  const walk = (node: unknown, remaining: number): void => {
    if (remaining < 0 || node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    let record: Record<string, unknown>;
    try {
      record = node as Record<string, unknown>;
    } catch {
      return;
    }
    const candidate = record['name'];
    if (typeof candidate === 'string' && isReservedServiceName(candidate)) found.add(candidate);
    if (!isPluginSpecLike(node)) return;
    for (const key of ['provides', 'kernelPlugins']) {
      const child = record[key];
      if (Array.isArray(child)) for (const item of child) walk(item, remaining - 1);
    }
  };
  walk(value, depth);
  return [...found];
}

/**
 * 取不到 Actor 时抛出：本地没有 spawn，集群发现里也没有。
 *
 * 刻意**不继承 AssemblyError**：装配错误是启动期问题（配置/依赖写错，应让 start() 失败），
 * 而这是运行期的**寻址失败**——一次请求找不到目标应当映射成 404，而不是 500
 * （Web 层按 `name` 判定，见 packages/web/src/context.ts 的 toErrorResponse）。
 */
export class ActorNotResolvableError extends Error {
  readonly actorName: string;
  constructor(actorName: string) {
    super(`不存在名为 '${actorName}' 的 Actor（本地未 spawn，集群发现也没有找到）`);
    this.name = 'ActorNotResolvableError';
    this.actorName = actorName;
  }
}

function isProviderSpec(value: ProviderSpec | ProviderFactory): value is ProviderSpec {
  return typeof value === 'object' && value !== null && 'factory' in value;
}

function isActorSpec(value: ActorSpec | unknown): value is ActorSpec {
  return (
    typeof value === 'object' && value !== null && 'definition' in (value as Record<string, unknown>)
  );
}

function isClass(value: unknown): value is new (...args: unknown[]) => unknown {
  return typeof value === 'function' && (value as { prototype?: object }).prototype !== undefined;
}

/** 声明一个模块（只做形状规整，实际解析发生在 start()）。 */
export function defineModule(spec: ModuleSpec): ModuleSpec {
  return spec;
}

/** 声明一个插件（用户自定义扩展点）。 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  return spec;
}

/** 把插件 schema 合并进应用 schema，使插件配置与应用配置走同一套加载/校验/环境变量机制。 */
function mergePluginSchemas(base: ConfigSchema | undefined, plugins: readonly PluginSpec[]): ConfigSchema {
  const withConfig = plugins.filter((p) => p.config);
  if (withConfig.length === 0) return base ?? {};
  const section: ConfigSchema = {};
  for (const plugin of withConfig) section[plugin.name] = plugin.config as ConfigSchema;
  return { ...(base ?? {}), plugins: { ...(base?.plugins as ConfigSchema | undefined), ...section } };
}

/** 声明一个应用。 */
export function defineApp<S extends ConfigSchemaInput>(spec: AppSpec<S>): AppSpec<S> {
  return spec;
}

export class Application {
  private readonly providerSpecs = new Map<string, ProviderSpec>();
  private readonly actorSpecs = new Map<string, ActorSpec>();
  /**
   * 路径 → { 定义, spawn 选项 }（M4 第 3b 步）。
   *
   * 集群接管时需要"用同一个定义把 Actor 在新 owner 上重建"，而"这个 actorId 是哪个定义、用什么
   * 持久化选项"是**应用层**的知识（模块的 `actors:` 声明 + 依赖注入）。所以在这里记账，并在启动后
   * 把它交给内核的 `ownership.recreate`。
   */
  private readonly actorDefinitions = new Map<string, { definition: unknown; options: Record<string, unknown>; actorName: string }>();
  private readonly providerValues = new Map<string, unknown>();
  private readonly handles = new Map<string, ActorHandle>();
  /** 审计 F14：`listening` 监听器的句柄，停机时注销（原来只 on 不 off）。 */
  _recreateInstaller: (() => void) | null = null;
  private readonly modules_: ModuleSpec[] = [];
  private readonly pluginSpecs: PluginSpec[] = [];
  private readonly routeSpecs: unknown[] = [];
  private readonly disposedProviders: string[] = [];
  /** 插件注册的服务（控制器用 ctx.get(name) 取用）。 */
  private readonly services = new Map<string, unknown>();
  /** 极简事件总线：订阅者抛错不影响请求主流程。 */
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private loadedConfig: LoadedConfig | null = null;
  private system: unknown = null;
  /** 统一日志路由器（P2）：`logging.logger` 给了才非 null。 */
  private readonly logRouter: AppLogger | null;
  /**
   * 路径 → 该 Actor 的崩溃回执（`ActorSpec.onCrash`；只通知，不干预监督）。
   *
   * 键用**声明路径 + 内核实际路径**两套都登记：内核给的 `actor_crash` meta 里的 `path`
   * 可能与 `spawn({ id })` 的路径形态不同（例如带系统前缀），只登记一套会静默查不到。
   */
  private readonly crashHooks = new Map<string, ActorCrashHook>();
  /** 内核事件桥的清理句柄（停机时摘掉；重复 start 不会叠加）。 */
  private bridgeDispose: (() => void) | null = null;
  /** `app.on('http:error')` 的退订句柄（与内核桥一起摘）。 */
  private httpErrorOff: (() => void) | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  /** 上一次 start() 的失败原因；非 null 时拒绝再次 start（避免“第二次静默成功”）。 */
  private startFailure: Error | null = null;

  private readonly spec: AppSpec;
  private readonly options: CreateAppOptions;

  constructor(spec: AppSpec, options: CreateAppOptions = {}) {
    this.spec = spec;
    this.options = options;
    // 日志路由器只需要配置，不需要加载配置/启动内核 → 构造期就建好，
    // 这样插件在 setup 阶段就能通过 `app.logSink` 用上统一出口。
    this.logRouter = options.logging === undefined ? null : createAppLogger(options.logging);
  }

  /**
   * **统一日志出口**（P2；插件用）：把插件自己的事件按统一策略记出去。
   *
   * 没配 `logging.logger` 时是 null —— 插件应当**自己兜底**（通常是 console），
   * 而不是把日志丢掉（库代码不决定输出，但也不能吞掉可观测性）。
   */
  get logSink(): ((family: 'app' | 'kernel' | 'http' | 'plugin', event: string, meta?: Record<string, unknown>) => void) | null {
    if (this.logRouter === null) return null;
    return (family, event, meta) => this.logRouter?.publish(family, event, meta);
  }

  /** 脱敏关键词覆盖（`logging.redactKeywords`；没配就是 undefined = 用 Web 层默认名单）。 */
  get redactKeywords(): readonly string[] | undefined {
    return this.logRouter?.redactKeywords;
  }

  get config(): LoadedConfig {
    if (!this.loadedConfig) throw new Error('配置尚未加载：请先 start()');
    return this.loadedConfig;
  }

  /** 模块声明的路由（由 Web 层插件解释；应用层不做解释，保持依赖方向）。 */
  /**
   * 全局中间件（由 web 层插件解释；应用层不依赖 Web 层，保持依赖方向）。
   *
   * 顺序：显式声明的全局中间件在前（保持既有行为），随后是各插件贡献的中间件
   * （插件按声明顺序；Web 层再按 `phase` 稳定排序）。
   */
  get middleware(): readonly unknown[] {
    // 必须读 `pluginSpecs`（拓扑序，含 `defineModule({ plugins })` 声明的插件）。
    // 只读顶层 `spec.plugins` 会静默丢掉模块级插件贡献的中间件 —— 声明式鉴权因此被绕过。
    // start() 之前 `pluginSpecs` 还是空的（collect 在 start 里）；先给顶层插件一个可用的
    // 视图，避免 `app.middleware` 在装配前读不到声明。
    const source = this.pluginSpecs.length > 0 ? this.pluginSpecs : (this.spec.plugins ?? []);
    const pluginMiddleware = source.flatMap((plugin) => plugin.middleware ?? []);
    return [...(this.spec.middleware ?? []), ...pluginMiddleware];
  }

  get routes(): readonly unknown[] {
    // 插件路由追加在模块路由之后（模块路由还带自己的子树中间件，见 collect）。
    // 同 middleware：模块级插件也必须生效。
    const source = this.pluginSpecs.length > 0 ? this.pluginSpecs : (this.spec.plugins ?? []);
    const pluginRoutes = source.flatMap((plugin) => plugin.routes ?? []);
    return [...this.routeSpecs, ...pluginRoutes];
  }

  /**
   * 已声明的插件（按依赖拓扑排序后的顺序）。
   *
   * 公开它是为了 Web 层那类"只有看得到全部插件才能做的校验"（例如"哪片路由前缀是哪个插件占的"），
   * 以及诊断输出 —— 而不是让下游去猜（早先 Web 层只能硬编码插件名，那种口径一定会分叉）。
   */
  get plugins(): readonly PluginSpec[] {
    return this.pluginSpecs;
  }

  /**
   * 已收集的模块（含 imports 展开后的顺序）。
   *
   * 公开理由与 `plugins` 相同：诊断类插件需要读模块级声明（例如 `defineModule({ debug })`
   * 的可见性作用域），而应用层不解释它的内容（`debug` 是不透明类型，由 Web 层解读）。
   */
  get modules(): readonly ModuleSpec[] {
    return this.modules_;
  }

  /** 逃生通道：高级用法可直接访问内核 system（应用层签名不依赖它）。 */
  get kernel(): unknown {
    return this.system;
  }

  /**
   * 取一个 Actor 句柄。
   *
   * 顺序：**本地已 spawn 的 Actor** → **内核按名字解析**（装了 cluster 插件时，这会让
   * `ctx.actor('player_001')` 触达其它节点上的 Actor，且调用方无需知道它在哪台机器上）。
   * 都找不到时抛出 `ActorNotResolvableError`（带 Actor 名字，而不是静默返回 undefined）。
   * 注意它是**运行期寻址失败**：调用方（如 Web 层）应把它当成 404，而不是 500。
   */
  actor(name: string): ActorHandle {
    const handle = this.handles.get(name);
    if (handle) return handle;

    // 位置透明：本地没有就交给内核解析（内核在装了集群插件时会查 gossip 索引，
    // 返回一个首次使用时才建立连接的 ref；没装集群插件时返回空）。
    if (this.system) {
      const system = this.system as { resolve?: (path: string) => ActorHandle | null | undefined };
      if (typeof system.resolve === 'function') {
        try {
          const resolved = system.resolve(name);
          if (resolved) return resolved;
        } catch {
          /* 未发现：落到下面的明确报错 */
        }
      }
    }
    throw new ActorNotResolvableError(name);
  }

  /** 取一个已解析的 provider 或插件注册的服务（供控制器、测试与插件使用）。 */
  get<T = unknown>(name: string): T {
    if (this.providerValues.has(name)) return this.providerValues.get(name) as T;
    if (this.services.has(name)) return this.services.get(name) as T;
    throw new AssemblyError([
      { message: `provider/服务 '${name}' 尚未解析或注册`, requester: '(app.get)' },
    ]);
  }

  /** 订阅事件（返回取消订阅函数）。 */
  on(event: string, listener: (payload: never) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (payload: unknown) => void);
  }

  /** 发布事件：订阅者抛错只记录，绝不影响请求主流程。 */
  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        // console-ok: 事件订阅者抛错与日志出口无关，且 emit 在停机路径上（不能依赖外部 logger）
        console.error(`[events] '${event}' 的订阅者抛错：`, error);
      }
    }
  }

  /**
   * 安装**错误出口**（P1）：内核日志/崩溃/死信/系统故障 + Web 层 5xx → 应用层钩子。
   *
   * 没给 `errors` 就什么都不装（默认静默）。重复 start 不叠加（先摘旧的）。
   */
  private installErrorHooks(): void {
    // Actor 级 `onCrash` 是**独立声明**的：即使没配全局 `errors`，它也必须被调用
    // （早先只在配了 `errors` 时才装桥，于是 `onCrash` 被静默忽略 —— 实测踩到）。
    // 注意时机：这里在 spawn **之前**执行，所以看的是**声明**里有没有 onCrash，
    // 而不是 `crashHooks`（那时还没登记）。
    const declared: ErrorHooks = this.options.errors ?? {};
    const anyPerActorCrash = [...this.actorSpecs.values()].some((spec) => typeof spec.onCrash === 'function');
    const hasAnyOutlet =
      declared.onKernelLog !== undefined ||
      declared.onActorCrash !== undefined ||
      declared.onDeadLetter !== undefined ||
      declared.onSystemFailure !== undefined ||
      declared.onHttpError !== undefined ||
      anyPerActorCrash;
    if (!hasAnyOutlet) return; // 一个出口都没声明：不装监听（零开销，行为与从前一致）

    const hooks: ErrorHooks = {
      ...declared,
      // 只有 per-actor onCrash 时，也要让桥订阅内核日志（否则它没有触发点）
      ...(anyPerActorCrash && declared.onActorCrash === undefined && declared.onKernelLog === undefined
        ? { onActorCrash: () => undefined }
        : {}),
    };
    this.bridgeDispose?.();
    this.httpErrorOff?.();
    this.bridgeDispose = null;
    this.httpErrorOff = null;

    if (this.system !== null) {
      this.bridgeDispose = bridgeKernelEvents(
        this.system as Parameters<typeof bridgeKernelEvents>[0],
        hooks,
        {
          // 声明名比路径更好读（`actors: { Counter: … }` → `Counter`）；推不出来就用路径
          nameOf: (path) => this.actorNameOf(path),
          onCrash: (path) => this.crashHooks.get(path),
        },
        // 给了 logger：内核日志已直达出口，桥只负责崩溃回执（避免重复）
        { includeKernelLog: this.logRouter === null || !this.logRouter.handlesKernel },
      );
    }

    if (hooks.onHttpError !== undefined) {
      const off = this.on('http:error', ((info: {
        requestId: string;
        status: number;
        path: string | null;
        method: string | null;
        error: unknown;
      }) => {
        try {
          hooks.onHttpError?.(info);
        } catch (error) {
          // console-ok: 同上——钩子自己坏了，不能再走钩子
          console.error('[errors] onHttpError 钩子抛错（已忽略，不影响请求）：', error);
        }
      }) as (payload: never) => void);
      this.httpErrorOff = off;
    }
  }

  /** 内核路径 → 声明名（`actors: { Counter: … }` 的键）；两条路径形态都认。 */
  private actorNameOf(kernelPath: string): string | undefined {
    for (const [path, entry] of this.actorDefinitions) {
      if (path === kernelPath || String(entry.options.id ?? '') === kernelPath) return entry.actorName;
    }
    return undefined;
  }

  /**
   * 读**死信**（消息没送达/被丢弃的记录）：装了 `deadLetters` 插件就读落盘的那份，否则读内存环。
   *
   * 为什么要给这个入口：死信是"消息静默丢了"的唯一证据；`tell` 是 fire-and-forget，
   * 想知道失败就必须 `ask` —— 这条语义边界见文档。
   */
  async deadLetters(): Promise<DeadLetterLike[]> {
    const system = this.system as { readDeadLetters?: () => Promise<unknown[]> } | null;
    if (system === null || typeof system.readDeadLetters !== 'function') return [];
    const entries = await system.readDeadLetters();
    // 两套形状（内存环 / 落盘队列）在这里统一 —— 见 `normalizeDeadLetter` 的注释
    return Array.isArray(entries) ? entries.map((entry) => normalizeDeadLetter(entry)) : [];
  }

  /**
   * 清空死信（内存环 + 落盘的那份），返回**清掉的条数**。
   *
   * 注意内核的实现：装了 `deadLetters` 插件时内存环是空的（落盘队列才是权威），
   * 内核的 `clearDeadLetters()` 就只数了内存环 → 返回 0（实际文件被清了）。
   * 所以这里先读一遍再清，把两边的条数如实报出来（否则"清了 0 条"会让人以为没生效）。
   */
  async clearDeadLetters(): Promise<number> {
    const system = this.system as
      | { clearDeadLetters?: () => Promise<number>; readDeadLetters?: () => Promise<unknown[]> }
      | null;
    if (system === null || typeof system.clearDeadLetters !== 'function') return 0;
    const before = typeof system.readDeadLetters === 'function' ? (await system.readDeadLetters()).length : 0;
    const reported = await system.clearDeadLetters();
    return Math.max(reported, before);
  }

  /**
   * 插件注册服务（例如 wsPlugin 注册连接注册表）；重复注册报错，避免静默覆盖。
   *
   * **保留名不在这里拦**：运行时 `provide('httpServer', …)` 的调用者既可能是框架插件（必须允许），
   * 也可能是用户插件（应当拒绝），而这里只看得到名字 —— 分不出来。所以保留名改在**声明层**拦：
   * 插件的 `name`/`provides` 与模块 provider 的名字（装配期就能看到）撞上 `RESERVED_SERVICE_NAMES` 即报错。
   * 这条"哪一层拦得住"的边界是实测出来的：早先按名字拦，结果 `httpPlugin` 自己注册 `httpServer` 就被拒了。
   */
  provide(name: string, value: unknown): void {
    if (this.services.has(name)) {
      throw new AssemblyError([{ message: `服务 '${name}' 被重复注册`, requester: '(app.provide)' }]);
    }
    this.services.set(name, value);
  }

  async start(): Promise<this> {
    if (this.started) return this;
    if (this.startFailure !== null) {
      throw new AssemblyError([
        { message: `上一次 start() 已失败（${this.startFailure.message}）；请创建新的 Application 后重试` },
      ]);
    }
    try {
      await this._start();
      this.started = true;
      return this;
    } catch (err) {
      this.startFailure = err instanceof Error ? err : new Error(String(err));
      await this._rollbackStart();
      throw err;
    }
  }

  /** 启动失败时逆序回收已建立的资源，避免“第一次失败、第二次静默成功”。 */
  private async _rollbackStart(): Promise<void> {
    for (const plugin of [...this.pluginSpecs].reverse()) {
      try {
        await plugin.onStopping?.(this);
      } catch {
        /* 回收失败不掩盖原始启动错误 */
      }
    }
    if (this.system) {
      try {
        await (this.system as { stop(options?: { timeoutMs?: number }): Promise<void> }).stop({ timeoutMs: 5000 });
      } catch {
        /* 原始错误优先 */
      }
    }
    for (const plugin of [...this.pluginSpecs].reverse()) {
      try {
        await plugin.teardown?.(this);
      } catch {
        /* 同上 */
      }
    }
    this.bridgeDispose?.();
    this.bridgeDispose = null;
    this.httpErrorOff?.();
    this.httpErrorOff = null;
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private async _start(): Promise<void> {
    // 1) 收集模块与插件 —— 必须先做：插件的配置 schema 要参与第 2 步的配置合并
    const issues: AssemblyIssue[] = [];
    this.collect(this.spec.modules, issues);
    for (const plugin of this.spec.plugins ?? []) {
      if (this.pluginSpecs.some((p) => p.name === plugin.name)) {
        issues.push({ message: `插件 '${plugin.name}' 被重复声明`, requester: '(app.plugins)' });
        continue;
      }
      this.pluginSpecs.push(plugin);
    }
    if (issues.length > 0) throw new AssemblyError(issues);

    // 1b) 插件依赖图：未知依赖 + 循环依赖（审计 M1：这条验收过去根本没实现）
    const orderedPlugins = this.orderPlugins(this.pluginSpecs, issues);
    this.pluginSpecs.length = 0;
    this.pluginSpecs.push(...orderedPlugins);
    if (issues.length > 0) throw new AssemblyError(issues);

    // 1c) 保留服务名：插件**名字**与**内核能力插件**都可能占用服务名命名空间
    // （`plugin({ name: '@actor/http', kernelPlugins: [httpPlugin()] })`），而装配期只看得到外层声明
    // → 这里在声明图上做一次有界遍历。用户插件（没有 framework 标记）撞上保留名一律报错。
    for (const plugin of this.pluginSpecs) {
      if (plugin.framework === true) continue;
      // 框架命名空间的名字由框架自己用（`@actor/web:contextHooks` 这类内部服务）
      if (plugin.name.startsWith('@actor/')) continue;
      const reserved = reservedServiceNamesIn(plugin);
      if (reserved.length === 0) continue;
      issues.push({
        message:
          `插件 '${plugin.name}' 使用了框架保留服务名（${reserved.join(', ')}）—— ` +
          `请改用别的名字；要复用框架能力就 ctx.get(...)，不要自己 provide`,
        requester: plugin.name,
      });
    }
    // 模块 provider 的名字也是服务名（`ctx.get(name)` 取的就是它）→ 同样不许撞保留名。
    // 框架自己的 provider（`@actor/…` 命名空间）放行：那是框架内部约定。
    for (const name of this.providerSpecs.keys()) {
      if (!isReservedServiceName(name) || name.startsWith('@actor/')) continue;
      issues.push({
        message:
          `provider '${name}' 使用了框架保留服务名（保留清单见 @actor/app 的 RESERVED_SERVICE_NAMES）—— ` +
          `请改用别的名字；要复用框架能力就 ctx.get('${name}')`,
        requester: '(provider)',
      });
    }
    if (issues.length > 0) throw new AssemblyError(issues);

    // 2) 配置：插件 schema 合并进应用 schema，走同一套加载/校验/环境变量机制
    const baseSchema = (this.spec.config?.schema ?? {}) as ConfigSchema;
    const definition = defineConfig(mergePluginSchemas(baseSchema, this.pluginSpecs));
    this.loadedConfig = await loadConfig(definition, {
      ...(this.options.configDir === undefined ? {} : { configDir: this.options.configDir }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.envPrefix === undefined ? {} : { envPrefix: this.options.envPrefix }),
      ...(this.options.overrides === undefined ? {} : { overrides: this.options.overrides }),
    });

    // 3) 插件 setup（在 provider 解析与 Actor spawn 之前）
    for (const plugin of this.pluginSpecs) {
      const pluginConfig: Record<string, unknown> = {};
      for (const key of Object.keys(plugin.config ?? {})) {
        pluginConfig[key] = this.config.get(`plugins.${plugin.name}.${key}`);
      }
      await plugin.setup?.(this, pluginConfig);
    }

    // 4) 解析全部 provider：未知依赖与循环依赖在此暴露
    const resolveIssues: AssemblyIssue[] = [];
    for (const name of this.providerSpecs.keys()) this.resolveProvider(name, [], resolveIssues);
    if (resolveIssues.length > 0) throw new AssemblyError(resolveIssues);

    // 5) 启动内核并 spawn Actor —— 插件贡献的内核能力在此一次性装入
    // （显式启用：未声明的能力不会被挂上，内核的加载面因此可控）
    const contributed = this.pluginSpecs.flatMap((plugin) => plugin.kernelPlugins ?? []);
    const explicitKernel = this.options.kernel ?? {};
    const kernelOptions: Record<string, unknown> = { ...explicitKernel };
    if (explicitKernel['logger'] === undefined) {
      // 没配 logging.logger 时保持**从前行为**（内核日志关闭，不产生新输出）；
      // 配了就把内核日志接进统一出口（`kernel:*`）。
      kernelOptions['logger'] =
        this.logRouter === null || !this.logRouter.handlesKernel
          ? false
          : (event: string, meta?: Record<string, unknown>) => this.logRouter?.publish('kernel', `kernel:${event}`, meta);
    }
    if (contributed.length > 0) {
      const existing = (kernelOptions.plugins as readonly unknown[] | undefined) ?? [];
      kernelOptions.plugins = [...existing, ...contributed];
    }
    this.system = createSystem(kernelOptions);
    const system = this.system as { spawn: (d: unknown, o: unknown) => Promise<ActorHandle> };
    // 4b) **错误出口**：把内核后台事件与 Web 层 5xx 送到应用层（没给钩子就什么都不装）
    this.installErrorHooks();
    // 装了集群插件时，把"路径 → 定义"交给它：接管别的节点交出来的 Actor 时内核会回调这里。
    // 注意时机：插件的 setup 发生在**内核 init（listen）时**，所以这里先试一次，并挂到 'listening'
    // 上再装一次——否则 ownership 还不存在，钩子会静默装不上（真踩过）。
    const installRecreate = (): void => {
      const ownership = (this.system as { ownership?: { recreate?: unknown } } | null)?.ownership;
      if (ownership) ownership.recreate = (path: string) => this.actorDefinitions.get(String(path)) ?? null;
    };
    installRecreate();
    // 审计 F14：记下句柄，停机时注销（原来只 on 不 off）
    this._recreateInstaller = installRecreate;
    (this.system as { on?: (event: string, fn: () => void) => void }).on?.('listening', installRecreate);
    for (const [name, actorSpec] of this.actorSpecs) {
      this.handles.set(name, await this.spawnActor(system, name, actorSpec));
    }
    // 第一次 spawn 会触发 system.init()（插件 setup 完成）；这时 `ownership` 才存在。
    // 再装一次 recreate，避免只有 `'listening'` 时才装（cluster + autoListen:false 会漏掉）。
    installRecreate();

    // 6) 模块 onStart（按声明顺序）
    for (const mod of this.modules_) await mod.onStart?.(this);

    // 7) 插件的"就绪"动作（此时 Actor 已 spawn、模块 onStart 已完成）：端口监听等放这里
    for (const plugin of this.pluginSpecs) await plugin.onReady?.(this);

    // 7b) 生命周期事件也走统一出口（P2）：`app:started` 带上模块数与插件数，便于排障
    this.logRouter?.publish('app', 'app:started', {
      modules: this.modules_.length,
      plugins: this.pluginSpecs.length,
      actors: this.actorSpecs.size,
    });

    // 8) 保持进程存活：start() 之后应用一直运行，直到 stop()
    this.keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    // 审计 F14：把 listening 监听器摘掉（同一个 Application 实例重用时不会叠加）
    if (this._recreateInstaller !== null) {
      (this.system as { off?: (event: string, fn: () => void) => void } | null)?.off?.('listening', this._recreateInstaller);
      this._recreateInstaller = null;
    }
    if (this.stopped) return; // 幂等
    this.stopped = true;
    // 先摘错误桥：停机过程中的崩溃/死信不应再打扰（也避免钩子引用已释放的东西）
    this.bridgeDispose?.();
    this.bridgeDispose = null;
    this.httpErrorOff?.();
    this.httpErrorOff = null;

    // 第一步：插件先停收新请求（逆序），再让内核收尾
    for (const plugin of [...this.pluginSpecs].reverse()) {
      try {
        await plugin.onStopping?.(this);
      } catch {
        /* 停收失败不阻断整体停止流程 */
      }
    }
    // 随后：模块 onStop（逆序）→ 内核停止（有界）→ 插件 teardown → provider dispose
    for (const mod of [...this.modules_].reverse()) {
      try {
        await mod.onStop?.(this);
      } catch {
        /* onStop 不应阻断停止流程 */
      }
    }
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    if (this.system) {
      const system = this.system as { stop: (o?: unknown) => Promise<void> };
      await system.stop(options.timeoutMs ?? 10_000);
    }
    for (const plugin of [...this.pluginSpecs].reverse()) {
      try {
        await plugin.teardown?.(this);
      } catch {
        /* 插件释放失败不阻断停止流程 */
      }
    }
    this.logRouter?.publish('app', 'app:stopped', { reason: 'stop()' });

    for (const name of [...this.disposedProviders].reverse()) {
      const spec = this.providerSpecs.get(name);
      if (spec?.dispose) {
        try {
          await spec.dispose(this.providerValues.get(name));
        } catch {
          /* 释放失败不影响其它释放 */
        }
      }
    }
  }

  // --- 内部 ---------------------------------------------------------------

  private collect(modules: readonly ModuleSpec[], issues: AssemblyIssue[]): void {
    for (const mod of modules) {
      if (this.modules_.includes(mod)) continue;
      this.modules_.push(mod);
      for (const [name, value] of Object.entries(mod.providers ?? {})) {
        if (this.providerSpecs.has(name)) {
          issues.push({ message: `provider '${name}' 被重复定义（模块 '${mod.name}'）`, requester: mod.name });
          continue;
        }
        this.providerSpecs.set(name, isProviderSpec(value) ? value : { factory: value });
      }
      for (const [name, value] of Object.entries(mod.actors ?? {})) {
        if (this.actorSpecs.has(name)) {
          issues.push({ message: `Actor '${name}' 被重复定义（模块 '${mod.name}'）`, requester: mod.name });
          continue;
        }
        this.actorSpecs.set(name, isActorSpec(value) ? value : { definition: value });
      }
      if (mod.routes && mod.router) {
        issues.push({
          message: `模块 '${mod.name}' 同时声明了 routes 与 router —— 请只用其中一种（R3：显式优于隐式）`,
          requester: mod.name,
        });
      } else if (mod.routes || mod.router || mod.middleware) {
        // 组装成"路由器形状的普通对象"：应用层不认识路由器类型，Web 层按结构识别。
        // 于是模块中间件 = 该模块根路由器的中间件（子树语义），模块名进入归属信息（诊断用）。
        // mod.routes 有两种形态：元组数组（扁平声明）或路由器对象（routes({...}) 的产物）。
        // 后者放进 children —— 与 router 一样按子树处理（模块中间件仍是它的父层）。
        const routesIsArray = Array.isArray(mod.routes);
        this.routeSpecs.push({
          name: mod.name,
          // 模块级诊断可见性：Web 层（路由器/调试插件）读取它（应用层只透传）
          ...(mod.debug === undefined ? {} : { debug: mod.debug }),
          ...(mod.middleware ? { middleware: mod.middleware } : {}),
          ...(routesIsArray ? { routes: mod.routes } : {}),
          ...(!routesIsArray && mod.routes ? { children: [mod.routes] } : {}),
          ...(mod.router ? { children: [...(!routesIsArray && mod.routes ? [mod.routes] : []), mod.router] } : {}),
        });
      }
      for (const plugin of mod.plugins ?? []) {
        if (this.pluginSpecs.some((p) => p.name === plugin.name)) {
          issues.push({ message: `插件 '${plugin.name}' 被重复声明`, requester: mod.name });
          continue;
        }
        this.pluginSpecs.push(plugin);
      }
      if (mod.imports) this.collect(mod.imports, issues);
    }
  }

  /**
   * 插件依赖图：校验 `requires` 都能被某个插件的 `name`/`provides` 满足，按依赖顺序拓扑排序，
   * 并在成环时打印**环本身**（`a -> b -> a`），与 provider 的循环依赖错误同一风格。
   */
  private orderPlugins(plugins: readonly PluginSpec[], issues: AssemblyIssue[]): PluginSpec[] {
    const byCapability = new Map<string, PluginSpec>();
    for (const plugin of plugins) {
      byCapability.set(plugin.name, plugin);
      for (const capability of plugin.provides ?? []) {
        if (!byCapability.has(capability)) byCapability.set(capability, plugin);
      }
    }
    const ordered: PluginSpec[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (plugin: PluginSpec, stack: readonly string[]): void => {
      const current = state.get(plugin.name);
      if (current === 'done') return;
      if (current === 'visiting') {
        issues.push({ message: `插件循环依赖: ${[...stack, plugin.name].join(' -> ')}`, requester: '(app.plugins)' });
        return;
      }
      state.set(plugin.name, 'visiting');
      for (const requirement of plugin.requires ?? []) {
        const provider = byCapability.get(requirement);
        if (provider === undefined) {
          issues.push({
            message: `插件 '${plugin.name}' 依赖未知能力 '${requirement}'`,
            requester: '(app.plugins)',
          });
          continue;
        }
        visit(provider, [...stack, plugin.name]);
      }
      state.set(plugin.name, 'done');
      if (!ordered.includes(plugin)) ordered.push(plugin);
    };
    for (const plugin of plugins) visit(plugin, []);
    return ordered;
  }

  private resolveProvider(
    name: string,
    stack: readonly string[],
    issues: AssemblyIssue[],
  ): unknown {
    if (this.providerValues.has(name)) return this.providerValues.get(name);
    // 内置依赖：config / log 由应用层提供，不是用户声明的 provider
    if (name === 'config' || name === 'log') return this.builtins()[name];
    const spec = this.providerSpecs.get(name);
    const requester = stack[stack.length - 1] ?? '(app)';
    if (!spec) {
      issues.push({ message: `未知依赖 '${name}'`, requester });
      return undefined;
    }
    if (stack.includes(name)) {
      issues.push({ message: `循环依赖: ${[...stack, name].join(' -> ')}`, requester });
      return undefined;
    }
    const deps: Record<string, unknown> = {};
    for (const dep of spec.deps ?? []) {
      deps[dep] = this.resolveProvider(dep, [...stack, name], issues);
    }
    const value = spec.factory({ ...this.builtins(), ...deps });
    this.providerValues.set(name, value);
    this.disposedProviders.push(name);
    return value;
  }

  private builtins(): AppDeps {
    return {
      config: this.config,
      // console-ok: 注入给 Actor/provider 的内置 log 默认实现（用户可用 deps.log 换成自己的）
      log: { info: console.info, warn: console.warn, error: console.error },
    };
  }

  private async spawnActor(
    system: { spawn: (d: unknown, o: unknown) => Promise<ActorHandle> },
    name: string,
    spec: ActorSpec,
  ): Promise<ActorHandle> {
    const context = { ...this.builtins(), ...Object.fromEntries(this.providerValues) };
    const deps = spec.deps ? Object.fromEntries(spec.deps.map((d) => [d, this.providerDependency(d, name)])) : context;
    let definition: unknown;
    if (isClass(spec.definition)) {
      // 已知缺陷（见 docs/design/m3-data-evolution.md §5）：class 形态被拆成 handler bag 时，
      // 方法绑在"探测实例"上，而 cell 的状态是另一份拷贝——于是 events/snapshot 持久化会
      // **写盘成功但状态恢复不出来**（静默数据错误）。宁可拒绝启动并把出口写清楚。
      const persistence = spec.options?.persistence ?? this.kernelDefaultPersistence();
      const mode =
        typeof persistence === 'string'
          ? persistence
          : (persistence as { mode?: string } | null | undefined)?.mode;
      if (mode === 'events' || mode === 'snapshot') {
        throw new AssemblyError([
          {
            message:
              `Actor '${name}' 是 class 形态且启用了 '${mode}' 持久化：当前不支持` +
              '（事件/快照会落盘，但状态无法正确恢复）。' +
              '请改用 handler bag 或 @actor/data 的 defineAggregate，或不要为该 Actor 开启持久化',
            requester: `Actor '${name}'`,
          },
        ]);
      }
      const instance = new (spec.definition as new (deps: unknown) => Record<string, unknown>)(deps);
      // 只转发内核认识的成员，并把方法绑定到实例上——否则方法被拆出来后 this 会丢。
      const forwarded: Record<string, unknown> = {};
      if ('state' in instance) forwarded.state = instance.state;
      for (const name of ['preStart', 'receive', 'preRestart', 'postStop']) {
        const member = instance[name];
        if (typeof member === 'function') forwarded[name] = (member as (...args: unknown[]) => unknown).bind(instance);
      }
      if (typeof forwarded.receive !== 'function') {
        throw new AssemblyError([
          { message: `Actor 类缺少 receive() 方法`, requester: `Actor '${name}'` },
        ]);
      }
      definition = defineActor(forwarded as Parameters<typeof defineActor>[0]);
    } else {
      definition = defineActor(spec.definition as Parameters<typeof defineActor>[0]);
    }
    const spawnOptions = { id: spec.id ?? name, ...(spec.options ?? {}) };
    const handle = await system.spawn(definition, spawnOptions);
    // 记下路径 → 定义：集群在本节点接管别人的 Actor 时要用（见 actorDefinitions 的注释）
    const handlePath = (handle as { path?: string }).path ?? String(spawnOptions.id);
    this.actorDefinitions.set(handlePath, { definition, options: spawnOptions, actorName: name });
    if (typeof spec.onCrash === 'function') {
      // 两套路径形态都登记（见 crashHooks 的注释）
      this.crashHooks.set(handlePath, spec.onCrash);
      this.crashHooks.set(String(spawnOptions.id), spec.onCrash);
    }
    return handle;
  }

  /** 内核级默认持久化（`createApp(..., { kernel: { defaults: { persistence } } })`）。 */
  private kernelDefaultPersistence(): unknown {
    const kernel = this.options.kernel as { defaults?: { persistence?: unknown } } | undefined;
    return kernel?.defaults?.persistence;
  }

  private providerDependency(dep: string, actorName: string): unknown {
    if (dep === 'config') return this.loadedConfig;
    if (dep === 'log') return this.builtins().log;
    if (!this.providerValues.has(dep)) {
      throw new AssemblyError([{ message: `未知依赖 '${dep}'`, requester: `Actor '${actorName}'` }]);
    }
    return this.providerValues.get(dep);
  }
}

/** 创建应用（不启动）。`application.start()` 才会校验配置并装配。 */
export function createApp<S extends ConfigSchemaInput>(
  spec: AppSpec<S>,
  options: CreateAppOptions = {},
): Application {
  return new Application(spec as AppSpec, options);
}
