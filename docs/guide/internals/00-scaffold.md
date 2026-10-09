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
  assert.match(stdout, /已生成 23 个文件/);   // 默认 layered（含构建路线：Dockerfile ×2、scripts/、tsconfig.build.json）

  // layered：进程入口与装配分开，业务按层分目录
  for (const file of [
    'package.json', 'tsconfig.json', 'main.ts', 'server.ts', 'config/default.ts',
    'src/module.ts', 'src/controller/notes.controller.ts', 'src/controller/counter.controller.ts',
    'src/controller/health.controller.ts', 'src/actor/counter.actor.ts', 'src/model/note.ts',
    'src/schema/note.schema.ts', 'src/service/notes.repository.ts', 'src/plugin/index.ts',
    'test/api.test.ts',
    // 部署双轨：官方构建路径（见 22 部署与构建）
    'tsconfig.build.json', 'scripts/copy-assets.mjs', 'scripts/smoke.mjs',
    'Dockerfile', 'Dockerfile.direct', '.dockerignore',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `缺少 ${file}`);
  }

  // flat：保留旧的扁平形状（最小示例/老项目用）——文件数不同、装配文件是 src/app.ts
  const flatDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-scaffold-flat-'));
  try {
    const { stdout: flatOut } = await run(process.execPath, [cli, 'new', 'app', flatDir, '--layout', 'flat']);
    assert.match(flatOut, /已生成 16 个文件/);
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

### 用短名写（应用层语法糖）

同一条定义有**两个名字**：`defineXxx` 是规范名，小写短名是**同一个对象的别名**（不是包装函数）。
两种写法完全等价、可以混用，选你觉得好读的那种：

```ts
// server.ts —— 两种写法混用也没问题
import { app, config, module } from '@actor/app';            // defineApp/defineConfig/defineModule
import { controller, get, httpPlugin } from '@actor/web';     // defineController

export default app({
  config: config({ port: { type: 'number', default: 3000 } }),
  modules: [
    module({
      name: 'notes',
      routes: [controller({ name: 'notes', routes: [get('/notes', () => [])] })],
    }),
  ],
  plugins: [httpPlugin({ port: 0 })],
});
```

**为什么可以放心用短名**：`test/unit-sugar-aliases.test.js` 逐包逐名断言 `short === canonical`
（用 `===` 钉死，不只是"行为像"）——谁要是把它改成包装函数，门禁立刻红。所以这里**不再抄一遍等价性代码**：
一份可执行的恒等断言比文档里再贴一段"两种写法"更不容易腐烂。

短名清单（都来自 `define*`，只是去掉前缀、首字母小写）：

| 包 | 短名 |
|---|---|
| `@actor/app` | `app` `config` `module` `plugin` |
| `@actor/web` | `controller` `router` `middleware` `webPlugin` `uploadStorage` |
| `@actor/db` / `@actor/mongodb` | `model` / `collection` |
| `@actor/data` | `aggregate` `eventSchema` `evolution` |
| `@actor/mail` / `@actor/resource` | `mailTransport` / `managedResource` |

两个**没有**短名的地方（不是遗漏，是名字已被占用）：

- `defineRoutes` 没有短名 —— `routes` 在 `@actor/web` 里已经是**另一个东西**（路由表的标记，配 `RoutesTableSpec`）；
- `defineResourceAdapter` 没有短名 —— `resourceAdapter` 已经是**插件装载函数**（`resourceAdapter(adapter, { name })`）。

### 进程入口：`runApp()` 收敛样板

每个 `main.ts` 都要写一遍的 `createApp → 接优雅停 → start → 打印地址`，现在一次调用就够：

```ts
// main.ts
import { runApp } from '@actor/app';

import app, { http } from './server.ts';

await runApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
  onStarted: () => {
    const address = http.address();
    console.log(`listening on http://${String(address?.host)}:${String(address?.port)}`);
  },
});
```

`runApp` 把一处**容易写错的顺序**固定下来了：**信号处理器在任何 `await` 之前注册** ——
否则启动窗口内收到 `SIGTERM` 会走 Node 默认行为（直接退出，不做优雅停）。
退出行为可注入（`exit`，默认 `process.exit`），所以这条路径**能被测试**：`packages/web/test/run-app.test.ts`
真的发一个信号、断言"停一次、退 0、重复信号不重复退"。

### 参数简写（T2：省掉样板，但一次都不含糊）

三处简写都遵循同一条纪律：**糖与全量写法产出同一份数据**（有"深比较相等"的门禁盯着），
并且随时可以只在一处写全量形式（混用没问题）。

**① 配置值即 schema** —— 直接写值，类型与默认值从值推断：

```ts
config({
  port: 3000,                       // = { type: 'number', default: 3000 }
  name: 'app',                      // = { type: 'string', default: 'app' }
  tags: ['a'],                      // = { type: 'json',   default: ['a'] }
  token: { type: 'string', secret: true },     // 需要校验/打码/必填就写全量形式
});
```

要 `min`/`regex`/`enum`/`secret`/`nullable` 或"必填（不给默认值）"时写全量形式；
**普通对象永远是分组**（不会被当成"默认值是个对象"）—— 要对象默认值请写 `{ type: 'json', default: { … } }`。

**② 输入声明合一** —— 不用再手写 `body: [...]` 与 `input` 两处（不带 `from` 的输入**默认来自请求体**）：

```ts
controller({
  input: {
    filename: 'string',                                  // 字符串别名：string / int / number / bool / boolean / json
    size: 'int',
    id: { from: 'params', type: 'string' },              // 路径参数
    limit: { from: 'query', type: 'number', default: 20 }, // 查询参数（路由模式里要写 ?limit= 声明"会读取"）
  },
  handle: (input) => input,
});
```

`body` 会被自动补齐（于是"每个输入键都要有来源"的启动期校验照旧生效）。要"部分更新"（只校验给了的字段）
就在字段上写 `required: false`。

**③ 中间件阶段即函数名** —— `atPre` / `atAuth` / `atParse` / `atHandler` / `atPost` / `atError`：

```ts
import { atAuth, atPost } from '@actor/web';

