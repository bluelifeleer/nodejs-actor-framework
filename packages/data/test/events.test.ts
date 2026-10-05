import { test } from 'node:test';
import assert from 'node:assert';

import {
  createEventEnvelope,
  createEventRegistry,
  defineEventSchema,
  EventSchemaError,
  isEventEnvelope,
  validateEventSchema,
  type EventSchema,
} from '../src/index.ts';

const chain: EventSchema = {
  type: 'ItemAdded',
  version: 3,
  upcasts: [
    { from: 1, to: 2, up: (e) => ({ ...e, currency: e.currency ?? 'CNY' }) },
    { from: 2, to: 3, up: (e) => ({ ...e, price: (e.price as number) * 100 }) },
  ],
};

test('events: schema 写错在**构造期**就报错（链缺口/歧义/未来版本/坏函数）', () => {
  assert.throws(
    () => defineEventSchema({ type: 'X', version: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof EventSchemaError);
      assert.match(err.message, /version 必须是 >= 1/);
      return true;
    },
  );

  // 链缺口：version=3 但只有 1→2
  assert.throws(
    () =>
      defineEventSchema({
        type: 'X',
        version: 3,
        upcasts: [
          { from: 1, to: 2, up: (e) => e },
          { from: 2, to: 2, up: (e) => e }, // to 必须大于 from
        ],
      }),
    /to 必须大于 from/,
  );
  assert.throws(
    () => defineEventSchema({ type: 'X', version: 3, upcasts: [{ from: 1, to: 2, up: (e) => e }] }),
    /升级链有缺口：v2/,
  );

  // 指向未来版本
  assert.throws(
    () => defineEventSchema({ type: 'X', version: 2, upcasts: [{ from: 1, to: 3, up: (e) => e }] }),
    /超过了 schema.version=2/,
  );

  // 同一 from 两条（歧义）
  assert.throws(
    () =>
      defineEventSchema({
        type: 'X',
        version: 3,
        upcasts: [
          { from: 1, to: 2, up: (e) => e },
          { from: 1, to: 3, up: (e) => e },
        ],
      }),
    /两条 from=1/,
  );

  // up 不是函数
  assert.throws(
    () =>
      defineEventSchema({
        type: 'X',
        version: 2,
        upcasts: [{ from: 1, to: 2, up: undefined as never }],
      }),
    /缺少 up 函数/,
  );

  // 非法 schema 的 validate 结果可直接查看（不抛）
  assert.deepStrictEqual(validateEventSchema({ type: '', version: 1 }), ['事件类型 type 必须是非空字符串']);
  assert.deepStrictEqual(validateEventSchema(chain), []);
});

test('events: 一跳升级也合法（1 → 3），并冻结 upcast 的输入', () => {
  const schema = defineEventSchema({
    type: 'Jump',
    version: 3,
    upcasts: [{ from: 1, to: 3, up: (e) => ({ ...e, jumped: true }) }],
  });
  const registry = createEventRegistry([schema]);
  assert.deepStrictEqual(registry.upcast(createEventEnvelope({ type: 'Jump', version: 1, payload: { n: 1 } })), {
    n: 1,
    jumped: true,
  });
});

test('events: 输入被顶层冻结——改写入参会抛错，而不是悄悄污染原始日志', () => {
  const registry = createEventRegistry([
    {
      type: 'Mutate',
      version: 2,
      upcasts: [
        {
          from: 1,
          to: 2,
          up: (e) => {
            e.price = 1; // 不应该这么做：输入是冻结的浅拷贝
            return e;
          },
        },
      ],
    },
  ]);
  assert.throws(
    () => registry.upcast(createEventEnvelope({ type: 'Mutate', version: 1, payload: { price: 0 } })),
    TypeError,
  );
});

test('events: 旧原始 JSON（M3 之前格式）视为 v1 并走升级链', () => {
  const registry = createEventRegistry([chain]);
  // 无信封：只要自带字符串 type 就当 v1
  assert.deepStrictEqual(registry.upcast({ type: 'ItemAdded', price: 3 }), {
    type: 'ItemAdded',
    price: 300,
    currency: 'CNY',
  });
  // 带 eventId/version 的信封同样走链；注意返回的是 **payload 升级后的形状**——
  // 信封的 type 只用于查表，不注入事件体（事件体自带判别字段是使用约定）
  assert.deepStrictEqual(
    registry.upcast(createEventEnvelope({ type: 'ItemAdded', version: 1, payload: { kind: 'ItemAdded', price: 3 } })),
    { kind: 'ItemAdded', price: 300, currency: 'CNY' },
  );
});

