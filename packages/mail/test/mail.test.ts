import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realResourceUrl, testWithResource } from '@actor/resource';

import { parseMailHeaders, renderMail, type MailMessage } from '../src/message.ts';
import { renderTemplate, escapeHtml } from '../src/render.ts';
import { fileTransport, runMailTransportContract, type MailTransport } from '../src/transport.ts';
import { smtpTransport } from '../src/smtp.ts';
import { mailPlugin } from '../src/plugin.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'actor-mail-'));
const base: MailMessage = {
  from: { name: '发件人', address: 'from@example.com' },
  to: ['to@example.com'],
  subject: '中文主题 🙂',
  text: '纯文本',
};

// --- 消息与 MIME 渲染 -------------------------------------------------------
test('mail: 中文主题走 RFC 2047 encoded-word，头部可解析回来', () => {
  const rendered = renderMail(base);
  const headers = parseMailHeaders(rendered.raw);
  assert.match(headers['subject'] ?? '', /^=\?UTF-8\?B\?/, '非 ASCII 主题必须编码');
  const decoded = Buffer.from((headers['subject'] ?? '').replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8');
  assert.strictEqual(decoded, '中文主题 🙂');
  assert.strictEqual(headers['from']?.includes('=?UTF-8?B?'), true, '显示名也要编码');
  assert.strictEqual(rendered.envelope.from, 'from@example.com');
  assert.deepStrictEqual(rendered.envelope.to, ['to@example.com']);
});

test('mail: 纯文本 + HTML → multipart/alternative；附件 → multipart/mixed + base64', () => {
  const alternative = renderMail({ ...base, html: '<p>hi</p>' });
  assert.match(alternative.raw, /Content-Type: multipart\/alternative; boundary="alt-/);
  assert.match(alternative.raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(alternative.raw, /Content-Type: text\/html; charset=utf-8/);

  const withAttachment = renderMail({
    ...base,
    attachments: [{ filename: '报表.csv', content: 'a,b\r\n1,2\r\n', contentType: 'text/csv' }],
  });
  assert.match(withAttachment.raw, /Content-Type: multipart\/mixed; boundary="mix-/);
  assert.match(withAttachment.raw, /Content-Transfer-Encoding: base64/);
  assert.match(withAttachment.raw, /Content-Disposition: attachment; filename="=\?UTF-8\?B\?/, '附件名也要编码');
  const encodedBody = Buffer.from('a,b\r\n1,2\r\n', 'utf8').toString('base64');
  assert.ok(withAttachment.raw.includes(encodedBody), '附件内容必须是 base64');
});

test('mail: 头部注入与非法地址一律拒绝（CR/LF 不能进头部）', () => {
  assert.throws(() => renderMail({ ...base, subject: 'x\r\nBcc: evil@example.com' }), /不允许出现换行/);
  assert.throws(() => renderMail({ ...base, to: ['a@b.com\r\nBcc: evil@example.com'] }), /不允许出现换行/);
  assert.throws(() => renderMail({ ...base, from: { name: 'x\r\nBcc: e@x', address: 'f@x.com' } }), /不允许出现换行/);
  assert.throws(() => renderMail({ ...base, headers: { 'X-Custom': 'ok\r\nInjected: 1' } }), /不允许出现换行/);
  assert.throws(() => renderMail({ ...base, attachments: [{ filename: 'a\r\nb', content: 'x' }] }), /不允许出现换行/);
  assert.throws(() => renderMail({ ...base, to: [] }), /至少一个收件人/);
  assert.throws(() => renderMail({ ...base, to: ['not-an-address'] }), /地址格式不对/);
});

test('mail: 模板渲染**默认转义**，缺键保留原文，支持嵌套取值', () => {
  assert.strictEqual(renderTemplate('你好 {{name}}', { name: '世界' }), '你好 世界');
  assert.strictEqual(renderTemplate('<p>{{bio}}</p>', { bio: '<script>alert(1)</script>' }), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.strictEqual(renderTemplate('{{user.name}}', { user: { name: '张三' } }), '张三');
  assert.strictEqual(renderTemplate('{{missing}}', {}), '{{missing}}', '缺键保留原文（一眼看出漏了什么）');
  assert.strictEqual(renderTemplate('{{x}}', { x: 1 }, { escape: false }), '1');
  assert.strictEqual(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

// --- transport 契约（fileTransport 离线真验）--------------------------------
runMailTransportContract({ name: 'file', make: () => fileTransport({ dir: tmp() }) });

test('mail: fileTransport 真的写出可解析的 .eml（离线真验）', async () => {
  const dir = tmp();
  const transport = fileTransport({ dir });
  const result = await transport.send({ ...base, html: '<p>hi</p>' });
  const file = result.id;
  assert.ok(fs.existsSync(file), `应当写出文件：${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  const headers = parseMailHeaders(raw);
  assert.strictEqual(headers['mime-version'], '1.0');
  assert.ok(headers['message-id']?.startsWith('<'));
  assert.deepStrictEqual(result.accepted, ['to@example.com']);
  assert.deepStrictEqual(result.rejected, []);
  assert.match(String(result.detail?.['subject']), /中文主题/);
});

// --- 插件端到端 -------------------------------------------------------------
test('mail plugin: 接进应用 → ctx.get("mail") 能发信；生命周期交给 supervise', async () => {
  const dir = tmp();
  const events: string[] = [];
  const plugin = mailPlugin({ driver: 'file', dir, onEvent: (event) => events.push(event.type) });
  const services = new Map<string, unknown>();
  const config = {
    get<T>(key: string): T {
      const values: Record<string, unknown> = { 'plugins.mail.url': '', 'plugins.mail.dir': dir, 'plugins.mail.driver': 'file' };
      return values[key] as T;
    },
  };
  const app = {
    config,
    provide: (name: string, value: unknown) => void services.set(name, value),
    get: <T>(name: string): T => services.get(name) as T,
  };
  await plugin.onReady(app as never);
  try {
    const resource = services.get('mail') as { acquire(): Promise<MailTransport> };
    const transport = await resource.acquire();
    const result = await transport.send({ ...base, subject: '来自插件' });
    assert.ok(fs.existsSync(result.id));
    assert.ok(services.has('mail:resource'), '受管资源也要注册（与 resourceAdapter 一致）');
    const registry = services.get('@actor/resource:registry') as Array<{ name: string }>;
    assert.deepStrictEqual(registry.map((item) => item.name), ['mail'], '/__debug/health 要能发现它');
    assert.ok(events.includes('connecting') && events.includes('connected'), `要报生命周期事件：${events.join(',')}`);
  } finally {
    await plugin.onStopping();
  }
});

test('mail plugin: 内存/close 幂等（onStopping 调两次不炸）', async () => {
  const plugin = mailPlugin({ transport: fileTransport({ dir: tmp() }) });
  const services = new Map<string, unknown>();
  const app = {
    config: { get<T>(): T { return '' as T; } },
    provide: (name: string, value: unknown) => void services.set(name, value),
    get: <T>(name: string): T => services.get(name) as T,
  };
  await plugin.onReady(app as never);
  await plugin.onStopping();
  await plugin.onStopping();
});

// --- SMTP：契约级（假 nodemailer）+ 真服务开关 ------------------------------
test('smtp: 懒加载驱动、选项映射、错误包装（用假 nodemailer 验证，不发真邮件）', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeModule = {
    createTransport(options: Record<string, unknown>) {
      calls.push({ createTransport: options });
      return {
        async sendMail(mail: Record<string, unknown>) {
          calls.push({ sendMail: mail });
          return { messageId: '<fake@id>', accepted: ['to@example.com'], rejected: [] };
        },
        async verify() {
          calls.push({ verify: true });
        },
        close() {
          calls.push({ close: true });
        },
      };
    },
  };
  const transport = smtpTransport({
    url: 'smtp://user:secret@mail.example.com:465',
    resolve: (specifier: string) => {
      if (specifier === 'nodemailer') return fakeModule;
      const error = new Error(`Cannot find module '${specifier}'`);
      (error as { code?: string }).code = 'MODULE_NOT_FOUND';
      throw error;
    },
  });
  await transport.verify?.();
  const result = await transport.send(base);
  assert.strictEqual(result.id, '<fake@id>');
  assert.deepStrictEqual(calls[0]?.['createTransport'], { host: 'mail.example.com', port: 465, secure: true, auth: { user: 'user', pass: 'secret' }, connectionTimeout: 10000 });
  const sent = calls.find((call) => 'sendMail' in call)?.['sendMail'] as Record<string, unknown>;
  assert.ok(String(sent['raw']).includes('Subject: =?UTF-8?B?'), '走的是渲染好的 raw（SMTP 不自己拼 MIME）');

  // 驱动没装 → 安装提示（不是静默失败）
  const missing = smtpTransport({ url: 'smtp://mail.example.com', resolve: () => { const e = new Error("Cannot find module 'nodemailer'"); (e as { code?: string }).code = 'MODULE_NOT_FOUND'; throw e; } });
  await assert.rejects(() => missing.send(base), /nodemailer/);
});

const smtpUrl = realResourceUrl('ACTOR_TEST_SMTP_URL');
test('smtp: 真服务投递（MailHog）', { skip: smtpUrl === undefined ? 'ACTOR_TEST_SMTP_URL not set（先 node scripts/dev-databases.mjs up mailhog）' : false }, async () => {
  const transport = smtpTransport({ url: smtpUrl as string, resolve: () => import('nodemailer') as never });
  await transport.send({ ...base, to: ['inbox@example.com'] });
  await transport.close?.();
});

testWithResource('ACTOR_TEST_SMTP_URL', 'smtp: 真服务上的契约套件', () => {
  runMailTransportContract({
    name: 'smtp-real',
    make: () => smtpTransport({ url: realResourceUrl('ACTOR_TEST_SMTP_URL') as string, resolve: () => import('nodemailer') as never }),
    realDelivery: true,
    to: 'contract@example.com',
  });
});

test('mail: 单段中文纯文本正文必须按声明的 base64 编码（回归：头说 base64、正文写原文）', () => {
  const rendered = renderMail({ from: 'from@example.com', to: ['to@example.com'], subject: 's', text: '你好，世界' });
  const [head = '', body = ''] = rendered.raw.split('\r\n\r\n');
  assert.match(head, /content-transfer-encoding:\s*base64/i);
  assert.strictEqual(Buffer.from(body, 'base64').toString('utf8'), '你好，世界');
});

test('mail: 附件 contentType/contentId、Message-ID、header 名都不能注入（回归）', () => {
  const base = { from: 'from@example.com', to: ['to@example.com'], subject: 's', text: 'x' };
  assert.throws(
    () => renderMail({ ...base, attachments: [{ filename: 'a.txt', content: Buffer.from('x'), contentType: 'text/plain\r\nBcc: evil@example.com' }] }),
    /contentType/,
  );
  assert.throws(
    () => renderMail({ ...base, attachments: [{ filename: 'a.txt', content: Buffer.from('x'), contentId: 'id\r\nBcc: evil@example.com' }] }),
    /contentId/,
  );
  assert.throws(() => renderMail(base, { messageId: '<a@b>\r\nBcc: evil@example.com' }), /Message-ID/);
  assert.throws(() => renderMail({ ...base, headers: { ' X-Smuggled': 'evil' } }), /header name/);
});
