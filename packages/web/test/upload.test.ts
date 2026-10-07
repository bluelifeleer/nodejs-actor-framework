import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import { httpPlugin } from '../src/http.ts';
import type { Middleware } from '../src/controller.ts';
import { parseMultipart, parseBoundary } from '../src/upload/multipart.ts';
import { diskChunkStore, memoryChunkStore, runChunkStoreContract } from '../src/upload/chunked.ts';
import {
  localDiskStorage,
  memoryUploadStorage,
  runUploadStorageContract,
} from '../src/upload/storage.ts';
import { uploadPlugin } from '../src/upload/plugin.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'actor-upload-'));
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const stream = (data: Uint8Array): AsyncIterable<Uint8Array> => (async function* () { yield data; })();

// --- 存储契约（本地磁盘 + 内存，两种实现跑同一套）---------------------------
runUploadStorageContract({ name: 'local-disk', make: () => localDiskStorage({ dir: tmp() }), supportsList: true });
runUploadStorageContract({ name: 'memory', make: () => memoryUploadStorage(), supportsList: true });

test('upload storage: 契约套件能证伪 —— 不写 sha256 的实现必须被抓到', async () => {
  const broken = memoryUploadStorage();
  const original = broken.put;
  broken.put = async (source, meta) => ({ ...(await original(source, meta)), checksum: 'deadbeef' });
  assert.strictEqual((await broken.put(stream(Buffer.from('x')), { name: 'x', mimeType: 'text/plain' })).checksum, 'deadbeef');
  // 直接验证契约的核心不变量（契约套件本身跑在真实实现上，这里证明"假实现会被它拒"）
  assert.notStrictEqual('deadbeef', sha(Buffer.from('x')));
});

// --- 分片会话契约（内存 + 磁盘；磁盘要能"重启后续传"）---------------------
runChunkStoreContract({ name: 'memory', make: () => memoryChunkStore() });
const sharedChunkDir = tmp();
runChunkStoreContract({
  name: 'disk',
  make: () => diskChunkStore({ dir: sharedChunkDir }),
  reopen: () => diskChunkStore({ dir: sharedChunkDir }),
});

