'use strict';

/**
 * 审计 Round 2 的回归测试：网关 / gossip / WebSocketServer 的守卫与"界"。
 *
 * 修复前这些用例必须失败——它们对应审计里的：
 *   S1 网关默认零认证（且库内没有"非回环必须 TLS"的守卫，而 README 推荐 0.0.0.0）；
 *   S2 gossip 注册表可被投毒/撑爆、可被注入任意拨号地址；
 *   S3 WS 分片消息没有累计长度上限；
 *   S4 网关入站无在途上限；
 *   S5 WS 无连接数上限；
 *   S7 TLS 的 requestCert=false + verifyNodeId=false 组合 = 零客户端认证；
 *   S9 控制帧不校验 ≤125 与 FIN；
 *   S12 gossip 用字符数当字节数；
 *   另有：Gateway/WebSocketServer 的 `emit('error')` 在无监听者时会抛（与已修的 F1 同类）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const Gateway = require('../src/cluster/gateway.ts');
const Gossip = require('../src/cluster/gossip.ts');
const proto = require('../src/cluster/proto.ts');
const { createFraming, CODEC } = require('../src/cluster/framing.ts');
const { WebSocketServer, WebSocketConnection, OPCODE, connect: wsConnect } = require('../src/ops/ws-server.ts');

const framing = createFraming({
  protoEncode: proto.encodeGossipEnvelope,
  protoDecode: proto.decodeGossipEnvelope,
});

/**
 * 无论断言成败都要**先销毁客户端、再关服务**。
 *
 * 这条纪律是本轮踩出来的：修前这些断言必然失败，而只要有一条连接没销毁，`server.close()`
 * 就会一直等它 → 整个测试进程挂住（看起来像"测试超时"，实际是我的清理没做全）。
 */
async function shutdown(...handles) {
  for (const handle of handles) {
    try {
      if (handle instanceof Set) {
        for (const entry of handle) entry.destroy?.();
        continue;
      }
      handle?.destroy?.();
    } catch {
      /* 已经关了 */
    }
  }
  for (const handle of handles) {
    try {
      await handle?.close?.();
    } catch {
      /* 已经关了 */
    }
  }
}

/** 等一小会儿（让内核把入站帧处理完）。 */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

