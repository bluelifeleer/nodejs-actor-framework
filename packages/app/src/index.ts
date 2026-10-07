/**
 * `@actor/app` —— 应用层（M1：配置 + 装配）。
 *
 * 边界规则（docs/design/m1-app-assembly.md §1）：
 *   - 用户项目只依赖本包，不直接依赖内核 `nodejs-actor-framework`；
 *   - 本包**不得 re-export 内核内部类型**（ActorSystem / Mailbox / ActorCell / ChildSupervisor /
 *     RemoteRef 等），只暴露应用层概念；
 *   - 本包依赖内核（向下），内核不依赖本包。
 *
 * 本包为 ESM TypeScript（package.json type: module）——单一模块体系，不使用 .mts 混用。
 */
export {
  defineConfig,
  defineConfig as config,
  loadConfig,
  validateValues,
  ConfigValidationError,
  type ConfigSchema,
  type ConfigDefinition,
  type ConfigIssue,
  type FieldSpec,
  type FieldType,
  type LoadConfigOptions,
  type LoadedConfig,
  type ValidateValuesResult,
} from './config.ts';

export {
  defineModule,
  defineModule as module,
  definePlugin,
  definePlugin as plugin,
  defineApp,
  defineApp as app,
  createApp,
  Application,
  AssemblyError,
  ActorNotResolvableError,
  type ActorHandle,
  type AppDeps,
  type ConfigReader,
  type Logger,
  type ActorSpec,
  type AppSpec,
  type AssemblyIssue,
  type CreateAppOptions,
  type ModuleSpec,
  type ProviderFactory,
  type ProviderSpec,
  type PluginSpec,
} from './assembly.ts';

export {
  metricsPlugin,
  tracingPlugin,
  deadLettersPlugin,
  rateLimitPlugin,
  pubsubPlugin,
  clusterPlugin,
  type ClusterActorMeta,
  type ClusterPeer,
  type ClusterPlugin,
  type ClusterPluginOptions,
} from './plugins.ts';

/** 应用层版本，便于启动日志与诊断。 */
export const APP_LAYER_VERSION = '0.1.0';

export { runApp, type RunAppOptions } from './run.ts';
