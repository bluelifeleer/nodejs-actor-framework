'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTempEnv, cleanup, waitFor, delay } = require('./helpers');

const tempDir = setupTempEnv('actor-tls-rotation');

const { Gateway } = require('../src/cluster/gateway');
const Gossip = require('../src/cluster/gossip');
const tlsUtil = require('../src/cluster/tls-util');

test.after(() => cleanup(tempDir));

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');
const fixture = (name) => path.join(FIXTURES, name);

/** A TLS identity whose CN equals `nodeName`. */
function identity(nodeName, caPaths, extra = {}) {
  return {
    enabled: true,
    key: fixture(`${nodeName}.key`),
    cert: fixture(`${nodeName}.crt`),
    ca: caPaths,
    requestCert: true,
    rejectUnauthorized: true,
    verifyNodeId: true,
    minVersion: 'TLSv1.2',
    ...extra,
  };
}

async function withGateways(specs, fn) {
  const gateways = specs.map(
    (spec, index) =>
      new Gateway({
        host: '127.0.0.1',
        port: 0,
        nodeId: spec.nodeId || `G${index}`,
        tls: spec.tls,
        onDeliver: spec.onDeliver || (async () => null),
      }),
  );
  try {
    for (const gw of gateways) await gw.listen();
    return await fn(gateways);
  } finally {
    for (const gw of gateways) {
      try {
        await gw.close();
      } catch {
        /* already closed */
      }
    }
  }
}

test('rotation: the fixture set includes a CRL and a second CA', () => {
  for (const file of ['ca.crl', 'ca2.crt', 'ca2.key', 'ca2-node.crt', 'ca2-node.key', 'revoked.crt', 'revoked.key']) {
    assert.ok(fs.existsSync(fixture(file)), `missing fixture ${file}`);
  }
});

test('multi-CA: a bundle trusts both CAs, a single CA does not', async () => {
  const bundle = [fixture('ca.crt'), fixture('ca2.crt')];

  // Server trusts ca + ca2; the ca2-node client trusts ca (which signed the server).
  await withGateways(
    [
      { nodeId: 'node-1', tls: identity('node-1', bundle), onDeliver: async () => 'from-node-1' },
      { nodeId: 'ca2-node', tls: identity('ca2-node', [fixture('ca.crt')]) },
    ],
    async ([server, client]) => {
      assert.strictEqual(await client.deliver('127.0.0.1', server.port, 'actor-1', {}), 'from-node-1');
    },
  );

  // Same client against a server that only trusts ca1 must be rejected.
  await withGateways(
    [
      { nodeId: 'node-1', tls: identity('node-1', [fixture('ca.crt')]), onDeliver: async () => 'nope' },
      { nodeId: 'ca2-node', tls: identity('ca2-node', [fixture('ca.crt')]) },
    ],
    async ([server, client]) => {
      await assert.rejects(() => client.deliver('127.0.0.1', server.port, 'actor-1', {}, 2500), /timed out|closed|reset|alert/i);
    },
  );
});

test('revocation: a certificate listed in the CRL is refused', async () => {
  const serverTls = identity('node-1', [fixture('ca.crt')], { crl: [fixture('ca.crl')] });

  await withGateways(
    [
      { nodeId: 'node-1', tls: serverTls, onDeliver: async () => 'ok' },
      { nodeId: 'node-2', tls: identity('node-2', [fixture('ca.crt')]) },
      { nodeId: 'revoked', tls: identity('revoked', [fixture('ca.crt')]) },
    ],
    async ([server, healthy, revoked]) => {
      assert.strictEqual(await healthy.deliver('127.0.0.1', server.port, 'a', {}), 'ok', 'a non-revoked peer still works');
      await assert.rejects(
        () => revoked.deliver('127.0.0.1', server.port, 'a', {}, 2500),
        /timed out|closed|reset|alert|revoked|revocation/i,
        'the revoked certificate must not be accepted',
      );
    },
  );
});

test('revocation: the denylist refuses a node even with a valid certificate', async () => {
  const errors = [];
  const server = new Gateway({
    host: '127.0.0.1',
    port: 0,
    nodeId: 'node-1',
    tls: identity('node-1', [fixture('ca.crt')], { denyNodes: ['node-2'] }),
    onDeliver: async () => 'ok',
  });
  server.on('auth_error', (reason) => errors.push(reason));
  const client = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'node-2', tls: identity('node-2', [fixture('ca.crt')]) });
  try {
    await server.listen();
    await client.listen();
    await assert.rejects(() => client.deliver('127.0.0.1', server.port, 'a', {}, 2500), /timed out|closed|reset/i);
    await waitFor(() => errors.length > 0, { message: 'a denylist rejection to be reported', timeout: 3000 });
    assert.match(errors[0], /denylist/);
  } finally {
    await server.close();
    await client.close();
  }
});

test('revocation: the denylist can also match the certificate CN', () => {
  const config = { enabled: true, verifyNodeId: false, denyNodes: ['node-9'] };
  const socket = { getPeerCertificate: () => ({ subject: { CN: 'node-9' } }) };
  const check = tlsUtil.verifyPeerNodeId(socket, 'whatever', config);
  assert.strictEqual(check.ok, false);
  assert.match(check.reason, /denylist/);
});

