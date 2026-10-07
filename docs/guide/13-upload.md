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

见示例的 [`examples/app-upload/README.md`](../../examples/app-upload/README.md)：整文件 sha256 用 **WebCrypto** 算、
分片**并发**（默认 4）、失败**退避重试**、把 `uploadId` 存 `localStorage`，
**续传时先 `GET /uploads/chunked/:id` 拿 `missing`，只补缺口**再 `complete`。

## 明确不做（v1）

- 断点续传的"秒传"（相同 sha256 直接复用）：需要内容寻址存储与去重策略，另立设计；
- 下载侧 Range/流式响应（当前回读是整块返回，注意大文件的内存占用）；
- 图片转码、病毒扫描、分片并行度服务端限流。