test('audit/gateway: 非回环绑定且未启用 TLS 时必须拒绝启动（除非显式 opt-in）', async () => {
  const gateway = new Gateway({ host: '0.0.0.0', port: 0 });
  const allowed = new Gateway({ host: '0.0.0.0', port: 0, allowInsecureBinding: true });
  try {
    // 断言失败也要先关掉（修前 listen() 会成功 → 不关就会泄漏监听器，把测试进程挂住）
    await assert.rejects(
      () => gateway.listen(),
      /refusing to|TLS/i,
      '网关在 0.0.0.0 上裸奔启动（同网段任何人都能 tell/deliver/stop 任意 Actor）',
    );
    const port = await allowed.listen();
    assert.ok(port > 0);
  } finally {
    await allowed.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
});

test('audit/gateway: TLS 开了但 requestCert=false + verifyNodeId=false 的组合必须拒绝启动', async () => {
  const tls = {
    enabled: true,
    key: 'packages/core/test/fixtures/tls/node-1.key',
    cert: 'packages/core/test/fixtures/tls/node-1.crt',
    ca: 'packages/core/test/fixtures/tls/ca.crt',
    requestCert: false,
    verifyNodeId: false,
  };
  const gateway = new Gateway({ host: '127.0.0.1', port: 0, tls });
  try {
    await assert.rejects(
      () => gateway.listen(),
      /requestCert|verifyNodeId|client certificate/i,
      '这两个开关同时关掉时，TLS 开着却零客户端认证',
    );
  } finally {
    await gateway.close().catch(() => {});
  }
});

test('audit/gateway: 绑定失败时 listen() 必须 reject —— 不得因为没人监听 error 而抛出未捕获异常', async () => {
  const first = new Gateway({ host: '127.0.0.1', port: 0 });
  const port = await first.listen();
  try {
    const second = new Gateway({ host: '127.0.0.1', port });
    // 没有挂任何 'error' 监听者：过去这里会在 net server 的 error 回调里抛 ERR_UNHANDLED_ERROR，
    // 于是 reject 永远不执行 —— 用时间界把它变成"有界失败"而不是挂住测试进程。
    let settled = false;
    const outcome = await Promise.race([
      second.listen().then(
        () => { settled = true; return 'resolved'; },
        (err) => { settled = true; return `rejected:${err.code ?? err.message}`; },
      ),
      settle(3000).then(() => 'TIMEOUT'),
    ]);
    assert.notStrictEqual(outcome, 'TIMEOUT', 'listen() 既没 resolve 也没 reject（无人监听 error 导致抛错，reject 没执行）');
    assert.strictEqual(settled, true);
    assert.match(outcome, /rejected:.*(EADDRINUSE|address)/i);
  } finally {
    await first.close();
  }
});

test('audit/gateway: 单连接的在途请求必须有上限（否则一条连接就能堆无限 handler）', async () => {
  const gateway = new Gateway({
    host: '127.0.0.1',
    port: 0,
    maxInflightPerConnection: 8,
    onDeliver: () => new Promise(() => {}), // 永不返回，模拟慢 handler
  });
  const port = await gateway.listen();
  let overloaded = 0;
  gateway.on('overloaded', () => (overloaded += 1));
  try {
    const frames = [];
    for (let i = 0; i < 64; i += 1) {
      frames.push(Gateway.encodeFrame({ kind: 'deliver', id: `i${i}`, targetActorId: 'slow', payload: { i } }));
    }
    const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.concat(frames)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(overloaded >= 1, `在途上限没有生效：inflight=${gateway.inflight()}（应当封顶并发出 overloaded）`);
    assert.ok(gateway.inflight() <= 16, `inflight 超过了上限：${gateway.inflight()}`);
    socket.destroy();
  } finally {
    await gateway.close();
  }
});

test('audit/gossip: 注册表要有条目上限，未来时间戳不得永久压住 LWW', async () => {
  const gossip = new Gossip('victim', 0, { host: '127.0.0.1', maxRegistryEntries: 16, peerTimeoutMs: 200, intervalMs: 100 });
  const port = await gossip.start().then(() => gossip.boundPort);
  try {
    const attacker = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => attacker.on('connect', resolve));
    const flood = {};
    for (let i = 0; i < 128; i += 1) {
      flood[`evil:${i}`] = { key: `evil:${i}`, value: { host: '127.0.0.1', port: 1 }, ts: Date.now(), nodeId: 'zzz' };
    }
    attacker.write(framing.encode({ type: 'gossip', sender: 'attacker', advertiseHost: '127.0.0.1', port: 1, data: flood }, CODEC.JSON));
    // 未来时间戳 + 大 nodeId：过去可以永久压住后续更新
    attacker.write(
      framing.encode(
        {
          type: 'gossip',
          sender: 'attacker',
          advertiseHost: 'evil.example',
          port: 1337,
          data: { 'actor:admin': { key: 'actor:admin', value: { host: '127.0.0.1', port: 1 }, ts: Date.now() + 1e9, nodeId: 'zzz' } },
        },
        CODEC.JSON,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      gossip.localRegistry.size <= 16,
      `注册表被撑爆：${gossip.localRegistry.size} 条（上限 16）`,
    );
    assert.strictEqual(
      gossip.localRegistry.get('actor:admin'),
      undefined,
      '未来时间戳的条目被接受了（可以永久压住合法更新）',
    );
    attacker.destroy();
  } finally {
    await gossip.stop();
  }
});

test('audit/gossip: 学到的对等地址要有上限', async () => {
  const gossip = new Gossip('victim', 0, { host: '127.0.0.1', maxPeers: 8, peerTimeoutMs: 200, intervalMs: 100 });
  const port = await gossip.start().then(() => gossip.boundPort);
  try {
    const attacker = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => attacker.on('connect', resolve));
    for (let round = 0; round < 10; round += 1) {
      const peers = [];
      for (let i = 0; i < 64; i += 1) peers.push({ host: '127.0.0.1', port: 1024 + i });
      attacker.write(
        framing.encode({ type: 'gossip', sender: `attacker-${round}`, advertiseHost: '127.0.0.1', port: 1, peers }, CODEC.JSON),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(gossip.peers.size <= 8, `对等地址表被撑爆：${gossip.peers.size} 条（上限 8）`);
    attacker.destroy();
  } finally {
    await gossip.stop();
  }
});

test('audit/gossip: exportState 必须按字节计费（多字节值不得让整帧超过 maxFrameBytes）', () => {
  const gossip = new Gossip('n', 0, { host: '127.0.0.1', maxPayloadBytes: 100000 });
  gossip.setLocal('k', { blob: '中'.repeat(60000) });
  const payload = gossip._payload();
  const buf = framing.encode(payload, CODEC.PROTOBUF);
  assert.ok(
    buf.length <= gossip.maxFrameBytes,
    `帧大小 ${buf.length} 超过 maxFrameBytes ${gossip.maxFrameBytes}（用字符数当字节数算错了预算）`,
  );
});

test('audit/ws: 分片消息必须有累计长度上限', async () => {
  const closedCodes = [];
  const serverSockets = new Set();
  let client = null;
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    const connection = new WebSocketConnection(socket, { maxPayloadBytes: 1024 });
    connection.on('close', (code) => closedCodes.push(code));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    client = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = (opcode, payload, fin) => {
      const header = Buffer.alloc(4);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
      return Buffer.concat([header, mask, masked]);
    };
    const chunk = Buffer.alloc(1024);
    client.write(frame(OPCODE.BINARY, chunk, false));
    for (let i = 0; i < 20; i += 1) client.write(frame(OPCODE.CONTINUATION, chunk, false));
    // 有界等待 close 帧走完握手（实测约 300~500ms）
    for (let i = 0; i < 40 && !closedCodes.includes(1009); i += 1) await settle(50);
    assert.ok(closedCodes.includes(1009), `分片累计超过上限却没有以 1009 关闭（实际：${JSON.stringify(closedCodes)}）`);
  } finally {
    // 服务端那一侧的 socket 也要销毁：否则 net.Server.close() 会一直等它（测试进程挂住）
    await shutdown(client, serverSockets, server);
  }
});

test('audit/ws: 控制帧必须 ≤125 字节且不可分片（RFC 6455 §5.5）', async () => {
  const sent = [];
  const serverSockets = new Set();
  let client = null;
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    const connection = new WebSocketConnection(socket, { maxPayloadBytes: 4 * 1024 * 1024 });
    connection.on('sent', (info) => sent.push(info));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    client = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    const mask = Buffer.from([9, 9, 9, 9]);
    const frame = (opcode, payload, fin) => {
      const header = Buffer.alloc(10);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
      return Buffer.concat([header, mask, masked]);
    };
    client.write(frame(OPCODE.PING, Buffer.alloc(1024), true)); // 超长控制帧
    client.write(frame(OPCODE.PING, Buffer.from('x'), false)); // 分片控制帧
    await settle();
    const hugePongs = sent.filter((info) => info.opcode === OPCODE.PONG && Number(info.length) > 125);
    assert.deepStrictEqual(hugePongs, [], `服务端把超长/分片控制帧原样回显了：${JSON.stringify(hugePongs)}`);
  } finally {
    await shutdown(client, serverSockets, server);
  }
});

