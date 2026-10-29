import { createRequire } from 'node:module';

// 契约套件是**测试工具**：`node:test` 必须等到真正调用 run*Contract 时才加载，
// 否则生产入口 import 一个常量就会把测试运行器带进进程/打包产物。
const require = createRequire(import.meta.url);
let nodeTest: typeof import('node:test') | null = null;
const test: typeof import('node:test').test = ((...args: unknown[]) => {
  nodeTest ??= require('node:test') as typeof import('node:test');
  return (nodeTest.test as unknown as (...values: unknown[]) => unknown)(...args);
}) as unknown as typeof import('node:test').test;
import assert from 'node:assert';

import { DbConfigError } from '@actor/resource';

import type { Middleware } from './middleware.ts';
import type { Route } from './routes.ts';
import type { RouteEntry } from './router.ts';

/**
 * **Web 插件**：`PluginSpec` + 三个贡献点（路由 / 带阶段的中间件 / 请求上下文扩展）。
 *
 * 设计见 docs/design/m8-web-plugins.md §3。要点：
 *   - **阶段由框架保证顺序**，不靠使用者记得"鉴权要排在解析上传前面"；
 *   - 路由冲突、阶段写错、名字缺失都在**启动期**报错（不留到运行期）；
 *   - `context` 钩子在每个请求的 ctx 创建后、中间件之前执行（用来挂 `ctx.log` 这类派生值）；
 *     需要"每次请求变"的值（如 `ctx.user`）请在**中间件**里 `ctx.extend(...)`。
 */
export type MiddlewarePhase = 'pre' | 'auth' | 'parse' | 'handler' | 'post' | 'error';

/** 阶段顺序（数字小的先跑）。 */
export const MIDDLEWARE_PHASES: readonly MiddlewarePhase[] = ['pre', 'auth', 'parse', 'handler', 'post', 'error'];

/** 中间件链里的一项：函数（默认 `pre` 阶段）或带阶段的包装。 */
export type PhasedMiddleware = Middleware | { readonly handler: Middleware; readonly phase: MiddlewarePhase; readonly name?: string };

/** 插件贡献的请求上下文钩子（服务名固定，`httpPlugin` 会读它）。 */
export const WEB_CONTEXT_HOOKS_SERVICE = '@actor/web:contextHooks';

export interface WebPluginSpec {
  name: string;
  requires?: readonly string[];
  provides?: readonly string[];
  description?: string;
  /**
   * **框架自带**标记：由 `@actor/web` 自己的插件工厂（upload / debug / http / ws / requestLog）设置。
   *
   * 用途只有一个、且是安全相关：装配期"保留前缀"校验只放行**框架自己的**插件占用 `/uploads`、`/__debug`
   * —— 没有这个标记就无法区分"框架插件"与"恰好同名的第三方插件"，也就只能靠插件名去猜（会分叉）。
   * 用户插件不要设置它：设了就等于宣称自己是框架插件。
   */
  framework?: true;
  config?: Record<string, unknown>;
  /** 贡献的路由（`routePrefix` 会在定义时套到每个模式上）。 */
  /**
   * 插件贡献的路由。
   *
   * 接受**助手产出形状**（`get(...)`/`post(...)` 返回的 `RouteEntry` 元组）与已构建的 `Route` 两者 ——
   * 与 `router.ts` 里 router spec 的 `routes?: readonly RouteEntry[]` 同一口径。
   * 早先这里只写 `Route[]`，于是 `defineWebPlugin({ routes: [get(...)] })` 是类型错误，
   * 而**示例没进 typecheck 矩阵**所以一直没暴露（`routes.ts` 里 `defineRoutes` 的注释记过同一类 bug，
   * 那次放宽了它，这次把插件 spec 漏掉的那处补齐）。运行时本来就按元组解释（见下面 `as unknown as` 的用法）。
   */
  routes?: readonly (Route | RouteEntry)[];
  /** 路由前缀，例如 `/uploads`。 */
  routePrefix?: string;
  /** 贡献的中间件（带阶段）。 */
  middleware?: readonly PhasedMiddleware[];
  /** 请求上下文扩展钩子（每个请求创建 ctx 后执行）。 */
  context?: (ctx: Record<string, unknown>) => Record<string, unknown>;
  /** `defineWebPlugin` 内部会包一层（注册 context 钩子服务）；也可以自己写。 */
  setup?: (app: { provide?(name: string, value: unknown): void; get?<T>(name: string): T; config: { get<T>(key: string): T } }) => void | Promise<void>;
  onReady?: (app: { provide?(name: string, value: unknown): void; get?<T>(name: string): T; config: { get<T>(key: string): T } }) => void | Promise<void>;
  onStopping?: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

/** 套前缀：路由元组是 `[method, pattern, controller, middleware?]`，只改 pattern。 */
function prefixRoute(route: Route, prefix: string): Route {
  if (prefix === '') return route;
  const entry = route as unknown as readonly unknown[];
  const pattern = entry[1];
  if (typeof pattern !== 'string') return route;
  const joined = `${prefix.replace(/\/$/, '')}${pattern.startsWith('/') ? pattern : `/${pattern}`}`;
  const copy = [...entry];
  copy[1] = joined;
  return copy as unknown as Route;
}

/** 定义一个 web 插件：校验 + 套前缀（纯函数，定义期就能失败）。 */
export function defineWebPlugin(spec: WebPluginSpec): WebPluginSpec {
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new DbConfigError('defineWebPlugin: "name" is required');
  }
  const prefix = spec.routePrefix ?? '';
  if (prefix !== '' && !prefix.startsWith('/')) {
    throw new DbConfigError(`defineWebPlugin("${spec.name}"): routePrefix must start with "/" (got "${prefix}")`);
  }
  for (const item of spec.middleware ?? []) {
    if (typeof item === 'function') continue;
    const phase = (item as { phase?: unknown }).phase;
    if (typeof phase !== 'string' || !MIDDLEWARE_PHASES.includes(phase as MiddlewarePhase)) {
      throw new DbConfigError(
        `defineWebPlugin("${spec.name}"): middleware phase must be one of ${MIDDLEWARE_PHASES.join('|')} (got "${String(phase)}")`,
      );
    }
    if (typeof (item as { handler?: unknown }).handler !== 'function') {
      throw new DbConfigError(`defineWebPlugin("${spec.name}"): phased middleware needs a "handler" function`);
    }
  }

