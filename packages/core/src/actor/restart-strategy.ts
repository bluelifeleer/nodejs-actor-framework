// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Supervision restart strategies.
 *
 * 迁移期写法（M0.1 → 路线 B 的过渡）：本包当前仍是 CJS，因此
 *   - 类型用 `export type`（会被类型擦除）
 *   - 运行时导出用 `module.exports`
 * Node 可直接运行本文件（类型剥离），无需构建；引用方必须写显式扩展名
 * （`require('./restart-strategy.ts')`，因为 CJS 解析不补 `.ts`）。
 */
export type RestartStrategyName = 'one_for_one' | 'rest_for_one' | 'one_for_all';

const RestartStrategy = Object.freeze({
  ONE_FOR_ONE: 'one_for_one',
  REST_FOR_ONE: 'rest_for_one',
  ONE_FOR_ALL: 'one_for_all',
} as const);

export type RestartStrategyMap = typeof RestartStrategy;

module.exports = RestartStrategy;
