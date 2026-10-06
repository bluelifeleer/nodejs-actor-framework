// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Public API of the actor framework.
 *
 *   const { createSystem, Actor } = require('nodejs-actor-framework');
 *
 *   class Player extends Actor {
 *     preStart() { this.state = { hp: 100 }; }
 *     async receive(msg) {
 *       if (msg.type === 'hurt') { this.state.hp -= msg.damage; return this.state.hp; }
 *       throw new Error(`unknown message ${msg.type}`);
 *     }
 *   }
 *
 *   const system = createSystem();
 *   const player = await system.spawn(Player, { id: 'player_001' });
 *   player.tell({ type: 'hurt', damage: 5 });                  // fire and forget
 *   const hp = await player.ask({ type: 'hurt', damage: 5 });  // request/response
 *   await system.stop();
 *
 * This module is the framework surface; anything under lib/ is internal and
 * may change between minor versions.
 */

const { Actor, defineActor, ActorDefinition } = require('./actor/actor.ts');
const { ActorRef, DeadLetterRef } = require('./actor/actor-ref.ts');
const { ActorSystem, createSystem } = require('./actor/system.ts');
const { RemoteRef, Peer } = require('./cluster/remote.ts');
const ring = require('./cluster/ring.ts');
const clock = require('./obs/clock.ts');
const { createLogAdapter } = require('./obs/log-adapter.ts');
const ownership = require('./cluster/ownership.ts');
const { MemoryPersistence, FilePersistence } = require('./store/persistence.ts');
const Mailbox = require('./actor/mailbox.ts');
const ChildSupervisor = require('./actor/guardian.ts');
const errors = require('./actor/errors.ts');
const RestartStrategy = require('./actor/restart-strategy.ts');
const plugins = require('./plugins/index.ts');

module.exports = {
  // 可注入时钟（虚拟时钟在 @actor/testkit）
  createRealClock: clock.createRealClock,
  // 日志适配：把 pino/winston/console 这类对象日志器接到内核的 (event, meta) 函数接口
  createLogAdapter,
  // 集群治理：一致性哈希环（纯函数；所有权 = ownerOfShard(ring, shard)）
  ring,
  // 集群治理：所有权守卫 + fencing token（createOwnershipGuard）
  ownership,
  // programming model
  Actor,
  defineActor,
  ActorDefinition,
  createSystem,
  ActorSystem,
  ActorRef,
  DeadLetterRef,
  // location transparency (peer nodes)
  RemoteRef,
  Peer,

  // configuration enums / helpers
  RestartStrategy,
  Overflow: Mailbox.OVERFLOW,

  // optional capabilities, attached via createSystem({ plugins: [...] })
  plugins,
  cluster: plugins.cluster,
  pubsub: plugins.pubsub,
  metrics: plugins.metrics,
  tracing: plugins.tracing,
  deadLetters: plugins.deadLetters,
  rateLimit: plugins.rateLimit,

  // persistence adapters
  MemoryPersistence,
  FilePersistence,

  // advanced / introspection
  ChildSupervisor,
  Mailbox,

  // error types
  // Errors are listed explicitly instead of `...errors`: a spread inside the
  // export object makes cjs-module-lexer give up, and then ESM consumers cannot
  // do `import { ActorStoppedError } from 'nodejs-actor-framework'`.
  ActorFrameworkError: errors.ActorFrameworkError,
  DefinitionError: errors.DefinitionError,
  MailboxFullError: errors.MailboxFullError,
  AskTimeoutError: errors.AskTimeoutError,
  ActorStoppedError: errors.ActorStoppedError,
  ActorNotFoundError: errors.ActorNotFoundError,
  PersistenceError: errors.PersistenceError,
  EscalationError: errors.EscalationError,
};
