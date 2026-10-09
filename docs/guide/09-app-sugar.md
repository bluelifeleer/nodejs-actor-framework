# 09. 应用层语法糖：短名、简写、工厂

**你会得到**：短名、值即 schema、输入声明合一、CRUD/health 工厂 —— 每一条都与全量写法**等价**（有断言）

**前置**：写过一两个控制器与模块　**耗时**：12 分钟

一组"少写样板但**不牺牲启动期检查**"的写法。纪律只有一条：
**糖与全量写法产出同一份数据**（有"深比较相等"的门禁盯着），所以你可以逐处选择用哪种、也能混用。

## 1. 短名就是同一个对象

```ts
import { app, config, module, plugin } from '@actor/app';
import { controller, router, middleware, webPlugin, uploadStorage } from '@actor/web';
import { model } from '@actor/db'; import { collection } from '@actor/mongodb';
import { aggregate, eventSchema, evolution } from '@actor/data';
import { mailTransport } from '@actor/mail'; import { managedResource } from '@actor/resource';
```

不是包装函数、不是两套方言：`test/unit-sugar-aliases.test.js` 用 `===` 逐条钉死 `short === canonical`。

两个**故意没有**短名的地方（名字被占用，不是遗漏）：`defineRoutes`（`routes` 已是"路由表标记"）
与 `defineResourceAdapter`（`resourceAdapter` 已是插件装载函数）。

## 2. 配置：值即 schema

```ts
config({
  port: 3000,                                    // = { type: 'number', default: 3000 }
  tags: ['a'],                                   // = { type: 'json',   default: ['a'] }
  token: { type: 'string', secret: true },        // 要打码/必填/校验就写全量
  optional: { type: 'string', required: false },  // 可缺省（部分更新用）
});
```

字符串/数字/布尔/数组 → 推断类型 + 该值作默认值；**普通对象永远是分组**（要对象默认值写
`{ type: 'json', default: {…} }`）；"必填"只能靠全量写法。细节见 [14 配置与密钥](./14-config-env.md)。

## 3. 输入声明合一

不用再手写 `body: [...]` 与 `input` 两处：**不带 `from` 的输入默认来自请求体**。

```ts
controller({
  input: {
    filename: 'string',                                     // 别名：string / int、number / bool、boolean / json
    id: { from: 'params', type: 'string', min: 1 },
    limit: { from: 'query', type: 'number', default: 20 },
  },
  handle: (input) => input,
});
```

来源优先级：**显式 `from` > 路由模式（`:id` / `?q=`）> 默认 body**。详见 [10 路由与请求](./10-http-routing.md)。

## 4. 中间件：阶段即函数名

```ts
import { atAuth, atPost, atPre } from '@actor/web';

middleware: [
  atPre(async (_ctx, next) => next(), 'timer'),
  atAuth(async (ctx, next) => { ctx.extend({ user: await verify(ctx) }); return next(); }),
  { handler: async (_ctx, next) => next(), phase: 'post' },   // 全量写法，可混用
  atPost(async (_ctx, next) => { const result = await next(); return result; }),
]
```

六个阶段：`atPre` `atAuth` `atParse` `atHandler` `atPost` `atError`（顺序即此）。
名字带 `at` 前缀是刻意的：`post` 已是路由助手、`parse` 撞 `JSON.parse`。

## 5. 工厂：`crudRoutes` / `healthRoutes`

`crudRoutes(prefix, store, opts)` 生成标准五条路由；`store` 只要**结构化最小形状**：

```ts
interface CrudStore {
  list(input): unknown;                     // 列表（分页参数已校验）
  get(id): unknown;                         // null → 404
  create(body): unknown;                    // 抛 status:409 / name 含 Conflict → 409
  update(id, body, options?): unknown;      // options.expectedVersion = 乐观锁；冲突 → 409
  remove(id): unknown;                      // false/null → 404，否则 204
}
```

```ts
crudRoutes('/notes', notesRepository, {
  name: 'note',
  fields: { title: 'string', tags: ['x'] },     // 可写字段（数组=必填字符串；对象=值即 schema）
  auth: { required: true },
  onConflict: (info) => { throw new HttpError(409, '被别人改过', info); },   // 可选
  routes: { list: myListController },            // 逐项覆盖
});
```

`healthRoutes()` 生成 `GET /health`，只报告**进程形状**（`status` / `uptimeMs` / 受管资源**数量**）；
深度健康留在 `/__debug/health?check=1`（需要 token）。完整用法见 [11 数据与 CRUD](./11-crud-database.md)。

## 6. 保留名与诊断可见性

| 保留物 | 值 | 撞上会怎样 |
|---|---|---|
| ctx 字段 | `method` `path` `requestId` `body` `params` `qs` `headers` `route` … | `ctx.extend` 报错 |
| 路由前缀 | `/uploads`、`/__debug` | 启动期报错 |
| 服务名 | `config` `log` `httpServer` `wsConnections`、`@actor/…` | 声明层报错 |

debug 可见性作用域（**只减少信息面，不是安全边界**）：全局 / 模块 / 控制器三层 ——
见 [18 可观测与上线](./18-observability-deploy.md)。

