/**
 * 快照信封 + 版本策略（M3 第 1 步）。
 *
 * 原则（doc 04 §4.2）：**快照是缓存，不是事实来源**。所以版本对不上时，
 * 最差的选择是"硬着头皮用"；本文件的默认行为是**拒绝启动并指名版本**。
 */

/** 信封本身的格式版本（与用户的状态版本无关）。 */
export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotEnvelope<S = unknown> {
  /** 信封格式版本；用于将来改信封本身。 */
  snapshotVersion: number;
  /** **状态结构**版本（用户 schema 的版本）。 */
  stateVersion: number;
  takenAt: number;
  state: S;
}

export interface SnapshotSchema<S = unknown> {
  /** 当前代码期望的状态结构版本。 */
  version: number;
  /**
   * 没有信封的旧快照（M3 之前写入）对应的状态版本。
   * 默认 `1`——如果你的存量快照其实不是"新方案的第 1 版"，在这里改。
   */
  legacyVersion?: number;
  /**
   * 结构迁移：`from` → `to`。**缺失时不会猜测**：直接拒绝启动并说明缺哪个版本。
   * 迁移函数应当是纯函数（返回新状态，不改输入）。
   */
  migrate?: (state: unknown, meta: { from: number; to: number }) => S;
}

/** 快照结构版本对不上、且无法安全处理时抛出（＝拒绝启动该 Actor）。 */
export class StateEvolutionError extends Error {
  readonly found: number | undefined;
  readonly expected: number | undefined;
  constructor(message: string, details: { found?: number; expected?: number } = {}) {
    super(message);
    this.name = 'StateEvolutionError';
    this.found = details.found;
    this.expected = details.expected;
  }
}

export function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SnapshotEnvelope>;
  return (
    Number.isInteger(candidate.snapshotVersion) &&
    (candidate.snapshotVersion as number) >= 1 &&
    Number.isInteger(candidate.stateVersion) &&
    (candidate.stateVersion as number) >= 1 &&
    'state' in candidate
  );
}

/** 写入时套信封（`takenAt` 可注入，便于测试）。 */
export function createSnapshotEnvelope<S>(
  state: S,
  options: { stateVersion: number; takenAt?: number },
): SnapshotEnvelope<S> {
  if (!Number.isInteger(options.stateVersion) || options.stateVersion < 1) {
    throw new StateEvolutionError(
      `createSnapshotEnvelope: stateVersion 必须是 >= 1 的整数（当前 ${String(options.stateVersion)}）`,
    );
  }
  return {
    snapshotVersion: SNAPSHOT_FORMAT_VERSION,
    stateVersion: options.stateVersion,
    takenAt: options.takenAt ?? Date.now(),
    state,
  };
}

/**
 * 读取一条快照，返回**当前结构**的状态。
 *
 * 四条规则（可测）：
 * 1. `stateVersion` 与代码期望一致 → 直接用；
 * 2. 不一致 + 注册了 `migrate` → 迁移后用；
 * 3. 不一致 + 没有 `migrate` → 抛 `StateEvolutionError`（**拒绝启动**，绝不静默用错结构）；
 * 4. 没有信封（M3 之前的快照）→ 视为 `legacyVersion`（默认 1），落回 1/2/3。
 *
 * 另外：信封格式版本比本代码更新时同样拒绝（说明代码比数据旧，降级读会被误读）。
 */
export function decodeSnapshot<S>(raw: unknown, schema: SnapshotSchema<S>): unknown {
  if (!Number.isInteger(schema?.version) || schema.version < 1) {
    throw new StateEvolutionError(
      `decodeSnapshot: schema.version 必须是 >= 1 的整数（当前 ${String(schema?.version)}）`,
    );
  }

  const hasEnvelope = isSnapshotEnvelope(raw);
  if (hasEnvelope && raw.snapshotVersion > SNAPSHOT_FORMAT_VERSION) {
    throw new StateEvolutionError(
      `快照信封格式 v${raw.snapshotVersion} 比本代码支持的 v${SNAPSHOT_FORMAT_VERSION} 更新：` +
        '拒绝用旧代码读新格式（请先升级代码）',
    );
  }

  const stateVersion = hasEnvelope ? raw.stateVersion : (schema.legacyVersion ?? 1);
  const state = hasEnvelope ? raw.state : raw;

  if (stateVersion === schema.version) return state;

  if (typeof schema.migrate === 'function') {
    return schema.migrate(state, { from: stateVersion, to: schema.version });
  }

  throw new StateEvolutionError(
    `快照状态结构是 v${stateVersion}，而当前代码期望 v${schema.version}，且没有注册迁移函数：` +
      '拒绝启动（不会静默用错结构）。请提供 migrate，或删除该快照让它从事件重建。',
    { found: stateVersion, expected: schema.version },
  );
}
