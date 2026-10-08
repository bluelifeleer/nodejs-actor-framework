# 0. 什么是 Actor，为什么它值得你换一种写法

这一页讲**模型**（别的页面讲用法）。读完你应该能回答三个问题：
状态为什么不用锁？失败为什么不用 `try/catch` 兜？这套东西**什么时候不该用**？

## 1. 先从一个人人都遇过的问题开始

账户余额 100，两个请求同时各扣 1。你写了这样一段（真实系统里 `await` 那次就是一次查询或网络往返）：

```ts
let balance = 100;
async function debit(amount: number) {
  const current = balance;   // 读：两个请求都读到 100
  await db.get(...);         // 让出：另一个请求插进来
  balance = current - amount; // 改-写：后写的把先写的覆盖掉
}
```

两个请求都读到 100，各自写回 99 —— **扣了两次，余额只少 1**。这就是"读-改-写交错"，
它和语言无关、和框架无关，只要"并发进入 + 中间有让出点"就会发生。常见对策各有代价：

| 对策 | 代价 |
|---|---|
| 加锁 / 串行队列 | 能用，但**互斥要你负责**：漏一处、异常路径没释放、换个入口忘了包，就悄悄回到出错状态 |
| 数据库事务 | 只覆盖一次事务内的操作；跨调用、跨服务、内存态帮不上 |
| 单线程排队（`worker_threads` + 手写 RPC） | 要自己实现消息协议、错误传播、生命周期、重启 |

Actor 模型把"互斥"从一个**你要记得加的装饰**，变成**执行模型本身**。

## 2. Actor 的三条规则

```
        tell / ask                    ┌──────────────────────────┐
   ─────────────────►  ┌────────┐     │  Actor                   │
   外部世界只能发消息   │ 邮箱   │ ──► │  · 自己的状态（别人改不到）│
   （拿不到内部状态）   │ FIFO   │     │  · 一次处理一条消息       │
                       └────────┘     │  · 抛错 = 崩溃，交给监督者 │
                                      └───────────┬──────────────┘
                                                  │ 父 Actor 是监督者
                                    重启 / 升级 / 停止（策略决定）
```

1. **状态私有**：状态只在 Actor 内部（本框架里是 `this.state`）。外面拿不到引用，只能发消息 —— 所以不可能有"别人在我读和写之间插一脚"。
2. **消息串行**：同一个 Actor 的邮箱是 FIFO，**一次处理一条**，处理完才取下一条。所以读-改-写天然是原子的，**不需要锁**。
3. **失败有归属**：handler 抛错不是"记个日志继续"，而是这个 Actor 崩溃，由它的监督者（父 Actor）按策略决定：重启、升级给祖父、或停下。

> 一句话：**Actor = 私有状态 + 串行邮箱 + 明确的失败归属**。三者缺一，就退化成"又一个带状态的对象"。

## 3. 消息只有两种，语义差别很大

| 用法 | 语义 | 失败时 |
|---|---|---|
| `ref.tell(msg)` | 发后不理：不分配 reply、不设定时器 | 你**不会**知道失败；消息进死信队列（可查询、可落盘） |
| `await ref.ask(msg, 超时)` | 请求-响应：有超时、有真实错误 | 抛到你手上（`AskTimeoutError`、handler 的真实错误…） |

**这不是缺陷，是刻意的**：跨进程/跨节点的 `tell` 无法知道对方是否处理成功，
声称"可靠投递"才是骗人。需要知道结果就用 `ask`；不需要就用 `tell` 换吞吐，并去死信里对账。
（HTTP 层同理：`ask` 超时映射 504、找不到 Actor 映射 404，见 [20 错误与日志](./20-errors-and-logging.md)。）

## 4. 顺序保证到哪里为止（必须讲清）

- **同一个 Actor 内**：严格 FIFO，一条处理完再下一条 —— 这是你能依赖的全部顺序。
- **不同 Actor 之间**：**没有**全局顺序。`A` 发给 `B`、`A` 又发给 `C`，`B` 和 `C` 谁先处理完都可能。
- 想跨 Actor 定序，要么用同一个 Actor 收敛（比如订单 Actor 内统一决策），要么在业务层带上序号自己判断。

把它当成"**每个 Actor 是一个独立的串行世界**"，而不是"整个系统一个队列"。

## 5. 失败：为什么"重启出干净实例"比"catch 住继续"更可靠

`try/catch` 兜住异常后，你面对的是一个**状态可能已经写坏一半**的对象，而它还会继续服务后续请求 ——
这类 bug 最难查，因为错误现场早没了。Actor 的选择是相反的：

- handler 抛错 → 该 Actor **崩溃**（并把正在等的 `ask` 立刻用真实错误拒绝，不会让调用方干等）；
- 父 Actor 按监督策略决定：重启用**全新实例**（`preStart` 重新建立状态），或升级；
- 重启强度用尽 → 一路升级到顶层 → `system_failure` 事件 + 如实停机（不会静默放弃）。

代价是"状态会被重置" —— 所以有状态的东西要配**持久化**（`snapshot` / `events` 两种模式，
见 [12 Actor 与状态](./12-actors-state.md)）；没配持久化就接受"重来一次"。

## 6. 状态该放哪（一句话判断法）

