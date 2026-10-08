# 10. 路由与请求：校验、状态码、中间件

这一页只讲一件事：**一个 HTTP 请求从进来到响应，每一步在哪里写、错了会怎样**。

## 1. 路由写在哪

路由是**声明式**的，挂在模块上（`defineModule({ routes })` 或 `{ router }`），
框架在**启动期**统一校验：非法模式、重复路由、输入键没有来源 —— 全部拒绝启动并列出问题。

```ts
import { defineRoutes, get, post, del } from '@actor/web';

export default defineModule({
  name: 'notes',
  routes: defineRoutes([
    get('/notes?limit=&cursor=', listNotes),   // ?a=&b= 表示"这个接口会读这两个查询参数"
    post('/notes', createNote),
    get('/notes/:id', getNote),                // :id 是路径参数
    del('/notes/:id', removeNote),
  ]),
});
```

嵌套/分组用 `router` + `defineRouter`（前缀会套到整棵子树上）：

```ts
defineModule({
  name: 'api',
  router: defineRouter({
    prefix: '/api/v1',
    middleware: [atAuth(requireToken)],        // 该子树全部生效（外层先执行）
    routes: defineRoutes([get('/notes', listNotes)]),   // 实际路径 /api/v1/notes
  }),
});
```

> `routes`（扁平数组）与 `router`（嵌套）**不能同时写在一个模块上**：框架会明确报错（显式优于隐式）。

## 2. 输入声明：写一次，两件事都办了

`input` 同时负责**声明来源**与**校验/转换**。不带 `from` 的字段默认来自**请求体**：

```ts
const listNotes = defineController({
  input: {
    limit:  { from: 'query', type: 'number', default: 20, min: 1, max: 100 },
    cursor: { from: 'query', type: 'string', default: '' },
  },
  handle: (input) => ({ limit: input.limit, cursor: input.cursor }),   // 已经是 number / string
});

const getNote = defineController({
  input: { id: { from: 'params', type: 'string', min: 1 } },
  handle: (input) => ({ id: input.id }),
});

const createNote = defineController({
  input: { title: 'string', tags: ['x'] },     // 简写：string/int/bool/json；数组=json
  handle: (input) => reply.json(input, { status: 201 }),
});
```

三条容易踩的规则：

| 规则 | 现象 | 怎么办 |
|---|---|---|
| **查询参数必须在模式里声明** | `input` 里有 `limit`，但模式是 `/notes`（没有 `?limit=`）→ **启动期报错** | 模式写成 `/notes?limit=`，或用 `from: 'params'`/默认 body |
| 未声明的键会被拒 | body 里多一个 `nmae` → **400**（防拼写错误，故意的） | 声明它（`fields`/`input`），或确实要收任意 JSON 就声明 `type: 'json'` |
| 类型转换是**自动**的 | `?limit=50` 到 `handle` 里已是 `number`；`?verbose=true` 已是 `boolean` | 别自己 `Number(input.x)` |

**错误形状是统一的**（与配置校验同一套）：

```json
{ "error": { "status": 400, "message": "input validation failed",
             "details": { "issues": [ { "path": "limit", "message": "不得小于 1（实际 0）" } ] } } }
```

## 3. 错误 → 状态码：一张表就够了

| 你做什么 | 客户端看到 |
|---|---|
| `return { … }` / `return [ … ]` | 200 + JSON |
| `return reply.json(x, { status: 201 })` | 201 |
| `return undefined` / `reply.noContent()` | 204（空体） |
| `throw new HttpError(409, '已存在')` | 409 + `{ error: { status, message, details } }`（`details` 是第 3 个参数） |
| 抛其它异常 | **500**，响应里**不带**内部细节；服务端通过 `app.on('http:error')` 可见 |
| Actor 的 `AskTimeoutError` | 504 |
| 找不到 Actor（`ActorNotResolvableError`） | 404 |

