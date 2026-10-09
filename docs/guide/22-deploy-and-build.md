# 22. 部署与构建：直跑 `.ts` 还是编译成 JS

**你会得到**：把服务部署到服务器的两条完整路线（直跑 / 编译产物），以及"我该选哪条"的判断法。
**前置**：能跑起一个项目（[01 五分钟上手](./01-quickstart.md)）。
**耗时**：10 分钟读完；照做约 5 分钟。

这一页回答一个很多人第一次接触本框架会问的问题：**别人的框架都要先编译成 JS 再上线，我们直接 `node main.ts` 跑服务器，合理吗？**

## 1. 为什么可以直跑（不是"偷懒"，是有依据的）

- **Node ≥ 24 原生剥离类型**：`.ts` 里的类型标注会被运行时的类型剥离去掉，直接执行 —— 不需要 tsc、不需要打包器。
- **框架保证源码"可剥离"**：`tsconfig` 开了 `erasableSyntaxOnly`，所以仓库里**没有** `enum`、`namespace`、
  参数属性（`constructor(private x)`）这类需要真实转译的语法；也**没有装饰器**（Node 原生与
  `--experimental-transform-types` 都不支持装饰器，所以本框架的主线 API 刻意不用装饰器 ——
  这是设计取舍，不是遗漏，细节见 [internals/00 脚手架与工具链](./internals/00-scaffold.md)）。
- **代价必须说清**：**运行时不做类型检查**。CI 里必须跑 `npm run typecheck`（`tsc --noEmit`），
  否则类型错误会一路走到线上。

## 2. 什么时候**必须**编译

| 情况 | 为什么 |
|---|---|
| 目标环境 Node < 24 | 老 Node 不认识 `.ts`，只能跑 `.js` |
| 要作为**库**发给别人用 | 消费者不该被强制升 Node（见下一节"包怎么发"） |
| 生产有 APM / 打包 / 体积要求 | 这些工具链通常只认 `.js` 与 sourcemap |
| 需要 sourcemap 直接对应到 JS 行号 | 事故复盘时与工具链对齐 |

其他情况（内部服务、单机、容器里同时带源码、团队接受 Node ≥ 24）**直跑更省事**：少一个构建阶段、少一份产物、少一处"忘了重新构建"。

## 3. 路线 A：直跑（默认）

```bash
node main.ts            # 开发/自托管：直接跑
npm run dev             # 同上，带 --watch 自动重启
```

生产建议同时打开 Node 的**编译缓存**（重复启动更快；应用越大收益越明显）：

```ts
// main.ts 顶部（可选）
import { enableCompileCache } from 'node:module';
enableCompileCache();
```

容器里就是单阶段镜像（脚手架已生成 `Dockerfile.direct`）：

```bash
docker build -f Dockerfile.direct -t my-app:direct .
docker run --rm -p 9000:9000 -e NODE_ENV=production my-app:direct
```

## 4. 路线 B：编译成 JS（脚手架已内置）

```bash
npm run build           # tsc -p tsconfig.build.json && node scripts/copy-assets.mjs
npm run start:prod      # node dist/main.js
npm run smoke:prod      # 起一次产物、打 /health，退出码 0/1（部署流水线用）
```

`tsconfig.build.json` 里两个关键点：

- **`rewriteRelativeImportExtensions: true`**：本框架的源码约定了写 `./x.ts`
  （`allowImportingTsExtensions`），编译时必须改写成 `./x.js`，否则产物 `ERR_MODULE_NOT_FOUND`；
- **`sourceMap: true`**：线上报错能定位回源码。产物里不含 `.ts`，也不需要把源码带上服务器。

还有一个**最常见的坑**：`main.ts` 用 `import.meta.url` 定位配置目录，编译后 `dist/main.js` 会去找
`dist/config` —— 所以 `npm run build` 里带了 `scripts/copy-assets.mjs`，把 `config/` 里的**非 TS 资产**
（JSON、模板、证书、SQL…）拷进 `dist/`。忘了这一步的典型症状是启动时报"配置目录不存在"。

多阶段镜像（脚手架已生成 `Dockerfile`）：

