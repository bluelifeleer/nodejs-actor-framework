# 17. 应用层语法糖（短名 / 简写 / 工厂 / 保留名）

这一篇是 M9 那批"应用层语法糖"的**完整说明**：短名、参数简写（T2）、工厂（T3）、
保留名与诊断可见性。它们的目标只有一个：**把应用层的样板压下去，但不牺牲"启动期响亮失败"**。
每一处糖都有"与全量写法**深比较相等**"或"行为等价"的门禁盯着，所以放心混用。

> 糖的定位：`defineXxx` 永远是**规范名**，短名/简写只是同一份数据的另一种写法。
> 细节与决策记录见 [m9-define-sugar.md](../../design/m9-define-sugar.md)（含"设计 vs 实现"对照）。

## 1. 短名与 `defineXxx` 是**同一个对象**

```ts
import { app, config, module, plugin } from '@actor/app';        // defineApp / defineConfig / defineModule / definePlugin
import { controller, router, middleware, webPlugin } from '@actor/web';  // defineController / defineRouter / …
```

不是包装函数、不是两套方言：`test/unit-sugar-aliases.test.js` 用 `===` 逐条钉死
`short === canonical`。谁把它改成包装函数，门禁立刻红。

| 包 | 短名 |
|---|---|
| `@actor/app` | `app` `config` `module` `plugin` |
| `@actor/web` | `controller` `router` `middleware` `webPlugin` `uploadStorage` |
| `@actor/db` / `@actor/mongodb` | `model` / `collection` |
| `@actor/data` | `aggregate` `eventSchema` `evolution` |
| `@actor/mail` / `@actor/resource` | `mailTransport` / `managedResource` |

两个**故意没有**短名的地方（名字已被占用，不是遗漏）：`defineRoutes`（`routes` 在 `@actor/web` 里
已经是"路由表标记"，配 `RoutesTableSpec`）与 `defineResourceAdapter`（`resourceAdapter` 已是插件装载函数）。

## 2. 配置：值即 schema

```ts
config({
  port: 3000,                    // = { type: 'number', default: 3000 }
  name: 'app',                   // = { type: 'string', default: 'app' }
  verbose: false,                // = { type: 'boolean', default: false }
  tags: ['a'],                   // = { type: 'json',   default: ['a'] }
  token: { type: 'string', secret: true },   // 要打码/必填/校验就写全量形式
});
```

规则与边界（都可证伪，见 `packages/app/test/sugar-config.test.ts`）：

| 写法 | 结果 |
|---|---|
| 字符串 / 数字 / 布尔 / 数组 | 推断类型 + 该值作为 `default` |
| **普通对象** | **永远是分组**（递归展开），不会被当成"默认值是个对象" |
| `{ type: 'json', default: { … } }` | 要对象默认值就写这个（意图明确） |
| `{ type: 'string' }`（无 default） | **必填** —— 简写总有默认值，所以"必填"只能靠全量写法 |
| `{ …, required: false }` | 可缺省（部分更新用；没给就跳过，给了照常校验） |
| `null` / 函数 / 拼错的 `type` | **定义期报错**，并给出"支持哪些写法"的提示 |

两种写法**可以混用**，而且归一化只做一次（`schema` 与 `fields` 都由同一份产出，不可能分叉）。

从环境变量读配置的命名约定不变：`port` → `APP_PORT`，`gateway.url` → `APP_GATEWAY__URL`。

## 3. 控制器输入声明合一

不用再手写两处（`body: [...]` 与 `input`）——**不带 `from` 的输入默认来自请求体**：

```ts
controller({
  input: {
    filename: 'string',                                     // 字符串简写（别名见下）
    size: 'int',
    id: { from: 'params', type: 'string', min: 1 },          // 路径参数
    limit: { from: 'query', type: 'number', default: 20 },   // 查询参数（模式里仍要写 ?limit= 声明"会读取"）
  },
  handle: (input) => input,
});
```

