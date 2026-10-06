/**
 * 迁移执行器（M3 第 4 步）。
 *
 * 默认姿态是**拒绝启动**（doc 04 §5）：`assertMigrationsApplied()` 在任何"结构不确定"的情况下抛错，
 * 而不是让应用带着旧结构跑起来：
 *   - 有未应用的迁移 → `MigrationPendingError`（先 migrate()）；
 *   - 上次执行中断 → `MigrationInterruptedError`（重跑 migrate()，up() 必须幂等）；
 *   - 数据里的版本比代码还新 → `MigrationVersionError`（说明代码该升级，绝不"降级跑"）。
 */

import {
  MigrationPendingError,
  MigrationInterruptedError,
  MigrationVersionError,
  type Migration,
  type MigrationContext,
  type MigrationRecord,
  type MigrationStore,
} from './types.ts';

export interface MigrationRunnerOptions {
  migrations: readonly Migration[];
  store: MigrationStore;
  /** 诊断输出（默认什么都不打；执行动作时由调用方决定要不要给）。 */
  log?: (message: string, meta?: unknown) => void;
  /** 时钟（测试注入用）。 */
  now?: () => number;
}

export interface MigrationStatus {
  /** 已完成的版本（升序）。 */
  applied: number[];
  /**
   * 声明了但没跑的迁移版本（升序）。
   *
   * 与 `applied` / `interrupted` / `unknown` 一样是**版本号**：同一个状态对象里混两种类型
   * （这里给对象、那里给数字）会让使用者写出 `v[object Object]` 这种输出——CLI 打印状态时
   * 就是这么发现的。要迁移详情，调用方本来就持有自己传进去的那个数组。
   */
  pending: number[];
  /** 版本表里是 started 的（执行到一半中断）。 */
  interrupted: number[];
  /** 版本表里有、但当前代码里没有的版本（代码比数据旧）。 */
  unknown: number[];
}

const byVersion = (migrations: readonly Migration[]): Migration[] =>
  [...migrations].sort((a, b) => a.version - b.version);

export function createMigrationRunner(options: MigrationRunnerOptions) {
  if (!options?.store || typeof options.store.read !== 'function') {
    throw new MigrationVersionError(['migrationRunner 需要 store（提供 read / write / remove）']);
  }
  const issues: string[] = [];
  const seen = new Set<number>();
  for (const migration of options.migrations ?? []) {
    if (!Number.isInteger(migration?.version) || migration.version < 1) {
      issues.push(`迁移的 version 必须是 >= 1 的整数（当前 ${String(migration?.version)}）`);
      continue;
    }
    if (seen.has(migration.version)) issues.push(`版本 v${migration.version} 被声明了两次`);
    seen.add(migration.version);
    if (typeof migration.up !== 'function') issues.push(`v${migration.version} 缺少 up() 函数`);
    if (migration.down !== undefined && typeof migration.down !== 'function') {
      issues.push(`v${migration.version} 的 down 必须是函数（要么不写，要么写成函数）`);
    }
  }
  if (issues.length > 0) throw new MigrationVersionError(issues);

  const { store } = options;
  const migrations = byVersion(options.migrations ?? []);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const context: MigrationContext = { store, log };

  async function readRecords(): Promise<MigrationRecord[]> {
    await store.ensure?.();
    return store.read();
  }

  async function status(): Promise<MigrationStatus> {
    const records = await readRecords();
    const known = new Map(migrations.map((migration) => [migration.version, migration]));
    const applied: number[] = [];
    const interrupted: number[] = [];
    const unknown: number[] = [];
    for (const record of records) {
      if (!known.has(record.version)) {
        unknown.push(record.version);
        continue;
      }
      if (record.status === 'completed') applied.push(record.version);
      else interrupted.push(record.version);
    }
    const done = new Set([...applied, ...interrupted]);
    return {
      applied: applied.sort((a, b) => a - b),
      pending: migrations.filter((migration) => !done.has(migration.version)).map((migration) => migration.version),
      interrupted: interrupted.sort((a, b) => a - b),
      unknown: unknown.sort((a, b) => a - b),
    };
  }

  /** 启动校验：任何"结构不确定"都拒绝启动。 */
  async function assertApplied(): Promise<MigrationStatus> {
    const current = await status();
    if (current.unknown.length > 0) {
      throw new MigrationVersionError([
        `数据里应用过 v${current.unknown.join(', v')}，但当前代码里没有这些迁移：` +
          '说明代码比数据旧——请先升级代码，不要用旧代码跑新结构',
      ]);
    }
    if (current.interrupted.length > 0) throw new MigrationInterruptedError(current.interrupted);
    if (current.pending.length > 0) throw new MigrationPendingError([...current.pending]);
    return current;
  }

  /** 按版本升序执行未完成的迁移；每个迁移**先记 started、成功后记 completed**。 */
  async function migrate(): Promise<{ applied: Migration[]; status: MigrationStatus }> {
    const current = await status();
    if (current.unknown.length > 0) {
      throw new MigrationVersionError([
        `数据里应用过 v${current.unknown.join(', v')}，但当前代码里没有这些迁移（不能降级执行）`,
      ]);
    }
    const ran: Migration[] = [];
    // interrupted 也要重跑（顺序仍然按版本升序）
    const todo = migrations.filter(
      (migration) => current.pending.includes(migration.version) || current.interrupted.includes(migration.version),
    );
    for (const migration of todo) {
      const wasInterrupted = current.interrupted.includes(migration.version);
      log(wasInterrupted ? `重跑中断的迁移 v${migration.version}` : `应用迁移 v${migration.version}`, {
        description: migration.description,
      });
      await store.write({
        version: migration.version,
        status: 'started',
        ...(migration.description === undefined ? {} : { description: migration.description }),
        at: now(),
      });
      await migration.up(context);
      await store.write({
        version: migration.version,
        status: 'completed',
        ...(migration.description === undefined ? {} : { description: migration.description }),
        at: now(),
      });
      ran.push(migration);
    }
    return { applied: ran, status: await status() };
  }

  /** 回滚到 `to`（不含）：按版本**降序**执行 down()；缺 down 的迁移直接报错。 */
  async function rollback(rollbackOptions: { to: number }): Promise<{ rolledBack: Migration[]; status: MigrationStatus }> {
    const target = rollbackOptions?.to;
    if (!Number.isInteger(target) || target < 0) {
      throw new MigrationVersionError([`rollback 需要 to（>= 0 的整数，当前 ${String(target)}）`]);
    }
    const current = await status();
    const candidates = migrations
      .filter((migration) => migration.version > target && current.applied.includes(migration.version))
      .sort((a, b) => b.version - a.version);
    const missingDown = candidates.filter((migration) => typeof migration.down !== 'function');
    if (missingDown.length > 0) {
      throw new MigrationVersionError([
        `v${missingDown.map((m) => m.version).join(', v')} 没有 down()，无法回滚：` +
          '要能回滚就在迁移里写 down()，否则请用"前滚"而不是回滚',
      ]);
    }
    const rolledBack: Migration[] = [];
    for (const migration of candidates) {
      log(`回滚迁移 v${migration.version}`, { description: migration.description });
      await migration.down?.(context);
      await store.remove(migration.version);
      rolledBack.push(migration);
    }
    return { rolledBack, status: await status() };
  }

  return { status, assertApplied, migrate, rollback };
}
