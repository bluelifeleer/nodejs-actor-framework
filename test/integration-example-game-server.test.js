'use strict';

/**
 * The runnable game-server example is part of the documentation, so it gets
 * tested like code: real child processes, real TCP clients, real restart.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { setupTempEnv, cleanup, waitFor, delay } = require('../packages/core/test/helpers');

const tempDir = setupTempEnv('actor-game-example');
const SERVER = path.join(__dirname, '..', 'examples', 'game-server.js');

test.after(() => cleanup(tempDir));

/** Start the example server and wait until it prints its bound port. */
async function startServer(dataDir) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      METRICS_PORT: '0',
      TICK_MS: '50',
      SAVE_EVERY_TICKS: '2',
      NODE_ID: `example-${path.basename(dataDir)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (c) => {
    output += c.toString();
  });
  proc.stderr.on('data', (c) => {
    output += c.toString();
  });

  const port = await waitFor(() => {
    const match = /PORT=(\d+)/.exec(output);
    return match ? Number(match[1]) : false;
  }, { message: 'the example server to print its port', timeout: 20000 }).catch((err) => {
    proc.kill('SIGKILL');
    throw new Error(`${err.message}\n--- server output ---\n${output}`);
  });

  return {
    proc,
    port,
    output: () => output,
    async stop(signal = 'SIGTERM') {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill(signal);
      await exited;
      return output;
    },
  };
}

/** One TCP connection, one JSON reply per command. */
async function client(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  let buffer = '';
  const queue = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(parsed);
      else queue.push(parsed);
    }
  });

  const next = (timeoutMs = 8000) => new Promise((resolve, reject) => {
    if (queue.length > 0) return resolve(queue.shift());
    const timer = setTimeout(() => reject(new Error('no reply from the game server')), timeoutMs);
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });

  return {
    async send(line) {
      socket.write(`${line}\n`);
      return next();
    },
    /** Fire and forget, then drain the same number of replies. */
    async flood(line, times) {
      for (let i = 0; i < times; i += 1) socket.write(`${line}\n`);
      const replies = [];
      for (let i = 0; i < times; i += 1) replies.push(await next());
      return replies;
    },
    close: () => socket.end(),
  };
}

test('example game server: a client can join, hit, move and query a player', async () => {
  const server = await startServer(path.join(tempDir, 'run-1'));
  const c = await client(server.port);
  try {
    const joined = await c.send('join {"playerId":"alice"}');
    assert.strictEqual(joined.ok, true);
    assert.deepStrictEqual(joined.result.roster, ['alice']);

    const moved = await c.send('move {"playerId":"alice","x":3,"y":4}');
    assert.deepStrictEqual(moved.result, { x: 3, y: 4 });

    const hit = await c.send('hit {"playerId":"alice","damage":10}');
    assert.strictEqual(hit.result.hp, 90);
    assert.strictEqual(hit.result.score, 10);

    const stats = await c.send('stats {"playerId":"alice"}');
    assert.strictEqual(stats.result.hp, 90);
    assert.strictEqual(stats.result.x, 3);

    // Respawn on death: hp resets and the death is counted.
    const dead = await c.send('hit {"playerId":"alice","damage":200}');
    assert.strictEqual(dead.result.respawned, true);
    assert.strictEqual(dead.result.deaths, 1);
    assert.strictEqual(dead.result.hp, 100);

    // Unknown command and malformed JSON come back as errors, not crashes.
    assert.strictEqual((await c.send('nope {}')).ok, false);
    assert.match((await c.send('hit {broken')).error, /合法 JSON/);

    // Flooding one connection still processes every message in order.
    const replies = await c.flood('hit {"playerId":"alice","damage":1}', 12);
    assert.strictEqual(replies.length, 12);
    const hps = replies.map((r) => r.result.hp);
    assert.deepStrictEqual(hps, [...hps].sort((a, b) => b - a), 'throttling must not reorder messages');
  } finally {
    c.close();
    await server.stop();
  }
});

test('example game server: the leaderboard ranks players in a worker thread', async () => {
  const server = await startServer(path.join(tempDir, 'run-2'));
  const c = await client(server.port);
  try {
    await c.send('join {"playerId":"alice"}');
    await c.send('join {"playerId":"bob"}');
    await c.send('hit {"playerId":"alice","damage":30}');
    await c.send('hit {"playerId":"bob","damage":10}');

    const top = await c.send('top {"n":2}');
    assert.deepStrictEqual(top.result.map((entry) => entry.playerId), ['alice', 'bob']);
    assert.deepStrictEqual(top.result.map((entry) => entry.rank), [1, 2]);

    const room = await c.send('room {}');
    assert.deepStrictEqual(room.result.roster.sort(), ['alice', 'bob']);
    assert.deepStrictEqual(room.result.children.sort(), ['alice', 'bob']);
  } finally {
    c.close();
    await server.stop();
  }
});

test('example game server: player state survives a full process restart', async () => {
  const dataDir = path.join(tempDir, 'persistent');

  const first = await startServer(dataDir);
  const c1 = await client(first.port);
  await c1.send('join {"playerId":"alice"}');
  const hit = await c1.send('hit {"playerId":"alice","damage":30}');
  assert.strictEqual(hit.result.hp, 70);
  c1.close();
  const firstLog = await first.stop();
  assert.match(firstLog, /已安全退出/);

  // Same data dir, brand new process: roster and player state come back.
  const second = await startServer(dataDir);
  const c2 = await client(second.port);
  try {
    await waitFor(() => /已恢复房间名册并重建玩家 Actor：alice/.test(second.output()), {
      message: 'the room to restore its roster',
      timeout: 10000,
    });

    // No re-join needed: stats must show the persisted values.
    const stats = await c2.send('stats {"playerId":"alice"}');
    assert.strictEqual(stats.result.hp, 70, 'persisted hp');
    assert.strictEqual(stats.result.score, 30, 'persisted score');

    const again = await c2.send('hit {"playerId":"alice","damage":5}');
    assert.strictEqual(again.result.hp, 65, 'the restored actor keeps playing');
  } finally {
    c2.close();
    await second.stop();
  }
});

test('example game server: SIGTERM shuts down gracefully and snapshots the roster', async () => {
  const dataDir = path.join(tempDir, 'graceful');
  const server = await startServer(dataDir);
  const c = await client(server.port);
  await c.send('join {"playerId":"bob"}');
  c.close();

  const log = await server.stop('SIGTERM');
  assert.match(log, /正在退出/);
  assert.match(log, /已安全退出/);

  await delay(20);
  const fs = require('fs');
  const snapshots = fs.readdirSync(path.join(dataDir, 'snapshots'));
  assert.ok(snapshots.some((f) => f.includes('room-1')), `roster snapshot written, got ${snapshots.join(',')}`);
  assert.ok(snapshots.some((f) => f.includes('bob')), `player snapshot written, got ${snapshots.join(',')}`);
});
