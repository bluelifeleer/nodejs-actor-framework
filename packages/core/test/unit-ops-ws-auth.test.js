'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-ops-ws');

const { WebSocketServer, connect } = require('../src/ops/ws-server');
const { TokenAuthority, tokenFromRequest } = require('../src/ops/token');

test.after(() => cleanup(tempDir));

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');
const tls = () => ({
  key: require('fs').readFileSync(path.join(FIXTURES, 'node-1.key')),
  cert: require('fs').readFileSync(path.join(FIXTURES, 'node-1.crt')),
});

/** Run a server for one test and always tear it down. */
async function withServer(options, body) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await server.listen();
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// WebSocket framing
// ---------------------------------------------------------------------------

test('ws: a client can connect, echo text and exchange binary frames', async () => {
  await withServer({}, async (server) => {
    server.on('connection', (socket, req) => {
      assert.strictEqual(req.headers.upgrade, 'websocket');
      socket.on('message', (data, isBinary) => {
        socket.send(isBinary ? data : `echo:${data}`, { binary: isBinary });
      });
    });

    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    try {
      client.send('hello');
      const text = await client.nextMessage();
      assert.strictEqual(text.data, 'echo:hello');
      assert.strictEqual(text.isBinary, false);

      const payload = Buffer.from([1, 2, 3, 250]);
      client.send(payload, { binary: true });
      const binary = await client.nextMessage();
      assert.strictEqual(binary.isBinary, true);
      assert.deepStrictEqual(binary.data, payload);
    } finally {
      client.close();
    }
  });
});

test('ws: fragmented messages are reassembled', async () => {
  await withServer({}, async (server) => {
    server.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`got:${data}`));
    });
    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    try {
      // Hand-build a fragmented text message: "he" + "llo" across frames.
      const crypto = require('crypto');
      const frame = (opcode, fin, payload) => {
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
        const header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | masked.length]);
        return Buffer.concat([header, mask, masked]);
      };
      client.socket.write(Buffer.concat([
        frame(0x1, false, Buffer.from('he')),
        frame(0x0, false, Buffer.from('ll')),
        frame(0x0, true, Buffer.from('o')),
      ]));
      const reply = await client.nextMessage();
      assert.strictEqual(reply.data, 'got:hello');
    } finally {
      client.close();
    }
  });
});

test('ws: large messages use the 64-bit length path', async () => {
  await withServer({}, async (server) => {
    server.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`${data.length}`));
    });
    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    try {
      const big = 'x'.repeat(70000); // > 65535, forces the 8-byte length header
      client.send(big);
      const reply = await client.nextMessage();
      assert.strictEqual(reply.data, '70000');
    } finally {
      client.close();
    }
  });
});

test('ws: keepalive works in both directions, and close performs the handshake', async () => {
  await withServer({}, async (server) => {
    const serverSawPing = [];
    server.on('connection', (socket) => {
      socket.on('ping', (payload) => serverSawPing.push(payload.toString()));
      socket.ping(Buffer.from('from-server'));
    });

    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    // A PING from the server is delivered as 'ping' (the PONG reply is automatic).
    assert.strictEqual((await client.nextPing()).toString(), 'from-server');

    // ...and a PING from the client is answered by the server with a PONG.
    client.ping(Buffer.from('from-client'));
    assert.strictEqual((await client.nextPong()).toString(), 'from-client');
    await waitFor(() => serverSawPing.includes('from-client'), { message: 'the server to see the ping' });

    const closed = new Promise((resolve) => client.once('close', (code) => resolve(code)));
    client.close(1000, 'bye');
    assert.strictEqual(await closed, 1000);
  });
});

test('ws: an unmasked client frame is a protocol error (RFC 6455)', async () => {
  await withServer({}, async (server) => {
    const errors = [];
    server.on('connection', (socket) => socket.on('protocolError', (err) => errors.push(err.message)));
    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    // Hand-build an unmasked frame, which a client must never send.
    client.socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await waitFor(() => errors.length > 0, { message: 'the protocol error to be reported' });
    assert.match(errors[0], /must be masked/);
    client.close();
  });
});

test('ws: an oversized frame is closed with 1009 instead of buffering', async () => {
  const closeCodes = [];
  await withServer({ maxPayloadBytes: 1024 }, async (server) => {
    server.on('connection', (socket) => {
      socket.on('close', (code) => closeCodes.push(code));
    });
    const client = await connect(`ws://127.0.0.1:${server.boundPort}`);
    client.send('y'.repeat(5000));
    // The server must refuse the frame rather than buffer 5KB per connection.
    await waitFor(() => closeCodes.length > 0, { message: 'the server to close the connection' });
    assert.strictEqual(closeCodes[0], 1009, 'message too big');
    client.close();
  });
});

