// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const RestartStrategy = require('./restart-strategy.ts');

/**
 * Supervision decisions for one actor's children.
 *
 * This is the actor-tree counterpart of supervisor.js: same three strategies
 * and the same restart-intensity window, but it only *decides* (pure function
 * of state) and never starts or stops anything. The ActorCell performs the
 * async restart itself, which the older synchronous supervisor could not do.
 *
 * When the intensity window is exceeded the supervisor does not silently give
 * up: it returns `escalate`, and the owning actor fails, so *its* supervisor
 * decides. That is how OTP avoids hiding a permanent failure.
 */
class ChildSupervisor {
  constructor(options = {}) {
    this.id = options.id || 'supervisor';
    this.strategy = Object.values(RestartStrategy).includes(options.strategy)
      ? options.strategy
      : RestartStrategy.ONE_FOR_ONE;
    this.maxRestarts = Number.isFinite(options.maxRestarts) ? options.maxRestarts : 3;
    this.withinSeconds = Number.isFinite(options.withinSeconds) ? options.withinSeconds : 5;
    /** @type {string[]} children in spawn order */
    this.order = [];
    this.restartHistory = [];
    this.escalations = 0;
  }

  get size() {
    return this.order.length;
  }

  add(childId) {
    const id = String(childId);
    if (!this.order.includes(id)) this.order.push(id);
    return id;
  }

  remove(childId) {
    const id = String(childId);
    const index = this.order.indexOf(id);
    if (index < 0) return false;
    this.order.splice(index, 1);
    return true;
  }

  has(childId) {
    return this.order.includes(String(childId));
  }

  checkQuota(now = Date.now()) {
    const cutoff = now - this.withinSeconds * 1000;
    this.restartHistory = this.restartHistory.filter((ts) => ts >= cutoff);
    return this.restartHistory.length < this.maxRestarts;
  }

  /**
   * @returns {{action:'restart', targets:string[]} |
   *           {action:'escalate', reason:string} |
   *           {action:'none', reason:string}}
   */
  decide(crashedId, now = Date.now()) {
    const id = String(crashedId);
    if (!this.has(id)) return { action: 'none', reason: 'unknown_child' };
    if (!this.checkQuota(now)) {
      this.escalations += 1;
      return { action: 'escalate', reason: 'restart_intensity_exceeded' };
    }
    this.restartHistory.push(now);

    if (this.strategy === RestartStrategy.ONE_FOR_ALL) {
      return { action: 'restart', targets: [...this.order] };
    }
    if (this.strategy === RestartStrategy.REST_FOR_ONE) {
      return { action: 'restart', targets: this.order.slice(this.order.indexOf(id)) };
    }
    return { action: 'restart', targets: [id] };
  }

  info() {
    return {
      id: this.id,
      strategy: this.strategy,
      children: [...this.order],
      restartsInWindow: this.restartHistory.length,
      maxRestarts: this.maxRestarts,
      withinSeconds: this.withinSeconds,
      escalations: this.escalations,
    };
  }
}

module.exports = ChildSupervisor;
module.exports.RestartStrategy = RestartStrategy;