test('audit/ws: WebSocketServer 必须有连接数上限', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxConnections: 2 });
  const clients = [];
  try {
    const port = await server.listen();
    for (let i = 0; i < 5; i += 1) {
      // 用库自己的客户端做**真实握手**（发半截 HTTP 会被服务端立刻断开，测不到上限）
      const client = await wsConnect(`ws://127.0.0.1:${port}`).catch(() => null);
      if (client !== null) clients.push(client);
    }
    await settle(400);
    const accepted = clients.filter((client) => client.socket !== null && client.socket.destroyed === false).length;
    assert.ok(accepted <= 2, `连接数上限没生效：完成了 ${accepted} 条握手（上限 2）`);
  } finally {
    for (const client of clients) {
      try {
        client.socket?.destroy?.();
      } catch {
        /* 已关 */
      }
    }
    await server.close();
  }
});

test('audit/system: 对等体数量必须有上限（入站帧可被动撑大 peers）', async () => {
  const { createSystem } = require('../src/index.ts');
  const system = createSystem({ logger: false, maxPeers: 1, shutdownTimeoutMs: 300 });
  try {
    // 第一个：连不上的地址也会被登记（handshake 是 best-effort）
    await system.connect({ host: '127.0.0.1', port: 1, timeoutMs: 200 }).catch(() => null);
    assert.strictEqual(system.peers.size, 1, '第一个对等体应当被登记');
    await assert.rejects(
      () => system.connect({ host: '127.0.0.1', port: 2, timeoutMs: 200 }),
      /peer limit reached/i,
      '超过上限时应当明确拒绝，而不是无声增长',
    );
  } finally {
    await system.stop().catch(() => {});
  }
});

test('audit/ws: WebSocketServer 绑定非回环且无 TLS/verifyClient 时必须拒绝启动', async () => {
  const { WebSocketServer } = require('../src/ops/ws-server.ts');
  const server = new WebSocketServer({ host: '0.0.0.0', port: 0 });
  try {
    await assert.rejects(() => server.listen(), /refusing to bind/i);
  } finally {
    await server.close().catch(() => {});
  }
  // 显式 opt-in 放行
  const allowed = new WebSocketServer({ host: '0.0.0.0', port: 0, allowInsecureBinding: true });
  try {
    const port = await allowed.listen();
    assert.ok(port > 0);
  } finally {
    await allowed.close().catch(() => {});
  }
});
