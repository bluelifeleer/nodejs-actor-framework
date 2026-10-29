import { createHash, randomBytes } from 'node:crypto';
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

import { DbConfigError } from '@actor/resource';

/**
 * **refresh token**：不透明随机串（**不是 JWT** —— 必须能撤销）+ **轮换** + **重放即整族撤销**。
 *
 * 语义（写进契约套件，任何实现都要满足）：
 *   1. `issue()` 发一个 token，属于某个 `family`；
 *   2. `consume()` 校验成功后**换发新 token**（同族），旧 token 立即作废；
 *   3. **旧 token 再被用一次 = 重放攻击** → **整个族撤销**（连同刚换发的新 token 一起失效）；
 *   4. 过期 / 未知 token 明确区分（服务端日志用；对外一律 401 ✗ 别把原因回给客户端）。
 *
 * 存储里只放 **token 的 sha256**（不放原文）—— 存储被读走也不等于拿到可用会话。
 */
export interface RefreshTokenRecord {
  readonly family: string;
  readonly subject: string;
  readonly expiresAt: string;
  readonly used: boolean;
}

export interface IssuedRefreshToken {
  readonly token: string;
  readonly family: string;
  readonly subject: string;
  readonly expiresAt: string;
}

export type RefreshConsumeResult =
  | { readonly ok: true; readonly subject: string; readonly family: string; readonly issued: IssuedRefreshToken }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'replay' };

export interface RefreshTokenStore {
  issue(input: { subject: string; family?: string; ttlMs?: number }): Promise<IssuedRefreshToken>;
  /** 校验并**轮换**；重放会撤销整族。 */
  consume(token: string): Promise<RefreshConsumeResult>;
  /** 撤销整族（登出全部设备/发现异常时用）。 */
  revokeFamily(family: string): Promise<number>;
  /** 撤销单个 token。 */
  revoke(token: string): Promise<boolean>;
  purgeExpired?(now?: number): Promise<number>;
}

