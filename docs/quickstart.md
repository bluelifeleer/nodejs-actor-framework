# 5 分钟上手

> 用户项目只依赖 `@actor/app`，**不接触内核**（`nodejs-actor-framework`）。
> 边界由测试强制：示例目录里出现内核包名即测试失败。

## 1. 项目骨架

```
my-app/
├── config/default.ts       # defineConfig：默认值 + 校验 + 类型
├── src/
│   ├── actors/             # 业务 Actor（普通类/普通函数，无继承）
│   ├── plugins/            # 用户自定义插件（可选）
│   ├── module.ts           # defineModule：声明 actors / providers / 启停钩子
│   └── app.ts              # defineApp：把配置、模块、插件组装成应用
└── main.ts                 # 启动入口：createApp(app).start()
```

## 2. 三段代码

```ts
// config/default.ts —— 用户可配置：schema 就是默认值与校验规则
import { defineConfig } from '@actor/app';
export default defineConfig({
  step: { type: 'number', default: 1, min: 1 },
  token: { type: 'string', default: '', secret: true },   // 日志/诊断中自动打码
});
```

```ts
// src/actors/counter.ts —— 普通类，无继承；依赖由框架注入
import type { AppDeps } from '@actor/app';
export class Counter {
  deps: AppDeps;
  count = 0;
  constructor(deps: AppDeps) { this.deps = deps; }
  receive(msg: { type: 'add'; by?: number }): number {
    if (msg.type === 'add') this.count += msg.by ?? this.deps.config.get<number>('step');
    return this.count;
  }
}
```

```ts
// src/module.ts + src/app.ts + main.ts
import { createApp, defineApp, defineModule, metricsPlugin } from '@actor/app';
import config from '../config/default.ts';
import { Counter } from './actors/counter.ts';

const counterModule = defineModule({ name: 'counter', actors: { Counter } });
const app = defineApp({ config, modules: [counterModule], plugins: [metricsPlugin()] });

const application = createApp(app, { configDir: new URL('./config', import.meta.url).pathname });
await application.start();                                   // 配置校验 → 装配 → spawn → 就绪
console.log(await application.actor('Counter').ask({ type: 'add' }));
process.on('SIGTERM', () => void application.stop({ timeoutMs: 10_000 }));
```

运行（Node 直接跑 TypeScript，**零构建**）：

```bash
node main.ts
APP_STEP=5 node main.ts                     # 环境变量覆盖配置（camelCase → UPPER_SNAKE）
```

## 3. 三个关键约定

| 约定 | 说明 |
|---|---|
| **配置分层** | schema 默认值 < `config/default.*` < `config/<APP_ENV>.*` < 环境变量 < 显式 overrides；启动时**一次性报出全部问题** |
| **依赖按名解析** | provider 用 `{ deps, factory }`；未知依赖与循环依赖在 `start()` 立即报错（带请求者） |
| **能力显式启用** | `plugins: [...]` 里声明什么才装什么（自定义插件与内置能力同一条路） |

## 4. 生命周期（顺序固定）

```
start: 收集模块/插件 → 合并配置 schema 并加载校验 → 插件 setup(声明顺序)
       → provider 解析 → 建内核 + spawn Actor → 模块 onStart → 保持进程存活
stop : 模块 onStop(逆序) → 内核停止 → 插件 teardown(逆序) → provider dispose(逆序) → 释放
```

`start()` 之后应用会一直运行，直到 `stop()`——用户不需要自己挂空定时器。

## 5. 可跑的完整示例

[`examples/app-minimal/`](../examples/app-minimal/README.md)：配置覆盖、provider 注入、
自定义插件、内置能力、优雅退出，并有端到端测试守护。

## 6. 下一步

- 路由与控制器（M2）：无状态控制器为默认，`ctx.actor(name)` 是唯一桥梁；
- 数据模型与演进（M3）；集群与运维（M4）。
