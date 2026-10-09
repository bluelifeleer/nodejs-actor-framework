# 21. CLI：生成骨架与自定义命令

`actor` 除了 `new app` / `add` / `migrate` / `doctor`，还有两件日常用得最多的能力：
**生成骨架**（controller/actor/service/model/schema/middleware/test/command）与
**把自己项目的命令挂进 `actor`**。

共同纪律（和脚手架一致）：

- **非破坏性**：已存在的文件**默认拒绝覆盖**（`--force` 才写）；
- **`--dry-run` 一个字节都不写**（先看计划再决定）；
- **不自动改写你的代码**：需要接线的地方（`src/module.ts`）只**打印要粘贴的片段**；
- 生成的东西**自带可跑的测试**（`--no-test` 关掉），并且项目仍然 typecheck 通过。

## 一、生成骨架

```bash
actor generate controller note        # src/controller/note.controller.ts + test/…
actor generate actor      cart        # src/actor/cart.actor.ts（handler bag，状态只在 this.state）
actor generate service    billing     # src/service/billing.service.ts（装配点）
actor generate model      note        # src/model/note.ts（领域类型 + 行映射）
actor generate schema     note --field title:string --field tags:json --optimistic-lock
actor generate middleware audit       # src/middleware/audit.ts（atPre 阶段）
actor generate test       note        # test/note.test.ts（真起应用 + 真请求的骨架）
actor generate migration  create-notes # src/migrations/<时间戳>-create-notes.ts（版本号自动接续）
```

别名 `actor g`；布局**跟着项目走**（layered → `src/<层>/`；`flat` → `src/`）。

| 选项 | 作用 |
|---|---|
| `--field <名字>:<类型>`（可重复） | `model` / `schema` 的字段。类型：`string` `text` `number`/`int` `bool`/`boolean` `json` `timestamp` `uuid`（省略 = `string`） |
| `--optimistic-lock` | `schema` 加一列 `version`（乐观锁；更新时版本不符 → 409） |
| `--migration-version <n>` | `migration` 显式指定版本号（不给就扫 `src/migrations/**` 里已有的 `version:` 自动 +1） |
| `--no-test` | 不生成配套测试 |
| `--dry-run` / `--force` | 只算不写 / 覆盖已存在文件 |
| `--mount` | 把接线插进模块文件的 `// @actor:mount <槽位>` 标记后（无标记则只提示，不改文件） |
| `--dir <项目>` | 指定项目目录（默认当前目录） |

生成后会打印**要粘贴的片段**，例如：

```text
下一步：把下面这段合并进 src/module.ts（本命令不改你的代码）
  // src/module.ts —— 1) 顶部 import
  import { note } from './controller/note.controller.ts';

  // 2) routes 里加一行（路径与输入来源自定）
  get('/note?name=', note),
```

> 为什么默认**不自动插入**：`module.ts` 是你的文件（你很可能已经改过它），
> 正则/AST 改写在这种文件上迟早会改坏别人的代码。打印片段 + 明确下一步，是这套 CLI 一贯的取舍。

### 想让它自动接线：`--mount`

`--mount` 会往模块文件里的**显式标记**后面插入整行 —— 没有标记就**一个字节都不改**，并告诉你加哪一行：

```bash
actor generate controller notes --mount
# 已把这些行插进 src/module.ts：
#   + import { notes } from './controller/notes.controller.ts';
#   + get('/notes?name=', notes),
```

标记长这样（脚手架生成的项目**开箱就带**，两种布局都在 `src/module.ts`）：

```ts
// @actor:mount imports          ← 顶层 import 区（必须顶格）

export default defineModule({
  name: 'app',
  providers: {
    // @actor:mount providers
  },
  actors: {
    // @actor:mount actors
  },
  middleware: [
    // @actor:mount middleware
  ],
  routes: defineRoutes([
    // @actor:mount routes
  ]),
});
```

