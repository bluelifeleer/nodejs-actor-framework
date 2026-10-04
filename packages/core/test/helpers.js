'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

/**
 * Point the framework at a throwaway data directory.
 *
 * MUST be called before requiring anything that reads config (config.js caches
 * an env-derived object at require time).
 */
function setupTempEnv(prefix = 'actor-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  process.env.ACTOR_DATA_DIR = dir;
  process.env.ACTOR_LOG_DIR = path.join(dir, 'logs');
  process.env.ACTOR_BOOT_ACTORS = '';
  process.env.ACTOR_LOG_SAMPLE_RATE = '1';
  // Fast defaults so tests do not sit in the batch linger window.
  process.env.ACTOR_BATCH_TIMEOUT_MS = '20';
  process.env.ACTOR_METRICS_FLUSH_MS = '20';
  // Tests exercise the hot-reload path explicitly.
  process.env.ENABLE_HOT_RELOAD = '1';
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 5000, interval = 20, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(interval);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Send newline-terminated commands and resolve with the whole transcript. */
function telnet(port, lines, options = {}) {
  const { host = '127.0.0.1', gapMs = 250, settleMs = 900 } = options;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(buffer));
    socket.on('connect', async () => {
      for (const line of lines) {
        socket.write(`${line}\n`);
        await delay(gapMs);
      }
      await delay(settleMs);
      socket.end();
    });
  });
}

/** Write raw bytes (used to prove line buffering works). */
function telnetRaw(port, payload, { host = '127.0.0.1', settleMs = 900 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = '';
    socket.on('data', (c) => {
      buffer += c.toString();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(buffer));
    socket.on('connect', async () => {
      socket.write(payload);
      await delay(settleMs);
      socket.end();
    });
  });
}

module.exports = {
  setupTempEnv,
  cleanup,
  delay,
  waitFor,
  freePort,
  telnet,
  telnetRaw,
};
