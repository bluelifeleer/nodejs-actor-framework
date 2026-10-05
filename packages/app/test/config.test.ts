import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig, loadConfig, ConfigValidationError } from '../src/index.ts';

function tempConfigDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-config-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const schema = defineConfig({
  tickMs: { type: 'number', default: 200, min: 16 },
  mode: { type: 'string', default: 'dev', enum: ['dev', 'prod'] },
  debug: { type: 'boolean', default: false },
  gateway: {
    url: { type: 'string', default: 'tcp://127.0.0.1:9000' },
    token: { type: 'string', secret: true, default: '' },
  },
});

test('config: 默认值生效，可用点号路径读取', async () => {
  const config = await loadConfig(schema, { configDir: tempConfigDir({}), env: {} });
  assert.strictEqual(config.get('tickMs'), 200);
  assert.strictEqual(config.get<string>('gateway.url'), 'tcp://127.0.0.1:9000');
  assert.deepStrictEqual(config.all(), {
    tickMs: 200, mode: 'dev', debug: false,
    gateway: { url: 'tcp://127.0.0.1:9000', token: '' },
  });
});

test('config: 分层覆盖 default 文件 < 环境文件 < 环境变量 < overrides', async () => {
  const dir = tempConfigDir({
    'default.json': JSON.stringify({ tickMs: 100, mode: 'dev' }),
    'production.json': JSON.stringify({ tickMs: 400 }),
  });
  const config = await loadConfig(schema, {
    configDir: dir,
    env: { APP_ENV: 'production', APP_TICK_MS: '500', APP_GATEWAY__URL: 'tcp://env:1' },
    overrides: { mode: 'prod' },
  });
  assert.strictEqual(config.get('tickMs'), 500);
  assert.strictEqual(config.get('mode'), 'prod');
  assert.strictEqual(config.get('gateway.url'), 'tcp://env:1');
  assert.ok(config.sources.some((s) => s.includes('default.json')), `sources=${JSON.stringify(config.sources)}`);
  assert.ok(config.sources.includes('env:APP_TICK_MS'));
});

test('config: 每个 base 只取第一个存在的文件（.json 优先于 .ts）', async () => {
  const dir = tempConfigDir({
    'default.json': JSON.stringify({ tickMs: 100 }),
    'default.ts': 'export default { tickMs: 111, mode: "prod" };\n',
  });
  const config = await loadConfig(schema, { configDir: dir, env: {} });
  assert.strictEqual(config.get('tickMs'), 100);
});

test('config: 校验一次性报出全部问题（范围/枚举/必填/未知项）', async () => {
  const dir = tempConfigDir({ 'default.json': JSON.stringify({ tickMs: 5, mode: 'staging', typo: 1 }) });
  const def = defineConfig({
    tickMs: { type: 'number', default: 200, min: 16 },
    mode: { type: 'string', default: 'dev', enum: ['dev', 'prod'] },
    required: { type: 'string' },
  });
  await assert.rejects(
    () => loadConfig(def, { configDir: dir, env: {} }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError, 'should be ConfigValidationError');
      assert.deepStrictEqual(err.issues.map((i) => i.path).sort(), ['mode', 'required', 'tickMs', 'typo']);
      return true;
    },
  );
});

test('config: 环境变量按类型强制转换（number/boolean/json）', async () => {
  const def = defineConfig({
    n: { type: 'number', default: 1 },
    b: { type: 'boolean', default: false },
    j: { type: 'json', default: {} },
  });
  const config = await loadConfig(def, {
    configDir: tempConfigDir({}),
    env: { APP_N: '42', APP_B: 'yes', APP_J: '{"a":1}' },
  });
  assert.strictEqual(config.get('n'), 42);
  assert.strictEqual(config.get('b'), true);
  assert.deepStrictEqual(config.get('j'), { a: 1 });
});

test('config: secret 在 redacted() 中打码，get()/all() 仍为真实值', async () => {
  const dir = tempConfigDir({ 'default.json': JSON.stringify({ gateway: { token: 'super-secret' } }) });
  const config = await loadConfig(schema, { configDir: dir, env: {} });
  assert.strictEqual(config.get('gateway.token'), 'super-secret');
  assert.strictEqual((config.redacted().gateway as Record<string, unknown>).token, '***');
  assert.strictEqual((config.all().gateway as Record<string, unknown>).token, 'super-secret');
});
