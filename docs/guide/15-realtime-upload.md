# 15. 实时（WebSocket）与文件上传

**你会得到**：WebSocket 推送（含共享端口）与文件上传（含分片、大小限制、413 语义）

**前置**：有可跑的 HTTP 项目　**耗时**：18 分钟

两条独立的能力，按需装：`wsPlugin`（推送/双向）与 `uploadPlugin`（收文件）。

## 一、WebSocket

### 1. 装插件 + 写路由

```ts
import { defineController, defineRoutes, ws, wsPlugin } from '@actor/web';

const http = httpPlugin({ port: 9000 });
const wsServer = wsPlugin();      // 不配 port → 与 HTTP **共享端口**；配了就是独立端口

plugins: [http, wsServer],

routes: defineRoutes([
  ws('/chat/:room?token=', defineController({
    input: {
      room: { from: 'params', type: 'string' },
      token: { from: 'query', type: 'string', default: 'none' },
      // 消息体：**每条消息**都过一遍输入校验（与 HTTP 同一套规则）
      type: 'string',
      text: 'string',
    },
    handle: (input) => ({ room: input.room, token: input.token, type: input.type, text: input.text }),
  })),
]),
```

**WS 与 HTTP 的语义完全一致**：路径参数、查询参数、输入校验（失败回 `{ error: { status: 400, details } }`）、
中间件链（全局 → 路由 → 控制器）、`ctx.actor(...)`、错误映射（404/400/500…）。
差别只有一条：**每条消息触发一次 `handle`**，连接本身归框架（"连接在框架、状态在 Actor"）。

| 事项 | 说明 |
|---|---|
| 端口 | 不写 `port` → 与 HTTP 同端口（推荐，少一个暴露面）；独立端口用于隔离流量 |
| 推送 | 控制器里 `ctx.get('wsConnections')` 拿连接注册表，按 id/playerId 主动推 |
| 关闭 | 停服务时框架先发 `1001 server shutting down`，等连接排空（有超时兜底） |
| 连接标识 | 用 `wsPlugin({ identify: (req) => ... })` 返回 `playerId`，否则自动 `ws-<序号>` |

### 2. 客户端怎么连

浏览器用原生 `WebSocket`；Node 里可以用内置的 `WebSocket`（Node ≥ 22）或内核的 `connect()` 辅助：

```js
const socket = new WebSocket('ws://127.0.0.1:9000/chat/lobby?token=t1');
socket.onmessage = (event) => console.log(JSON.parse(event.data));
socket.onopen = () => socket.send(JSON.stringify({ type: 'say', text: 'hi' }));
```

### 3. 跑一遍（真连接，CI 真执行）

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, ws, wsPlugin } = await import(`${repo}packages/web/src/index.ts`);

const server = wsPlugin({ port: 0 });     // 文档里用随机端口，避免和本机抢
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'chat',
        routes: defineRoutes([
          ws('/chat/:room?token=', defineController({
            input: {
              room: { from: 'params', type: 'string' },
              token: { from: 'query', type: 'string', default: 'none' },
              type: 'string',                     // 必填：没给就是 400
              text: { type: 'string', default: '' },
            },
            handle: (input) => ({ room: input.room, token: input.token, type: input.type, text: input.text }),
          })),
        ]),
      }),
    ],
    plugins: [server],
  }),
  { configDir: null, env: {} },
);
await app.start();
const port = server.address()?.port;
assert.ok(typeof port === 'number' && port > 0, 'start() 之后端口就绪');

const nextMessage = (socket) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等消息超时')), 5000);
    socket.addEventListener('message', (event) => { clearTimeout(timer); resolve(JSON.parse(String(event.data))); }, { once: true });
  });
const open = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => resolve(socket), { once: true });
  socket.addEventListener('error', reject, { once: true });
});

