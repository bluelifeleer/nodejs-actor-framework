'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-gw-fence');

const { Gateway, encodeFrame, CODEC } = require('../src/cluster/gateway.ts');
const { encodeGatewayFrame, decodeGatewayFrame } = require('../src/cluster/proto.ts');

test.after(() => cleanup(tempDir));

/** 两个网关 + 可注入的所有权判定钩子；保证关闭，避免漏 socket 卡住测试。 */
async function withPair(specA = {}, specB = {}) {
  const a = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'node-a', onDeliver: async () => 'ok', ...specA });
  const b = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'node-b', onDeliver: async () => 'ok', ...specB });
  await a.listen();
  await b.listen();
  const close = async () => {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  };
  return { a, b, close };
}

const bAddr = (b) => ({ host: '127.0.0.1', port: b.boundPort });

test('fencing(proto): 旧帧（无 shardEpoch）解码不报错；新字段能往返', () => {
  const oldFrame = encodeGatewayFrame({ kind: 'deliver', id: 'x', targetActorId: 'a' });
  const decodedOld = decodeGatewayFrame(oldFrame);
  assert.strictEqual(decodedOld.shardEpoch, undefined, '老帧上没有这个字段');
  assert.strictEqual(decodedOld.targetActorId, 'a', '老帧的其它字段照常');

  const newBuffer = encodeGatewayFrame({ kind: 'deliver', id: 'x', targetActorId: 'a', shardEpoch: 7 });
  assert.strictEqual(decodeGatewayFrame(newBuffer).shardEpoch, 7, '新字段往返');

  // 两个编码路径都必须带 caps / shardCount：JSON 路径天然带，proto 路径要求字段已登记
  const helloProto = decodeGatewayFrame(encodeGatewayFrame({ kind: 'hello', caps: ['fence'], shardCount: 256 }));
  assert.deepStrictEqual({ caps: helloProto.caps, shardCount: helloProto.shardCount }, { caps: ['fence'], shardCount: 256 });
  const helloJson = (function () {
    const framed = encodeFrame({ kind: 'hello', caps: ['fence'], shardCount: 256 }, CODEC.JSON);
    return JSON.parse(framed.subarray(5).toString('utf8'));
  })();
  assert.deepStrictEqual({ caps: helloJson.caps, shardCount: helloJson.shardCount }, { caps: ['fence'], shardCount: 256 });

  // 未来字段（16）必须被跳过而不是报错——这是"滚动升级"的底层保证
  const { encodeMessage, GATEWAY_FRAME_SCHEMA } = require('../src/cluster/proto.ts');
  // 用 99（真正的"未来字段"）：16/17 已经被 capsJson/shardCount 占用，不能借它们测试
  const withExtra = [...GATEWAY_FRAME_SCHEMA, { name: 'futureThing', no: 99, type: 'string' }];
  const body = encodeMessage(withExtra, { kind: 'deliver', targetActorId: 'a', shardEpoch: 3, futureThing: 'x' });
  const decoded = decodeGatewayFrame(body);
  assert.strictEqual(decoded.shardEpoch, 3);
  assert.strictEqual(decoded.futureThing, undefined, '未知字段被跳过');
});

test('fencing: 对端**声明支持**却没带 epoch → 拒绝（协议违规，不是"老节点"）', async () => {
  const rejections = [];
  const { a, b, close } = await withPair(
    { caps: ['fence'] },
    { onDeliver: async () => 'served', onTell: async () => undefined },
  );
  b.on('ownership_rejected', (reason) => rejections.push(reason));
  try {
    // 直接用底层 request 发一个"声称支持 fencing 但不带 epoch"的帧（老节点的行为）
    const res = await a.request(bAddr(b).host, bAddr(b).port, { kind: 'deliver', targetActorId: 'x', payload: {} }, 2000);
    assert.strictEqual(res.ok, false, '必须拒绝');
    assert.match(res.error, /却没有在帧上带 shardEpoch/);
    assert.strictEqual(rejections.length, 1);
  } finally {
    await close();
  }
});

test('fencing: 对端**不支持** fencing 且没带 epoch → 放行，但发 fencing_skipped（降级可见）', async () => {
  const skipped = [];
  const { a, b, close } = await withPair(
    { caps: [] }, // 老节点：不声明任何能力
    { onDeliver: async () => 'served' },
  );
  b.on('fencing_skipped', (info) => skipped.push(info));
  try {
    const res = await a.request(bAddr(b).host, bAddr(b).port, { kind: 'deliver', targetActorId: 'x', payload: {} }, 2000);
    assert.deepStrictEqual({ ok: res.ok, data: res.data }, { ok: true, data: 'served' }, '软升级：老节点照常工作');
    assert.strictEqual(skipped.length, 1, '但降级必须被看见');
    assert.strictEqual(skipped[0].peerNodeId, 'node-a');
  } finally {
    await close();
  }
});

