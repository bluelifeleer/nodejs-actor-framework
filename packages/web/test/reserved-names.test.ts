import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, defineApp, defineModule } from '@actor/app';

import {
  declaredPrefixOwners,
  duplicatePrefixOwners,
  frameworkPrefixOwners,
  inReservedPrefix,
  pluginPrefixCollisions,
  prefixesOverlap,
  RESERVED_CONTEXT_KEYS,
  RESERVED_PREFIX_OWNERS,
  RESERVED_ROUTE_PREFIXES,
} from '../src/context.ts';
import { debugPlugin } from '../src/debug.ts';
import { httpPlugin } from '../src/http.ts';
import { defineWebPlugin } from '../src/plugins.ts';
import { defineRoutes, get, reservedPrefixIssues } from '../src/routes.ts';
import { uploadPlugin } from '../src/upload/plugin.ts';
import { localDiskStorage } from '../src/upload/storage.ts';

const WEB_SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * M9e 尾巴：**保留名的单一来源 + 装配期校验**
 *
 * 这里盯的是"清单与实现分叉"：`RESERVED_ROUTE_PREFIXES` / `RESERVED_PREFIX_OWNERS` 是人写的清单，
 * 而内置插件的实际默认前缀是代码里的字面量 —— 两者一旦分叉，装配期校验就会漏（或误报）。
 * 所以门禁必须读**实现里的实际值**（把插件造出来、把默认路由造出来），而不是再抄一遍常量。
 */

