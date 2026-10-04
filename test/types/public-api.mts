/**
 * Compile-only test: `npm run typecheck` must pass.
 * It exercises the documented public API, not the implementation.
 */
import {
  Actor,
  cluster,
  pubsub,
  metrics,
  tracing,
  deadLetters,
  rateLimit,
  ActorSystem,
  createSystem,
  defineActor,
  RestartStrategy,
  Overflow,
  MemoryPersistence,
  FilePersistence,
  AskTimeoutError,
  MailboxFullError,
} from 'nodejs-actor-framework';
import type {
  ActorRef, ActorContext, RemoteRef, Peer, ActorInspection, Plugin, DiscoveredRef, PubSubService,
} from 'nodejs-actor-framework';

type Msg = { type: 'hurt'; damage: number } | { type: 'state' };
type PlayerState = { hp: number };

class Player extends Actor<Msg, number, PlayerState> {
  override preStart(ctx: ActorContext<PlayerState>): void {
    void ctx;
    this.state = { hp: 100 };
  }

  override async receive(msg: Msg, ctx: ActorContext<PlayerState>): Promise<number> {
    if (msg.type === 'hurt') this.state.hp -= msg.damage;
    ctx.log('handled', { hp: this.state.hp });
    return this.state.hp;
  }

  override postStop(): void {}
}

export async function main(): Promise<void> {
  const system: ActorSystem = createSystem({
    name: 'example',
    persistenceDir: '.data',
    defaults: { supervision: { strategy: RestartStrategy.ONE_FOR_ONE, maxRestarts: 3 } },
  });

  const player: ActorRef<Msg, number> = await system.spawn(Player, { id: 'player_001' });
  const accepted: boolean = player.tell({ type: 'hurt', damage: 5 });
  const hp: number = await player.ask({ type: 'hurt', damage: 5 });
  const inspection: ActorInspection = player.inspect();
  const depth: number = inspection.mailbox.size;
  const restored: boolean = inspection.persistence.restored;
  const snapshot: unknown = await player.state();
  void accepted; void hp; void depth; void restored; void snapshot;

  // Handler-bag form.
  const bag = await system.spawn({ state: { n: 0 }, onMessage: (msg: string) => msg.length }, { id: 'bag' });
  const length: number = await bag.ask('abc');
  void length;

  // Worker isolation takes a module path and is a different isolation mode.
  const isolated = await system.spawn('./actors/encoder.js', { id: 'encoder', isolation: 'worker' });
  void isolated;

  // Persistence adapters are pluggable.
  const adapter = new MemoryPersistence();
  await adapter.saveSnapshot('player_001', { hp: 1 });
  const fromDisk = new FilePersistence({ baseDir: '.actors' });
  await fromDisk.appendEvent('player_001', { delta: 1 });

  // Clustering: serve, connect, and use a remote ref like a local one.
  const port: number = await system.listen({ host: '127.0.0.1', port: 0 });
  const peer: Peer = await system.connect({ host: '127.0.0.1', port });
  const remote: RemoteRef<Msg, number> = peer.ref<Msg, number>('player_001');
  const remoteHp: number = await remote.ask({ type: 'hurt', damage: 1 });
  const bySpec: RemoteRef<Msg, number> = system.remote<Msg, number>('player_001@127.0.0.1:9000');
  void remoteHp; void bySpec;
  const peers = system.listPeers();
  void peers;

  const defined = defineActor(Player);
  void defined.kind;

  try {
    await player.ask({ type: 'state' }, 10);
  } catch (err) {
    if (err instanceof AskTimeoutError) void 0;
    if (err instanceof MailboxFullError) void 0;
  }

  const overflow = Overflow.DROP_OLDEST;
  void overflow;
  const actors: number = system.stats().actors;
  void actors;

  await system.stop();
}

// Plugin surface: compile-time check of the documented factories.
export async function plugins(): Promise<void> {
  const system: ActorSystem = createSystem({
    plugins: [
      cluster({ seeds: ['10.0.0.1:7200'], intervalMs: 100 }),
      pubsub(),
      metrics({ exporter: { enabled: true, port: 9464 } }),
      tracing({ sampleRate: 0.5 }),
      deadLetters(),
      rateLimit({ capacity: 10, rate: 5 }),
    ],
  });
  const onlyTeardown: Plugin = { name: 'x', teardown: () => {} };
  void onlyTeardown;

  await system.init();
  const discovered: DiscoveredRef<{ type: string }, number> | null =
    system.cluster ? system.cluster.resolveRemote<{ type: string }, number>('player_001') : null;
  if (discovered) await discovered.ask({ type: 'hurt' }, 1000);

  const bus: PubSubService | null = system.pubsub;
  if (bus) {
    bus.subscribe('news', 'player_001');
    await bus.publish('news', { text: 'hi' });
  }
  await system.readDeadLetters();
  await system.clearDeadLetters();
  await system.stop();
}
