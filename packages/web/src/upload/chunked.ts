import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// 契约套件是**测试工具**：`node:test` 必须等到真正调用 run*Contract 时才加载，
// 否则生产入口 import 一个常量就会把测试运行器带进进程/打包产物。
const require = createRequire(import.meta.url);
let nodeTest: typeof import('node:test') | null = null;
const test: typeof import('node:test').test = ((...args: unknown[]) => {
  nodeTest ??= require('node:test') as typeof import('node:test');
  return (nodeTest.test as unknown as (...values: unknown[]) => unknown)(...args);
}) as unknown as typeof import('node:test').test;
import assert from 'node:assert';

import { DbConfigError } from '@actor/resource';

import { HttpError } from '../context.ts';
import type { UploadedFile } from './storage.ts';

/**
 * **分片上传 + 断点续传**：会话与分片数据由 `ChunkSessionStore` 管；两个内置实现
 * （内存 / 本地磁盘），磁盘实现**进程重启后仍能续传**（这是"断点续传"的关键）。
 *
 * 协议（后端侧语义）：
 *   1. `init`：客户端声明 `filename/size/chunkSize/sha256(整文件)` → 拿到 `uploadId` + 已收分片；
 *   2. 客户端并发 `PUT` 各分片（带 `x-chunk-sha256` 时**逐片校验**；同一分片可**幂等重传**）；
 *   3. `GET` 状态：已收分片 / 缺失分片 / 过期时间（断点续传靠它先查再补缺口）；
 *   4. `complete`：按序合并 → 交给 `UploadStorage.put`（内部算 sha256）→ 与客户端声明的**整文件 sha256** 比对，
 *      不符则**拒绝并报出期望/实际**，同时作废会话（分片数据不可信）。
 */
export interface ChunkSession {
  readonly uploadId: string;
  readonly filename: string;
  /** 客户端声明的 MIME（可选；分片协议本身不携带，允许白名单据此校验）。 */
  readonly mimeType?: string;
  readonly size: number;
  readonly chunkSize: number;
  /** 客户端声明的整文件 sha256（十六进制小写）。 */
  readonly sha256: string;
  /** 已收到的分片下标（升序）。 */
  readonly received: readonly number[];
  readonly createdAt: string;
  /** 活动滑动后的过期时间（最后一次活动 + ttlMs，且不超过 hardExpiresAt）。 */
  readonly expiresAt: string;
  /** **绝对**上限：滑动也不能突破它（否则一个一直 ping 的会话永不失效）。 */
  readonly hardExpiresAt: string;
  /**
   * 上传者的 subject（**有鉴权时才有**）。
   *
   * 语义：`undefined` = 匿名上传 —— 一律放行（很多场景没有鉴权，不能强制）；
   * 有值时 = 该会话只属于这个 subject，别人拿到 uploadId 也读不到/改不了（返回 404，不暴露存在性）。
   */
  readonly subject?: string;
  /** 完成后的结果。保留一段宽限期，于是 `complete` **幂等**、响应丢了也能再查回来。 */
  readonly completed?: { readonly file: UploadedFile; readonly at: string };
}

export interface ChunkSessionStore {
  /** `subject` 有值表示"这个会话有主"（见 `ChunkSession.subject`）。 */
  create(input: { filename: string; size: number; chunkSize: number; sha256: string; subject?: string; mimeType?: string }): Promise<ChunkSession>;
  get(uploadId: string): Promise<ChunkSession | null>;
  /** 写入/覆盖一个分片；给 `expectedSha256` 时逐片校验（不符 → 400 且不记录）。 */
  putChunk(
    uploadId: string,
    index: number,
    source: AsyncIterable<Uint8Array>,
    expectedSha256?: string,
  ): Promise<{ session: ChunkSession; chunkSha256: string }>;
  /** 按序读出所有分片（合并用）。 */
  readAll(uploadId: string): AsyncIterable<Uint8Array>;
  remove(uploadId: string): Promise<boolean>;
  /** 标记完成（保留会话与结果、**释放分片数据**）→ `complete` 因此可幂等重试。 */
  markCompleted(uploadId: string, file: UploadedFile): Promise<ChunkSession>;
  /** 清理过期会话（及其分片），返回被清掉的 uploadId。 */
  purgeExpired(now?: number): Promise<string[]>;
  /** 当前活跃会话数（用于 `maxActiveSessions` 限流）；不支持就别实现（插件会在启动期拒绝）。 */
  countActive?(): Promise<number>;
  /** 总分片数。 */
  totalChunks(session: ChunkSession): number;
  /** 缺失分片下标（升序）。 */
  missingChunks(session: ChunkSession): number[];
}