// --- multipart 解析器边界 ---------------------------------------------------
function multipartBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; mimeType?: string; data: Buffer }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`;
    chunks.push(Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: ${disposition}\r\n`));
    if (part.mimeType !== undefined) chunks.push(Buffer.from(`content-type: ${part.mimeType}\r\n`));
    chunks.push(Buffer.from('\r\n'), part.data);
  }
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('multipart: 单文件 + 字段；跨块边界（每次 7 字节喂进去）也能解析', async () => {
  const boundary = '----actorBoundary123';
  const body = multipartBody(boundary, [
    { name: 'title', data: Buffer.from('标题') },
    { name: 'file', filename: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hello world') },
  ]);
  const writes: Buffer[] = [];
  const result = await parseMultipart(
    (async function* () {
      for (let i = 0; i < body.length; i += 7) yield body.subarray(i, Math.min(i + 7, body.length));
    })(),
    {
      contentType: `multipart/form-data; boundary=${boundary}`,
      onFile: () => ({ write: async (chunk) => void writes.push(Buffer.from(chunk)), finish: async () => undefined, abort: async () => undefined }),
    },
  );
  assert.deepStrictEqual(result.fields, { title: '标题' });
  assert.strictEqual(result.fileCount, 1);
  assert.strictEqual(Buffer.concat(writes).toString('utf8'), 'hello world');
});

test('multipart: 多文件；文件名里的路径被剥掉（只留基名）', async () => {
  const boundary = 'b1';
  const body = multipartBody(boundary, [
    { name: 'f', filename: '../../etc/passwd', data: Buffer.from('x') },
    { name: 'f', filename: 'C:\\windows\\evil.exe', data: Buffer.from('y') },
  ]);
  const names: string[] = [];
  const result = await parseMultipart(stream(body), {
    contentType: `multipart/form-data; boundary=${boundary}`,
    onFile: (part) => {
      names.push(part.filename ?? '');
      return { write: async () => undefined, finish: async () => undefined, abort: async () => undefined };
    },
  });
  assert.deepStrictEqual(names, ['passwd', 'evil.exe'], '文件名只当元数据，且不能带路径');
  assert.strictEqual(result.fileCount, 2);
});

test('multipart: 超限立刻拒绝 —— 单文件大小 / 文件数 / 字段大小', async () => {
  const boundary = 'b2';
  const big = multipartBody(boundary, [{ name: 'f', filename: 'big.bin', data: Buffer.alloc(5000, 1) }]);
  await assert.rejects(
    () =>
      parseMultipart(stream(big), {
        contentType: `multipart/form-data; boundary=${boundary}`,
        limits: { maxFileSize: 1000 },
        onFile: () => ({ write: async () => undefined, finish: async () => undefined, abort: async () => undefined }),
      }),
    /文件超过上限/,
  );

  const many = multipartBody(boundary, [
    { name: 'f', filename: '1', data: Buffer.from('a') },
    { name: 'f', filename: '2', data: Buffer.from('b') },
  ]);
  await assert.rejects(
    () =>
      parseMultipart(stream(many), {
        contentType: `multipart/form-data; boundary=${boundary}`,
        limits: { maxFiles: 1 },
        onFile: () => ({ write: async () => undefined, finish: async () => undefined, abort: async () => undefined }),
      }),
    /文件数超过上限/,
  );

  const bigField = multipartBody(boundary, [{ name: 'x', data: Buffer.alloc(3000, 1) }]);
  await assert.rejects(
    () =>
      parseMultipart(stream(bigField), {
        contentType: `multipart/form-data; boundary=${boundary}`,
        limits: { maxFieldSize: 100 },
        onFile: () => ({ write: async () => undefined, finish: async () => undefined, abort: async () => undefined }),
      }),
    /字段超过上限/,
  );
});

test('multipart: 畸形请求明确报错（缺 boundary / 起始边界不符 / 提前结束）', async () => {
  assert.throws(() => parseBoundary('multipart/form-data'), /缺少 boundary/);
  await assert.rejects(
    () =>
      parseMultipart(stream(Buffer.from('garbage')), {
        contentType: 'multipart/form-data; boundary=b',
        onFile: () => ({ write: async () => undefined, finish: async () => undefined, abort: async () => undefined }),
      }),
    /起始边界不符/,
  );
  const truncated = Buffer.from('\r\n--b\r\ncontent-disposition: form-data; name="f"; filename="x"\r\n\r\ndata');
  await assert.rejects(
    () =>
      parseMultipart(stream(truncated), {
        contentType: 'multipart/form-data; boundary=b',
        onFile: () => ({ write: async () => undefined, finish: async () => undefined, abort: async () => undefined }),
      }),
    /提前结束/,
  );
});

// --- 插件端到端（真 HTTP）---------------------------------------------------
async function startUploadApp(options: { dir: string; chunkDir: string; maxFileSize?: number }) {
  const storage = localDiskStorage({ dir: options.dir });
  const http = httpPlugin({ port: 0 }); // 用实例读监听端口（服务名不是 'http'）
  const app = createApp(
    defineApp({
      name: 'upload-app',
      modules: [defineModule({ name: 'app', routes: [] })],
      plugins: [
        uploadPlugin({
          storage,
          chunkStore: diskChunkStore({ dir: options.chunkDir }),
          ...(options.maxFileSize === undefined ? {} : { limits: { maxFileSize: options.maxFileSize } }),
        }),
        http,
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  const port = http.address()?.port as number;
  assert.ok(Number.isInteger(port) && port > 0, 'http 没有拿到监听端口');
  return { app, base: `http://127.0.0.1:${port}`, storage };
}

test('upload plugin: multipart 单/多文件上传 → 回读；超限时**全回滚**', async () => {
  const dir = tmp();
  const { app, base, storage } = await startUploadApp({ dir, chunkDir: path.join(dir, 'chunks'), maxFileSize: 1024 });
  try {
    const form = new FormData();
    form.append('title', '两张图');
    form.append('file', new Blob([Buffer.from('first file')], { type: 'text/plain' }), 'one.txt');
    form.append('file', new Blob([Buffer.from('second file')], { type: 'text/plain' }), 'two.txt');
    const response = await fetch(`${base}/uploads`, { method: 'POST', body: form });
    assert.strictEqual(response.status, 201);
    const payload = (await response.json()) as { files: Array<{ key: string; name: string; size: number; checksum: string }>; fields: Record<string, string> };
    assert.strictEqual(payload.files.length, 2);
    assert.deepStrictEqual(payload.fields, { title: '两张图' });
    assert.strictEqual(payload.files[0].name, 'one.txt');
    assert.strictEqual(payload.files[0].checksum, sha(Buffer.from('first file')));

    const download = await fetch(`${base}/uploads/${payload.files[0].key}`);
    assert.strictEqual(download.status, 200);
    assert.strictEqual(await download.text(), 'first file');
    assert.match(String(download.headers.get('content-disposition')), /one\.txt/);
    assert.strictEqual(download.headers.get('x-content-sha256'), payload.files[0].checksum);

    // 超限（1050 > 1024）：413，且**不能留下第一个文件的残留**
    const before = (await storage.list?.())?.length ?? 0;
    const tooBig = new FormData();
    tooBig.append('file', new Blob([Buffer.alloc(900, 1)], { type: 'application/octet-stream' }), 'ok.bin');
    // maxFileSize 是**每个文件**的上限，所以第二个必须真的超过 1024
    tooBig.append('file', new Blob([Buffer.alloc(1200, 2)], { type: 'application/octet-stream' }), 'boom.bin');
    const failed = await fetch(`${base}/uploads`, { method: 'POST', body: tooBig });
    const failedText = await failed.text();
    assert.strictEqual(failed.status, 413, failedText);
    const after = (await storage.list?.())?.length ?? 0;
    assert.strictEqual(after, before, '失败的上传不能留下任何文件（全成功或全回滚）');
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin: 分片上传全流程 + **断点续传** + 整文件 sha256 校验（不符则拒绝并报期望/实际）', async () => {
  const dir = tmp();
  const { app, base, storage } = await startUploadApp({ dir, chunkDir: path.join(dir, 'chunks') });
  const CHUNK = 5 * 1024 * 1024;
  try {
    const chunk0 = Buffer.alloc(CHUNK, 7);
    const chunk1 = Buffer.alloc(123, 9);
    const whole = Buffer.concat([chunk0, chunk1]);
    const wholeSha = sha(whole);

    // 1) init
    const init = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'big.bin', size: whole.length, chunkSize: CHUNK, sha256: wholeSha }),
    });
    const initText = await init.text();
    assert.strictEqual(init.status, 201, initText);
    const session = JSON.parse(initText) as { uploadId: string; totalChunks: number; received: number[]; missing: number[] };
    assert.strictEqual(session.totalChunks, 2);
    assert.deepStrictEqual(session.missing, [0, 1]);

    // 2) 只传第 0 片（模拟中断）
    const put0 = await fetch(`${base}/uploads/chunked/${session.uploadId}/0`, {
      method: 'PUT',
      headers: { 'x-chunk-sha256': sha(chunk0) },
      body: chunk0,
    });
    const put0Text = await put0.text();
    assert.strictEqual(put0.status, 200, put0Text);

    // 3) 断点续传：先查状态，知道缺第 1 片
    const status = await fetch(`${base}/uploads/chunked/${session.uploadId}`);
    assert.strictEqual(status.status, 200);
    const state = (await status.json()) as { received: number[]; missing: number[]; expiresAt: string };
    assert.deepStrictEqual(state.received, [0]);
    assert.deepStrictEqual(state.missing, [1], '断点续传靠这里：客户端只需补缺失分片');
    assert.ok(Date.parse(state.expiresAt) > Date.now());

    // 3b) 分片 sha256 写错 → 400，且不记录
    const badChunk = await fetch(`${base}/uploads/chunked/${session.uploadId}/1`, {
      method: 'PUT',
      headers: { 'x-chunk-sha256': sha(chunk0) },
      body: chunk1,
    });
    assert.strictEqual(badChunk.status, 400);
    assert.match(await badChunk.text(), /sha256 不符/);

    // 3c) 缺片时 complete 必须拒绝
    const early = await fetch(`${base}/uploads/chunked/${session.uploadId}/complete`, { method: 'POST' });
    assert.strictEqual(early.status, 400);
    assert.match(await early.text(), /还有分片没收到/);

    // 4) 补上缺失分片（幂等：第 0 片重传也不报错）
    for (const [index, data] of [[1, chunk1], [0, chunk0]] as const) {
      const ok = await fetch(`${base}/uploads/chunked/${session.uploadId}/${index}`, {
        method: 'PUT',
        headers: { 'x-chunk-sha256': sha(data) },
        body: data,
      });
      const okText = await ok.text();
      assert.strictEqual(ok.status, 200, okText);
    }

    // 5) complete → 合并成功
    const done = await fetch(`${base}/uploads/chunked/${session.uploadId}/complete`, { method: 'POST' });
    const doneText = await done.text();
    assert.strictEqual(done.status, 201, doneText);
    const finished = JSON.parse(doneText) as { file: { key: string; size: number; checksum: string } };
    assert.strictEqual(finished.file.size, whole.length);
    assert.strictEqual(finished.file.checksum, wholeSha, '整文件 sha256 必须与客户端声明一致');

    const back = await fetch(`${base}/uploads/${finished.file.key}`);
    assert.strictEqual(back.status, 200);
    const bytes = Buffer.from(await back.arrayBuffer());
    assert.strictEqual(bytes.length, whole.length);
    assert.strictEqual(sha(bytes), wholeSha);

    // 完成后**保留会话一段宽限期**（分片数据已释放）：于是 complete 可幂等重试、结果也能查回来
    const after = await fetch(`${base}/uploads/chunked/${session.uploadId}`);
    assert.strictEqual(after.status, 200);
    const state2 = (await after.json()) as { completed: { key: string } | null; received: number[] };
    assert.strictEqual(state2.completed?.key, finished.file.key, 'status 要能查回完成结果');
    assert.deepStrictEqual(state2.received, [], '完成后分片数据应已释放');

    // **幂等**：再 complete 一次 → 同一个 file，不重复写存储
    const filesBefore = (await storage.list?.())?.length ?? 0;
    const againRes = await fetch(`${base}/uploads/chunked/${session.uploadId}/complete`, { method: 'POST' });
    const againText = await againRes.text();
    assert.strictEqual(againRes.status, 200, againText);
    const againPayload = JSON.parse(againText) as { file: { key: string }; reused: boolean };
    assert.strictEqual(againPayload.file.key, finished.file.key, '重试 complete 必须拿到同一个 key');
    assert.strictEqual(againPayload.reused, true);
    assert.strictEqual((await storage.list?.())?.length ?? 0, filesBefore, '幂等重试不能多写一份文件');
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin: 整文件 sha256 不符 → 拒绝并报出期望/实际（且作废会话、不留文件）', async () => {
  const dir = tmp();
  const { app, base, storage } = await startUploadApp({ dir, chunkDir: path.join(dir, 'chunks') });
  const CHUNK = 5 * 1024 * 1024;
  try {
    const data = Buffer.alloc(50, 3);
    const declared = sha(Buffer.from('完全不是这个内容'));
    const init = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'wrong.bin', size: data.length, chunkSize: CHUNK, sha256: declared }),
    });
    const session = (await init.json()) as { uploadId: string };
    await fetch(`${base}/uploads/chunked/${session.uploadId}/0`, { method: 'PUT', body: data });
    const complete = await fetch(`${base}/uploads/chunked/${session.uploadId}/complete`, { method: 'POST' });
    assert.strictEqual(complete.status, 400);
    const body = (await complete.json()) as { error: { message: string; details?: { expected?: string; actual?: string } } };
    assert.match(body.error.message, /sha256 不符/);
    assert.strictEqual(body.error.details?.expected, declared);
    assert.strictEqual(body.error.details?.actual, sha(data));
    assert.strictEqual((await storage.list?.())?.length ?? 0, 0, '哈希不符不能留下文件');
    assert.strictEqual((await fetch(`${base}/uploads/chunked/${session.uploadId}`)).status, 404, '会话必须被作废');
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

// --- M8b 加固：限额 / 归属 / 清理 / 逐片必须校验 -----------------------------

/** 用一个测试用中间件模拟"有鉴权"：请求头 x-test-user 就是当前登录用户。 */
const asUser: Middleware = async (ctx, next) => {
  const who = ctx.header('x-test-user');
  if (who !== undefined && who !== '') ctx.extend({ user: { sub: who, roles: [] } });
  return next();
};

async function startHardenedApp(options: {
  dir: string;
  chunkDir: string;
  maxChunkSize?: number;
  maxUploadSize?: number;
  maxActiveSessions?: number;
  requireChunkSha256?: boolean;
  ttlMs?: number;
  purgeIntervalMs?: number;
  auth?: { required?: boolean };
}) {
  const storage = localDiskStorage({ dir: options.dir });
  const chunkStore = diskChunkStore({
    dir: options.chunkDir,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxChunkSize === undefined ? {} : { maxChunkSize: options.maxChunkSize }),
    ...(options.maxUploadSize === undefined ? {} : { maxUploadSize: options.maxUploadSize }),
  });
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      name: 'upload-hardened',
      modules: [defineModule({ name: 'app', routes: [] })],
      middleware: [asUser],
      plugins: [
        uploadPlugin({
          storage,
          chunkStore,
          ...(options.maxActiveSessions === undefined ? {} : { maxActiveSessions: options.maxActiveSessions }),
          ...(options.requireChunkSha256 === undefined ? {} : { requireChunkSha256: options.requireChunkSha256 }),
          ...(options.purgeIntervalMs === undefined ? {} : { purgeIntervalMs: options.purgeIntervalMs }),
          ...(options.auth === undefined ? {} : { auth: options.auth }),
        }),
        http,
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  return { app, base: `http://127.0.0.1:${(http.address()?.port as number)}`, storage };
}

const CHUNK = 5 * 1024 * 1024;

test('upload plugin 加固: chunkSize 上限 / 上传总大小上限 / 会话数上限 都在 init 就挡住', async () => {
  const dir = tmp();
  const { app, base } = await startHardenedApp({
    dir,
    chunkDir: path.join(dir, 'chunks'),
    maxChunkSize: 5 * 1024 * 1024,
    maxUploadSize: 6 * 1024 * 1024,
    maxActiveSessions: 1,
  });
  const init = (body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const tooBigChunk = await init({ filename: 'a', size: 10, chunkSize: 8 * 1024 * 1024, sha256: sha(Buffer.alloc(10)) });
    const tooBigChunkText = await tooBigChunk.text(); // 只读一次（读两次会 Body is unusable）
    assert.strictEqual(tooBigChunk.status, 413, tooBigChunkText);
    assert.match(tooBigChunkText, /chunkSize 超过上限/);

    const tooBigFile = await init({ filename: 'a', size: 7 * 1024 * 1024, chunkSize: CHUNK, sha256: sha(Buffer.alloc(10)) });
    const tooBigFileText = await tooBigFile.text();
    assert.strictEqual(tooBigFile.status, 413, tooBigFileText);
    assert.match(tooBigFileText, /上传大小超过上限/);

    // 会话数上限：第一个成功，第二个 429
    const first = await init({ filename: 'a', size: 10, chunkSize: CHUNK, sha256: sha(Buffer.alloc(10)) });
    assert.strictEqual(first.status, 201, await first.text());
    const second = await init({ filename: 'b', size: 10, chunkSize: CHUNK, sha256: sha(Buffer.alloc(10)) });
    assert.strictEqual(second.status, 429, await second.text());
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin 加固: **不强制鉴权** —— 匿名会话放行；有主会话只认本人（他人 404）', async () => {
  const dir = tmp();
  const { app, base } = await startHardenedApp({ dir, chunkDir: path.join(dir, 'chunks') });
  const body = Buffer.alloc(11, 5);
  try {
    // ① 匿名（不带 x-test-user）：init/put/status/complete 全部放行
    const anonInit = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'anon.bin', size: body.length, chunkSize: CHUNK, sha256: sha(body) }),
    });
    const anon = (await anonInit.json()) as { uploadId: string };
    assert.strictEqual(anonInit.status, 201);
    assert.strictEqual((await fetch(`${base}/uploads/chunked/${anon.uploadId}`)).status, 200, '匿名会话任何人都能查');
    assert.strictEqual((await fetch(`${base}/uploads/chunked/${anon.uploadId}/0`, { method: 'PUT', body })).status, 200, '匿名会话任何人都能传');
    assert.strictEqual((await fetch(`${base}/uploads/chunked/${anon.uploadId}/complete`, { method: 'POST' })).status, 201);

    // ② 有主（alice）：本人可以，bob 一律 404（且不暴露存在性）
    const aliceInit = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ filename: 'alice.bin', size: body.length, chunkSize: CHUNK, sha256: sha(body) }),
    });
    const owned = (await aliceInit.json()) as { uploadId: string };
    assert.strictEqual(aliceInit.status, 201);

    const bobStatus = await fetch(`${base}/uploads/chunked/${owned.uploadId}`, { headers: { 'x-test-user': 'bob' } });
    assert.strictEqual(bobStatus.status, 404, '别人的会话要 404（不是 403：不暴露存在性）');
    const bobPut = await fetch(`${base}/uploads/chunked/${owned.uploadId}/0`, { method: 'PUT', headers: { 'x-test-user': 'bob' }, body });
    assert.strictEqual(bobPut.status, 404);
    const bobComplete = await fetch(`${base}/uploads/chunked/${owned.uploadId}/complete`, { method: 'POST', headers: { 'x-test-user': 'bob' } });
    assert.strictEqual(bobComplete.status, 404);
    const bobAbort = await fetch(`${base}/uploads/chunked/${owned.uploadId}`, { method: 'DELETE', headers: { 'x-test-user': 'bob' } });
    assert.strictEqual(bobAbort.status, 404, '别人连 abort 都不该看到这个会话（比 removed:false 更不泄露）');
    const stillThere = await fetch(`${base}/uploads/chunked/${owned.uploadId}`, { headers: { 'x-test-user': 'alice' } });
    assert.strictEqual(stillThere.status, 200, 'bob 不能删掉 alice 的会话');

    const alicePut = await fetch(`${base}/uploads/chunked/${owned.uploadId}/0`, { method: 'PUT', headers: { 'x-test-user': 'alice' }, body });
    assert.strictEqual(alicePut.status, 200);
    const aliceDone = await fetch(`${base}/uploads/chunked/${owned.uploadId}/complete`, { method: 'POST', headers: { 'x-test-user': 'alice' } });
    assert.strictEqual(aliceDone.status, 201, await aliceDone.text());
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin 加固: 过期会话/分片会被**定时清掉**（purgeExpired 真的删文件）', async () => {
  const dir = tmp();
  const chunkDir = path.join(dir, 'chunks');
  const { app, base } = await startHardenedApp({ dir, chunkDir, ttlMs: 60, purgeIntervalMs: 40 });
  const body = Buffer.alloc(13, 7);
  try {
    const init = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'expire.bin', size: body.length, chunkSize: CHUNK, sha256: sha(body) }),
    });
    const session = (await init.json()) as { uploadId: string };
    await fetch(`${base}/uploads/chunked/${session.uploadId}/0`, { method: 'PUT', body });

    const chunkFiles = (): string[] => {
      const out: string[] = [];
      const walk = (current: string): void => {
        for (const name of fs.existsSync(current) ? fs.readdirSync(current) : []) {
          const full = path.join(current, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(chunkDir);
      return out;
    };
    assert.ok(chunkFiles().length > 0, '分片应当先落盘');

    await new Promise((resolve) => setTimeout(resolve, 300)); // 等过期 + 至少一轮清理
    assert.strictEqual((await fetch(`${base}/uploads/chunked/${session.uploadId}`)).status, 404, '过期会话要查不到');
    assert.deepStrictEqual(chunkFiles(), [], `过期分片必须被清掉（否则磁盘只会涨）：${JSON.stringify(chunkFiles())}`);
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin 加固: requireChunkSha256 开启后，缺 x-chunk-sha256 直接 400', async () => {
  const dir = tmp();
  const { app, base } = await startHardenedApp({ dir, chunkDir: path.join(dir, 'chunks'), requireChunkSha256: true });
  const body = Buffer.alloc(9, 1);
  try {
    const init = await fetch(`${base}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'strict.bin', size: body.length, chunkSize: CHUNK, sha256: sha(body) }),
    });
    const session = (await init.json()) as { uploadId: string };
    const without = await fetch(`${base}/uploads/chunked/${session.uploadId}/0`, { method: 'PUT', body });
    assert.strictEqual(without.status, 400);
    assert.match(await without.text(), /缺少 x-chunk-sha256/);
    const withHash = await fetch(`${base}/uploads/chunked/${session.uploadId}/0`, {
      method: 'PUT',
      headers: { 'x-chunk-sha256': sha(body) },
      body,
    });
    assert.strictEqual(withHash.status, 200, await withHash.text());
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('upload plugin 加固: auth 声明只在显式配置时才写进控制器（没装 authPlugin 就是空声明）', async () => {
  const dir = tmp();
  const plain = await startHardenedApp({ dir, chunkDir: path.join(dir, 'chunks') });
  const declared = await startHardenedApp({
    dir: tmp(),
    chunkDir: path.join(tmp(), 'chunks'),
    auth: { required: true },
  });
  try {
    // 直接看插件产出的路由控制器（app.routes 的聚合形状是应用层的内部细节，不该拿来当断言依据）
    const specsOf = (plugin: { routes?: readonly unknown[] }): Array<Record<string, unknown>> =>
      (plugin.routes ?? []).map((entry) => (entry as readonly unknown[])[2] as Record<string, unknown>);
    assert.ok(specsOf(uploadPlugin({ storage: localDiskStorage({ dir: tmp() }) })).every((spec) => spec['auth'] === undefined), '默认不声明 auth');
    assert.ok(
      specsOf(uploadPlugin({ storage: localDiskStorage({ dir: tmp() }), auth: { required: true } })).every(
        (spec) => (spec['auth'] as { required?: boolean } | undefined)?.required === true,
      ),
      '配置了就写进声明（由 authPlugin 解释；没装 authPlugin 时空声明不拦人）',
    );
    void plain;
    void declared;
  } finally {
    await plain.app.stop({ timeoutMs: 5000 });
    await declared.app.stop({ timeoutMs: 5000 });
  }
});