test('events: 认不出的旧数据与未知类型都**原样透传**（旧行为 / 滚动升级）', () => {
  const registry = createEventRegistry([chain]);
  // 没有 type 的旧记录：原样返回（= M3 之前行为）
  const opaque = { kind: 'deposit', amount: 5 };
  assert.strictEqual(registry.upcast(opaque), opaque);
  assert.strictEqual(registry.upcast(42), 42);

  // 未注册的类型：信封被拆开，payload 原样放行（老代码读到新事件不该崩）
  assert.deepStrictEqual(registry.upcast(createEventEnvelope({ type: 'Newer', version: 7, payload: { x: 1 } })), {
    x: 1,
  });
  // 已注册类型但数据版本更新：不降级，原样放行
  assert.deepStrictEqual(
    registry.upcast(createEventEnvelope({ type: 'ItemAdded', version: 9, payload: { price: 5 } })),
    { price: 5 },
  );
});

test('events: 自定义 legacy 读取器（如用 kind 当类型）', () => {
  const registry = createEventRegistry([{ type: 'deposit', version: 2, upcasts: [{ from: 1, to: 2, up: (e) => ({ ...e, cents: true }) }] }], {
    legacy: (raw) => {
      const r = raw as { kind?: unknown; amount?: unknown };
      if (typeof r?.kind !== 'string') return null;
      return { type: r.kind, version: 1, payload: raw };
    },
  });
  assert.deepStrictEqual(registry.upcast({ kind: 'deposit', amount: 5 }), { kind: 'deposit', amount: 5, cents: true });
});

test('events: 同类型重复注册报错；currentVersion/types 可用；批量与逐条一致', () => {
  assert.throws(
    () => createEventRegistry([chain, { type: 'ItemAdded', version: 1 }]),
    /被重复注册/,
  );

  const registry = createEventRegistry([chain, { type: 'Other', version: 1 }]);
  assert.strictEqual(registry.currentVersion('ItemAdded'), 3);
  assert.strictEqual(registry.currentVersion('Nope'), null);
  assert.deepStrictEqual(registry.types(), ['ItemAdded', 'Other']);

  const raws = [{ type: 'ItemAdded', price: 1 }, { type: 'Other', y: 2 }];
  assert.deepStrictEqual(registry.upcastAll(raws), raws.map((r) => registry.upcast(r)));
});

test('events: 升级链被"压缩"后读到中间版本 → 运行时给出可诊断的错误', () => {
  // 合法 schema（1 → 3 一跳），但盘上存在 v2 数据（历史中间版本）
  const registry = createEventRegistry([
    { type: 'Squashed', version: 3, upcasts: [{ from: 1, to: 3, up: (e) => ({ ...e, ok: true }) }] },
  ]);
  assert.throws(
    () => registry.upcast(createEventEnvelope({ type: 'Squashed', version: 2, payload: {} })),
    /读到 v2 数据，但没有对应的升级步骤/,
  );
});

test('events: 升级链是纯函数链——同一输入跑两次结果相同', () => {
  const registry = createEventRegistry([chain]);
  const raw = createEventEnvelope({ type: 'ItemAdded', version: 1, payload: { price: 7 } });
  assert.deepStrictEqual(registry.upcast(raw), registry.upcast(raw));
});

test('events: 信封工具（isEventEnvelope / createEventEnvelope）', () => {
  const envelope = createEventEnvelope({ type: 'A', version: 1, payload: { x: 1 }, eventId: 'evt-fixed', at: 123 });
  assert.deepStrictEqual(envelope, { eventId: 'evt-fixed', type: 'A', version: 1, at: 123, payload: { x: 1 } });
  assert.ok(isEventEnvelope(envelope));
  assert.strictEqual(isEventEnvelope({ type: 'A', version: 1 }), false, '缺 payload 不算信封');
  assert.strictEqual(isEventEnvelope({ type: 'A', payload: {} }), false, '缺 version 不算信封');
  assert.strictEqual(isEventEnvelope(null), false);

  const auto = createEventEnvelope({ type: 'A', version: 1, payload: null });
  assert.match(auto.eventId, /^evt-[0-9a-f-]{36}$/);
  assert.strictEqual(typeof auto.at, 'number');

  assert.throws(() => createEventEnvelope({ type: 'A', version: 0, payload: null }), /version 必须是 >= 1/);
});

