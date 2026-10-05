/**
 * 投影 / 读模型（M3 第 6 步）：断点续跑 + 去重 + 从 0 重建（可灌影子读模型再切换）。
 */

export {
  ProjectionError,
  ProjectionHandleError,
  type ProjectionCatchUpResult,
  type ProjectionContext,
  type ProjectionSpec,
  type ProjectionStatus,
} from './types.ts';

export { clearRepository, createProjectionRunner, type ProjectionRunner, type ProjectionRunnerOptions } from './runner.ts';