- **槽位**：`imports` / `providers` / `actors` / `routes` / `middleware`；迁移用 `src/migrations.ts` 里的
  `imports` + `migrations`（该文件不存在时会按模板**新建**）。
- **幂等**：要插的行已经存在就跳过，重复跑不会产生重复 import。
- **原子**：先写临时文件再 `rename`，中途失败不会留下半截文件；不留 `.tmp` 残留。
- **`--dry-run`**：连临时文件都不建，只打印"会插什么"。
- **不需要接线的 kind**（`model` / `schema` / `test` / `command`）会明确说明原因，而不是假装挂上了。
- 生成 `service` 时插入的 provider 是**能跑的单行**（`dsn: ''` + `// TODO: 把 dsn 接到 config 上`）——
  不替用户猜配置键名。
- 标识符会去掉重复后缀：`actor generate actor demo-actor` → 导出 `demoActor`（不是 `demoActorActor`）。

## 二、自定义命令

```bash
actor generate command seed     # 生成 .actor/commands/seed.ts（自带选项声明与最小实现）
actor commands                  # 列出内置 + 项目自定义命令（--json 机器可读）
actor seed --count 3            # 直接当子命令跑（--help 自动可用）
```

命令契约（`defineCommand`）：**声明选项 → 框架解析并生成 `--help` → 你的 `run` 被子进程执行**。

```ts
import { defineCommand } from '@actor/cli/src/commands/custom.ts';

export default defineCommand({
  name: 'seed',
  summary: '灌一批种子数据',
  usage: 'actor seed [--count 20] [--dry-run]',
  flags: {
    count: { type: 'number', default: 20, description: '条数' },
    'dry-run': { type: 'boolean', default: false, description: '只打印计划' },
  },
  async run({ cwd, args, flags, stdout }) {
    stdout(`在 ${cwd} 灌 ${String(flags.count)} 条（dryRun=${String(flags['dry-run'])}）`);
    return 0;   // 退出码：0 成功 / 1 用法错误 / 2 环境问题
  },
});
```

发现位置（三处，**都在项目自己声明过的范围里**）：

| 位置 | 说明 |
|---|---|
| `<项目>/.actor/commands.ts` | 集中声明：`export const commands = [defineCommand(…), …]` 或 `export default defineCommand(…)` |
| `<项目>/.actor/commands/*.ts` | 一个文件一个命令（`export default defineCommand(…)`） |
| `node_modules/actor-command-*` | npm 包：**必须**在项目 `dependencies` 里，或在 `package.json` 的 `"actor": { "commands": ["包名"] }` 里显式列出 |

**为什么不通扫 `node_modules`**：加载一个包就是执行它的代码。只认"这个项目自己声明过的依赖"，
才能把"谁有权在你的 CLI 进程里跑代码"答清楚 —— 未声明的包即使躺在 `node_modules` 里**也不会被加载**（有用例守着）。

发布一个命令包：包内 `package.json` 写 `"actor": { "commandsModule": "./lib/commands.js" }`（或 `exports["./commands"]`），
`lib/commands.js` 里 `export const commands = [defineCommand(…)]` 或 `export default defineCommand(…)`。

**执行是子进程**（刻意）：用户代码里的 `process.exit()` / 未捕获异常 / 死循环不会带崩主 CLI；
你的退出码会**原样透传**（`return 3` → shell 里就是 3），抛错则保留完整堆栈（你在开发，需要定位）。

**不静默的四种情况**：与内置命令重名、两个文件声明同名命令、`run` 不是函数、选项名与声明不符 —— 都会明确报错。

## 三、跑一遍（CI 真执行）

下面这段会真建一个项目，把七种骨架各生成一遍，再断言 **typecheck 通过 + 生成的测试全跑过**。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = `${process.cwd()}/`;
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
const project = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-cli-gen-'));
// 子进程里要删掉 NODE_TEST_CONTEXT：否则 node:test 会判定"递归运行"而跳过
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

