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

  /**
   * `__esModule` 是 tsc 编译 CJS 时加的**互操作标记**（`Object.defineProperty(exports, '__esModule', …)`），
   * 不是本包的公共导出：手写的 `src/index.d.ts` 里没有它，用户也不该 import 它。
   * 编译产物（dist）必然带它，所以这里显式排除 —— 但**其余名字一个都不能少**。
   */
  const names = Object.keys(cjs).filter((name) => name !== '__esModule');
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