/** 递归读一个目录下所有 .ts 文件（文本门禁用）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('保留前缀：清单与"谁占用它"一一对应（没有多余、没有缺失）', () => {
  assert.deepStrictEqual(
    RESERVED_PREFIX_OWNERS.map((item) => item.prefix).sort(),
    [...RESERVED_ROUTE_PREFIXES].sort(),
    '两张表必须互相覆盖（清单是唯一来源）',
  );
  for (const item of RESERVED_PREFIX_OWNERS) {
    assert.ok(item.prefix.startsWith('/'), `保留前缀必须以 / 开头：${item.prefix}`);
    assert.ok(item.owner.trim().length > 0, '保留前缀必须记名（报错时要指名道姓）');
  }
});

test('保留前缀：内置插件**实际默认占用**的前缀 ⊆ 清单（分叉就红）', () => {
  const upload = uploadPlugin({ storage: localDiskStorage({ dir: 'data/test-uploads' }) });
  assert.strictEqual(upload.routePrefix, '/uploads', 'uploadPlugin 的默认前缀变了就同步清单');
  assert.strictEqual(upload.framework, true, '框架自带插件必须打 framework 标记（放行判据靠它）');

  const debug = debugPlugin({ enabled: true, token: 'a-very-long-debug-token' });
  assert.strictEqual(debug.routePrefix, '/__debug', 'debugPlugin 的默认前缀变了就同步清单');
  assert.strictEqual(debug.framework, true);
  assert.deepStrictEqual(
    (debug.routes ?? []).map((route) => String((route as unknown as readonly unknown[])[1])),
    ['/__debug/routes', '/__debug/health', '/__debug/config'],
    '路由必须在声明的前缀下（前缀只能套一次）',
  );

  // 源码里的**字面量默认值**也要在清单里：光看插件产出会漏掉"模块路由撞车"那半边
  for (const file of sourceFiles(WEB_SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    const found = [...source.matchAll(/routePrefix\s*\?\?\s*(['"])(\/[^'"]*)\1/g)].map((match) => match[2]);
    for (const literal of found) {
      if (!inReservedPrefix(literal)) continue;
      assert.ok(
        RESERVED_ROUTE_PREFIXES.includes(literal),
        `${path.relative(process.cwd(), file)} 里的默认前缀 ${literal} 不在 RESERVED_ROUTE_PREFIXES 里`,
      );
    }
  }
});

test('保留前缀：inReservedPrefix / prefixesOverlap 只按命名空间判定（不做模糊猜测）', () => {
  assert.strictEqual(inReservedPrefix('/__debug'), true);
  assert.strictEqual(inReservedPrefix('/__debug/routes'), true, '子路径也算（前缀是命名空间）');
  assert.strictEqual(inReservedPrefix('/__debug?x=1'), true, '查询声明不参与判定');
  assert.strictEqual(inReservedPrefix('/__debugger'), false, '同前缀但不同命名空间不算');
  assert.strictEqual(inReservedPrefix('/uploads/chunked/init'), true);
  assert.strictEqual(inReservedPrefix('/public'), false);

  assert.strictEqual(prefixesOverlap('/__debug', '/__debug/x'), true, '父子算重叠');
  assert.strictEqual(prefixesOverlap('/', '/__debug'), true, '根前缀把一切都包进去 → 重叠');
  assert.strictEqual(prefixesOverlap('/a', '/b'), false);
  assert.strictEqual(prefixesOverlap('/debug', '/__debug'), false, '只按命名空间，不看相似度');
});

test('保留前缀：模块路由撞上保留前缀 → 启动期明确报错，并说清下一步', async () => {
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({ name: 'site', routes: defineRoutes([get('/__debug/mine', () => ({ ok: true }))]) }),
      ],
      plugins: [http],
    }),
    { configDir: null, env: {} },
  );
  await assert.rejects(
    () => app.start(),
    (error: Error) => {
      assert.match(error.message, /保留前缀/);
      assert.match(error.message, /\/__debug\/mine/, '报错要指名道姓（哪条路由）');
      assert.match(error.message, /routePrefix|prefix/, '报错要说清下一步怎么绕开');
      return true;
    },
  );
});

test('保留前缀：路由层没有放行名单——带归属的路由落在保留区一律拦（框架插件走插件层）', () => {
  const owned = [
    { pattern: '/uploads/chunked/init', meta: { module: 'upload' } },
    { pattern: '/__debug/routes', meta: { module: 'debug' } },
  ];
  assert.strictEqual(
    reservedPrefixIssues(owned, RESERVED_PREFIX_OWNERS, inReservedPrefix).length,
    2,
    '带归属的路由就算名字与框架插件一样，也不能靠 meta 伪装成框架路由',
  );
  // 调用方（httpPlugin）只把**带归属**的路由喂进来：插件贡献的路由不带归属，由插件层负责
  const input = [['GET', '/__debug/routes', null, undefined, { module: 'site' }], ['GET', '/__debug/x', null]];
  const withOwner = input.filter((entry) => {
    const meta = entry[4] as { module?: string } | undefined;
    return meta?.module !== undefined;
  });
  assert.strictEqual(reservedPrefixIssues(withOwner, RESERVED_PREFIX_OWNERS, inReservedPrefix).length, 1);
});

test('保留前缀：插件层——第三方插件不许认领保留区（含"父前缀吞掉保留区"）', () => {
  assert.deepStrictEqual(
    pluginPrefixCollisions([
      defineWebPlugin({ name: 'debug', framework: true, routePrefix: '/__debug', routes: [] }),
      defineWebPlugin({ name: 'upload', framework: true, routePrefix: '/uploads', routes: [] }),
    ]),
    [],
    '框架自带插件占自己的保留前缀是设计如此',
  );
  assert.deepStrictEqual(
    pluginPrefixCollisions([defineWebPlugin({ name: 'mine', routePrefix: '/__debug', routes: [] })]),
    [{ owner: 'mine', prefix: '/__debug', reserved: '/__debug' }],
    '同名认领 → 拦',
  );
  assert.deepStrictEqual(
    pluginPrefixCollisions([{ name: 'greedy', routePrefix: '/' }]),
    [{ owner: 'greedy', prefix: '/', reserved: '/uploads' }],
    '父前缀把保留区吞进去 → 拦（报第一个重叠的保留前缀）',
  );
  assert.deepStrictEqual(
    pluginPrefixCollisions([{ name: 'mine', routePrefix: '/files' }]),
    [],
    '自己的命名空间不受影响',
  );
});

test('保留前缀：插件名对不上时按声明判定（改 prefix 后旧路由立刻是错的）', () => {
  assert.deepStrictEqual(
    declaredPrefixOwners([
      { name: 'debug', routePrefix: '/admin/debug' },
      { name: 'upload', routePrefix: '/uploads' },
    ]),
    [
      { owner: 'debug', prefix: '/admin/debug' },
      { owner: 'upload', prefix: '/uploads' },
    ],
  );
  const plugins = [{ name: 'debug', routePrefix: '/admin/debug', framework: true }];
  assert.deepStrictEqual(frameworkPrefixOwners(plugins), ['debug']);
  assert.deepStrictEqual(pluginPrefixCollisions(plugins), [], '改到自己的命名空间 → 不与保留区重叠');
  // 但它若还在 /__debug 下留模块路由 → 路由层照样拦（"我声明了别处"不构成豁免）
  assert.strictEqual(
    reservedPrefixIssues(
      [{ pattern: '/__debug/routes', meta: { module: 'debug' } }],
      RESERVED_PREFIX_OWNERS,
      inReservedPrefix,
    ).length,
    1,
  );
  // 同名第三方插件（无 framework 标记）认领 /__debug → 插件层拦
  assert.deepStrictEqual(
    pluginPrefixCollisions([{ name: 'debug', routePrefix: '/__debug' }]),
    [{ owner: 'debug', prefix: '/__debug', reserved: '/__debug' }],
  );
});

test('保留前缀：端到端——uploadPlugin / debugPlugin 自己的路由不再误报', async () => {
  const http = httpPlugin({ port: 0 });
  const upload = uploadPlugin({ storage: localDiskStorage({ dir: 'data/test-uploads' }) });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'app' })], plugins: [http, upload] }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    const port = http.address()?.port as number;
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/uploads`)).status, 405, '路由在（GET 不允许，POST 才是上传）');
  } finally {
    await app.stop();
  }
});

test('保留前缀：两个插件声明同一前缀 → 启动期报错（同一片命名空间只能有一个主人）', async () => {
  assert.deepStrictEqual(
    duplicatePrefixOwners([
      { name: 'a', routePrefix: '/x' },
      { name: 'b', routePrefix: '/x' },
      { name: 'c', routePrefix: '/y' },
    ]),
    [{ prefix: '/x', owners: ['a', 'b'] }],
  );
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'app' })],
      plugins: [
        http,
        defineWebPlugin({ name: 'one', routePrefix: '/files', routes: [get('/files', () => ({ ok: 1 }))] }),
        defineWebPlugin({ name: 'two', routePrefix: '/files', routes: [get('/files/:id', () => ({ ok: 1 }))] }),
      ],
    }),
    { configDir: null, env: {} },
  );
  await assert.rejects(() => app.start(), /被多个插件声明占用/);
});

test('保留前缀：不撞车的项目照常启动（校验不能误报）', async () => {
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'site', routes: defineRoutes([get('/notes/:id', () => ({ ok: true }))]) })],
      plugins: [http],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    const port = http.address()?.port as number;
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/notes/1`)).status, 200);
  } finally {
    await app.stop();
  }
});

test('保留 ctx 键：清单是单一来源（无重复项，含历史洞的兜底 route）', () => {
  assert.ok(RESERVED_CONTEXT_KEYS.includes('route'), 'route 必须还在清单里（历史洞的兜底）');
  assert.strictEqual(new Set(RESERVED_CONTEXT_KEYS).size, RESERVED_CONTEXT_KEYS.length, '清单不该有重复项');
});
