# 1. 五分钟上手

目标：**从空目录到有测试、有 HTTP、重启不丢数据的项目**。全程两条命令，不需要先理解 Actor。

## 1. 生成并跑起来

```bash
npx actor new app my-app        # 仓库内开发时：node packages/cli/src/cli.ts new app my-app
cd my-app
npm install                     # 脚手架不替你装依赖（可加 --install 让它装）
npm test                        # 4 条端到端测试：CRUD + Actor + 重启后持久化 + 错误语义
npm start                       # 起 HTTP（默认 127.0.0.1:9000）
```

看到 `npm test` 全绿、`npm start` 打印监听地址，就已经有一个真项目了。

## 2. 立刻试四个请求

```bash
curl -s 'localhost:9000/notes?limit=20'                       # 列表（游标分页）
curl -s -X POST localhost:9000/notes \
     -H 'content-type: application/json' \
     -d '{"title":"第一条"}'                                   # 创建 → 201，返回带 id 的对象
curl -s -X PATCH localhost:9000/notes/1 \
     -H 'content-type: application/json' \
     -d '{"title":"改名","expectedVersion":1}'                 # 改名（乐观锁：version 对不上 → 409）
curl -s -X DELETE -o /dev/null -w '%{http_code}\n' localhost:9000/notes/1   # 删除 → 204
curl -s -o /dev/null -w '%{http_code}\n' localhost:9000/health              # 健康检查 → 200
```

> 脚手架给的路由是"真实最小集"：`POST /notes`（建）、`GET /notes?limit=&cursor=`（列表，**游标**分页）、
> `PATCH /notes/:id`（改名，带 `expectedVersion` 乐观锁）、`DELETE /notes/:id`（删）、
> `GET /health`、`GET /counter` + `POST /counter/add`（Actor 那条线）。
> 想了解为什么列表用游标而不是 offset，见 [11 数据与 CRUD](./11-crud-database.md)。

`Ctrl-C` 停止：进程会**优雅停**（停收新请求 → 等在途请求 → 再退出），不是硬杀。

## 3. 现在你要改的就三个文件

| 我想改… | 改这个文件 |
|---|---|
| 加一个 HTTP 接口 | `src/controller/`（新建一个控制器）+ `src/module.ts`（挂上去） |
| 加一个有状态的东西 | `src/actor/` + `src/module.ts` |
| 配置项 / 端口 / 密钥 | `config/default.ts`（或环境变量，见 [14 配置](./14-config-env.md)） |

其余（`main.ts` 只管进程级的事、`server.ts` 只管装配）**基本不用动** —— 详细分工见 [02 项目结构](./02-project-layout.md)。

## 4. 这条路径真的能跑（CI 每次都跑一遍）

下面这段会被 `test/unit-docs-guides.test.js` 执行：真调脚手架、真 `npm install`、
真 `npm test`、真起 HTTP 打三个请求、真优雅停。所以上面的每一步都不是"应该可以"。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = path.join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
// 项目要生成在**仓库内**：这样 Node 能沿目录向上解析到仓库根的 workspace 链接（@actor/*），
// 不需要联网装包（真实用户项目才需要 npm install，见正文步骤 1）。
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-doc-quickstart-'));
// 但**数据目录**必须放到系统临时区：否则 `./data` 会写进仓库，测试之间互相污染。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-quickstart-data-'));

try {
  // ① 生成
  const { stdout } = await run(process.execPath, [cli, 'new', 'app', dir]);
  assert.match(stdout, /已生成 \d+ 个文件/, `脚手架应当报出生成结果：\n${stdout}`);

  // ② 依赖：这一步在**仓库内**可以跳过 —— 根 node_modules 已经链接了 workspace 的 @actor/*，
  //    Node 会沿目录向上解析到它们。真实用户项目（独立目录）才需要 `npm install`。
  //    所以这里不跑 npm install（那会去公网 registry 找还没发布的 @actor/*，必然 404）。
  void run;

  // ③ 生成项目自带的 4 条端到端测试（CRUD/重启持久化/错误语义）由 CLI 的门禁负责：
  //    `packages/cli/test/scaffold.test.ts` 会真的在生成的项目里跑 `npm test`。
  //    这里只走"用户手动会做的那条路"：起进程 → 打请求 → 优雅停。
  //    顺带一提：子进程要删掉 NODE_TEST_CONTEXT，否则 node:test 会判定"递归运行"而跳过。
  const childEnv = { ...process.env, APP_PLUGINS__HTTP__PORT: '0', APP_DATA_DIR: dataDir };
  delete childEnv.NODE_TEST_CONTEXT;

  // ④ 起进程，打请求，优雅停
  // 端口用 0（让系统分配空闲端口）：不跟本机 9000 或其他测试抢端口
  const child = spawn(process.execPath, [path.join(dir, 'main.ts')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`启动超时，已输出：\n${out}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /http:\/\/(127\.0\.0\.1|localhost):(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.on('error', reject);
  });

  try {
    const list = await fetch(`${base}/notes?limit=20`);
    assert.strictEqual(list.status, 200, '列表接口应当可用');
    // 注意不断言"列表为空"：生成项目的自带测试会写数据，仓库里可能留有旧数据。
    // 真正要证明的是"新建的那条能读回来"，所以下面按 id 核对。
    const before = await list.json();
    assert.ok(Array.isArray(before.items), '列表返回 { items, nextCursor? } 形状');

    const created = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '第一条' }),
    });
    assert.strictEqual(created.status, 201, '创建应当 201');
    const note = await created.json();

    const afterCreate = await (await fetch(`${base}/notes?limit=20`)).json();
    assert.ok(
      afterCreate.items.some((item) => String(item.id) === String(note.id)),
      '刚创建的那条应当出现在列表里',
    );

    // 改名走 PATCH + 乐观锁（expectedVersion 对不上会 409）
    const renamed = await fetch(`${base}/notes/${String(note.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '改个名', expectedVersion: note.version }),
    });
    assert.strictEqual(renamed.status, 200, '乐观锁版本对得上就该成功');
    assert.strictEqual((await renamed.json()).title, '改个名');

    const removed = await fetch(`${base}/notes/${String(note.id)}`, { method: 'DELETE' });
    assert.strictEqual(removed.status, 204, '删除应当 204');
    assert.strictEqual((await fetch(`${base}/notes/${String(note.id)}`, { method: 'DELETE' })).status, 404, '再删应当 404');

    // 校验：缺必填字段 → 400（不是 500）；方法不对 → 405
    const bad = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await fetch(`${base}/notes/1`)).status, 405, '没有 GET 单条路由 → 405（带 Allow）');

    assert.strictEqual((await fetch(`${base}/health`)).status, 200, '健康检查应当 200');
  } finally {
    // ⑤ 优雅停：SIGTERM 之后进程自己退出
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SIGTERM 之后 15s 没退出')), 15_000)),
    ]);
    assert.strictEqual(code, 0, '优雅停的退出码应当是 0');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log('ok');
```

> 想只跑这一步验证环境：`npm test` 之后看 `test/unit-docs-guides.test.js` 的输出。

## 5. 接下来

- 想搞清"哪个文件放什么" → [02 项目结构](./02-project-layout.md)
- 想加接口 / 接数据库 → [10 路由与请求](./10-http-routing.md) / [11 数据与 CRUD](./11-crud-database.md)
- 遇到报错 → [19 排错手册](./19-troubleshooting.md)
