'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor, freePort } = require('./helpers');

const tempDir = setupTempEnv('actor-remote');

const { createSystem, RemoteRef } = require('../src/index.js');

test.after(() => cleanup(tempDir));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two systems wired to each other over the framed gateway. */
async function twoNodes(t, options = {}) {
  const server = createSystem({ logger: false, name: 'node-a', ...options });
  const client = createSystem({ logger: false, name: 'node-b' });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  const peer = await client.connect({ host: '127.0.0.1', port });
  const close = async () => {
    await client.stop();
    await server.stop();
  };
  if (t && typeof t.after === 'function') t.after(close);
  return { server, client, peer, port, close };
}

test('remote: ask and tell reach an actor on another node', async (t) => {
  const { server, peer } = await twoNodes(t);

  const seen = [];
  await server.spawn(
    {
      preStart() {
        this.state = { hp: 100 };
      },
      onMessage(msg) {
        seen.push(msg);
        if (msg.type === 'hurt') {
          this.state.hp -= msg.damage;
          return this.state.hp;
        }
        return 'noted';
      },
    },
    { id: 'player' },
  );

  const remote = peer.ref('player');
  assert.ok(remote instanceof RemoteRef);
  assert.strictEqual(remote.isLocal, false);
  assert.strictEqual(remote.path, 'player');
  assert.strictEqual(remote.id, 'player');

  // request/response
  assert.strictEqual(await remote.ask({ type: 'hurt', damage: 5 }), 95);
  assert.strictEqual(await remote.ask({ type: 'hurt', damage: 5 }), 90);

  // fire and forget: it is handed to the transport, then applied remotely
  assert.strictEqual(remote.tell({ type: 'poke' }), true);
  await waitFor(() => seen.some((m) => m.type === 'poke'), { message: 'the tell to arrive' });

  assert.strictEqual(server.inspect('player').state.hp, 90);
});

test('remote: an actor can ask a remote actor by spec through ctx', async (t) => {
  const { server, client, port } = await twoNodes(t);
  await server.spawn(async (msg) => `remote-says:${msg.n}`, { id: 'echo' });

  // "path@host:port" works from inside an actor, exactly like a local name.
  const caller = await client.spawn(
    async (msg, ctx) => ctx.ask(`echo@127.0.0.1:${port}`, { n: 7 }),
    { id: 'caller' },
  );
  assert.strictEqual(await caller.ask('go', 4000), 'remote-says:7');
});

test('remote: errors and unknown actors cross the network intact', async (t) => {
  const { peer } = await twoNodes(t);

  await assert.rejects(() => peer.ask('ghost', { type: 'x' }, 2000), /no actor registered/);
  await assert.rejects(() => peer.ref('ghost').stop(), /no actor registered/);
});

test('remote: a handler failure is reported to the caller', async (t) => {
  const { server, peer } = await twoNodes(t);
  await server.spawn(async (msg) => {
    if (msg.type === 'boom') throw new Error('remote boom');
    return 'ok';
  }, { id: 'flaky' });

  await assert.rejects(() => peer.ref('flaky').ask({ type: 'boom' }, 3000), /remote boom/);
  // The actor was restarted by its own supervisor and is usable again.
  await waitFor(async () => {
    try {
      return (await peer.ref('flaky').ask({ type: 'ok' }, 2000)) === 'ok';
    } catch {
      return false;
    }
  }, { message: 'the remote actor to recover' });
});

test('remote: the sender path and the trace survive the node boundary', async (t) => {
  const tracing = require('../src/plugins/tracing');
  const server = createSystem({ logger: false, name: 'trace-a', plugins: [tracing()] });
  const client = createSystem({ logger: false, name: 'trace-b', plugins: [tracing()] });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  const peer = await client.connect({ host: '127.0.0.1', port });
  t.after(async () => {
    await client.stop();
    await server.stop();
  });

  // On the peer node: report who asked and which trace we are in.
  await server.spawn(async (msg, ctx) => ({
    sender: ctx.sender ? ctx.sender.path : null,
    senderIsLocal: ctx.sender ? ctx.sender.isLocal : null,
    traceId: ctx.trace ? ctx.trace.traceId : null,
    spanId: ctx.trace ? ctx.trace.spanId : null,
    parentSpanId: ctx.trace ? ctx.trace.parentSpanId : null,
  }), { id: 'reporter' });

  // On this node: an actor that calls the remote actor.
  const caller = await client.spawn(async (msg, ctx) => ctx.ask('reporter@127.0.0.1:' + port, { hi: 1 }, 3000), { id: 'caller' });
  const seen = await caller.ask('go', 5000);

  assert.strictEqual(seen.sender, 'caller', 'the remote handler sees who asked');
  assert.strictEqual(seen.senderIsLocal, false, 'and knows it is not a local actor');
  assert.ok(seen.traceId, 'the handler is inside a trace');
  assert.notStrictEqual(seen.spanId, null);
  assert.notStrictEqual(seen.parentSpanId, null, 'the remote span is a child of the caller span');

  // A remote sender cannot be told/asked directly; the error says what to do.
  await server.spawn(async (msg, ctx) => {
    try {
      ctx.tell(ctx.sender, { nope: true });
      return 'no error';
    } catch (err) {
      return err.message;
    }
  }, { id: 'try-reply' });
  const direct = await client.spawn(async (msg, ctx) => {
    const r = await ctx.ask('try-reply@127.0.0.1:' + port, 'x', 3000);
    return r;
  }, { id: 'direct' });
  assert.match(await direct.ask('go', 5000), /cannot tell\(\) a remote sender/);
});