| 这东西 | 放哪 | 为什么 |
|---|---|---|
| 计数、余额、库存、房间成员、游戏角色 —— **并发写会算错** | **Actor** | 消息串行 → 不用锁也不会算错 |
| 列表、报表、查询 | 仓储 / 投影 | 读多写少，塞进 Actor 只会变成瓶颈 |
| 每请求临时值（当前用户、traceId） | `ctx.state` / `ctx.extend` | 与 Actor 无关 |

判据：**两个请求同时来会互相写坏（读-改-写）就是 Actor**；只是"读出来展示"就是仓储。
展开见 [12 Actor 与状态](./12-actors-state.md)。

## 7. 四条常见误解

| 误解 | 事实 |
|---|---|
| "Actor 是线程/协程" | 不是。Actor 默认跑在**同一进程的同一事件循环**里，串行是**排队**换来的，不是并行 |
| "Actor 就是个队列/任务系统" | 队列只是它的邮箱。Actor 还有私有状态、监督关系、地址（路径）与生命周期 |
| "Actor 就是微服务" | 可以跨进程（本框架支持集群），但**同进程内也成立** —— 它的价值首先是并发正确性，不是拆分部署 |
| "有了 Actor 就不用事务" | 只保证**单个 Actor 内**串行。跨实体的一致性仍要数据库事务/事件溯源/补偿 |

## 8. 什么时候**不要**用它

这部分和"什么时候用"一样重要（[21 CLI 与生成器](./21-cli-generate-and-commands.md) 之类的工具也一样，非破坏性优先）：

- **纯 CRUD / 无状态 BFF**：直接 Express/Fastify 更省事，Actor 只会多一层概念。
- **需要跨实体强一致事务**：数据库事务更直接；Actor 帮不了跨聚合的原子性。
- **读多写少的报表**：走仓储/投影，别把查询塞进 Actor（会把串行世界变成瓶颈）。
- **Handler 里大量 `await` 外部 IO**：这一条最容易被忽略 —— **`await` 期间邮箱会被占住**，
  该 Actor 的后续消息都得排队。所以"Actor 只做决策、慢 IO 放外面/放服务层"是常见用法。
- **单进程内存装不下的状态**：Actor 是内存态 + 持久化，不是分布式 KV。

## 9. 跑一遍（CI 真执行）

三种写法（裸共享状态 / 共享状态 + 手动串行 / Actor），同一形状的读-改-写、同一个让出点，
20 个并发请求。断言是确定性的：裸共享**必丢**，后两种**必不丢**。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
// 文档的示例块在临时目录里执行，所以这里按**仓库相对路径**导入 CJS 源码：
// 用户项目里写 `const { createSystem } = require('nodejs-actor-framework')`（或 ESM 的具名导入），
// 而直接 import 源码文件时具名导出可能拿不全（CJS 的静态分析限制），所以走 default。
const kernel = await import(`${repo}packages/core/src/index.ts`);
const { createSystem } = kernel.default ?? kernel;
assert.strictEqual(typeof createSystem, 'function');

const N = 20;

// ① 裸共享状态：读 → 让出 → 改-写
let bare = 0;
async function debitBare(amount) {
  const current = bare;
  await Promise.resolve();       // 真实系统里这里是 await db.get() / 网络往返
  bare = current + amount;
}

// ② 共享状态 + 手动串行（把操作排成一条链当锁）
let locked = 0;
let chain = Promise.resolve();
function withLock(task) {
  const next = chain.then(task, task);
  chain = next.then(() => undefined, () => undefined);
  return next;
}
async function debitLocked(amount) {
  const current = locked;
  await Promise.resolve();
  locked = current + amount;
}

// ③ Actor：状态私有 + 消息串行（读-改-写与上面形状完全相同）
const Account = {
  preStart() { this.state = { balance: 0 }; },
  async receive(msg) {
    const current = this.state.balance;
    await Promise.resolve();
    this.state.balance = current + msg.amount;
    return this.state.balance;
  },
};

await Promise.all(Array.from({ length: N }, () => debitBare(1)));
await Promise.all(Array.from({ length: N }, () => withLock(() => debitLocked(1))));

const system = createSystem({ logger: false });
const account = await system.spawn(Account, { id: 'account' });
await Promise.all(Array.from({ length: N }, () => account.ask({ amount: 1 }, 5000)));
const actor = await account.ask({ amount: 0 }, 5000);
await system.stop();

assert.strictEqual(bare, 1, '裸共享状态：20 个并发只留下 1 —— 19 次更新被覆盖');
assert.strictEqual(locked, N, '加互斥就对了，但互斥要你自己保证（漏一处就回到 ①）');
assert.strictEqual(actor, N, 'Actor：消息串行，一条都不丢');
console.log(`bare=${bare} locked=${locked} actor=${actor}`);
```

同一段实验在官网上也是同一份代码（`tools/landing/snippets/04-shared-vs-actor.ts`），
既进 typecheck 又会被真跑 —— 你在页面上看到的数字，是它每次运行的真实输出。

## 10. 接下来

- 想直接上手：[01 五分钟上手](./01-quickstart.md)
- 想知道状态放哪、怎么持久化：[12 Actor 与状态](./12-actors-state.md)
- 想知道内部怎么做到串行、崩溃、恢复：[实现说明](./internals/README.md)
- 想选型（优缺点、边界、替代方案）：[官网首页的「为什么选它 / 什么时候别选」](../../index.html#why)