controller({
  middleware: [
    atAuth(async (ctx, next) => { /* 校验 token */ return next(); }),   // = { handler, phase: 'auth' }
    atPost(async (_ctx, next) => { const result = await next(); /* 后置 */ return result; }),
  ],
  handle: () => ({ ok: true }),
});
```

（名字带 `at` 前缀是为了不与既有导出/全局撞：`post` 已经是路由助手、`parse` 撞 `JSON.parse`。）

### 工厂糖（T3）：CRUD 与健康检查

`crudRoutes` 生成 list/get/create/update/delete 五条路由（含分页、404/409、输入校验），
每一项都能**逐项覆盖**；`healthRoutes` 生成一个"只报告进程形状"的 `/health`：

```ts
import { crudRoutes, healthRoutes, get } from '@actor/web';

module({
  name: 'notes',
  router: crudRoutes('/notes', notesRepository, {
    name: 'note',
    fields: ['title', 'body'],          // 可写字段（数组 = 必填字符串；对象 = 值即 schema）
    auth: { required: true },           // 由 authPlugin 解释
    routes: { list: get('/notes', customListController) },  // 想换哪条就换哪条
  }),
});
```

| 方法/模式 | 语义 |
|---|---|
| `GET /notes?limit=&offset=` | 列表（默认 `limit=20`、上限 100，参数透传给仓储） |
| `GET /notes/:id` | 取一条；仓储返回 `null` → 404 |
| `POST /notes` | 创建 → 201；仓储抛 `status: 409` 或 `name` 含 Conflict → 409 |
| `PUT /notes/:id` | 更新（默认**部分更新**，`updateRequired: true` 可改成全量）→ 200；不存在 → 404 |
| `DELETE /notes/:id` | 删除 → 204；返回 `false` → 404 |

仓储只要求**结构化最小形状**（`list/get/create/update/remove`），不依赖 `@actor/db`：

```ts
module({ name: 'notes', providers: { notesRepository: () => ({ list, get, create, update, remove }) } });
```

### 保留名与命名冲突（框架守的那一层）

框架占了几个**全局名字**，撞上会在**启动期明确报错**（不是静默覆盖）：

| 保留物 | 值 | 单一来源 |
|---|---|---|
| ctx 字段 | `method` `path` `requestId` `body` `params` `qs` `headers` `route` 等（`ctx.extend` 撞上会报错） | `RESERVED_CONTEXT_KEYS`（`@actor/web`） |
| 路由前缀 | `/uploads`（uploadPlugin）、`/__debug`（debugPlugin） | `RESERVED_ROUTE_PREFIXES` / `RESERVED_PREFIX_OWNERS`（`@actor/web`） |
| 服务名 | `config` `log` `httpServer` `wsConnections` 与 `@actor/` 命名空间 | `RESERVED_SERVICE_NAMES`（`@actor/app`） |

自定义插件想占自己的前缀就声明 `routePrefix`（`defineWebPlugin({ routePrefix: '/mine' })`）；
服务名用自己项目的名字（控制器里 `ctx.get('mine')` 取）。

**编译器挡不住的那一层已经有人管**：重复标识符（`import { config }` 和 `const config`）由 TypeScript 报错，
框架不重复做；框架只守"保留位"（上面那张表）。真要撞名就 `import { config as appConfig }`。

### 诊断路由的可见性作用域（debug 四层）

`debugPlugin` 打开后会挂 `/__debug/routes|health|config`（默认关闭、需 token、生产拒绝启动）。
**诊断输出里暴露什么**可以按四层收窄：

```ts
debugPlugin({ enabled: true, token, expose: { hidePrefixes: ['/internal'] } })   // 全局：按前缀
module({ name: 'admin', debug: { hidePrefixes: ['/admin/audit'] } })             // 路由前缀（模块级叠加）
module({ name: 'secret', debug: { expose: false } })                             // 模块：整棵子树不进输出
controller({ debug: 'off', handle })                                            // 控制器：这条不进输出
```

> ⚠️ **这不是安全边界**：它只让诊断输出少暴露信息，**不影响路由是否可用、也不改变鉴权**。
> 真正的门是 token + "生产环境拒绝启动"。把隐藏当安全用是常见误解。

### 生成插件骨架：四种 kind

```bash
actor new plugin my-plugin --kind app|web|resource|mail
```

| kind | 内容 | 自证方式 |
|---|---|---|
| `app` | `definePlugin` 骨架（配置节 + setup/onReady/onStopping/teardown + 一个服务） | 骨架自带行为测试（生命周期顺序 / 配置节 / 服务可获取 / 停机幂等） |
| `web` | `defineWebPlugin`（routes + 带阶段中间件 + ctx 扩展槽） | `runWebPluginContract`（已发布） |
| `resource` | `defineResourceAdapter`（connect/healthCheck/keepAlive/close/stats） | `runManagedResourceContract`（已发布） |
| `mail` | `defineMailTransport`（send + verify，发前先 `assertSendable`） | `runMailTransportContract`（已发布） |

每种骨架都带 `package.json` / `src/index.ts` / `test/contract.test.ts` / `README.md`，
生成的测试**当场可跑**（`cd my-plugin && npm test`）；仓库内模式（`--repo`）还会打印四张矩阵的接线清单。

### 这四种骨架真的能跑（这条示例会被测试执行）

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-plugin-kinds-'));

try {
  for (const kind of ['app', 'web', 'resource', 'mail']) {
    const { stdout } = await run(process.execPath, [cli, 'new', 'plugin', `doc-${kind}-plugin`, '--kind', kind, '--dir', dir]);
    assert.match(stdout, new RegExp(`已生成 ${kind} 插件`), `${kind} 骨架应当生成：\n${stdout}`);
    const project = path.join(dir, `doc-${kind}-plugin`);
    assert.ok(fs.existsSync(path.join(project, 'test', 'contract.test.ts')), `${kind} 骨架要自带契约测试`);
    // 关键：**生成的骨架当场能跑自己的契约套件**（不是空壳）
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const test = await run('npm', ['test'], { cwd: project, timeout: 120_000, env });
    assert.ok(!/fail [1-9]/.test(test.stdout), `${kind} 骨架的契约测试不该有失败：\n${test.stdout}`);
    assert.match(test.stdout, /pass [1-9]/, `${kind} 骨架的契约测试应当真的跑起来：\n${test.stdout}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

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

下一步：[第一个 Actor](./01-first-actor.md) / [HTTP 应用](./03-http-app.md) / [数据层](./04-data-layer.md)
/ [应用层语法糖](../09-app-sugar.md)（短名、简写、工厂、保留名 —— 上面这些骨架写法背后的那套约定）。
