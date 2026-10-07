# 0. 从零生成一个能跑的项目

```bash
node packages/cli/src/cli.ts new app my-app     # 仓库内；发布后就是 `actor new app my-app`
cd my-app && npm install && npm start && npm test
```

默认生成 **layered 布局**的 16 个文件（按业务分层，见下一节），**开箱即跑**：`npm start` 起 HTTP，`npm test` 跑 4 条端到端用例
（CRUD 201/200/409/204、Actor、**重启后持久化**、400/404/405）。骨架里没有 TODO、没有注释掉的代码，
每一处都是当前真实可用的写法。

## 脚手架真的会生成这些文件（这条示例会被测试执行）

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
// 生成到仓库内（这样 @actor/* 通过 workspace 链接解析得到，不需要联网装依赖）
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-scaffold-'));

try {
  const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
  const { stdout } = await run(process.execPath, [cli, 'new', 'app', dir]);
  assert.match(stdout, /已生成 17 个文件/);   // 默认 layered

  // layered：进程入口与装配分开，业务按层分目录
  for (const file of [
    'package.json', 'tsconfig.json', 'main.ts', 'server.ts', 'config/default.ts',
    'src/module.ts', 'src/controller/notes.controller.ts', 'src/controller/counter.controller.ts',
    'src/controller/health.controller.ts', 'src/actor/counter.actor.ts', 'src/model/note.ts',
    'src/schema/note.schema.ts', 'src/service/notes.repository.ts', 'src/plugin/index.ts',
    'test/api.test.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `缺少 ${file}`);
  }

  // flat：保留旧的扁平形状（最小示例/老项目用）——文件数不同、装配文件是 src/app.ts
  const flatDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-scaffold-flat-'));
  try {
    const { stdout: flatOut } = await run(process.execPath, [cli, 'new', 'app', flatDir, '--layout', 'flat']);
    assert.match(flatOut, /已生成 10 个文件/);
    assert.ok(fs.existsSync(path.join(flatDir, 'src', 'app.ts')), 'flat 布局应当有 src/app.ts');
    assert.ok(!fs.existsSync(path.join(flatDir, 'server.ts')), 'flat 布局不该有 server.ts');
  } finally {
    fs.rmSync(flatDir, { recursive: true, force: true });
  }

  // 非空目录必须拒绝（脚手架不覆盖已有项目）
  await assert.rejects(() => run(process.execPath, [cli, 'new', 'app', dir]), /目标目录非空/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 生成了什么（layered 布局，默认）

```
my-app/
├── main.ts                 进程入口：信号注册、优雅停、启动日志（最薄的一层）
├── server.ts               应用装配：createApp + 插件/模块接线，导出 http 实例（测试直接 import 它）
├── config/default.ts       配置定义（schema + 默认值）
├── tsconfig.json           生成的项目自带类型检查配置（`npx tsc -p . --noEmit`）
├── src/
│   ├── controller/         HTTP 语义：notes / counter / health
│   ├── actor/              Actor 定义（有状态、串行、可持久化）
│   ├── model/              领域类型与映射
│   ├── schema/             数据层声明（集合名、排序键；换 SQL 时这里是 defineModel/迁移的落点）
│   ├── service/            仓储/外部依赖的装配（换存储只改这一个文件）
│   ├── plugin/index.ts     能力插件桶（脚手架按你选的能力生成；server.ts 只 import 它）
│   └── module.ts           接线：providers + actors + routes
└── test/api.test.ts        端到端（真 HTTP + 真重启）
```

**谁放哪是写死的**：`main.ts` 只做进程级的事，`server.ts` 只做装配，业务在 `src/` 各层里。
这样项目长大后不会出现"所有东西都在一个文件里"。

### 选 web 插件：`--web-plugins upload,auth,debug`

```bash
actor new app my-app --web-plugins upload,auth     # 文件上传 + 鉴权
```

每个插件是一个**片段**（自带接线 + 一条冒烟测试），生成器把它们拷进项目并重写
`src/plugin/index.ts`（桶文件）—— **`server.ts` 不会被文本改写**（那种做法很脆）。
三个插件的默认行为都是"没配置就不干活"，所以离线/没服务时项目照常能跑：

| 插件 | 默认行为 |
|---|---|
| `upload` | 挂 `/uploads`（流式单/多文件 + 分片续传），数据落 `./data/uploads` |
| `auth` | **没配 `APP_JWT_SECRET` 就不挂**（很多项目本来没有登录体系）；配了才校验 Bearer |
| `debug` | **默认关闭**；`APP_DEBUG=1` + `APP_DEBUG_TOKEN`（≥16 字符）才开 `/__debug/*` |

flat 布局不支持 `--web-plugins`（桶文件是 layered 的机制），会**明确报错**而不是静默忽略。

### 追加能力：`--with redis,mail`

```bash
actor new app my-app --with redis,mail     # 基础模板（web + data）+ 追加 Redis 与邮件
```

- 依赖**按闭包**写进生成项目的 `package.json`（含传递包，例如 redis 片段会用 `@actor/resource`）——
  不指望"传递依赖恰好被提升到顶层"；
- 每个能力是一个片段，自带**一条冒烟测试**；服务类能力**按 env 门控**：
  | 能力 | 默认行为 |
  |---|---|
  | `redis` | 没配 `APP_REDIS_URL` 就不挂（框架对资源是"连不上就启动失败"，本地没 Redis 不该拖垮应用）；配了之后连不上**会**让启动失败（刻意的，不静默降级） |
  | `mail` | `fileTransport` 写 `.eml`（零依赖、离线可跑）；换 SMTP 只改一行 + `npm i nodemailer` |
- 还没实现片段的能力（当前是 `db` / `mongodb`）**明确报错**，不会生成一半；
- `--with` 是**追加**：基础模板自带 web + data（模板代码依赖它们）。

### 另一种布局：`--layout flat`

```bash
actor new app my-app --layout flat     # 10 个文件的最小扁平形状（老项目/最小示例用）
```

flat 是**保留的旧形状**（`src/app.ts` + `src/{notes,counter,module}.ts`），没有 `tsconfig.json`；
新项目建议用默认的 layered。

## 迁移与体检

`actor doctor` 除了"文件在不在、配置能不能加载、迁移有没有应用、端口有没有被占"，
还检查两类**一致性**（都只提示、不擅自改你的代码）：

- **能力一致性**：`package.json` 声明了 `@actor/redis`，但 `src/plugin/redis.ts` 不存在（等于装了不用）→
  提示 `actor add --with redis`，或把用不到的包去掉；
- **布局一致性**：layered 项目里出现 `src/notes.controller.ts` 这类"放错层"的文件 →
  提示应该放到 `src/controller/`（doctor 不会替你移动文件）。


项目里加 `src/migrations.ts`（约定位置）之后：

```bash
actor migrate status              # 看已应用/待应用/中断/“数据比代码新”；有待处理时退出码 2
actor migrate up                  # 应用（幂等：中断过的会被重跑，所以 up() 要幂等）
actor migrate down --to 1         # 回滚到 v1；**必须显式给 --to**，CLI 绝不猜回滚到哪
actor doctor                      # 体检：Node/依赖/配置/数据目录/迁移/端口，每项失败都给出下一步
```

`migrate status` **有待处理就返回退出码 2**：这样 CI 和启动脚本能直接用它当门禁
（"结构不确定就不许开始服务"是数据层的默认姿态）。`--json` 给脚本用。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-doctor-'));

try {
  await run(process.execPath, [cli, 'new', 'app', dir]);

  // 刚生成的骨架应当是"体检全绿"（没有迁移文件 → 迁移这项也算通过）
  const { stdout } = await run(process.execPath, [cli, 'doctor', '--dir', dir, '--port', '0', '--json']);
  const report = JSON.parse(stdout);
  assert.strictEqual(report.problems, 0, `骨架应当体检全绿：${stdout}`);
  const names = report.checks.map((check) => check.name);
  for (const expected of ['Node 版本', '依赖声明', '配置', '数据目录', '迁移']) {
    assert.ok(names.includes(expected), `缺少检查项 ${expected}`);
  }

  // 给它加一个迁移 → status 会指出"待应用"并给出非零退出码（CI 当门禁用）
  fs.writeFileSync(
    path.join(dir, 'src', 'migrations.ts'),
    'export default [{ version: 1, description: "建表", async up() {}, async down() {} }];\n',
  );
  const status = await run(process.execPath, [cli, 'migrate', 'status', '--dir', dir, '--json']).catch((err) => err);
  assert.strictEqual(status.code, 2, '有未应用迁移时退出码必须是 2');
  assert.deepStrictEqual(JSON.parse(status.stdout).status.pending, [1]);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## CLI 约定

| 行为 | 为什么 |
|---|---|
| 目标目录**非空就拒绝**（要 `--force`） | 脚手架最糟的事故是"手一抖把已有项目覆盖了"；`--force` 也不会删你已有的文件 |
| **不自动装依赖** | 装依赖要联网、可能编译原生模块，脚手架不该替用户决定；生成后打印下一步 |
| 退出码有意义（0 成功 / 1 用法错误 / 2 环境问题），默认**不打印堆栈** | 堆栈对使用者没有信息量；要排查加 `--debug` |

```bash
node packages/cli/src/cli.ts --help
node packages/cli/src/cli.ts --version
```

## 两个容易踩的坑（骨架已经替你处理了）

1. **快照持久化的契约是 `this.state`**：状态放在别的字段（`this.count`）看起来能跑，
   但**重启后会归零**。生成项目里那条"重启后状态还在"的测试就是专门盯这个的——所以别删它。
2. **class 形态的 Actor 不能开 `snapshot`/`events` 持久化**：框架在启动期就会明确拒绝
   （类实例的状态无法被正确恢复）。要用持久化就用 handler bag 或 `@actor/data` 的 `defineAggregate`。

下一步：[第一个 Actor](./01-first-actor.md) / [HTTP 应用](./03-http-app.md) / [数据层](./04-data-layer.md)。
