# 11. 数据与 CRUD：建表 → 迁移 → 仓储 → 接口

**你会得到**：从"声明一张表"到"五条 CRUD 路由"的完整链路，含迁移与仓储

**前置**：跑得起来一个项目；用过 SQL 或 ORM 更顺　**耗时**：20 分钟

最常见的活就是这个：**一张表 + 一组 CRUD 接口**。这一页把它一次走完，每步都能单独替换。

## 0. 先选路线

| 你的情况 | 用什么 |
|---|---|
| 标准 CRUD（列表/单条/建/改/删），字段少 | [`crudRoutes`](./09-app-sugar.md)（工厂生成五条路由，逐项可覆盖） |
| 语义特殊（复杂查询、批量、状态机） | 手写控制器 + `createRepository` |
| 不想写 SQL、只要键值/对象存储 | `@actor/data` 的仓储与聚合（见 [internals/04-data-layer](./internals/04-data-layer.md)） |
| 要事件溯源/投影/outbox | `@actor/data`（同上） |

## 1. 声明表（model）

```ts
import { defineModel } from '@actor/db';

export const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },          // 框架在 insert 时自动生成
    title: { type: 'string', length: 200, notNull: true },
    body: { type: 'text', default: '' },
    tags: { type: 'json', default: [] },              // 库里是文本，领域里是数组（自动编解码）
    done: { type: 'boolean', default: false },
    createdAt: { type: 'timestamp', auto: 'create' }, // 插入时自动填
    updatedAt: { type: 'timestamp', auto: 'update' }, // 每次更新自动填
    version: { type: 'integer', version: true },      // 乐观锁：update 时自动 +1，冲突抛 DbConflictError
  },
  indexes: [{ fields: ['done'] }],
});
```

**同一个 model 声明，三种方言都能建表**（`createTableSql` 按方言渲染类型）：

```ts
Note.createTableSql(dialectFor({ dialect: 'sqlite' }));
// CREATE TABLE IF NOT EXISTS "notes" ("id" text NOT NULL PRIMARY KEY, "title" text NOT NULL, …)

Note.createTableSql(dialectFor({ dialect: 'pgsql' }));    // uuid / jsonb / timestamptz
Note.createTableSql(dialectFor({ dialect: 'mysql' }));    // char(36) / json / datetime
```

## 2. 建表与迁移

- **开发/测试**：`db.sync([Note])` 直接建（幂等）；表结构与 model 不一致时它能给出**漂移报告**
  （`sync([...], { mode: 'check' })` 只报不改，适合 CI）。
- **生产**：用迁移，不要靠 sync。迁移文件里写"意图 + SQL"，CLI 管状态：

```bash
actor migrate status      # 列出待应用（有未应用时退出码 2，可直接当 CI 门禁）
actor migrate up          # 应用
actor migrate down --to 1 # 回滚到版本 1
```

在应用启动前拦一道（多数事故是"代码上了、表没迁"）：

```ts
// server.ts 或 main.ts 的启动前钩子
await runApp(application, {
  beforeStart: async () => {
    const { pending } = await migrateStatus();
    if (pending.length > 0) throw new Error(`有 ${pending.length} 个迁移未应用，拒绝启动`);
  },
});
```

## 3. 仓储：连上库

```ts
import { databaseAdapter, createRepository } from '@actor/db';

export default defineModule({
  name: 'app',
  providers: {
    notes: (deps) => {
      const db = deps['db'] as { runner(): Runner; models: Map<string, Model> };
      return createRepository(Note, { dialect: 'sqlite', runner: db.runner(), models: db.models });
    },
  },
  plugins: [databaseAdapter({ url: 'sqlite:./data/app.db', models: [Note] })],
});
```

仓储给你的方法（都**参数化 SQL**，标识符只来自 model 声明）：

| 方法 | 说明 |
|---|---|
| `insert(entity)` | 自动填 uuid 主键 / `auto:'create'` / `version=0`，返回落库后的实体 |
| `findById(id)` | 找不到返回 `null`（**不抛错**，由控制器决定 404） |
| `findMany({ where, orderBy, limit, cursor })` | `where` 是字段等值条件；`cursor` 是游标分页 |
| `update(id, patch, { expectedVersion })` | 乐观锁：版本不符抛 `DbConflictError`（→ 你翻译成 409） |
| `delete(id)` | 返回是否删掉 |

> **为什么列表推荐游标**：`offset` 分页在并发写入下会**漏或重**（有人插了一行，第二页就错位）。
> 脚手架默认给的就是 `?limit=&cursor=`。真要 offset，用 `findMany` + 自己的 SQL。

