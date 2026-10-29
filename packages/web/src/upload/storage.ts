import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * **上传存储契约**：框架只内置本地磁盘实现；S3/OSS/MinIO 由使用者实现本接口
 * （再用 `defineUploadStorage` 包一下即可）。
 *
 * 纪律（与数据库适配器一致）：
 *   - `put` 的入参是**流**（边写边算 sha256），所以大文件不会进内存；
 *   - `checksum` 是**内容 sha256**（十六进制），分片合并后的整文件校验就靠它；
 *   - `key` 由**服务端**生成（`put` 返回），调用方不能指定路径（杜绝穿越）。
 */
export interface UploadedFile {
  /** 服务端生成的键（也就是存储里的名字）。 */
  readonly key: string;
  /** 原始文件名 —— **只当元数据**，不参与路径。 */
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** 内容 sha256（十六进制小写）。 */
  readonly checksum: string;
  readonly uploadedAt: string;
}

export interface UploadStorage {
  put(
    source: AsyncIterable<Uint8Array>,
    meta: { name: string; mimeType: string; extension?: string },
  ): Promise<UploadedFile>;
  get(key: string): Promise<{ stream: AsyncIterable<Uint8Array>; file: UploadedFile } | null>;
  stat(key: string): Promise<UploadedFile | null>;
  delete(key: string): Promise<boolean>;
  list?(): Promise<UploadedFile[]>;
}

/** 结构校验（用户自装存储也能用它自证形状）。 */
export function defineUploadStorage(spec: UploadStorage): UploadStorage {
  if (typeof spec?.put !== 'function') throw new DbConfigError('defineUploadStorage: "put" is required');
  if (typeof spec.get !== 'function' || typeof spec.stat !== 'function' || typeof spec.delete !== 'function') {
    throw new DbConfigError('defineUploadStorage: get/stat/delete are required');
  }
  return spec;
}

/** 安全的 key：随机 uuid + 白名单扩展名（绝不采用调用方给的路径）。 */
export function generateKey(extension: string | undefined): string {
  const ext = extension === undefined ? '' : extension.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
  return `${randomUUID()}${ext === '' ? '' : `.${ext}`}`;
}

async function* fileStream(file: string): AsyncIterable<Uint8Array> {
  // 流式读，不把整个文件读进内存（默认单文件上限 512MiB）
  for await (const chunk of createReadStream(file)) yield chunk as Uint8Array;
}

export interface LocalDiskStorageOptions {
  /** 数据目录（不存在会创建）。 */
  dir: string;
}

/**
 * 内置的本地磁盘存储：文件写 `dir/<key>`，元数据写 `dir/<key>.json`（先写临时名再 rename，避免半截文件被当成完整的）。
 */
export function localDiskStorage(options: LocalDiskStorageOptions): UploadStorage {
  const dir = path.resolve(options.dir);
  const dataPath = (key: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes('..')) {
      throw new DbConfigError(`upload key "${key}" is not a safe key`);
    }
    return path.join(dir, key);
  };
  const metaPath = (key: string): string => `${dataPath(key)}.json`;
  const readMeta = async (key: string): Promise<UploadedFile | null> => {
    try {
      return JSON.parse(await readFile(metaPath(key), 'utf8')) as UploadedFile;
    } catch {
      return null;
    }
  };

  return defineUploadStorage({
    async put(source, meta) {
      await mkdir(dir, { recursive: true });
      const key = generateKey(meta.extension);
      const target = dataPath(key);
      const temp = `${target}.part`;
      const hash = createHash('sha256');
      let size = 0;
      const { open } = await import('node:fs/promises');
      const handle = await open(temp, 'w');
      try {
        for await (const chunk of source) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
          hash.update(bytes);
          size += bytes.byteLength;
          await handle.write(bytes);
        }
        await handle.close();
        // 先落元数据再 rename：这样"看得见数据文件"就一定能读到元数据
        const file: UploadedFile = {
          key,
          name: meta.name,
          mimeType: meta.mimeType,
          size,
          checksum: hash.digest('hex'),
          uploadedAt: new Date().toISOString(),
        };
        await writeFile(metaPath(key), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
        await rename(temp, target);
        return file;
      } catch (err) {
        await handle.close().catch(() => undefined);
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
    },
    async get(key) {
      const file = await readMeta(key);
      if (file === null) return null;
      return { stream: fileStream(dataPath(key)), file };
    },
    stat: readMeta,
    async delete(key) {
      const file = await readMeta(key);
      if (file === null) return false;
      await rm(dataPath(key), { force: true });
      await rm(metaPath(key), { force: true });
      return true;
    },
    async list() {
      const { readdir } = await import('node:fs/promises');
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const out: UploadedFile[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const meta = await readMeta(name.slice(0, -'.json'.length));
        if (meta !== null) out.push(meta);
      }
      return out;
    },
  });
}

