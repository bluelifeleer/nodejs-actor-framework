import { createHmac, createPrivateKey, createPublicKey, createSign, createVerify, timingSafeEqual } from 'node:crypto';

import { DbConfigError } from '@actor/resource';

/**
 * **JWT（JWS）实现**：零依赖，只用 `node:crypto`。
 *
 * 支持：HS256/384/512（HMAC，**常量时间比较**）、RS256/384/512、ES256/384（原始 R||S 签名）。
 * 明确拒绝：`alg: none`（以及任何不在白名单里的 alg）—— 这是 JWT 最经典的坑，**默认就不接受**。
 */
export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384';

export const SIGNING_ALGORITHMS: readonly JwtAlgorithm[] = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'];
/** HMAC 系列（对称密钥）：校验必须用常量时间比较。 */
export const HMAC_ALGORITHMS: readonly JwtAlgorithm[] = ['HS256', 'HS384', 'HS512'];

export interface JwtKey {
  /** 密钥标识（多密钥轮换时按 header.kid 选）。 */
  readonly kid?: string;
  readonly algorithm: JwtAlgorithm;
  /** HMAC：字符串/字节密钥；RS/ES：PEM 私钥（签发）或公钥（校验）。 */
  readonly key: string | Uint8Array;
  /** 校验时允许用它（私钥也能推出公钥，所以签发的 key 通常也能验）。 */
  readonly verifyOnly?: boolean;
}

export interface JwtVerifyOptions {
  /** 允许的算法白名单（默认：所有支持的算法，但**永远不含 none**）。 */
  readonly algorithms?: readonly JwtAlgorithm[];
  readonly keys: readonly JwtKey[];
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  /** 时钟容差（秒偏移；默认 0，不偷偷放宽）。 */
  readonly clockToleranceSec?: number;
  readonly now?: number;
  /** 额外校验（黑名单/撤销/自定义 claim）—— 抛错即拒绝。 */
  readonly verifyExtra?: (payload: Record<string, unknown>) => void | Promise<void>;
  /**
   * 是否要求 token 带 `exp`（默认 false：兼容既有调用方）。
   * `authPlugin` 默认把它设为 true —— 登录 token 不应永久有效。
   */
  readonly requireExp?: boolean;
}

export interface JwtPayload extends Record<string, unknown> {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

/** 校验失败的原因（**服务端日志用**；对外一律 401，不区分原因）。 */
export type JwtFailureReason =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'key_not_found'
  | 'signature_invalid'
  | 'missing_exp'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_the_future'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'verify_extra_failed';

export class JwtError extends Error {
  readonly reason: JwtFailureReason;
  constructor(reason: JwtFailureReason, message: string) {
    super(message);
    this.name = 'JwtError';
    this.reason = reason;
  }
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');
const fromBase64url = (input: string): Buffer => {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new JwtError('malformed', 'JWT 段不是合法的 base64url');
  return Buffer.from(input, 'base64url');
};

function hashFor(algorithm: JwtAlgorithm): string {
  const bits = algorithm.slice(2);
  const map: Record<string, string> = { '256': 'sha256', '384': 'sha384', '512': 'sha512' };
  return map[bits] as string;
}

/** 签发：`payload` 会带上 iat（未给时），可显式给 exp/nbf/iss/aud。 */
export function signJwt(
  payload: JwtPayload,
  options: { key: JwtKey; header?: Record<string, unknown>; expiresInSec?: number; now?: number },
): string {
  const algorithm = options.key.algorithm;
  if (!SIGNING_ALGORITHMS.includes(algorithm)) throw new DbConfigError(`signJwt: 不支持的算法 ${algorithm}`);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: JwtPayload = { iat: now, ...payload };
  if (options.expiresInSec !== undefined && claims.exp === undefined) claims.exp = now + options.expiresInSec;
  const header = { alg: algorithm, typ: 'JWT', ...(options.key.kid === undefined ? {} : { kid: options.key.kid }), ...(options.header ?? {}) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  if (HMAC_ALGORITHMS.includes(algorithm)) {
    const signature = createHmac(hashFor(algorithm), options.key.key).update(signingInput).digest();
    return `${signingInput}.${base64url(signature)}`;
  }
  const signer = createSign(hashFor(algorithm));
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({
    key: createPrivateKey(toPem(options.key.key)),
    ...(algorithm.startsWith('ES') ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  });
  return `${signingInput}.${base64url(signature)}`;
}

/** 只解码（**不校验**）—— 用于日志/调试；名字里写明不校验，避免误用。 */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: JwtPayload } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'JWT 必须是三段');
  try {
    return {
      header: JSON.parse(fromBase64url(parts[0] as string).toString('utf8')) as Record<string, unknown>,
      payload: JSON.parse(fromBase64url(parts[1] as string).toString('utf8')) as JwtPayload,
    };
  } catch (err) {
    if (err instanceof JwtError) throw err;
    throw new JwtError('malformed', 'JWT 的 header/payload 不是合法 JSON');
  }
}

function toPem(key: string | Uint8Array): string | Buffer {
  if (typeof key === 'string') return key;
  return Buffer.from(key);
}

/** 拿到可用于校验的公钥：给公钥直接用；给私钥（签发用的那把）就从私钥推公钥。 */
function publicKeyOf(raw: string | Uint8Array): ReturnType<typeof createPublicKey> {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.includes('PUBLIC KEY') || text.includes('RSA PUBLIC')) return createPublicKey(text);
  return createPublicKey(createPrivateKey(text));
}

