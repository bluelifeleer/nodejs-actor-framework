/**
 * `actor migrate status|up|down`：对接数据层的迁移框架。
 *
 * 这里刻意**不重新实现**迁移逻辑：版本表、幂等、中断可重入、"数据比代码新"都是
 * `@actor/data` 的 `createMigrationRunner` 在做。CLI 只负责：找到项目、找到迁移、把结果讲清楚。
 */

import { createFileMigrationStore, createMigrationRunner } from '@actor/data';

import { UsageError } from '../args.ts';
import { ProjectError, loadMigrations, loadProject } from '../project/load.ts';

export interface MigrateOptions {
  dir: string;
  data?: string;
  to?: number;
}

export interface MigrateResult {
  action: 'status' | 'up' | 'down';
  project: string;
  dataDir: string;
  status: { applied: number[]; pending: number[]; interrupted: number[]; unknown: number[] };
  applied?: unknown[];
  rolledBack?: unknown[];
  /** 需要用户注意的下一步（例如"有未应用迁移"）。 */
  notes: string[];
}

async function runnerFor(options: MigrateOptions) {
  const project = await loadProject(options.dir, { data: options.data });
  const migrations = await loadMigrations(project);
  const runner = createMigrationRunner({
    store: createFileMigrationStore({ dir: project.dataDir }),
    migrations: migrations as never,
  });
  return { project, migrations, runner };
}

export async function migrate(action: string, options: MigrateOptions): Promise<MigrateResult> {
  if (!['status', 'up', 'down'].includes(action)) {
    throw new UsageError(`未知的迁移动作 '${action}'`, '支持：status（看状态）/ up（应用）/ down --to <version>（回滚）');
  }

  const { project, migrations, runner } = await runnerFor(options);
  if (migrations.length === 0) {
    // 项目还没写迁移不是错误：说清楚就好（别让人以为命令坏了）
    const status = await runner.status();
    return {
      action: action as MigrateResult['action'],
      project: project.name,
      dataDir: project.dataDir,
      status,
      notes: ['这个项目还没有迁移（约定位置：src/migrations.ts）'],
    };
  }

  const notes: string[] = [];
  if (action === 'status') {
    const status = await runner.status();
    if (status.interrupted.length > 0) {
      notes.push(`有中断的迁移 ${status.interrupted.map((v) => `v${v}`).join(', ')}：up 会重跑它（up() 必须幂等）`);
    }
    if (status.pending.length > 0) notes.push(`有未应用迁移：跑 actor migrate up`);
    if (status.unknown.length > 0) {
      notes.push(`数据里的版本比代码新（${status.unknown.map((v) => `v${v}`).join(', ')}）：请先升级代码，不要降级跑`);
    }
    return { action: 'status', project: project.name, dataDir: project.dataDir, status, notes };
  }

  if (action === 'up') {
    const result = await runner.migrate();
    const status = await runner.status();
    if (status.pending.length > 0) notes.push('还有未应用的迁移（看 status）');
    return {
      action: 'up',
      project: project.name,
      dataDir: project.dataDir,
      applied: result.applied,
      status,
      notes,
    };
  }

  // down：必须显式给目标版本 —— CLI 绝不猜"回滚到哪"
  if (options.to === undefined || !Number.isInteger(options.to) || options.to < 0) {
    throw new UsageError(
      '`migrate down` 需要显式目标版本',
      '用法：actor migrate down --to <version>（回滚到该版本，回滚它之后的迁移）',
    );
  }
  const result = await runner.rollback({ to: options.to });
  const status = await runner.status();
  return {
    action: 'down',
    project: project.name,
    dataDir: project.dataDir,
    rolledBack: result.rolledBack,
    status,
    notes,
  };
}

export { ProjectError };