test('ws: a wrong path or a non-upgrade request is refused', async () => {
  await withServer({ path: '/game' }, async (server) => {
    await assert.rejects(() => connect(`ws://127.0.0.1:${server.boundPort}/other`), /upgrade refused|404/);

    // Plain HTTP GET gets a 426 telling the caller to upgrade.
    const http = require('http');
    const { status, body } = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.boundPort, path: '/game' }, (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }).on('error', reject);
    });
    assert.strictEqual(status, 426);
    assert.match(body, /Upgrade Required/);
  });
});

// ---------------------------------------------------------------------------
// TLS / WSS
// ---------------------------------------------------------------------------

test('wss: the same protocol over TLS', async () => {
  await withServer({ tls: tls() }, async (server) => {
    assert.strictEqual(server.secure, true);
    server.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`secure:${data}`));
    });
    // Self-signed test certificate: opt out of verification explicitly.
    const client = await connect(`wss://127.0.0.1:${server.boundPort}`, { tls: { rejectUnauthorized: false } });
    try {
      client.send('hi');
      const reply = await client.nextMessage();
      assert.strictEqual(reply.data, 'secure:hi');
    } finally {
      client.close();
    }
  });
});

test('wss: certificate verification is on by default (self-signed is refused)', async () => {
  await withServer({ tls: tls() }, async (server) => {
    await assert.rejects(
      () => connect(`wss://127.0.0.1:${server.boundPort}`),
      /self[- ]signed|unable to verify|DEPTH_ZERO/i,
      'a client must not silently accept an untrusted certificate',
    );
  });
});

test('wss: a plaintext client cannot talk to a TLS endpoint (no accidental downgrade)', async () => {
  await withServer({ tls: tls() }, async (server) => {
    const tlsErrors = [];
    server.on('tlsClientError', (err) => tlsErrors.push(err));
    await assert.rejects(() => connect(`ws://127.0.0.1:${server.boundPort}`), /refused|timed out|socket hang up|ECONNRESET/i);
    await waitFor(() => tlsErrors.length > 0, { message: 'a TLS handshake error to be reported' });
  });
});

// ---------------------------------------------------------------------------
// Token auth on the upgrade path
// ---------------------------------------------------------------------------

test('auth: verifyClient gates the upgrade before any frame is exchanged', async () => {
  const tokens = new TokenAuthority({ secret: 'test-secret-that-is-long-enough' });
  const accepted = tokens.issue({ playerId: 'alice' }).token;
  const rejected = [];

  await withServer({
    verifyClient: (req) => {
      const token = tokenFromRequest(req);
      const verified = token && tokens.verify(token);
      if (!verified) {
        rejected.push(req.url);
        return false;
      }
      req.playerId = verified.playerId;
      return verified;
    },
  }, async (server) => {
    server.on('connection', (socket, req) => socket.send(`hello ${req.auth.playerId}`));

    const ok = await connect(`ws://127.0.0.1:${server.boundPort}/?token=${accepted}`);
    assert.strictEqual((await ok.nextMessage()).data, 'hello alice');
    ok.close();

    await assert.rejects(() => connect(`ws://127.0.0.1:${server.boundPort}/?token=forged`), /401|refused/);
    await assert.rejects(() => connect(`ws://127.0.0.1:${server.boundPort}/`), /401|refused/);
    assert.strictEqual(rejected.length, 2);
  });
});

test('auth: tokens carry claims, expire, and can be revoked', () => {
  const tokens = new TokenAuthority({ secret: 'another-secret-long-enough', ttlMs: 50, clockSkewMs: 0 });
  const { token } = tokens.issue({ playerId: 'bob', claims: { role: 'gm' } });

  const verified = tokens.verify(token);
  assert.strictEqual(verified.playerId, 'bob');
  assert.strictEqual(verified.claims.role, 'gm');
  assert.ok(verified.jti);

  // Revocation is immediate.
  assert.strictEqual(tokens.revoke(token), true);
  assert.strictEqual(tokens.verify(token), null);
});

