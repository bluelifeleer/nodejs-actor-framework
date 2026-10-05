# M1 设计：配置 + 装配（应用层）

> 决策前提（用户已确认）：路线 **B 完备框架**；第一层做**配置 + 装配**；
> **用户项目不得直接暴露内核**（要有 `config/`、`router/`、启动入口等骨架）。

## 1. 分层与包边界（这是"不暴露内核"的硬保证）

```
packages/core      内核（现状，保持不变）：Actor/邮箱/监督/集群/持久化/可观测/worker
packages/app       ← M1 新增：配置、装配/DI、模块、插件 SDK、生命周期
packages/web       ← M2：路由、控制器、HTTP/WS 接入（无状态控制器为默认）
packages/data      ← M3：数据模型与演进
packages/cli       ← 可选：actor run / actor new
packages/testkit   ← 可选：测试工具（testApp、假时钟、内存后端）
```

三条规则（用测试强制执行，不靠约定）：

1. **用户项目只依赖 `@actor/app`（+ 按需 `@actor/web` 等），永不 import `@actor/core`**；
2. `@actor/app` **不 re-export 内核内部类型**（`ActorSystem`/`Mailbox`/`ActorCell` 等一律不出现在应用层签名里）；
3. 内核仍可**独立使用**（现有 30 个导出不动，`createSystem` 仍是低层入口）——应用层是它的上层消费者。

落地方式：`packages/app` 的 `package.json` 依赖 `@actor/core`（`workspace:*`），用户项目不依赖 core；
再加一条**导入面守卫测试**：扫描示例应用的源码，禁止出现 `@actor/core` 或深路径 `packages/core/src/**`。

## 2. 目标项目骨架（用户新建项目长这样）

```
my-app/
├── config/
│   ├── default.ts          # 默认值 + 校验规则（类型化，零构建直接跑）
│   ├── development.ts      # 环境覆盖（可选）
│   └── production.ts
├── src/
│   ├── actors/             # 业务 Actor：普通类/普通函数，无继承（见 §4）
│   ├── services/           # 可注入服务（provider）
│   ├── router/             # 路由/控制器声明（M2 落地，M1 先留目录与类型）
│   ├── plugins/            # 用户自定义插件
│   ├── module.ts           # defineModule：声明 actors/providers/plugins/routes
│   └── app.ts              # 装配：defineApp({ modules, config, plugins })
├── main.ts                 # 启动入口：createApp(app).start()
├── test/
└── package.json            # 依赖 @actor/app（不含 @actor/core）
```

## 3. 用户可见 API（应用层，全部来自 `@actor/app`）

```ts
// config/default.ts —— 用户可配置（schema + 默认值 + 校验）
export default defineConfig({
  tickMs: { type: 'number', default: 200, min: 16 },
  roomSize: { type: 'number', default: 50 },
  gateway: { url: { type: 'string', default: 'tcp://127.0.0.1:9000' } },
});

// src/actors/player.ts —— 普通类，无继承、无框架基类
export class PlayerService {
  constructor(private deps: { config: AppConfig; log: Logger }) {}
  onStart(state: PlayerState) { /* ... */ }
  onMessage(msg: PlayerMsg, ctx: ActorCtx) { /* ... */ }
}

// src/module.ts —— 装配声明
export default defineModule({
  name: 'game',
  actors: { Player: PlayerService },          // 框架负责 spawn / 监督 / 持久化
  providers: {           // DI：依赖按名字解析，工厂函数拿到已解析的依赖
    leaderboard: ({ actors, config }) => new Leaderboard(actors.Room, config.roomSize),
  },
  plugins: [myPlugin({ /* ... */ })],
});

// main.ts —— 启动入口
import app from './src/app';                  // defineApp({ modules: [game] })
const application = createApp(app);
await application.start();                    // 配置校验 → 装配 → spawn → 就绪
process.on('SIGTERM', () => application.stop({ timeoutMs: 10_000 }));
```

**内核不可见**：上面全部类型（`AppConfig`/`Logger`/`ActorCtx`/`ActorRef` 别名）都由 `@actor/app` 提供，
用户不需要（也不能）接触 `ActorSystem`、`Mailbox`、`Supervision` 等内核概念。

## 4. 配置语义（用户可配置）

