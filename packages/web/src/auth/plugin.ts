import { DbConfigError } from '@actor/resource';

import { HttpError, routeSpecOf } from '../context.ts';
import { defineWebPlugin, type WebPluginSpec } from '../plugins.ts';
import type { Middleware } from '../middleware.ts';
import { JwtError, verifyJwt, type JwtAlgorithm, type JwtKey, type JwtPayload } from './jwt.ts';

/**
 * **鉴权插件**：Bearer / cookie / 自定义来源取 token → 校验（JWT）→ 把用户放进请求上下文。
 *
 * 纪律：
 *   - 失败一律 **401 + `WWW-Authenticate: Bearer`**，**对外不区分原因**（防探测）；
 *     真正的原因（过期？签名错？iss 不对？）只进**服务端日志**；
 *   - 角色不符是 **403**（已认证但没权限）；
 *   - 密钥在启动期校验：缺失/太短直接**拒绝启动**，且**永不**进日志；
 *   - 只有"需要鉴权"的路由才拦：控制器写 `auth: { required: true }`，或插件配 `required: true` 全局要求。
 */
export interface AuthUser {
  readonly sub?: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly claims: JwtPayload;
}

export interface AuthPluginOptions {
  /** 校验用密钥（HMAC 密钥 / RS·ES 的公钥或私钥）。多把密钥按 `kid` 选，可用于轮换。 */
  keys: readonly JwtKey[];
  /** 算法白名单（默认所有支持算法；`none` 永远不在其中）。 */
  algorithms?: readonly JwtAlgorithm[];
  issuer?: string;
  audience?: string | readonly string[];
  clockToleranceSec?: number;
  /** 全局要求鉴权（默认 false：只有声明了 `auth` 的控制器才拦）。 */
  required?: boolean;
  /** 取 Bearer 的请求头名（默认 authorization）。 */
  header?: string;
  /** 从 cookie 取（例如 `access_token`）。 */
  cookie?: string;
  /** 完全自定义取法（返回 null 表示没有）。 */
  extractToken?: (ctx: { header(name: string): string | undefined; headers: Record<string, unknown> }) => string | null;
  /** 角色 claim 名（默认 roles）。 */
  rolesClaim?: string;
  /** scope claim 名（默认 scope，空格分隔；也接受 scopes 数组）。 */
  scopesClaim?: string;
  /** 额外校验（撤销/黑名单）—— 抛错即拒绝。 */
  verifyExtra?: (payload: JwtPayload) => void | Promise<void>;
  /** 服务端记明细（失败原因只到这里，绝不回给客户端）。 */
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

const MIN_HMAC_BYTES = 32; // RFC 7518：HS256 的密钥至少 256 bit

function assertKeys(keys: readonly JwtKey[]): void {
  if (!Array.isArray(keys) || keys.length === 0) throw new DbConfigError('authPlugin: "keys" 不能为空');
  for (const key of keys) {
    if (key.algorithm.startsWith('HS')) {
      const bytes = typeof key.key === 'string' ? Buffer.byteLength(key.key, 'utf8') : key.key.byteLength;
      if (bytes < MIN_HMAC_BYTES) {
        throw new DbConfigError(`authPlugin: HMAC 密钥太短（${bytes} 字节 < ${MIN_HMAC_BYTES}）——拒绝启动，也不会把它写进日志`);
      }
    }
  }
}

function toUser(payload: JwtPayload, rolesClaim: string, scopesClaim: string): AuthUser {
  const rawRoles = payload[rolesClaim];
  const roles = Array.isArray(rawRoles) ? rawRoles.map(String) : typeof rawRoles === 'string' ? rawRoles.split(/[\s,]+/).filter(Boolean) : [];
  const rawScopes = payload[scopesClaim];
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.map(String)
    : typeof rawScopes === 'string'
      ? rawScopes.split(/\s+/).filter(Boolean)
      : [];
  return { ...(payload.sub === undefined ? {} : { sub: String(payload.sub) }), roles, scopes, claims: payload };
}

/** 401：**对外不区分原因**，但带上 `WWW-Authenticate`。 */
function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', undefined, { 'www-authenticate': 'Bearer' });
}

