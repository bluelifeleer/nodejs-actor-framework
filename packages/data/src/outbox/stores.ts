/**
 * Outbox 的游标与日志读取（M3 第 5 步）。
 *
 * 游标存储三个适配器与迁移框架的版本表同形（memory / file / sql）：一个整数、原子写、
 * 跨实例可读。日志读取则是"把内核的 `store.loadEvents` 包一层"，用注册表补号并取出 `seq/eventId`。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { EventRegistry } from '../events.ts';
import { OutboxError, type OutboxCursorStore, type OutboxEntry, type OutboxLogReader } from './types.ts';

/* -------------------------------------------------------------------------- */
/* 游标存储                                                                    */
/* -------------------------------------------------------------------------- */

function checkSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq < 0) throw new OutboxError(`游标必须是 >= 0 的整数（当前 ${String(seq)}）`);
}

export function createMemoryOutboxCursor(initial = 0): OutboxCursorStore {
  checkSeq(initial);
  let cursor = initial;
  return {
    async read() {
      return cursor;
    },
    async write(seq) {
      checkSeq(seq);
      cursor = seq;
    },
  };
}

export interface FileOutboxCursorOptions {
  dir: string;
  /** 游标文件名（默认 `outbox-cursor.json`）。 */
  fileName?: string;
}

export function createFileOutboxCursor(options: FileOutboxCursorOptions): OutboxCursorStore {
  if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
    throw new OutboxError('createFileOutboxCursor 需要 dir（数据目录）');
  }
  const file = path.join(options.dir, options.fileName ?? 'outbox-cursor.json');
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { cursor?: unknown };
        const cursor = Number(parsed?.cursor ?? 0);
        checkSeq(cursor);
        return cursor;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        if (err instanceof SyntaxError) throw new OutboxError(`游标文件 ${file} 内容损坏：${err.message}`);
        throw err;
      }
    },
    async write(seq) {
      checkSeq(seq);
      fs.mkdirSync(options.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify({ cursor: seq })}\n`);
      await fsp.rename(tmp, file); // 原子替换：不会读到写了一半的游标
    },
  };
}

/** 与迁移/仓储共用的 SQL 驱动形状。 */
export interface OutboxSqlRunner {
  all(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: readonly unknown[]): Promise<number>;
  /** 可选：真事务（提供给游标更新的原子性） */
  transaction?<R>(fn: (scoped: OutboxSqlRunner) => Promise<R>): Promise<R>;
}

export interface SqlOutboxCursorOptions {
  runner: OutboxSqlRunner;
  /** 游标表名（默认 `outbox_cursor`；由 `ensure()` 建表）。 */
  table?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function createSqlOutboxCursor(options: SqlOutboxCursorOptions): OutboxCursorStore {
  const table = options?.table ?? 'outbox_cursor';
  if (!options?.runner || typeof options.runner.all !== 'function' || typeof options.runner.run !== 'function') {
    throw new OutboxError('createSqlOutboxCursor 需要 runner（提供 all / run）');
  }
  if (!IDENTIFIER.test(table)) throw new OutboxError(`表名必须是简单标识符：${table}`);
  const { runner } = options;
  return {
    async ensure() {
      await runner.run(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL)`, []);
    },
    async read() {
      const rows = await runner.all(`SELECT cursor FROM ${table} WHERE id = 1`, []);
      const cursor = Number(rows[0]?.cursor ?? 0);
      checkSeq(cursor);
      return cursor;
    },
    async write(seq) {
      checkSeq(seq);
      // DELETE + INSERT：三种方言都认（不用 ON CONFLICT / ON DUPLICATE KEY）。
      // 两条语句必须在同一事务里，否则崩溃窗口会留下"已删除、未插入" → 游标归零、整段重投。
      const write = async (scoped: OutboxSqlRunner): Promise<void> => {
        await scoped.run(`DELETE FROM ${table} WHERE id = 1`, []);
        await scoped.run(`INSERT INTO ${table} (id, cursor) VALUES (1, ?)`, [seq]);
      };
      if (typeof runner.transaction === 'function') await runner.transaction(write);
      else await write(runner);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 日志读取                                                                    */
/* -------------------------------------------------------------------------- */

export interface OutboxLogReaderOptions {
  /** 读原始记录：把内核的 `store.loadEvents(actorPath)` 包一层即可。 */
  loadRecords(): Promise<readonly unknown[]>;
  /** 数据层的事件注册表（补号 + 升级 + 连续性检查）。 */
  registry: EventRegistry;
  /** 没有 `eventId` 的老事件用 `"<actorPath>#<seq>"` 当投递 id（便于去重与诊断）。 */
  actorPath?: string;
}

export function createOutboxLogReader(options: OutboxLogReaderOptions): OutboxLogReader {
  if (!options || typeof options.loadRecords !== 'function') {
    throw new OutboxError('createOutboxLogReader 需要 loadRecords()');
  }
  if (!options.registry || typeof options.registry.readEntries !== 'function') {
    throw new OutboxError('createOutboxLogReader 需要 registry（createEventRegistry 的产物）');
  }
  const prefix = options.actorPath ?? 'actor';
  return {
    async read(fromSeq, limit) {
      const raws = await options.loadRecords();
      const { entries } = options.registry.readEntries(raws, { fromSeq: fromSeq + 1 });
      return entries.slice(0, limit).map((entry) => ({
        seq: entry.seq,
        eventId: entry.eventId,
        event: entry.event,
        type: entry.type,
        deliveryId: entry.eventId ?? `${prefix}#${entry.seq}`,
      }));
    },
  };
}