export interface ChunkStoreOptions {
  /** 会话有效期（默认 24h；活动时滑动，见 `refreshTtlOnActivity`）。 */
  ttlMs?: number;
  /** 绝对上限（默认 7 天）：滑动也不能突破。 */
  hardTtlMs?: number;
  /** 每次写入分片就续期（默认 true）—— 大文件传一整天不该中途失效。 */
  refreshTtlOnActivity?: boolean;
  /** 完成后再保留多久（默认 15 分钟）：让 `complete` 幂等、也能把结果查回来。 */
  completedGraceMs?: number;
  /** 单分片上限（默认 64MiB）：**这是内存安全的边界**，客户端声明超过就拒。 */
  maxChunkSize?: number;
  /** 整份上传大小上限（默认 5GiB）：防止声明一个 10TB 的会话慢慢填满磁盘。 */
  maxUploadSize?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_GRACE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;

/** 上限（含默认值），init 与写入两侧都用它。 */
interface Limits {
  ttlMs: number;
  hardTtlMs: number;
  refreshTtlOnActivity: boolean;
  completedGraceMs: number;
  maxChunkSize: number;
  maxUploadSize: number;
}

function limitsOf(options: ChunkStoreOptions): Limits {
  return {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    hardTtlMs: options.hardTtlMs ?? DEFAULT_HARD_TTL_MS,
    refreshTtlOnActivity: options.refreshTtlOnActivity !== false,
    completedGraceMs: options.completedGraceMs ?? DEFAULT_COMPLETED_GRACE_MS,
    maxChunkSize: options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE,
    maxUploadSize: options.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE,
  };
}

/** 活动续期（滑动 TTL），但永远不越过绝对上限。 */
function slide(session: ChunkSession, limits: Limits, now = Date.now()): ChunkSession {
  if (!limits.refreshTtlOnActivity) return session;
  const next = Math.min(now + limits.ttlMs, Date.parse(session.hardExpiresAt));
  if (next <= Date.parse(session.expiresAt)) return session;
  return { ...session, expiresAt: new Date(next).toISOString() };
}

/** 过期判定：滑动窗口或绝对上限任一到期即失效。 */
function expired(session: ChunkSession, now = Date.now()): boolean {
  return Date.parse(session.expiresAt) < now || Date.parse(session.hardExpiresAt) < now;
}

function validateInit(
  input: { filename: string; size: number; chunkSize: number; sha256: string; subject?: string; mimeType?: string },
  limits: Limits,
): ChunkSession {
  if (typeof input.filename !== 'string' || input.filename.trim() === '') throw new HttpError(400, 'init: filename 必填');
  if (!Number.isInteger(input.size) || input.size < 0) throw new HttpError(400, 'init: size 必须是非负整数');
  if (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0) throw new HttpError(400, 'init: chunkSize 必须是正整数');
  if (input.chunkSize < 5 * 1024 * 1024) {
    // 太小的分片只会把请求数搞爆；5MiB 是常见下限（S3 是 5MiB）
    throw new HttpError(400, `init: chunkSize 太小（最小 ${5 * 1024 * 1024} 字节）`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new HttpError(400, 'init: sha256 必须是 64 位十六进制（整文件 sha256）');
  // 上限必须在 init 就挡住：不然客户端可以声明一个巨大的会话慢慢填满磁盘
  if (input.chunkSize > limits.maxChunkSize) {
    throw new HttpError(413, `init: chunkSize 超过上限（maxChunkSize=${limits.maxChunkSize}）`);
  }
  if (input.size > limits.maxUploadSize) {
    throw new HttpError(413, `init: 上传大小超过上限（maxUploadSize=${limits.maxUploadSize}）`);
  }
  const now = Date.now();
  return {
    uploadId: randomUUID(),
    filename: input.filename,
    size: input.size,
    chunkSize: input.chunkSize,
    sha256: input.sha256,
    received: [],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + limits.ttlMs, now + limits.hardTtlMs)).toISOString(),
    hardExpiresAt: new Date(now + limits.hardTtlMs).toISOString(),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
  };
}

function expectedChunkSize(session: ChunkSession, index: number): number {
  const total = Math.max(1, Math.ceil(session.size / session.chunkSize));
  // NaN 与任何数比较都是 false，会绕过下面的范围检查并留下永不回收的 .NaN.part
  if (!Number.isInteger(index)) throw new HttpError(400, `分片下标必须是整数（拿到 ${String(index)}）`);
  if (index < 0 || index >= total) throw new HttpError(400, `分片下标越界：${index}（共 ${total} 片）`);
  if (index === total - 1) return session.size - index * session.chunkSize;
  return session.chunkSize;
}

const totalChunks = (session: ChunkSession): number => Math.max(1, Math.ceil(session.size / session.chunkSize));
const missingChunks = (session: ChunkSession): number[] => {
  const have = new Set(session.received);
  const out: number[] = [];
  for (let index = 0; index < totalChunks(session); index += 1) if (!have.has(index)) out.push(index);
  return out;
};

/** 带上限的读取：超过就立刻 413（不让它先把内存吃光再报错）。 */
async function drain(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new HttpError(413, `分片超过上限（maxChunkSize=${maxBytes}）`);
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

/** 校验分片内容（大小 + 可选 sha256），返回 sha256。 */
function checkChunk(index: number, bytes: Buffer, expectedSize: number, expectedSha256?: string): string {
  if (bytes.byteLength !== expectedSize) {
    throw new HttpError(400, `分片 ${index} 大小不符：期望 ${expectedSize}，实际 ${bytes.byteLength}`);
  }
  const chunkSha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== chunkSha256) {
    throw new HttpError(400, `分片 ${index} 的 sha256 不符`, { expected: expectedSha256.toLowerCase(), actual: chunkSha256 });
  }
  return chunkSha256;
}

/** 内存实现（单节点/测试）。⚠️ 多节点下语义不成立：分片只在收到它的那个进程里。 */
export function memoryChunkStore(options: ChunkStoreOptions = {}): ChunkSessionStore {
  const limits = limitsOf(options);
  const sessions = new Map<string, ChunkSession>();
  const chunks = new Map<string, Map<number, Buffer>>();

  const get = async (uploadId: string): Promise<ChunkSession | null> => {
    const session = sessions.get(uploadId);
    if (session === undefined) return null;
    if (expired(session)) {
      sessions.delete(uploadId);
      chunks.delete(uploadId);
      return null;
    }
    return session;
  };

  return {
    totalChunks,
    missingChunks,
    async create(input) {
      const session = validateInit(input, limits);
      sessions.set(session.uploadId, session);
      chunks.set(session.uploadId, new Map());
      return session;
    },
    get,
    async putChunk(uploadId, index, source, expectedSha256) {
      const session = await get(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const expectedSize = expectedChunkSize(session, index);
      const bytes = await drain(source, limits.maxChunkSize);
      const chunkSha256 = checkChunk(index, bytes, expectedSize, expectedSha256);
      chunks.get(uploadId)?.set(index, bytes);
      const received = [...new Set([...session.received, index])].sort((a, b) => a - b);
      const updated = slide({ ...session, received }, limits);
      sessions.set(uploadId, updated);
      return { session: updated, chunkSha256 };
    },
    async *readAll(uploadId) {
      const session = await get(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const missing = missingChunks(session);
      if (missing.length > 0) throw new HttpError(400, `还有分片没收到：${missing.join(',')}`);
      const map = chunks.get(uploadId) ?? new Map();
      for (let index = 0; index < totalChunks(session); index += 1) yield map.get(index) as Buffer;
    },
    async remove(uploadId) {
      chunks.delete(uploadId);
      return sessions.delete(uploadId);
    },
    async markCompleted(uploadId, file) {
      const session = await get(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const now = Date.now();
      const next: ChunkSession = {
        ...session,
        completed: { file, at: new Date(now).toISOString() },
        // 分片数据已释放 → 记账也不能再说"收过"（不声称不存在的数据）
        received: [],
        expiresAt: new Date(Math.min(now + limits.completedGraceMs, Date.parse(session.hardExpiresAt))).toISOString(),
      };
      sessions.set(uploadId, next);
      chunks.delete(uploadId); // 完成即释放分片数据（结果留在会话里，于是 complete 可幂等重试）
      return next;
    },
    async countActive() {
      let count = 0;
      for (const session of sessions.values()) if (!expired(session)) count += 1;
      return count;
    },
    async purgeExpired(now = Date.now()) {
      const removed: string[] = [];
      for (const [uploadId, session] of sessions) {
        if (expired(session, now)) {
          sessions.delete(uploadId);
          chunks.delete(uploadId);
          removed.push(uploadId);
        }
      }
      return removed;
    },
  };
}

/** 本地磁盘实现：会话元数据 + 分片都落盘 → **进程重启后仍可续传**。 */
export function diskChunkStore(options: { dir: string } & ChunkStoreOptions): ChunkSessionStore {
  const limits = limitsOf(options);
  const root = path.resolve(options.dir);
  const safeId = (uploadId: string): string => {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new HttpError(400, `uploadId 不合法：${uploadId}`);
    return uploadId;
  };
  // 按前两位分桶：5MiB 分片 × 100GB = 2 万个文件，全堆一个目录会拖垮文件系统
  const bucketOf = (uploadId: string): string => path.join(root, safeId(uploadId).slice(0, 2));
  const sessionPath = (uploadId: string): string => path.join(bucketOf(uploadId), `${safeId(uploadId)}.session.json`);
  const chunkPath = (uploadId: string, index: number): string => path.join(bucketOf(uploadId), `${safeId(uploadId)}.${index}.part`);

  const readSession = async (uploadId: string): Promise<ChunkSession | null> => {
    const file = sessionPath(uploadId); // 先校验 id（抛出的 HttpError 不能被下面的 catch 吞掉）
    try {
      const session = JSON.parse(await readFile(file, 'utf8')) as ChunkSession;
      return expired(session) ? null : session;
    } catch {
      return null;
    }
  };
  const writeSession = async (session: ChunkSession): Promise<void> => {
    const file = sessionPath(session.uploadId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(session), 'utf8');
  };
  const dropChunks = async (session: ChunkSession): Promise<void> => {
    for (let index = 0; index < totalChunks(session); index += 1) {
      await rm(chunkPath(session.uploadId, index), { force: true });
    }
  };
  const listSessions = async (): Promise<string[]> => {
    let buckets: string[] = [];
    try {
      buckets = await readdir(root);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const bucket of buckets) {
      let names: string[] = [];
      try {
        names = await readdir(path.join(root, bucket));
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.session.json')) ids.push(name.slice(0, -'.session.json'.length));
      }
    }
    return ids;
  };

  const store: ChunkSessionStore = {
    totalChunks,
    missingChunks,
    async create(input) {
      const session = validateInit(input, limits);
      await writeSession(session);
      return session;
    },
    get: readSession,
    async putChunk(uploadId, index, source, expectedSha256) {
      const session = await readSession(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const expectedSize = expectedChunkSize(session, index);
      const target = chunkPath(uploadId, index);
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.part`;
      // **流式写入 + 边写边算 sha256**（不把整片 concat 进内存；分片再大也只看上限）
      const hash = createHash('sha256');
      let total = 0;
      const sink = createWriteStream(temp);
      try {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > limits.maxChunkSize) throw new HttpError(413, `分片超过上限（maxChunkSize=${limits.maxChunkSize}）`);
          hash.update(bytes);
          if (!sink.write(bytes)) await once(sink, 'drain');
        }
        await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err == null ? resolve() : reject(err))));
      } catch (err) {
        sink.destroy();
        await rm(temp, { force: true });
        throw err;
      }
      const chunkSha256 = hash.digest('hex');
      if (total !== expectedSize) {
        await rm(temp, { force: true });
        throw new HttpError(400, `分片 ${index} 大小不符：期望 ${expectedSize}，实际 ${total}`);
      }
      if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== chunkSha256) {
        await rm(temp, { force: true });
        throw new HttpError(400, `分片 ${index} 的 sha256 不符`, { expected: expectedSha256.toLowerCase(), actual: chunkSha256 });
      }
      await rename(temp, target); // 校验通过才就位（半截数据不会被当成收过的分片）
      const received = [...new Set([...session.received, index])].sort((a, b) => a - b);
      const updated = slide({ ...session, received }, limits);
      await writeSession(updated);
      return { session: updated, chunkSha256 };
    },
    async *readAll(uploadId) {
      const session = await readSession(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const missing = missingChunks(session);
      if (missing.length > 0) throw new HttpError(400, `还有分片没收到：${missing.join(',')}`);
      for (let index = 0; index < totalChunks(session); index += 1) {
        // 用流按 1MiB 分片读：单个分片再大也不会整片进内存
        for await (const slice of createReadStream(chunkPath(uploadId, index), { highWaterMark: 1024 * 1024 })) {
          yield slice as Uint8Array;
        }
      }
    },
    async remove(uploadId) {
      const session = await readSession(uploadId);
      if (session === null) return false;
      await dropChunks(session);
      await rm(sessionPath(uploadId), { force: true });
      return true;
    },
    async markCompleted(uploadId, file) {
      const session = await readSession(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const now = Date.now();
      const next: ChunkSession = {
        ...session,
        completed: { file, at: new Date(now).toISOString() },
        received: [],
        expiresAt: new Date(Math.min(now + limits.completedGraceMs, Date.parse(session.hardExpiresAt))).toISOString(),
      };
      await writeSession(next);
      await dropChunks(session); // 分片数据释放；结果留在会话里（complete 可幂等重试 / 查询）
      return next;
    },
    async countActive() {
      let count = 0;
      for (const uploadId of await listSessions()) {
        if ((await readSession(uploadId)) !== null) count += 1;
      }
      return count;
    },
    async purgeExpired(now = Date.now()) {
      const removed: string[] = [];
      for (const uploadId of await listSessions()) {
        const file = sessionPath(uploadId);
        let session: ChunkSession;
        try {
          session = JSON.parse(await readFile(file, 'utf8')) as ChunkSession;
        } catch {
          await rm(file, { force: true });
          removed.push(uploadId);
          continue;
        }
        if (expired(session, now)) {
          await dropChunks(session);
          await rm(file, { force: true });
          removed.push(uploadId);
        }
      }
      return removed;
    },
  };
  return store;
}

/** 契约套件：任何 `ChunkSessionStore` 实现都应通过（含"重启后仍能续传"的验证钩子）。 */
export function runChunkStoreContract(options: {
  name: string;
  make: () => ChunkSessionStore | Promise<ChunkSessionStore>;
  /** 造一个"同一份数据的新实例"（用于验证磁盘实现重启后可续传；内存实现返回新空实例即可）。 */
  reopen?: () => ChunkSessionStore | Promise<ChunkSessionStore>;
}): void {
  const CHUNK = 5 * 1024 * 1024;
  const bytes = (size: number, fill: number): Buffer => Buffer.alloc(size, fill);
  const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
  const asStream = (data: Uint8Array): AsyncIterable<Uint8Array> => (async function* () { yield data; })();

  test(`[chunk-store:${options.name}] init 校验 + 状态（已收/缺失/过期时间）`, async () => {
    const store = await options.make();
    const payload = Buffer.concat([bytes(CHUNK, 1), bytes(10, 2)]);
    const session = await store.create({ filename: 'big.bin', size: payload.length, chunkSize: CHUNK, sha256: sha(payload) });
    assert.strictEqual(store.totalChunks(session), 2);
    assert.deepStrictEqual(store.missingChunks(session), [0, 1]);
    assert.ok(Date.parse(session.expiresAt) > Date.now());
    await assert.rejects(() => store.create({ filename: 'x', size: 10, chunkSize: 1024, sha256: sha(payload) }), /chunkSize 太小/);
    await assert.rejects(() => store.create({ filename: 'x', size: 10, chunkSize: CHUNK, sha256: 'nope' }), /64 位十六进制/);
  });

  test(`[chunk-store:${options.name}] 分片写入：逐片 sha256 校验、大小校验、幂等重传`, async () => {
    const store = await options.make();
    const first = bytes(CHUNK, 7);
    const second = bytes(3, 8);
    const payload = Buffer.concat([first, second]);
    const session = await store.create({ filename: 'big.bin', size: payload.length, chunkSize: CHUNK, sha256: sha(payload) });

    const ok = await store.putChunk(session.uploadId, 0, asStream(first), sha(first));
    assert.deepStrictEqual(ok.session.received, [0]);
    assert.strictEqual(ok.chunkSha256, sha(first));

    // 幂等重传同一片：不报错、状态不变
    const again = await store.putChunk(session.uploadId, 0, asStream(first), sha(first));
    assert.deepStrictEqual(again.session.received, [0]);

    // 分片 sha256 不符：拒绝，且**不记录**
    await assert.rejects(
      () => store.putChunk(session.uploadId, 1, asStream(second), sha(first)),
      /sha256 不符/,
    );
    assert.deepStrictEqual((await store.get(session.uploadId))?.received, [0]);

    // 大小不符：拒绝
    await assert.rejects(() => store.putChunk(session.uploadId, 1, asStream(bytes(2, 9))), /大小不符/);

    // 越界：拒绝
    await assert.rejects(() => store.putChunk(session.uploadId, 5, asStream(second)), /越界/);

    // 补齐后 readAll 能按序拼回
    await store.putChunk(session.uploadId, 1, asStream(second), sha(second));
    const parts: Buffer[] = [];
    for await (const chunk of store.readAll(session.uploadId)) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    assert.deepStrictEqual(Buffer.concat(parts), payload);
  });

  test(`[chunk-store:${options.name}] 缺片时 readAll 明确拒绝；remove 后可重来`, async () => {
    const store = await options.make();
    const payload = Buffer.concat([bytes(CHUNK, 1), bytes(5, 2)]);
    const session = await store.create({ filename: 'b', size: payload.length, chunkSize: CHUNK, sha256: sha(payload) });
    await store.putChunk(session.uploadId, 0, asStream(payload.subarray(0, CHUNK)));
    const iterator = store.readAll(session.uploadId)[Symbol.asyncIterator]();
    await assert.rejects(() => iterator.next(), /还有分片没收到/);
    assert.strictEqual(await store.remove(session.uploadId), true);
    assert.strictEqual(await store.get(session.uploadId), null);
    assert.strictEqual(await store.remove(session.uploadId), false);
  });

  if (options.reopen !== undefined) {
    test(`[chunk-store:${options.name}] **重启后仍能续传**（换一个实例看得到已收分片）`, async () => {
      const first = bytes(CHUNK, 3);
      const payload = Buffer.concat([first, bytes(4, 4)]);
      const store = await options.make();
      const session = await store.create({ filename: 'resume.bin', size: payload.length, chunkSize: CHUNK, sha256: sha(payload) });
      await store.putChunk(session.uploadId, 0, asStream(first), sha(first));

      const reopened = await options.reopen?.();
      const state = await (reopened as ChunkSessionStore).get(session.uploadId);
      assert.ok(state !== null, '重启后必须还能拿到会话');
      assert.deepStrictEqual(state?.received, [0], '重启后必须知道已经收过第 0 片');
      assert.deepStrictEqual((reopened as ChunkSessionStore).missingChunks(state as ChunkSession), [1], '缺哪片也要算得出来');
    });
  }

  test(`[chunk-store:${options.name}] 上限在 init 就挡住（chunkSize 与上传总大小）`, async () => {
    const store = await options.make();
    await assert.rejects(
      () => store.create({ filename: 'a', size: 10, chunkSize: 128 * 1024 * 1024, sha256: 'a'.repeat(64) }),
      /chunkSize 超过上限/,
    );
    await assert.rejects(
      () => store.create({ filename: 'a', size: 6 * 1024 * 1024 * 1024, chunkSize: CHUNK, sha256: 'a'.repeat(64) }),
      /上传大小超过上限/,
    );
  });

  test(`[chunk-store:${options.name}] 活动会滑动 TTL，但绝不越过**绝对上限**`, async () => {
    const store = await options.make();
    const first = await store.create({ filename: 'a', size: CHUNK, chunkSize: CHUNK, sha256: 'a'.repeat(64) });
    assert.ok(Date.parse(first.hardExpiresAt) >= Date.parse(first.expiresAt), '要有绝对上限');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const { session } = await store.putChunk(first.uploadId, 0, asStream(bytes(CHUNK, 1)));
    assert.ok(Date.parse(session.expiresAt) > Date.parse(first.expiresAt), '传了分片就应当续期');
    assert.ok(Date.parse(session.expiresAt) <= Date.parse(session.hardExpiresAt), '续期也不能越过绝对上限');
  });

  test(`[chunk-store:${options.name}] markCompleted：结果可查、不再声称"收过"、分片已释放`, async () => {
    const store = await options.make();
    const data = bytes(11, 9);
    const before = (await store.countActive?.()) ?? 0; // 必须在 create **之前**取快照（套件共用一个目录）
    const session = await store.create({ filename: 'c.bin', size: data.length, chunkSize: CHUNK, sha256: sha(data) });
    await store.putChunk(session.uploadId, 0, asStream(data), sha(data));
    assert.strictEqual((await store.countActive?.()) ?? 0, before + 1, 'countActive 要能数到新会话（套件里共享目录，所以看差值）');

    const file = {
      key: 'k1',
      name: 'c.bin',
      mimeType: 'application/octet-stream',
      size: data.length,
      checksum: sha(data),
      uploadedAt: new Date().toISOString(),
    };
    const done = await store.markCompleted(session.uploadId, file);
    assert.deepStrictEqual(done.completed?.file, file, '完成结果要留在会话里（complete 才能幂等重试）');
    assert.deepStrictEqual(done.received, [], '分片数据已释放 → 不能再声称收过');
    const iterator = store.readAll(session.uploadId)[Symbol.asyncIterator]();
    await assert.rejects(() => iterator.next(), /还有分片没收到/);
    assert.deepStrictEqual((await store.get(session.uploadId))?.completed?.file, file);
    assert.strictEqual(await store.remove(session.uploadId), true);
  });

  test(`[chunk-store:${options.name}] purgeExpired 真的删掉会话与分片，并返回被清的 id`, async () => {
    const store = await options.make();
    const data = bytes(7, 3);
    const session = await store.create({ filename: 'p.bin', size: data.length, chunkSize: CHUNK, sha256: sha(data) });
    await store.putChunk(session.uploadId, 0, asStream(data), sha(data));
    // 传入"足够远的未来"→ 跨过绝对上限（默认 7 天）才会被判过期（60s 这种是过不了 hardTtl 的）
    const removed = await store.purgeExpired?.(Date.now() + 30 * 24 * 60 * 60 * 1000);
    assert.ok(removed?.includes(session.uploadId) === true, `要返回被清的 id：${JSON.stringify(removed)}`);
    assert.strictEqual(await store.get(session.uploadId), null);
    await assert.rejects(() => store.putChunk(session.uploadId, 0, asStream(data)), /不存在或已过期/);
  });

  test(`[chunk-store:${options.name}] 未知 uploadId 是 404（不是 500）；不安全的 id 直接拒`, async () => {
    const store = await options.make();
    await assert.rejects(() => store.putChunk('00000000-0000-4000-8000-000000000000', 0, asStream(bytes(1, 1))), /不存在或已过期/);
    if (options.name.includes('disk')) {
      await assert.rejects(() => store.get('../../etc/passwd'), /uploadId 不合法/);
    }
  });
}

void DbConfigError;