```ts
import { HttpError, reply } from '@actor/web';

if (exists) throw new HttpError(409, '标题重复', { title });
return reply.noContent();
```

> 服务端**必须能看到 5xx**：`httpPlugin` 会把 5xx 转成 `app.emit('http:error', { requestId, status, path, error })` ——
> 接一条日志即可（框架不替你决定日志去处）。

## 4. 中间件：阶段顺序由框架保证

Koa 风格 `(ctx, next)`；`await next()` 之后的部分逆序展开。**阶段**决定顺序，不靠你排：

| 阶段 | 典型用途 |
|---|---|
| `pre` | 请求日志、限流、CORS |
| `auth` | 鉴权（`authPlugin` 在这一阶段解释控制器上的 `auth` 声明） |
| `parse` | 解析/规范化（例如把 header 里的租户写进 `ctx.state`） |
| `handler` | 紧贴控制器之前的准备 |
| `post` | 后置：统一包一层响应、耗时统计 |
| `error` | 兜底错误处理 |

三种写法等价，可混用：

```ts
import { atPre, atPost } from '@actor/web';

defineModule({
  name: 'notes',
  middleware: [
    atPre(async (ctx, next) => { ctx.state.startedAt = Date.now(); return next(); }, 'timer'),
    { handler: async (_ctx, next) => next(), phase: 'pre' },                    // 全量写法
    atPost(async (ctx, next) => { const result = await next(); void ctx; return result; }),
  ],
  routes: defineRoutes([get('/notes?limit=', listNotes)]),
});
```

**中间件之间的通信**走 `ctx.state`（每请求可变袋）；**要挂到 `ctx.xxx` 上**用 `ctx.extend`：

```ts
atAuth(async (ctx, next) => {
  const user = await verify(ctx.header('authorization'));
  ctx.extend({ user });            // 之后 ctx.user 可用；框架保留字段会被拒绝（防覆盖）
  return next();
}),
```

**短路**：不调 `next()` 直接返回即可（返回什么就是响应）；抛 `HttpError` 也一样。

## 5. 自定义响应（下载、protobuf、HEAD）

```ts
import { reply } from '@actor/web';

return reply.text('纯文本');
return reply.buffer(new Uint8Array([1, 2, 3]));                    // 二进制，带 content-type
return reply.send(bytes, { status: 206, contentType: 'video/mp4', headers: { 'content-range': 'bytes 0-1/2' } });
```

`HEAD` 请求命中 `GET` 路由时，响应头照常计算、`body` 自动丢弃（标准行为，不用你处理）。

## 6. 端到端跑一遍（CI 真执行）

下面这段直接 dispatch 路由表（不起服务器），把上面这些规则全部断言一遍。

```js verify
import assert from 'node:assert';

// 这个块会被抽到临时目录里执行（cwd 是仓库根），所以源码导入用"cwd + file://"的形式。
// 你写自己的项目时就直接 `from '@actor/web'`。
const repo = `file://${process.cwd()}/`;
const { buildRouteTable, defineController, defineRoutes, dispatch, get, post, reply, HttpError, atPost, atPre } =
  await import(`${repo}packages/web/src/index.ts`);

const trace = [];
const notes = new Map();

