# API 参考（从源码生成）

完整导出清单在这里（构建文档站时自动生成，不手抄）：

- **[API 参考](../../../api.html)** —— 每个包的导出名、签名与注释摘要
  （本地开发时：`npm run docs:serve` 之后打开 <http://127.0.0.1:4321/api.html>）

按包分节，覆盖 `nodejs-actor-framework`（内核）与 `@actor/app` `@actor/web` `@actor/data`
`@actor/resource` `@actor/db-core` `@actor/db` `@actor/redis` `@actor/mongodb` `@actor/mail`。

> 生成方式（`tools/docs-site.mjs` + `tools/api-extract.mjs`）：**从源码/手写 `.d.ts` 提取**，
> 所以它不会"文档说有、代码里没有"。内核多数文件带 `@ts-nocheck`（类型未补齐），
> 所以那一节只列导出名 + 注释摘要，并在页面上**如实标注**——不假装完整。

## 找不到名字时怎么办

| 你想找 | 去哪 |
|---|---|
| 某个函数/类型的签名与注释 | [API 参考](../../../api.html)（搜名字） |
| "我该用哪个"（任务视角） | [文档首页](../README.md) 的「按任务查」 |
| 为什么这么设计 | [`docs/design/`](../../design/) |
| 报错怎么修 | [排错手册](../19-troubleshooting.md) |

## 公开面是有门禁的（所以 API 参考可信）

这套仓库里，"公开面"不是靠自觉维护的：

- **运行时导出基线**（`test/unit-package-surfaces.test.js`）：每个包的导出名字被钉住，**只允许增加** ——
  重构时忘了 re-export 会立刻红；
- **类型覆盖检查**（`npm run release:check` / `unit-kernel-surface`）：每个运行时导出都必须有类型声明；
- **文档成员检查**（`test/types/documented-members.mts`）：文档里用到的公开成员真的存在、类型说得通。

## 自己跑一遍（CI 真执行）

下面这段断言"API 参考覆盖了本章提到的四个常用入口"——这样"文档与公开面分叉"会红。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
// 命名空间变量刻意不叫 `app`/`web`：文档门禁会把 `appLayer.defineApp` 当成"内核 app 的成员访问"去核对
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);

// 本章/主线文档反复提到的入口，必须在公开面上
for (const name of ['createApp', 'defineApp', 'defineModule', 'definePlugin', 'defineConfig', 'runApp']) {
  assert.strictEqual(typeof appLayer[name], 'function', `@actor/app 应当导出 ${name}`);
}
for (const name of ['defineController', 'defineRoutes', 'httpPlugin', 'crudRoutes', 'healthRoutes', 'debugPlugin']) {
  assert.strictEqual(typeof webLayer[name], 'function', `@actor/web 应当导出 ${name}`);
}

// 短名与规范名是**同一个对象**（别名不是包装函数）
assert.strictEqual(appLayer.app, appLayer.defineApp);
assert.strictEqual(appLayer.module, appLayer.defineModule);
assert.strictEqual(appLayer.config, appLayer.defineConfig);
assert.strictEqual(webLayer.controller, webLayer.defineController);

// 保留名清单是导出的（文档与门禁都读它）
assert.ok(Array.isArray(webLayer.RESERVED_ROUTE_PREFIXES) && webLayer.RESERVED_ROUTE_PREFIXES.includes('/uploads'));
assert.ok(Array.isArray(appLayer.RESERVED_SERVICE_NAMES) && appLayer.RESERVED_SERVICE_NAMES.includes('httpServer'));
console.log('ok');
```
