import { test } from 'node:test';
import assert from 'node:assert';

import { OpsAgent, collectFrameworkSnapshot, opsAgentPlugin, summarizeActors } from '../src/index.ts';

test('ops-agent: reads actor cells and dead letters structurally', () => {
  const system = {
    cells: new Map([
      ['player_1', { path: 'player_1', state: 'running', isolation: 'inline', mailbox: { size: 3 }, counters: { received: 10, handled: 9, failed: 1 } }],
    ]),
    stats: () => ({ deadLettered: 2 }),
  };
  const snapshot = collectFrameworkSnapshot(system);
  assert.strictEqual(snapshot.actors.length, 1);
  assert.strictEqual(snapshot.actors[0]?.mailbox, 3);
  assert.strictEqual(snapshot.actors[0]?.failed, 1);
  assert.strictEqual(snapshot.deadLetters, 2);
  const summary = summarizeActors(snapshot.actors);
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(summary.running, 1);
});

test('ops-agent: plugin starts and stops an agent', async () => {
  const lines: string[] = [];
  const app = {
    kernel: { cells: new Map(), stats: () => ({ deadLettered: 0 }) },
    logSink: (scope: string, event: string) => { lines.push(`${scope}:${event}`); },
  };
  const plugin = opsAgentPlugin({
    id: 'test-agent',
    platformUrl: 'http://127.0.0.1:9',
    token: 'test-token',
    intervalMs: 1000,
    dataDir: process.cwd(),
  });
  await plugin.onReady(app as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await plugin.onStopping();
  assert.ok(Array.isArray(lines));
});

test('ops-agent: public class can be constructed without framework imports', () => {
  const agent = new OpsAgent({ id: 'x', platformUrl: 'http://127.0.0.1:9', token: 't' });
  agent.log({ ts: Date.now(), level: 'error', event: 'boom' });
  agent.stop();
  assert.ok(agent instanceof OpsAgent);
});
