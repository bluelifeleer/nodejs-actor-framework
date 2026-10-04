# 迁移 codemod

一次性脚本，用于 M0.1 的模块体系迁移。**改完必须立刻跑全量测试与类型检查**（见下方教训）。

| 脚本 | 作用 |
|---|---|
| `cjs-to-esm-core.py` | core 包（`src` + `test` + `fixtures`）的 CJS 语法 → ESM 语法：静态 `require` → `import`（相对路径补显式扩展名）、`module.exports` → 具名导出 + default（含去重）、`__dirname` → `import.meta.dirname`、含动态 `require` 的文件自动注入 `createRequire` 前导。`--dry` 只报告。 |
| `module-exports-to-esm.py` | 只用括号配对把 `module.exports = {...}` 转成 ESM 导出（`cjs-to-esm-core.py` 已内含该逻辑，保留作对照）。 |
| `cjs-to-esm-core-imports.py` | 只做 import 改写（同上，保留作对照）。 |

## 实测教训（务必遵守）

1. **`packages/core/package.json` 的 `"type": "module"` 作用于该包下所有 `.js`**，包括 `test/**` 与 `test/fixtures/**`。
   所以"src 切 ESM"与"包内测试切 ESM"**必须同一批完成**，否则立刻出现
   `module is not defined` / 具名导入解析失败。
   翻转前校验：`grep -rn "module.exports\|require(" packages/core --include="*.js"` 必须为空。
2. **正则批量加注解/改写会命中调用点**（`this._onData(chunk)`）与**被括号截断**
   （`Buffer.alloc(0)` 里的 `)`），必须区分声明点与调用点，并且每步立刻编译。
3. **具名导出去重**：`module.exports = { X }` 与 `module.exports.X = X` 同时存在时，
   两者都会变成 `export { X }` → `SyntaxError: Duplicate export`。
