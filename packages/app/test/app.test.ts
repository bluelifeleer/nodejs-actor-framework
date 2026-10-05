import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AssemblyError,
  createApp,
  defineApp,
  defineConfig,
  defineModule,
  type LoadedConfig,
} from '../src/index.ts';

function tempConfigDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const schema = defineConfig({ greet: { type: 'string', default: 'hi' } });

test('app: 最小应用可启动、配置生效、函数式 Actor 可 ask、stop 幂等', async () => {
  const app = createApp(
    defineApp({
      config: schema as never,
      modules: [defineModule({ name: 'main', actors: { Echo: async (msg: unknown) => `echo:${msg}` } })],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  assert.strictEqual(app.config.get('greet'), 'hi');
  assert.strictEqual(await app.actor('Echo').ask('hello'), 'echo:hello');
  await app.stop();
  await app.stop(); // 幂等，不应抛错
});

test('app: 类形态 Actor 由框架实例化，并注入依赖上下文', async () => {
  class Greeter {
    deps: Record<string, unknown>;
    constructor(deps: Record<string, unknown>) {
      this.deps = deps;
    }
    receive(msg: { name: string }): string {
      const config = this.deps.config as LoadedConfig;
      return `${config.get('greet')} ${msg.name}`;
    }
  }
  const app = createApp(
    defineApp({ config: schema as never, modules: [defineModule({ name: 'main', actors: { Greeter } })] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  assert.strictEqual(await app.actor('Greeter').ask({ name: 'ada' }), 'hi ada');
  await app.stop();
});

test('app: provider 按名解析（含依赖 config 与其它 provider）', async () => {
  const app = createApp(
    defineApp({
      config: schema as never,
      modules: [
        defineModule({
          name: 'main',
          providers: {
            base: { deps: ['config'], factory: ({ config }) => ({ greet: (config as LoadedConfig).get('greet') }) },
            derived: { deps: ['base'], factory: ({ base }) => `${(base as { greet: string }).greet}!` },
          },
        }),
      ],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  assert.strictEqual(app.get('derived'), 'hi!');
  await app.stop();
});

test('app: 未知依赖与循环依赖在 start() 立即报错（含请求者信息）', async () => {
  const unknownDep = createApp(
    defineApp({ modules: [defineModule({ name: 'm', providers: { a: { deps: ['nope'], factory: () => 1 } } })] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await assert.rejects(
    () => unknownDep.start(),
    (err: unknown) => {
      assert.ok(err instanceof AssemblyError, 'should be AssemblyError');
      assert.match(err.message, /未知依赖 'nope'/);
      assert.match(err.message, /来自 a/);
      return true;
    },
  );

  const circular = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'm',
          providers: { a: { deps: ['b'], factory: () => 1 }, b: { deps: ['a'], factory: () => 2 } },
        }),
      ],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await assert.rejects(
    () => circular.start(),
    (err: unknown) => {
      assert.ok(err instanceof AssemblyError);
      assert.match(err.message, /循环依赖: a -> b -> a/);
      return true;
    },
  );
});

test('app: imports 合并模块；重名声明在 start() 报错', async () => {
  const shared = defineModule({ name: 'shared', providers: { x: () => 1 } });
  const main = defineModule({ name: 'main', imports: [shared], providers: { x: () => 2 } });
  const app = createApp(defineApp({ modules: [main] }), { configDir: tempConfigDir(), env: {} });
  await assert.rejects(
    () => app.start(),
    (err: unknown) => {
      assert.ok(err instanceof AssemblyError);
      assert.match(err.message, /provider 'x' 被重复定义/);
      return true;
    },
  );
});

test('app: 取不存在的 Actor/provider 会明确报错，而不是返回 undefined', async () => {
  const app = createApp(defineApp({ modules: [defineModule({ name: 'main' })] }), {
    configDir: tempConfigDir(),
    env: {},
  });
  await app.start();
  assert.throws(() => app.actor('Nope'), /不存在名为 'Nope' 的 Actor（本地未 spawn，集群发现也没有找到）/);
  assert.throws(() => app.get('nope'), /provider 'nope' 尚未解析/);
  await app.stop();
});


test('app: actor() 位置透明——本地优先，其次交给内核解析（未装集群插件时给出明确错误）', async () => {
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: { Local: async (msg: unknown) => `local:${String(msg)}` } })] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();

  // 本地 Actor 直接命中（不经过内核解析）
  assert.strictEqual(await app.actor('Local').ask('hi'), 'local:hi');

  // 未知名：内核解析不到 → 明确报错（提示集群发现，而不是 undefined 或含糊信息）
  assert.throws(() => app.actor('player_001'), /集群发现也没有找到/);
  await app.stop();
});


test('app: 内核直接 spawn 的 Actor 也能被 actor() 解析（真实走内核解析路径）', async () => {
  const app = createApp(defineApp({ modules: [defineModule({ name: 'm' })] }), {
    configDir: tempConfigDir(),
    env: {},
  });
  await app.start();

  // 绕过应用层声明，直接在内核上 spawn —— 应用层的 handles 里没有它
  const kernel = app.kernel as { spawn: (definition: unknown, options: unknown) => Promise<unknown> };
  await kernel.spawn(async (msg: unknown) => `kernel:${String(msg)}`, { id: 'ViaKernel' });

  // 因此这里必须走"内核按名字解析"这条路（装了 cluster 插件时它还会查 gossip 索引）
  assert.strictEqual(await app.actor('ViaKernel').ask('hi'), 'kernel:hi');
  await app.stop();
});
