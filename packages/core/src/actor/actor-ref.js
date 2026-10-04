'use strict';

const { ActorStoppedError } = require('./errors');

/**
 * A handle to an actor.
 *
 * This is the only thing user code should hold on to: it is location
 * transparent, so the same `tell`/`ask`/`stop` calls work for an actor in this
 * process (today) or on another node (once the cluster transport is wired to
 * the same interface).
 */
class ActorRef {
  /**
   * @param {{tell:(msg:any)=>boolean, ask:(msg:any, timeout?:number)=>Promise<any>,
   *          stop:()=>Promise<void>, inspect:()=>object,
   *          id:string, path:string}} target
   */
  constructor(target) {
    Object.defineProperty(this, '_target', { value: target, enumerable: false });
  }

  get id() {
    return this._target.id;
  }

  get path() {
    return this._target.path;
  }

  get isLocal() {
    return true;
  }

  /**
   * Fire and forget. Returns false when the mailbox refused the message.
   * The optional `sender`/`trace` are used internally by ActorContext so the
   * callee sees who sent the message and the trace chain stays intact.
   */
  tell(msg, sender, trace) {
    return this._target.tell(msg, sender, trace);
  }

  /** Send and wait for the reply returned by `receive`. */
  ask(msg, timeoutMs, sender, trace) {
    return this._target.ask(msg, timeoutMs, sender, trace);
  }

  /** Graceful stop (runs postStop); the ref becomes unusable afterwards. */
  stop() {
    return this._target.stop();
  }

  /** Introspection snapshot (mailbox depth, state, children, counters). */
  inspect() {
    return this._target.inspect();
  }

  /**
   * The actor's current state: a clone for local actors, fetched over the
   * worker protocol for isolated ones.
   */
  state() {
    return typeof this._target.state === 'function' ? this._target.state() : undefined;
  }

  toString() {
    return `ActorRef(${this._target.path || this._target.id})`;
  }
}

/** Placeholder for "this message has no sender" (an `ask` always has one). */
class DeadLetterRef {
  get id() {
    return null;
  }

  get path() {
    return null;
  }

  get isLocal() {
    return true;
  }

  tell() {
    return false;
  }

  ask() {
    return Promise.reject(new ActorStoppedError('the sender is not replyable'));
  }

  stop() {
    return Promise.resolve();
  }

  inspect() {
    return { dead: true };
  }

  state() {
    return undefined;
  }

  toString() {
    return 'DeadLetterRef';
  }
}

module.exports = { ActorRef, DeadLetterRef };
