'use strict';

/**
 * Dependency-free HMAC tokens for the **access layer** (token → playerId).
 *
 * This is the building block, not an authentication policy: it signs and
 * verifies a compact `base64url(payload).base64url(hmac)` token with an
 * expiry, using only `crypto`. Wire it into your login endpoint (issue a token)
 * and into `verifyClient` (reject the upgrade when verification fails).
 *
 *   const tokens = new TokenAuthority({ secret: process.env.AUTH_SECRET });
 *   const token = tokens.issue({ playerId: 'alice', ttlMs: 3600_000 });
 *   tokens.verify(token);        // -> { playerId: 'alice', exp, iat } | null
 *   tokens.revoke(token);        // immediate logout / ban
 *
 * Deliberately not included: user database, refresh tokens, OAuth. Those are
 * application concerns; `TokenAuthority` only solves "is this token ours and
 * still valid".
 */

const crypto = require('crypto');
export interface TokenAuthorityOptions {
  /** At least 16 characters, or `ACTOR_AUTH_SECRET` in the environment. */
  secret?: string;
  /** Default token lifetime in ms (default 1h). 0 is honoured (expires at once). */
  ttlMs?: number;
  /** Accepted clock drift in ms (default 5000). 0 disables tolerance. */
  clockSkewMs?: number;
  maxRevoked?: number;
}

export interface IssueOptions {
  playerId: string;
  ttlMs?: number;
  claims?: Record<string, unknown>;
}

export interface IssuedToken {
  token: string;
  playerId: string;
  expiresAt: number;
}

export interface VerifiedToken {
  playerId: string;
  iat: number;
  exp: number;
  jti: string;
  claims: Record<string, unknown>;
}

export interface RequestLike {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}



/** base64url without padding. */
const b64 = (buf: Buffer | string | Uint8Array): string => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = (str: unknown): Buffer => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class TokenAuthority {
  secret: Buffer;
  defaultTtlMs: number;
  clockSkewMs: number;
  /** Revoked token ids (jti); in-memory by design. */
  revoked: Set<string>;
  maxRevoked: number;

  constructor(options: TokenAuthorityOptions = {}) {
    const secret = options.secret || process.env.ACTOR_AUTH_SECRET;
    if (!secret || String(secret).length < 16) {
      throw new Error(
        'TokenAuthority needs a secret of at least 16 characters ' +
          '(pass { secret } or set ACTOR_AUTH_SECRET)',
      );
    }
    this.secret = Buffer.from(String(secret), 'utf8');
    // `=== undefined` rather than `||`: 0 is a legitimate value for both
    // (immediately expiring tokens, and no skew tolerance at all).
    this.defaultTtlMs = options.ttlMs === undefined ? 60 * 60 * 1000 : options.ttlMs;
    this.clockSkewMs = options.clockSkewMs === undefined ? 5000 : options.clockSkewMs;
    /** @type {Set<string>} revoked token ids (jti); in-memory by design. */
    this.revoked = new Set();
    this.maxRevoked = options.maxRevoked === undefined ? 10000 : options.maxRevoked;
  }

  /** Issue a signed token for a player. */
  issue({ playerId, ttlMs = this.defaultTtlMs, claims = {} }: IssueOptions = { playerId: '' }): IssuedToken {
    if (!playerId) throw new Error('issue({ playerId }) is required');
    const now = Date.now();
    const payload = { sub: String(playerId), iat: now, exp: now + ttlMs, jti: crypto.randomUUID(), ...claims };
    const body = b64(JSON.stringify(payload));
    return {
      token: `${body}.${this._sign(body)}`,
      playerId: payload.sub,
      expiresAt: payload.exp,
    };
  }

  /**
   * Verify a token.
   * @returns {{playerId: string, iat: number, exp: number, jti: string, claims: object}|null}
   *          null for anything invalid — never throws on bad input.
   */
  verify(token: unknown): VerifiedToken | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    // Constant-time signature check first: never parse unauthenticated input.
    const expected = this._sign(body);
    if (!timingSafeEqual(signature, expected)) return null;

    let payload: any;
    try {
      payload = JSON.parse(unb64(body).toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    const now = Date.now();
    if (payload.exp + this.clockSkewMs < now) return null; // expired
    if (typeof payload.iat === 'number' && payload.iat - this.clockSkewMs > now) return null; // issued in the future
    if (payload.jti && this.revoked.has(payload.jti)) return null; // logged out / banned

    const { sub, iat, exp, jti, ...claims } = payload;
    return { playerId: sub, iat, exp, jti, claims };
  }

  /** Revoke a token (by its `jti`), so a logout takes effect immediately. */
  revoke(token: unknown): boolean {
    const verified = this.verify(token);
    if (!verified || !verified.jti) return false;
    this.revoked.add(verified.jti);
    if (this.revoked.size > this.maxRevoked) {
      // Bounded: drop the oldest insertions (approximate, avoids unbounded growth).
      const excess = this.revoked.size - this.maxRevoked;
      let removed = 0;
      for (const id of this.revoked) {
        this.revoked.delete(id);
        if (++removed >= excess) break;
      }
    }
    return true;
  }

  _sign(body: string): string {
    return b64(crypto.createHmac('sha256', this.secret).update(body).digest());
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  /**
   * 审计 S13：原来"长度不等就 return false"，内容比较是恒定时间但**长度会经耗时泄漏**。
   * 改成先各自 SHA-256 再比：摘要等长，比较路径不依赖输入长度。
   */
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Pull a token out of an HTTP upgrade request. Accepts, in order:
 *   - `?token=...` query parameter
 *   - `Sec-WebSocket-Protocol: bearer.<token>`  (for browsers, which cannot set headers)
 *   - `Authorization: Bearer <token>`
 */
function tokenFromRequest(req: RequestLike | null): string | null {
  if (!req) return null;
  // Header values may be repeated (string[]) — take the first, as the wire format allows one.
  const header = (name: string): string | undefined => {
    const value = (req.headers || {})[name];
    return Array.isArray(value) ? value[0] : value;
  };
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) return fromQuery;
  } catch {
    /* fall through */
  }
  const protocol = header('sec-websocket-protocol');
  if (protocol) {
    const match = /(?:^|,\s*)bearer\.([A-Za-z0-9._-]+)/.exec(protocol);
    if (match) return match[1] ?? null;
  }
  const auth = header('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

module.exports = { TokenAuthority, tokenFromRequest, timingSafeEqual };
module.exports.TokenAuthority = TokenAuthority;
