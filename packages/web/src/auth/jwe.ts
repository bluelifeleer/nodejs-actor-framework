import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';

import { DbConfigError } from '@actor/resource';

import { JwtError } from './jwt.ts';

/**
 * **JWE（加密 JWT）**：只支持两种**常见且安全**的组合，其它组合**显式拒绝**（不假装支持）。
 *
 * | alg | enc | 密钥 |
 * |---|---|---|
 * | `RSA-OAEP-256` | `A256GCM` | PEM 公钥（加密）/ 私钥（解密），可按 `kid` 轮换 |
 * | `dir` | `A256GCM` | 32 字节共享密钥 |
 *
 * 推荐用法是**嵌套**（签名后加密，`JWS in JWE`）：
 * ```ts
 * const jws = signJwt({ sub: 'u' }, { key: signKey });
 * const jwe = encryptJwe(jws, { key: encryptKey });         // 密文里看不到 payload
 * const back = await decryptToJws(jwe, { keys: [decryptKey] });
 * const { payload } = await verifyJwt(back, { keys: [verifyKey] });   // 解密后再验签
 * ```
 */
export type JweKeyAlgorithm = 'RSA-OAEP-256' | 'dir';
export type JweContentEncryption = 'A256GCM';

export const JWE_ALGORITHMS: readonly JweKeyAlgorithm[] = ['RSA-OAEP-256', 'dir'];
export const JWE_ENCRYPTIONS: readonly JweContentEncryption[] = ['A256GCM'];

export interface JweKey {
  readonly kid?: string;
  readonly alg: JweKeyAlgorithm;
  readonly enc?: JweContentEncryption;
  /** `RSA-OAEP-256`：PEM（加密用公钥、解密用私钥）；`dir`：32 字节密钥。 */
  readonly key: string | Uint8Array;
}

export class JweError extends Error {
  readonly reason: 'unsupported_algorithm' | 'not_supported' | 'malformed' | 'key_not_found' | 'decrypt_failed';
  constructor(reason: JweError['reason'], message: string) {
    super(message);
    this.name = 'JweError';
    this.reason = reason;
  }
}

const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');
const fromB64u = (input: string): Buffer => {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new JweError('malformed', 'JWE 段不是合法的 base64url');
  return Buffer.from(input, 'base64url');
};

function contentKey(key: JweKey): Buffer {
  if (key.alg === 'dir') {
    const bytes = typeof key.key === 'string' ? Buffer.from(key.key, 'utf8') : Buffer.from(key.key);
    if (bytes.byteLength !== 32) {
      throw new DbConfigError(`jwe: alg=dir 需要 32 字节密钥（A256GCM），当前 ${bytes.byteLength} 字节`);
    }
    return bytes;
  }
  return randomBytes(32); // CEK：每个消息一把
}

/** 加密：`plaintext` 通常是**已签名的 JWS**（嵌套），也可以是任意字符串。 */
export function encryptJwe(plaintext: string, options: { key: JweKey; enc?: JweContentEncryption; typ?: string }): string {
  const alg = options.key.alg;
  const enc = options.enc ?? options.key.enc ?? 'A256GCM';
  if (!JWE_ALGORITHMS.includes(alg)) {
    throw new JweError('not_supported', `不支持的 alg "${String(alg)}"：只支持 ${JWE_ALGORITHMS.join(', ')}`);
  }
  if (!JWE_ENCRYPTIONS.includes(enc)) {
    throw new JweError('not_supported', `不支持的 enc "${String(enc)}"：只支持 ${JWE_ENCRYPTIONS.join(', ')}`);
  }

  const cek = contentKey(options.key);
  const header: Record<string, unknown> = { alg, enc, ...(options.key.kid === undefined ? {} : { kid: options.key.kid }) };
  if (options.typ !== undefined) header.typ = options.typ;
  const protectedHeader = b64u(JSON.stringify(header));
  const aad = Buffer.from(protectedHeader, 'ascii');

  let encryptedKey = Buffer.alloc(0);
  if (alg === 'RSA-OAEP-256') {
    if (typeof options.key.key !== 'string' || !options.key.key.includes('PUBLIC KEY')) {
      throw new DbConfigError('jwe: RSA-OAEP-256 加密需要 PEM 公钥（-----BEGIN PUBLIC KEY-----）');
    }
    encryptedKey = publicEncrypt(
      { key: createPublicKey(options.key.key), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      cek,
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [protectedHeader, b64u(encryptedKey), b64u(iv), b64u(ciphertext), b64u(tag)].join('.');
}

/** 解密：失败一律抛 `JweError`（**不要**把 reason 回给客户端）。 */
export function decryptJwe(token: string, options: { keys: readonly JweKey[] }): string {
  const parts = token.split('.');
  if (parts.length !== 5) throw new JweError('malformed', 'JWE 必须是五段（compact serialization）');
  const [protectedHeader, encryptedKey, ivPart, ciphertext, tagPart] = parts as [string, string, string, string, string];

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64u(protectedHeader).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new JweError('malformed', 'JWE 的 protected header 不是合法 JSON');
  }
  const alg = header.alg;
  const enc = header.enc;
  if (!JWE_ALGORITHMS.includes(alg as JweKeyAlgorithm)) {
    throw new JweError('not_supported', `不支持的 alg "${String(alg)}"：只支持 ${JWE_ALGORITHMS.join(', ')}`);
  }
  if (!JWE_ENCRYPTIONS.includes(enc as JweContentEncryption)) {
    throw new JweError('not_supported', `不支持的 enc "${String(enc)}"：只支持 ${JWE_ENCRYPTIONS.join(', ')}`);
  }
  const kid = header.kid;
  const candidates = options.keys.filter(
    (key) => key.alg === alg && (kid === undefined || key.kid === undefined || key.kid === kid),
  );
  if (candidates.length === 0) {
    throw new JweError('key_not_found', kid === undefined ? `没有可用于 ${String(alg)} 的密钥` : `找不到 kid=${String(kid)} 的密钥`);
  }

  let lastError: unknown = null;
  for (const key of candidates) {
    try {
      let cek: Buffer;
      if (alg === 'dir') {
        cek = contentKey(key);
      } else {
        const pem = typeof key.key === 'string' ? key.key : Buffer.from(key.key).toString('utf8');
        if (!pem.includes('PRIVATE KEY')) throw new DbConfigError('jwe: RSA-OAEP-256 解密需要 PEM 私钥');
        cek = privateDecrypt(
          { key: createPrivateKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          fromB64u(encryptedKey),
        );
      }
      const decipher = createDecipheriv('aes-256-gcm', cek, fromB64u(ivPart));
      decipher.setAAD(Buffer.from(protectedHeader, 'ascii'));
      decipher.setAuthTag(fromB64u(tagPart));
      return Buffer.concat([decipher.update(fromB64u(ciphertext)), decipher.final()]).toString('utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw new JweError('decrypt_failed', `解密失败（认证标签不符或密钥不对）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 解密并拆出内层 JWS（嵌套用法的一步到位版）。 */
export function decryptToJws(token: string, options: { keys: readonly JweKey[] }): string {
  const plaintext = decryptJwe(token, options);
  if (plaintext.split('.').length !== 3) {
    throw new JwtError('malformed', 'JWE 里解出来的不是 JWS（三段）—— 嵌套用法请传已签名的 token');
  }
  return plaintext;
}
