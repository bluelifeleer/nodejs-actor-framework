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

const { Actor, defineActor, ActorDefinition } = require('./actor/actor');
const { ActorRef, DeadLetterRef } = require('./actor/actor-ref');
const { ActorSystem, createSystem } = require('./actor/system');
const { RemoteRef, Peer } = require('./cluster/remote');
const { MemoryPersistence, FilePersistence } = require('./store/persistence');
const Mailbox = require('./actor/mailbox');
const ChildSupervisor = require('./actor/guardian');
const errors = require('./actor/errors');
const RestartStrategy = require('./actor/restart-strategy');
const plugins = require('./plugins');

module.exports = {
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