## 4. 接口：工厂或手写

### 路线 A：`crudRoutes`（五条路由一次到位）

```ts
import { crudRoutes } from '@actor/web';

// 把仓储适配成工厂要的"最小形状"（不同数据层方法名不同，这里是唯一需要翻译的地方）
const store = {
  list: (input) => notes.findMany({ orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: Number(input.limit) }),
  get: (id) => notes.findById(id),
  create: (body) => notes.insert(body),
  update: (id, body) => notes.update(id, body, { expectedVersion: Number(body.expectedVersion) }),
  remove: (id) => notes.delete(id),
};

// 字段两种写法：
//   fields: ['title', 'body']                       → 都是**必填字符串**
//   fields: { title: 'string', tags: ['x'] }        → 值即 schema（要 json/默认值/可缺省就用这种）
defineModule({
  name: 'notes',
  router: crudRoutes('/notes', store, { fields: { title: 'string', tags: ['x'] } }),
});
```

`fields` 是**可写字段声明**（校验严格：未声明的键会被 400 拒掉）。
乐观锁冲突要变成 409：在 `update` 里 catch `DbConflictError` 抛 `HttpError(409, …)`（见下面手写版示例）。

### 路线 B：手写控制器（要精确控制时）

```ts
export const notesController = {
  create: defineController({
    input: { title: 'string', tags: ['x'] },
    handle: async (input, ctx) => {
      const notes = ctx.get('notes') as Repository<typeof Note>;
      return reply.json(await notes.insert(input), { status: 201 });
    },
  }),
  update: defineController({
    input: { id: { from: 'params', type: 'string' }, title: 'string' },
    handle: async (input, ctx) => {
      const notes = ctx.get('notes') as Repository<typeof Note>;
      try {
        return await notes.update(String(input.id), { title: input.title }, { expectedVersion: Number(input.expectedVersion) });
      } catch (err) {
        if (err instanceof DbConflictError) throw new HttpError(409, '别人已经改过了', { expected: err.expectedVersion, actual: err.actualVersion });
        throw err;
      }
    },
  }),
};
```

## 5. 端到端跑一遍（真库：内存 SQLite，CI 真执行）

下面这段是**真的建表、真的读写、真的撞乐观锁**（用 Node 24 内置的 `node:sqlite`，
所以不需要装任何东西、也不会碰你的磁盘）。

```js verify
import assert from 'node:assert';

// 这个块会被抽到临时目录里执行（cwd 是仓库根），所以源码导入用"cwd + file://"的形式。
// 你写自己的项目时就直接 `from '@actor/db'` / `from '@actor/web'`。
const repo = `file://${process.cwd()}/`;
const { createRepository, defineModel, dialectFor } = await import(`${repo}packages/db/src/index.ts`);
const { crudRoutes, createApp, defineApp, defineModule, httpPlugin, HttpError } = {
  ...(await import(`${repo}packages/web/src/index.ts`)),
  ...(await import(`${repo}packages/app/src/index.ts`)),
};
const { DatabaseSync } = await import('node:sqlite');

// ① 表声明：uuid 主键 / json 列 / 乐观锁 version
const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    tags: { type: 'json', default: [] },
    version: { type: 'integer', version: true },
    createdAt: { type: 'timestamp', auto: 'create' },
  },
});
const dialect = 'sqlite';
const ddl = Note.createTableSql(dialectFor({ dialect }));
assert.match(ddl, /CREATE TABLE IF NOT EXISTS "notes"/);
assert.match(ddl, /"tags" text DEFAULT '\[\]'/, '同一声明在 sqlite 下渲染成 text（不是 jsonb）');

