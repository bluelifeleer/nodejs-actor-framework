import { HttpError, reply } from '../context.ts';
import { defineController } from '../controller.ts';
import { defineRoutes, del, get, post, put, type Route } from '../routes.ts';
import { defineWebPlugin, type WebPluginSpec } from '../plugins.ts';
import { DEFAULT_MULTIPART_LIMITS, parseMultipart, type MultipartLimits } from './multipart.ts';
import { diskChunkStore, memoryChunkStore, type ChunkSessionStore } from './chunked.ts';
import { type UploadStorage, type UploadedFile } from './storage.ts';

/** 插件把"需要流式 body 的路径"注册成这个服务，httpPlugin 读它来决定是否缓冲。 */
export const STREAM_ROUTES_SERVICE = '@actor/web:streamRoutes';
/** 插件把上传存储注册成这个服务（其它模块也能直接用）。 */
export const UPLOAD_STORAGE_SERVICE = '@actor/web:uploadStorage';

type StreamMatcher = (method: string, path: string) => boolean;

function matcherFor(patterns: readonly string[]): StreamMatcher {
  const compiled = patterns.map((pattern) => {
    const regex = new RegExp(
      `^${pattern
        .split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/')}$`,
    );
    return regex;
  });
  return (_method: string, path: string): boolean => compiled.some((regex) => regex.test(path));
}

/** 把 push 型 sink 变成 pull 型 async iterable（`storage.put` 要吃流）。 */
function pushStream(): {
  stream: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  fail(error: unknown): void;
} {
  const queue: Uint8Array[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  let failure: unknown = null;
  const wake = (): void => {
    notify?.();
    notify = null;
  };
  const stream = (async function* (): AsyncIterable<Uint8Array> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as Uint8Array;
      if (failure !== null) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  })();
  return {
    stream,
    async write(chunk) {
      if (failure !== null) throw failure;
      queue.push(chunk);
      wake();
      // 背压：让出一次事件循环，避免无限堆积（存储侧不消费时不至于吃光内存）
      if (queue.length > 16) await new Promise<void>((resolve) => setImmediate(resolve));
    },
    end() {
      closed = true;
      wake();
    },
    fail(error) {
      failure = error;
      wake();
    },
  };
}

export interface UploadPluginOptions {
  storage: UploadStorage;
  /** 分片会话存储；默认内存（单节点）。多节点部署请换成磁盘/共享存储实现。 */
  chunkStore?: ChunkSessionStore;
  routePrefix?: string;
  limits?: Partial<MultipartLimits>;
  /** 给了就强制白名单（否则只做基本校验）。 */
  allowedMimeTypes?: readonly string[];
  allowedExtensions?: readonly string[];
}

/** 从文件名取扩展名（不带点，小写）。 */
function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * **上传插件**：流式单/多文件 + **分片断点续传**（含逐片与整文件 sha256 校验）。
 *
 * 路由（前缀默认 `/uploads`）：
 *   - `POST /uploads`：multipart 单/多文件（**全成功或全回滚**）；
 *   - `GET /uploads/:key`：回读（带 content-type 与 Content-Disposition）；
 *   - `POST /uploads/chunked/init`：声明 filename/size/chunkSize/整文件 sha256 → uploadId + 已收分片；
 *   - `PUT /uploads/chunked/:uploadId/:index`：上传分片（`x-chunk-sha256` 逐片校验，幂等可重传）；
 *   - `GET /uploads/chunked/:uploadId`：断点续传状态（已收/缺失/过期时间）；
 *   - `POST /uploads/chunked/:uploadId/complete`：合并 + **整文件 sha256 校验**（不符则拒绝并报期望/实际）；
 *   - `DELETE /uploads/chunked/:uploadId`：作废会话（清理分片）。
 */