function hmacEquals(expected: Buffer, actual: Buffer): boolean {
  // 长度不同直接判否（timingSafeEqual 要求等长），但仍做一次比较避免"长度即答案"的额外信号
  if (expected.length !== actual.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function verifySignature(algorithm: JwtAlgorithm, key: JwtKey, signingInput: string, signature: Buffer): boolean {
  if (HMAC_ALGORITHMS.includes(algorithm)) {
    const expected = createHmac(hashFor(algorithm), key.key).update(signingInput).digest();
    return hmacEquals(expected, signature);
  }
  const verifier = createVerify(hashFor(algorithm));
  verifier.update(signingInput);
  verifier.end();
  try {
    if (algorithm.startsWith('ES')) return verifier.verify({ key: publicKeyOf(key.key), dsaEncoding: 'ieee-p1363' }, signature);
    if (algorithm.startsWith('RS')) return verifier.verify({ key: publicKeyOf(key.key) }, signature);
    return verifier.verify({ key: toPem(key.key) } as never, signature);
  } catch {
    return false;
  }
}

/**
 * 校验 JWT。失败一律抛 `JwtError`（带 reason；**对外不要把这个 reason 返回给客户端**）。
 */
export async function verifyJwt(token: string, options: JwtVerifyOptions): Promise<{ header: Record<string, unknown>; payload: JwtPayload }> {
  const decoded = decodeJwt(token);
  const alg = decoded.header.alg;
  if (typeof alg !== 'string') throw new JwtError('malformed', 'JWT header 缺少 alg');
  if (alg.toLowerCase() === 'none') throw new JwtError('unsupported_algorithm', '拒绝 alg=none');
  if (!SIGNING_ALGORITHMS.includes(alg as JwtAlgorithm)) {
    throw new JwtError('unsupported_algorithm', `不支持的算法 ${alg}`);
  }
  const allowed = options.algorithms ?? SIGNING_ALGORITHMS;
  if (!allowed.includes(alg as JwtAlgorithm)) {
    throw new JwtError('unsupported_algorithm', `算法 ${alg} 不在白名单里`);
  }

  const kid = decoded.header.kid;
  const candidates = options.keys.filter((key) => key.algorithm === alg && (kid === undefined || key.kid === undefined || key.kid === kid));
  if (candidates.length === 0) throw new JwtError('key_not_found', kid === undefined ? `没有可用于 ${alg} 的密钥` : `找不到 kid=${String(kid)} 的密钥`);

  const parts = token.split('.');
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = fromBase64url(parts[2] as string);
  if (!candidates.some((key) => verifySignature(alg as JwtAlgorithm, key, signingInput, signature))) {
    throw new JwtError('signature_invalid', '签名校验失败');
  }

  const payload = decoded.payload;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSec ?? 0;
  if (options.requireExp === true && typeof payload.exp !== 'number') {
    throw new JwtError('missing_exp', 'token 缺少 exp（拒绝永久有效的 token）');
  }
  if (typeof payload.exp === 'number' && now > payload.exp + tolerance) throw new JwtError('expired', `token 已过期（exp=${payload.exp}）`);
  if (typeof payload.nbf === 'number' && now + tolerance < payload.nbf) throw new JwtError('not_yet_valid', `token 还没生效（nbf=${payload.nbf}）`);
  if (typeof payload.iat === 'number' && now + tolerance < payload.iat) throw new JwtError('issued_in_the_future', `iat 在未来（iat=${payload.iat}）`);

  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw new JwtError('issuer_mismatch', `iss 不匹配（期望 ${options.issuer}）`);
  }
  if (options.audience !== undefined) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
    if (!expected.some((item) => actual.includes(item))) throw new JwtError('audience_mismatch', `aud 不匹配（期望 ${expected.join('|')}）`);
  }
  if (options.verifyExtra !== undefined) {
    try {
      await options.verifyExtra(payload);
    } catch (err) {
      throw new JwtError('verify_extra_failed', `verifyExtra 拒绝：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { header: decoded.header, payload };
}