**字符串别名**：`string` / `int`、`number` / `bool`、`boolean` / `json`（都表示"该类型、必填"；
要默认值写 `{ type, default }`）。不认识的别名在**定义期**报错，不会静默当字符串。

**来源的优先级**（这一条在实现时踩过坑，值得记住）：

```
显式 from  >  路由模式（:param / ?query=）  >  输入的默认来源（body）
```

为什么"模式"要插在中间：`get('/rooms/:id?verbose=', controller({ input: { verbose: { type: 'boolean' } } }))`
这种老写法（还没有 `from` 概念）一直靠模式定位；若让"默认 body"盖过模式，`?verbose=true` 的查询值会被直接丢掉。

**来源决定了输入怎么组装**：`from: 'query'` 的键**不会**被同名 body 字段顶掉（反之亦然）。
`body` 会被自动补齐，于是"每个输入键都必须有来源"的启动期校验照旧生效（写错字仍然 400 级报错）。

## 4. 中间件：阶段即函数名

阶段顺序**由框架保证**（不靠你记得"鉴权要排在解析上传前面"）。写法有两种，完全等价：

```ts
import { atAuth, atPost } from '@actor/web';

controller({
  middleware: [
    atAuth(async (ctx, next) => { /* 校验 token */ return next(); }),   // = { handler, phase: 'auth' }
    { handler: async (_ctx, next) => next(), phase: 'pre' },            // 全量写法，可混用
    atPost(async (_ctx, next) => { const result = await next(); /* 后置 */ return result; }),
  ],
  handle: () => ({ ok: true }),
});
```

六个阶段：`atPre` `atAuth` `atParse` `atHandler` `atPost` `atError`（顺序即此顺序）。
名字带 `at` 前缀是**刻意的**：`post` 已经是路由助手、`parse` 撞 `JSON.parse` —— 早期直接用这些名字时，
示例在同一个文件里 `import { post }` 就编译不过（实测）。

> 阶段简写会**包一层函数**（不是给原函数挂属性：函数的 `name` 是只读的）。
> 阶段名拼错不会静默失效：`defineWebPlugin` 在定义期就拒绝非法阶段。

## 5. 工厂：`crudRoutes` / `healthRoutes`

`crudRoutes(prefix, store, opts)` 生成标准的五条路由，`store` 只要**结构化最小形状**
（不依赖 `@actor/db`，你自己的仓储/适配器都能满足）：

```ts
interface CrudStore {
  list(input): unknown;                     // 列表（分页参数已校验/补默认值后透传）
  get(id): unknown;                         // null → 404
  create(body): unknown;                    // 抛 status:409（或 name 含 Conflict）→ 409
  update(id, body): unknown;                // null → 404
  remove(id): unknown;                      // false/null → 404，否则 204
}
```

| 方法/模式 | 语义 |
|---|---|
| `GET <prefix>?limit=&offset=` | 列表；默认 `limit=20`、上限 100（可用 `pagination` 改，`false` 则不声明分页） |
| `GET <prefix>/:id` | 取一条；`null` → 404 |
| `POST <prefix>` | 创建 → 201（返回体是仓储的返回值） |
| `PUT <prefix>/:id` | 更新 → 200；默认**部分更新**（`updateRequired: true` 改成全量必填） |
| `DELETE <prefix>/:id` | 删除 → 204；`false` → 404 |

**可写字段要显式声明**（框架的输入校验是严格的：未声明的键会被拒，防拼写错误）：

```ts
crudRoutes('/notes', notesRepository, {
  name: 'note',
  fields: ['title', 'body'],          // 数组 = 字段名列表，默认都是必填字符串
  // fields: { title: 'string', done: { type: 'boolean', default: false } },  // 或值即 schema
  auth: { required: true },           // 由 authPlugin 解释；没装 authPlugin 就只是声明
  input: { list: { tag: { from: 'query', type: 'string' } } },   // 给某一条加输入
  routes: { list: myListController },  // 想换哪条就换哪条（其余保持工厂产出）
});
```

