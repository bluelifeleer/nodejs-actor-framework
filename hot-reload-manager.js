'use strict';

const config = require('./config');

/**
 * Actor hot-reload coordinator (main process side).
 *
 * Security posture (this used to be remotely reachable RCE with no checks):
 *  - Disabled by default; requires ENABLE_HOT_RELOAD=1.
 *  - Code size is bounded.
 *  - The worker validates that the compiled value is actually a function and
 *    that it does not return a non-function, and reports failures back so the
 *    console can show a real error instead of silently killing the actor.
 *  - A dependency-free "reviewed module" path is offered as the safer
 *    alternative: the worker `require()`s a file that is already on disk.
 */
class HotReloadManager {
  constructor(actorManager, options = {}) {
    this.am = actorManager;
    this.enabled = options.enabled ?? config.hotReload.enabled;
    this.maxCodeBytes = options.maxCodeBytes || config.hotReload.maxCodeBytes;
    this.modulePath = options.modulePath || config.hotReload.modulePath;
  }

  get isEnabled() {
    return Boolean(this.enabled);
  }

  _assertEnabled() {
    if (!this.enabled) {
      throw new Error('hot reload is disabled; start with ENABLE_HOT_RELOAD=1 to allow it');
    }
  }

  /** Replace an actor's onMessage with dynamically compiled code. */
  async hotUpdate(actorId, fnCode) {
    this._assertEnabled();
    if (typeof fnCode !== 'string' || fnCode.trim() === '') {
      throw new TypeError('hotUpdate(actorId, fnCode): fnCode must be a non-empty string');
    }
    if (Buffer.byteLength(fnCode, 'utf8') > this.maxCodeBytes) {
      throw new Error(`hot reload code exceeds ${this.maxCodeBytes} bytes`);
    }
    return this.am.control(actorId, { type: 'hot_reload', fnCode }, this.am.requestTimeoutMs);
  }

  /** Load a handler from an existing module file (no eval). */
  async loadFromModule(actorId, modulePath = this.modulePath, exportName = 'default') {
    if (!modulePath) throw new Error('no module path configured (ACTOR_HOT_RELOAD_MODULE)');
    return this.am.control(
      actorId,
      { type: 'hot_reload_module', modulePath, exportName },
      this.am.requestTimeoutMs,
    );
  }

  info() {
    return {
      enabled: this.enabled,
      maxCodeBytes: this.maxCodeBytes,
      modulePath: this.modulePath || null,
    };
  }
}

module.exports = HotReloadManager;
module.exports.HotReloadManager = HotReloadManager;
