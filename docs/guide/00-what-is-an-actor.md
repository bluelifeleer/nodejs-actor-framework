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

## 6. 三十秒决策树：用 Actor / 用仓储 / 直接 Express

不用先理解内核，回答四个问题就能分流：

```
问题 1  这段代码里，有没有"两个请求同时来会互相写坏"的状态（读-改-写）？
        │
        ├─ 没有 ─► 问题 2
        └─ 有   ─► 问题 3

问题 2  你是不是只在做"请求进来 → 读写数据库 → 返回"？
        │
        ├─ 是   ─► 直接用 Express / Fastify（不要上 Actor，结构最简单）
        └─ 不是 ─► 用 Actor 装那些内存态（房间、对局、连接、定时任务…）

问题 3  这个状态需要活过重启吗？
        │
        ├─ 不需要（丢了能重建）─► Actor（不配持久化）
        └─ 需要               ─► 问题 4

问题 4  需要跨节点共享（多实例同时读写同一份状态）吗？
        │
        ├─ 不需要 ─► Actor + 快照/事件持久化（本框架一行配置）
        └─ 需要   ─► Actor + 集群 + 共享存储
                     （只有共享存储才能跨节点交接有状态 Actor；
                       连共享存储都不想要，那更适合集中式数据库/外部 KV，而不是 Actor）
```