test('events: readLog —— 序号连续性检查（跳号 / 重复 / 倒退都当场报错）', () => {
  const registry = createEventRegistry([chain]);
  const env = (seq: number, price: number) =>
    createEventEnvelope({ type: 'ItemAdded', version: 3, payload: { type: 'ItemAdded', price }, seq });

  const ok = registry.readLog([env(1, 1), env(2, 2), env(3, 3)]);
  assert.strictEqual(ok.lastSeq, 3);
  assert.strictEqual(ok.events.length, 3);

  assert.throws(() => registry.readLog([env(1, 1), env(3, 3)]), /序号不连续：第 2 条的 seq=3，期望 2/);
  assert.throws(() => registry.readLog([env(1, 1), env(1, 1)]), /没有大于前一条/);
  assert.throws(
    () => registry.readLog([env(2, 1)]),
    /第 1 条的 seq=2，期望 1/,
    '日志从 2 开始同样算断号（确实要从中间读，就用 fromSeq 明确起点）',
  );
});

test('events: readLog —— 旧格式按位置补号（可与信封混排），fromSeq 用于增量重放', () => {
  const registry = createEventRegistry([chain]);
  const legacy = { type: 'ItemAdded', price: 1 }; // 无信封 → 补 1
  const second = createEventEnvelope({ type: 'ItemAdded', version: 1, payload: { type: 'ItemAdded', price: 2 }, seq: 2 });
  const third = createEventEnvelope({ type: 'ItemAdded', version: 1, payload: { type: 'ItemAdded', price: 3 } }); // 无 seq → 补 3

  const all = registry.readLog([legacy, second, third]);
  assert.strictEqual(all.lastSeq, 3);
  assert.deepStrictEqual(
    all.events.map((e) => (e as { price: number }).price),
    [100, 200, 300],
    '混排也要逐条升级',
  );

  const from2 = registry.readLog([legacy, second, third], { fromSeq: 2 });
  assert.deepStrictEqual(
    from2.events.map((e) => (e as { price: number }).price),
    [200, 300],
  );
  assert.strictEqual(from2.lastSeq, 3, 'lastSeq 始终是整段日志的最后序号（与过滤无关）');

  assert.deepStrictEqual(registry.readLog([]), { events: [], lastSeq: null });
});

test('events: seq 是可选字段（M3 第 2b 步之前写的信封没有它），写法与校验', () => {
  const withSeq = createEventEnvelope({ type: 'A', version: 1, payload: null, seq: 7 });
  assert.strictEqual(withSeq.seq, 7);
  const without = createEventEnvelope({ type: 'A', version: 1, payload: null });
  assert.strictEqual('seq' in without, false, '不传就完全不写这个字段');
  assert.ok(isEventEnvelope(without), '没有 seq 的老信封仍然是合法信封');
  assert.throws(() => createEventEnvelope({ type: 'A', version: 1, payload: null, seq: 0 }), /seq 必须是 >= 1/);
});

test('events: readLog —— fromSeq 允许"日志正好从起点开始"（快照截断后的正常形态）', () => {
  const registry = createEventRegistry([chain]);
  const env = (seq: number, price: number) =>
    createEventEnvelope({ type: 'ItemAdded', version: 3, payload: { type: 'ItemAdded', price }, seq });

  // 日志被截断到 3 开始：fromSeq=3 时合法，且只返回 3 之后（含 3）
  const resumed = registry.readLog([env(3, 1), env(4, 2)], { fromSeq: 3 });
  assert.deepStrictEqual(resumed.events.map((e) => (e as { price: number }).price), [1, 2]);
  assert.strictEqual(resumed.lastSeq, 4);

  // 起点与 fromSeq 不一致 → 仍然是断号
  assert.throws(
    () => registry.readLog([env(4, 1)], { fromSeq: 3 }),
    /第 1 条的 seq=4，期望 1（完整日志）或 3（从快照续跑）/,
  );

  // 完整日志 + fromSeq：第一条仍是 1，不受影响
  const full = registry.readLog([env(1, 1), env(2, 2), env(3, 3)], { fromSeq: 3 });
  assert.deepStrictEqual(full.events.map((e) => (e as { price: number }).price), [3]);
});
