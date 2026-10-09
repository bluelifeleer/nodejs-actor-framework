# 14. 配置与密钥：分层、环境变量、校验

**你会得到**：配置分层与覆盖顺序、环境变量命名、`secret: true` 到底做了什么、校验规则

**前置**：项目里有 `config/default.ts`　**耗时**：12 分钟

## 1. 配置只有一个入口：`defineConfig`

```ts
// config/default.ts
import { defineConfig } from '@actor/app';

export default defineConfig({
  dataDir: './data',                     // 简写：值即 schema（= { type: 'string', default: './data' }）
  tickMs: { type: 'number', default: 200, min: 16 },   // 显式声明：要校验/必填/打码时这样写
  gateway: {                             // 普通对象 = 分组（点号路径 gateway.url）
    url: 'tcp://127.0.0.1:9000',
    token: { type: 'string', secret: true, default: '' },   // secret：诊断/日志里打码
  },
  features: ['a'],                       // 数组 = json（库里/环境变量都当 JSON 处理）
});
```

读取：控制器里 `ctx.config.get<T>('gateway.url')`，provider 里 `deps.config.get(...)`。

## 2. 覆盖顺序（后者盖前者）

```
schema 默认值  →  config/default.*  →  config/<APP_ENV>.*  →  环境变量  →  overrides（测试用）
```

- `APP_ENV`（或 `NODE_ENV`）决定第二层文件：`APP_ENV=production` → 读 `config/production.ts|json`；
- **只认声明过的键**：配置文件里写个拼错的键 → 启动期报错（`未知配置项（来自 config/default.json，拼写错误？）`）；
- 校验**一次性报出全部问题**（不是遇到第一个就停）。

## 3. 环境变量命名规则

```
camelCase 字段     →  APP_UPPER_SNAKE
嵌套（点号路径）    →  用 __ 分隔

tickMs            →  APP_TICK_MS
gateway.url       →  APP_GATEWAY__URL
plugins.http.port →  APP_PLUGINS__HTTP__PORT     ← 插件配置也走同一套
```

类型转换是自动的：`'4000'` → `4000`，`'true'/'1'/'yes'/'on'` → `true`，JSON 字段解析成对象/数组。

| 你想要的 | 怎么做 |
|---|---|
| 改端口 | `APP_PLUGINS__HTTP__PORT=8080` |
| 换数据目录 | `APP_DATA_DIR=/var/lib/my-app` |
| 给密钥 | `APP_JWT_SECRET=…`（**只从环境变量给，别写进 default.ts**） |
| 生产专用值 | `config/production.ts` + `APP_ENV=production` |
| 测试里固定值 | `createApp(spec, { overrides: { ... } })` |

> 为什么不把密钥写在 `config/default.ts`：那个文件会进版本库。
> 写在 env 里，另配 `.env.example` 说明需要哪些（框架**不读 `.env`**，交给你的启动脚本/编排平台）。

## 4. `secret: true` 做了什么

```ts
const config = ...;
config.all();        // 真实值（应用内部用）
config.redacted();   // secret 字段变成 '***'（诊断/日志用）
config.sources;      // ['config/default.ts', 'env:APP_TICK_MS', 'overrides'] —— 排查"这值哪来的"
```

`debugPlugin` 的 `/__debug/config` 只输出**形状**（每个键的类型 + 是否等于默认值），**值一律打码**——
所以它即使被打开也拿不到密钥。但默认它还是关的（见 [18 可观测与上线](./18-observability-deploy.md)）。

## 5. 必填与"部分更新"

```ts
defineConfig({
  dsn: { type: 'string' },                  // 不给 default = **必填**（没给就拒绝启动）
  optional: { type: 'string', required: false },   // 可缺省：没给就跳过（不塞 undefined 进结果）
});
```

`required: false` 也是控制器**部分更新**（PUT/PATCH）实现"只校验给了的字段"的机制。

## 6. 校验规则表

| 字段 | 作用 | 例子 |
|---|---|---|
| `type` | `string` / `number` / `boolean` / `json` | `{ type: 'number' }` |
| `default` | 有默认值即非必填 | `{ type: 'number', default: 20 }` |
| `required: false` | 显式可缺省（默认必填） | 部分更新字段 |
| `min` / `max` | 数字范围 | `{ type: 'number', min: 1, max: 100 }` |
| `regex` | 字符串格式 | `{ type: 'string', regex: '^[a-z]+$' }` |
| `enum` | 取值白名单 | `{ type: 'string', enum: ['dev', 'prod'] }` |
| `secret` | 打码（脱敏） | token/密码/密钥 |
| `nullable` | 允许显式 null | 可空的可选值 |

