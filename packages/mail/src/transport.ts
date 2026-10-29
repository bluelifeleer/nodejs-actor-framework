import { mkdir, writeFile } from 'node:fs/promises';
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

import { DbConfigError, DbConnectionError } from '@actor/resource';

import { renderMail, type MailMessage } from './message.ts';

/**
 * **MailTransport 契约**：能发就行，别的一概不管。
 *
 * 实现自己的（Resend/SES/Mailgun…）用 `defineMailTransport`；`send` 里别做重试/队列
 * （那是投递语义层的事，框架不在这里假装有保证）。
 */
export interface MailSendResult {
  /** 传输层给的 id（`fileTransport` 给的是文件路径；SMTP 给的是 messageId）。 */
  readonly id: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  /** 附加信息（例如写到了哪个文件）。 */
  readonly detail?: Record<string, unknown>;
}

export interface MailTransport {
  readonly kind: string;
  /** 这个包名没装时的安装提示（内置实现填 `(内置)`）。 */
  readonly driverPackage?: string;
  send(message: MailMessage): Promise<MailSendResult>;
  /** 探活（SMTP：连一下/NOOP）。 */
  verify?(): Promise<void>;
  close?(): Promise<void>;
}

export function defineMailTransport(spec: MailTransport): MailTransport {
  if (typeof spec?.send !== 'function') throw new DbConfigError('defineMailTransport: "send" is required');
  if (typeof spec.kind !== 'string' || spec.kind === '') throw new DbConfigError('defineMailTransport: "kind" is required');
  return spec;
}

/** 写 `.eml` 的传输（**离线可真验**：无需任何服务，产物就是标准邮件文件）。 */
export function fileTransport(options: { dir: string; ext?: string }): MailTransport {
  const dir = path.resolve(options.dir);
  const ext = options.ext ?? '.eml';
  let counter = 0;
  return defineMailTransport({
    kind: 'file',
    driverPackage: '(内置)',
    async send(message) {
      const rendered = renderMail(message);
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${String((counter += 1)).padStart(4, '0')}${ext}`);
      await writeFile(file, rendered.raw, 'utf8');
      return {
        id: file,
        accepted: rendered.envelope.to,
        rejected: [],
        detail: { file, messageId: rendered.messageId, subject: rendered.subject, bytes: Buffer.byteLength(rendered.raw) },
      };
    },
    async verify() {
      // 目录能建就算可用（写权限问题会在 send 时响亮报错）
      await mkdir(dir, { recursive: true });
    },
  });
}

/** 契约套件：任何 `MailTransport` 实现都应通过（用户自装的 Resend/SES 也能自证合规）。 */
export function runMailTransportContract(options: {
  name: string;
  make: () => MailTransport | Promise<MailTransport>;
  /** 直接投递到真实服务时才需要：会真的发一封信（默认跳过真实投递断言）。 */
  realDelivery?: boolean;
  /** 接收者（真实投递时用）。 */
  to?: string;
}): void {
  const message: MailMessage = {
    from: { name: '测试发件人', address: 'from@example.com' },
    to: [options.to ?? 'to@example.com'],
    subject: '契约测试：中文主题 🙂',
    text: '纯文本正文',
    html: '<p>HTML 正文</p>',
  };

  test(`[mail-transport:${options.name}] send 返回 id 与收件人结果（accepted/rejected 都要有）`, async () => {
    const transport = await options.make();
    const result = await transport.send(message);
    assert.strictEqual(typeof result.id, 'string');
    assert.ok(result.id.length > 0, 'id 不能为空（排障要靠它）');
    assert.ok(Array.isArray(result.accepted) && result.accepted.length >= 1, '至少要报一个被接受者');
    assert.ok(Array.isArray(result.rejected), 'rejected 必须有（空数组也算）');
    assert.ok(!result.accepted.includes(''), 'accepted 里不该有空地址');
  });

  test(`[mail-transport:${options.name}] verify/close 可选但必须是幂等函数`, async () => {
    const transport = await options.make();
    if (typeof transport.verify === 'function') {
      await transport.verify();
      await transport.verify();
    }
    if (typeof transport.close === 'function') {
      await transport.close();
      await transport.close();
    }
    assert.ok(true);
  });

  test(`[mail-transport:${options.name}] 非法消息要明确报错（不给收件人 / 头部注入）`, async () => {
    const transport = await options.make();
    await assert.rejects(() => transport.send({ ...message, to: [] }), /至少一个收件人/);
    await assert.rejects(
      () => transport.send({ ...message, subject: 'a\r\nBcc: evil@example.com' }),
      /不允许出现换行/,
      '头部注入必须被拒（否则能偷偷加 Bcc）',
    );
  });
}

void DbConnectionError;
