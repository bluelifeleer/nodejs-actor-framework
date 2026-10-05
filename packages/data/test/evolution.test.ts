import { test } from 'node:test';
import assert from 'node:assert';

import {
  createEventEnvelope,
  createEventRegistry,
  defineEventSchema,
  defineEvolution,
  isSnapshotEnvelope,
} from '../src/index.ts';

const items = defineEventSchema({
  type: 'ItemAdded',
  version: 2,
  upcasts: [{ from: 1, to: 2, up: (e) => ({ ...e, currency: e.currency ?? 'CNY' }) }],
});

test('evolution: 事件规则编译成内核 upcast hook（信封与旧格式都认）', () => {
  const evolution = defineEvolution({ events: [items] });
  assert.strictEqual(typeof evolution.upcast, 'function');
  assert.strictEqual(evolution.decodeSnapshot, undefined);
  assert.strictEqual(evolution.encodeSnapshot, undefined);

  const upcast = evolution.upcast as (raw: unknown) => unknown;
  assert.deepStrictEqual(upcast(createEventEnvelope({ type: 'ItemAdded', version: 1, payload: { price: 1 } })), {
    price: 1,
    currency: 'CNY',
  });
  assert.deepStrictEqual(upcast({ type: 'ItemAdded', price: 2 }), { type: 'ItemAdded', price: 2, currency: 'CNY' });
});

test('evolution: 也可以直接给已建好的注册表', () => {
  const registry = createEventRegistry([items]);
  const evolution = defineEvolution({ events: registry });
  assert.deepStrictEqual((evolution.upcast as (r: unknown) => unknown)({ type: 'ItemAdded', price: 1 }), {
    type: 'ItemAdded',
    price: 1,
    currency: 'CNY',
  });
});

test('evolution: 快照规则编译成 encode/decode 一对 hook，且可往返', () => {
  const evolution = defineEvolution({ snapshot: { version: 2, migrate: (s) => ({ ...(s as object), migrated: true }) } });
  assert.strictEqual(evolution.upcast, undefined);

  const encode = evolution.encodeSnapshot as (state: unknown) => unknown;
  const decode = evolution.decodeSnapshot as (raw: unknown) => unknown;

  const stored = encode({ hp: 1 });
  assert.ok(isSnapshotEnvelope(stored));
  assert.strictEqual((stored as { stateVersion: number }).stateVersion, 2);
  assert.deepStrictEqual(decode(stored), { hp: 1 });

  // 旧格式（裸状态）按 v1 走迁移
  assert.deepStrictEqual(decode({ hp: 1 }), { hp: 1, migrated: true });
});

test('evolution: 什么都不声明 / 只写 legacy → 报错（防拼错字段名静默失效）', () => {
  assert.throws(() => defineEvolution({}), /至少要声明 events 或 snapshot/);
  assert.throws(
    () => defineEvolution({ legacy: () => null } as never),
    /只给 legacy 而没有给 events/,
  );
  // 拼错字段名等于什么都没声明
  assert.throws(() => defineEvolution({ event: [] } as never), /至少要声明 events 或 snapshot/);
});
