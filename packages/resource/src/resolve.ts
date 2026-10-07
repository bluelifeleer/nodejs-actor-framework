import { createRequire } from 'node:module';
import path from 'node:path';

import { DriverMissingError } from './errors.ts';

/** 解析用户项目里的模块（与内核解析 worker 模块、CLI 解析项目文件同一套语义）。 */
export interface DriverResolver {
  (specifier: string): unknown;
}

/**
 * 造一个"从应用根解析"的 require。
 *
 * （M7a 从 `@actor/db` 搬来；`@actor/db` 原样 re-export，使用者无感。）
 *
 * 为什么不是直接 `await import('pg')`：那样解析的是 **`@actor/db` 自己的** node_modules。
 * 驱动是**用户装在他们项目里**的，pnpm 这类严格布局下从本包位置根本看不到它 —— 必须从应用根解析。
 */
export function createAppRequire(root: string = process.env.ACTOR_APP_ROOT ?? process.cwd()): DriverResolver {
  const req = createRequire(path.join(path.resolve(root), 'package.json'));
  return (specifier: string) => req(specifier) as unknown;
}

function isModuleNotFound(err: unknown, specifier: string): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return true;
  // pnpm/yarn 有些包装会换成别的 code，但消息里仍然是 "Cannot find module 'pg'"
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Cannot find') && message.includes(specifier.split('/')[0] as string);
}

/** 加载驱动；找不到时抛 `DriverMissingError`（带安装命令）。`dialect` 参数即适配器 kind。 */
export function loadDriverModule<T>(
  specifier: string,
  dialect: string,
  packageName: string,
  resolve: DriverResolver = createAppRequire(),
): T {
  try {
    return resolve(specifier) as T;
  } catch (err) {
    if (isModuleNotFound(err, specifier)) throw new DriverMissingError(dialect, packageName, err);
    throw err; // 装是装了，但加载时自己炸了：不要误导成"驱动没装"
  }
}