```bash
docker build -t my-app:compiled .
docker run --rm -p 9000:9000 -e NODE_ENV=production my-app:compiled
```

## 5. 怎么检查"产物没问题"（部署流水线的三道门）

```bash
npm run typecheck       # ① 类型：运行时不做，CI 必须做
npm run build           # ② 构建
npm run smoke:prod      # ③ 冒烟：真起产物、真打 /health
```

`actor doctor` 也会看这一节：

| 情况 | 提示 |
|---|---|
| 还没有 `dist/` | ✓（走直跑路线本来就不需要；要构建就 `npm run build`） |
| `dist` 比源码**旧** | ✗ `dist 比源码旧（src/module.ts 更新于产物之后）` → 重新构建（部署前务必，否则上线的是旧代码） |
| `dist/config` 缺非 TS 资产 | ✗ 报出缺哪个文件 → 跑一次 `npm run build`（会执行资产拷贝） |

## 6. 两条路的行为必须一致（这是框架自己的门禁）

"直跑和编译产物跑起来不一样"是这套双轨制最危险的地方。仓库里有门禁盯着它：
同一个脚手架项目，**直跑 `main.ts` 与 `node dist/main.js` 分别起一次，打同一组请求
（含校验失败 400、404、405、乐观锁 409），断言状态码完全相同**；
另外还断言产物里没有残留 `.ts` 引用、`smoke:prod` 真的打到了 `/health`。

## 7. 跑一遍（CI 真执行）

下面这段验证"编译 JS 这条路真的成立"：在临时目录里造一个最小的"用 `.ts` 扩展名导入"的项目，
用 `rewriteRelativeImportExtensions` 编译，产物必须能跑。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-build-'));

try {
  // 源码里刻意写 `./dep.ts`（本框架的约定），编译后必须是 `./dep.js`
  // `"type": "module"` 让产物保持 ESM（脚手架项目就是 ESM）
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'dep.ts'), 'export const answer: number = 42;\n');
  fs.writeFileSync(
    path.join(dir, 'main.ts'),
    ["import { answer } from './dep.ts';", 'console.log(`answer=${answer}`);', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          noEmit: false,
          outDir: 'dist',
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );

  // 用仓库里的 tsc（示例块在临时目录里执行，npx 解析不到 typescript）
  const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  await run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: dir });
  const emitted = fs.readFileSync(path.join(dir, 'dist', 'main.js'), 'utf8');
  assert.match(emitted, /from '\.\/dep\.js'/, '`./dep.ts` 必须被改写成 `./dep.js`，否则产物跑不起来');
  assert.ok(!emitted.includes('./dep.ts'), '产物里不能残留 .ts 引用');

  const { stdout } = await run(process.execPath, ['dist/main.js'], { cwd: dir });
  assert.strictEqual(stdout.trim(), 'answer=42', '编译产物必须真的能跑');
  console.log('ok: ./dep.ts → ./dep.js，产物可运行');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
```

> 整条脚手架链路（`npm run build` → 起 `dist/main.js` → `/health` 200 → 直跑与产物行为一致 →
> 产物无 `.ts` 残留）在仓库门禁 `test/unit-build-path.test.js` 里每次都会真跑一遍。

## 8. 选型速查

| 你的情况 | 选 |
|---|---|
| 内部服务 / 单机 / 团队接受 Node ≥ 24 | **直跑**（`node main.ts`，镜像用 `Dockerfile.direct`） |
| 目标环境 Node < 24、要发 npm 包、有 APM/打包约束 | **编译**（`npm run build` + `npm start:prod`，镜像用 `Dockerfile`） |
| 不确定 | 先直跑；等遇到上面任意一条再切编译 —— **切换成本很低**（一条 `npm run build`，源码不用改） |

## 9. 接下来

- 生产清单（信号处理、优雅停机、诊断路由、日志）→ [18 可观测与部署](./18-observability-deploy.md)
- 错误出口与日志出口 → [20 错误与日志](./20-errors-and-logging.md)
- 自定义命令 / 生成器（部署脚本里常用）→ [21 CLI 进阶](./21-cli-generate-and-commands.md)
