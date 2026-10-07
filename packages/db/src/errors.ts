/**
 * 错误类型：**通用**的那些住在 `@actor/db-core`（SQL / Redis / MongoDB / 自装适配器共用），
 * 这里**原样 re-export** —— 既有使用者的导入路径与 `instanceof` 判断都不变。
 *
 * SQL 专有的 `DbSchemaDriftError`（表与 model 对不上）在 `schema.ts` 里（它需要漂移报告类型）。
 */
export {
  DbConfigError,
  DbConnectionError,
  DbConflictError,
  DbDriverMissingError,
  DbError,
  DbNotFoundError,
  DbNotConnectedError,
  DbUnavailableError,
} from '@actor/db-core';