  const seen = new Set<string>();
  // spec.routes 对**用户**放宽了（允许 get/post 的助手元组，见字段注释）；内部按老口径当 Route[] 用一次，
  // 元组形状由运行时转换（下面 `as unknown as readonly unknown[]` 那几处就是干这个的）。
  const normalizedRoutes = (spec.routes ?? []) as readonly Route[];
  const routes = normalizedRoutes.map((route) => {
    const prefixed = prefixRoute(route, prefix);
    const entry = prefixed as unknown as readonly unknown[];
    const key = `${String(entry[0])} ${String(entry[1])}`;
    if (seen.has(key)) {
      throw new DbConfigError(`defineWebPlugin("${spec.name}"): duplicate route "${key}"（插件内重复声明）`);
    }
    seen.add(key);
    return prefixed;
  });

  return {
    ...spec,
    ...(routes.length === 0 ? {} : { routes }),
    // 把 context 钩子注册成服务：Web 层每请求读一次（应用层不需要知道 web 细节）
    //
    // ⚠️ 必须**组合**调用方自己的 `setup`，而不是覆盖它 —— 早先这里直接写了新的 setup，
    // 于是插件（例如 uploadPlugin）自己注册的服务全部丢失，表现为运行期 500/挂起。
    setup: async (app: { provide?(name: string, value: unknown): void; get?<T>(name: string): T; config: { get<T>(key: string): T } }) => {
      await spec.setup?.(app);
      if (spec.context === undefined) return undefined;
      // 服务可能还没注册（app.get 对未注册的服务是**严格报错**的）→ 读不到就当空
      let existing: readonly ((ctx: Record<string, unknown>) => Record<string, unknown>)[] = [];
      try {
        existing = app.get?.<readonly ((ctx: Record<string, unknown>) => Record<string, unknown>)[]>(WEB_CONTEXT_HOOKS_SERVICE) ?? [];
      } catch {
        existing = [];
      }
      app.provide?.(WEB_CONTEXT_HOOKS_SERVICE, [...existing, spec.context]);
      return undefined;
    },
  } as WebPluginSpec;
}

/** 把中间件链按阶段稳定排序（未声明阶段的按 `pre` 处理 → 不改变既有行为）。 */
export function orderMiddleware(chain: readonly unknown[]): Middleware[] {
  const ranked = chain.map((item, index) => {
    if (typeof item === 'function') {
      // 函数可以自带 `phase` 属性（例如 requireRole()）——没有就按 pre（既有行为不变）
      const declared = (item as { phase?: unknown }).phase;
      const rank = typeof declared === 'string' ? MIDDLEWARE_PHASES.indexOf(declared as MiddlewarePhase) : -1;
      return { handler: item as Middleware, rank: rank < 0 ? MIDDLEWARE_PHASES.indexOf('pre') : rank, index };
    }
    const phased = item as { handler?: unknown; phase?: unknown };
    if (typeof phased.handler === 'function') {
      const rank = MIDDLEWARE_PHASES.indexOf(phased.phase as MiddlewarePhase);
      return { handler: phased.handler as Middleware, rank: rank < 0 ? 0 : rank, index };
    }
    throw new DbConfigError(`middleware chain contains an unsupported item at index ${index}（既不是函数也不是 { handler, phase }）`);
  });
  return ranked
    .sort((left, right) => (left.rank === right.rank ? left.index - right.index : left.rank - right.rank))
    .map((item) => item.handler);
}

