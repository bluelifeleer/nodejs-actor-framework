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

/** 头部字段名必须是 RFC 5322 token（拒绝冒号/空白/控制字符）。 */
function assertHeaderName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new DbConfigError(`mail: header name 不是合法 token：${JSON.stringify(name)}`);
  }
}

function assertMessageId(value: string): void {
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(value)) {
    throw new DbConfigError(`mail: Message-ID 格式不对：${JSON.stringify(value)}`);
  }
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
  // 显示名里的逗号/分号/引号等必须按 RFC 5322 quoted-string 处理，否则
  // `Doe, John <j@example.com>` 会被解析成两个地址
  const display = /^[\x20-\x7e]*$/.test(name)
    ? /[",;:<>@\\\[\]]/.test(name)
      ? `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : name
    : encodeWord(name);
  return `${display} <${address}>`;
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

/**
 * **发送前的合法性检查**（自定义 transport 请先调它，再发）。
 *
 * 为什么单独导出：`renderMail` 会做这些检查，但把信交给 HTTP API（Resend/SES…）的传输**不渲染**
 * ——于是它会漏掉"没有收件人"与"主题里藏 CRLF（头部注入）"这两个洞。契约套件要求这些错误必须响亮，
 * 所以规则做成**单一来源**，而不是让每个实现各抄一遍。
 */
export function assertSendable(message: MailMessage): void {
  if (message.to === undefined || message.to.length === 0) throw new DbConfigError('mail: 至少一个收件人（to）');
  assertNoInjection(message.subject, 'subject');
  // 地址（含显示名）也走同一套规范化：格式不对/带换行都会在这里响亮报错
  addressOf(message.from);
  for (const recipient of message.to) addressOf(recipient);
  for (const recipient of message.cc ?? []) addressOf(recipient);
  for (const recipient of message.bcc ?? []) addressOf(recipient);
  if (message.replyTo !== undefined) addressOf(message.replyTo);
}

/** 把消息渲染成 `.eml`（RFC 5322 + MIME）。 */
export function renderMail(message: MailMessage, options: { now?: Date; messageId?: string; domain?: string } = {}): RenderedMail {
  assertSendable(message);

  const from = addressOf(message.from);
  const to = message.to.map(addressOf);
  const cc = (message.cc ?? []).map(addressOf);
  const bcc = (message.bcc ?? []).map(addressOf);
  const domain = options.domain ?? from.address.split('@')[1] ?? 'localhost';
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) throw new DbConfigError(`mail: domain 格式不对：${JSON.stringify(domain)}`);
  const messageId = options.messageId ?? `<${randomUUID()}@${domain}>`;
  assertMessageId(messageId);
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
    assertHeaderName(key);
    assertNoInjection(value, `header ${key}`);
    headers.push(`${key}: ${value}`);
  }

  const text = message.text ?? '';
  const html = message.html;
  const attachments = message.attachments ?? [];
  const stamp = randomUUID().slice(0, 8);

  const bodyPart = (contentType: string, rawBody: string): string => {
    // RFC 5322 §2.3：正文行必须用 CRLF；先规范化再判断 7bit/base64
    const body = rawBody.replace(/\r?\n/g, '\r\n');
    return (
      `Content-Type: ${contentType}\r\nContent-Transfer-Encoding: ${/^[\x20-\x7e\r\n]*$/.test(body) ? '7bit' : 'base64'}\r\n\r\n` +
      (/^[\x20-\x7e\r\n]*$/.test(body) ? body : base64Lines(Buffer.from(body, 'utf8')))
    );
  };

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
      if (!/^[\w.+-]+\/[\w.+-]+(?:;\s*[\w.-]+=[^;\r\n]+)*$/.test(contentType)) {
        throw new DbConfigError(`mail: attachment contentType 格式不对：${JSON.stringify(contentType)}`);
      }
      const id = attachment.contentId ?? `${randomUUID()}@${domain}`;
      if (!/^[^\s<>\r\n]+@[^\s<>\r\n]+$/.test(id)) {
        throw new DbConfigError(`mail: attachment contentId 格式不对：${JSON.stringify(id)}`);
      }
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
    // 头部声明的 CTE（7bit/base64）与正文必须来自**同一次**渲染：
    // 旧实现只取了头部，正文却写原文，非 ASCII 正文会被收件端按 base64 解码成乱码。
    const rendered = bodyPart('text/plain; charset=utf-8', text);
    const separator = rendered.indexOf('\r\n\r\n');
    headers.push(rendered.slice(0, separator));
    body = rendered.slice(separator + 4);
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
