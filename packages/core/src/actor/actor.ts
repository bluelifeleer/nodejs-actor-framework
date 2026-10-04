'use strict';

const { DefinitionError } = require('./errors.mts');

/**
 * Base class for user actors.
 *
 * Lifecycle (see ActorCell for the exact ordering):
 *
 *   new -> preStart(ctx) -> [recover state] -> postRecover(ctx)
 *            -> receive(msg, ctx)* -> postStop(ctx)
 *                   ^                      |
 *                   +---- restart on failure+
 *
 * `preStart` runs *before* recovery, so it is the place to establish initial
 * state (`this.state = { balance: 0 }`); a snapshot or replayed events are
 * applied on top of it, in `postRecover`.
 *
 * `receive` runs one message at a time per actor, so `this.state` never needs
 * a lock. Throwing from `receive` is the idiomatic way to signal failure: the
 * actor crashes and its supervisor decides what happens next.
 */
class Actor {
  constructor() {
    /** @type {any} actor-private state; never shared between actors */
    this.state = {};
    /** @type {string|null} */
    this.id = null;
    /** @type {string|null} full path, e.g. "player_001/pet-1" */
    this.path = null;
  }

  /** Called once before the first message (and again after every restart). */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  preStart(ctx) {}

  /**
   * Called after a snapshot or replayed events were applied. `ctx.restored`
   * tells whether anything was recovered, so this is the place to log or
   * validate a recovery.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  postRecover(ctx) {}

  /** Handle one message. Return a value to answer an `ask()`. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async receive(msg, ctx) {
    throw new DefinitionError('actor does not implement receive(msg, ctx)');
  }

  /** Called on graceful stop, and before a restart. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  postStop(ctx) {}

  /**
   * Called when this actor failed and is about to restart. Runs before
   * postStop(). The message that caused the failure is passed in.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  preRestart(reason, msg, ctx) {}

  /** Apply a persisted event to `this.state` (events persistence). */
  applyEvent(event) {
    if (event && typeof event === 'object') Object.assign(this.state, event);
  }
}

/** Adapts plain handler functions to the Actor interface. */
class HandlerActor extends Actor {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    if (handlers.state !== undefined) {
      this.state = typeof handlers.state === 'function' ? handlers.state() : { ...handlers.state };
    }
  }

  preStart(ctx) {
    if (this.handlers.preStart) return this.handlers.preStart.call(this, ctx);
    return undefined;
  }

  postRecover(ctx) {
    if (this.handlers.postRecover) return this.handlers.postRecover.call(this, ctx);
    return undefined;
  }

  receive(msg, ctx) {
    return this.handlers.receive.call(this, msg, ctx);
  }

  postStop(ctx) {
    if (this.handlers.postStop) return this.handlers.postStop.call(this, ctx);
    return undefined;
  }

  preRestart(reason, msg, ctx) {
    if (this.handlers.preRestart) return this.handlers.preRestart.call(this, reason, msg, ctx);
    return undefined;
  }

  applyEvent(event) {
    if (this.handlers.applyEvent) return this.handlers.applyEvent.call(this, event);
    return super.applyEvent(event);
  }
}

const HANDLER_ALIASES = {
  preStart: ['preStart', 'onStart', 'start'],
  postRecover: ['postRecover', 'onRecover', 'afterRecover'],
  receive: ['receive', 'onMessage', 'onReceive', 'handle'],
  postStop: ['postStop', 'onStop', 'stop'],
  preRestart: ['preRestart', 'onRestart', 'onFailure'],
  applyEvent: ['applyEvent', 'onEvent', 'reduce'],
};

function pickHandlers(source) {
  const handlers = {};
  const unknown = [];
  const known = new Set(Object.values(HANDLER_ALIASES).flat().concat(['state']));
  for (const [canonical, aliases] of Object.entries(HANDLER_ALIASES)) {
    for (const alias of aliases) {
      if (typeof source[alias] === 'function') {
        handlers[canonical] = source[alias];
        break;
      }
    }
  }
  if (source.state !== undefined) handlers.state = source.state;
  for (const key of Object.keys(source)) {
    if (!known.has(key)) unknown.push(key);
  }
  if (!handlers.receive) {
    throw new DefinitionError(
      `actor definition needs a message handler (receive/onMessage); ` +
        `found keys: ${Object.keys(source).join(', ') || '(none)'}`,
    );
  }
  return { handlers, unknown };
}

/**
 * Normalise every supported way of describing an actor into one Definition.
 *
 * Supported inputs:
 *   defineActor(class Player extends Actor { ... })
 *   defineActor(async (msg, ctx) => { ... })
 *   defineActor({ state, preStart, receive, postStop })
 *   defineActor({ onStart, onMessage, onStop })      // alias form
 *   defineActor(instanceOfActorSubclass)
 *
 * @param {Function|object} input
 * @param {object} [defaults] per-type defaults (supervision, mailbox, persistence, ...)
 */
function defineActor(input, defaults = {}) {
  if (input === null || input === undefined) {
    throw new DefinitionError('defineActor(input): input is required');
  }

  // Already normalised.
  if (input instanceof ActorDefinition) {
    return input.options === defaults ? input : input.withDefaults(defaults);
  }

  // A live actor instance.
  if (input instanceof Actor) {
    const name = input.constructor.name || 'Actor';
    return new ActorDefinition({ name, kind: 'instance', create: () => input, options: defaults });
  }

  // A class (optionally extending Actor).
  if (typeof input === 'function' && input.prototype && typeof input.prototype.receive === 'function') {
    const name = input.name || 'AnonymousActor';
    if (input.prototype.receive === Actor.prototype.receive) {
      // Subclassing Actor but not overriding receive() is a definition bug:
      // catch it here instead of failing on the first message.
      throw new DefinitionError(`actor class "${name}" does not implement receive(msg, ctx)`);
    }
    return new ActorDefinition({ name, kind: 'class', create: () => new input(), options: defaults });
  }

  // A bare message handler.
  if (typeof input === 'function') {
    const name = input.name && input.name !== 'anonymous' ? input.name : 'HandlerActor';
    return new ActorDefinition({
      name,
      kind: 'handler',
      create: () => new HandlerActor({ receive: input }),
      options: defaults,
    });
  }

  // A handler/state bag.
  if (typeof input === 'object') {
    const { handlers, unknown } = pickHandlers(input);
    const name = handlers.receive.name && handlers.receive.name !== 'anonymous' ? handlers.receive.name : 'HandlerActor';
    return new ActorDefinition({
      name,
      kind: 'handler',
      create: () => new HandlerActor(handlers),
      options: defaults,
      unknownKeys: unknown,
    });
  }

  throw new DefinitionError(`defineActor(input): unsupported definition of type ${typeof input}`);
}

/** A normalised actor definition. */
class ActorDefinition {
  constructor({ name, kind, create, options = {}, unknownKeys = [], modulePath = null, exportName = 'default' }) {
    this.name = name;
    this.kind = kind;
    this.create = create;
    this.options = options;
    this.unknownKeys = unknownKeys;
    /** Set for `kind: 'worker'`: where the actor's code lives. */
    this.modulePath = modulePath;
    this.exportName = exportName;
  }

  withDefaults(defaults) {
    return new ActorDefinition({
      name: this.name,
      kind: this.kind,
      create: this.create,
      options: { ...defaults, ...this.options },
      unknownKeys: this.unknownKeys,
      modulePath: this.modulePath,
      exportName: this.exportName,
    });
  }
}

module.exports = { Actor, ActorDefinition, defineActor, HandlerActor };
