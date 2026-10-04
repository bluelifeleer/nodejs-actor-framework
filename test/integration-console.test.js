import { test, before, after } from 'node:test';
import assert from 'node:assert';
import _helpers from '../packages/core/test/helpers.js';
const { setupTempEnv, cleanup, telnet, telnetRaw } = _helpers;
import _actor_main from '../actor-main.js';
const { bootstrap } = _actor_main;
import _telnet_console from '../packages/core/src/ops/telnet-console.js';
const { TelnetConsole } = _telnet_console;

/**
 * Console-level integration against the framework node.
 *
 * The console only speaks the framework's public API, so these tests double as
 * a check that the public surface is usable from outside (`resolve`, `tell`,
 * `ask`, `state`, `stats`, `readDeadLetters`, pubsub, cluster).
 */





const tempDir = setupTempEnv('actor-console');




let ctx;
let bareCtx;
let authCtx;
let peerCtx;

before(async () => {
  // Only the main node needs the metrics exporter: the other three exist to test
  // degradation and auth, and four exporters + gossip nodes make the suite slow
  // enough to be flaky under load.
  const light = {
    telnet: { enabled: true, port: 0, host: '127.0.0.1', token: null },
    metrics: { exporter: { enabled: false } },
    bootActors: [],
  };

  ctx = await bootstrap({
    telnet: { enabled: true, port: 0, host: '127.0.0.1', token: null },
    metrics: { exporter: { enabled: true, host: '127.0.0.1', port: 0 } },
    bootActors: ['player_001'],
    nodeId: 'console-node',
    gateway: { enabled: true, host: '127.0.0.1', port: 0 },
    gossip: { enabled: true, host: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, intervalMs: 100 },
  });

  bareCtx = await bootstrap({
    ...light,
    nodeId: 'console-bare',
    gateway: { enabled: false },
    gossip: { enabled: false },
    bootActors: [],
  });

  authCtx = await bootstrap({
    ...light,
    nodeId: 'console-auth',
    telnet: { enabled: true, port: 0, host: '127.0.0.1', token: 's3cr3t-token' },
    gateway: { enabled: false },
    gossip: { enabled: false },
  });

  // A second gossip node, seeded to the first, to drive discovery via the console.
  peerCtx = await bootstrap({
    ...light,
    nodeId: 'console-peer',
    gateway: { enabled: true, host: '127.0.0.1', port: 0 },
    gossip: {
      enabled: true,
      host: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      port: 0,
      intervalMs: 100,
      seeds: [{ host: '127.0.0.1', port: ctx.ports.gossip }],
    },
  });
});

after(async () => {
  for (const node of [peerCtx, authCtx, bareCtx, ctx]) if (node) await node.close();
  cleanup(tempDir);
});

const run = (...lines) => telnet(ctx.ports.console, lines);
const runBare = (...lines) => telnet(bareCtx.ports.console, lines);

test('console: banner and help list the framework commands', async () => {
  const out = await run('help');
  assert.match(out, /Actor Framework Console \(framework model\)/);
  assert.match(out, /actors \| inspect \[path\] \| state \[path\] \| system/);
  assert.match(out, /tell \[path\] json \| ask \[path\] json/);
  assert.match(out, /cluster info/);
  assert.doesNotMatch(out, /hotreload/, 'the eval-based command is gone');
});

test('console: hurt reports the new hp', async () => {
  const out = await run('hurt player_001 10');
  assert.match(out, /OK hp=90/);
});

test('console: non-numeric damage is rejected (no NaN state poisoning)', async () => {
  const out = await run('hurt player_001 abc');
  assert.match(out, /ERR:damage must be a finite number/);
  assert.match(await run('getState player_001'), /"hp":90/);
});

test('console: the removed priority argument is explained, not ignored', async () => {
  const out = await run('hurt player_001 10 0');
  assert.match(out, /ERR:priority was removed/);
  assert.match(out, /single FIFO per actor/);
  assert.match(await run('getState player_001'), /"hp":90/, 'state untouched');
});

