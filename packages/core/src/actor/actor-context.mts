

import { ActorStoppedError } from './errors.mts';

/**
 * The `ctx` object passed to every actor hook and to `receive`.
 *
 * It is the actor's view of the world: who it is, who sent the current
 * message, how to create children, and how to persist. It deliberately does
 * not expose the cell's internals.
 */
class ActorContext {
  constructor(cell) {
    this.cell = cell;
    this.restored = false;
  }

  get self() {
    return this.cell.ref;
  }

  /** The sender of the message currently being handled, or null if outside. */
  get sender() {
    return this.cell.currentSender;
  }

  get system() {
    return this.cell.system;
  }

  get id() {
    return this.cell.id;
  }

  get path() {
    return this.cell.path;
  }

  /** Child actor ids, in spawn order. */
  get children() {
    return [...this.cell.children.keys()];
  }

  /** True when the actor is inside `receive` (used to guard misuse). */
  get handling() {
    return this.cell.handling;
  }

  /** Trace context of the message being handled (tracing plugin installed). */
  get trace() {
    return this.cell.currentTrace || null;
  }

  /** Create a child span of the current one (for spans the actor starts). */
  span() {
    if (!this.cell.system.tracer) return null;
    return this.cell.system.tracer.child(this.cell.currentTrace);
  }

  /** Create a child actor supervised by this one. */
  spawn(definition, options) {
    return this.cell.spawnChild(definition, options);
  }

  /** Send to another actor (accepts an ActorRef, or an id/path string). */
  tell(target, msg) {
    return resolveTarget(this.cell, target).tell(msg, this.cell.ref, this.cell.currentTrace);
  }

  ask(target, msg, timeoutMs) {
    return resolveTarget(this.cell, target).ask(
      msg,
      timeoutMs ?? this.cell.options.askTimeoutMs,
      this.cell.ref,
      this.cell.currentTrace,
    );
  }

  /** Stop a child (or any known actor) gracefully. */
  stop(target) {
    if (target === undefined) return this.cell.stop();
    return resolveTarget(this.cell, target).stop();
  }

  stopSelf() {
    return this.cell.stop();
  }

  /** Append a domain event (persistence: 'events'). */
  persist(event) {
    return this.cell.persistEvent(event);
  }

  /** Store the current state (persistence: 'snapshot'). */
  saveSnapshot() {
    return this.cell.saveSnapshot();
  }

  /** Structured log line, tagged with this actor's path. */
  log(message, meta) {
    this.cell.system._log('actor', { path: this.cell.path, message, ...(meta || {}) });
  }
}

function resolveTarget(cell, target) {
  if (!target) throw new ActorStoppedError('target actor is required');
  if (typeof target.tell === 'function' && typeof target.ask === 'function') return target;

  const local = cell.system.resolve(target);
  if (local) return local;

  // Location transparency: "path@host:port" (or a bare path once a peer is
  // connected) routes to the peer node. With no peers this is skipped, so the
  // local-only behaviour is unchanged.
  if (typeof target === 'string' && (target.includes('@') || cell.system.peers.size > 0)) {
    try {
      return cell.system.remote(target);
    } catch {
      /* fall through to the clearer error below */
    }
  }
  throw new ActorStoppedError(`no actor registered as "${target}"`);
}



export { resolveTarget, ActorContext };
export default ActorContext;