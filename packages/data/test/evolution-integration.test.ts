import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSystem } from 'nodejs-actor-framework';
import { FilePersistence } from 'nodejs-actor-framework'; // 公开面成员，从包根导入

import {
  createEventEnvelope,
  defineEventSchema,
  defineEvolution,
  isSnapshotEnvelope,
  StateEvolutionError,
} from '../src/index.ts';

/**
 * 第 1 步的验收：**v1 数据在 v3 代码下可读**。
 *
 * 这里刻意用真实内核 + 真实文件（FilePersistence）跑"旧代码写、新代码读"，
 * 而不是只测纯函数——纯函数自证不了"接线接对了"。
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-data-'));
}

test('events: 旧原始 JSON（v1）在 v3 代码下可读，且盘上日志一字节不改', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir }); // 直接读盘：不带任何演进

  // --- 阶段 1：M3 之前的代码。`ctx.persist` 写的是原始 JSON（无信封） ---
  const v1 = {
    preStart(this: { state: { total: number } }) {
      this.state = { total: 0 };
    },
    async receive(this: { state: { total: number } }, msg: { type: string; price?: number }, ctx: { persist(e: unknown): Promise<unknown> }) {
      if (msg.type === 'add') {
        await ctx.persist({ type: 'ItemAdded', price: msg.price });
        return this.state.total;
      }
      return this.state.total;
    },
    applyEvent(this: { state: { total: number } }, event: { type: string; price: number }) {
      if (event.type === 'ItemAdded') this.state.total += event.price;
    },
  };

  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(v1, { id: 'cart-1', persistence: { mode: 'events' } });
  await ref1.ask({ type: 'add', price: 10 });
  await ref1.ask({ type: 'add', price: 20 });
  assert.strictEqual(await ref1.ask({ type: 'add', price: 30 }), 60, 'v1 代码下总计 60 元');
  await system1.stop();

  const rawBefore = await store.loadEvents('cart-1');
  assert.deepStrictEqual(rawBefore, [
    { type: 'ItemAdded', price: 10 },
    { type: 'ItemAdded', price: 20 },
    { type: 'ItemAdded', price: 30 },
  ]);
  assert.ok(
    rawBefore.every((e) => !('version' in (e as object)) && !('eventId' in (e as object))),
    '存量日志确实是"无信封"的旧格式',
  );

  // --- 阶段 2：v3 代码 + upcast 链。同一个目录、同一个 Actor id ---
  const v3 = {
    preStart(this: { state: { totalCents: number; currency: string | null } }) {
      this.state = { totalCents: 0, currency: null };
    },
    async receive(
      this: { state: { totalCents: number; currency: string | null } },
      msg: { type: string; price?: number },
      ctx: { persist(e: unknown): Promise<unknown> },
    ) {
      if (msg.type === 'add') {
        // 新代码写**带信封**的 v3 事件（信封由数据层产出；内核原样存）。
        // 事件体自带判别字段 `type` —— 这是约定的"事件体自描述"，信封的 type 只用于查表。
        await ctx.persist(
          createEventEnvelope({
            type: 'ItemAdded',
            version: 3,
            payload: { type: 'ItemAdded', price: (msg.price as number) * 100, currency: 'CNY' },
          }),
        );
      }
      return this.state;
    },
    applyEvent(this: { state: { totalCents: number; currency: string | null } }, event: { type: string; price: number; currency: string }) {
      if (event.type === 'ItemAdded') {
        this.state.totalCents += event.price;
        this.state.currency = event.currency;
      }
    },
  };

  const evolution = defineEvolution({
    events: [
      defineEventSchema({
        type: 'ItemAdded',
        version: 3,
        upcasts: [
          { from: 1, to: 2, up: (e) => ({ ...e, currency: e.currency ?? 'CNY' }) },
          { from: 2, to: 3, up: (e) => ({ ...e, price: (e.price as number) * 100 }) },
        ],
      }),
    ],
  });

  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(v3, { id: 'cart-1', persistence: { mode: 'events', evolution } });
  assert.deepStrictEqual(
    await ref2.ask({ type: 'total' }),
    { totalCents: 6000, currency: 'CNY' },
    '三条 v1 旧数据被升级成 v3：（10+20+30）元 → 6000 分',
  );

  // 关键性质：升级只发生在**读取期**，盘上的原始日志没有被改写
  assert.deepStrictEqual(await store.loadEvents('cart-1'), rawBefore, '存量日志必须保持不变');

  // 新写入的事件是新格式（信封 + 当前版本）
  await ref2.ask({ type: 'add', price: 5 });
  assert.deepStrictEqual(
    await ref2.ask({ type: 'total' }),
    { totalCents: 6500, currency: 'CNY' },
    '写入期也必须走同一条演进管线（不能"内存里拿到信封、重放时拿到 payload"）',
  );
  const rawAfterWrite = await store.loadEvents('cart-1');
  assert.strictEqual(rawAfterWrite.length, 4);
  assert.deepStrictEqual(rawAfterWrite[3], {
    eventId: (rawAfterWrite[3] as { eventId: string }).eventId,
    type: 'ItemAdded',
    version: 3,
    at: (rawAfterWrite[3] as { at: number }).at,
    payload: { type: 'ItemAdded', price: 500, currency: 'CNY' },
  });
  assert.match((rawAfterWrite[3] as { eventId: string }).eventId, /^evt-/);
  await system2.stop();

  // --- 阶段 3：混合日志（3 条旧 v1 + 1 条新信封 v3）再次重放 ---
  const system3 = createSystem({ logger: false, persistence: { dir } });
  const ref3 = await system3.spawn(v3, { id: 'cart-1', persistence: { mode: 'events', evolution } });
  assert.deepStrictEqual(
    await ref3.ask({ type: 'total' }),
    { totalCents: 6500, currency: 'CNY' },
    '重放结果必须与写入期完全一致（相同数字即是"写入/重放同形状"的证据）',
  );
  await system3.stop();
});

test('snapshot: 版本不匹配时有迁移就迁移，没有就拒绝启动（且不动数据）', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });

  // --- 阶段 1：M3 之前的代码，快照是裸状态（无信封） ---
  const v1 = {
    preStart(this: { state: { hp: number; hits: number } }) {
      this.state = { hp: 100, hits: 0 };
    },
    async receive(
      this: { state: { hp: number; hits: number } },
      msg: { type: string },
      ctx: { saveSnapshot(): Promise<unknown> },
    ) {
      if (msg.type === 'hit') {
        this.state.hp -= 1;
        this.state.hits += 1;
        await ctx.saveSnapshot();
      }
      return this.state;
    },
  };

  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(v1, { id: 'tank', persistence: { mode: 'snapshot' } });
  assert.deepStrictEqual(await ref1.ask({ type: 'hit' }), { hp: 99, hits: 1 });
  await system1.stop();

  const rawSnapshot = await store.loadSnapshot('tank');
  assert.deepStrictEqual(rawSnapshot, { hp: 99, hits: 1 }, '存量快照是"裸状态"的旧格式');
  assert.strictEqual(isSnapshotEnvelope(rawSnapshot), false);

  // --- 阶段 2a：v2 代码但没有迁移 → 拒绝启动，且数据不被破坏 ---
  const v2 = {
    preStart(this: { state: { hp: number; hits: number; armor: number } }) {
      this.state = { hp: 0, hits: 0, armor: 0 };
    },
    async receive(
      this: { state: { hp: number; hits: number; armor: number } },
      msg: { type: string },
      ctx: { saveSnapshot(): Promise<unknown> },
    ) {
      if (msg.type === 'hit') {
        this.state.hp -= 1;
        this.state.hits += 1;
        await ctx.saveSnapshot();
      }
      return this.state;
    },
  };

  const system2 = createSystem({ logger: false, persistence: { dir } });
  await assert.rejects(
    () =>
      system2.spawn(v2, {
        id: 'tank',
        persistence: { mode: 'snapshot', evolution: defineEvolution({ snapshot: { version: 2 } }) },
      }),
    (err: unknown) => {
      assert.ok(err instanceof StateEvolutionError, `期望 StateEvolutionError，实际 ${String(err)}`);
      assert.match((err as Error).message, /v1/);
      assert.match((err as Error).message, /v2/);
      return true;
    },
    '没有迁移函数时必须拒绝启动，而不是静默用错结构',
  );
  assert.deepStrictEqual(await store.loadSnapshot('tank'), rawSnapshot, '拒绝启动不得改动快照');
  await system2.stop();

  // --- 阶段 2b：v2 代码 + 迁移 → 迁移后可用；再存一次就写成带信封的新格式 ---
  const evolution = defineEvolution({
    snapshot: {
      version: 2,
      migrate: (state, { from, to }) => ({ ...(state as object), armor: from === 1 && to === 2 ? 5 : 0 }),
    },
  });
  const system3 = createSystem({ logger: false, persistence: { dir } });
  const ref3 = await system3.spawn(v2, { id: 'tank', persistence: { mode: 'snapshot', evolution } });
  assert.deepStrictEqual(await ref3.state(), { hp: 99, hits: 1, armor: 5 }, '旧快照被迁移到 v2 结构');

  assert.deepStrictEqual(await ref3.ask({ type: 'hit' }), { hp: 98, hits: 2, armor: 5 });
  const enveloped = await store.loadSnapshot('tank');
  assert.ok(isSnapshotEnvelope(enveloped), '新写入的快照应带信封');
  assert.strictEqual((enveloped as { stateVersion: number }).stateVersion, 2);
  assert.deepStrictEqual((enveloped as { state: unknown }).state, { hp: 98, hits: 2, armor: 5 });
  await system3.stop();

  // --- 阶段 3：重启后（读新格式快照）状态一致 ---
  const system4 = createSystem({ logger: false, persistence: { dir } });
  const ref4 = await system4.spawn(v2, { id: 'tank', persistence: { mode: 'snapshot', evolution } });
  assert.deepStrictEqual(await ref4.state(), { hp: 98, hits: 2, armor: 5 });
  await system4.stop();
});

test('内核 hook：没配 evolution 时行为与 M3 之前完全一致（原样读写）', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });

  const actor = {
    preStart(this: { state: { n: number } }) {
      this.state = { n: 0 };
    },
    async receive(
      this: { state: { n: number } },
      msg: { type: string },
      ctx: { persist(e: unknown): Promise<unknown>; saveSnapshot(): Promise<unknown> },
    ) {
      if (msg.type === 'bump') {
        this.state.n += 1;
        await ctx.persist({ type: 'Bumped', n: this.state.n });
        await ctx.saveSnapshot();
      }
      return this.state;
    },
    applyEvent(this: { state: { n: number } }, event: { n?: number }) {
      if (typeof event.n === 'number') this.state.n = event.n;
    },
  };

  const system = createSystem({ logger: false, persistence: { dir } });
  const ref = await system.spawn(actor, { id: 'plain', persistence: { mode: 'events' } });
  await ref.ask({ type: 'bump' });
  await system.stop();

  assert.deepStrictEqual(await store.loadEvents('plain'), [{ type: 'Bumped', n: 1 }]);
  assert.deepStrictEqual(await store.loadSnapshot('plain'), { n: 1 }, '没有 encodeSnapshot 时快照仍是裸状态');

  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(actor, { id: 'plain', persistence: { mode: 'events' } });
  assert.deepStrictEqual(await ref2.state(), { n: 1 });
  await system2.stop();
});

test('内核 hook：evolution hook 返回 Promise 会被拒绝（写入期与重放期都拒绝）', async () => {
  const dir = tempDir();
  const actor = {
    preStart(this: { state: { n: number } }) {
      this.state = { n: 0 };
    },
    async receive(this: { state: { n: number } }, msg: unknown, ctx: { persist(e: unknown): Promise<unknown> }) {
      await ctx.persist({ type: 'X', n: 1 });
      return this.state;
    },
    applyEvent(this: { state: { n: number } }, event: { n?: number }) {
      if (typeof event.n === 'number') this.state.n += event.n;
    },
  };

  // 先用**不带** evolution 的代码落一条事件（模拟存量日志）
  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(actor, { id: 'async-hook', persistence: { mode: 'events' } });
  await ref1.ask({ type: 'go' });
  await system1.stop();

  const asyncEvolution = { upcast: async (raw: unknown) => raw };

  // (a) 重放期：hook 返回 Promise → 大声失败，而不是把 Promise 喂给 applyEvent
  const system2 = createSystem({ logger: false, persistence: { dir } });
  await assert.rejects(
    () =>
      system2.spawn(actor, {
        id: 'async-hook',
        persistence: { mode: 'events', evolution: asyncEvolution },
      }),
    /must be synchronous/,
  );
  await system2.stop();

  // (b) 写入期走的是**同一条**管线，所以同样当场拒绝（不能"写的时候放过、重启后才炸"）
  const system3 = createSystem({ logger: false, persistence: { dir: tempDir() } });
  const ref3 = await system3.spawn(actor, {
    id: 'async-hook-2',
    persistence: { mode: 'events', evolution: asyncEvolution },
  });
  await assert.rejects(() => ref3.ask({ type: 'go' }), /must be synchronous/);
  await system3.stop();
});
