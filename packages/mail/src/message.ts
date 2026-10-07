import { randomUUID } from 'node:crypto';

import { DbConfigError, DbConnectionError } from '@actor/resource';

/**
 * **邮件消息模型 + MIME 渲染**（零依赖）：把 `MailMessage` 变成可直接投递的 `.eml` 文本。
 *
 * 渲染要点（都是"收件端能不能正确显示"的关键）：
 *   - 非 ASCII 主题/文件名 → **RFC 2047** encoded-word（`=?UTF-8?B?...?=`）；
 *   - 同时有纯文本与 HTML → `multipart/alternative`；
 *   - 有附件 → 外层 `multipart/mixed`；
 *   - 附件按 **base64** 编码，每行 76 字符（RFC 2045）；
 *   - **头部注入防御**：地址/主题里的 CR/LF 一律拒绝（否则 `To: a@b\r\nBcc: x@y` 这种就能塞进来）。
 */
export interface MailAddress {
  readonly name?: string;
  readonly address: string;
}

export interface MailAttachment {
  readonly filename: string;
  readonly content: Uint8Array | string;
  readonly contentType?: string;
  readonly contentId?: string;
}

export interface MailMessage {
  readonly from: string | MailAddress;
  readonly to: readonly (string | MailAddress)[];
  readonly cc?: readonly (string | MailAddress)[];
  readonly bcc?: readonly (string | MailAddress)[];
  readonly replyTo?: string | MailAddress;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly MailAttachment[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** 渲染后可投递的内容。 */
export interface RenderedMail {
  readonly raw: string;
  readonly messageId: string;
  readonly envelope: { readonly from: string; readonly to: readonly string[] };
  readonly subject: string;
}

const CRLF = /\r|\n/;

function assertNoInjection(value: string, what: string): void {
  if (CRLF.test(value)) throw new DbConfigError(`mail: ${what} 里不允许出现换行（防头部注入）：${JSON.stringify(value)}`);
}

function addressOf(input: string | MailAddress): MailAddress {
  if (typeof input === 'string') {
    assertNoInjection(input, 'address');
    if (!/^[^@\s]+@[^@\s]+$/.test(input)) throw new DbConfigError(`mail: 地址格式不对：${input}`);
    return { address: input };
  }
  assertNoInjection(input.address, 'address');
  if (input.name !== undefined) assertNoInjection(input.name, 'display name');
  if (!/^[^@\s]+@[^@\s]+$/.test(input.address)) throw new DbConfigError(`mail: 地址格式不对：${input.address}`);
  return input;
}

/** 需要编码吗（含非 ASCII）→ RFC 2047 encoded-word。 */
function encodeWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress(input: string | MailAddress): string {
  const { name, address } = addressOf(input);
  if (name === undefined || name === '') return address;
  return `${encodeWord(name)} <${address}>`;
}

function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

function base64Lines(data: Buffer): string {
  const encoded = data.toString('base64');
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n');
}

function asBuffer(content: Uint8Array | string): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

/** 把消息渲染成 `.eml`（RFC 5322 + MIME）。 */
export function renderMail(message: MailMessage, options: { now?: Date; messageId?: string; domain?: string } = {}): RenderedMail {
  if (message.to === undefined || message.to.length === 0) throw new DbConfigError('mail: 至少一个收件人（to）');
  assertNoInjection(message.subject, 'subject');

  const from = addressOf(message.from);
  const to = message.to.map(addressOf);
  const cc = (message.cc ?? []).map(addressOf);
  const bcc = (message.bcc ?? []).map(addressOf);
  const domain = options.domain ?? from.address.split('@')[1] ?? 'localhost';
  const messageId = options.messageId ?? `<${randomUUID()}@${domain}>`;
  const date = options.now ?? new Date();

  const headers: string[] = [
    `From: ${formatAddress(message.from)}`,
    `To: ${to.map((item) => formatAddress(item)).join(', ')}`,
    ...(cc.length === 0 ? [] : [`Cc: ${cc.map((item) => formatAddress(item)).join(', ')}`]),
    ...(message.replyTo === undefined ? [] : [`Reply-To: ${formatAddress(message.replyTo)}`]),
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${formatDate(date)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    assertNoInjection(key, 'header name');
    assertNoInjection(value, `header ${key}`);
    headers.push(`${key}: ${value}`);
  }

  const text = message.text ?? '';
  const html = message.html;
  const attachments = message.attachments ?? [];
  const stamp = randomUUID().slice(0, 8);

  const bodyPart = (contentType: string, body: string): string =>
    `Content-Type: ${contentType}\r\nContent-Transfer-Encoding: ${/^[\x20-\x7e\r\n]*$/.test(body) ? '7bit' : 'base64'}\r\n\r\n` +
    (/^[\x20-\x7e\r\n]*$/.test(body) ? body : base64Lines(Buffer.from(body, 'utf8')));

  let body: string;
  if (html !== undefined && attachments.length === 0) {
    // 纯文本 + HTML → multipart/alternative
    const boundary = `alt-${stamp}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      bodyPart('text/plain; charset=utf-8', text),
      `--${boundary}`,
      bodyPart('text/html; charset=utf-8', html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else if (attachments.length > 0) {
    const mixed = `mix-${stamp}`;
    const alt = `alt-${stamp}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    const inner =
      html === undefined
        ? [`--${mixed}`, bodyPart('text/plain; charset=utf-8', text), '']
        : [
            `--${mixed}`,
            `Content-Type: multipart/alternative; boundary="${alt}"`,
            '',
            `--${alt}`,
            bodyPart('text/plain; charset=utf-8', text),
            `--${alt}`,
            bodyPart('text/html; charset=utf-8', html),
            `--${alt}--`,
            '',
          ];
    const parts = [...inner];
    for (const attachment of attachments) {
      assertNoInjection(attachment.filename, 'attachment filename');
      const contentType = attachment.contentType ?? 'application/octet-stream';
      const id = attachment.contentId ?? `${randomUUID()}@${domain}`;
      parts.push(
        `--${mixed}`,
        `Content-Type: ${contentType}; name="${encodeWord(attachment.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${encodeWord(attachment.filename)}"`,
        `Content-ID: <${id}>`,
        '',
        base64Lines(asBuffer(attachment.content)),
        '',
      );
    }
    parts.push(`--${mixed}--`, '');
    body = parts.join('\r\n');
  } else {
    headers.push(bodyPart('text/plain; charset=utf-8', text).split('\r\n\r\n')[0] as string);
    body = text;
  }

  return {
    raw: `${headers.join('\r\n')}\r\n\r\n${body}`,
    messageId,
    envelope: { from: from.address, to: [...to, ...cc, ...bcc].map((item) => item.address) },
    subject: message.subject,
  };
}

/** 从 `.eml` 里粗略取出头部（诊断/测试用；**不是**完整 MIME 解析器）。 */
export function parseMailHeaders(raw: string): Record<string, string> {
  const head = raw.split('\r\n\r\n')[0] ?? '';
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && current !== null) {
      out[current] = `${out[current] ?? ''} ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(':');
    if (index < 0) continue;
    current = line.slice(0, index).toLowerCase();
    out[current] = line.slice(index + 1).trim();
  }
  return out;
}

void DbConnectionError;