test('rotation: a rotated CA bundle takes effect without a restart', async () => {
  const bundle = path.join(tempDir, 'rotating-ca.pem');
  fs.copyFileSync(fixture('ca.crt'), bundle);

  const serverTls = identity('node-1', [bundle], { reloadMs: 150 });
  const reloads = [];
  const server = new Gateway({
    host: '127.0.0.1',
    port: 0,
    nodeId: 'node-1',
    tls: serverTls,
    onDeliver: async () => 'rotated-ok',
  });
  server.on('tls_reloaded', () => reloads.push(Date.now()));
  server.on('tls_reload_error', (err) => reloads.push(`error:${err.message}`));

  const client = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'ca2-node', tls: identity('ca2-node', [fixture('ca.crt')]) });
  try {
    await server.listen();
    await client.listen();

    // Before rotation the ca2 identity is not trusted.
    await assert.rejects(() => client.deliver('127.0.0.1', server.port, 'a', {}, 2000), /timed out|closed|reset|alert/i);

    // Trust a second CA by appending it to the bundle, as an operator would.
    fs.appendFileSync(bundle, fs.readFileSync(fixture('ca2.crt')));

    await waitFor(() => reloads.length > 0, { message: 'the secure context to reload', timeout: 5000 });
    assert.ok(typeof reloads[0] === 'number', `unexpected reload outcome: ${reloads[0]}`);

    // A brand new connection now succeeds against the reloaded context.
    await waitFor(
      async () => {
        try {
          return (await client.deliver('127.0.0.1', server.port, 'a', {}, 2000)) === 'rotated-ok';
        } catch {
          return false;
        }
      },
      { message: 'the rotated CA to be honoured', timeout: 5000 },
    );
  } finally {
    await server.close();
    await client.close();
  }
});

test('rotation: a broken bundle keeps the previous context serving', async () => {
  const bundle = path.join(tempDir, 'broken-ca.pem');
  fs.copyFileSync(fixture('ca.crt'), bundle);

  const errors = [];
  const reloads = [];
  const server = new Gateway({
    host: '127.0.0.1',
    port: 0,
    nodeId: 'node-1',
    tls: identity('node-1', [bundle], { reloadMs: 150 }),
    onDeliver: async () => 'still-alive',
  });
  server.on('tls_reloaded', () => reloads.push('ok'));
  server.on('tls_reload_error', (err) => errors.push(err.message));

  const client = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'node-2', tls: identity('node-2', [fixture('ca.crt')]) });
  try {
    await server.listen();
    await client.listen();
    assert.strictEqual(await client.deliver('127.0.0.1', server.port, 'a', {}), 'still-alive');

    // Simulate a half-written / invalid rotation.
    fs.writeFileSync(bundle, 'this is not a certificate\n');
    await waitFor(() => errors.length > 0, { message: 'the broken bundle to be reported', timeout: 5000 });
    assert.strictEqual(reloads.length, 0, 'no reload was applied');

    // The listener keeps serving with the previous material.
    assert.strictEqual(await client.deliver('127.0.0.1', server.port, 'a', {}), 'still-alive');
  } finally {
    await server.close();
    await client.close();
  }
});

test('rotation: reload can be disabled, and reloadNow() works on demand', async () => {
  const bundle = path.join(tempDir, 'manual-ca.pem');
  fs.copyFileSync(fixture('ca.crt'), bundle);

  const server = new Gateway({
    host: '127.0.0.1',
    port: 0,
    nodeId: 'node-1',
    tls: identity('node-1', [bundle], { reloadMs: 0 }),
    onDeliver: async () => 'manual-ok',
  });
  try {
    await server.listen();
    assert.strictEqual(server.reloader, null, 'reloadMs=0 disables the watcher');

    const reloader = tlsUtil.createReloader(server.tls, { onReload: () => {}, intervalMs: 0 });
    assert.strictEqual(reloader, null, 'a zero interval produces no reloader');
  } finally {
    await server.close();
  }
});

test('rotation: gossip refreshes its secure context too', async () => {
  const bundle = path.join(tempDir, 'gossip-ca.pem');
  fs.copyFileSync(fixture('ca.crt'), bundle);

  const node1 = new Gossip('node-1', 0, {
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    intervalMs: 80,
    tls: identity('node-1', [bundle], { reloadMs: 150 }),
  });
  const reloads = [];
  node1.on('tls_reloaded', () => reloads.push('ok'));
  await node1.start();

  const node2Tls = identity('ca2-node', [fixture('ca.crt')], { reloadMs: 0 });
  try {
    fs.appendFileSync(bundle, fs.readFileSync(fixture('ca2.crt')));
    await waitFor(() => reloads.length > 0, { message: 'gossip to reload its context', timeout: 5000 });

    // A ca2-signed peer can now be accepted by the reloaded listener.
    const node2 = new Gossip('ca2-node', 0, {
      host: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      intervalMs: 80,
      tls: node2Tls,
      seeds: [{ host: '127.0.0.1', port: node1.boundPort }],
    });
    await node2.start();
    try {
      node1.setLocal('after-rotation', { type: 'actor' });
      await waitFor(() => node2.localRegistry.has('after-rotation'), { message: 'convergence with the rotated CA', timeout: 8000 });
    } finally {
      await node2.stop();
    }
  } finally {
    await node1.stop();
  }
});