test('auth: forged, truncated, tampered and non-string tokens are all rejected', () => {
  const secret = 'the-secret-is-long-enough';
  const tokens = new TokenAuthority({ secret, clockSkewMs: 0 });
  const good = tokens.issue({ playerId: 'carol' }).token;

  assert.strictEqual(tokens.verify(good).playerId, 'carol', 'the issuer accepts its own token');

  const other = new TokenAuthority({ secret: 'a-totally-different-secret', clockSkewMs: 0 });
  assert.strictEqual(other.verify(good), null, 'a different secret cannot verify it');

  assert.strictEqual(tokens.verify(`${good}x`), null, 'tampered signature');
  assert.strictEqual(tokens.verify(good.split('.')[0]), null, 'missing signature');
  assert.strictEqual(tokens.verify(''), null);
  assert.strictEqual(tokens.verify(null), null);
  assert.strictEqual(tokens.verify(undefined), null);
  assert.strictEqual(tokens.verify('a'.repeat(5000)), null, 'oversized token');
  assert.strictEqual(tokens.verify(12345), null, 'non-string');
  assert.strictEqual(tokens.verify('no-dot-at-all'), null);

  // Same-length payload change: the signature check must still fail.
  const [body, signature] = good.split('.');
  const flipped = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${signature}`;
  assert.strictEqual(tokens.verify(flipped), null, 'tampered payload');
});

test('auth: expiry is enforced, with a configurable clock skew', async () => {
  const secret = 'expiry-secret-long-enough';
  const strict = new TokenAuthority({ secret, ttlMs: 20, clockSkewMs: 0 });
  const token = strict.issue({ playerId: 'dave' }).token;
  assert.ok(strict.verify(token), 'valid before expiry');
  await delay(40);
  assert.strictEqual(strict.verify(token), null, 'expired with no skew tolerance');

  // With skew the same token is still accepted (clocks are never exact).
  const lenient = new TokenAuthority({ secret, ttlMs: 20, clockSkewMs: 5000 });
  const fresh = lenient.issue({ playerId: 'erin' }).token;
  await delay(40);
  assert.ok(lenient.verify(fresh), 'inside the skew window');

  // A token issued in the future is refused too.
  const future = new TokenAuthority({ secret, clockSkewMs: 0 });
  const futureToken = future.issue({ playerId: 'frank', claims: { iat: Date.now() + 60_000 } });
  assert.strictEqual(future.verify(futureToken.token), null, 'not valid yet');
});

test('auth: a weak or missing secret is refused at construction', () => {
  assert.throws(() => new TokenAuthority({ secret: 'short' }), /at least 16 characters/);
  const previous = process.env.ACTOR_AUTH_SECRET;
  delete process.env.ACTOR_AUTH_SECRET;
  try {
    assert.throws(() => new TokenAuthority(), /at least 16 characters/);
  } finally {
    if (previous !== undefined) process.env.ACTOR_AUTH_SECRET = previous;
  }
});

test('auth: tokenFromRequest understands query, subprotocol and bearer header', () => {
  const withQuery = { url: '/?token=abc.def', headers: {} };
  assert.strictEqual(tokenFromRequest(withQuery), 'abc.def');

  const withProtocol = { url: '/', headers: { 'sec-websocket-protocol': 'bearer.xyz.123' } };
  assert.strictEqual(tokenFromRequest(withProtocol), 'xyz.123');

  const withHeader = { url: '/', headers: { authorization: 'Bearer from-header' } };
  assert.strictEqual(tokenFromRequest(withHeader), 'from-header');

  assert.strictEqual(tokenFromRequest({ url: '/', headers: {} }), null);
  assert.strictEqual(tokenFromRequest(null), null);
});

test('auth: concurrent connections keep their own identity', async () => {
  const tokens = new TokenAuthority({ secret: 'shared-secret-long-enough' });
  await withServer({
    verifyClient: (req) => {
      const verified = tokens.verify(tokenFromRequest(req) || '');
      return verified || false;
    },
  }, async (server) => {
    const seen = new Set();
    server.on('connection', (socket, req) => {
      seen.add(req.auth.playerId);
      socket.send(req.auth.playerId);
    });

    const names = ['alice', 'bob', 'carol'];
    const clients = await Promise.all(names.map((name) => connect(
      `ws://127.0.0.1:${server.boundPort}/?token=${tokens.issue({ playerId: name }).token}`,
    )));
    const replies = await Promise.all(clients.map((c) => c.nextMessage()));
    assert.deepStrictEqual(replies.map((r) => r.data).sort(), [...names].sort());
    assert.deepStrictEqual([...seen].sort(), [...names].sort());
    for (const c of clients) c.close();
  });
});
