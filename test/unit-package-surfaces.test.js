import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * **公开面基线**：把每个包的运行时导出名字钉住，只允许**增加**。
 *
 * 为什么需要（M7/M8 的教训）：现有的"公开面门禁"只保证"每个运行时导出都有类型声明"，
 * 它发现不了"导出消失" —— 而搬迁/重构最容易的翻车方式就是"某个名字忘了 re-export"。
 * 这份基线是抽 @actor/resource、抽 @actor/db-core 这类搬迁的安全网。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASELINE = {
  "@actor/resource": [
    "DbConfigError",
    "DbConnectionError",
    "DbDriverMissingError",
    "DbError",
    "DbNotConnectedError",
    "DbUnavailableError",
    "DriverMissingError",
    "ResourceConfigError",
    "ResourceConnectionError",
    "ResourceError",
    "ResourceNotConnectedError",
    "ResourceUnavailableError",
    "createAppRequire",
    "databaseAdapter",
    "defineDatabaseAdapter",
    "defineManagedResource",
    "defineResourceAdapter",
    "loadDriverModule",
    "mapPoolOptions",
    "realDatabaseUrl",
    "realResourceUrl",
    "resourceAdapter",
    "runManagedConnectionContract",
    "runManagedResourceContract",
    "supervise",
    "testWithDatabase",
    "testWithResource",
  ],
  "@actor/db-core": [
    "DbConfigError",
    "DbConflictError",
    "DbConnectionError",
    "DbDriverMissingError",
    "DbError",
    "DbNotConnectedError",
    "DbNotFoundError",
    "DbUnavailableError",
    "createAppRequire",
    "databaseAdapter",
    "defineDatabaseAdapter",
    "defineManagedResource",
    "loadDriverModule",
    "mapPoolOptions",
    "realDatabaseUrl",
    "runManagedConnectionContract",
    "supervise",
    "testWithDatabase",
  ],
  "@actor/db": [
    "DEFAULT_POOL",
    "DEFAULT_PORTS",
    "DIALECTS",
    "DIALECT_SPECS",
    "DRIVER_PACKAGES",
    "DbConfigError",
    "DbConflictError",
    "DbConnectionError",
    "DbDriverMissingError",
    "DbError",
    "DbNotConnectedError",
    "DbNotFoundError",
    "DbSchemaDriftError",
    "assertDialect",
    "checkDrift",
    "columnTypeFor",
    "columnsSql",
    "createAppRequire",
    "createDatabase",
    "createMssqlDriver",
    "createMysqlDriver",
    "createPgDriver",
    "createRepository",
    "createSqlAdapter",
    "createSqliteDriver",
    "databasePlugin",
    "defaultParseValue",
    "defaultPortFor",
    "defaultSerializeValue",
    "defineModel",
    "describeConnection",
    "dialectFor",
    "dialectFromUrl",
    "dialectSpec",
    "entityToRow",
    "inspectTable",
    "loadDriverModule",
    "normalizeDbType",
    "parseConnection",
    "placeholderFor",
    "quoteIdentifier",
    "quoteTable",
    "rowToEntity",
    "syncModels",
    "tableExistsSql",
  ],
  "@actor/redis": [
    "DEFAULT_REDIS_DRIVER",
    "createKeyValueClient",
    "describeRedis",
    "parseRedisUrl",
    "redisAdapter",
    "resolveRedisDriver",
  ],
  "@actor/mail": [
    "createRenderer",
    "defineMailTransport",
    "escapeHtml",
    "fileTransport",
    "mailPlugin",
    "parseMailHeaders",
    "renderMail",
    "renderTemplate",
    "runMailTransportContract",
    "smtpTransport",
  ],
  "@actor/mongodb": [
    "DEFAULT_MONGO_DRIVER",
    "checkCollectionDrift",
    "createDocumentClient",
    "defineCollection",
    "describeMongo",
    "inspectCollection",
    "mongoAdapter",
    "mongoPoolOptions",
    "parseMongoUrl",
    "resolveMongoDriver",
    "syncCollections",
  ],
};

for (const [pkg, expected] of Object.entries(BASELINE)) {
  test(`surface baseline: ${pkg} 的运行时导出只增不减`, async () => {
    const dir = pkg.replace('@actor/', '');
    const mod = await import(pathToFileURL(path.join(ROOT, 'packages', dir, 'src', 'index.ts')).href);
    const have = new Set(Object.keys(mod).filter((name) => name !== 'default'));
    const missing = expected.filter((name) => !have.has(name));
    assert.deepStrictEqual(missing, [], `${pkg} 少了这些导出（搬迁时忘了 re-export？）：${missing.join(', ')}`);
  });
}

test('surface baseline: 基线本身能证伪（少一个必须被抓到）', () => {
  const expected = BASELINE['@actor/resource'];
  const missing = [...expected, 'ThisExportDoesNotExist'].filter((name) => !expected.includes(name));
  assert.deepStrictEqual(missing, ['ThisExportDoesNotExist']);
});