/**
 * 路由级中间件：要求已认证用户具备某个角色（否则 403）。
 *
 * ⚠️ 它自带 `phase: 'auth'` 标记 —— 否则默认的 `pre` 阶段会让它跑在 `authPlugin` **之前**
 * （那时 `ctx.user` 还没设，于是所有请求都 401）。中间件阶段由框架保证顺序，别靠人肉排。
 */
export function requireRole(...roles: string[]): Middleware {
  const handler: Middleware = async (ctx, next) => {
    const user = ctx.extension<AuthUser>('user');
    if (user === undefined) throw new HttpError(401, 'unauthorized', undefined, { 'www-authenticate': 'Bearer' });
    if (!roles.some((role) => user.roles.includes(role))) throw new HttpError(403, 'forbidden');
    return next();
  };
  (handler as unknown as { phase: string }).phase = 'auth';
  return handler;
}

/** 鉴权插件：中间件跑在 **auth 阶段**（在解析 body 之前）。 */
export function authPlugin(options: AuthPluginOptions): WebPluginSpec {
  assertKeys(options.keys);
  const headerName = (options.header ?? 'authorization').toLowerCase();
  const rolesClaim = options.rolesClaim ?? 'roles';
  const scopesClaim = options.scopesClaim ?? 'scope';

  const extract = (ctx: { header(name: string): string | undefined }): string | null => {
    if (options.extractToken !== undefined) return options.extractToken(ctx as never);
    const raw = ctx.header(headerName);
    if (raw !== undefined) {
      const match = /^bearer\s+(.+)$/i.exec(raw.trim());
      if (match?.[1] !== undefined) return match[1];
    }
    if (options.cookie !== undefined) {
      const cookie = ctx.header('cookie');
      if (cookie !== undefined) {
        for (const part of cookie.split(';')) {
          const [name, ...rest] = part.trim().split('=');
          if (name === options.cookie) return decodeURIComponent(rest.join('='));
        }
      }
    }
    return null;
  };

  return defineWebPlugin({
    name: 'auth',
    middleware: [
      {
        name: 'auth',
        phase: 'auth',
        handler: async (ctx, next) => {
          const spec = routeSpecOf<{ auth?: { required?: boolean; roles?: readonly string[] } }>(ctx);
          const requirement = spec?.auth;
          const needsAuth =
            options.required === true || requirement?.required === true || (requirement?.roles?.length ?? 0) > 0;

          const token = extract(ctx);
          if (token === null) {
            if (!needsAuth) return next(); // 不要求鉴权：放行（ctx.user 不设置）
            options.logger?.('auth_failed', { requestId: ctx.requestId, path: ctx.path, reason: 'missing_token' });
            throw unauthorized();
          }

          let user: AuthUser;
          try {
            const { payload } = await verifyJwt(token, {
              keys: options.keys,
              ...(options.algorithms === undefined ? {} : { algorithms: options.algorithms }),
              ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
              ...(options.audience === undefined ? {} : { audience: options.audience }),
              ...(options.clockToleranceSec === undefined ? {} : { clockToleranceSec: options.clockToleranceSec }),
              ...(options.verifyExtra === undefined ? {} : { verifyExtra: options.verifyExtra }),
            });
            user = toUser(payload, rolesClaim, scopesClaim);
          } catch (err) {
            // 明细只进服务端日志；回给客户端的一律是裸 401
            const reason = err instanceof JwtError ? err.reason : 'verify_failed';
            options.logger?.('auth_failed', {
              requestId: ctx.requestId,
              path: ctx.path,
              reason,
              ...(err instanceof Error ? { detail: err.message } : {}),
            });
            throw unauthorized();
          }

          ctx.extend({ user });
          const requiredRoles = requirement?.roles ?? [];
          if (requiredRoles.length > 0 && !requiredRoles.some((role) => user.roles.includes(role))) {
            options.logger?.('authz_failed', { requestId: ctx.requestId, path: ctx.path, requiredRoles, userRoles: user.roles });
            throw new HttpError(403, 'forbidden');
          }
          return next();
        },
      },
    ],
  });
}