| 项 | 设计 |
|---|---|
| 声明 | `defineConfig({ key: { type, default, min/max/regex, secret? } })`，嵌套对象支持 |
| 分层（后者覆盖前者） | ① schema 默认值 → ② `config/default.ts` → ③ `config/<APP_ENV>.ts` → ④ 环境变量 → ⑤ 启动参数 |
| 环境变量映射 | `APP_TICK_MS` → `tickMs`（前缀可配；嵌套用 `__`：`APP_GATEWAY__URL`） |
| 校验时机 | `start()` 最先执行；失败即**启动失败**并打印**全部**错误（不吐半截） |
| 访问 | 依赖注入（`deps.config`）或 `app.config.get('tickMs')`；**只读** |
| 机密 | `secret: true` 的键在日志/诊断中一律打码；`app.config.redacted()` 供运维查看 |
| 类型 | 从 schema 推导的 TS 类型（用户写 `config.tickMs` 有补全） |

## 5. 装配 / DI 语义

| 项 | 设计 |
|---|---|
| 模块 | `defineModule({ name, imports?, providers?, actors?, plugins?, routes?, onStart?, onStop? })` |
| 依赖解析 | **按名字**在模块图内解析（含 `imports` 引入的模块）；未知依赖 → 启动失败并指出"谁要什么、哪里没有" |
| 循环依赖 | 启动时检测，报出环路径，**不**做静默降级 |
| Provider | 工厂函数 `(deps) => value`；默认**单例**（每个 app 一份）；可选 `{ scope: 'transient' }` |
| Actor 句柄 | `actors.Player` → `ActorRef`（本地或远程由内核决定，应用层不感知） |
| 生命周期 | `start()`：配置校验 → 插件 setup → provider 实例化（懒惰 + 按需）→ 模块 `onStart` → spawn actors；`stop()` 逆序，**有界**（`timeoutMs`，超时记录仍在忙的 actor） |
| 退出码 | 启动失败 → 非零退出并给出可操作信息；`stop()` 幂等 |
| 逃生通道 | `app.kernel` 暴露内核（文档标注"高级/非必要"，应用层签名不依赖它） |

## 6. 插件 SDK（用户自定义插件）

```ts
export default definePlugin({
  name: 'metrics-to-datadog',
  config: { apiKey: { type: 'string', secret: true } },
  setup(app, config) { /* 注册钩子、订阅事件 */ },
  teardown(app) { /* 释放资源 */ },
});
```
- `setup` 在 provider 之前、`teardown` 在模块 `onStop` 之后（与内核插件顺序一致）；
- 内置能力（cluster/metrics/tracing/deadLetters/rateLimit）在应用层包装成**内置插件**，
  用户在 `defineApp({ plugins })` 里显式启用，而不是被自动挂上（这也顺带解决"加载面 32 个模块"的问题）。

## 7. 验收标准（M1 出口，全部可跑）

1. **示例应用** `examples/app-minimal/`：具备 §2 的骨架，**只 import `@actor/app`**；
2. **导入面守卫测试**：扫描该示例（及后续示例）源码，出现 `@actor/core` 或 `packages/core/src` 即测试失败；
3. **配置测试**：默认值 / 环境覆盖 / 校验失败（含多条错误一次性报出）/ secret 打码；
4. **装配测试**：依赖解析成功与失败（未知依赖、循环依赖）、生命周期顺序、`stop()` 有界且幂等；
5. **不回归**：现有 281 个用例保持全绿；内核可独立使用（现有 README 的 `createSystem` 用法不改）；
6. **文档**：`docs/design/02-config-di-plugins.md` 更新为"已实现"状态，并给出 5 分钟上手（骨架 + 三段代码）。

## 8. 待你确认（这几项定了我再动代码）

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| A1 | 包名 | ① `@actor/app`、`@actor/web`（作用域包，边界最强）② `nodejs-actor-framework/app`（单包子路径，发布简单） | **①**：边界靠包而不是靠约定；monorepo 已就绪 |
| A2 | 配置格式 | ① TS 优先（类型化、零构建）② TS + JSON/YAML | **① + JSON 兜底**（YAML 不引依赖） |
| A3 | CLI | ① M1 就做 `npx actor run/new` ② M5 再做 | **②**：先把运行时 API 做对，CLI 只是壳 |
| A4 | `main.ts` 里是否允许 `createApp().start()` | ① 允许（显式、可测）② 必须走 CLI | **①**（CLI 之后包装它） |
| A5 | Actor 定义风格 | ① 普通类 + 生命周期方法名约定（`onStart/onMessage/onStop`）② 函数式优先 | **① 为主、② 为辅**（无继承是无侵入的关键） |
