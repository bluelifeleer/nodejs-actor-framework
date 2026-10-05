import { createSystem, defineActor } from 'nodejs-actor-framework';

import {
  defineConfig,
  type ConfigSchema,
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
  ask(message: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
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
}

export interface ModuleSpec {
  name: string;
  imports?: readonly ModuleSpec[];
  providers?: Record<string, ProviderSpec | ProviderFactory>;
  actors?: Record<string, ActorSpec | unknown>;
  onStart?: (app: Application) => void | Promise<void>;
  onStop?: (app: Application) => void | Promise<void>;
}

export interface AppSpec<S extends ConfigSchema = ConfigSchema> {
  config?: ConfigDefinition<S>;
  modules: readonly ModuleSpec[];
}

export interface CreateAppOptions {
  configDir?: string;
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

/** 声明一个应用。 */
export function defineApp<S extends ConfigSchema>(spec: AppSpec<S>): AppSpec<S> {
  return spec;
}

export class Application {
  private readonly providerSpecs = new Map<string, ProviderSpec>();
  private readonly actorSpecs = new Map<string, ActorSpec>();
  private readonly providerValues = new Map<string, unknown>();
  private readonly handles = new Map<string, ActorHandle>();
  private readonly modules: ModuleSpec[] = [];
  private readonly disposedProviders: string[] = [];
  private loadedConfig: LoadedConfig | null = null;
  private system: unknown = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;

  private readonly spec: AppSpec<ConfigSchema>;
  private readonly options: CreateAppOptions;

  constructor(spec: AppSpec<ConfigSchema>, options: CreateAppOptions = {}) {
    this.spec = spec;
    this.options = options;
  }

  get config(): LoadedConfig {
    if (!this.loadedConfig) throw new Error('配置尚未加载：请先 start()');
    return this.loadedConfig;
  }

  /** 逃生通道：高级用法可直接访问内核 system（应用层签名不依赖它）。 */
  get kernel(): unknown {
    return this.system;
  }

  /** 取一个 Actor 句柄（Actor 不存在时抛错，避免静默拿到 undefined）。 */
  actor(name: string): ActorHandle {
    const handle = this.handles.get(name);
    if (!handle) {
      throw new AssemblyError([{ message: `不存在名为 '${name}' 的 Actor`, requester: '(app.actor)' }]);
    }
    return handle;
  }

  /** 取一个已解析的 provider（供测试与插件使用）。 */
  get<T = unknown>(name: string): T {
    if (!this.providerValues.has(name)) {
      throw new AssemblyError([{ message: `provider '${name}' 尚未解析`, requester: '(app.get)' }]);
    }
    return this.providerValues.get(name) as T;
  }

  async start(): Promise<this> {
    if (this.started) return this;
    this.started = true;

    // 1) 配置：最先执行，失败即启动失败（一次性报出全部问题）
    const definition = (this.spec.config ?? defineConfig({})) as ConfigDefinition<ConfigSchema>;
    this.loadedConfig = await loadConfig(definition, {
      ...(this.options.configDir === undefined ? {} : { configDir: this.options.configDir }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.envPrefix === undefined ? {} : { envPrefix: this.options.envPrefix }),
      ...(this.options.overrides === undefined ? {} : { overrides: this.options.overrides }),
    });

    // 2) 收集模块图（含 imports 递归）并检测重名
    const issues: AssemblyIssue[] = [];
    this.collect(this.spec.modules, issues);
    if (issues.length > 0) throw new AssemblyError(issues);

    // 3) 解析全部 provider：未知依赖与循环依赖在此暴露
    const resolveIssues: AssemblyIssue[] = [];
    for (const name of this.providerSpecs.keys()) this.resolveProvider(name, [], resolveIssues);
    if (resolveIssues.length > 0) throw new AssemblyError(resolveIssues);

    // 4) 启动内核并 spawn Actor
    this.system = createSystem(this.options.kernel ?? { logger: false });
    const system = this.system as { spawn: (d: unknown, o: unknown) => Promise<ActorHandle> };
    for (const [name, actorSpec] of this.actorSpecs) {
      const handle = await this.spawnActor(system, name, actorSpec);
      this.handles.set(name, handle);
    }

    // 5) 模块 onStart（按声明顺序）
    for (const mod of this.modules) await mod.onStart?.(this);

    // 6) 保持进程存活：应用 start() 之后应当一直运行，直到 stop()。
    // 否则一个"没有端口/定时器"的应用会在事件循环排空后自己退出（实测就是如此）。
    this.keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    return this;
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.stopped) return; // 幂等
    this.stopped = true;

    // 逆序：模块 onStop → 内核停止（有界）→ provider dispose
    for (const mod of [...this.modules].reverse()) {
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
      await system.stop({ timeoutMs: options.timeoutMs ?? 10_000 });
    }
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
      if (this.modules.includes(mod)) continue;
      this.modules.push(mod);
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
      if (mod.imports) this.collect(mod.imports, issues);
    }
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
    return system.spawn(definition, { id: spec.id ?? name, ...(spec.options ?? {}) });
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
export function createApp<S extends ConfigSchema>(
  spec: AppSpec<S>,
  options: CreateAppOptions = {},
): Application {
  return new Application(spec as AppSpec<ConfigSchema>, options);
}
