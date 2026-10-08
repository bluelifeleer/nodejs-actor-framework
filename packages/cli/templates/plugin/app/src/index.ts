import { definePlugin, type Application, type PluginSpec } from '@actor/app';

/**
 * __PLUGIN_NAME__：一个**应用插件**（不依赖 Web 层）。
 *
 * 三个要点（都能在本文件里看到）：
 *   ① `config`：字段会并进应用配置的 `plugins.__PLUGIN_NAME__.*`，与普通配置同一套加载/环境变量/校验；
 *   ② 生命周期：`setup` → `onReady` → `onStopping` → `teardown`（时机由框架保证，见各钩子注释）；
 *   ③ 服务：`app.provide(name, value)` 注册，控制器/其它插件用 `ctx.get(name)` 取。
 */
export interface __PLUGIN_CAMEL__Options {
  /** 覆盖配置里的 greeting（不传就用 `plugins.__PLUGIN_NAME__.greeting`）。 */
  greeting?: string;
  /** 观测钩子（默认不写 stdout —— 库代码不该自己决定日志去处）。 */
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/** 服务名：别的插件/控制器用 `ctx.get(SERVICE)` 取。 */
export const SERVICE = '__PLUGIN_NAME__';

/** 配置 schema：会并进 `plugins.__PLUGIN_NAME__.*`（简写与全量写法可混用）。 */
const config = {
  greeting: { type: 'string' as const, default: 'hello' },
  // 机密项要显式声明（诊断输出与 redacted() 会打码）
  token: { type: 'string' as const, secret: true, default: '' },
};

export function __PLUGIN_CAMEL__Plugin(options: __PLUGIN_CAMEL__Options = {}): PluginSpec {
  return definePlugin({
    name: '__PLUGIN_NAME__',
    description: '__PLUGIN_NAME__ 应用插件（骨架）',
    config,
    // 声明依赖的插件能力名（不需要就删掉）：装配期会做未知依赖与循环依赖检查
    // requires: ['http'],

    /** provider 解析与 Actor spawn **之前**：读配置、准备资源。 */
    async setup(app: Application, config_: Record<string, unknown>) {
      const greeting = options.greeting ?? String(config_['greeting'] ?? 'hello');
      // 注册服务（重复注册会报错，不静默覆盖）
      app.provide(SERVICE, {
        kind: '__PLUGIN_NAME__',
        greet: (who: string) => `${greeting}, ${who}`,
      });
      options.logger?.('__PLUGIN_CAMEL___setup', { greeting });
    },

    /** 端口监听这类"就绪"动作放这里：此时 Actor 已 spawn、模块 onStart 已完成。 */
    async onReady(app: Application) {
      const service = app.get<{ kind: string }>(SERVICE);
      options.logger?.('__PLUGIN_CAMEL___ready', { kind: service.kind });
    },

    /** 停止流程**第一步**：先停收新请求/释放入口，再等内核收尾。 */
    async onStopping() {
      options.logger?.('__PLUGIN_CAMEL___stopping');
    },

    /** 兜底释放（模块 onStop 与内核停止之后，逆序执行）。 */
    async teardown() {
      options.logger?.('__PLUGIN_CAMEL___teardown');
    },
  });
}

export default __PLUGIN_CAMEL__Plugin;