test('remote: the caller\'s timeout is honoured, not replaced by the server default', async (t) => {
  const server = createSystem({ logger: false, name: 'slow-node' });
  const client = createSystem({ logger: false, name: 'impatient-node' });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  const peer = await client.connect({ host: '127.0.0.1', port });
  t.after(async () => {
    await client.stop();
    await server.stop();
  });

  await server.spawn(() => new Promise(() => {}), { id: 'black-hole' });

  const startedAt = Date.now();
  await assert.rejects(() => peer.ref('black-hole').ask('x', 250), /timed out/i);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `the caller timeout (250ms) must travel with the request, took ${elapsed}ms`);
  await server.ref('black-hole').stop();
});

test('remote: stop() stops an actor on the peer node', async (t) => {
  const { server, peer } = await twoNodes(t);
  await server.spawn(async () => 'ok', { id: 'doomed' });
  assert.ok(server.resolve('doomed'));

  assert.strictEqual(await peer.ref('doomed').stop(), true);
  await waitFor(() => server.resolve('doomed') === null, { message: 'the remote actor to stop' });
});

test('remote: inspect() explains that it is local-only', async (t) => {
  const { peer } = await twoNodes(t);
  assert.throws(() => peer.ref('anything').inspect(), /local-only/);
});

test('remote: system.remote() resolves "path@host:port" and single-peer specs', async (t) => {
  const { server, client, peer, port } = await twoNodes(t);
  await server.spawn(async () => 'hi', { id: 'greeter' });

  const viaSpec = client.remote(`greeter@127.0.0.1:${port}`);
  assert.strictEqual(viaSpec.path, 'greeter');
  assert.strictEqual(await viaSpec.ask('x'), 'hi');

  // With exactly one peer a bare path also works.
  assert.strictEqual(await client.remote('greeter').ask('y'), 'hi');

  // A second peer makes the bare form ambiguous.
  const other = createSystem({ logger: false, name: 'node-c' });
  const otherPort = await other.listen({ host: '127.0.0.1', port: 0 });
  await client.connect({ host: '127.0.0.1', port: otherPort });
  assert.throws(() => client.remote('greeter'), /needs "path@host:port"/);
  assert.throws(() => client.remote('greeter@10.9.9.9:1'), /no peer/);
  assert.strictEqual(client.listPeers().length, 2);
  await other.stop();
  assert.ok(peer);
});

test('remote: the peer node id is learned from the handshake', async (t) => {
  const { peer } = await twoNodes(t);
  assert.strictEqual(peer.nodeId, 'node-a');
  assert.strictEqual(peer.describe(), 'node-a(127.0.0.1:' + peer.port + ')');
  assert.strictEqual(await peer.ping(), true);
});

test('remote: an unreachable peer rejects instead of hanging', async () => {
  const client = createSystem({ logger: false, name: 'lonely' });
  const closedPort = await freePort();
  try {
    const peer = await client.connect({ host: '127.0.0.1', port: closedPort, timeoutMs: 300 });
    await assert.rejects(() => peer.ref('a').ask('x', 400), /timed out|ECONNREFUSED|closed/);
  } finally {
    await client.stop();
  }
});

test('remote: connecting twice returns the same peer and stop() cleans up', async (t) => {
  const { server, client, port } = await twoNodes(t);
  await server.spawn(async () => 'ok', { id: 'a' });

  const first = await client.connect({ host: '127.0.0.1', port });
  const second = await client.connect({ host: '127.0.0.1', port });
  assert.strictEqual(first, second, 'peers are pooled by address');

  // system.stop() closes the server gateway and every peer connection.
  await client.stop();
  await waitFor(() => client.listPeers().length === 0, { message: 'peers to be cleared' });
  await server.stop();
});

test('remote: tell does not allocate a reply and survives a slow peer', async (t) => {
  const { server, peer } = await twoNodes(t);

  let handled = 0;
  await server.spawn(async () => {
    await sleep(20);
    handled += 1;
    return 'ok';
  }, { id: 'slow', mailbox: { maxSize: 1000 } });

  const remote = peer.ref('slow');
  const started = Date.now();
  for (let i = 0; i < 50; i += 1) assert.strictEqual(remote.tell(i), true);
  const tellMs = Date.now() - started;
  assert.ok(tellMs < 100, `50 tells should be fast, took ${tellMs}ms`);

  await waitFor(() => handled === 50, { message: 'all remote tells to be handled', timeout: 8000 });
});