`healthRoutes()` 生成 `GET /health`，**只报告进程形状**（`status` / `uptimeMs` / 受管资源**数量**）：

```json
{ "status": "ok", "uptimeMs": 12, "resources": null }
```

刻意的取舍：**深度健康**（`checkHealth()`）留在 `/__debug/health?check=1`（需要 token）；
公开端点不该暴露资源名与配置细节。受管资源没装时 `resources` 如实给 `null`（不假装 0）。

产出的是**普通 `RouterSpec`**，所以放进 `defineModule({ router })`、与手写路由混用、
重复路由检查、前缀校验全都照旧。

## 6. 保留名：框架守的那一层

| 保留物 | 值 | 撞上会怎样 |
|---|---|---|
| ctx 字段 | `method` `path` `requestId` `body` `params` `qs` `headers` `route` … | `ctx.extend({ … })` 明确报错 |
| 路由前缀 | `/uploads`（uploadPlugin）、`/__debug`（debugPlugin） | 模块路由落在里面 → **启动期报错**；插件认领保留前缀、两个插件抢同一前缀也报错 |
| 服务名 | `config` `log` `httpServer` `wsConnections` 与 `@actor/` 命名空间 | 插件名 / provides / provider 名撞上 → 启动期报错 |

单一来源（文档与门禁都读它）：`RESERVED_CONTEXT_KEYS`、`RESERVED_ROUTE_PREFIXES` /
`RESERVED_PREFIX_OWNERS`（`@actor/web`）、`RESERVED_SERVICE_NAMES`（`@actor/app`）。

自定义插件占自己的命名空间就声明前缀：`defineWebPlugin({ routePrefix: '/mine', … })`。

**编译器挡不住的那一层已经有人管**：重复标识符（`import { config }` + `const config`）由 TypeScript 报错，
框架不重复做；框架只守"保留位"。真撞名就 `import { config as appConfig }`。

## 7. 诊断路由的可见性作用域（四层）

`debugPlugin` 打开后挂 `/__debug/routes|health|config`（默认**关闭**、需 token、生产**拒绝启动**）。
"诊断输出里暴露什么"可以按四层收窄：

```ts
debugPlugin({ enabled: true, token, expose: { hidePrefixes: ['/internal'] } })  // 全局：按前缀
module({ name: 'admin',  debug: { hidePrefixes: ['/admin/audit'] } })            // 路由前缀（模块级叠加）
module({ name: 'secret', debug: { expose: false } })                             // 模块：整棵子树不进输出
controller({ debug: 'off', handle })                                             // 控制器：这一条不进输出
```

> ⚠️ **这不是安全边界**：它只让诊断输出少暴露信息，**不影响路由是否可用、也不改变鉴权**。
> 真正的门是 token + "生产环境拒绝启动"。把"隐藏"当安全用是常见误解 —— 用例里专门有一条
> "被隐藏的路由照样 200，而没 token 访问诊断端点仍然 401"。

## 8. 全套一起跑（这条示例会被测试执行）

