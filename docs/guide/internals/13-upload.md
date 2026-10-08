# 文件上传（流式 / 大文件分片 / 断点续传）

`uploadPlugin()`（`@actor/web`）给三件事：**流式**小文件上传、**分片 + 断点续传**的大文件上传、
以及一套可替换的**存储契约**。

```bash
# 完整可跑示例（自带前端页面，同源，不需要 CORS）
cd examples/app-upload && node main.ts
```

## 装进应用

```ts
import { diskChunkStore, httpPlugin, localDiskStorage, uploadPlugin } from '@actor/web';

export default defineApp({
  modules: [myModule],
  plugins: [
    uploadPlugin({
      storage: localDiskStorage({ dir: './data/files' }),
      chunkStore: diskChunkStore({ dir: './data/chunks' }),  // 磁盘 → 进程重启仍能续传
      limits: { maxFileSize: 2 * 1024 * 1024 * 1024, maxFiles: 10 },
    }),
    httpPlugin({ port: 3000 }),
  ],
});
```

路由（前缀默认 `/uploads`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | multipart 单/多文件；流式落盘、超限**立刻** 413、失败**全回滚** |
| GET | `/uploads/:key` | 回读（带 content-type / Content-Disposition / x-content-sha256） |
| POST | `/uploads/chunked/init` | 声明 `filename/size/chunkSize/sha256` → 会话 + 已收/缺失分片 |
| PUT | `/uploads/chunked/:uploadId/:index` | 分片体（`x-chunk-sha256` 逐片校验，幂等可重传） |
| GET | `/uploads/chunked/:uploadId` | 断点续传状态（`received`/`missing`/`expiresAt`） |
| POST | `/uploads/chunked/:uploadId/complete` | 合并 + **整文件 sha256 校验**（不符给出 expected/actual 并作废会话） |
| DELETE | `/uploads/chunked/:uploadId` | 作废会话 |

## 限额（分片路径也有，且都在 init 就挡住）

| 选项 | 默认 | 作用 |
|---|---|---|
| `maxChunkSize` | 64MiB | 单分片上限（也决定内存安全边界：写入是**流式**的，不整片进内存） |
| `maxUploadSize` | 5GiB | 整份上传上限（防"声明一个 10TB 会话慢慢填磁盘"） |
| `maxActiveSessions` | 不限 | 并发会话上限（会话存储要实现 `countActive()`；不支持则**启动期拒绝**，不静默失效） |
| `purgeIntervalMs` | 10 分钟 | 过期会话/分片清理间隔（`0` = 不自动清理）；启动时也会清一次 |
| `requireChunkSha256` | `false` | 是否强制逐片 `x-chunk-sha256`（**建议开启**：把损坏挡在写入时） |
| `ttlMs` / `hardTtlMs` | 24h / 7 天 | 活动**滑动**续期，但绝不越过绝对上限 |

## 鉴权：**不强制**，有就验证、没有就放行

- 会话会记录上传者（`ctx.user.sub`，装了 `authPlugin` 才有）；
- **匿名会话**（没有鉴权）→ 一律放行 —— 很多场景就是没有登录体系，不能强制；
- **有主会话** → 只有本人能查状态/传分片/完成/作废，别人一律 **404**（不暴露"这个会话存在"）；
- 想额外要求鉴权（装了 authPlugin 时才生效）：`uploadPlugin({ auth: { required: true, roles: ['uploader'] } })`
  —— 它只是**写进控制器声明**，没装 authPlugin 就是空声明、不拦任何人。

## 完成后可以安全重试（幂等）

`complete` 成功后**会话会保留一段宽限期**（默认 15 分钟，`completedGraceMs` 可调）并记住结果，分片数据同时释放。
于是：响应在网络里丢了，客户端**再发一次 `complete`** 就能拿回同一个 `file`（返回 `reused: true`），
不需要整份重传；`GET /uploads/chunked/:uploadId` 也能查回 `completed.file`。

## 默认就是安全的

- **key 由服务端生成**（`uuid` + 白名单扩展名），客户端给的 `filename` **只当元数据**，且会被剥掉路径成分；
- `allowedMimeTypes` / `allowedExtensions` 白名单（给了就强制，不符 415）；
- 三个上限：`maxFileSize`（**每文件**）/ `maxFiles` / `maxFieldSize`，超限 413（流式发现，不先吃进内存）；
- 分片：`chunkSize` 最小 5MiB、分片大小必须**精确匹配**（末片按剩余算）、逐片 sha256、整文件 sha256；
- `uploadId` 必须形如 uuid（不让它变成路径）。

## 存储是可替换的

```js verify
import { localDiskStorage, memoryUploadStorage, diskChunkStore } from '@actor/web';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-upload-guide-'));
const storage = localDiskStorage({ dir });
const payload = Buffer.from('hello upload');

// 流式写入：边写边算 sha256，返回服务端生成的 key
const file = await storage.put((async function* () { yield payload; })(), {
  name: '../../etc/passwd',        // 原始文件名只当元数据
  mimeType: 'text/plain',
  extension: 'txt',
});
console.log('key =', file.key, '| size =', file.size);
if (file.key.includes('/') || file.key.includes('..')) throw new Error('key 不能是路径');
if (file.checksum !== createHash('sha256').update(payload).digest('hex')) throw new Error('checksum 必须是内容 sha256');

// 回读
const read = await storage.get(file.key);
const parts = [];
for await (const chunk of read.stream) parts.push(chunk);
if (Buffer.concat(parts).toString() !== 'hello upload') throw new Error('回读内容不一致');

// 内存实现同样满足契约（小规模部署/测试）
const memory = memoryUploadStorage();
await memory.put((async function* () { yield Buffer.from('x'); })(), { name: 'x', mimeType: 'text/plain' });

// 分片会话存储：内存 or 磁盘（磁盘重启后仍可续传）
const chunks = diskChunkStore({ dir: path.join(dir, 'chunks') });
const session = await chunks.create({ filename: 'big.bin', size: 5 * 1024 * 1024, chunkSize: 5 * 1024 * 1024, sha256: 'a'.repeat(64) });
console.log('会话 →', session.uploadId, '| 总分片 =', chunks.totalChunks(session), '| 缺失 =', chunks.missingChunks(session).join(','));
await chunks.remove(session.uploadId);
fs.rmSync(dir, { recursive: true, force: true });
```

自己写存储（S3/OSS/MinIO）时先跑契约套件：

```ts
runUploadStorageContract({ name: 'my-s3', make: () => myS3Storage, supportsList: true });
runChunkStoreContract({ name: 'my-store', make: () => myStore, reopen: () => myStoreOnSameData });
```

> `reopen` 那一项就是**断点续传**的关键：换一个实例（模拟重启）后仍要能看到已收分片。

## 前端怎么配合

见示例的 [`examples/app-upload/README.md`](../../../examples/app-upload/README.md)：整文件 sha256 用 **WebCrypto** 算、
分片**并发**（默认 4）、失败**退避重试**、把 `uploadId` 存 `localStorage`，
**续传时先 `GET /uploads/chunked/:id` 拿 `missing`，只补缺口**再 `complete`。

## 明确不做（v1）

- 断点续传的"秒传"（相同 sha256 直接复用）：需要内容寻址存储与去重策略，另立设计；
- 下载侧 Range/流式响应（当前回读是整块返回，注意大文件的内存占用）；
- 图片转码、病毒扫描、分片并行度服务端限流。
