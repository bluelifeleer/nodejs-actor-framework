# 0. 从零生成一个能跑的项目

```bash
node packages/cli/src/cli.ts new app my-app     # 仓库内；发布后就是 `actor new app my-app`
cd my-app && npm install && npm start && npm test
```

生成 10 个文件，**开箱即跑**：`npm start` 起 HTTP，`npm test` 跑 4 条端到端用例
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
  assert.match(stdout, /已生成 10 个文件/);

  for (const file of ['package.json', 'main.ts', 'config/default.ts', 'src/app.ts', 'src/module.ts', 'src/notes.ts', 'src/counter.ts', 'test/app.test.ts']) {
    assert.ok(fs.existsSync(path.join(dir, file)), `缺少 ${file}`);
  }

  // 非空目录必须拒绝（脚手架不覆盖已有项目）
  await assert.rejects(() => run(process.execPath, [cli, 'new', 'app', dir]), /目标目录非空/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 生成了什么

```
my-app/
├── package.json          # 依赖 @actor/app @actor/data @actor/web（用户项目不直接依赖内核）
├── config/default.ts     # 配置 = 默认值 + 校验（APP_* 环境变量覆盖）
├── main.ts               # 启动入口：SIGTERM/SIGINT 优雅停止
├── src/
│   ├── app.ts            # defineApp：配置 / 模块 / 插件
│   ├── module.ts         # defineModule：providers（仓储）+ actors + routes
│   ├── notes.ts          # CRUD 控制器（仓储 + 游标分页 + 乐观锁 → 409）
│   └── counter.ts        # Actor（mode: 'snapshot'）：写路径在这里
├── test/app.test.ts      # 端到端：真 HTTP + 真重启
└── README.md
```

| 路径 | 走哪一层 |
|---|---|
| `POST /notes`、`GET /notes?limit=&cursor=`、`PATCH /notes/:id`、`DELETE /notes/:id` | **仓储**（文件适配器；换 SQL 只改 `module.ts` 一行） |
| `POST /counter/add`、`GET /counter` | **Actor**（`mode: 'snapshot'`，状态落盘） |
| `GET /health` | 函数式控制器（无输入无依赖时最简） |

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
