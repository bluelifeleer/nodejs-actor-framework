'use strict';

const EventEmitter = require('events');
const config = require('./config');

const RestartStrategy = {
  ONE_FOR_ONE: 'one_for_one',
  REST_FOR_ONE: 'rest_for_one',
  ONE_FOR_ALL: 'one_for_all',
};

const VALID_STRATEGIES = new Set(Object.values(RestartStrategy));

/**
 * OTP-style supervisor.
 *
 * Supports the three documented strategies, a real restart-intensity circuit
 * breaker, and — importantly — the wiring that used to be missing:
 * `handleChildCrash()` is now called from ActorManager when a worker exits
 * abnormally, so "fault auto-restart" actually happens.
 */
class Supervisor extends EventEmitter {
  /**
   * @param {string|object} id supervisor id, or an options object with `id`
   * @param {object} [options]
   */
  constructor(id, options = {}) {
    super();
    let opts = options;
    if (id && typeof id === 'object') {
      opts = id;
      id = opts.id;
    }
    this.id = id || 'supervisor';
    this.strategy = VALID_STRATEGIES.has(opts.strategy) ? opts.strategy : RestartStrategy.ONE_FOR_ONE;
    this.maxRestarts = Number.isFinite(opts.maxRestarts) ? opts.maxRestarts : config.supervisor.maxRestarts;
    this.withinSeconds = Number.isFinite(opts.withinSeconds) ? opts.withinSeconds : config.supervisor.withinSeconds;
    this.cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : config.supervisor.cooldownMs;
    this.autoRecover = opts.autoRecover !== false;

    /** @type {Map<string, object>} */
    this.children = new Map();
    this.restartHistory = [];
    this.running = false;
    this.circuitOpen = false;
    this._timers = new Set();
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.circuitOpen = false;
    this.emit('start', this.id);
    return this;
  }

  stop() {
    this.running = false;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    for (const child of this.children.values()) {
      this._stopChildRef(child);
      child.stopped = true;
    }
    this.emit('stop', this.id);
    return this;
  }

  _later(fn, ms) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      fn();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    this._timers.add(t);
    return t;
  }

  _stopChildRef(child) {
    if (!child) return;
    try {
      if (typeof child.stopFn === 'function') child.stopFn(child.ref);
      else if (child.ref && typeof child.ref.terminate === 'function') child.ref.terminate();
    } catch (err) {
      this.emit('child_stop_error', child.id, err);
    }
  }

  /**
   * @param {() => any} startFn creates the child, returns its handle
   * @param {string} childId
   * @param {{stopFn?: (ref:any)=>void}} [opts]
   */
  spawnChild(startFn, childId, opts = {}) {
    if (!this.running) throw new Error(`supervisor ${this.id} not running`);
    if (typeof startFn !== 'function') throw new TypeError('spawnChild(startFn, childId): startFn must be a function');
    if (!childId) throw new TypeError('spawnChild(startFn, childId): childId is required');
    if (this.children.has(childId)) throw new Error(`child ${childId} already supervised`);

    const child = { id: childId, startFn, stopFn: opts.stopFn, ref: null, stopped: false, restarts: 0 };
    this.children.set(childId, child);
    child.ref = startFn();
    this.emit('child_start', childId);
    return childId;
  }

  hasChild(childId) {
    return this.children.has(childId);
  }

  checkRestartQuota(now = Date.now()) {
    const cutoff = now - this.withinSeconds * 1000;
    this.restartHistory = this.restartHistory.filter((t) => t >= cutoff);
    return this.restartHistory.length < this.maxRestarts;
  }

  _restart(child) {
    this._stopChildRef(child);
    child.ref = child.startFn();
    child.stopped = false;
    child.restarts += 1;
    this.restartHistory.push(Date.now());
    this.emit('child_restart', child.id);
  }

  _openCircuit() {
    this.circuitOpen = true;
    this.running = false;
    for (const child of this.children.values()) {
      this._stopChildRef(child);
      child.stopped = true;
    }
    this.emit('supervisor_circuit_open', this.id, {
      maxRestarts: this.maxRestarts,
      withinSeconds: this.withinSeconds,
    });
    if (this.autoRecover) {
      this._later(() => this._closeCircuit(), this.cooldownMs);
    }
  }

  _closeCircuit() {
    this.circuitOpen = false;
    this.running = true;
    this.restartHistory = [];
    for (const child of this.children.values()) {
      try {
        child.ref = child.startFn();
        child.stopped = false;
        this.emit('child_restart', child.id);
      } catch (err) {
        this.emit('child_start_error', child.id, err);
      }
    }
    this.emit('supervisor_circuit_close', this.id);
  }

  /** Ordered list of supervised children (spawn order). */
  _order() {
    return [...this.children.values()];
  }

  /**
   * Called by ActorManager when a supervised worker dies unexpectedly.
   * Applies the configured restart strategy and the intensity limit.
   */
  handleChildCrash(childId, info = {}) {
    const child = this.children.get(childId);
    if (!child) return { restarted: false, reason: 'unknown_child' };
    if (child.stopped) return { restarted: false, reason: 'stopped' }; // intentional kill
    if (!this.running) return { restarted: false, reason: 'not_running' };

    this.emit('child_crash', childId, info);

    if (!this.checkRestartQuota()) {
      this._openCircuit();
      return { restarted: false, reason: 'restart_intensity_exceeded' };
    }

    const order = this._order();
    const index = order.findIndex((c) => c.id === childId);

    if (this.strategy === RestartStrategy.ONE_FOR_ALL) {
      // The whole group shares fate: restart everything after stopping all.
      for (const c of order) this._stopChildRef(c);
      for (const c of order) this._restart(c);
      return { restarted: true, restartedChildren: order.map((c) => c.id) };
    }

    if (this.strategy === RestartStrategy.REST_FOR_ONE) {
      // Restart the crashed child and every child started after it.
      const affected = order.slice(index);
      for (const c of affected) this._stopChildRef(c);
      for (const c of affected) this._restart(c);
      return { restarted: true, restartedChildren: affected.map((c) => c.id) };
    }

    this._restart(child);
    return { restarted: true, restartedChildren: [childId] };
  }

  /** Intentional stop: the child is not restarted afterwards. */
  killChild(childId) {
    const child = this.children.get(childId);
    if (!child) return false;
    child.stopped = true;
    this._stopChildRef(child);
    this.emit('child_stop', childId);
    return true;
  }

  stopChild(childId) {
    return this.killChild(childId);
  }

  removeChild(childId) {
    const child = this.children.get(childId);
    if (!child) return false;
    this._stopChildRef(child);
    child.stopped = true;
    this.children.delete(childId);
    this.emit('child_stop', childId);
    return true;
  }

  info() {
    return {
      id: this.id,
      strategy: this.strategy,
      running: this.running,
      circuitOpen: this.circuitOpen,
      restartsInWindow: this.restartHistory.length,
      children: this._order().map((c) => ({ id: c.id, stopped: c.stopped, restarts: c.restarts })),
    };
  }
}

module.exports = Supervisor;
module.exports.Supervisor = Supervisor;
module.exports.RestartStrategy = RestartStrategy;
