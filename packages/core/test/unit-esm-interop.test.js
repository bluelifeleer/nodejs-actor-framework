'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

/**
 * ESM 互操作：包是 CJS，但 ESM 消费者必须能用具名导入。
 *
 * 这条曾经真的坏过：`module.exports = { ..., ...errors }` 里的展开写法会让
 * cjs-module-lexer 放弃分析，于是 `import { ActorStoppedError } from '...'`
 * 直接报 "does not provide an export named ..."，而 `require` 一切正常——
 * 只有 ESM 用户会踩到，且报错信息指向包本身。
 */
test('esm interop: every public export is available as a named ESM export', async () => {
  const cjs = require('nodejs-actor-framework');
  const esm = await import('nodejs-actor-framework');

  const names = Object.keys(cjs);
  assert.ok(names.length >= 30, `expected the public surface, got ${names.length} names`);

  const missing = names.filter((name) => !(name in esm));
  assert.deepStrictEqual(
    missing,
    [],
    `these names cannot be imported from ESM (spread in module.exports?): ${missing.join(', ')}`,
  );

  // Identity must match, not just presence (guards against duplicate instances).
  for (const name of names) {
    assert.strictEqual(esm[name], cjs[name], `esm.${name} !== require(...).${name}`);
  }
});