// ② 真库（内存）+ 最小 Runner：SqliteRunner 就是 all / run 两个方法
const db = new DatabaseSync(':memory:');
db.exec(ddl);
const runner = {
  all: async (sql, params = []) => db.prepare(sql).all(...params),
  run: async (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
};
const notes = createRepository(Note, { dialect, runner, models: new Map([['notes', Note]]) });

// ③ 仓储：插入自动填 id/version/createdAt；json 列自动编解码（**先别改它**，⑤ 要拿它做断言）
const created = await notes.insert({ title: '第一条', tags: ['a'] });
assert.ok(typeof created.id === 'string' && created.id.length > 0, 'uuid 主键自动生成');
assert.strictEqual(created.version, 0, 'version 从 0 开始');
assert.deepStrictEqual(created.tags, ['a'], 'json 列写进去、读出来都是数组');
assert.strictEqual(await notes.findById('不存在'), null, 'findById 找不到给 null（不抛错）');

// ④ 仓储：读一条 / 列表
assert.deepStrictEqual({ ...(await notes.findById(created.id)) }, { ...created });

// ⑤ 接口：crudRoutes + 把 DbConflictError 翻成 409
const store = {
  list: (input) => notes.findMany({ orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: Number(input.limit) }),
  get: (id) => notes.findById(id),
  create: (body) => notes.insert(body),
  // 工厂把 expectedVersion 摘出来作为第三参传进来（所以它不该混进 body 去当列改）
  update: (id, body, options) => {
    try {
      return notes.update(id, body, { expectedVersion: options?.expectedVersion });
    } catch (error) {
      if (error.name === 'DbConflictError') throw new HttpError(409, '别人已经改过了');
      throw error;
    }
  },
  remove: (id) => notes.delete(id),
};

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'notes',
        router: crudRoutes('/notes', store, { fields: { title: 'string', tags: ['x'] } }),
      }),
    ],
    plugins: [http],
  }),
  { configDir: null, env: {} },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  const list = await (await fetch(`${base}/notes?limit=20`)).json();
  assert.strictEqual(list.length, 1);
  // 注意：仓储读回来的 createdAt 是 Date，过 JSON 之后变成 ISO 字符串 —— 按字段比，别整对象比
  assert.strictEqual(list[0].id, created.id);
  assert.strictEqual(list[0].title, created.title);
  assert.deepStrictEqual(list[0].tags, created.tags);

  const fresh = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '第二条', tags: [] }),
  });
  assert.strictEqual(fresh.status, 201);
  const second = await fresh.json();

  // 乐观锁冲突 → 409（业务语义，不是 500）
  const stale = await fetch(`${base}/notes/${String(second.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '并发改', expectedVersion: 999 }),
  });
  assert.strictEqual(stale.status, 409, '版本对不上必须 409');

  // 单条 / 删除 / 再删
  assert.strictEqual((await fetch(`${base}/notes/${String(second.id)}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/notes/${String(second.id)}`, { method: 'DELETE' })).status, 204);
  assert.strictEqual((await fetch(`${base}/notes/${String(second.id)}`, { method: 'DELETE' })).status, 404);

  // 未声明的写入字段仍然 400（fields 之外一律拒）
  const extra = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x', nope: 1 }),
  });
  assert.strictEqual(extra.status, 400);

  // ⑥ 乐观锁：库层拿旧版本更新必须抛 DbConflictError（接口层已经把它翻成 409，上面断言过）
  const current = await notes.findById(created.id);
  await assert.rejects(
    () => notes.update(created.id, { title: '并发改' }, { expectedVersion: current.version - 1 }),
    (error) => error.name === 'DbConflictError',
    '拿旧版本更新必须冲突（这就是 409 的来源）',
  );
  const bumped = await notes.update(created.id, { title: '顺序改' }, { expectedVersion: current.version });
  assert.strictEqual(bumped.version, current.version + 1, '更新成功 version +1');
} finally {
  await app.stop();
}
console.log('ok');
```

## 6. 换个库要改什么

| 从 | 到 | 改动 |
|---|---|---|
| 内存 / sqlite | pgsql | `databaseAdapter({ url: 'pgsql://…' })` + `npm i pg`；model/仓储/控制器**一行不改** |
| sqlite | mysql | 同上（`npm i mysql2`） |
| 单库 | 多库 | `databaseAdapter(..., { name: 'analytics' })` 起第二个实例（见 [`examples/app-multi-db`](../../examples/app-multi-db/README.md)） |
| 换 ORM 风格 | 自定义 SQL | 用 `db.runner()` 自己写（`db-core` 的 `Runner` 契约），仓储仍可复用映射 |

方言由 URL 推断，也能显式给；池参数、探活、优雅关闭都由 `databaseAdapter` 统一管（连不上就**启动失败**，不静默降级）。

## 7. 相关

- 输入校验与错误码 → [10 路由与请求](./10-http-routing.md)
- 工厂的完整选项 → [09 应用层语法糖](./09-app-sugar.md) §5
- 真实库的完整示例 → [`examples/app-db`](../../examples/app-db/README.md)、[`examples/app-multi-db`](../../examples/app-multi-db/README.md)
- 事件溯源/投影/outbox → [internals/04-data-layer](./internals/04-data-layer.md)

## 下一步


- [12 Actor 与状态](./12-actors-state.md)
- [17 测试](./17-testing.md)
