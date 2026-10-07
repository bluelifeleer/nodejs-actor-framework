import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';

import {
  decryptJwe,
  decryptToJws,
  encryptJwe,
  JweError,
  type JweKey,
} from '../src/auth/jwe.ts';
import { JwtError, signJwt, verifyJwt, type JwtKey } from '../src/auth/jwt.ts';

const shared = Buffer.alloc(32, 7);
const dirKey = (kid?: string): JweKey => ({ alg: 'dir', key: shared, ...(kid === undefined ? {} : { kid }) });

test('jwe: dir + A256GCM 往返；密文里看不到明文', () => {
  const secret = 'top-secret-payload-中文';
  const token = encryptJwe(secret, { key: dirKey() });
  assert.strictEqual(token.split('.').length, 5, 'JWE 必须是五段');
  assert.ok(!token.includes(secret), '密文里不能出现明文');
  assert.ok(!token.includes(Buffer.from(secret).toString('base64')), 'base64 也不能出现');
  assert.strictEqual(decryptJwe(token, { keys: [dirKey()] }), secret);

  // AAD 绑定 protected header：改 header 就解不开
  const [header, ...rest] = token.split('.');
  const forgedHeader = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', typ: 'evil' })).toString('base64url');
  assert.throws(() => decryptJwe([forgedHeader, ...rest].join('.'), { keys: [dirKey()] }), /解密失败/);

  // 篡改密文 / 认证标签 / IV 都必须拒绝（GCM 的认证性）
  for (const index of [2, 3, 4]) {
    const parts = token.split('.');
    const original = parts[index] as string;
    parts[index] = `${original.slice(0, -2)}${original.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.throws(() => decryptJwe(parts.join('.'), { keys: [dirKey()] }), /解密失败/, `第 ${index} 段被篡改必须拒绝`);
  }
});

test('jwe: dir 密钥必须 32 字节（A256GCM）；找不到 kid 明确报错', () => {
  assert.throws(() => encryptJwe('x', { key: { alg: 'dir', key: Buffer.alloc(16) } }), /32 字节/);
  const token = encryptJwe('x', { key: dirKey('new') });
  assert.throws(() => decryptJwe(token, { keys: [dirKey('old')] }), (err: unknown) => {
    assert.ok(err instanceof JweError);
    assert.strictEqual(err.reason, 'key_not_found');
    return true;
  });
});

test('jwe: RSA-OAEP-256 + A256GCM 往返；公钥加密、私钥解密、kid 轮换', () => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = (pair: typeof first, kid: string): JweKey => ({
    alg: 'RSA-OAEP-256',
    kid,
    key: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });
  const priv = (pair: typeof first, kid: string): JweKey => ({
    alg: 'RSA-OAEP-256',
    kid,
    key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  });

  const token = encryptJwe('rsa-secret', { key: pub(first, 'k1') });
  assert.strictEqual(decryptJwe(token, { keys: [priv(first, 'k1')] }), 'rsa-secret');
  // 轮换：同时挂新旧密钥，按 kid 选
  assert.strictEqual(decryptJwe(token, { keys: [priv(second, 'k2'), priv(first, 'k1')] }), 'rsa-secret');
  // 拿错私钥 → 解密失败
  assert.throws(() => decryptJwe(token, { keys: [priv(second, 'k1')] }), /解密失败/);
});

test('jwe: 不支持的组合**显式拒绝**，并说清支持什么', () => {
  for (const bad of [
    { alg: 'RSA-OAEP', key: '' },
    { alg: 'A256KW', key: '' },
    { alg: 'none', key: '' },
  ]) {
    assert.throws(
      () => encryptJwe('x', { key: bad as unknown as JweKey }),
      (err: unknown) => {
        assert.ok(err instanceof JweError);
        assert.strictEqual(err.reason, 'not_supported');
        assert.match((err as Error).message, /只支持 RSA-OAEP-256, dir/);
        return true;
      },
      `${bad.alg} 必须被显式拒绝`,
    );
  }
  assert.throws(() => encryptJwe('x', { key: dirKey(), enc: 'A128GCM' as never }), /只支持 A256GCM/);

  // 解密侧同样拒绝（伪造 header）
  const forged = [
    Buffer.from(JSON.stringify({ alg: 'RSA1_5', enc: 'A256GCM' })).toString('base64url'),
    '',
    '',
    '',
    '',
  ].join('.');
  assert.throws(() => decryptJwe(forged, { keys: [dirKey()] }), /不支持的 alg/);
});

test('jwe: 嵌套 JWS-in-JWE（签名后加密 → 解密 → 验签）', async () => {
  const signKey: JwtKey = { algorithm: 'HS256', key: 'a-very-long-development-secret-0123456789' };
  const jws = signJwt({ sub: 'nested', roles: ['admin'] }, { key: signKey, expiresInSec: 60 });
  const jwe = encryptJwe(jws, { key: dirKey(), typ: 'JWT' });
  assert.ok(!jwe.includes('nested'), '加密后不应看到内层声明');

  const back = decryptToJws(jwe, { keys: [dirKey()] });
  const { payload } = await verifyJwt(back, { keys: [signKey] });
  assert.strictEqual(payload.sub, 'nested');

  // 内层被篡改 → 验签失败（外层解开了也没用）
  const [h, b, s] = jws.split('.') as [string, string, string];
  const evil = `${h}.${Buffer.from(JSON.stringify({ sub: 'root' })).toString('base64url')}.${s}`;
  await assert.rejects(() => verifyJwt(decryptToJws(encryptJwe(evil, { key: dirKey() }), { keys: [dirKey()] }), { keys: [signKey] }), /签名/);

  // 内层不是 JWS → decryptToJws 明确报错
  assert.throws(() => decryptToJws(encryptJwe('not-a-jws', { key: dirKey() }), { keys: [dirKey()] }), (err: unknown) => {
    assert.ok(err instanceof JwtError);
    assert.strictEqual(err.reason, 'malformed');
    return true;
  });
});