export interface RefreshStoreOptions {
  /** token 有效期（默认 30 天）。 */
  ttlMs?: number;
  /**
   * 允许在 `NODE_ENV=production` 下用内存实现。
   *
   * ⚠️ 内存实现是**单节点**语义：多实例部署时，A 实例发的 token 到 B 实例就"未见过"（表现为随机登出），
   * 而重放检测也会被绕过。所以生产环境**默认拒绝启动**，要用必须显式承认。
   */
  allowInMemoryInProduction?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function newToken(): string {
  return randomBytes(32).toString('base64url');
}
function newFamily(): string {
  return randomBytes(12).toString('hex');
}

function assertSingleNodeSafe(options: RefreshStoreOptions): void {
  const production = process.env['NODE_ENV'] === 'production';
  if (production && options.allowInMemoryInProduction !== true) {
    throw new DbConfigError(
      'memoryRefreshStore 是单节点实现：生产环境请换成共享存储（例如 redisRefreshStore），' +
        '或显式传 { allowInMemoryInProduction: true } 承担"随机登出 + 重放检测被绕过"的后果',
    );
  }
  if (production) options.logger?.('refresh_store_in_memory_in_production', { acknowledged: true });
}

/** 内存实现（单节点/测试）。生产默认拒绝启动，理由见 `allowInMemoryInProduction`。 */
export function memoryRefreshStore(options: RefreshStoreOptions = {}): RefreshTokenStore {
  assertSingleNodeSafe(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const byHash = new Map<string, RefreshTokenRecord>();

  const issueInto = (subject: string, family: string, ttl: number): IssuedRefreshToken => {
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    byHash.set(hashToken(token), { family, subject, expiresAt, used: false });
    return { token, family, subject, expiresAt };
  };

  return {
    async issue(input) {
      return issueInto(input.subject, input.family ?? newFamily(), input.ttlMs ?? ttlMs);
    },
    async consume(token) {
      const hash = hashToken(token);
      const record = byHash.get(hash);
      if (record === undefined) return { ok: false, reason: 'unknown' };
      if (Date.parse(record.expiresAt) < Date.now()) {
        byHash.delete(hash);
        return { ok: false, reason: 'expired' };
      }
      if (record.used) {
        // 重放：整族撤销（包括攻击者手上那把"新" token）
        let revoked = 0;
        for (const [key, value] of byHash) {
          if (value.family === record.family) {
            byHash.delete(key);
            revoked += 1;
          }
        }
        options.logger?.('refresh_replay_detected', { family: record.family, revoked });
        return { ok: false, reason: 'replay' };
      }
      byHash.set(hash, { ...record, used: true });
      const ttl = Math.max(1000, Date.parse(record.expiresAt) - Date.now());
      return { ok: true, subject: record.subject, family: record.family, issued: issueInto(record.subject, record.family, ttl) };
    },
    async revokeFamily(family) {
      let removed = 0;
      for (const [key, value] of byHash) {
        if (value.family === family) {
          byHash.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    async revoke(token) {
      return byHash.delete(hashToken(token));
    },
    async purgeExpired(now = Date.now()) {
      let removed = 0;
      for (const [key, value] of byHash) {
        if (Date.parse(value.expiresAt) < now) {
          byHash.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/** `redisRefreshStore` 需要的最小客户端形状（`@actor/redis` 的 KeyValueClient 满足它，**不引入依赖**）。 */
export interface RefreshKeyValueClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ttlMs?: number; ifNotExists?: boolean }): Promise<boolean | void>;
  del(...keys: string[]): Promise<number>;
}

interface StoredFamily {
  readonly subject: string;
  readonly tokens: Array<{ hash: string; expiresAt: string; used: boolean }>;
}

/**
 * 共享存储实现（多节点可用）：给 `@actor/redis` 的客户端即可。
 *
 * 结构：`<prefix><hash>` = 家族 id（用于快速找到族）；`<prefix>family:<family>` = 整族记录（含每个 token 的状态）。
 * 轮换 = 在族记录里把旧 token 标 used 并追加新 token；重放 = 发现 used 记录 → 删整族键。
 */
export function redisRefreshStore(client: RefreshKeyValueClient, options: RefreshStoreOptions & { prefix?: string } = {}): RefreshTokenStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const prefix = options.prefix ?? 'refresh:';
  const familyKey = (family: string): string => `${prefix}family:${family}`;
  const tokenKey = (hash: string): string => `${prefix}${hash}`;

  const readFamily = async (family: string): Promise<StoredFamily | null> => client.get<StoredFamily>(familyKey(family));
  const writeFamily = async (family: string, value: StoredFamily, ttl: number): Promise<void> => {
    await client.set(familyKey(family), value, { ttlMs: ttl });
  };

  const issueInto = async (subject: string, family: string, ttl: number): Promise<IssuedRefreshToken> => {
    const token = newToken();
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const existing = (await readFamily(family)) ?? { subject, tokens: [] };
    const tokens = [...existing.tokens.filter((item) => Date.parse(item.expiresAt) > Date.now()), { hash, expiresAt, used: false }];
    await writeFamily(family, { subject: existing.subject || subject, tokens }, ttl);
    await client.set(tokenKey(hash), family, { ttlMs: ttl });
    return { token, family, subject: existing.subject || subject, expiresAt };
  };

  /** 已持有 NX 锁后执行真正的消费逻辑（见下方 consume 的并发说明）。 */
  const consumeLocked = async (hash: string): Promise<RefreshConsumeResult> => {
    const family = await client.get<string>(tokenKey(hash));
    if (family === null || family === undefined) return { ok: false, reason: 'unknown' };
    const record = await readFamily(family);
    if (record === null) return { ok: false, reason: 'unknown' };
    const entry = record.tokens.find((item) => item.hash === hash);
    if (entry === undefined) return { ok: false, reason: 'unknown' };
    if (Date.parse(entry.expiresAt) < Date.now()) {
      await client.del(tokenKey(hash));
      return { ok: false, reason: 'expired' };
    }
    if (entry.used) {
      const keys = [familyKey(family), ...record.tokens.map((item) => tokenKey(item.hash))];
      const revoked = await client.del(...keys);
      options.logger?.('refresh_replay_detected', { family, revoked });
      return { ok: false, reason: 'replay' };
    }
    const ttl = Math.max(1000, Date.parse(entry.expiresAt) - Date.now());
    const updated: StoredFamily = {
      subject: record.subject,
      tokens: record.tokens.map((item) => (item.hash === hash ? { ...item, used: true } : item)),
    };
    await writeFamily(family, updated, ttl);
    return { ok: true, subject: record.subject, family, issued: await issueInto(record.subject, family, ttl) };
  };

  return {
    async issue(input) {
      return issueInto(input.subject, input.family ?? newFamily(), input.ttlMs ?? ttlMs);
    },
    async consume(token) {
      const hash = hashToken(token);
      /**
       * 同一 token 的并发消费必须只有一个赢家：读-改-写没有 CAS 时，
       * 两个请求会各发一把新 token，重放检测形同虚设。用短 TTL 的 NX 锁串行化。
       */
      const lockKey = `${tokenKey(hash)}:lock`;
      const acquired = await client.set(lockKey, '1', { ttlMs: 5000, ifNotExists: true });
      if (acquired === false) return { ok: false, reason: 'replay' };
      try {
        return await consumeLocked(hash);
      } finally {
        await client.del(lockKey).catch(() => 0);
      }
    },
    async revokeFamily(family) {
      const record = await readFamily(family);
      if (record === null) return 0;
      const keys = [familyKey(family), ...record.tokens.map((item) => tokenKey(item.hash))];
      await client.del(...keys);
      return record.tokens.length;
    },
    async revoke(token) {
      const hash = hashToken(token);
      const family = await client.get<string>(tokenKey(hash));
      if (family === null || family === undefined) return false;
      await client.del(tokenKey(hash));
      const record = await readFamily(family);
      if (record !== null) {
        await writeFamily(family, { subject: record.subject, tokens: record.tokens.filter((item) => item.hash !== hash) }, ttlMs);
      }
      return true;
    },
  };
}

/** 契约套件：任何 `RefreshTokenStore` 实现都应通过（含重放即整族撤销这条安全不变量）。 */
export function runRefreshStoreContract(options: {
  name: string;
  make: () => RefreshTokenStore | Promise<RefreshTokenStore>;
  /** 换一个实例看同一份数据（共享存储实现要能续上；纯内存实现可省略）。 */
  reopen?: () => RefreshTokenStore | Promise<RefreshTokenStore>;
  /**
   * 过期 token 的报法：内存实现能区分 `expired`；**KV 型存储**（Redis 等）到期键直接消失，
   * 只能报 `unknown` —— 这是诚实答案，不是缺陷，所以显式声明而不是把断言放松掉。
   */
  expiryReportsAs?: 'expired' | 'unknown';
}): void {
  test(`[refresh-store:${options.name}] 签发 → 消费即轮换（新旧 token 都能算清）`, async () => {
    const store = await options.make();
    const issued = await store.issue({ subject: 'u1' });
    assert.ok(issued.token.length >= 32, 'token 必须是不透明随机串');
    assert.ok(!issued.token.includes('.'), '不能是 JWT（必须可撤销、无自描述）');

    const first = await store.consume(issued.token);
    assert.strictEqual(first.ok, true);
    if (!first.ok) return;
    assert.strictEqual(first.subject, 'u1');
    assert.strictEqual(first.family, issued.family, '轮换后的 token 必须在同一族');
    assert.notStrictEqual(first.issued.token, issued.token, '必须换发新 token');
    assert.strictEqual(await store.consume(first.issued.token).then((r) => r.ok), true, '新 token 可以用');
  });

  test(`[refresh-store:${options.name}] **重放旧 token → 整族撤销**（连新 token 一起失效）`, async () => {
    const store = await options.make();
    const issued = await store.issue({ subject: 'u2' });
    const rotated = await store.consume(issued.token);
    assert.ok(rotated.ok);
    if (!rotated.ok) return;

    // 攻击者拿着旧 token 再来一次 → 重放
    const replay = await store.consume(issued.token);
    assert.strictEqual(replay.ok, false);
    if (!replay.ok) assert.strictEqual(replay.reason, 'replay');

    // 族被撤销：刚换发的那把也不能用了（这是这条防御的意义）
    const afterReplay = await store.consume(rotated.issued.token);
    assert.strictEqual(afterReplay.ok, false);
    if (!afterReplay.ok) assert.strictEqual(afterReplay.reason, 'unknown', '整族都该被删掉');
  });

  test(`[refresh-store:${options.name}] 未知 / 过期 / 撤销的 token 都明确区分`, async () => {
    const store = await options.make();
    const unknown = await store.consume('definitely-not-a-token');
    assert.deepStrictEqual(unknown, { ok: false, reason: 'unknown' });

    const shortLived = await store.issue({ subject: 'u3', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await store.consume(shortLived.token);
    assert.strictEqual(expired.ok, false);
    if (!expired.ok) {
      assert.strictEqual(expired.reason, options.expiryReportsAs ?? 'expired');
    }

    const revocable = await store.issue({ subject: 'u4' });
    assert.strictEqual(await store.revoke(revocable.token), true);
    assert.strictEqual((await store.consume(revocable.token)).ok, false);

    const familyA = await store.issue({ subject: 'u5' });
    const familyB = await store.issue({ subject: 'u6' });
    assert.ok((await store.revokeFamily(familyA.family)) >= 1);
    assert.strictEqual((await store.consume(familyA.token)).ok, false);
    assert.strictEqual((await store.consume(familyB.token)).ok, true, '撤销一族不能影响别族');
  });

  if (options.reopen !== undefined) {
    test(`[refresh-store:${options.name}] 换实例后仍认得（共享存储语义）`, async () => {
      const store = await options.make();
      const issued = await store.issue({ subject: 'u7' });
      const reopened = await options.reopen?.();
      const consumed = await (reopened as RefreshTokenStore).consume(issued.token);
      assert.strictEqual(consumed.ok, true, '另一个实例也要认得这个 token');
    });
  }
}