try {
  await run(process.execPath, [cli, 'new', 'app', project]);

  for (const kind of ['controller', 'actor', 'service', 'model', 'schema', 'middleware', 'test']) {
    const { stdout } = await run(
      process.execPath,
      [cli, 'generate', kind, `probe-${kind}`, '--field', 'title:string', ...(kind === 'schema' ? ['--optimistic-lock'] : [])],
      { cwd: project, env },
    );
    assert.match(stdout, new RegExp(`已生成 ${kind} 骨架`), `${kind} 应当生成成功：\n${stdout}`);
    assert.match(stdout, /下一步：/, `${kind} 要给出 module.ts 片段`);
  }

  // 生成的骨架真的在（layered 布局）
  for (const file of [
    'src/controller/probe-controller.controller.ts',
    'src/actor/probe-actor.actor.ts',
    'src/service/probe-service.service.ts',
    'src/model/probe-model.ts',
    'src/schema/probe-schema.schema.ts',
    'src/middleware/probe-middleware.ts',
    'test/probe-test.test.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(project, file)), `缺少 ${file}`);
  }

  // 证据 ①：项目仍然 typecheck 通过
  await run('npx', ['--no-install', 'tsc', '-p', '.', '--noEmit'], { cwd: project, env, timeout: 240_000 });

  // 证据 ②：生成的测试真的跑过（脚手架 4 条 + 生成的 8 条 = 12）
  const { stdout, stderr } = await run('npm', ['test'], { cwd: project, env, timeout: 240_000 });
  const output = `${stdout}${stderr}`;
  assert.match(output, /pass 12/, `生成的测试应当全过：\n${output}`);
  assert.ok(!/fail [1-9]/.test(output), `不该有失败：\n${output}`);

  // 迁移：版本号自动接续（第一个 v1，第二个 v2）
  const firstMigration = await run(process.execPath, [cli, 'generate', 'migration', 'create-notes'], { cwd: project, env });
  assert.match(firstMigration.stdout, /已生成 migration 骨架/);
  const migrationDir = path.join(project, 'src', 'migrations');
  const firstFile = fs.readdirSync(migrationDir)[0];
  assert.match(fs.readFileSync(path.join(migrationDir, firstFile), 'utf8'), /version: 1/);
  const secondMigration = await run(process.execPath, [cli, 'generate', 'migration', 'add-tags'], { cwd: project, env });
  assert.match(secondMigration.stdout, /import v2 from/, `第二个迁移应当是 v2：\n${secondMigration.stdout}`);

  // 非破坏性：改过的文件不会被覆盖
  const target = path.join(project, 'src', 'controller', 'probe-controller.controller.ts');
  fs.writeFileSync(target, '// 我改过的\n', 'utf8');
  const again = await run(process.execPath, [cli, 'generate', 'controller', 'probe-controller'], { cwd: project, env });
  assert.match(again.stdout, /已存在，跳过/);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '// 我改过的\n');
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
console.log('ok');
```

## 四、自定义命令跑一遍（CI 真执行）

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
const project = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-cli-cmd-'));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const expectFail = async (args, pattern) => {
  const failed = await run(process.execPath, [cli, ...args], { cwd: project, env }).catch((error) => error);
  assert.match(String(failed.stderr ?? ''), pattern, `期望报错 ${String(pattern)}：${String(failed.stderr ?? '')}`);
  return failed;
};

try {
  await run(process.execPath, [cli, 'new', 'app', project]);
  // ① 生成骨架 → 就会被发现（`.actor/commands/` 是约定位置）
  await run(process.execPath, [cli, 'generate', 'command', 'seed'], { cwd: project, env });

  const listed = await run(process.execPath, [cli, 'commands'], { cwd: project, env });
  assert.match(listed.stdout, /内置命令：/);
  assert.match(listed.stdout, /seed/);
  assert.match(listed.stdout, /\.actor\/commands\/seed\.ts/, '要显示命令来源');

  const asJson = JSON.parse((await run(process.execPath, [cli, 'commands', '--json'], { cwd: project, env })).stdout);
  assert.deepStrictEqual(asJson.custom.map((item) => item.name), ['seed']);
  assert.ok(asJson.custom[0].flags.includes('count'));

  // ② 执行：选项由**子进程**按它自己的声明解析（主 CLI 不认识 --count 也不该拦）
  const executed = await run(process.execPath, [cli, 'seed', '--count', '3'], { cwd: project, env });
  assert.match(executed.stdout, /count=3/);
  assert.match((await run(process.execPath, [cli, 'seed'], { cwd: project, env })).stdout, /count=10/, '默认值生效');

  // ③ --help 由 flags 声明自动生成
  const help = await run(process.execPath, [cli, 'seed', '--help'], { cwd: project, env });
  assert.match(help.stdout, /actor seed/);
  assert.match(help.stdout, /--count <number>/);

  // ④ 未知选项在**子进程**报错（指向具体命令），退出码 1
  const bad = await expectFail(['seed', '--nope'], /未知选项 '--nope'（命令 'seed'）/);
  assert.strictEqual(bad.code, 1);

  // ⑤ 子进程隔离：自定义命令抛错/自定义退出码都不影响主 CLI
  fs.writeFileSync(
    path.join(project, '.actor', 'commands', 'boom.ts'),
    [
      "import { defineCommand } from '@actor/cli/src/commands/custom.ts';",
      'export default defineCommand({',
      "  name: 'boom',",
      "  run() { throw new Error('自定义命令炸了'); },",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  const boom = await expectFail(['boom'], /自定义命令炸了/);
  assert.strictEqual(boom.code, 1);
  assert.match(String(boom.stderr ?? ''), /at /, '用户代码的堆栈要保留');
  assert.match((await run(process.execPath, [cli, 'commands'], { cwd: project, env })).stdout, /boom/, '主 CLI 照常可用');

  // ⑥ 未定义的命令仍然报"未知命令"，并提示去看 actor commands
  await expectFail(['nope'], /未知命令 'nope'[\s\S]*actor commands/);

  // ⑦ npm 包来源：只认项目声明过的包（未声明的包即使躺在 node_modules 里也不加载）
  const pkg = path.join(project, 'node_modules', 'actor-command-seed');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'actor-command-seed', version: '1.0.0', type: 'module', actor: { commandsModule: './lib/commands.js' } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(pkg, 'lib', 'commands.js'),
    "export default { name: 'frompkg', summary: '包里的命令', run() { return 0; } };\n",
    'utf8',
  );
  const undeclared = path.join(project, 'node_modules', 'actor-command-evil');
  fs.mkdirSync(undeclared, { recursive: true });
  fs.writeFileSync(path.join(undeclared, 'package.json'), JSON.stringify({ name: 'actor-command-evil', version: '1.0.0', type: 'module', main: 'index.js' }), 'utf8');
  fs.writeFileSync(path.join(undeclared, 'index.js'), "export default { name: 'evil', run() { return 0; } };\n", 'utf8');

  const manifestPath = path.join(project, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = { ...manifest.dependencies, 'actor-command-seed': '1.0.0' };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const withPackages = JSON.parse((await run(process.execPath, [cli, 'commands', '--json'], { cwd: project, env })).stdout);
  const packageNames = withPackages.custom.map((item) => item.name);
  assert.ok(packageNames.includes('frompkg'), `声明过的包要被发现：${JSON.stringify(packageNames)}`);
  assert.ok(!packageNames.includes('evil'), '未声明的包绝不能加载');
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
console.log('ok');
```

## 五、相关

- 脚手架本身（`new app` / `--layout` / `--with` / `--web-plugins`）→ [internals/00-scaffold](./internals/00-scaffold.md)
- 生成的骨架怎么接进模块 → [02 项目结构](./02-project-layout.md)
- `doctor` 会体检"自定义命令"这一节（重名/形状不对会如实报出）→ [19 排错手册](./19-troubleshooting.md)
