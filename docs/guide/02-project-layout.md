# 2. 项目结构：代码该写哪

一句话分工：**`main.ts` 只管进程，`server.ts` 只管装配，业务在 `src/` 里分层。**

```
my-app/
├── main.ts                  进程入口：信号注册、优雅停、退出码、启动日志（最薄的一层）
├── server.ts                应用装配：createApp + 插件/模块接线，导出 http 实例（测试直接 import 它）
├── config/
│   ├── default.ts           配置定义（schema + 默认值）
│   └── production.ts        有就覆盖（APP_ENV=production 时生效）
├── src/
│   ├── controller/          HTTP 语义：输入校验 + 状态码 + 错误翻译（无状态）
│   ├── actor/               有状态、串行、可持久化的写路径
│   ├── model/               领域类型与映射（Row ↔ 领域对象）
│   ├── schema/              数据层声明（表/集合名、索引、迁移的落点）
│   ├── service/             仓储/外部依赖的装配与跨模块逻辑
│   ├── plugin/              能力插件的桶文件（脚手架按你选的能力生成）
│   └── module.ts            接线：providers + actors + routes（只接线，不放业务）
├── test/
│   └── api.test.ts          端到端（真 HTTP + 真重启）
├── package.json  tsconfig.json  README.md
└── data/                    运行时产物（快照/事件/上传文件；.gitignore 掉）
```

## 每个文件回答一个问题

| 你脑子里的问题 | 写在哪 |
|---|---|
| "这个接口返回什么状态码？参数怎么校验？" | `src/controller/*.ts` |
| "这个状态谁持有、怎么保证并发安全？" | `src/actor/*.ts` |
| "这个字段叫什么类型、库里长什么样？" | `src/model/*.ts`（领域）+ `src/schema/*.ts`（表/集合声明） |
| "换个数据库要改哪？" | `src/service/*.ts`（装配点）——仓储接口在控制器里只按形状用 |
| "这些声明怎么挂到应用上？" | `src/module.ts`（只接线） |
| "信号、退出码、优雅停？" | `main.ts`（一般不用动） |
| "端口、DSN、密钥？" | `config/default.ts` + 环境变量（见 [14 配置与密钥](./14-config-env.md)） |

**为什么这么分**：这三层各有各的"不能放"——状态不能放控制器（控制器是无状态的，多请求共享），
HTTP 语义不能放 Actor（Actor 不该知道 404 长什么样），装配不能散在业务里（换实现时你要找得到）。

## 分层不是教条：什么时候该合

- **小项目 / 一个接口的验证**：`node packages/cli/src/cli.ts new app x --layout flat` 生成扁平布局
  （`src/app.ts` + `src/{notes,counter,module}.ts`），少几个目录，心智能负担得起。
- **只有读、没有状态**：控制器 + 仓储两层就够，不需要 Actor。
- **业务很厚**：`src/service/` 里再分目录（`service/billing/…`），控制器只做翻译。

## 这条结构是生成出来的（不是手抄的示意）

下面这段会被 CI 执行：真调脚手架生成项目，断言文件清单与分层关键点一致。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-layout-'));

try {
  await run(process.execPath, [cli, 'new', 'app', dir]);

  const expect = (file) => assert.ok(fs.existsSync(path.join(dir, file)), `缺少 ${file}`);
  // 进程入口与装配层必须分开
  for (const file of ['main.ts', 'server.ts', 'config/default.ts', 'src/module.ts', 'test/api.test.ts']) expect(file);
  // 业务分层目录（layered 布局的"契约"）
  for (const dirName of ['controller', 'actor', 'model', 'schema', 'service', 'plugin']) {
    assert.ok(fs.statSync(path.join(dir, 'src', dirName)).isDirectory(), `缺少 src/${dirName}/`);
  }
  // 数据目录不进版本库
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /data/, '.gitignore 要忽略 data/');

  // flat 布局是**另一种形状**：没有 server.ts，装配在 src/app.ts
  const flatDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-layout-flat-'));
  try {
    await run(process.execPath, [cli, 'new', 'app', flatDir, '--layout', 'flat']);
    assert.ok(fs.existsSync(path.join(flatDir, 'src', 'app.ts')), 'flat 的装配在 src/app.ts');
    assert.ok(!fs.existsSync(path.join(flatDir, 'server.ts')), 'flat 不该有 server.ts');
  } finally {
    fs.rmSync(flatDir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 想加东西时，一条最短路径

```ts
// 1) src/controller/report.controller.ts —— 只放 HTTP 语义
import { defineController, reply } from '@actor/web';
export const report = defineController({
  input: { month: 'string' },            // 值即 schema：必填字符串，默认来自请求体
  handle: async (input, ctx) => {
    const orders = ctx.get('orders') as { monthly(month: string): Promise<unknown> };
    return reply.json(await orders.monthly(String(input.month)));
  },
});

// 2) src/service/orders.repository.ts —— 装配点（换实现只改这里）
export const createOrders = (dsn: string) => ({ monthly: async (month: string) => ({ month, total: 0, dsn }) });

// 3) src/module.ts —— 接线（providers + routes）
import { defineModule } from '@actor/app';
import { defineRoutes, post } from '@actor/web';
import { report } from './controller/report.controller.ts';
import { createOrders } from './service/orders.repository.ts';

export default defineModule({
  name: 'app',
  providers: {
    orders: (deps) => {
      const config = deps['config'] as { get<T>(key: string): T };
      return createOrders(config.get<string>('dataDir'));
    },
  },
  routes: defineRoutes([post('/reports/monthly', report)]),
});
```

改完重启即可：路由/输入/依赖在**启动期**统一校验，写错了会直接拒绝启动并说清哪一条。

## 下一步

- 加接口、校验、错误码 → [10 路由与请求](./10-http-routing.md)
- 建表 + 仓储 + CRUD → [11 数据与 CRUD](./11-crud-database.md)
- 状态放哪 → [12 Actor 与状态](./12-actors-state.md)
