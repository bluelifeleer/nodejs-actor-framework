import { test } from 'node:test';
import assert from 'node:assert';

import { createKeyValueClient } from '../src/client.ts';
import { createFakeStore } from './fake-store.ts';

/**
 * 键值层测试：用**内存版命令分发器**验证参数拼装与结果解析。
 *
 * 为什么值得这么测：`KeyValueClient` 的实现本质是"领域方法 → Redis 命令"的映射，
 * 最容易错的地方是参数顺序、前缀、以及 `HGETALL` 在 RESP2 下是**扁平数组**这种协议细节。
 */
test('kv: 常用命令的参数拼装与结果类型', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  assert.strictEqual(await kv.set('a', '1'), true);
  assert.strictEqual(await kv.get('a'), '1');
  assert.deepStrictEqual(store.commands.at(-1), ['GET', 'a']);

  assert.deepStrictEqual(await kv.mSet({ b: '2', c: '3' }), undefined);
  assert.deepStrictEqual(await kv.mGet('a', 'b', 'missing'), ['1', '2', null]);

  assert.strictEqual(await kv.incr('counter'), 1);
  assert.strictEqual(await kv.incr('counter', 5), 6);

  assert.strictEqual(await kv.exists('a', 'nope'), 1);
  assert.strictEqual(await kv.del('a', 'b'), 2);
  assert.strictEqual(await kv.get('a'), null);
});

test('kv: SET 的选项（PX/NX）与过期时间', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  await kv.set('k', 'v', { ttlMs: 1500 });
  assert.deepStrictEqual(store.commands.at(-1), ['SET', 'k', 'v', 'PX', '1500']);
  assert.strictEqual(await kv.ttl('k'), 1500);

  // NX：已存在时不覆盖
  assert.strictEqual(await kv.set('k', 'other', { ifNotExists: true }), false);
  assert.deepStrictEqual(store.commands.at(-1), ['SET', 'k', 'other', 'NX']);
  assert.strictEqual(await kv.get('k'), 'v');

  assert.strictEqual(await kv.expire('k', 10), true);
  assert.strictEqual(await kv.ttl('k'), 10);

  await kv.setEx('k2', 'v2', 200);
  assert.deepStrictEqual(store.commands.at(-1), ['SET', 'k2', 'v2', 'PX', '200']);
});

test('kv: 哈希/列表/集合（含 HGETALL 的扁平数组解析）', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  await kv.hSet('h', 'f1', 'v1');
  await kv.hSet('h', 'f2', 'v2');
  assert.strictEqual(await kv.hGet('h', 'f1'), 'v1');
  assert.deepStrictEqual(await kv.hGetAll('h'), { f1: 'v1', f2: 'v2' });
  assert.strictEqual(await kv.hGet('h', 'nope'), null);

  await kv.lPush('l', 'a', 'b');
  assert.deepStrictEqual(await kv.lRange('l', 0, -1), ['b', 'a']);

  await kv.sAdd('s', 'x', 'y');
  assert.deepStrictEqual((await kv.sMembers('s')).sort(), ['x', 'y']);
});

test('kv: 前缀命名空间 —— 每个命令都加上，scan 结果剥掉', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle, { prefix: 'app:' });

  await kv.set('k', 'v');
  assert.deepStrictEqual(store.commands.at(-1), ['SET', 'app:k', 'v']);
  assert.strictEqual(await kv.get('k'), 'v');
  assert.deepStrictEqual(store.commands.at(-1), ['GET', 'app:k']);

  await kv.set('other', 'x');
  const scanned = await kv.scan('0', { match: '*', count: 10 });
  assert.deepStrictEqual(store.commands.at(-1), ['SCAN', '0', 'MATCH', 'app:*', 'COUNT', '10']);
  assert.deepStrictEqual(scanned.keys.sort(), ['k', 'other'], 'scan 结果应当剥掉前缀');
  assert.strictEqual(scanned.cursor, '0');
});

test('kv: 逃生通道（command 任意命令 + raw 原生客户端）', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  const pong = await kv.command<string>(['PING']);
  assert.strictEqual(pong, 'PONG');
  assert.deepStrictEqual(kv.raw, store.handle.raw, 'raw 应当是原生客户端');
});

test('kv: pipeline 是流水线（顺序保证，且明确不是 MULTI/EXEC 事务）', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  const results = await kv
    .pipeline()
    .command(['SET', 'p1', 'a'])
    .command(['SET', 'p2', 'b'])
    .command(['GET', 'p1'])
    .exec();
  assert.deepStrictEqual(results, ['OK', 'OK', 'a']);
  assert.ok(!store.commands.some((args) => args[0] === 'MULTI'), 'pipeline 不该偷偷发 MULTI（名不副实）');
});

test('kv: JSON 便捷方法用可注入的 serialize/parse', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle, {
    serialize: (value) => `custom:${JSON.stringify(value)}`,
    parse: (text) => JSON.parse(text.replace(/^custom:/, '')) as unknown,
  });

  await kv.setJson('obj', { a: 1 }, { ttlMs: 50 });
  const stored = await kv.get('obj');
  assert.strictEqual(stored, 'custom:{"a":1}');
  assert.deepStrictEqual(await kv.getJson('obj'), { a: 1 });
  assert.strictEqual(await kv.getJson('missing'), null);

  // 默认是 JSON
  const plain = createKeyValueClient(createFakeStore().handle);
  await plain.setJson('p', [1, 2]);
  assert.deepStrictEqual(await plain.getJson('p'), [1, 2]);
});

test('kv: 订阅与发布（handler 收到消息）', async () => {
  const store = createFakeStore();
  const kv = createKeyValueClient(store.handle);

  const received: Array<[string, string]> = [];
  const unsubscribe = await kv.subscribe('news', (message, channel) => received.push([channel, message]));
  // 注意："订阅另开一条独立连接"是**驱动层**的事（node-redis/ioredis 的 duplicate），
  // 这一层只负责把 handler 接上去 —— 那条断言在 adapter.test.ts 里。

  await kv.publish('news', 'hello');
  assert.deepStrictEqual(received, [['news', 'hello']]);

  await unsubscribe();
  await kv.publish('news', 'after-unsubscribe');
  assert.deepStrictEqual(received, [['news', 'hello']], '退订之后不该再收到');
});