export function uploadPlugin(options: UploadPluginOptions): WebPluginSpec {
  const prefix = (options.routePrefix ?? '/uploads').replace(/\/$/, '');
  const chunkStore = options.chunkStore ?? memoryChunkStore();
  const limits: MultipartLimits = { ...DEFAULT_MULTIPART_LIMITS, ...(options.limits ?? {}) };
  const streamPatterns = [prefix, `${prefix}/chunked/:uploadId/:index`];

  const checkWhitelist = (filename: string, mimeType: string): void => {
    if (options.allowedExtensions !== undefined) {
      const ext = extensionOf(filename);
      if (!options.allowedExtensions.map((item) => item.replace(/^\./, '').toLowerCase()).includes(ext)) {
        throw new HttpError(415, `扩展名不允许：.${ext}`);
      }
    }
    if (options.allowedMimeTypes !== undefined && !options.allowedMimeTypes.includes(mimeType)) {
      throw new HttpError(415, `MIME 类型不允许：${mimeType}`);
    }
  };

  const routes = defineRoutes([
    post(
      prefix,
      defineController({
        async handle(_input, ctx): Promise<unknown> {
          const stream = (ctx as unknown as { stream?: AsyncIterable<Uint8Array> }).stream;
          if (stream === undefined) throw new HttpError(500, '上传路由没有拿到请求流（httpPlugin 未启用流式？）');
          const contentType = ctx.header('content-type') ?? '';
          const written: UploadedFile[] = [];
          const pending: Array<{ push: ReturnType<typeof pushStream>; promise: Promise<UploadedFile>; mimeType: string }> = [];

          const parse = parseMultipart(stream, {
            contentType,
            limits,
            onFile: (part) => {
              const filename = part.filename ?? 'upload.bin';
              checkWhitelist(filename, part.mimeType);
              const push = pushStream();
              const promise = options.storage.put(push.stream, {
                name: filename,
                mimeType: part.mimeType,
                extension: extensionOf(filename),
              });
              pending.push({ push, promise, mimeType: part.mimeType });
              return {
                write: (chunk) => push.write(chunk),
                finish: async () => {
                  push.end();
                  written.push(await promise);
                },
                abort: async () => {
                  push.fail(new HttpError(400, '上传被中断'));
                  await promise.catch(() => undefined);
                },
              };
            },
          });

          try {
            const result = await parse;
            if (written.length === 0) throw new HttpError(400, '请求里没有文件（multipart 的 file part）');
            return reply.json({ files: written, fields: result.fields }, { status: 201 });
          } catch (err) {
            // **全成功或全回滚**：任何失败都把已经写进去的删掉
            for (const item of pending) item.push.fail(err);
            await Promise.all(pending.map((item) => item.promise.catch(() => undefined)));
            await Promise.all(written.map((file) => options.storage.delete(file.key)));
            throw err;
          }
        },
      }),
    ),

    get(
      `${prefix}/:key`,
      defineController({
        input: { key: { type: 'string', min: 1 } },
        async handle(input, ctx): Promise<unknown> {
          const key = String(input.key);
          const read = await options.storage.get(key);
          if (read === null) throw new HttpError(404, `文件不存在：${key}`);
          const parts: Uint8Array[] = [];
          for await (const chunk of read.stream) parts.push(chunk);
          return reply.buffer(Buffer.concat(parts), {
            contentType: read.file.mimeType,
            headers: {
              'content-disposition': `attachment; filename="${read.file.name.replace(/["\\]/g, '_')}"`,
              'x-content-sha256': read.file.checksum,
            },
          });
        },
      }),
    ),

    post(
      `${prefix}/chunked/init`,
      defineController({
        body: ['filename', 'size', 'chunkSize', 'sha256'],
        input: {
          filename: { type: 'string', min: 1 },
          size: { type: 'number' },
          chunkSize: { type: 'number' },
          sha256: { type: 'string', min: 64, max: 64 },
        },
        async handle(input): Promise<unknown> {
          const session = await chunkStore.create({
            filename: String(input.filename),
            size: Number(input.size),
            chunkSize: Number(input.chunkSize),
            sha256: String(input.sha256).toLowerCase(),
          });
          return reply.json(
            {
              uploadId: session.uploadId,
              totalChunks: chunkStore.totalChunks(session),
              received: session.received,
              missing: chunkStore.missingChunks(session),
              expiresAt: session.expiresAt,
            },
            { status: 201 },
          );
        },
      }),
    ),

    put(
      `${prefix}/chunked/:uploadId/:index`,
      defineController({
        input: { uploadId: { type: 'string', min: 1 }, index: { type: 'string', min: 1 } },
        async handle(input, ctx): Promise<unknown> {
          const stream = (ctx as unknown as { stream?: AsyncIterable<Uint8Array> }).stream;
          if (stream === undefined) throw new HttpError(500, '分片路由没有拿到请求流（httpPlugin 未启用流式？）');
          const expected = ctx.header('x-chunk-sha256');
          const { session } = await chunkStore.putChunk(
            String(input.uploadId),
            Number(input.index),
            stream,
            expected === undefined ? undefined : expected.toLowerCase(),
          );
          return reply.json({
            uploadId: session.uploadId,
            received: session.received,
            missing: chunkStore.missingChunks(session),
          });
        },
      }),
    ),

    get(
      `${prefix}/chunked/:uploadId`,
      defineController({
        input: { uploadId: { type: 'string', min: 1 } },
        async handle(input): Promise<unknown> {
          const session = await chunkStore.get(String(input.uploadId));
          if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${String(input.uploadId)}`);
          return {
            uploadId: session.uploadId,
            filename: session.filename,
            size: session.size,
            chunkSize: session.chunkSize,
            sha256: session.sha256,
            totalChunks: chunkStore.totalChunks(session),
            received: session.received,
            missing: chunkStore.missingChunks(session),
            expiresAt: session.expiresAt,
          };
        },
      }),
    ),

    post(
      `${prefix}/chunked/:uploadId/complete`,
      defineController({
        input: { uploadId: { type: 'string', min: 1 } },
        async handle(input): Promise<unknown> {
          const uploadId = String(input.uploadId);
          const session = await chunkStore.get(uploadId);
          if (session === null) throw new HttpError(404, `上传会话不存在或已过期：${uploadId}`);
          const missing = chunkStore.missingChunks(session);
          if (missing.length > 0) throw new HttpError(400, `还有分片没收到：${missing.join(',')}`);

          const file = await options.storage.put(chunkStore.readAll(uploadId), {
            name: session.filename,
            mimeType: 'application/octet-stream',
            extension: extensionOf(session.filename),
          });
          if (file.checksum !== session.sha256) {
            // 整文件哈希不符：分片数据不可信 → 作废会话，并把期望/实际报出去
            await options.storage.delete(file.key);
            await chunkStore.remove(uploadId);
            throw new HttpError(400, '整文件 sha256 不符（分片数据不可信，已作废会话）', {
              expected: session.sha256,
              actual: file.checksum,
            });
          }
          await chunkStore.remove(uploadId);
          return reply.json({ file }, { status: 201 });
        },
      }),
    ),

    del(
      `${prefix}/chunked/:uploadId`,
      defineController({
        input: { uploadId: { type: 'string', min: 1 } },
        async handle(input): Promise<unknown> {
          const removed = await chunkStore.remove(String(input.uploadId));
          return reply.json({ removed });
        },
      }),
    ),
  ]);

  return defineWebPlugin({
    name: 'upload',
    routes: routes as unknown as readonly Route[],
    config: {
      maxFileSize: { type: 'number' as const, default: limits.maxFileSize },
      maxFiles: { type: 'number' as const, default: limits.maxFiles },
    },
    middleware: [],
    // 把"要流式的路径"和存储注册成服务：httpPlugin 读前者决定不缓冲，别的模块可以读后者
    setup: (app: { provide?(name: string, value: unknown): void }) => {
      app.provide?.(STREAM_ROUTES_SERVICE, matcherFor(streamPatterns));
      app.provide?.(UPLOAD_STORAGE_SERVICE, options.storage);
      app.provide?.('upload', options.storage);
    },
  });
}

export { diskChunkStore };