**更便宜的等价问法**：*"我的读-改-写之间夹着 `await` 吗？"* —— 夹着就是危险区（[下一节](#11-五分钟改造演练把共享计数器搬进-actor) 会把这件事跑给你看）。

## 7. 状态该放哪（判断法）

| 这东西 | 放哪 | 为什么 |
|---|---|---|
| 计数、余额、库存、房间成员、游戏角色 —— **并发写会算错** | **Actor** | 消息串行 → 不用锁也不会算错 |
| 列表、报表、查询 | 仓储 / 投影 | 读多写少，塞进 Actor 只会变成瓶颈 |
| 每请求临时值（当前用户、traceId） | `ctx.state` / `ctx.extend` | 与 Actor 无关 |

判据：**两个请求同时来会互相写坏（读-改-写）就是 Actor**；只是"读出来展示"就是仓储。
展开见 [12 Actor 与状态](./12-actors-state.md)。

## 8. 四条常见误解

| 误解 | 事实 |
|---|---|
| "Actor 是线程/协程" | 不是。Actor 默认跑在**同一进程的同一事件循环**里，串行是**排队**换来的，不是并行 |
| "Actor 就是个队列/任务系统" | 队列只是它的邮箱。Actor 还有私有状态、监督关系、地址（路径）与生命周期 |
| "Actor 就是微服务" | 可以跨进程（本框架支持集群），但**同进程内也成立** —— 它的价值首先是并发正确性，不是拆分部署 |
| "有了 Actor 就不用事务" | 只保证**单个 Actor 内**串行。跨实体的一致性仍要数据库事务/事件溯源/补偿 |

## 9. 什么时候**不要**用它

这部分和"什么时候用"一样重要（[21 CLI 与生成器](./21-cli-generate-and-commands.md) 之类的工具也一样，非破坏性优先）：

- **纯 CRUD / 无状态 BFF**：直接 Express/Fastify 更省事，Actor 只会多一层概念。
- **需要跨实体强一致事务**：数据库事务更直接；Actor 帮不了跨聚合的原子性。
- **读多写少的报表**：走仓储/投影，别把查询塞进 Actor（会把串行世界变成瓶颈）。
- **Handler 里大量 `await` 外部 IO**：这一条最容易被忽略 —— **`await` 期间邮箱会被占住**，
  该 Actor 的后续消息都得排队。所以"Actor 只做决策、慢 IO 放外面/放服务层"是常见用法。
- **单进程内存装不下的状态**：Actor 是内存态 + 持久化，不是分布式 KV。

## 10. 跑一遍：同一件事的三种写法（CI 真执行）

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

## 11. 五分钟改造演练：把共享计数器搬进 Actor

假设你有一个已经在跑的服务（Express 写法，这里为了在 CI 里真跑改用内置 `node:http`，
**逻辑一模一样**）：模块级变量存余额，路由里做"读 → 调外部服务 → 写回"。

```js
let balance = 100;                                   // 模块级共享状态：问题就在这里

// 变量名刻意不叫 `app`：文档里的 `app` 专指框架应用层（`app.defineApp` 等），避免读起来混淆
expressApp.post('/debit', async (req, res) => {
  const current = balance;                           // 读
  await db.update(...);                              // 让出：外部 IO（真实系统里就是这个窗口）
  balance = current - 1;                             // 写回（用的是**自己读到的旧值**）
  res.end(String(balance));
});
```

### 第 1 步：先证明它坏了（别急着改）

20 个并发请求，每个扣 1。期望 100 − 20 = 80，实际 **99** —— 只扣掉了 1 笔，另外 19 笔全被覆盖。

这不是"框架不管"，而是**读-改-写之间夹着 `await`** 的必然结果。注意一个细节：
让出点必须是**真实 IO 那样的宏任务**（`await db.update()` / `setTimeout`）；
只 `await Promise.resolve()`（微任务）在真实 HTTP 请求之间往往**不会**交错 ——
这也是为什么这类 bug 在本地压测时经常"看起来没问题"，上线才丢账。

### 第 2 步：认出这属于 Actor 的状态

回到 [决策树](#6-三十秒决策树用-actor-用仓储-直接-express)：问题 1 是"有并发写会算错的状态吗" → 有；
问题 3 "要活过重启吗" → 要。所以是 **Actor + 持久化**。

### 第 3 步：把状态搬进 Actor（HTTP 层几乎不动）

```ts
const Account = {
  preStart() { this.state = { balance: 100 }; },        // 状态私有：外面拿不到引用
  async receive(msg) {
    const current = this.state.balance;                 // 读
    await db.update(...);                               // 同样"慢 IO"，但消息是**串行**处理的
    this.state.balance = current - msg.amount;          // 写回
    return this.state.balance;
  },
};

// 路由里只剩"发消息"，不再碰状态
expressApp.post('/debit', async (req, res) => {
  res.end(String(await account.ask({ amount: 1 }, 5000)));
});
```

改造的是**状态的位置**，不是 HTTP 层：路由、参数校验、返回结构都不用动。
（换成框架应用层写法就是 `ctx.actor('Account').ask(...)`，见 [12 Actor 与状态](./12-actors-state.md)。）

### 第 4 步：加持久化，重启也不丢

`spawn` 时给 `persistence: { mode: 'snapshot' }`（`events` 模式见 [12](./12-actors-state.md)），
状态就会在重启后恢复 —— 演练的最后一段就是这个断言。

### 第 5 步：跑一遍（CI 真执行）

下面这段把 A（坏）→ B（好）→ C（重启后仍在）三段都跑一遍，断言是确定性的：

```js verify
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const kernel = await import(`${repo}packages/core/src/index.ts`);
const { createSystem } = kernel.default ?? kernel;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const debitOnce = (base) => fetch(`${base}/debit`, { method: 'POST' });
const N = 20;

// ---------- A：改造前（Express 写法的等价物：模块级状态 + 读-改-写夹着 IO）----------
let balance = 100;
// 为了让"20 个请求都先读到旧值"**必然**发生，用一个 gate 模拟"同时到达 + IO 慢"
let arrived = 0;
let release;
const gate = new Promise((resolve) => { release = resolve; });
const before = http.createServer((req, res) => {
  void (async () => {
    if (req.url === '/debit') {
      const current = balance;                 // 读
      arrived += 1;
      if (arrived === N) release();             // 第 20 个到达后放行
      await gate;                               // 让出：真实系统里就是 await db.update()
      balance = current - 1;                    // 写回：用的是各自读到的旧值
      res.end(String(balance));
      return;
    }
    res.end(String(balance));
  })();
});
const beforeBase = await listen(before);
await Promise.all(Array.from({ length: N }, () => debitOnce(beforeBase)));
const broken = Number(await (await fetch(`${beforeBase}/balance`)).text());
await close(before);

// ---------- B：改造后（状态搬进 Actor，路由只发消息）----------
const Account = {
  preStart() { this.state = { balance: 100 }; },
  async receive(msg) {
    const current = this.state.balance;
    await new Promise((resolve) => setTimeout(resolve, 0)); // 同样的"慢 IO"，但消息串行
    this.state.balance = current - msg.amount;
    return this.state.balance;
  },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-'));
const system = createSystem({ logger: false, persistenceDir: dir });
const account = await system.spawn(Account, { id: 'account', persistence: { mode: 'snapshot' } });
const after = http.createServer((req, res) => {
  void (async () => {
    if (req.url === '/debit') {
      res.end(String(await account.ask({ amount: 1 }, 5000)));
      return;
    }
    res.end(String(await account.ask({ amount: 0 }, 5000)));
  })();
});
const afterBase = await listen(after);
await Promise.all(Array.from({ length: N }, () => debitOnce(afterBase)));
const fixed = Number(await (await fetch(`${afterBase}/balance`)).text());
await close(after);
await system.stop();

// ---------- C：重启之后仍在（快照持久化）----------
const system2 = createSystem({ logger: false, persistenceDir: dir });
const account2 = await system2.spawn(Account, { id: 'account', persistence: { mode: 'snapshot' } });
const restored = Number(await account2.ask({ amount: 0 }, 5000));
await system2.stop();
fs.rmSync(dir, { recursive: true, force: true });

assert.strictEqual(broken, 99, `改造前：期望 80，实际 ${broken} —— 19 笔被覆盖`);
assert.strictEqual(fixed, 80, `改造后：20 笔一笔不少（实际 ${fixed}）`);
assert.strictEqual(restored, 80, `重启后仍然是 ${restored}`);
console.log(`before=${broken} after=${fixed} after-restart=${restored}`);
```

### 演练要点

- **改造的是状态的位置，不是 HTTP 层**：路由代码几乎没动，动的是"谁拥有余额"。
- **先复现再改**：第 1 步的 99 比任何解释都有说服力（也顺便说明为什么这类 bug 上线才暴露）。
- **持久化是独立的一步**：它解决的是"重启后还在"，与"并发不丢"是两件事，别混为一谈。

## 12. 接下来

- 想直接上手：[01 五分钟上手](./01-quickstart.md)
- 想知道状态放哪、怎么持久化：[12 Actor 与状态](./12-actors-state.md)
- 想知道内部怎么做到串行、崩溃、恢复：[实现说明](./internals/README.md)
- 想选型（优缺点、边界、替代方案）：[官网首页的「为什么选它 / 什么时候别选」](../../index.html#why)
