/**
 * Supervision restart strategies.
 *
 * ESM 版（.mts）：本包其余文件仍是 CJS（.ts），混用是稳定的——ESM 可以
 * import CJS，CJS 也可以 require ESM（Node ≥22.12，且无 top-level await）。
 * 具名导出让 CJS 侧 `require('./restart-strategy.mts')` 直接拿到同名属性。
 */
export const ONE_FOR_ONE = 'one_for_one';
export const REST_FOR_ONE = 'rest_for_one';
export const ONE_FOR_ALL = 'one_for_all';

export type RestartStrategyName = typeof ONE_FOR_ONE | typeof REST_FOR_ONE | typeof ONE_FOR_ALL;

const RestartStrategy = Object.freeze({ ONE_FOR_ONE, REST_FOR_ONE, ONE_FOR_ALL } as const);

export type RestartStrategyMap = typeof RestartStrategy;
export default RestartStrategy;
