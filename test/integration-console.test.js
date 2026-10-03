'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, telnet, telnetRaw } = require('./helpers');

const tempDir = setupTempEnv('actor-console');

const { bootstrap } = require('../actor-main');
const { TelnetConsole } = require('../telnet-console');

let ctx;

before(async () => {
  ctx = await bootstrap({
    telnet: { enabled: true, port: 0, host: '127.0.0.1', token: '' },
    gateway: { enabled: false },
    gossip: { enabled: false },
    bootActors: ['player_001'],
  });
});

after(async () => {
  await ctx.close();
  cleanup(tempDir);
});

const run = (...lines) => telnet(ctx.ports.console, lines);

test('console: banner and help list the available commands', async () => {
  const out = await run('help');
  assert.match(out, /Actor Framework Console/);
  assert.match(out, /hotreload/);
  assert.match(out, /crash \[actorId\]/);
});

test('console: a valid hurt message reports the new hp and priority', async () => {
  const out = await run('hurt player_001 10 0');
  assert.match(out, /OK hp=90 priority=0\(HIGH\)/);
});

test('console: non-numeric damage is rejected (no NaN state poisoning)', async () => {
  // Regression: `hurt player_001 abc` used to set hp to NaN silently.
  const out = await run('hurt player_001 abc 1');
  assert.match(out, /ERR:damage must be a finite number/);
  const state = await run('getState player_001');
  assert.match(state, /state:\{"hp":90\}/);
});

test('console: an out-of-range priority is rejected (no worker crash)', async () => {
  // Regression: priority 5 used to throw in the mailbox and kill the process.
  const out = await run('hurt player_001 10 5');
  assert.match(out, /ERR:priority must be 0, 1 or 2/);
  assert.match(await run('getState player_001'), /state:\{"hp":90\}/);
});

test('console: malformed actor ids are rejected', async () => {
  assert.match(await run('getState ../etc/passwd'), /ERR:actorId must match/);
  assert.match(await run('spawn bad/id'), /ERR:actorId must match/);
  assert.match(await run('hurt'), /ERR:actorId is required/);
});

test('console: an empty line keeps the session open', async () => {
  // Regression: an empty line used to end the connection.
  const out = await run('', 'actors');
  assert.match(out, /actors:\["player_001"/);
});

test('console: several commands in one TCP packet are all executed', async () => {
  // Regression: each chunk was treated as exactly one command.
  const out = await telnetRaw(ctx.ports.console, 'actors\nsup info\nregistry list\n');
  assert.match(out, /actors:/);
  assert.match(out, /sup:\{/);
  assert.match(out, /registry:\{/);
});

test('console: unknown commands are reported, not fatal', async () => {
  assert.match(await run('frobnicate'), /unknown command: frobnicate/);
});

test('console: introspection commands work', async () => {
  assert.match(await run('sup info'), /"strategy":"one_for_one"/);
  assert.match(await run('registry list'), /player_001/);
  assert.match(await run('dlq size'), /DLQ size:\d+/);
  assert.match(await run('metrics dump'), /metrics:\{/);
  assert.match(await run('actors'), /actors:\[/);
  assert.match(await run('gossip info'), /gossip:\{"enabled":false\}/);
});

test('console: spawn, crash and kill behave as documented', async () => {
  assert.match(await run('spawn temp_actor'), /spawn temp_actor ok/);
  assert.match(await run('actors'), /temp_actor/);
  assert.match(await run('crash temp_actor'), /supervisor will restart/);
  assert.match(await run('kill temp_actor'), /will NOT be restarted/);
  assert.match(await run('drop temp_actor'), /drop temp_actor ok/);
});

test('console: metrics reported to the console are real, not {}', async () => {
  const state = await run('metrics dump');
  const json = state.slice(state.indexOf('metrics:') + 'metrics:'.length).trim().split('\n')[0];
  const snapshot = JSON.parse(json);
  assert.ok(snapshot.player_001, 'the actor has metrics');
  assert.ok(snapshot.player_001.received >= 1);
  assert.ok(snapshot.player_001.handled >= 1);
});

test('console: the quoted hot reload form from the README works', async () => {
  const code = '"async (msg) => { if (msg.type === \'hurt\') { this.state.hp -= 1; return this.state.hp; } return this.state; }"';
  const out = await run(`hotreload player_001 ${code}`);
  assert.match(out, /hot reload player_001: \{"installed":true/);
  assert.match(await run('hurt player_001 1 1'), /OK hp=89/);
  assert.match(await run('getState player_001'), /state:\{"hp":89\}/);
});

test('console: a broken hot reload is reported and the actor survives', async () => {
  const out = await run('hotreload player_001 "not a function"');
  assert.match(out, /ERR:hot reload failed/);
  assert.match(await run('getState player_001'), /state:\{"hp":89\}/);
  assert.match(await run('actors'), /player_001/);
});

test('console: pub/sub commands work end to end', async () => {
  assert.match(await run('pub sub game/notice player_001'), /subscribe game\/notice -> player_001/);
  assert.match(await run('pub topics'), /topics:\["game\/notice"\]/);
  const published = await run('pub pub game/notice {"msg":"server open"}');
  assert.match(published, /publish result:\[\{"actorId":"player_001","ok":true/);
  assert.match(await run('pub unsub game/notice player_001'), /unsub game\/notice/);
});

test('console: invalid JSON payloads are rejected', async () => {
  assert.match(await run('pub pub topic {not json}'), /ERR:payload must be valid JSON/);
});

test('console: gateway commands degrade gracefully when disabled', async () => {
  assert.match(await run('gateway ping 127.0.0.1 1'), /ERR:gateway disabled/);
});

test('console: a non-loopback bind without a token is refused', async () => {
  const guard = new TelnetConsole({ host: '0.0.0.0', token: '', context: {} });
  assert.throws(() => guard.assertSafeBinding(), /refusing to expose the console/);

  // And bootstrap degrades to "no console" instead of exposing it.
  const unsafe = await bootstrap({
    telnet: { enabled: true, port: 0, host: '0.0.0.0', token: '' },
    gateway: { enabled: false },
    gossip: { enabled: false },
    bootActors: [],
    registry: new (require('../registry').Registry)(),
  });
  try {
    assert.strictEqual(unsafe.console, null);
    assert.ok(unsafe.warnings.some((w) => /console could not listen/.test(w)));
  } finally {
    await unsafe.close();
  }
});

test('console: token authentication gates every command', async () => {
  const node = await bootstrap({
    telnet: { enabled: true, port: 0, host: '127.0.0.1', token: 's3cret' },
    gateway: { enabled: false },
    gossip: { enabled: false },
    bootActors: ['auth_actor'],
    registry: new (require('../registry').Registry)(),
  });
  try {
    assert.match(await telnet(node.ports.console, ['actors']), /authentication required/);
    assert.match(await telnet(node.ports.console, ['auth nope', 'actors']), /authentication required/);
    const ok = await telnet(node.ports.console, ['auth s3cret', 'actors']);
    assert.match(ok, /authenticated/);
    assert.match(ok, /actors:\["auth_actor"\]/);
  } finally {
    await node.close();
  }
});
