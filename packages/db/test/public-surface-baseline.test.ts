import { test } from 'node:test';
import assert from 'node:assert';

import * as api from '../src/index.ts';

/**
 * 公开面**基线**（M7a 的红线）：把 @actor/db 的运行时导出钉死，只允许**增加**，不允许减少。
 *
 * 为什么需要：M7a 要把驱动解析/池契约/错误基类搬去 `@actor/db-core` —— 搬迁最容易的翻车方式
 * 就是"某个导出忘了 re-export"。现有 surface 门禁只保证"每个运行时导出都有类型声明"，
 * 它发现不了"导出消失了"。这份基线补上那个洞。
 */
const BASELINE_2026_10: readonly string[] = [
  'DEFAULT_POOL', 'DEFAULT_PORTS', 'DIALECTS', 'DIALECT_SPECS', 'DRIVER_PACKAGES',
  'DbConfigError', 'DbConflictError', 'DbConnectionError', 'DbDriverMissingError', 'DbError',
  'DbNotConnectedError', 'DbNotFoundError', 'DbSchemaDriftError',
  'assertDialect', 'checkDrift', 'columnTypeFor', 'columnsSql', 'createAppRequire', 'createDatabase',
  'createMssqlDriver', 'createMysqlDriver', 'createPgDriver', 'createRepository', 'createSqliteDriver',
  'databasePlugin', 'defaultParseValue', 'defaultPortFor', 'defaultSerializeValue', 'defineModel',
  'describeConnection', 'dialectFor', 'dialectFromUrl', 'dialectSpec', 'entityToRow', 'inspectTable',
  'loadDriverModule', 'normalizeDbType', 'parseConnection', 'placeholderFor', 'quoteIdentifier',
  'quoteTable', 'rowToEntity', 'syncModels', 'tableExistsSql',
];

test('db surface baseline: 运行时导出只增不减（搬迁/重构不许丢导出）', () => {
  const current = new Set(Object.keys(api));
  const missing = BASELINE_2026_10.filter((name) => !current.has(name));
  assert.deepStrictEqual(
    missing,
    [],
    `这些导出在基线里但当前模块里没有了（搬迁时忘了 re-export？）：\n  ${missing.join(', ')}`,
  );
});

test('db surface baseline: 基线本身要能证伪（少一个必须被抓到）', () => {
  const current = new Set(Object.keys(api));
  const broken = [...BASELINE_2026_10, 'DbThisDoesNotExist'];
  const missing = broken.filter((name) => !current.has(name));
  assert.deepStrictEqual(missing, ['DbThisDoesNotExist'], '基线检查抓不到缺失的导出 —— 这条门禁是假的');
});
