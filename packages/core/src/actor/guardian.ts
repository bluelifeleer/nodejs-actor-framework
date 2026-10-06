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
/** 监督策略（与 RestartStrategy 常量同值）。 */
type Strategy = 'one_for_one' | 'rest_for_one' | 'one_for_all';

interface SupervisorOptions {
  id?: string;
  strategy?: string;
  maxRestarts?: number;
  withinSeconds?: number;
}

/** `decide()` 的三种结论：重启（列出目标）/ 上报（让上级决定）/ 什么都不做。 */
type SupervisionDecision =
  | { action: 'restart'; targets: string[] }
  | { action: 'escalate'; reason: string }
  | { action: 'none'; reason: string };

class ChildSupervisor {
  readonly id: string;
  readonly strategy: Strategy;
  readonly maxRestarts: number;
  readonly withinSeconds: number;
  /** 子 Actor（按创建顺序）。 */
  order: string[];
  /** 重启时间戳（滑动窗口内）。 */
  restartHistory: number[];
  escalations: number;

  constructor(options: SupervisorOptions = {}) {
    this.id = options.id ?? 'supervisor';
    const strategies = Object.values(RestartStrategy) as string[];
    this.strategy = (options.strategy !== undefined && strategies.includes(options.strategy)
      ? options.strategy
      : RestartStrategy.ONE_FOR_ONE) as Strategy;
    this.maxRestarts = Number.isFinite(options.maxRestarts) ? (options.maxRestarts as number) : 3;
    this.withinSeconds = Number.isFinite(options.withinSeconds) ? (options.withinSeconds as number) : 5;
    this.order = [];
    this.restartHistory = [];
    this.escalations = 0;
  }

  get size(): number {
    return this.order.length;
  }

  add(childId: string): string {
    const id = String(childId);
    if (!this.order.includes(id)) this.order.push(id);
    return id;
  }

  remove(childId: string): boolean {
    const id = String(childId);
    const index = this.order.indexOf(id);
    if (index < 0) return false;
    this.order.splice(index, 1);
    return true;
  }

  has(childId: string): boolean {
    return this.order.includes(String(childId));
  }

  /** 强度窗口内还有重启额度吗（会顺手清掉窗口外的时间戳）。 */
  checkQuota(now = Date.now()): boolean {
    const cutoff = now - this.withinSeconds * 1000;
    this.restartHistory = this.restartHistory.filter((ts) => ts >= cutoff);
    return this.restartHistory.length < this.maxRestarts;
  }

  /**
   * 纯决策：不启动也不停止任何东西（异步重启由 ActorCell 做）。
   * 超出强度窗口时**不静默放弃**，而是 `escalate` —— 让上级监督者决定（OTP 的语义）。
   */
  decide(crashedId: string, now = Date.now()): SupervisionDecision {
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

  info(): Record<string, unknown> {
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