## 7. 跑一遍（CI 真执行）

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const { defineConfig, loadConfig, ConfigValidationError } = await import(`${repo}packages/app/src/index.ts`);

// ① 简写 + 全量混用：产出同一份字段表
const definition = defineConfig({
  dataDir: './data',
  port: { type: 'number', default: 9000, min: 1, max: 65535 },
  gateway: { url: 'tcp://127.0.0.1:9000', token: { type: 'string', secret: true, default: '' } },
  features: ['a'],
});
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-config-'));
fs.writeFileSync(path.join(configDir, 'default.json'), JSON.stringify({ port: 9001 }));
fs.writeFileSync(path.join(configDir, 'production.json'), JSON.stringify({ port: 9443 }));

try {
  // ② 覆盖顺序：默认值 < default.json < 环境变量 < overrides
  const dev = await loadConfig(definition, {
    configDir,
    env: { APP_DATA_DIR: '/tmp/data-from-env' },
    overrides: { gateway: { url: 'tcp://override:1' } },
  });
  assert.strictEqual(dev.get('dataDir'), '/tmp/data-from-env', '环境变量盖过 schema 默认值');
  assert.strictEqual(dev.get('port'), 9001, 'default.json 盖过默认值');
  assert.strictEqual(dev.get('gateway.url'), 'tcp://override:1', 'overrides 优先级最高');
  assert.deepStrictEqual(dev.get('features'), ['a'], '数组（json）原样读回');
  assert.ok(dev.sources.some((item) => item.startsWith('env:')), `sources 要能说清值从哪来：${dev.sources.join(', ')}`);

  // ③ APP_ENV 分层
  const prod = await loadConfig(definition, { configDir, env: { APP_ENV: 'production' } });
  assert.strictEqual(prod.get('port'), 9443, 'production.json 盖过 default.json');

  // ④ secret 打码：redacted() 看不到真实值，all() 看得到
  const withSecret = await loadConfig(defineConfig({ token: { type: 'string', secret: true, default: 's3cr3t' } }), {
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-config-empty-')),
    env: {},
  });
  assert.strictEqual(withSecret.get('token'), 's3cr3t');
  assert.strictEqual(withSecret.redacted()['token'], '***', 'redacted() 里必须打码');
  assert.strictEqual(withSecret.all()['token'], 's3cr3t', 'all() 给应用内部用，是真值');

  // ⑤ 校验：一次性报出**全部**问题（不是遇到第一个就停）
  await assert.rejects(
    () =>
      loadConfig(defineConfig({ a: { type: 'number', min: 10 }, b: { type: 'string' } }), {
        configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'doc-config-bad-')),
        env: { APP_A: '1' },     // 小于 min
      }),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      const paths = error.issues.map((issue) => issue.path).sort();
      assert.deepStrictEqual(paths, ['a', 'b'], `两个问题要一次报出：${JSON.stringify(error.issues)}`);
      return true;
    },
  );

  // ⑥ 未知键（拼错）在启动期就报，不留到运行期
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-config-typo-'));
  fs.writeFileSync(path.join(badDir, 'default.json'), JSON.stringify({ prot: 9000 }));
  await assert.rejects(
    () => loadConfig(defineConfig({ port: { type: 'number', default: 9000 } }), { configDir: badDir, env: {} }),
    /未知配置项/,
  );
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}
console.log('ok');
```

## 8. 相关

- 控制器/插件的输入校验用的是**同一套**字段描述符 → [10 路由与请求](./10-http-routing.md)
- 插件配置进 `plugins.<插件名>.*`，写法同上；设计背景 → [设计：配置/DI/插件](../design/02-config-di-plugins.md)
- 诊断路由为什么拿不到你的密钥 → [18 可观测与上线](./18-observability-deploy.md)

> 配置也支持"值即 schema"的简写（`dataDir: './data'`）。**推荐还是显式声明**（类型、必填、
> 机密一眼可见）；简写的等价性由 [internals/17 应用层语法糖](./internals/17-app-sugar.md) 的门禁保证。

## 下一步


- [18 可观测与上线](./18-observability-deploy.md)
- [22 部署与构建](./22-deploy-and-build.md)
