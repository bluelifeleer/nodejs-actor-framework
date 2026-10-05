'use strict';

/**
 * `@actor/app` —— 应用层（M1：配置 + 装配）。
 *
 * 边界规则（docs/design/m1-app-assembly.md §1）：
 *   - 用户项目只依赖本包，不直接依赖内核 `nodejs-actor-framework`；
 *   - 本包**不得 re-export 内核内部类型**（ActorSystem / Mailbox / ActorCell / ChildSupervisor /
 *     RemoteRef 等），只暴露应用层概念（App / Module / Config / Provider / Plugin / Actor 句柄）。
 *   - 本包依赖内核（向下），内核不依赖本包。
 *
 * M1 的公共 API（defineConfig / defineModule / defineApp / createApp / definePlugin）在此逐步落地；
 * 现状为骨架，仅用于锁定包边界与守卫测试（见 test/unit-app-boundary.test.js）。
 */

/** 应用层版本，便于启动日志与诊断。 */
export const APP_LAYER_VERSION = '0.1.0';

export {};
