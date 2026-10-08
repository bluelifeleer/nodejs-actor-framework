# 16. 邮件：发出去、离线能验

## 1. 装插件（两条路）

```ts
import { mailPlugin } from '@actor/mail';

// 路线 A：写 .eml 到目录（**零依赖、离线可真验**：产物就是标准邮件文件）
plugins: [mailPlugin({ driver: 'file', dir: './data/mail' })],

// 路线 B：真发 SMTP（懒加载 nodemailer，可选依赖）
plugins: [mailPlugin({ driver: 'smtp', url: 'smtp://user:pass@smtp.example.com:587' })],

// 路线 C：自己的传输（Resend/SES/自建网关…）
plugins: [mailPlugin({ transport: myTransport })],
```

配置也可走 schema（`plugins.mail.url` / `plugins.mail.dir`，即 `APP_PLUGINS__MAIL__URL`）。

## 2. 发信

```ts
import type { MailTransport } from '@actor/mail';
import type { ManagedResource } from '@actor/resource';

const notify = defineController({
  input: { to: 'string', subject: 'string', text: 'string' },
  handle: async (input, ctx) => {
    // ctx.get('mail') 是**受管资源**（负责连接/探活/关闭），真正的 transport 在资源里；
    // acquire() 拿到的就是 transport（fileTransport / SMTP / 你自装的）
    const resource = ctx.get('mail') as ManagedResource<MailTransport>;
    const mail = await resource.acquire();
    const result = await mail.send({
      from: { name: 'My App', address: 'no-reply@example.com' },
      to: [String(input.to)],
      subject: String(input.subject),
      text: String(input.text),
      html: `<p>${String(input.text)}</p>`,     // 可选：同时给纯文本与 HTML
      // attachments: [{ filename: 'a.pdf', content: bytes, contentType: 'application/pdf' }],
    });
    return { id: result.id, accepted: result.accepted, rejected: result.rejected };
  },
});
```

`send()` 的返回：`{ id, accepted, rejected, detail? }` —— `id` 是传输层给的标识
（`fileTransport` 是文件路径，SMTP 是 messageId），排障靠它。

**传输层不做重试/队列**：`send` 失败就抛错，要不要重试是你的语义层的事
（可以放进 Actor 做串行重试、或落 outbox）。框架不在这里假装有保证。

## 3. 自装传输：先校验再发

走 HTTP API 的传输**不渲染邮件**，所以"没有收件人""主题里藏 CRLF（头部注入）"这两个洞要自己堵。
框架把规则做成了单一来源：

```ts
import { assertSendable, defineMailTransport, type MailMessage } from '@actor/mail';

export const resendTransport = (options: { endpoint: string; apiKey: string }) =>
  defineMailTransport({
    kind: 'resend',
    driverPackage: 'resend',
    async send(message: MailMessage) {
      assertSendable(message);          // ← 必须：没有收件人 / 头部注入都在这里被拒
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, text: message.text }),
      });
      if (!response.ok) throw new Error(`resend: send failed (${String(response.status)})`);
      const payload = await response.json();
      return { id: payload.id, accepted: message.to.map((item) => item.address), rejected: [] };
    },
  });
```

写完之后用**已发布的契约套件**自证合规（`test/contract.test.ts`）：

```ts
import { runMailTransportContract } from '@actor/mail';
runMailTransportContract({ name: 'resend', make: () => resendTransport({ endpoint: '…', apiKey: '…' }) });
```

## 4. 跑一遍（真写 `.eml` + 真解析，CI 真执行）

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, httpPlugin, post } = await import(`${repo}packages/web/src/index.ts`);
const { assertSendable, fileTransport, mailPlugin, parseMailHeaders, renderMail } = await import(
  `${repo}packages/mail/src/index.ts`
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-mail-'));

// ① 渲染：中文主题用 RFC 2047 编码、MIME 结构标准（离线可断言）
const rendered = renderMail({
  from: { name: '测试发件人', address: 'from@example.com' },
  to: [{ address: 'to@example.com' }],
  subject: '中文主题 🙂',
  text: '纯文本正文',
  html: '<p>HTML 正文</p>',
});
const headers = parseMailHeaders(rendered.raw);
assert.match(headers['subject'] ?? '', /=\?UTF-8\?/, '非 ASCII 主题必须按 RFC 2047 编码');
// 非 ASCII 正文按 base64 传输（MIME 标准做法），所以解码后再断言
const textPart = /Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(rendered.raw)?.[1] ?? '';
assert.strictEqual(Buffer.from(textPart.trim(), 'base64').toString('utf8'), '纯文本正文', '正文要能解出来');

// ② 发送前的校验是单一来源：没有收件人 / 头部注入都要被拒
assert.throws(() => assertSendable({ from: { address: 'a@b.c' }, to: [], subject: 'x', text: '' }), /至少一个收件人/);
assert.throws(
  () => assertSendable({ from: { address: 'a@b.c' }, to: [{ address: 'c@d.e' }], subject: 'a\r\nBcc: evil@x.y', text: '' }),
  /不允许出现换行/,
);

// ③ 端到端：控制器 → 服务 → fileTransport 真的落一个 .eml
const notify = defineController({
  input: { to: 'string', subject: 'string', text: 'string' },
  handle: async (input, ctx) => {
    // 受管资源 → acquire() 拿到 transport
    const resource = ctx.get('mail');
    const mail = await resource.acquire();
    return mail.send({
      from: { address: 'no-reply@example.com' },
      to: [String(input.to)],
      subject: String(input.subject),
      text: String(input.text),
    });
  },
});

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [defineModule({ name: 'app', routes: defineRoutes([post('/notify', notify)]) })],
    plugins: [http, mailPlugin({ transport: fileTransport({ dir }) })],
  }),
  { configDir: null, env: {} },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  const sent = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'someone@example.com', subject: '你好', text: '正文' }),
  });
  const sentText = await sent.text();
  assert.strictEqual(sent.status, 200, `发信应当成功：${sentText}`);
  const result = JSON.parse(sentText);
  assert.deepStrictEqual(result.accepted, ['someone@example.com']);
  assert.deepStrictEqual(result.rejected, []);
  assert.ok(fs.existsSync(String(result.id)), 'fileTransport 的 id 就是落盘路径，文件必须真的在');
  assert.match(fs.readFileSync(String(result.id), 'utf8'), /someone@example\.com/);

  // 非法消息走 HTTP 也要是 4xx/5xx 而不是静默成功（这里给的是空 to → 服务端错误可见）
  const bad = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: '', subject: 'x', text: '' }),
  });
  assert.ok(bad.status >= 400, `非法收件人必须失败：${String(bad.status)}`);
} finally {
  await app.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 5. 相关

- 自装传输的完整契约（幂等 `verify`/`close`、真实投递开关）→ [internals/16-mail](./internals/16-mail.md)
- 邮件失败要有日志/重试：用 Actor 串行化 + 自己的重试策略 → [12 Actor 与状态](./12-actors-state.md)
- 报错排查 → [19 排错手册](./19-troubleshooting.md)
