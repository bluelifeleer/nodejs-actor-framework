import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { newApp } from '../src/commands/new.ts';
import { appTemplates } from '../src/templates/app.ts';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');

/**
 * 脚手架的验收是 **M5 里写死的那条**："新人按文档在 30 分钟内跑通 CRUD + Actor + 持久化 + 测试"。
 * 所以这里不只断言"文件生成了"，而是**把生成的项目真跑起来**：跑它自带的测试（真 HTTP + 真重启）。
 *
 * 生成目录放在仓库内：`@actor/*` 通过 workspace 链接解析得到，不需要联网装依赖。
 */

function tempDir(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('scaffold: 模板清单齐全，package.json / README 里的项目名被替换', async () => {
  // 默认布局 = layered（按业务分层）
  const files = await appTemplates('demo-app');
  const names = files.map((file) => file.relative).sort();
  assert.deepStrictEqual(names, [
    '.dockerignore',
    '.gitignore',
    'Dockerfile',
    'Dockerfile.direct',
    'README.md',
    'config/default.ts',
    'main.ts',
    'package.json',
    'scripts/copy-assets.mjs',
    'scripts/smoke.mjs',
    'server.ts',
    'src/actor/counter.actor.ts',
    'src/controller/counter.controller.ts',
    'src/controller/health.controller.ts',
    'src/controller/notes.controller.ts',
    'src/model/note.ts',
    'src/module.ts',
    'src/plugin/index.ts',
    'src/schema/note.schema.ts',
    'src/service/notes.repository.ts',
    'test/api.test.ts',
    'tsconfig.build-test.json',
    'tsconfig.build.json',
    'tsconfig.json',
  ]);

  // flat 布局保留旧的扁平形状（老项目与最小示例用），两个模板根都必须在包里
  const flat = await appTemplates('demo-app', 'flat');
  assert.deepStrictEqual(
    flat.map((file) => file.relative).sort(),
    [
      '.dockerignore', '.gitignore', 'Dockerfile', 'Dockerfile.direct', 'README.md',
      'config/default.ts', 'main.ts', 'package.json', 'scripts/copy-assets.mjs', 'scripts/smoke.mjs',
      'src/app.ts', 'src/counter.ts', 'src/module.ts', 'src/notes.ts', 'test/app.test.ts',
      'tsconfig.build-test.json', 'tsconfig.build.json', 'tsconfig.json',
    ],
    'flat 布局同样带构建路线（两条部署路线的能力要对齐）',
  );

  const pkg = JSON.parse(files.find((file) => file.relative === 'package.json')!.content);
  assert.strictEqual(pkg.name, 'demo-app');
  assert.ok(pkg.scripts.start && pkg.scripts.test, '生成的项目要有 start / test');
  for (const dep of ['@actor/app', '@actor/data', '@actor/web']) {
    assert.ok(pkg.dependencies[dep], `依赖里要有 ${dep}`);
  }
  assert.ok(
    !JSON.stringify(pkg).includes('nodejs-actor-framework'),
    '用户项目不该直接依赖内核（用户项目依赖 @actor/*）',
  );
  assert.ok(files.find((file) => file.relative === 'README.md')!.content.includes('demo-app'));
});

test('scaffold: 非空目录默认拒绝（--force 才写入）', async () => {
  const dir = tempDir('nonempty');
  try {
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
    await assert.rejects(
      () => newApp(dir),
      (err: unknown) => {
        assert.match(String((err as Error).message), /目标目录非空/);
        assert.strictEqual(fs.existsSync(path.join(dir, 'main.ts')), false, '被拒时不该写任何文件');
        return true;
      },
    );
    const forced = await newApp(dir, { force: true });
    assert.ok(forced.files.includes('main.ts'));
    assert.ok(fs.existsSync(path.join(dir, 'existing.txt')), '--force 也不删用户已有的文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold: 缺少目标目录 / 未知布局 都报用法错误', async () => {
  await assert.rejects(() => newApp(''), /缺少目标目录/);
  await assert.rejects(
    () => newApp(path.join(ROOT, '.tmp-cli', 'bad-layout'), { layout: 'nope' as never }),
    /未知的布局 'nope'/,
  );
});

test('scaffold: --web-plugins 生成片段 + 桶文件，且生成的项目里那些能力的测试真的跑起来', async () => {
  const dir = tempDir('web-plugins');
  try {
    const result = await newApp(dir, { webPlugins: ['debug', 'upload'] });
    assert.deepStrictEqual(result.webPlugins, ['debug', 'upload']);
    for (const file of ['src/plugin/debug.ts', 'src/plugin/upload.ts', 'test/debug.test.ts', 'test/upload.test.ts']) {
      assert.ok(result.files.includes(file), `缺少 ${file}：${result.files.join(', ')}`);
    }
    const barrel = fs.readFileSync(path.join(dir, 'src/plugin', 'index.ts'), 'utf8');
    assert.match(barrel, /import debug from '\.\/debug\.ts'/, '桶文件要 import 选中的片段');
    assert.match(barrel, /import upload from '\.\/upload\.ts'/);
    assert.ok(!barrel.includes("import auth from"), '没选的能力不该出现在桶文件里');

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await run('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    // api 4 条 + upload 1 条 + debug 1 条 = 6 条（每个能力片段自带一条冒烟）
    assert.match(stdout, /pass 6/, `生成项目的测试应当 6 条全过：\n${stdout}`);
    assert.ok(!/fail [1-9]/.test(stdout), `生成项目的测试不该有失败：\n${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold: --with 追加能力（闭包写进 package.json，片段自带冒烟测试）', async () => {
  const dir = tempDir('with-redis');
  try {
    const result = await newApp(dir, { capabilities: ['redis'] });
    assert.deepStrictEqual(result.capabilities, ['redis']);
    assert.ok(result.files.includes('src/plugin/redis.ts'), `缺 redis 片段：${result.files.join(', ')}`);
    // 闭包：redis 片段会 import @actor/resource，所以生成的项目必须**声明**它（不能指望传递依赖被提升）
    assert.ok(result.packages.includes('@actor/redis'));
    assert.ok(result.packages.includes('@actor/resource'), `闭包应当带 resource：${result.packages.join(', ')}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.ok(pkg.dependencies['@actor/redis'] && pkg.dependencies['@actor/resource'], JSON.stringify(pkg.dependencies));

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.APP_REDIS_URL;
    const { stdout } = await run('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    assert.match(stdout, /pass 5/, `api 4 + redis 1 = 5 条应当全过：\n${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold: --with mail（fileTransport 离线可跑）；还没实现片段的能力明确拒绝', async () => {
  const dir = tempDir('with-mail');
  try {
    const result = await newApp(dir, { capabilities: ['mail'] });
    assert.ok(result.files.includes('src/plugin/mail.ts'));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await run('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    assert.match(stdout, /pass 5/, `api 4 + mail 1 = 5 条应当全过：\n${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // db/mongodb 的片段还没实现 → **明确报错**（不生成一半、也不静默少给）
  await assert.rejects(() => newApp(tempDir('with-db'), { capabilities: ['db'] }), /片段还没实现：db/);
  await assert.rejects(() => newApp(tempDir('with-bad'), { capabilities: ['nope' as never] }), /未知能力 'nope'/);
});

test('scaffold: 没选能力时桶文件为空；flat 布局下 --web-plugins 明确拒绝（不静默忽略）', async () => {
  const plain = await newApp(tempDir('web-plugins-none'));
  assert.deepStrictEqual(plain.webPlugins, []);
  assert.ok(
    !plain.files.some((file) => file.startsWith('test/debug') || file.startsWith('test/upload')),
    '没选能力就不该有片段文件',
  );
  assert.match(
    fs.readFileSync(path.join(plain.dir, 'src/plugin', 'index.ts'), 'utf8'),
    /const fragments: Array<PluginSpec \| PluginSpec\[\]> = \[\];/,
    '没选能力时桶文件应当是空数组',
  );
  await assert.rejects(
    () => newApp(tempDir('wp-flat'), { layout: 'flat', webPlugins: ['debug'] }),
    /flat 布局不支持 --web-plugins/,
  );
  await assert.rejects(() => newApp(tempDir('wp-unknown'), { webPlugins: ['nope' as never] }), /未知的 web 插件 'nope'/);
});

test('scaffold: **两种布局生成的项目都能跑** —— 跑它自带的测试（CRUD + Actor + 持久化 + 错误语义）', async () => {
  for (const layout of ['layered', 'flat'] as const) {
  const dir = tempDir(`runnable-${layout}`);
  try {
    const result = await newApp(dir, { layout });
    assert.strictEqual(result.layout, layout);
    assert.ok(
      result.files.includes(layout === 'layered' ? 'server.ts' : 'src/app.ts'),
      `${layout} 布局的文件清单不对：${result.files.join(', ')}`,
    );

    // 生成项目自带 4 条用例，其中一条真的重启应用验证持久化。
    // 注意：必须清掉 NODE_TEST_CONTEXT —— 否则孙进程（生成项目里的 node --test）会以为自己在
    // 父测试运行器里，输出被接管，我们只能看到 npm 的 banner（真踩过）。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await run('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    assert.match(stdout, /pass 4/, `${layout} 生成项目的测试应当 4 条全过：\n${stdout}`);
    assert.ok(!/fail [1-9]/.test(stdout), `${layout} 生成项目的测试不该有失败：\n${stdout}`);

    // 组合矩阵骨架：layered 模板自带 tsconfig，所以要求"生成的项目 typecheck 通过"
    // （flat 是保留的旧最小形状，没有 tsconfig —— 这一点在指南里写明）
    if (layout === 'layered') {
      await run('npx', ['tsc', '-p', dir, '--noEmit'], { cwd: ROOT, timeout: 180_000 });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  }
});
