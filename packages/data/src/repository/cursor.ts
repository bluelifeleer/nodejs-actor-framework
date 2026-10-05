/**
 * 游标编码与比较（M3 第 3 步）。
 *
 * **游标里必须带 tie-breaker**：`{ 排序键值, id }`。只放排序键值的话，排序键相同的多行在翻页
 * 边界会被漏掉或重复——而那正是"用游标替代 offset"要解决的那类问题
 * （docs/design/m3-data-evolution.md §7.2）。
 *
 * 游标是**不透明**的：只保证"同一适配器、同一排序"下可回放；用户不得依赖其内部结构。
 */

import { RepositoryQueryError } from './types.ts';

export interface CursorPayload {
  /** 上一次返回的最后一条的排序键值。 */
  key: string | number | null;
  /** 上一次返回的最后一条的 id（tie-breaker）。 */
  id: string | number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ k: payload.key, i: payload.id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new RepositoryQueryError('cursor 无法解析（不是本适配器产出的？游标是不透明的，请原样回传）');
  }
  if (parsed === null || typeof parsed !== 'object' || !('k' in parsed) || !('i' in parsed)) {
    throw new RepositoryQueryError('cursor 结构非法（缺少排序键或 id）');
  }
  const { k, i } = parsed as { k: unknown; i: unknown };
  if (k !== null && typeof k !== 'string' && typeof k !== 'number') {
    throw new RepositoryQueryError('cursor 里的排序键值必须是 string / number / null');
  }
  if (typeof i !== 'string' && typeof i !== 'number') {
    throw new RepositoryQueryError('cursor 里的 id 必须是 string 或 number');
  }
  return { key: k, id: i };
}

/**
 * 比较两个排序键值。只支持 `string` / `number`（+ `null` 排在最后）：
 * 混合类型会抛错而不是"随便排一个"——那种 bug 在生产里极难定位。
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // null/undefined 统一排最后
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  throw new RepositoryQueryError(
    `排序键的值必须是可比较的 string 或 number（遇到 ${typeof a} 与 ${typeof b}）`,
  );
}

/** 排序：主键 + id tie-breaker；`direction` 只影响顺序，不影响"是否同一条"。 */
export function compareRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBy: string,
  idField: string,
  direction: 'asc' | 'desc',
): number {
  const primary = compareValues(a[orderBy], b[orderBy]);
  const cmp = primary !== 0 ? primary : compareValues(a[idField], b[idField]);
  return direction === 'desc' ? -cmp : cmp;
}

/** 一行是否严格排在游标位置**之后**（翻页的唯一判据，避免依赖数组下标）。 */
export function isAfterCursor(
  row: Record<string, unknown>,
  cursor: CursorPayload,
  orderBy: string,
  idField: string,
  direction: 'asc' | 'desc',
): boolean {
  const primary = compareValues(row[orderBy], cursor.key);
  if (primary !== 0) return direction === 'desc' ? primary < 0 : primary > 0;
  const tie = compareValues(row[idField], cursor.id);
  return direction === 'desc' ? tie < 0 : tie > 0;
}

/** 与游标位置是否**相等**（同一行），用于"游标指向的那条正好也满足过滤"这类边界判断。 */
export function isAtCursor(
  row: Record<string, unknown>,
  cursor: CursorPayload,
  orderBy: string,
  idField: string,
): boolean {
  return compareValues(row[orderBy], cursor.key) === 0 && compareValues(row[idField], cursor.id) === 0;
}

/** 查询参数校验（limit 范围、where 值类型）。适配器共用，保证三个后端语义一致。 */
export function normalizeQuery(
  query: Record<string, unknown> | undefined,
  defaults: { idField: string },
): {
  where: Record<string, string | number | boolean | null>;
  orderBy: string;
  direction: 'asc' | 'desc';
  limit: number;
  cursor: string | null;
} {
  const raw = query ?? {};
  const rawWhere = (raw.where ?? {}) as Record<string, unknown>;
  if (rawWhere === null || typeof rawWhere !== 'object' || Array.isArray(rawWhere)) {
    throw new RepositoryQueryError('where 必须是"字段 → 原始值"的对象');
  }
  const where: Record<string, string | number | boolean | null> = {};
  for (const [field, value] of Object.entries(rawWhere)) {
    if (value === undefined) {
      throw new RepositoryQueryError(`where.${field} 是 undefined——等值过滤不接受 undefined（写 null 表示"等于 null"）`);
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new RepositoryQueryError(`where.${field} 只支持原始值（string / number / boolean / null），不支持复杂查询`);
    }
    where[field] = value;
  }

  const orderBy = raw.orderBy === undefined ? defaults.idField : raw.orderBy;
  if (typeof orderBy !== 'string' || orderBy.length === 0) {
    throw new RepositoryQueryError('orderBy 必须是非空字符串');
  }
  const direction = raw.direction === undefined ? 'asc' : raw.direction;
  if (direction !== 'asc' && direction !== 'desc') {
    throw new RepositoryQueryError("direction 只能是 'asc' 或 'desc'");
  }
  const normalizedDirection: 'asc' | 'desc' = direction;

  const limit = raw.limit === undefined ? 50 : raw.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RepositoryQueryError(`limit 必须是 1..1000 的整数（当前 ${String(raw.limit)}）`);
  }

  const cursor = raw.cursor === undefined || raw.cursor === null ? null : raw.cursor;
  if (cursor !== null && typeof cursor !== 'string') throw new RepositoryQueryError('cursor 必须是字符串');

  return { where, orderBy, direction: normalizedDirection, limit, cursor };
}