/**
 * **web 插件契约套件**（随包发布）：验证插件在贡献点上的行为是否符合约定。
 *
 * 与数据库那套 `runManagedResourceContract` 同构 —— 用户自己写的 web 插件也能拿它自证合规。
 * 覆盖：名字/阶段合法、路由带前缀且无内部冲突、中间件按阶段排序、`context` 钩子注册成服务、
 * 重复路由在**定义期**报错。
 */
export function runWebPluginContract(options: {
  name: string;
  /** 定义被测插件（每次调用返回一个新实例）。 */
  define: () => WebPluginSpec;
  /** 造一个 app 壳（只需要 config.get + provide/get）。 */
  makeApp?: () => {
    app: { provide?(name: string, value: unknown): void; get?<T>(name: string): T; config: { get<T>(key: string): T } };
    services: Map<string, unknown>;
  };
}): void {
  const { name } = options;

  test(`[web-plugin:${name}] 名字与阶段声明合法`, () => {
    const plugin = options.define();
    assert.strictEqual(typeof plugin.name, 'string');
    assert.ok(plugin.name.trim().length > 0, '插件必须有名字（也是配置节名）');
    for (const item of plugin.middleware ?? []) {
      if (typeof item === 'function') continue;
      assert.ok(
        MIDDLEWARE_PHASES.includes((item as { phase: MiddlewarePhase }).phase),
        `阶段必须是 ${MIDDLEWARE_PHASES.join('|')}`,
      );
    }
  });

  test(`[web-plugin:${name}] 路由带前缀且插件内不冲突`, () => {
    const plugin = options.define();
    const prefix = plugin.routePrefix ?? '';
    const seen = new Set<string>();
    for (const route of plugin.routes ?? []) {
      const entry = route as unknown as readonly unknown[];
      const pattern = String(entry[1]);
      if (prefix !== '') assert.ok(pattern.startsWith(prefix), `路由 "${pattern}" 没有套上前缀 "${prefix}"`);
      const key = `${String(entry[0])} ${pattern}`;
      assert.ok(!seen.has(key), `插件内路由冲突：${key}`);
      seen.add(key);
    }
  });

  test(`[web-plugin:${name}] context 钩子会被注册成服务（没写就不注册）`, async () => {
    const plugin = options.define();
    const shell = options.makeApp?.() ?? (() => {
      const services = new Map<string, unknown>();
      return {
        services,
        app: {
          config: { get<T>(): T { throw new Error('no config'); } },
          provide: (key: string, value: unknown) => void services.set(key, value),
          get: <T>(key: string) => services.get(key) as T,
        },
      };
    })();
    if (plugin.context === undefined) {
      assert.strictEqual(shell.services.get(WEB_CONTEXT_HOOKS_SERVICE), undefined);
      return;
    }
    // setup 是 async（defineWebPlugin 会组合调用方的 setup 再注册钩子）→ **必须 await**，
    // 否则断言跑在钩子注册之前（M8a 时在别处修过同一个坑，这里漏了）
    await (plugin as { setup?: (app: unknown) => void | Promise<void> }).setup?.(shell.app);
    const hooks = shell.services.get(WEB_CONTEXT_HOOKS_SERVICE) as readonly unknown[] | undefined;
    assert.ok(Array.isArray(hooks) && hooks.includes(plugin.context), 'context 钩子应当被注册成服务');
  });

  test(`[web-plugin:${name}] 非法阶段与重复路由在定义期就报错（不留到运行期）`, () => {
    const plugin = options.define();
    if ((plugin.routes ?? []).length > 0) {
      const first = plugin.routes?.[0] as unknown as readonly unknown[];
      assert.throws(
        () =>
          defineWebPlugin({
            name: `${name}-dup`,
            routes: [plugin.routes?.[0] as never, [first[0], first[1], first[2]] as never],
          }),
        /duplicate route/,
        '重复路由必须被拒',
      );
    }
    assert.throws(
      () => defineWebPlugin({ name: `${name}-bad`, middleware: [{ handler: () => undefined, phase: 'nope' as never }] }),
      /phase must be one of/,
    );
  });

  test(`[web-plugin:${name}] 中间件按阶段排序（未声明阶段的视为 pre，保持既有顺序）`, async () => {
    const labels: string[] = [];
    const tag = (label: string): Middleware => async () => {
      labels.push(label);
      return undefined;
    };
    const ordered = orderMiddleware([
      tag('unphased-1'),
      { handler: tag('post'), phase: 'post' },
      { handler: tag('auth'), phase: 'auth' },
      tag('unphased-2'),
    ]);
    assert.strictEqual(ordered.length, 4, '排序不该丢项');
    // 真的按顺序执行一遍（Middleware 的签名是 (ctx, next)）
    // 变量名刻意不叫 handler：`middleware.ts` 导出的阶段简写里就有一个 `handler()`，
    // 这里再叫 handler 会让"读代码的人以为在调它"（同文件里 import 的话还会真撞名）
    for (const step of ordered) await step({} as never, async () => undefined);
    assert.deepStrictEqual(
      labels,
      ['unphased-1', 'unphased-2', 'auth', 'post'],
      `阶段顺序不对：${labels.join(' → ')}`,
    );
  });
}