const routes = defineRoutes([
  get(
    '/notes?limit=&verbose=',
    defineController({
      middleware: [
        atPre(async (_ctx, next) => { trace.push('pre'); return next(); }, 'trace-pre'),
        atPost(async (_ctx, next) => { const value = await next(); trace.push('post'); return value; }, 'trace-post'),
      ],
      input: {
        limit: { from: 'query', type: 'number', default: 20, min: 1, max: 100 },
        verbose: { from: 'query', type: 'boolean', default: false },
      },
      handle: (input) => ({ limit: input.limit, verbose: input.verbose, count: notes.size }),
    }),
  ),
  post(
    '/notes',
    defineController({
      input: { title: 'string', tags: ['x'] },
      handle: (input) => {
        if ([...notes.values()].some((note) => note.title === input.title)) {
          throw new HttpError(409, '标题重复', { title: input.title });
        }
        const note = { id: `n${notes.size + 1}`, ...input };
        notes.set(note.id, note);
        return reply.json(note, { status: 201 });
      },
    }),
  ),
  get('/notes/:id', defineController({
    input: { id: { from: 'params', type: 'string', min: 1 } },
    handle: (input) => {
      const note = notes.get(String(input.id));
      if (!note) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return note;
    },
  })),
  get('/boom', defineController({ handle: () => { throw new Error('db password hunter2'); } })),
]);

const { routes: table, issues } = buildRouteTable(routes);
assert.deepStrictEqual(issues, [], '声明式路由在"启动期"就不该有问题');

// ① 查询参数：转换 + 默认值 + 中间件阶段顺序（pre → handle → post）
const listed = await dispatch({ routes: table, request: { method: 'GET', url: '/notes?limit=50&verbose=true' } });
assert.strictEqual(listed.status, 200);
assert.deepStrictEqual(JSON.parse(String(listed.response.body)), { limit: 50, verbose: true, count: 0 });
assert.deepStrictEqual(trace, ['pre', 'post'], '阶段顺序由框架保证（post 在 handle 之后展开）');

// ② 校验失败：一次报出全部问题
const bad = await dispatch({ routes: table, request: { method: 'GET', url: '/notes?limit=0&verbose=maybe' } });
assert.strictEqual(bad.status, 400);
const issues400 = JSON.parse(String(bad.response.body)).error.details.issues;
assert.deepStrictEqual(issues400.map((item) => item.path).sort(), ['limit', 'verbose'], '两个字段的问题一次报出');

// ③ 创建 → 201；重复 → 409（业务异常带 details）
const created = await dispatch({
  routes: table,
  request: { method: 'POST', url: '/notes', body: { title: 'a', tags: ['x'] } },
});
assert.strictEqual(created.status, 201);
assert.strictEqual(JSON.parse(String(created.response.body)).id, 'n1');

const conflict = await dispatch({
  routes: table,
  request: { method: 'POST', url: '/notes', body: { title: 'a', tags: [] } },
});
assert.strictEqual(conflict.status, 409);
assert.deepStrictEqual(JSON.parse(String(conflict.response.body)).error.details, { title: 'a' });

// ④ 未声明的 body 键会被拒（防拼写错误）
const unknownKey = await dispatch({
  routes: table,
  request: { method: 'POST', url: '/notes', body: { title: 'b', nmae: 'typo' } },
});
assert.strictEqual(unknownKey.status, 400);
assert.match(JSON.stringify(await unknownKey.response.body), /nmae/);

// ⑤ 路径参数 + 404
assert.strictEqual((await dispatch({ routes: table, request: { method: 'GET', url: '/notes/n1' } })).status, 200);
assert.strictEqual((await dispatch({ routes: table, request: { method: 'GET', url: '/notes/nope' } })).status, 404);

// ⑥ 未捕获异常 → 500，且**不把内部细节泄漏给客户端**
const boom = await dispatch({ routes: table, request: { method: 'GET', url: '/boom' } });
assert.strictEqual(boom.status, 500);
assert.ok(!String(boom.response.body).includes('hunter2'), '响应里不能带内部细节');
console.log('ok');
```

> 真实项目的 5xx 会通过 `app.emit('http:error')` 报出来（示例里没接 app，所以只看响应）。

## 7. 相关

- 加鉴权/角色 → [13 鉴权](./13-auth.md)
- 输入校验的完整字段规则（`min`/`max`/`regex`/`enum`/`secret`）→ [14 配置与密钥](./14-config-env.md) §2
- 路由写错了会怎样 → [19 排错手册](./19-troubleshooting.md)
