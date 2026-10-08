import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigValidationError, defineConfig, loadConfig, validateValues } from '../src/index.ts';

function tempConfigDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-sugar-config-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

/**
 * M9f T2：**配置值即 schema**
 *
 * 门禁是"行为等价（可证伪）"：简写写法的 `fields` 必须与手写全量写法**深比较相等** ——
 * 于是"糖产出与长名漂移"会立刻红，而不是靠"看起来能用"。
 */

test('config 简写：值即 schema，与全量写法逐字段深比较相等', () => {
  const sugared = defineConfig({
    port: 3000,
    name: 'app',
    verbose: false,
    tags: ['a', 'b'],
    nested: { retries: 3 },
  });
  const verbose = defineConfig({
    port: { type: 'number', default: 3000 },
    name: { type: 'string', default: 'app' },
    verbose: { type: 'boolean', default: false },
    tags: { type: 'json', default: ['a', 'b'] },
    nested: { retries: { type: 'number', default: 3 } },
  });
  assert.deepStrictEqual(
    [...sugared.fields.entries()],
    [...verbose.fields.entries()],
    '糖产出的字段表必须与全量写法完全一致',
  );
  assert.deepStrictEqual(sugared.schema, verbose.schema, 'schema 本身也应当等价（简写原地展开）');
});

test('config 简写与全量写法**可混用**（同一份 schema 里两种都写）', () => {
  const definition = defineConfig({
    port: 3000,                                   // 简写
    token: { type: 'string', secret: true },       // 全量（必填 + 打码）
    mode: { type: 'string', default: 'dev', enum: ['dev', 'prod'] }, // 全量（枚举约束）
  });
  assert.deepStrictEqual(
    [...definition.fields.entries()],
    [
      ['port', { type: 'number', default: 3000 }],
      ['token', { type: 'string', secret: true }],
      ['mode', { type: 'string', default: 'dev', enum: ['dev', 'prod'] }],
    ],
  );
});

test('config 简写：跑完整加载链路，行为与全量写法一致（含 env / 文件 / overrides）', async () => {
  const sugared = defineConfig({ port: 3000, name: 'app', db: { url: 'tcp://x' } });
  const verbose = defineConfig({
    port: { type: 'number', default: 3000 },
    name: { type: 'string', default: 'app' },
    db: { url: { type: 'string', default: 'tcp://x' } },
  });
  const dir = tempConfigDir({ 'default.json': JSON.stringify({ name: 'from-file' }) });
  const options = {
    configDir: dir,
    env: { APP_PORT: '4000', APP_DB__URL: 'tcp://env' },
    overrides: { name: 'from-override' },
  };
  const a = await loadConfig(sugared, options);
  const b = await loadConfig(verbose, options);
  assert.deepStrictEqual(a.all(), b.all());
  assert.deepStrictEqual(a.all(), { port: 4000, name: 'from-override', db: { url: 'tcp://env' } });
  assert.deepStrictEqual(a.sources, b.sources, '来源标签也要一致（同一套分层）');
});

test('config 简写：类型推断从值来（数字/布尔/数组/字符串），错值仍在启动期被拒', async () => {
  const definition = defineConfig({ port: 3000, tags: ['x'] });
  assert.strictEqual(definition.fields.get('port')?.type, 'number');
  assert.strictEqual(definition.fields.get('tags')?.type, 'json');
  // 文件里写了错类型 → 与全量写法同一套报错（不是"简写就免检"）
  const dir = tempConfigDir({ 'default.json': JSON.stringify({ port: 'not-a-number' }) });
  await assert.rejects(() => loadConfig(definition, { configDir: dir, env: {} }), /期望 number/);
});

test('config 简写：普通对象一律当分组（不会被当成"对象默认值"）', () => {
  const definition = defineConfig({ server: { port: 80 } });
  assert.deepStrictEqual([...definition.fields.keys()], ['server.port'], '对象展开成分组，点路径可见');
  // 要对象默认值就写 json（意图明确）
  const explicit = defineConfig({ server: { type: 'json', default: { port: 80 } } });
  assert.deepStrictEqual([...explicit.fields.keys()], ['server']);
});

test('config 简写：无法推断的值与拼错的 type 都给出可操作的报错', () => {
  assert.throws(
    () => defineConfig({ broken: null }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError, '应当是配置校验错误');
      assert.match(error.message, /broken/);
      assert.match(error.message, /无法从值推断/);
      assert.match(error.message, /\{ type: 'json', default/);
      return true;
    },
  );
  // 拼错的类型：在**定义期**就报，而不是被当成分组展开（那样会报出莫名其妙的叶子错）
  assert.throws(
    () => defineConfig({ broken: { type: 'strng' } }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /broken/);
      assert.match(error.message, /未知的字段类型 'strng'/);
      return true;
    },
  );
  // 带 type 但取值是数组（JSON schema 风格误写）也要说清楚，不是默默分组
  assert.throws(() => defineConfig({ broken: { type: ['string', 'null'] } }), /未知的字段类型/);
});

test('config 简写：validateValues 也吃简写（控制器输入与配置同一套机制）', () => {
  const { values, issues } = validateValues({ name: 'anon', size: 1 }, {});
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(values, { name: 'anon', size: 1 });

  const required = validateValues({ name: { type: 'string' } }, {});
  assert.strictEqual(required.issues.length, 1, '全量写法不带 default = 必填');
  assert.match(required.issues[0]?.message ?? '', /缺少必填项/);
});
