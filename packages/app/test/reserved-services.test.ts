import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { createApp, defineApp, defineModule, definePlugin } from '../src/index.ts';
import {
  isReservedServiceName,
  reservedServiceNamesIn,
  RESERVED_SERVICE_NAMES,
} from '../src/assembly.ts';

/**
 * M9e 尾巴：**保留服务名的单一来源 + 装配期校验**
 *
 * 服务名是全局命名空间（`app.provide(name)` → `ctx.get(name)`），框架自己占着几个 ——
 * 撞名会让"谁的值胜出"取决于注册顺序，属于静默覆盖那一类。所以门禁盯两件事：
 *   ① 清单必须覆盖**实现里实际 provide 的名字**（读源码，而不是再抄一遍常量）；
 *   ② 每条保留名都真的拦得住（可证伪：逐条断言 provide 抛错）。
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** 递归读一个目录下所有 .ts 文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('保留服务名：清单是单一来源，且每个具体名字都能被"声明层"认出来', async () => {
  assert.ok(RESERVED_SERVICE_NAMES.includes('config'));
  assert.ok(RESERVED_SERVICE_NAMES.includes('log'));
  assert.ok(RESERVED_SERVICE_NAMES.includes('httpServer'));
  assert.ok(RESERVED_SERVICE_NAMES.includes('wsConnections'));
  const concrete = RESERVED_SERVICE_NAMES.filter((name) => !name.endsWith('/'));
  assert.ok(concrete.length >= 4, `至少要有 4 个具体保留名（实测 ${String(concrete.length)} 个）`);
  for (const reserved of concrete) {
    assert.strictEqual(isReservedServiceName(reserved), true, `${reserved} 必须被判为保留名`);
    // 声明层（provider 名）必须能拦住它 —— 运行时 provide() 分不清调用者，所以不靠它拦
    const app = createApp(
      defineApp({ modules: [defineModule({ name: 'main', providers: { [reserved]: () => 1 } })] }),
      { configDir: null, env: {} },
    );
    await assert.rejects(() => app.start(), /框架保留服务名/, `provider '${reserved}' 必须被拒`);
  }
});

test('保留服务名：运行时 provide() 不按名字拦（框架插件自己也要注册 httpServer）', () => {
  const app = createApp(defineApp({ modules: [defineModule({ name: 'main' })] }), { configDir: null, env: {} });
  app.provide('httpServer', { fake: true });
  assert.deepStrictEqual(app.get('httpServer'), { fake: true });
  app.provide('@actor/web:contextHooks', []);
  assert.deepStrictEqual(app.get('@actor/web:contextHooks'), []);
  // 重复注册仍然报错（这条是既有的响亮失败，没被放宽）
  assert.throws(() => app.provide('httpServer', 2), /被重复注册/);
});

test('保留服务名：非保留名照常注册（校验不能误伤）', () => {
  const app = createApp(defineApp({ modules: [defineModule({ name: 'main' })] }), { configDir: null, env: {} });
  app.provide('notes', { ok: true });
  assert.deepStrictEqual(app.get('notes'), { ok: true });
  assert.strictEqual(isReservedServiceName('notes'), false);
  assert.strictEqual(isReservedServiceName('@actornot'), false, '命名空间匹配要精确到 "/"');
});

test('保留服务名：实现里实际 provide 的名字都在清单里（清单与实现分叉就红）', () => {
  const actual = new Set<string>();
  // 只看**发布出去的源码**（packages/*/src）：测试与示例里的名字是"用户起的名"，不构成保留名
  const packagesDir = path.join(REPO_ROOT, 'packages');
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of sourceFiles(path.join(packagesDir, entry.name, 'src'))) {
      if (file.endsWith(`${path.sep}assembly.ts`)) continue; // 装配层是校验方，不是被校验的调用方
      const source = fs.readFileSync(file, 'utf8');
      // 只看**字面量** provide（`app.provide('x', …)`）：变量名（如 db 插件的 name/repositoryName）是用户起的
      for (const match of source.matchAll(/\.provide\??\(\s*(['"])([^'"]+)\1/g)) actual.add(match[2] as string);
      // 服务名常量（`app.provide(SOME_SERVICE, …)`）也要能对上：名字来自导出的常量
      for (const match of source.matchAll(/export const ([A-Z_]*SERVICE[A-Z_]*) = (['"])([^'"]+)\2/g)) {
        actual.add(match[3] as string);
      }
    }
  }
  assert.ok(actual.size >= 3, `至少要扫到几个实际服务名（扫到 ${String(actual.size)} 个）`);
  for (const name of actual) {
    assert.strictEqual(isReservedServiceName(name), true, `实现里 provide 的 '${name}' 不在保留清单里 → 清单分叉了`);
  }
  // 反向：清单里除"命名空间规则"外，每条都要有实现出处（否则就是过期的名字）
  for (const reserved of RESERVED_SERVICE_NAMES) {
    if (reserved === 'config' || reserved === 'log' || reserved.endsWith('/')) continue;
    assert.ok(actual.has(reserved), `保留清单里的 '${reserved}' 在实现里已经没有了 → 该删掉`);
  }
});

test('保留服务名：插件声明图里有保留名 → 启动期报错（含内核能力插件的名字）', async () => {
  // 用户插件叫了框架保留的服务名（不是"框架命名空间"那种框架自用名）
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'main' })],
      plugins: [definePlugin({ name: 'httpServer', provides: ['whatever'] })],
    }),
    { configDir: null, env: {} },
  );
  await assert.rejects(() => app.start(), /框架保留服务名/);
  // 框架命名空间（`@actor/…`）是框架自己注册内部服务的地方：插件名用它不报错（那是内部约定）
  const framework = createApp(
    defineApp({
      modules: [defineModule({ name: 'main' })],
      plugins: [definePlugin({ name: '@actor/web:contextHooks', provides: ['hooks'] })],
    }),
    { configDir: null, env: {} },
  );
  await framework.start();
  await framework.stop();

  const app2 = createApp(
    defineApp({
      modules: [defineModule({ name: 'main' })],
      // 外面看是普通名字，内层内核插件却叫 @actor/http → 有界遍历要能发现
      plugins: [definePlugin({ name: 'my-plugin', kernelPlugins: [{ name: '@actor/http' }] })],
    }),
    { configDir: null, env: {} },
  );
  await assert.rejects(() => app2.start(), /框架保留服务名/);
});

test('保留服务名：正常插件与框架自带插件都不受影响（无假阳性）', async () => {
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          plugins: [definePlugin({ name: 'audit', provides: ['auditor'] })],
        }),
      ],
      plugins: [definePlugin({ name: 'cluster-lite', kernelPlugins: [{ name: 'cluster' }] })],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  await app.stop();
  // 框架自带的插件（framework: true）即使名字命中保留规则也不拦（那是它自己实现的一部分）
  const framework = reservedServiceNamesIn({ name: 'cluster', framework: true, kernelPlugins: [{ name: '@actor/cluster' }] });
  assert.deepStrictEqual(framework, ['@actor/cluster'], '遍历只看名字，屏蔽与否由调用方按 framework 标记决定');
});