test('console: malformed actor paths are rejected', async () => {
  assert.match(await run('getState ../etc/passwd'), /ERR:actor path must match/);
  assert.match(await run('actors'), /actors:\[/, 'the session survives a rejected path');
  assert.match(await run('spawn bad\\path'), /ERR:actor path must match/);
  assert.match(await run('hurt'), /ERR:actor path is required/);
});

test('console: an empty line keeps the session open', async () => {
  const out = await run('', 'actors');
  assert.match(out, /actors:\["player_001"\]/, 'the session survived the empty line');
});

test('console: several commands in one TCP packet are all executed', async () => {
  const out = await telnetRaw(ctx.ports.console, 'actors\nsystem\nhelp\n');
  assert.match(out, /actors:\["player_001"\]/);
  assert.match(out, /system:\{/);
  assert.match(out, /Actor Framework Console/);
});

test('console: unknown commands are reported, not fatal', async () => {
  const out = await run('nope', 'actors');
  assert.match(out, /unknown command: nope/);
  assert.match(out, /actors:\["player_001"\]/);
});

test('console: introspection commands work', async () => {
  const actors = await run('actors');
  assert.match(actors, /actors:\["player_001"\]/);

  const inspect = await run('inspect player_001');
  assert.match(inspect, /inspect:\{/);
  assert.match(inspect, /"isolation":"inline"/);
  assert.match(inspect, /"counters":\{/);

  const state = await run('state player_001');
  assert.match(state, /state:\{"hp":90/);

  const system = await run('system');
  assert.match(system, /system:\{/);
  assert.match(system, /"name":"console-node"/);
  assert.match(system, /"plugins":/);

  const sup = await run('sup info');
  assert.match(sup, /sup:\{"root":/);
  assert.match(sup, /"path":"player_001"/);
});

test('console: tell and ask take JSON; malformed JSON is rejected', async () => {
  assert.match(await run('tell player_001 {"type":"debug:getState"}'), /accepted/);
  const reply = await run('ask player_001 {"type":"hurt","damage":1}');
  assert.match(reply, /reply:89/);

  const bad = await run('ask player_001 {not json}');
  assert.match(bad, /ERR:payload must be valid JSON/);
  const missing = await run('tell player_001');
  assert.match(missing, /ERR:payload must be JSON/);
});

test('console: spawn, crash and kill behave as documented', async () => {
  assert.match(await run('spawn arena/bob'), /spawn arena\/bob ok \(isolation=inline\)/);
  assert.match(await run('actors'), /arena\/bob/);
  assert.match(await run('spawn arena/bob'), /ERR:actor arena\/bob already exists/);

  // A module path spawn with worker isolation.
  assert.match(
    await run('spawn encoder ./examples/actors/encoder.js worker'),
    /spawn encoder ok \(isolation=worker\)/,
  );
  assert.match(await run('state encoder'), /"jobs":0/);

  const crash = await run('crash arena/bob');
  assert.match(crash, /crash arena\/bob -> crash requested via console for arena\/bob/);
  assert.match(crash, /the supervisor will restart it/);

  assert.match(await run('kill arena/bob'), /kill arena\/bob ok/);
  assert.match(await run('getState arena/bob'), /ERR:actor arena\/bob not found/);

  // The isolated actor was restarted after its crash and is still usable.
  assert.match(await run('ask encoder {"type":"encode","text":"hi"}'), /reply:"aGk="/);
  await run('kill encoder');
});

test('console: metrics dump reports real counters', async () => {
  await ctx.system.ref('player_001').ask({ type: 'hurt', damage: 1 });
  const out = await run('metrics dump');
  assert.match(out, /metrics:\{/);
  assert.match(out, /"player_001":\{/);
  assert.match(out, /"received":\d+/);
  assert.doesNotMatch(out, /metrics:\{\}/);
});

test('console: pub/sub commands work end to end', async () => {
  assert.match(await run('pub sub news player_001'), /subscribe news -> player_001/);
  assert.match(await run('pub topics'), /topics:\["news"\]/);
  assert.match(await run('pub subs news'), /subscribers:\["player_001"\]/);

  const published = await run('pub pub news {"text":"hello"}');
  assert.match(published, /publish result:\[\{"path":"player_001","ok":true\}\]/);

  assert.match(await run('pub unsub news player_001'), /unsub news -> player_001/);
  assert.match(await run('pub topics'), /topics:\[\]/);
});

test('console: dlq commands report and clear dead letters', async () => {
  const flaky = await ctx.system.spawn(async () => {
    throw new Error('console dlq failure');
  }, { id: 'console-flaky', failure: 'retry', maxRetry: 0 });
  await assert.rejects(() => flaky.ask('x'), /console dlq failure/);

  assert.match(await run('dlq size'), /DLQ size:1/);
  assert.match(await run('dlq list'), /console-flaky/);
  assert.match(await run('dlq clear'), /DLQ cleared/);
  assert.match(await run('dlq size'), /DLQ size:0/);
  await flaky.stop();
});

test('console: cluster info reports this node and its peers', async () => {
  const info = await run('cluster info');
  assert.match(info, /cluster:\{/);
  assert.match(info, /"nodeId":"console-node"/);
  assert.match(info, /"remoteActors":/);
  assert.match(info, /"peers":\[/);
});

test('console: an actor on another node is reachable by name through the console', async () => {
  const peerRun = (...lines) => telnet(peerCtx.ports.console, lines);

  const discovered = await peerRun('cluster wait player_001');
  assert.match(discovered, /discovered:\{/);
  assert.match(discovered, /"nodeId":"console-node"/);

  const lookup = await peerRun('cluster lookup player_001');
  assert.match(lookup, /lookup:\{.*"host":"127\.0\.0\.1","gatewayPort":\d+/);

  const reply = await peerRun('ask player_001 {"type":"hurt","damage":2}');
  assert.match(reply, /reply:\d+/, 'the remote ask returned the hp from the other node');
});

test('console: disabled subsystems degrade with a clear error', async () => {
  assert.match(await runBare('cluster info'), /ERR:cluster plugin is not installed/);
  const peer = await runBare('peer ping 127.0.0.1 9');
  assert.match(peer, /ERR:/, 'an unreachable peer surfaces as an error');
  assert.match(await runBare('actors'), /actors:\[\]/);
});

test('console: a non-loopback bind without a token is refused', async () => {
  const unsafe = new TelnetConsole({
    host: '0.0.0.0',
    port: 0,
    token: null,
    context: { system: ctx.system },
  });
  await assert.rejects(() => unsafe.listen(), /refusing to expose the console/);

  const safe = new TelnetConsole({
    host: '0.0.0.0',
    port: 0,
    token: 'a-token',
    context: { system: ctx.system },
  });
  try {
    assert.ok(await safe.listen() > 0, 'a token makes a non-loopback bind acceptable');
  } finally {
    await safe.close();
  }
});

test('console: token authentication gates every command', async () => {
  const denied = await telnet(authCtx.ports.console, ['actors']);
  assert.match(denied, /ERR: authentication required/);
  assert.doesNotMatch(denied, /actors:\[/);

  const wrongToken = await telnet(authCtx.ports.console, ['auth nope', 'actors']);
  assert.match(wrongToken, /ERR: authentication required/);

  const allowed = await telnet(authCtx.ports.console, ['auth s3cr3t-token', 'actors']);
  assert.match(allowed, /authenticated/);
  assert.match(allowed, /actors:\[\]/);
});