try {
  const socket = await open(`ws://127.0.0.1:${String(port)}/chat/lobby?token=t1`);
  socket.send(JSON.stringify({ type: 'say', text: 'hi' }));
  assert.deepStrictEqual(await nextMessage(socket), { room: 'lobby', token: 't1', type: 'say', text: 'hi' },
    '路径参数 + 查询参数 + 消息体三者合一');

  // 校验失败：与 HTTP 同一套错误形状
  socket.send(JSON.stringify({ text: '没有 type' }));
  const invalid = await nextMessage(socket);
  assert.strictEqual(invalid.error.status, 400);
  assert.strictEqual(invalid.error.details.issues[0].path, 'type');
  socket.close();

  // 没有对应 WS 路由的路径 → 404
  const unknown = await open(`ws://127.0.0.1:${String(port)}/nope`);
  unknown.send(JSON.stringify({ type: 'x' }));
  assert.strictEqual((await nextMessage(unknown)).error.status, 404);
  unknown.close();
} finally {
  await app.stop();
}
console.log('ok');
```

## 二、文件上传

### 1. 装插件

```ts
import { uploadPlugin, localDiskStorage } from '@actor/web';

plugins: [
  uploadPlugin({
    storage: localDiskStorage({ dir: './data/uploads' }),     // 换 S3/OSS 就换一个 UploadStorage
    allowedMimeTypes: ['image/png', 'image/jpeg'],            // 白名单（可选）
    maxUploadSize: 20 * 1024 * 1024,                          // 整份上限（init 阶段就挡）
    maxActiveSessions: 100,                                   // 会话上限（存储要支持 countActive）
    requireChunkSha256: true,                                 // 分片必须带 hash（建议开）
  }),
],
```

### 2. 路由一览（默认前缀 `/uploads`）

| 方法/路径 | 用途 |
|---|---|
| `POST /uploads` | multipart 单/多文件（**全成功或全回滚**） |
| `GET /uploads/:key` | 回读（带 `content-type` 与 `Content-Disposition`） |
| `POST /uploads/chunked/init` | 声明 filename/size/chunkSize/整文件 sha256 → `uploadId` + 已收分片 |
| `PUT /uploads/chunked/:uploadId/:index` | 传分片（`x-chunk-sha256` 逐片校验，幂等可重传） |
| `GET /uploads/chunked/:uploadId` | 断点续传状态（已收/缺失/过期） |
| `POST /uploads/chunked/:uploadId/complete` | 合并 + 整文件 sha256 校验（不符**拒绝并作废**） |
| `DELETE /uploads/chunked/:uploadId` | 作废会话（清理分片） |

> `/uploads` 是**框架保留前缀**：你自己的路由不要落在里面（会在启动期报错）；
> 要换前缀就 `uploadPlugin({ routePrefix: '/files' })`。

### 3. 浏览器端（multipart 直传）

```js
const form = new FormData();
form.append('file', fileInput.files[0]);
await fetch('/uploads', { method: 'POST', body: form });      // 响应里是 { files: [...] }
```

大文件/弱网用分片：`init` → 逐片 `PUT`（可并发、可重传）→ `complete`。
网络断了就 `GET /uploads/chunked/:uploadId` 查缺哪片，接着传（断点续传）。

### 4. 归属校验（可选）

带 `authPlugin` 时，会话会记住创建者的 `sub`：**有主会话只有本人能续传/完成**（他人得到 404，不暴露"会话存在"）。
匿名会话（没有登录）一律放行 —— 没鉴权体系时不该拦人。

### 5. 跑一遍（真 multipart 上传 + 回读，CI 真执行）

```js verify
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { httpPlugin, localDiskStorage, uploadPlugin } = await import(`${repo}packages/web/src/index.ts`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-upload-'));
const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [defineModule({ name: 'app' })],
    plugins: [
      http,
      uploadPlugin({
        storage: localDiskStorage({ dir }),
        // 三层上限都要设，否则大的那份会先被默认的 64MiB 单文件上限放过：
        //   limits.maxFileSize（单个文件，默认 64MiB）/ maxUploadSize（整份请求）/ limits.maxFiles（个数）
        maxUploadSize: 1024 * 1024,
        limits: { maxFileSize: 1024 * 1024 },
      }),
    ],
  }),
  { configDir: null, env: {} },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  // ① multipart 上传（Node 内置 FormData/Blob，不需要任何依赖）
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello upload')], { type: 'text/plain' }), 'hello.txt');
  const uploaded = await fetch(`${base}/uploads`, { method: 'POST', body: form });
  const uploadedText = await uploaded.text();     // body 只能读一次：先读文本，再按需解析
  assert.strictEqual(uploaded.status, 201, `上传应当 201：${uploadedText}`);
  const payload = JSON.parse(uploadedText);
  assert.strictEqual(payload.files.length, 1);
  const file = payload.files[0];
  assert.strictEqual(file.name, 'hello.txt');
  assert.strictEqual(file.size, 'hello upload'.length);

  // ② 回读：内容一致，且带 content-type
  const back = await fetch(`${base}/uploads/${String(file.key)}`);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(await back.text(), 'hello upload');
  assert.match(back.headers.get('content-type') ?? '', /text\/plain/);

  // ③ 不存在的 key → 404（不是 500）
  assert.strictEqual((await fetch(`${base}/uploads/nope`)).status, 404);

  // ④ 超限：整体上限 1MiB → 413（在写盘前就挡）
  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024)], { type: 'application/octet-stream' }), 'big.bin');
  const tooBig = await fetch(`${base}/uploads`, { method: 'POST', body: big });
  assert.strictEqual(tooBig.status, 413, `超限必须被拒：${tooBig.status}`);

  // ⑤ 分片：init → 传片 → complete → 回读
  //    分片是给**大文件**用的，所以这里另起一个"宽松上限"的应用实例：
  //    chunkSize 下限是 5MiB（太小只会把请求数搞爆；S3 也是这个量级），
  //    而上面那个实例的 maxUploadSize 只有 1MiB（为了演示 413），没法传分片。
  const looseHttp = httpPlugin({ port: 0, accessLog: false });
  const looseApp = createApp(
    defineApp({
      modules: [defineModule({ name: 'app' })],
      plugins: [looseHttp, uploadPlugin({ storage: localDiskStorage({ dir }) })],
    }),
    { configDir: null, env: {} },
  );
  await looseApp.start();
  const looseBase = `http://127.0.0.1:${String(looseHttp.address()?.port)}`;
  try {
    const chunk = Buffer.alloc(5 * 1024 * 1024, 7);
    const init = await fetch(`${looseBase}/uploads/chunked/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 整文件 sha256 是 init 的**必填**声明：complete 时会核对（不符就拒绝并作废会话）
      body: JSON.stringify({
        filename: 'part.bin',
        size: chunk.length,
        chunkSize: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex'),
      }),
    });
    const initText = await init.text();
    assert.strictEqual(init.status, 201, `init 应当 201：${initText}`);
    const session = JSON.parse(initText);
    assert.deepStrictEqual(session.received, [], '刚 init 时一片都没收到');

    const put = await fetch(`${looseBase}/uploads/chunked/${String(session.uploadId)}/0`, { method: 'PUT', body: chunk });
    assert.strictEqual(put.status, 200, `传片应当 200：${await put.text()}`);

    const status = await (await fetch(`${looseBase}/uploads/chunked/${String(session.uploadId)}`)).json();
    assert.deepStrictEqual(status.missing, [], '断点续传状态应当显示已经收全');

    const done = await fetch(`${looseBase}/uploads/chunked/${String(session.uploadId)}/complete`, { method: 'POST' });
    const doneText = await done.text();
    assert.strictEqual(done.status, 201, `complete 应当 201：${doneText}`);
    const finished = JSON.parse(doneText);
    const chunked = await fetch(`${looseBase}/uploads/${String(finished.file.key)}`);
    assert.strictEqual((await chunked.arrayBuffer()).byteLength, chunk.length, '分片合并后的文件大小要对');
  } finally {
    await looseApp.stop();
  }
} finally {
  await app.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 三、相关

- 上传的存储契约（自己实现 S3/OSS）→ [internals/13-upload](./internals/13-upload.md)
- WS 的中间件与鉴权（`requireRole` 也能用在 WS 路由上）→ [10 路由与请求](./10-http-routing.md)、[13 鉴权](./13-auth.md)
- 上传/WS 相关报错 → [19 排错手册](./19-troubleshooting.md)

## 下一步


- [13 鉴权](./13-auth.md)
- [18 可观测与上线](./18-observability-deploy.md)