```js verify
import assert from 'node:assert';

// 这个块会被抽到临时目录里执行（cwd 是仓库根），所以源码导入用绝对 file URL。
// 你写自己的项目时就直接 `from '@actor/app'` / `from '@actor/web'`。
const repo = new URL('../', import.meta.url).href;
const { createApp, defineApp, defineModule, defineConfig, RESERVED_SERVICE_NAMES } =
  await import(`${repo}packages/app/src/index.ts`);
const { crudRoutes, healthRoutes, httpPlugin, RESERVED_ROUTE_PREFIXES } =
  await import(`${repo}packages/web/src/index.ts`);

// ① 配置：值即 schema 与**显式声明**逐字段等价（主线 [09 可选简写](../09-app-sugar.md)
//    把这条等价性指到这里 —— 主线只写一种形态，等价证明留在这页）
const sugaredConfig = defineConfig({ port: 3000, nested: { retries: 3 } });
const verboseConfig = defineConfig({
  port: { type: 'number', default: 3000 },
  nested: { retries: { type: 'number', default: 3 } },
});
assert.deepStrictEqual([...sugaredConfig.fields.entries()], [...verboseConfig.fields.entries()]);
assert.deepStrictEqual(sugaredConfig.schema, verboseConfig.schema, '简写必须原地展开成同一份 schema');

// ② 仓储只要最小形状（这里用内存实现；换成 @actor/db 的仓储也一样）
const rows = new Map();
const notes = {
  list: (input) => ({ items: [...rows.values()].slice(Number(input.offset), Number(input.offset) + Number(input.limit)), total: rows.size }),
  get: (id) => rows.get(String(id)) ?? null,
  create: (body) => {
    if ([...rows.values()].some((row) => row.title === body.title)) {
      const conflict = new Error('duplicate');
      conflict.status = 409;
      throw conflict;
    }
    const row = { id: `n${rows.size + 1}`, title: body.title };
    rows.set(row.id, row);
    return row;
  },
  update: (id, body) => {
    const row = rows.get(String(id));
    if (!row) return null;
    return Object.assign(row, body);
  },
  remove: (id) => rows.delete(String(id)),
};

// ② 工厂产出的就是普通 RouterSpec，直接放进模块
const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({ name: 'notes', router: crudRoutes('/notes', notes, { name: 'note', fields: ['title'] }) }),
      defineModule({ name: 'ops', router: healthRoutes() }),
    ],
    plugins: [http],
  }),
  { configDir: null, env: {} },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  // 列表（分页默认值生效）
  const list = await fetch(`${base}/notes`);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(await list.json(), { items: [], total: 0 });

  // 创建 → 201；重复 → 409
  const created = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'first' }),
  });
  assert.strictEqual(created.status, 201);
  const duplicate = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'first' }),
  });
  assert.strictEqual(duplicate.status, 409, '冲突必须是 409');

  // 单条 / 更新 / 删除
  assert.deepStrictEqual(await (await fetch(`${base}/notes/n1`)).json(), { id: 'n1', title: 'first' });
  assert.strictEqual((await fetch(`${base}/notes/missing`)).status, 404);
  const updated = await fetch(`${base}/notes/n1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'renamed' }),
  });
  assert.deepStrictEqual(await updated.json(), { id: 'n1', title: 'renamed' }, 'PUT 默认部分更新');
  assert.strictEqual((await fetch(`${base}/notes/n1`, { method: 'DELETE' })).status, 204);
  assert.strictEqual((await fetch(`${base}/notes/n1`)).status, 404);

  // 未声明的字段仍然被拒（严格校验没有被工厂放宽）
  const extra = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x', nope: 1 }),
  });
  assert.strictEqual(extra.status, 400);

  // health：只报告进程形状
  const health = await (await fetch(`${base}/health`)).json();
  assert.strictEqual(health.status, 'ok');
  assert.strictEqual(health.resources, null, '没装受管资源时如实 null');

  // ③ 保留名是单一来源（装配期据此报错）
  assert.ok(RESERVED_ROUTE_PREFIXES.includes('/__debug'));
  assert.ok(RESERVED_SERVICE_NAMES.includes('httpServer'));
} finally {
  await app.stop();
}
console.log('ok');
```

## 9. 下一步

- 想从零生成一个用上这些写法的项目：[从零生成一个项目](./00-scaffold.md)（`actor new app`）；
- 想写自己的插件（含四种骨架）：[Web 插件](./12-web-plugin.md) 与 [自装适配器](./11-custom-adapter.md)；
- 想做 CRUD + 真实数据库：[数据层](./04-data-layer.md) / [数据库](./08-database.md)；
- 诊断与日志：[日志与诊断](./15-observability.md)。