## 7. 跑一遍（CI 真执行）

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
// 命名空间变量刻意不叫 `app`/`web`：文档门禁会把 `appLayer.defineApp` 当成"内核 app 的成员访问"去核对
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);

// ① 短名 = 规范名（同一对象，不是包装函数）
assert.strictEqual(appLayer.app, appLayer.defineApp);
assert.strictEqual(appLayer.config, appLayer.defineConfig);
assert.strictEqual(appLayer.module, appLayer.defineModule);
assert.strictEqual(webLayer.controller, webLayer.defineController);
assert.strictEqual(webLayer.webPlugin, webLayer.defineWebPlugin);

// ② 配置值即 schema：与全量写法逐字段相等
const sugared = appLayer.defineConfig({ port: 3000, nested: { retries: 3 } });
const verbose = appLayer.defineConfig({ port: { type: 'number', default: 3000 }, nested: { retries: { type: 'number', default: 3 } } });
assert.deepStrictEqual([...sugared.fields.entries()], [...verbose.fields.entries()]);
assert.deepStrictEqual(sugared.schema, verbose.schema, 'schema 也要一致（简写原地展开）');

// ③ 输入声明合一：字符串别名展开 + 自动补 body + from 保留
const spec = webLayer.defineController({
  input: { title: 'string', size: 'int', id: { from: 'params', type: 'string' } },
  handle: () => undefined,
});
assert.deepStrictEqual(spec.input, { title: { type: 'string' }, size: { type: 'number' }, id: { type: 'string' } });
assert.deepStrictEqual(spec.body, ['title', 'size'], '不带 from 的输入默认来自 body');
assert.deepStrictEqual([...webLayer.inputSourcesOf(spec)], [['title', 'body'], ['size', 'body'], ['id', 'params']]);
assert.throws(() => webLayer.defineController({ input: { x: 'strng' }, handle: () => 1 }), /不认识/);

// ④ 中间件阶段简写 = 对象写法（**真跑一遍**看执行顺序）
//    `orderMiddleware` 返回的是原始函数，所以要比"执行顺序"而不是函数属性
const runChain = async (chain) => {
  const trace = [];
  const tag = (label) => async (_ctx, next) => { trace.push(label); return next(); };
  const ordered = webLayer.orderMiddleware(
    chain.map((step) => (typeof step === 'function' ? step(tag) : { ...step, handler: tag(step.label) })),
  );
  for (const step of ordered) await step({}, async () => undefined);
  return trace;
};
// 简写写法（阶段即函数名）与全量写法（{ handler, phase }）声明顺序故意打乱，看排序后是否一致
const sugaredOrder = await runChain([
  (tag) => webLayer.atPost(tag('post')),
  (tag) => webLayer.atPre(tag('pre')),
  (tag) => webLayer.atAuth(tag('auth')),
]);
const verboseOrder = await runChain([
  { phase: 'post', label: 'post' },
  { phase: 'pre', label: 'pre' },
  { phase: 'auth', label: 'auth' },
]);
assert.deepStrictEqual(sugaredOrder, verboseOrder, '简写与全量写法产出同一执行顺序');
assert.deepStrictEqual(sugaredOrder, ['pre', 'auth', 'post'], '顺序由框架保证（与声明顺序无关）');

// 简写不能改坏原函数（不挂属性、不动 name）
const original = () => undefined;
const wrapped = webLayer.atAuth(original, 'auth-mw');
assert.strictEqual(wrapped.name, 'auth-mw', 'name 只用于诊断显示');
assert.strictEqual(original.phase, undefined, '原函数不被动过');

// ⑤ 工厂：五条路由 + 乐观锁参数自动声明 + health
const store = { list: () => [], get: () => null, create: () => ({}), update: () => ({}), remove: () => true };
const routes = webLayer.crudRoutes('/notes', store, { fields: { title: 'string' } });
assert.deepStrictEqual(
  routes.routes.map((entry) => `${String(entry[0])} ${String(entry[1]).split('?')[0]}`),
  ['GET /notes', 'GET /notes/:id', 'POST /notes', 'PUT /notes/:id', 'DELETE /notes/:id'],
);
const put = routes.routes.find((entry) => String(entry[0]) === 'PUT');
assert.strictEqual(put[2].input.expectedVersion.required, false, 'PUT 自动声明乐观锁参数（可选）');
assert.ok(webLayer.healthRoutes().routes.some((entry) => String(entry[1]) === '/health'));

// ⑥ 保留名清单是导出的（文档与门禁都读它）
assert.ok(webLayer.RESERVED_ROUTE_PREFIXES.includes('/uploads'));
assert.ok(appLayer.RESERVED_SERVICE_NAMES.includes('httpServer'));
console.log('ok');
```

## 8. 相关

- 路由/校验/错误的完整用法 → [10 路由与请求](./10-http-routing.md)
- CRUD + 数据库（含乐观锁 409）→ [11 数据与 CRUD](./11-crud-database.md)
- 设计决策与"设计 vs 实现"对照 → [internals/17-app-sugar](./internals/17-app-sugar.md)

## 下一步


- [10 路由与请求](./10-http-routing.md)
- [11 数据与 CRUD](./11-crud-database.md)