test('fencing: 带上 epoch 时交给判定钩子——旧 epoch 被拒、新 epoch 通过', async () => {
  const seen = [];
  const { a, b, close } = await withPair(
    { epochFor: () => 2 }, // a 认为目标 shard 是第 2 代
    {
      onDeliver: async () => 'served',
      verifyOwnership: (info) => {
        seen.push(info);
        return info.shardEpoch >= 3 ? { ok: true } : { ok: false, reason: `旧 epoch ${info.shardEpoch} 已被 epoch 3 取代` };
      },
    },
  );
  try {
    await assert.rejects(
      () => a.deliver(bAddr(b).host, bAddr(b).port, 'x', {}, 1500),
      /旧 epoch 2 已被 epoch 3 取代/,
      '旧 epoch 的投递必须失败',
    );
    assert.deepStrictEqual(seen[0], { kind: 'deliver', targetActorId: 'x', shardEpoch: 2, peerNodeId: 'node-a' });

    // 换一个"认为自己是第 3 代"的网关 → 通过
    const fresh = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'node-c', epochFor: () => 3 });
    await fresh.listen();
    try {
      assert.strictEqual(await fresh.deliver(bAddr(b).host, bAddr(b).port, 'x', {}), 'served');
      assert.strictEqual(seen.at(-1).shardEpoch, 3);
    } finally {
      await fresh.close().catch(() => {});
    }
  } finally {
    await close();
  }
});

test('fencing: 入站 tell 被拒时只记事件（没有回信通道，不能静默）', async () => {
  const events = [];
  const { a, b, close } = await withPair(
    { epochFor: () => 1 },
    { onTell: async () => undefined, verifyOwnership: () => ({ ok: false, reason: '不是这个 shard 的 owner' }) },
  );
  b.on('ownership_rejected', (reason, info) => events.push({ reason, kind: info.kind }));
  try {
    a.send(bAddr(b).host, bAddr(b).port, { kind: 'tell', targetActorId: 'x', payload: {}, shardEpoch: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepStrictEqual(events, [{ reason: '不是这个 shard 的 owner', kind: 'tell' }]);
  } finally {
    await close();
  }
});

test('fencing: shardCount 不一致 → 拒绝连接（D6：算错 shard 比拒连接危险）', async () => {
  const rejected = [];
  const { a, b, close } = await withPair(
    { shardCount: 256 },
    { shardCount: 64, onDeliver: async () => 'served' },
  );
  b.on('handshake_rejected', (reason, info) => rejected.push({ reason, nodeId: info.nodeId }));
  try {
    await assert.rejects(
      () => a.request(bAddr(b).host, bAddr(b).port, { kind: 'deliver', targetActorId: 'x', payload: {} }, 1500),
      /shardCount 不一致|socket|closed|ECONNRESET/,
      '连接应当被拒绝',
    );
    assert.strictEqual(rejected.length, 1);
    assert.match(rejected[0].reason, /shardCount 不一致：对端 256，本节点 64/);
    assert.strictEqual(rejected[0].nodeId, 'node-a');
  } finally {
    await close();
  }
});

test('fencing: requireFencing: true 时，不支持 fencing 的对端被拒（硬门，可选）', async () => {
  const rejected = [];
  const { a, b, close } = await withPair(
    { caps: [] }, // 老节点
    { requireFencing: true, onDeliver: async () => 'served' },
  );
  b.on('handshake_rejected', (reason) => rejected.push(reason));
  try {
    await assert.rejects(
      () => a.request(bAddr(b).host, bAddr(b).port, { kind: 'deliver', targetActorId: 'x', payload: {} }, 1500),
      /socket|closed|ECONNRESET|fencing/,
    );
    assert.match(rejected[0], /要求 fencing（requireFencing: true），但对端没有声明支持/);
  } finally {
    await close();
  }
});

test('fencing: 没装守卫时 epoch 只是随行信息（不影响判定，也不报错）', async () => {
  const { a, b, close } = await withPair({ epochFor: () => 5 }, { onDeliver: async () => 'served' });
  try {
    // 用 deliver()（会带上 epoch）；裸 request 不带 epoch，会被"声明支持 fencing"的规则拒掉
    assert.strictEqual(await a.deliver(bAddr(b).host, bAddr(b).port, 'x', {}), 'served');
  } finally {
    await close();
  }
});

test('fencing: 没装守卫时**出站帧不带该字段**（不制造"有 token"的假象）', async () => {
  const gateway = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'plain' });
  try {
    assert.deepStrictEqual(gateway.epochField('anything'), {}, '拿不到 epoch 就返回空对象');
  } finally {
    await gateway.close().catch(() => {});
  }
});