/** 内存存储（测试用；也适合小规模部署）。 */
export function memoryUploadStorage(options: { maxBytes?: number } = {}): UploadStorage {
  const files = new Map<string, { file: UploadedFile; bytes: Uint8Array }>();
  return defineUploadStorage({
    async put(source, meta) {
      const chunks: Uint8Array[] = [];
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of source) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
        hash.update(bytes);
        size += bytes.byteLength;
        if (options.maxBytes !== undefined && size > options.maxBytes) throw new DbConfigError('memoryUploadStorage: 超出 maxBytes');
        chunks.push(bytes);
      }
      const key = generateKey(meta.extension);
      const file: UploadedFile = {
        key,
        name: meta.name,
        mimeType: meta.mimeType,
        size,
        checksum: hash.digest('hex'),
        uploadedAt: new Date().toISOString(),
      };
      files.set(key, { file, bytes: Buffer.concat(chunks) });
      return file;
    },
    async get(key) {
      const entry = files.get(key);
      if (entry === undefined) return null;
      return { stream: (async function* () { yield entry.bytes; })(), file: entry.file };
    },
    async stat(key) {
      return files.get(key)?.file ?? null;
    },
    async delete(key) {
      return files.delete(key);
    },
    async list() {
      return [...files.values()].map((entry) => entry.file);
    },
  });
}

/** 契约套件：任何 `UploadStorage` 实现都应通过（用户自装的存储用它自证合规）。 */
export function runUploadStorageContract(options: {
  name: string;
  make: () => UploadStorage | Promise<UploadStorage>;
  /** 这个实现是否支持 list()（可选能力）。 */
  supportsList?: boolean;
}): void {
  const bytesOf = async (stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream) parts.push(chunk);
    return Buffer.concat(parts);
  };
  const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

  test(`[upload-storage:${options.name}] put 返回服务端生成的 key + 正确的 size/sha256`, async () => {
    const storage = await options.make();
    const payload = Buffer.from('hello upload contract');
    const file = await storage.put((async function* () { yield payload; })(), { name: 'a.txt', mimeType: 'text/plain', extension: 'txt' });
    assert.ok(file.key.length > 0);
    assert.ok(!file.key.includes('/') && !file.key.includes('..'), `key 不能是路径：${file.key}`);
    assert.ok(file.key.endsWith('.txt'), `key 应当带上白名单扩展名：${file.key}`);
    assert.strictEqual(file.size, payload.length);
    assert.strictEqual(file.checksum, sha256(payload), 'checksum 必须是内容 sha256');
    assert.strictEqual(file.name, 'a.txt', '原始文件名只当元数据');
  });

  test(`[upload-storage:${options.name}] get/stat 读回的内容与写入一致；delete 幂等`, async () => {
    const storage = await options.make();
    const payload = Buffer.from('read me back');
    const file = await storage.put((async function* () { yield payload; })(), { name: 'r.bin', mimeType: 'application/octet-stream' });
    const read = await storage.get(file.key);
    assert.ok(read !== null);
    assert.deepStrictEqual(await bytesOf(read.stream), payload);
    assert.strictEqual((await storage.stat(file.key))?.checksum, file.checksum);
    assert.strictEqual(await storage.delete(file.key), true);
    assert.strictEqual(await storage.delete(file.key), false, 'delete 必须幂等');
    assert.strictEqual(await storage.get(file.key), null);
    assert.strictEqual(await storage.stat(file.key), null);
  });

  test(`[upload-storage:${options.name}] 多块流式写入也正确（大文件不走内存）`, async () => {
    const storage = await options.make();
    const parts = [Buffer.from('aaa'), Buffer.from('bbb'), Buffer.from('ccc')];
    const file = await storage.put((async function* () { for (const part of parts) yield part; })(), { name: 'm', mimeType: 'text/plain' });
    assert.strictEqual(file.size, 9);
    assert.strictEqual(file.checksum, sha256(Buffer.concat(parts)));
    const read = await storage.get(file.key);
    assert.ok(read !== null);
    assert.deepStrictEqual(await bytesOf(read.stream), Buffer.concat(parts));
  });

  if (options.supportsList === true) {
    test(`[upload-storage:${options.name}] list 返回已存文件`, async () => {
      const storage = await options.make();
      const file = await storage.put((async function* () { yield Buffer.from('x'); })(), { name: 'l', mimeType: 'text/plain' });
      const list = (await storage.list?.()) ?? [];
      assert.ok(list.some((item) => item.key === file.key));
    });
  }

  test(`[upload-storage:${options.name}] 不存在的 key 不会抛出（返回 null）`, async () => {
    const storage = await options.make();
    assert.strictEqual(await storage.get('no-such-key'), null);
    assert.strictEqual(await storage.stat('no-such-key'), null);
    assert.strictEqual(await storage.delete('no-such-key'), false);
  });
}
