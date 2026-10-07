import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';

import { DbConfigError } from '@actor/resource';

import { HttpError } from '../context.ts';

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
  readonly size: number;
  readonly chunkSize: number;
  /** 客户端声明的整文件 sha256（十六进制小写）。 */
  readonly sha256: string;
  /** 已收到的分片下标（升序）。 */
  readonly received: readonly number[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ChunkSessionStore {
  create(input: { filename: string; size: number; chunkSize: number; sha256: string }): Promise<ChunkSession>;
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
  purgeExpired(now?: number): Promise<string[]>;
  /** 总分片数。 */
  totalChunks(session: ChunkSession): number;
  /** 缺失分片下标（升序）。 */
  missingChunks(session: ChunkSession): number[];
}

export interface ChunkStoreOptions {
  /** 会话有效期（默认 24h）。 */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function validateInit(input: { filename: string; size: number; chunkSize: number; sha256: string }, ttlMs: number): ChunkSession {
  if (typeof input.filename !== 'string' || input.filename.trim() === '') throw new HttpError(400, 'init: filename 必填');
  if (!Number.isInteger(input.size) || input.size < 0) throw new HttpError(400, 'init: size 必须是非负整数');
  if (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0) throw new HttpError(400, 'init: chunkSize 必须是正整数');
  if (input.chunkSize < 5 * 1024 * 1024) {
    // 太小的分片只会把请求数搞爆；5MiB 是常见下限（S3 是 5MiB）
    throw new HttpError(400, `init: chunkSize 太小（最小 ${5 * 1024 * 1024} 字节）`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new HttpError(400, 'init: sha256 必须是 64 位十六进制（整文件 sha256）');
  const now = Date.now();
  return {
    uploadId: randomUUID(),
    filename: input.filename,
    size: input.size,
    chunkSize: input.chunkSize,
    sha256: input.sha256,
    received: [],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function expectedChunkSize(session: ChunkSession, index: number): number {
  const total = Math.max(1, Math.ceil(session.size / session.chunkSize));
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

async function drain(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** 内存实现（单节点/测试）。⚠️ 多节点下语义不成立：分片只在收到它的那个进程里。 */
export function memoryChunkStore(options: ChunkStoreOptions = {}): ChunkSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const sessions = new Map<string, ChunkSession>();
  const chunks = new Map<string, Map<number, Buffer>>();

  const store: ChunkSessionStore = {
    totalChunks,
    missingChunks,
    async create(input) {
      const session = validateInit(input, ttlMs);
      sessions.set(session.uploadId, session);
      chunks.set(session.uploadId, new Map());
      return session;
    },
    async get(uploadId) {
      const session = sessions.get(uploadId);
      if (session === undefined) return null;
      if (Date.parse(session.expiresAt) < Date.now()) {
        sessions.delete(uploadId);
        chunks.delete(uploadId);
        return null;
      }
      return session;
    },
    async putChunk(uploadId, index, source, expectedSha256) {
      const session = await store.get(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const expectedSize = expectedChunkSize(session, index);
      const bytes = await drain(source);
      if (bytes.byteLength !== expectedSize) {
        throw new HttpError(400, `分片 ${index} 大小不符：期望 ${expectedSize}，实际 ${bytes.byteLength}`);
      }
      const chunkSha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== chunkSha256) {
        throw new HttpError(400, `分片 ${index} 的 sha256 不符`, { expected: expectedSha256.toLowerCase(), actual: chunkSha256 });
      }
      chunks.get(uploadId)?.set(index, bytes);
      const received = [...new Set([...session.received, index])].sort((a, b) => a - b);
      const updated: ChunkSession = { ...session, received };
      sessions.set(uploadId, updated);
      return { session: updated, chunkSha256 };
    },
    async *readAll(uploadId) {
      const session = await store.get(uploadId);
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
    async purgeExpired(now = Date.now()) {
      const removed: string[] = [];
      for (const [uploadId, session] of sessions) {
        if (Date.parse(session.expiresAt) < now) {
          sessions.delete(uploadId);
          chunks.delete(uploadId);
          removed.push(uploadId);
        }
      }
      return removed;
    },
  };
  return store;
}

/** 本地磁盘实现：会话元数据 + 分片都落盘 → **进程重启后仍可续传**。 */
export function diskChunkStore(options: { dir: string; ttlMs?: number }): ChunkSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const root = path.resolve(options.dir);
  const safeId = (uploadId: string): string => {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new HttpError(400, `uploadId 不合法：${uploadId}`);
    return uploadId;
  };
  const sessionPath = (uploadId: string): string => path.join(root, `${safeId(uploadId)}.session.json`);
  const chunkPath = (uploadId: string, index: number): string => path.join(root, `${safeId(uploadId)}.${String(index)}.part`);

  const readSession = async (uploadId: string): Promise<ChunkSession | null> => {
    const file = sessionPath(uploadId); // 先校验 id（抛出的 HttpError 不能被下面的 catch 吞掉）
    try {
      const session = JSON.parse(await readFile(file, 'utf8')) as ChunkSession;
      if (Date.parse(session.expiresAt) < Date.now()) return null;
      return session;
    } catch {
      return null;
    }
  };
  const writeSession = async (session: ChunkSession): Promise<void> => {
    await mkdir(root, { recursive: true });
    await writeFile(sessionPath(session.uploadId), JSON.stringify(session), 'utf8');
  };

  const store: ChunkSessionStore = {
    totalChunks,
    missingChunks,
    async create(input) {
      const session = validateInit(input, ttlMs);
      await writeSession(session);
      return session;
    },
    get: readSession,
    async putChunk(uploadId, index, source, expectedSha256) {
      const session = await readSession(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const expectedSize = expectedChunkSize(session, index);
      const bytes = await drain(source);
      if (bytes.byteLength !== expectedSize) {
        throw new HttpError(400, `分片 ${index} 大小不符：期望 ${expectedSize}，实际 ${bytes.byteLength}`);
      }
      const chunkSha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== chunkSha256) {
        throw new HttpError(400, `分片 ${index} 的 sha256 不符`, { expected: expectedSha256.toLowerCase(), actual: chunkSha256 });
      }
      await mkdir(root, { recursive: true });
      await writeFile(chunkPath(uploadId, index), bytes); // 幂等：同分片重传即覆盖
      const received = [...new Set([...session.received, index])].sort((a, b) => a - b);
      const updated: ChunkSession = { ...session, received };
      await writeSession(updated);
      return { session: updated, chunkSha256 };
    },
    async *readAll(uploadId) {
      const session = await readSession(uploadId);
      if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
      const missing = missingChunks(session);
      if (missing.length > 0) throw new HttpError(400, `还有分片没收到：${missing.join(',')}`);
      for (let index = 0; index < totalChunks(session); index += 1) {
        yield await readFile(chunkPath(uploadId, index)); // 分片大于内存也没关系：逐个读
      }
    },
    async remove(uploadId) {
      const session = await readSession(uploadId);
      if (session === null) return false;
      for (let index = 0; index < totalChunks(session); index += 1) {
        await rm(chunkPath(uploadId, index), { force: true });
      }
      await rm(sessionPath(uploadId), { force: true });
      return true;
    },
    async purgeExpired(now = Date.now()) {
      let names: string[] = [];
      try {
        names = await readdir(root);
      } catch {
        return [];
      }
      const removed: string[] = [];
      for (const name of names) {
        if (!name.endsWith('.session.json')) continue;
        const uploadId = name.slice(0, -'.session.json'.length);
        const session = await readSession(uploadId);
        if (session === null) {
          await store.remove(uploadId);
          removed.push(uploadId);
        }
      }
      void now;
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

  test(`[chunk-store:${options.name}] 未知 uploadId 是 404（不是 500）；不安全的 id 直接拒`, async () => {
    const store = await options.make();
    await assert.rejects(() => store.putChunk('00000000-0000-4000-8000-000000000000', 0, asStream(bytes(1, 1))), /不存在或已过期/);
    if (options.name.includes('disk')) {
      await assert.rejects(() => store.get('../../etc/passwd'), /uploadId 不合法/);
    }
  });
}

void DbConfigError;
