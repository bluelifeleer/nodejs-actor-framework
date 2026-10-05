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
  loadConfig,
  ConfigValidationError,
  type ConfigSchema,
  type ConfigDefinition,
  type ConfigIssue,
  type FieldSpec,
  type FieldType,
  type LoadConfigOptions,
  type LoadedConfig,
} from './config.ts';

/** 应用层版本，便于启动日志与诊断。 */
export const APP_LAYER_VERSION = '0.1.0';
