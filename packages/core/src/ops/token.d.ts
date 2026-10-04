/**
 * Type definitions for HMAC tokens (access-layer authentication).
 */

export interface TokenAuthorityOptions {
  /** At least 16 characters, or `ACTOR_AUTH_SECRET` in the environment. */
  secret?: string;
  /** Default token lifetime in ms (default 1h). 0 is honoured (expires at once). */
  ttlMs?: number;
  /** Accepted clock drift in ms (default 5000). 0 disables tolerance. */
  clockSkewMs?: number;
  maxRevoked?: number;
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

export class TokenAuthority {
  constructor(options?: TokenAuthorityOptions);
  issue(options: { playerId: string; ttlMs?: number; claims?: Record<string, unknown> }): IssuedToken;
  /** Never throws on bad input: returns null for invalid/expired/revoked tokens. */
  verify(token: string): VerifiedToken | null;
  revoke(token: string): boolean;
  readonly revoked: Set<string>;
}

/** Token from `?token=`, `Sec-WebSocket-Protocol: bearer.<token>`, or `Authorization: Bearer`. */
export function tokenFromRequest(req: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
} | null): string | null;

export function timingSafeEqual(a: string, b: string): boolean;
