import http from 'node:http';
import { Actor, createSystem, plugins } from 'nodejs-actor-framework';

/**
 * Example: a two-node cluster using the plugin surface.
 *
 *   node examples/cluster-two-nodes.js
 *
 * Shows what the plugins buy you over wiring transports by hand:
 *   - `cluster` : an actor is reached by NAME, no host:port at the call site
 *   - `pubsub`  : a subscription on one node receives a broadcast from another
 *   - `tracing` : one trace spans the cross-node call chain
 *   - `metrics` : actor counters on the Prometheus endpoint
 *   - worker isolation still works, because isolation is a per-actor choice
 *
 * Both systems live in one process so the example is self-contained; in
 * production each would be its own process and `seeds` would point at the
 * other machine.
 */




class Counter extends Actor {
  preStart() {
    this.state = { count: 0, traces: new Set() };
  }

  async receive(msg, ctx) {
    if (msg.type === 'inc') {
      this.state.count += msg.by || 1;
      if (ctx.trace) this.state.traces.add(ctx.trace.traceId);
      return this.state.count;
    }
    // Pub/sub payloads arrive as-is plus a `topic` field; they carry no `type`.
    if (msg.topic) {
      console.log(`  [node-a] notice received: ${JSON.stringify(msg.text)} (topic=${msg.topic})`);
      return 'noted';
    }
    if (msg.type === 'value') return this.state.count;
    if (msg.type === 'traces') return [...this.state.traces].length;
    throw new Error(`counter: unknown message "${msg.type}"`);
  }
}

function scrape(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function main() {
  const common = { host: '127.0.0.1', advertiseHost: '127.0.0.1', intervalMs: 100, port: 0 };

  // --- node A: owns the actor, serves metrics ------------------------------
  const nodeA = createSystem({
    name: 'node-a',
    logger: false,
    plugins: [
      plugins.cluster(common),
      plugins.pubsub(),
      plugins.tracing(),
      plugins.metrics({ intervalMs: 200, exporter: { enabled: true, host: '127.0.0.1', port: 0 } }),
    ],
  });
  await nodeA.init();
  const gossipPort = nodeA.cluster.port;
  await nodeA.listen({ host: '127.0.0.1', port: 0 });
  await nodeA.spawn(Counter, { id: 'counter' });
  nodeA.pubsub.subscribe('game/notice', 'counter');
  console.log(`node-a: gossip ${gossipPort}, gateway ${nodeA.port}, metrics ${nodeA.metricsExporter.boundPort}`);

  // --- node B: discovers node A through gossip -----------------------------
  const nodeB = createSystem({
    name: 'node-b',
    logger: false,
    plugins: [
      plugins.cluster({ ...common, seeds: [{ host: '127.0.0.1', port: gossipPort }] }),
      plugins.pubsub(),
      plugins.tracing(),
    ],
  });
  await nodeB.init();
  await nodeB.listen({ host: '127.0.0.1', port: 0 });
  console.log(`node-b: gateway ${nodeB.port}, talking to node-a`);

  // No host:port anywhere: the cluster plugin made "counter" resolvable.
  await nodeB.cluster.waitFor('counter');
  const counter = nodeB.resolve('counter');
  console.log('resolve by name ->', counter.toString());
  console.log('remote ask      ->', await counter.ask({ type: 'inc', by: 5 }, 3000));
  counter.tell({ type: 'inc', by: 2 });

  // From inside an actor, by name, with the trace chain intact.
  const relayer = await nodeB.spawn(
    async (msg, ctx) => ctx.ask('counter', { type: 'inc', by: msg.by }, 3000),
    { id: 'relayer' },
  );
  console.log('ctx.ask by name ->', await relayer.ask({ by: 3 }, 4000));

  // A broadcast from node B reaches the subscriber on node A.
  const published = await nodeB.pubsub.publish('game/notice', { text: 'server open' });
  console.log('publish         ->', JSON.stringify(published));

  // Worker isolation is orthogonal: a per-actor option on either node.
  const encoder = await nodeB.spawn('./examples/actors/encoder.js', { id: 'encoder', isolation: 'worker' });
  console.log('encoded         ->', await encoder.ask({ type: 'encode', text: 'actor' }));

  await new Promise((resolve) => setTimeout(resolve, 150));

  const body = await scrape(nodeA.metricsExporter.boundPort, '/metrics');
  const interesting = body
    .split('\n')
    .filter((line) => /^(actor_cluster_actors|actor_cluster_remote_actors|actor_cluster_peers|actor_isolated_actors|actor_messages_handled_total)/.test(line));
  console.log('node-a /metrics ->');
  for (const line of interesting) console.log(`   ${line}`);

  console.log('distinct traces on the cross-node chain ->', await counter.ask({ type: 'traces' }));

  await nodeB.stop();
  await nodeA.stop();
  console.log('both nodes stopped');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
