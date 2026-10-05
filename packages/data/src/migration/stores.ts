/**
 * 版本表的三个适配器（M3 第 4 步）。
 *
 * 共同约定：`write` 是**覆盖语义**（同一版本重复写就是更新状态），所以"started → completed"
 * 只是一个普通的覆盖；`read` 返回每个版本的**最后**状态。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { MigrationVersionError, type MigrationRecord, type MigrationStore } from './types.ts';

function checkRecord(record: MigrationRecord): void {
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new MigrationVersionError([`版本号必须是 >= 1 的整数（当前 ${String(record.version)}）`]);
  }
  if (record.status !== 'started' && record.status !== 'completed') {
    throw new MigrationVersionError([`status 只能是 'started' 或 'completed'（当前 ${String(record.status)}）`]);
  }
}

/** 最近一次为准：同一版本有多条记录时取最后一条。 */
function lastWins(records: readonly MigrationRecord[]): MigrationRecord[] {
  const byVersion = new Map<number, MigrationRecord>();
  for (const record of records) byVersion.set(record.version, record);
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

export function createMemoryMigrationStore(seed: readonly MigrationRecord[] = []): MigrationStore {
  let records = lastWins(seed);
  const api: MigrationStore = {
    async read() {
      return records.map((record) => ({ ...record }));
    },
    async write(record) {
      checkRecord(record);
      records = lastWins([...records, { ...record }]);
    },
    async remove(version) {
      records = records.filter((record) => record.version !== version);
    },
  };
  return api;
}

export interface FileMigrationStoreOptions {
  /** 数据目录（文件是 `<dir>/migrations.json`）。 */
  dir: string;
}

export function createFileMigrationStore(options: FileMigrationStoreOptions): MigrationStore {
  if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
    throw new MigrationVersionError(['createFileMigrationStore 需要 dir（数据目录）']);
  }
  const file = path.join(options.dir, 'migrations.json');

  const readAll = async (): Promise<MigrationRecord[]> => {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return lastWins(parsed as MigrationRecord[]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        throw new MigrationVersionError([`版本表 ${file} 内容损坏：${err.message}`]);
      }
      throw err;
    }
  };

  const writeAll = async (records: readonly MigrationRecord[]): Promise<void> => {
    fs.mkdirSync(options.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`);
    await fsp.rename(tmp, file); // 原子替换：版本表不会读到写了一半的内容
  };

  return {
    read: readAll,
    async write(record) {
      checkRecord(record);
      await writeAll(lastWins([...(await readAll()), { ...record }]));
    },
    async remove(version) {
      await writeAll((await readAll()).filter((record) => record.version !== version));
    },
  };
}

/** SQL 版本表用到的驱动能力（与仓储的 SqlRunner 同形，便于复用同一个连接）。 */
export interface MigrationSqlRunner {
  all(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: readonly unknown[]): Promise<number>;
}

export interface SqlMigrationStoreOptions {
  runner: MigrationSqlRunner;
  /** 版本表名（默认 `schema_migrations`；由 `ensure()` 建表）。 */
  table?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function createSqlMigrationStore(options: SqlMigrationStoreOptions): MigrationStore {
  const table = options?.table ?? 'schema_migrations';
  if (!options?.runner || typeof options.runner.all !== 'function' || typeof options.runner.run !== 'function') {
    throw new MigrationVersionError(['createSqlMigrationStore 需要 runner（提供 all / run）']);
  }
  if (!IDENTIFIER.test(table)) throw new MigrationVersionError([`表名必须是简单标识符：${table}`]);
  const { runner } = options;

  return {
    async ensure() {
      // 只建框架自己的账本表（业务表仍然是你的事）
      await runner.run(
        `CREATE TABLE IF NOT EXISTS ${table} (version INTEGER PRIMARY KEY, status TEXT NOT NULL, description TEXT, at INTEGER NOT NULL)`,
        [],
      );
    },
    async read() {
      const rows = await runner.all(`SELECT version, status, description, at FROM ${table} ORDER BY version`, []);
      return rows.map((row) => ({
        version: Number(row.version),
        status: row.status === 'started' ? 'started' : 'completed',
        ...(row.description === null || row.description === undefined ? {} : { description: String(row.description) }),
        at: Number(row.at),
      }));
    },
    async write(record) {
      checkRecord(record);
      // DELETE + INSERT：三种方言都认（不用 ON CONFLICT / ON DUPLICATE KEY），小表足够
      await runner.run(`DELETE FROM ${table} WHERE version = ?`, [record.version]);
      await runner.run(`INSERT INTO ${table} (version, status, description, at) VALUES (?, ?, ?, ?)`, [
        record.version,
        record.status,
        record.description ?? null,
        record.at,
      ]);
    },
    async remove(version) {
      await runner.run(`DELETE FROM ${table} WHERE version = ?`, [version]);
    },
  };
}
