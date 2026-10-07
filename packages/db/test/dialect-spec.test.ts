import { test } from 'node:test';
import assert from 'node:assert';

import { columnTypeFor, DIALECTS, dialectSpec } from '../src/index.ts';
import { DIALECT_SPECS } from '../src/dialects/index.ts';

/**
 * 方言描述符（`DialectSpec`）的契约测试 —— 设计见 docs/design/m6-dialect-spec.md。
 *
 * 这是"加方言只需一个文件"的**可执行契约**：
 *   - 注册表必须覆盖 `DIALECTS` 里的每一个方言；
 *   - 每个方言必须能给**每一个**逻辑类型**出**一个非空列类型（漏掉一个就是 bug，而不是"运行时才知道"）；
 *   - 公开的旧函数（`columnTypeFor` 等）必须与描述符给出**完全相同**的结果（重构不改行为）。
 */
const LOGICAL_TYPES = [
  'uuid', 'string', 'char', 'text', 'tinyText', 'mediumText', 'bigText',
  'tinyint', 'smallint', 'integer', 'bigint', 'decimal', 'float', 'real',
  'boolean', 'date', 'time', 'timestamp', 'dateTime', 'json', 'blob', 'binary',
] as const;

test('dialect-spec: 注册表覆盖所有方言，且每个方言对每个逻辑类型都能给出列类型', () => {
  assert.deepStrictEqual(
    Object.keys(DIALECT_SPECS).sort(),
    [...DIALECTS].sort(),
    '描述符注册表与公开的 DIALECTS 不一致',
  );
  for (const dialect of DIALECTS) {
    const spec = dialectSpec(dialect);
    assert.strictEqual(spec.name, dialect);
    assert.ok(spec.driverPackage.length > 0, `${dialect} 缺少 driverPackage`);
    for (const logical of LOGICAL_TYPES) {
      const type = spec.columnType(logical, { length: 8, precision: 12, scale: 3 });
      assert.strictEqual(typeof type, 'string', `${dialect}.${logical} 没给出列类型`);
      assert.ok(type.trim().length > 0, `${dialect}.${logical} 的列类型是空的`);
    }
  }
});

test('dialect-spec: 未知方言要明确报错（不能静默当成某一个）', () => {
  assert.throws(() => dialectSpec('oracle' as never), /unknown dialect/i);
});

test('dialect-spec: 公开函数与描述符结果一致（重构不改行为）', () => {
  for (const dialect of DIALECTS) {
    const spec = dialectSpec(dialect);
    for (const logical of LOGICAL_TYPES) {
      assert.strictEqual(
        columnTypeFor(dialect, logical as never, { length: 4 }),
        spec.columnType(logical as never, { length: 4 }),
        `${dialect}.${logical}: 公开函数与描述符结果不一致`,
      );
    }
    assert.strictEqual(spec.placeholder(3), dialect === 'pgsql' ? '$3' : '?');
    assert.strictEqual(spec.quote('x'), dialect === 'mysql' ? '`x`' : '"x"');
  }
});
