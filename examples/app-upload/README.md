# app-upload：文件上传（流式 + 大文件分片 + 断点续传 + sha256）

一个能直接跑起来的完整示例：后端用 `uploadPlugin()`，前端页面由示例自己托管（**同源**，不需要 CORS）。

```bash
cd examples/app-upload
node main.ts        # 打印 listening on http://127.0.0.1:PORT
# 浏览器打开那个地址 → 页面里可以选文件上传（小文件一次传 / 大文件分片续传）
```

数据落在 `examples/app-upload/data/`（`files/` 是成品文件、`chunks/` 是分片会话；可用 `APP_UPLOAD_DIR` 改）。

## 后端协议（`uploadPlugin()`，前缀默认 `/uploads`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | `multipart/form-data` 单/多文件；**流式**落盘，超限**立刻** 413；失败**全回滚** |
| GET | `/uploads/:key` | 回读（带 `content-type` 与 `Content-Disposition`、`x-content-sha256`） |
| POST | `/uploads/chunked/init` | `{filename,size,chunkSize,sha256}` → `{uploadId,totalChunks,received,missing,expiresAt}` |
| PUT | `/uploads/chunked/:uploadId/:index` | 分片体；`x-chunk-sha256` **逐片校验**；同一片**幂等可重传** |
| GET | `/uploads/chunked/:uploadId` | **断点续传状态**：`received` / `missing` / `expiresAt` |
| POST | `/uploads/chunked/:uploadId/complete` | 按序合并 → **整文件 sha256 校验**；不符则 400 并给出 `expected`/`actual`，同时作废会话 |
| DELETE | `/uploads/chunked/:uploadId` | 作废会话（清理分片） |

约定：`chunkSize` **最小 5MiB**（太小只会把请求数搞爆）；`sha256` 是**整文件**内容的 sha256（64 位十六进制小写）；
会话默认 24h 过期（`diskChunkStore({ dir, ttlMs })` 可调）。

## 前端示例（`src/demo-page.ts` 里有完整可跑版本）

要点：**整文件 sha256 用 WebCrypto 算**、分片**并发**、失败**重试**、刷新后靠 `localStorage` 里的 `uploadId`
**先查状态再补缺口**。

```js
const CHUNK = 5 * 1024 * 1024;   // 必须 >= 5MiB
const CONCURRENCY = 4;
const RETRIES = 3;

/** WebCrypto 算 sha256（十六进制） */
async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 上传单个分片（带重试；每片都带 sha256，服务端逐片校验） */
async function putChunk(uploadId, index, blob) {
  const chunkSha = await sha256Hex(blob);
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(`/uploads/chunked/${uploadId}/${index}`, {
        method: 'PUT',
        headers: { 'x-chunk-sha256': chunkSha },
        body: blob,
      });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`分片 ${index} 被拒：${res.status}`);
    } catch (err) {
      if (attempt === RETRIES) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));   // 退避重试
  }
}

/** 上传整个文件：init → 并发补缺口 → complete */
async function uploadFile(file) {
  const sha256 = await sha256Hex(file);                        // 整文件 sha256（complete 时后端核对）
  const init = await (await fetch('/uploads/chunked/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, chunkSize: CHUNK, sha256 }),
  })).json();
  localStorage.setItem('upload', JSON.stringify({ uploadId: init.uploadId, name: file.name }));

  const queue = [...init.missing];                             // init 就已经告诉我们缺哪些
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const blob = file.slice(index * CHUNK, Math.min((index + 1) * CHUNK, file.size));
      await putChunk(init.uploadId, index, blob);
    }
  }));

  const res = await fetch(`/uploads/chunked/${init.uploadId}/complete`, { method: 'POST' });
  const text = await res.text();
  if (!res.ok) throw new Error(`complete 失败：${res.status} ${text}`);   // sha256 不符会在这里报期望/实际
  localStorage.removeItem('upload');
  return JSON.parse(text).file;
}

/** 断点续传：刷新/断网后回来，先问服务端还缺什么，再补 */
async function resume(file) {
  const saved = JSON.parse(localStorage.getItem('upload') || 'null');
  if (!saved) return uploadFile(file);
  const res = await fetch(`/uploads/chunked/${saved.uploadId}`);
  if (res.status === 404) return uploadFile(file);             // 会话过期 → 重新来
  const { missing, totalChunks } = await res.json();
  const queue = [...missing];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      await putChunk(saved.uploadId, index, file.slice(index * CHUNK, Math.min((index + 1) * CHUNK, file.size)));
    }
  }));
  return (await (await fetch(`/uploads/chunked/${saved.uploadId}/complete`, { method: 'POST' })).json()).file;
}

/** 小文件就直接一次 multipart（单/多文件都走这条） */
async function uploadSmall(files) {
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);
  const res = await fetch('/uploads', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`上传失败：${res.status} ${await res.text()}`);
  return (await res.json()).files;      // [{key,name,mimeType,size,checksum,uploadedAt}]
}
```

## 换成别的存储

```ts
import { defineUploadStorage, uploadPlugin, type UploadStorage } from '@actor/web';

const s3: UploadStorage = defineUploadStorage({
  async put(stream, meta) { /* 边读流边传给 S3，返回 { key, name, mimeType, size, checksum, uploadedAt } */ },
  async get(key) { /* ... */ },
  async stat(key) { /* ... */ },
  async delete(key) { /* ... */ },
});

uploadPlugin({ storage: s3, chunkStore: diskChunkStore({ dir: './data/chunks' }) });
```

自己写的存储建议先跑契约套件自证合规：

```ts
import { runUploadStorageContract } from '@actor/web';
runUploadStorageContract({ name: 'my-s3', make: () => s3, supportsList: true });
```
