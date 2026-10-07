# Actor Framework

Node.js `worker_threads` Actor 框架：OTP 风格监督树、优先级邮箱与背压、重试 + 死信队列、持久化（可插拔后端）、指标与全链路 Trace、Gossip 集群、Pub/Sub、以及对等的 TCP 网关（Protobuf 帧 + 双向 TLS）。

**默认零外部依赖**（仅用 Node 内置模块），要求 **Node.js >= 18**。
唯一可选依赖是 LevelDB 后端所需的 `classic-level`（`optionalDependencies`，缺失时自动跳过，不影响其它功能）。

---

## 作为框架使用

```js
const { Actor, createSystem } = require('nodejs-actor-framework');

class Player extends Actor {
  preStart() { this.state = { hp: 100 }; }          // 恢复之前运行：用于建立初始状态
  async receive(msg, ctx) {
    switch (msg.type) {
      case 'hurt':
        this.state.hp -= msg.damage;
        return this.state.hp;                        // 返回值就是 ask() 的回复
      case 'pet':
        return (await ctx.spawn(Pet, { id: 'pet-1' })).path;   // 子 Actor，路径唯一
      default:
        throw new Error(`unknown message ${msg.type}`);        // 抛错 = 崩溃，交给监督树
    }
  }
  postStop(ctx) {}
}

const system = createSystem({
  defaults: { supervision: { strategy: 'one_for_one', maxRestarts: 3, withinSeconds: 5 } },
});

const player = await system.spawn(Player, { id: 'player_001' });
player.tell({ type: 'hurt', damage: 5 });                  // 发后不理：不分配 reply、不设定时器
const hp = await player.ask({ type: 'hurt', damage: 5 });  // 请求-响应
await system.stop();
```

可直接运行：[examples/game-server.js](examples/game-server.js)（`node examples/game-server.js`）。

### 编程模型

| 概念 | API | 说明 |
| --- | --- | --- |
| 定义 Actor | `class X extends Actor` / `createActor({ onMessage })` / 裸函数 / `{receive}` | 四种写法等价，同一套内核 |
| 生命周期 | `preStart` → 恢复 → `postRecover` → `receive*` → `postStop`；失败时 `preRestart` | 重启 = 全新实例（状态重置，除非配置了持久化） |
| 消息 | `ref.tell(msg)` / `ref.ask(msg, timeout)` | tell 零分配；ask 才分配 reply 与超时 |
| 上下文 | `ctx.self` / `ctx.sender` / `ctx.spawn` / `ctx.tell` / `ctx.ask` / `ctx.stop` / `ctx.persist` / `ctx.log` | `ctx.sender` 在外部 ask 时为 `null`，Actor 之间互发时是对方的 ref |
| 寻址 | `system.ref(path)` / `ctx.spawn(def, {id})` | **路径是唯一地址**（`arena/alice`）；裸 id 仅在无歧义时可用 |
| 监督 | 父 Actor 即子 Actor 的监督者；三策略 + 重启强度 | 子 Actor 超出重启强度 → **升级**：父 Actor 失败，由祖父决定 |
| 内省 | `system.inspect(path)` / `system.stats()` / `ref.inspect()` | 邮箱深度、计数器、状态快照、子 Actor、监督信息 |

### 失败语义（显式开关）

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `failure: 'crash'`（默认） | handler 抛错 → 该消息被丢弃、pending 的 ask 立刻收到真实错误 → Actor 崩溃 → 监督树重启 | Actor 模型的标准语义：故障是信号，不是噪声 |
| `failure: 'retry'` | 同一消息按指数退避重试 `maxRetry` 次，仍失败则进死信（`system.deadLetters` / `dead_letter` 事件），Actor 不崩溃 | 消息队列/任务消费语义，需要 `durableMailbox` 时使用 |

两种模式**按 Actor 独立配置**，不是全局开关。

### 持久化（四种策略，按 Actor 配置）

| `persistence` | 恢复的是 | 说明 |
| --- | --- | --- |
| `'none'`（默认） | 无 | 重启即全新状态，最符合 OTP 默认 |
| `'snapshot'` | 状态 | `ctx.saveSnapshot()` 或停止时自动保存；`preStart` 建立初始状态后被快照覆盖 |
| `'events'` | 事件重放 | `ctx.persist(event)` 追加事件并本地应用；重启时按 `applyEvent` 重放 |
| `'mailbox'` | 未确认消息 | 复用消息存储做 durable mailbox；**至少一次**语义，业务需幂等 |

存储后端可注入：`createSystem({ persistenceDir })`（文件）/ `persistence: adapter`（自定义）/ `mailboxStore`（复用 `message-store`）。
选了需要存储的策略却没提供存储会**直接报错**，不会静默地"不持久化"。

#### 结构演进：`persistence.evolution`（内核只提供接缝，格式由数据层决定）

改数据结构不该是破坏性变更。内核**不认识**任何信封格式，只提供三个可选的同步纯函数：

```js
const evolution = {
  upcast: (raw) => currentShapeEvent,   // events：每条事件在 applyEvent 之前调用（写入期与重放期都走）
  readLog: (raws) => ({ events }),      // events：整段日志一起读（升级 + 序号连续性检查）；重放优先用它
  decodeSnapshot: (raw) => state,       // snapshot：读取时校验版本/迁移；**抛错 = 该 Actor 拒绝启动**
  encodeSnapshot: (state) => stored,    // snapshot：写入时套信封
};
await system.spawn(Order, { id: 'order-1', persistence: { mode: 'events',   evolution } });
await system.spawn(Tank,  { id: 'tank',    persistence: { mode: 'snapshot', evolution } });
```

**可选快照缓存（`events` 模式）**：日志永远是真相，快照只是"已经重放到第几条"的缓存：

```js
await system.spawn(Acc, { id: 'acc', persistence: { mode: 'events', snapshot: { every: 100 } } });
// every > 0：每写 100 条事件自动存一次；every: 0：只用 ctx.saveSnapshot() 手动存；不写这行 = 纯重放
```

恢复时先读快照、再只重放增量（`readLog({ fromSeq })`）；快照结构对不上时，**有日志就丢弃快照
从事件重建**（日志是真相），**没有日志可重建才拒绝启动**（不拿错结构凑合）。没配置 `snapshot`
时行为与以前**逐字节一致**（手工 `ctx.saveSnapshot()` 仍写裸状态，不会被当成缓存读）。

**条件写（乐观并发）**：`events` 模式下内核会把「日志版本」（= 已写入的记录条数）带上一起写，
后端版本对不上就抛 `PersistenceConflictError` 且**不写入**——挡的是"同一个聚合被两个节点同时拥有"。
后端到底能保证什么可以查：

```js
system.persistenceCapabilities().conditionalAppend;   // 'atomic' | 'in-process' | false
```

`file` / `memory` 只能保证**同进程**（两个进程写同一目录不会被拦住，能力如实报 `'in-process'`）；
要真正的跨进程原子性，请换支持 CAS 的后端（SQL 等）。自定义适配器不实现 `capabilities()`
就是 `false`，内核不会传条件——也就不会让人误以为有保护。

这些 hook 都可选、默认恒等（不配置时行为与以前完全一致）；必须是**同步**函数，返回 Promise
会直接报错而不是被当成事件；**写入期与重放期走同一条 `upcast`**，所以"内存里的状态"与
"重启后重放出来的状态"不会漂移。`readLog` 是批量版本：**序号连续性只有看得到整段日志才能判断**
（断号意味着事件丢了，必须当场报错而不是静默少放一条）。`@actor/data`（M3）在此之上提供事件
信封（含每聚合单调 `seq`）、upcast 注册表与快照版本策略，见 `docs/design/m3-data-evolution.md`。

### 隔离：进程内（默认）与 worker（按 Actor 可选）

```js
// 进程内：默认，~5KB/Actor，适合绝大多数业务 Actor
const a = await system.spawn(Player, { id: 'player_001' });

// worker 隔离：该 Actor 的代码跑在自己的线程里（CPU 密集 / 需要真隔离时用）
const b = await system.spawn('./actors/encoder.js', { id: 'encoder', isolation: 'worker' });
await b.ask({ type: 'encode', buf });        // 同步自旋 400ms 也不会阻塞主线程
```

worker 隔离的取舍（框架会直接报错而不是静默降级）：

| 约束 | 原因 |
| --- | --- |
| 定义必须是**模块路径字符串** | 把代码送进线程只能靠 eval，而本框架刻意把动态执行设为显式开关 |
| 消息/回复/状态必须可结构化克隆 | 这才是"真隔离"的代价；不可克隆的回复会报错并让该消息失败 |
| 持久化仅支持 `none` / `snapshot` | `events` 需要把 `applyEvent` 也搬进线程；`mailbox` 由主线程保管 |
| `ctx` 跨线程可用 | `ctx.spawn/ask/tell/stop/saveSnapshot/log` 会代理回主线程，语义不变 |

**两种隔离共用同一套模型**：邮箱、背压、监督树、重启、死信都在主线程，所以"一个内联父 Actor 监督一个 worker 子 Actor"是自然写法。

### 多节点：远端 ActorRef（位置透明）

```js
// 节点 A
const a = createSystem({ name: 'node-a' });
await a.spawn(Player, { id: 'player_001' });
await a.listen({ host: '0.0.0.0', port: 9000, tls }); // 对外提供本节点 Actor（非回环必须配 TLS，
                                                     // 否则直接拒绝启动；确需裸奔用 allowInsecureBinding: true）

// 节点 B
const b = createSystem({ name: 'node-b' });
const peer = await b.connect({ host: '10.0.0.1', port: 9000 });
const remote = peer.ref('player_001');               // 与本地 ref 同名 API
remote.tell({ type: 'hurt', damage: 5 });            // 发后不理（新增 tell 帧）
const hp = await remote.ask({ type: 'hurt', damage: 5 }); // 请求-响应，远端错误/超时原样返回
await remote.stop();
```

- 也可写成 `system.remote('player_001@10.0.0.1:9000')`，或在 Actor 内 `ctx.ask('player_001@10.0.0.1:9000', msg)`。
- 复用现有网关：Protobuf 帧、连接池、mTLS、`nodeId`↔证书 CN 绑定全部生效。
- `tell` 只保证"交给传输层"（远端邮箱无法回话），`ask` 才是真正的往返；`inspect()` 是本地专用，远端会明确报错而不是返回残缺数据。

### 可选能力：插件

框架内核只管 Actor 语义；集群、发布订阅、指标、Trace、持久死信、限流都以**插件**形式挂到 `createSystem`，不用就不加载、不付费：

```js
const { createSystem, plugins } = require('nodejs-actor-framework');

const system = createSystem({
  name: 'node-a',
  plugins: [
    plugins.cluster({ seeds: ['10.0.0.1:7200'] }),   // 按名字发现远端 Actor
    plugins.pubsub(),                                 // 跨节点主题广播
    plugins.metrics({ exporter: { enabled: true, port: 9464 } }),
    plugins.tracing({ sampleRate: 0.1 }),             // tell/ask 链路透传
    plugins.deadLetters(),                            // 复用文件 DLQ，持久死信
    plugins.rateLimit({ capacity: 100, rate: 50 }),    // 每 Actor 令牌桶
  ],
});
```

| 插件 | 装上之后 | 复用了旧运行时的什么 |
| --- | --- | --- |
| `cluster` | `system.resolve('player_001')` 返回可用的 `DiscoveredRef`（懒连接）；`ctx.ask('name', msg)` 直接可用；`cluster.remoteActors()/lookup()/waitFor()` | `gossip.js`（LWW + 墓碑 + 心跳 + 节点剔除），复用不改 |
| `pubsub` | `system.pubsub.subscribe/publish/topics/subscribers`；订阅关系经 gossip 复制（`subs:<nodeId>`），跨节点投递 | 复用 gossip 的订阅复制通道 |
| `metrics` | Actor 计数器增量喂给 `metrics.js`；`/metrics` 端点换成框架形状（`actor_cluster_*`、`actor_mailbox_depth*`、`actor_isolated_actors`、每 Actor `actor_messages_*`） | `metrics.js` + `metrics-exporter.js`，新增 `framework` 视图 |
| `tracing` | 每条消息带 trace，`ctx.ask` 链自动嵌套父子 span；跨 worker **和跨节点**都保持同一 `traceId`（帧里带 trace） | `src/obs/trace.js` |
| `deadLetters` | 死信落盘（有界、容错解析），`system.readDeadLetters()/clearDeadLetters()` | `dead-letter-queue.js`，复用不改 |
| `rateLimit` | 每 Actor 令牌桶，限流时**不重排邮箱**（消息停在队首等令牌）；`{ rateLimit }` 可按 Actor 覆盖 | `token-bucket.js`，复用不改 |

设计约定：

- **不装插件 = 零开销**：Actor 热路径上只有几个 `if (this.system.tracer)` 之类的判断，没有插件时不创建 trace、不建令牌桶、死信留在内存。
- **同步 API 不变**：`resolve()` 仍是同步的；`cluster` 返回的 `DiscoveredRef` 在首次使用时才连接（真正的连接失败会在 `ask` 上抛出，`tell` 则会发 `remote_tell_failed` 事件）。
- **不做优先级邮箱**：Actor 模型是每 Actor 单 FIFO，优先级属于消息队列语义；需要时再作为插件提供（旧运行时的 `PriorityMailbox` 不移植）。

### 隔离与规模

| 模型 | 每 Actor 成本 | 1 万 Actor | 适用 |
| --- | --- | --- | --- |
| 进程内轻量 Actor（**默认**） | **~5 KB**（实测 10k = 50MB，spawn 156ms，全量 ask 26ms） | 可行 | 绝大多数业务 Actor |
| worker 线程 | ~4 MB（实测 200 线程 ≈ 895MB） | ≈ 40 GB，不可行 | CPU 密集 / 需要真隔离 |

因此当前 `Actor` 内核默认跑在进程内，调度器按"每轮 N 个 Actor × 每个 M 条消息"保证公平（一个繁忙 Actor 不会饿死其它 Actor）；worker 隔离将按 Actor 类型可选地接入（见 Roadmap）。

> `actor-main.js` 是一个**演示/运维节点**，它本身只是组合：`createSystem()` + 插件 + Telnet 控制台，不包含任何 Actor 语义。框架公共 API 在 `index.js`；如果你要把框架嵌进自己的服务，直接用 `createSystem()` 即可，不需要这个文件。

## 快速开始

```bash
node actor-main.js          # 或 npm start
```

启动后监听（默认全部绑定回环地址，端口可用环境变量覆盖）：

```
  node:    <hostname>-7200
  actors:  player_001
  console: telnet 127.0.0.1:8080
  gateway: 127.0.0.1:9000 (codec=proto)
  gossip:  127.0.0.1:7200
  tls:     disabled
  store:   file
  plugins: cluster, pubsub, tracing, deadLetters, rateLimit
  data:    ./data
```

`ACTOR_METRICS_ENABLED=1` 时还会多一行 `metrics: http://127.0.0.1:9464/metrics`。

连接调试控制台：

```bash
telnet 127.0.0.1 8080
# 或 nc 127.0.0.1 8080
```

控制台示例（`player_001` 由 `ACTOR_BOOT_ACTORS` 默认创建）：

```
hurt player_001 10              # 扣血 -> OK hp=90
getState player_001             # state:{"hp":90,...}
tell player_001 {"type":"hurt","damage":1}   # 发后不理 -> accepted
ask player_001 {"type":"hurt","damage":1}    # 请求-响应 -> reply:88
inspect player_001              # 邮箱深度、计数器、监督信息、孩子
state player_001                # 当前状态（worker 隔离的 Actor 会跨线程取回）
actors                          # 本节点 Actor 路径
spawn player_002                # 用内置演示定义创建（纳入监督树）
spawn enc ./examples/actors/encoder.js worker   # 用模块 + worker 隔离创建
crash player_002                # 触发崩溃 -> 监督者重启，进程不受影响
kill player_002                 # 有意停止（不会重启）
pub sub game/notice player_001  # 订阅主题
pub pub game/notice {"msg":"server open"}
cluster info                    # 已知节点 / 存活对端 / 已发现的远端 Actor
cluster lookup player_001       # 该路径在哪个节点
cluster wait some/actor         # 等待 gossip 发现
peer ping 127.0.0.1 9000        # 网关连通性
dlq list | dlq size | dlq clear # 死信（装了 deadLetters 插件就是落盘的）
metrics dump                    # 真实指标（Actor 计数器）
sup info                        # 根监督者 + 每个 Actor 的重启/升级计数
system                          # system.stats()
crash player_001                # 模拟崩溃 -> 监督树自动重启
kill player_001                 # 主动停止 -> 不会被重启
```

---

## 用框架做一个游戏服务器

完整可运行代码：[examples/game-server.js](examples/game-server.js)（房间 + 玩家 + 落库 + worker 排行榜 + 入口限流）
和 [examples/game-client.js](examples/game-client.js)（TCP 客户端）。

```bash
node examples/game-server.js          # 默认 127.0.0.1:7777，另开一个终端：
node examples/game-client.js 7777     # 脚本化跑一遍：join / hit / move / stats / top / chat
# 交互模式： node examples/game-client.js 7777 --interactive
```

### 需求 → 用哪个 API

| 游戏服务器要做的事 | 框架里对应什么 | 关键点 |
| --- | --- | --- |
| 一个玩家一个 Actor | `ctx.spawn(Player, { id: playerId })` | 玩家由**房间**（父 Actor）创建 → 自动进监督树 |
| 一个房间一个 Actor | `system.spawn(Room, { id: 'room-1' })` | 一个房间串行处理，别把整个世界塞进一个 Actor |
| 玩家崩了只重启玩家 | 默认行为 | 父子即监督树；房间自己崩才影响整屋子 |
| 房间崩了把玩家拉回来 | `Room.postRecover` 里按名册重新 `ctx.spawn` | **框架不会自动重建子 Actor**，见下文"恢复" |
| 玩家状态存档 | `persistence: { mode: 'snapshot' }` | 停 Actor / 停进程时自动写；也可 `ctx.saveSnapshot()` 定期存 |
| 进程重启后继续玩 | `createSystem({ persistenceDir })` | 房间恢复名册、玩家恢复 hp/score（有测试覆盖） |
| 聊天/世界公告 | `ctx.tell(playerId, msg)` 循环扇出 | 广播用 tell：不需要回值，也不被慢玩家拖住 |
| 需要回值的操作 | `ctx.ask(target, msg, timeoutMs)` | 加入房间、查状态、排行榜 |
| 反刷/限流 | `rateLimit: { capacity, rate }`（每 Actor）或插件全局默认 | 令牌桶挂在**入口**（会话 Actor），刷屏只影响那条连接 |
| 邮箱防爆 | `mailbox: { maxSize, overflow }` | 有界邮箱 + 背压策略（reject / drop-oldest / drop-newest） |
| 排名/寻路/加解密 | 模块路径 + `isolation: 'worker'` | 跑在独立线程，自旋也不卡主线程；要求消息可结构化克隆 |
| 客户端连接 | **框架不提供**，自己写 `net`/`ws` 适配层 | 一条连接一个 Session Actor（见下） |
| 跨节点（多台机器分片） | `plugins.cluster({ seeds })` + `ctx.ask('player@host:port', …)` | 装上后可按**名字**寻址远端 Actor，不用写 host:port |
| 运维观测 | `plugins.metrics({ exporter })` → `/metrics` | 每 Actor 计数、邮箱深度、隔离数、死信、调度队列 |
| HTTP 之外的运维 | `plugins.deadLetters()` | 重试耗尽的失败消息落盘，`system.readDeadLetters()` 读回 |

### 客户端协议层要自己写（重要）

框架的网关是 **节点 ↔ 节点** 的（帧 + mTLS + 节点握手），不是面向玩家的协议层。浏览器/手机要连进来，
你需要一个很薄的适配层，把连接变成 Actor 消息：

```js
const server = net.createServer(async (socket) => {         // 或 ws / uWebSockets
  const session = await system.spawn(makeSession(socket), { // 一条连接一个 Actor
    id: `session-${++seq}`,
    mailbox: { maxSize: 200 },        // 刷屏只影响这条连接
    rateLimit: { capacity: 30, rate: 20 },
  });
  socket.on('data', (buf) => { /* 解析成一条条命令 */ session.tell({ type: 'line', line }); });
  socket.on('close', () => session.tell({ type: 'close' }));  // 断线清理
});
```

推荐部署形态：**接入层进程**（WebSocket/TLS 终结、鉴权、协议解析，无状态可水平扩）→ **Actor 节点**
（房间/玩家，`plugins.cluster()` 互联）。接入层持有 `ActorRef`，业务逻辑全在 Actor 里。

### 依赖怎么传（框架没有 `this.options`）

这是新手最容易踩的地方，两种受支持的形式：

```js
// ① 节点级依赖 → 挂在 system 上（和框架自己的 system.cluster / system.pubsub 同一个位置）
system.game = { leaderboard: 'leaderboard' };
class Room extends Actor {
  async receive(msg, ctx) { const lb = ctx.system.game.leaderboard; /* ... */ }
}

// ② 每连接/每次创建都不同的依赖 → 工厂 + handler bag（闭包捕获，每次 spawn 都是新对象）
function makeSession(socket) {
  const write = (o) => socket.write(JSON.stringify(o) + '\n');
  return {
    state: () => ({ lines: 0 }),                     // state 可以是函数（每次实例化重新算）
    async onMessage(msg, ctx) { /* 用闭包里的 socket */ },
    onStop() { socket.end(); },
  };
}
await system.spawn(makeSession(socket), { id: 'session-1' });
```

两个坑：

- handler bag **只转发框架认识的钩子**（`receive`/`onMessage`、`preStart`/`onStart`、`postStop`/`onStop`、
  `postRecover`、`preRestart`、`applyEvent`、`state`）。你另外写的 `_helper()` 方法不会被转发——
  辅助函数请写成闭包。框架现在会打一条 `actor_definition_unknown_keys` 警告提醒你。
- `system.spawn(new Player())` 传**实例**是可以的，但重启会复用同一个对象（状态不会重置），
  只适合无状态且不需要重启的 Actor。要"每次重来都是干净状态"就用类或函数定义。

### 恢复：父 Actor 必须自己把孩子重建出来

监督树只记得"我有哪些孩子"，**不知道该怎么构造它们**，所以父 Actor 恢复后要自己 spawn：

```js
class Room extends Actor {
  preStart() { this.state = { roster: [] }; }          // ① 先默认值
  async postRecover(ctx) {                              // ③ 快照应用之后才跑这里
    if (!ctx.restored) return;
    for (const playerId of this.state.roster) {
      if (ctx.system.resolve(`${ctx.path}/${playerId}`)) continue;
      await ctx.spawn(Player, { id: playerId, persistence: { mode: 'snapshot' } });
    }
  }
  // ② 框架在中间把快照应用到 this.state
}
```

顺序是 `preStart → 应用快照 → postRecover`：**不能在 `preStart` 里做重建**，那时 `this.state.roster`
还是默认值。同理，"是否已加入"要判断**子 Actor 是否存在**（`ctx.system.resolve(path)`），
只看名册数组会在重启瞬间误判。

### 落库与退出

- **什么时候写盘**：停 Actor（含父 Actor 停止 → 子 Actor 优雅停止）时自动写；`ctx.saveSnapshot()`
  可按 tick 主动写。想只用"定期存 + 退出存"就够了，不必每条消息都存。
- **优雅退出**：`SIGINT/SIGTERM` → 先停止接受新连接，再 `await system.stop()`。父 Actor 会以
  `shutdownTimeoutMs` 为上限优雅停子 Actor（子 Actor 的 `postStop` 与快照都会跑完），
  卡死的 Actor 到点被强制终止，不会拖着进程不退出。

```
node examples/game-server.js
# 第一个进程：join alice / hit 30 → SIGTERM
# 第二个进程（同 DATA_DIR）：自动 "已恢复房间名册并重建玩家 Actor：alice"，stats 直接返回 hp=70 score=30
```

以上每条都有自动化用例：`test/integration-example-game-server.test.js`
（真实子进程 + TCP 客户端 + 真的重启一遍）。

### 上线三件套：接入层鉴权 / 多节点分片 / 告警

#### ① 接入层：WSS + token 鉴权（`examples/access-node.js`）

```bash
# 生成密钥并启动接入层（连本地房间）
ACTOR_AUTH_SECRET=$(openssl rand -hex 24) node examples/access-node.js
# 生产：开 WSS + 指到集群节点
ACTOR_AUTH_SECRET=... WSS_TLS=1 CERT=certs/server.crt KEY=certs/server.key \
  SEEDS=10.0.0.1:7200 node examples/access-node.js
```

```js
const { TokenAuthority, tokenFromRequest } = require('nodejs-actor-framework/src/ops/token');
const { WebSocketServer } = require('nodejs-actor-framework/src/ops/ws-server');

const tokens = new TokenAuthority({ secret: process.env.ACTOR_AUTH_SECRET }); // ≥16 字符，HMAC-SHA256
const wss = new WebSocketServer({
  host: '0.0.0.0', port: 8443, path: '/game',
  tls: { key, cert },                      // 没有 TLS 时绑定非回环地址会直接拒绝启动
  verifyClient(req) {                       // 握手阶段就鉴权，未通过不会建立连接
    const verified = tokens.verify(tokenFromRequest(req) || '');
    return verified || false;               // { playerId } 会挂到 req.auth
  },
});
wss.on('connection', async (socket, req) => {
  const playerId = req.auth.playerId;       // ★ 身份来自 token，不是客户端消息
  const session = await system.spawn(makeSession(socket, playerId), { id: `session-${n}`, rateLimit: { capacity: 40, rate: 25 } });
  socket.on('message', (raw) => session.tell(JSON.parse(raw.toString())));
});
```

要点：

- **`playerId` 必须来自 token**。如果让客户端在消息里带 `playerId`，任何人都能操作别人的角色。示例与测试都验证了"客户端伪造 playerId 会被忽略"。
- token 是 `base64url(payload).base64url(hmac)`，带 `exp`、`jti`，支持 `revoke()` 立即踢下线；默认容忍 5s 时钟偏移。
- 三种携带方式都支持：`?token=`、`Sec-WebSocket-Protocol: bearer.<token>`（浏览器不能自定义 header 时用）、`Authorization: Bearer`。
- **TLS 默认校验证书**（客户端 `connect()` 也是），自签证书要显式 `tls: { ca }` 或 `--insecure`（仅本地调试）。
- `src/ops/ws-server.js` 是零依赖的 RFC 6455 实现：文本/二进制、分片、ping/pong、close 握手、`maxPayloadBytes` 上限。不支持 `permessage-deflate`（不压缩）；要更多特性可以换 `ws`，接入层与框架之间只隔一个 `socket.send/on('message')`。
- 明文绑定非回环地址会被拒绝（和 Telnet 控制台同一个尺度）。

#### ② 多节点：房间分片 + 跨节点回信（`examples/game-cluster.js`）

```bash
NODES=2 ROOM_COUNT=4 DATA_DIR=./data node examples/game-cluster.js
#   game-1: 房间 room-1, room-3      game-2: 房间 room-2, room-4
#   access-1: wss://127.0.0.1:<port>/game
#   打印 alice/bob/carol 的去向 + 各自的 token + 可直接运行的客户端命令
node examples/ws-client.js <url> <token>            # 或 CA=test/fixtures/tls/ca.crt ... 走校验
```

```
ws-client ──token──▶ 接入层（WSS + 鉴权 + 一致性哈希选房间）
                          │ ctx.ask('room-2', …)     ← 只写房间名
                          ▼
      ┌──── gossip（成员 + Actor 名册，cluster 插件）────┐
      ▼                                                ▼
  Actor 节点 game-1（room-1/room-3）            Actor 节点 game-2（room-2/room-4）
```

- **接入层不需要知道房间在哪台机器**：房间启动时通过 gossip 广播"room-2 在 game-2 的 host:gatewayPort"，`ctx.ask('room-2', …)` 就命中远端；这是 `plugins.cluster()` 提供的按名字寻址。
- **一致性哈希**保证同一玩家永远落到同一房间（`roomFor(playerId)`，纯函数）；房间→节点的映射是运维配置，示例用 `房间号 % NODES`。
- **跨节点回信**：房间要把推送发给接入层的会话。框架会在帧里带上发送方的**网关地址**，所以房间拿到的 `ctx.sender` 是**可回信**的；把它存下来即可：

  ```js
  // 会话加入时记住"谁在问"（不要信客户端传来的路径）
  if (ctx.sender && ctx.sender.path) this.sessions[playerId] = ctx.sender; // ← 存 ref，不是 path 字符串
  // 广播时直接回信：本地会话是 ActorRef，跨节点会话是 RemoteSender，用法完全一样
  ctx.tell(this.sessions[playerId], { type: 'push', text: `[聊天] ${msg.text}` });
  ```

  这也是**为什么接入层自己也要 `listen()`**：它得在网关上服务会话 Actor，房间才发得回来（生产里这个端口只对集群内网开放或直接上 mTLS）。
- 远端调用和本地调用语义一致：**调用方的 timeout、`ctx.sender`、trace 上下文都会随帧传递**（`senderPath`/`senderHost`/`senderPort`/`timeoutMs`/`trace`）。
- gossip 是**最终一致**的（默认秒级）：刚建立的会话不一定马上被别的节点"按名字"发现。这就是上面要存可回信 ref 的原因；确实需要按名字找新会话时，用 `cluster.waitFor(name)` 等一下。
- 会话引用是**易失**的，所以放在实例字段而不是 `this.state`：`this.state` 要落库，只应存游戏状态。

#### ③ 告警：`/metrics` → 告警

有 Prometheus 就用规则文件，**不需要写代码**：

```yaml
# examples/prometheus/alerts.yml
- alert: ActorMailboxBacklog
  expr: sum(actor_mailbox_depth_total) > 1000
  for: 30s
  labels: { severity: warning }
- alert: ActorDeadLetters
  expr: increase(actor_dead_lettered_total[5m]) > 0
  labels: { severity: critical }
```

没有 Prometheus（单机/内网/先用起来）就用进程内告警器 `src/obs/alerting.js`：

```js
const { AlertManager, consoleNotifier } = require('nodejs-actor-framework/src/obs/alerting');
const alerts = new AlertManager({
  source: { url: 'http://127.0.0.1:9464/metrics' },   // 或 { snapshot: () => renderFamilies(exporter.snapshot()) }
  rules: [
    { name: 'MailboxBacklog',   metric: 'actor_mailbox_depth_total',      condition: '>',          threshold: 1000, for: '10s', severity: 'warning' },
    { name: 'ThrottledFlood',   metric: 'actor_messages_throttled_total', condition: 'rate>',      threshold: 50,   for: '30s' },
    { name: 'DeadLetters',      metric: 'actor_dead_lettered_total',      condition: 'increase>',  threshold: 0,    severity: 'critical' },
    { name: 'ActorCrashLoop',   metric: 'actor_supervisor_restarts_in_window', condition: '>',     threshold: 2,    severity: 'critical' },
  ],
  notifiers: [consoleNotifier(), webhookNotifier(process.env.ALERT_WEBHOOK)],
});
await alerts.start();
```

规则能力：gauge 比较（`>` `>=` `<` `<=` `==` `!=`）、计数器 `rate>`/`increase>`（计数器回绕/重启按 0 处理）、`for:` 持续时间（避免瞬时抖动误报）、`resolveFor`（防抖）、`resolved` 通知、console/webhook 通知器（webhook 失败不会阻塞评估）。规则定义有问题会在构造时直接报错。

完整示例：`node examples/alerts.mjs`（故意制造邮箱积压 + 死信，能看到 firing → resolved 全过程）；指标清单见 [examples/prometheus/README.md](examples/prometheus/README.md)。

## 功能状态

下表是**实测状态**，每一项都有 `test/` 下的自动化用例覆盖（共 279 个用例，`npm test`）：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| **Actor 编程模型** | ✅ | `Actor` 基类 / 函数式定义、`tell`/`ask`、`ctx` 上下文与子 Actor、生命周期钩子、路径寻址 |
| **进程内轻量 Actor** | ✅ | ~5KB/个（实测 10 万级可行），公平调度，单 Actor 永不并发处理两条消息 |
| **按父子的监督树** | ✅ | 父 Actor 即监督者；三策略 + 重启强度；超限则升级给祖父 |
| **失败语义开关** | ✅ | 默认崩溃重启；`failure: 'retry'` 才启用重试 + 死信 |
| **四种持久化策略** | ✅ | `none` / `snapshot` / `events` / `mailbox`，按 Actor 配置、存储可注入 |
| **worker 隔离（可选）** | ✅ | `isolation: 'worker'` 按 Actor 类型开启：CPU 密集不阻塞主线程，崩溃只影响该线程 |
| **远端 ActorRef** | ✅ | `system.listen()` / `connect()` / `remote('path@host:port')`，`tell`/`ask`/`stop` 跨节点同构，复用 Protobuf 帧 + mTLS 网关 |
| **插件：集群发现** | ✅ | `plugins.cluster()` 后可按 **名字** 访问远端 Actor（gossip 发现，懒连接） |
| **插件：Pub/Sub** | ✅ | 跨节点主题广播，订阅关系随 gossip 复制 |
| **插件：指标** | ✅ | Actor 计数器进入 `/metrics`（框架形状的 gauge + 每 Actor 计数） |
| **插件：Trace** | ✅ | tell/ask 链路 span 嵌套，跨节点与跨 worker 透传，支持采样 |
| **插件：持久死信** | ✅ | 复用文件 DLQ，`readDeadLetters()`/`clearDeadLetters()` |
| **插件：限流** | ✅ | 每 Actor 令牌桶，限流不重排邮箱 |
| Worker 线程隔离 | ✅ | 单 Actor 崩溃不影响其他 Actor，也不会打死主进程 |
| 监督树 | ✅ | `one_for_one` / `rest_for_one` / `one_for_all` 三种策略真实生效 |
| 故障自动重启 | ✅ | worker 异常退出 → `handleChildCrash()` → 按策略重启（`crash` 命令可验证） |
| 重启强度 | ✅ | 窗口内重启超限 → **升级给父 Actor**（`EscalationError`）；根监督者无处升级 → 停止系统。这是 OTP 语义，旧运行时的"熔断 + 冷却自愈"已移除（它会让超限的 Actor 悄悄复活） |
| 优先级邮箱 | ✅ | HIGH(0) > NORMAL(1) > LOW(2)；非法优先级归一化，不再导致崩溃 |
| 背压 | ✅ | 邮箱有硬上限，超限回 `mailbox_full` 并计入 `dropped`，不入库 |
| 消息重试 + 退避 | ✅ | 逐条重试，指数退避，失败归因到真正失败的那条消息 |
| 死信队列 DLQ | ✅ | 重试耗尽入 DLQ；行级容错解析；文件有上限、自动裁剪最旧记录 |
| 持久化（可插拔） | ✅ | `file`（默认，无依赖）/ `memory`（测试）/ `level`（可选 LevelDB） |
| 持久化语义 | ✅ | 入队 append、终态 ack（**ack 也持久化**）；只有未确认的消息会重放 |
| 日志压缩 | ✅ | 追加式日志 + 死记录占比超阈值时原子重写（compact） |
| 批量消费 | ✅ | 数量阈值 / 超时双触发；可选 `onBatch` 契约，批次失败时逐条兜底 |
| 令牌桶限流 | ✅ | 每 Actor 独立令牌桶；限流时不重排邮箱、不重复计数 |
| 性能指标 | ✅ | worker 增量回传主进程聚合，`metrics dump` 返回真实数据 |
| 全链路 Trace | ✅ | `traceId`/`spanId`/`parentSpanId`，发布=父 span、投递=子 span，跨网关透传，可采样 |
| Gossip 集群 | ✅ | 对等节点互相学习、LWW 版本合并、删除墓碑、静默节点剔除、存活节点保活 |
| **Gossip 二进制帧** | ✅ | 与网关共用同一套帧格式（长度前缀 + codec），Protobuf 为默认，兼容 JSON 帧 |
| 注册中心 | ✅ | 本地 + 远端条目（含网关地址），带 TTL 清理 |
| Pub/Sub | ✅ | 订阅关系经 Gossip 复制，跨节点经网关投递，并行扇出、逐订阅者上报成败 |
| Actor 热更新 | ❌ 已移除 | 旧的 `new Function` 动态编译路径删除；等价能力是用模块路径 + `isolation:'worker'` 重启 Actor |
| **网关二进制帧** | ✅ | 长度前缀 + codec 字节；**Protobuf 为默认**，同时兼容 JSON 帧，混合节点互通 |
| **网关/集群 TLS** | ✅ | 双向认证（mTLS），`nodeId` 与证书 CN 绑定，配置错误只禁用监听、绝不降级明文 |
| **证书轮换 / 吊销** | ✅ | 多 CA 信任、CRL 吊销、CN 黑名单、证书热加载（`setSecureContext`，不断连接） |
| **指标导出** | ✅ | Prometheus 文本格式 `/metrics`（也可由 OTel Collector 的 prometheus receiver 抓取） |
| **存储迁移工具** | ✅ | `tools/migrate-store.js`：`file` → `level`，逐条校验、可重复执行、源文件只重命名不删除 |
| TCP 网关 | ✅ | 请求/响应关联、连接池、抗超大帧、握手机制 |
| Telnet 调试控制台 | ✅ | 行缓冲、可选 Token 鉴权、输入校验、连接数上限 |
| Monitor 监控 | ✅ | 被监控 Actor 死亡时通知监控者（含 `reason`） |

---

## 目录结构

```
actor-framework/                     # monorepo（根为私有工作区根，不发布）
├── packages/
│   └── core/                        # ★ @actor 内核包（可独立安装使用）
│       ├── package.json             #   name: nodejs-actor-framework（保持既有包名）
│       ├── src/
│       │   ├── index.js  index.d.ts #   公共 API 与类型声明
│       │   ├── config.js            #   配置（root = 应用根目录，默认 cwd）
│       │   ├── actor/               #   内核：Actor/邮箱/调度器/监督/系统
│       │   ├── cluster/             #   传输与集群：帧/Protobuf/网关/gossip/mTLS
│       │   ├── store/               #   持久化：快照/事件 + 后端（file/memory/level）
│       │   ├── obs/                 #   可观测：指标/导出器/告警/日志/Trace
│       │   ├── worker/              #   worker 隔离：线程宿主与代理
│       │   ├── ops/                 #   运维：Telnet 控制台、WS/TLS 服务器、token
│       │   └── plugins/             #   可选能力插件（M1 起拆为独立包）
│       └── test/                    #   包级测试（node:test，直接跑 .js/.ts）
├── examples/                        # ★ 示例：游戏服务器、接入层、集群、告警
├── actor-main.js                    # 演示/运维节点（应用层，不属于 core）
├── test/                            # 仓库级测试：app 与跨包集成（会启动 examples）
├── docs/design/                     # 设计文档（含 M0 施工设计）
├── tools/docs-site.mjs              # 文档站生成器（零依赖：md → 静态站点 + API 参考）
├── tools/release-check.mjs          # 发布前检查（打包内容 / 版本 / engines / 测试矩阵）
├── CHANGELOG.md                     # 版本与弃用策略 + 变更记录
├── tools/  scripts/                 # 迁移工具、测试证书生成
├── tsconfig.base.json  tsconfig.json
└── package.json                     # private workspace root
```

---

## 传输：帧格式与编解码

网关帧格式（双向一致）：

```
uint32_be bodyLength | uint8 codec | body
codec 0 = JSON      （utf-8 JSON，便于抓包排查）
codec 1 = Protobuf  （默认，见 packages/core/src/cluster/proto.js 与 actor-proto.proto）
```

- **codec 随帧携带**，因此节点总是同时接受两种编码：`ACTOR_GATEWAY_CODEC` 只决定**发送**用哪种，混合部署（滚动升级、异构客户端）无需协商。
- Protobuf 编解码是**手写**的（varint / length-delimited / 未知字段跳过），因此保持零依赖；未知字段会被跳过，所以后续版本可以安全地新增字段。
- 实测同样载荷下 Protobuf 帧显著小于 JSON（用例 `unit-proto` 有断言）。
- 业务载荷本身是任意 JSON，因而以 JSON 字节嵌入（`payloadJson` / `dataJson`）；框架自身的键（`type`/`priority`/`topic`/`trace`）在 `actor-proto.proto` 中给出类型。

## 集群与安全：双向 TLS

TLS 默认**关闭**。开启后网关与 Gossip 都使用 mTLS：

```bash
# 1) 自签 CA
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -sha256 \
  -keyout ca.key -out ca.crt -subj "/CN=actor-ca"

# 2) 每个节点一张证书，CN 必须等于该节点的 ACTOR_NODE_ID
openssl req -newkey rsa:2048 -nodes -keyout node-1.key -out node-1.csr -subj "/CN=node-1"
openssl x509 -req -in node-1.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out node-1.crt -days 825 -sha256 \
  -extfile <(printf "subjectAltName=IP:10.0.0.1\nextendedKeyUsage=serverAuth,clientAuth")

# 3) 启动
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=./ca.crt \
ACTOR_TLS_CERT=./node-1.crt ACTOR_TLS_KEY=./node-1.key \
ACTOR_NODE_ID=node-1 ACTOR_ADVERTISE_HOST=10.0.0.1 \
ACTOR_GATEWAY_HOST=10.0.0.1 ACTOR_GOSSIP_HOST=10.0.0.1 node actor-main.js
```

安全性质：

- **双向认证**：服务端 `requestCert` 且 `rejectUnauthorized`，客户端同样校验服务端证书链。
- **身份绑定**：`ACTOR_TLS_VERIFY_NODE_ID=1`（默认）要求对端证书 **CN 等于其声明的 `nodeId`**，因此一张合法证书无法冒充别的节点；网关还要求对端在发送任何数据前先完成 `hello` 握手。
- **不降级**：TLS 配置缺失或证书读不到时，该监听器会被**禁用**并告警，绝不会静默退回明文。
- 测试证书是**一次性**的，由 `npm run gen-test-certs` 生成（`test/fixtures/tls/`），仅供测试使用。

## 持久化：后端与语义

`ACTOR_STORE` 选择后端，接口一致（`append` / `ack` / `load` / `pendingCount` / `clear` / `compact`）：

| 后端 | 说明 | 适用 |
| --- | --- | --- |
| `file`（默认） | 每 Actor 一个追加式日志，记录带 CRC 帧；ack 也写入日志（O(1) 且持久），死记录占比超阈值时原子重写压缩；容错截断/损坏记录；自动迁移旧版 `.jsonl` | 单机、中小规模、零依赖 |
| `memory` | 纯内存，进程退出即丢 | 测试、临时场景 |
| `level` | 可选 `classic-level`；**每个 Actor 一个 LevelDB**（worker 之间无锁争用），按入队序号做范围扫描，ack 用批量删除 | 高吞吐、需要 O(1) ack |

语义要点：

- **至少一次投递**：消息入队落盘，终态（成功或入 DLQ）才 ack；崩溃重启只重放未确认的消息，业务 handler 应幂等。
- **ack 是持久的**：ack 会写入日志（而不是只留在内存），因此重启不会把已确认的消息再投一次。
- **顺序**：同一优先级内 FIFO；重试 `pushFront` 保持队首；限流不重排邮箱。
- **背压**：邮箱满立即拒绝（`mailbox_full`），被拒消息不落盘。
- 升级提示：旧版 `.jsonl` 会在首次读取时自动迁移为带帧日志，原文件重命名为 `*.jsonl.migrated` 保留。

---

## 配置

全部配置集中在 `config.js`，均可用环境变量覆盖。

**基础**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_DATA_DIR` | `./data` | 持久化、DLQ、日志目录 |
| `ACTOR_LOG_DIR` | 同 `ACTOR_DATA_DIR` | 日志目录 |
| `ACTOR_NODE_ID` | `<hostname>-<gossipPort>` | 集群内节点标识（唯一；TLS 下需等于证书 CN） |
| `ACTOR_BOOT_ACTORS` | `player_001` | 启动创建的 Actor，逗号分隔；设为空表示不创建 |
| `ACTOR_REGISTRY_PRUNE_MS` | `3000` | 远端注册条目过期检查周期 |

**控制台**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_TELNET_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `8080` | 控制台；绑定非回环地址时**必须**设置 Token |
| `ACTOR_TELNET_TOKEN` | 空 | 鉴权令牌（首条命令 `auth <token>`） |
| `ACTOR_TELNET_MAX_LINE` / `_MAX_CONN` | 64KB / 8 | 行长与连接数上限 |

**网关与集群**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_GATEWAY_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `9000` | 跨节点网关 |
| `ACTOR_GATEWAY_CODEC` | `proto` | 发送帧编码：`proto` 或 `json`（接收始终自动识别） |
| （框架）`system.listen()` / `connect()` | — | 节点间 `tell`/`ask`/`stop`；端口 `0` 表示随机端口 |
| `ACTOR_GATEWAY_MAX_FRAME` | 8MB | 单帧上限 |
| `ACTOR_GOSSIP_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `7200` | 集群 Gossip（默认端口避开 macOS AirPlay 的 7000） |
| `ACTOR_GOSSIP_SEEDS` | 空 | 种子节点 `host:port,...` |
| `ACTOR_ADVERTISE_HOST` | `127.0.0.1` | 告知其它节点的可达地址（多机部署必须设置） |
| `ACTOR_GOSSIP_CODEC` | `proto` | Gossip 发送帧编码（接收始终自动识别） |
| `ACTOR_GOSSIP_INTERVAL_MS` / `_PEER_TIMEOUT_MS` | 1000 / 6000 | 同步间隔与节点静默判定 |

**TLS**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_TLS_ENABLED` | `0` | 开启网关与 Gossip 的 mTLS |
| `ACTOR_TLS_KEY` / `_CERT` / `_CA` | 空 | 本节点私钥/证书与信任的 CA（开启时必填；逗号分隔可配多个 CA 或证书） |
| `ACTOR_TLS_CRL` | 空 | CRL 文件（逗号分隔多个），被吊销的证书会在握手中被拒 |
| `ACTOR_TLS_DENY_NODES` | 空 | 节点 id / 证书 CN 黑名单（无需 CRL 即可吊销） |
| `ACTOR_TLS_RELOAD_MS` | `30000` | 证书轮询间隔，热加载新证书；`0` 关闭 |
| `ACTOR_TLS_PASSPHRASE` | 空 | 私钥口令 |
| `ACTOR_TLS_SERVER_NAME` | 空 | 客户端 SNI 名称 |
| `ACTOR_TLS_REQUEST_CERT` / `_REJECT_UNAUTHORIZED` | `1` / `1` | 双向认证开关 |
| `ACTOR_TLS_VERIFY_NODE_ID` | `1` | 校验对端 `nodeId` == 证书 CN |
| `ACTOR_TLS_MIN_VERSION` | `TLSv1.2` | 最低协议版本 |

**持久化与消息**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_STORE` | `file` | `file` / `memory` / `level` |
| `ACTOR_STORE_LEVEL_PATH` | `<data>/level` | LevelDB 根目录 |
| `ACTOR_STORE_COMPACT_BYTES` | 256KB | file 后端压缩触发阈值 |
| `ACTOR_MAX_MAILBOX` | `1000` | 邮箱上限（背压） |
| `ACTOR_BATCH_MAX` / `_TIMEOUT_MS` | `5` / `200` | 批量双触发阈值 |
| `ACTOR_MAX_RETRY` / `_RETRY_BACKOFF_MS` | `3` / `50` | 重试次数与退避基数 |
| `ACTOR_BUCKET_CAPACITY` / `_RATE` | `100` / `50` | 令牌桶容量与速率 |
| `ACTOR_SUP_STRATEGY` / `_MAX_RESTARTS` / `_WITHIN_SECONDS` | `one_for_one` / `3` / `5` | 监督策略与重启强度（超限则升级） |
| `ACTOR_METRICS_ENABLED` / `_HOST` / `_PORT` / `_PATH` | `0` / `127.0.0.1` / `9464` / `/metrics` | Prometheus 抓取端点 |
| `ENABLE_HOT_RELOAD` | `0` | 已忽略：框架不做运行时编译代码，启动时会给出 warning |
| `ACTOR_PERSISTENCE_MODE` | `none` | 启动 Actor 的持久化：`none` / `snapshot` / `events` / `mailbox` |
| `ACTOR_PERSISTENCE_DIR` | `./data/actors` | `snapshot`/`events` 的存放目录 |
| `ACTOR_HOT_RELOAD_MODULE` | 空 | 更安全的替代：从受审查模块加载 handler |

### 集群示例（Protobuf + mTLS + LevelDB）

```bash
# 节点 1
ACTOR_NODE_ID=node-1 ACTOR_ADVERTISE_HOST=10.0.0.1 ACTOR_GATEWAY_HOST=10.0.0.1 \
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=ca.crt ACTOR_TLS_CERT=node-1.crt ACTOR_TLS_KEY=node-1.key \
ACTOR_STORE=level ACTOR_TELNET_TOKEN=$(openssl rand -hex 16) node actor-main.js

# 节点 2
ACTOR_NODE_ID=node-2 ACTOR_ADVERTISE_HOST=10.0.0.2 ACTOR_GATEWAY_HOST=10.0.0.2 \
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=ca.crt ACTOR_TLS_CERT=node-2.crt ACTOR_TLS_KEY=node-2.key \
ACTOR_STORE=level ACTOR_GOSSIP_SEEDS=10.0.0.1:7200 \
ACTOR_TELNET_TOKEN=$(openssl rand -hex 16) node actor-main.js
```

装了 `plugins.cluster()` 后，节点 2 上 `cluster info` 能看到节点 1 的 Actor，直接 `ask <path> {...}` 即可按名字跨节点调用；投递走 Protobuf 帧 + mTLS。

---

## 可观测性：Prometheus / OTel

开启后暴露只读的抓取端点（默认关闭、默认只绑回环）：

```bash
ACTOR_METRICS_ENABLED=1 ACTOR_METRICS_PORT=9464 node actor-main.js
curl -s localhost:9464/metrics | head
```

输出为标准 Prometheus 文本格式（`# HELP` / `# TYPE` + 指标），可被 Prometheus 直接抓取，
也可由 **OpenTelemetry Collector** 的 `prometheus` receiver 采集后转发到任意后端，
因此无需引入 SDK 依赖。

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `actor_messages_received_total{actor}` | counter | 进入邮箱的消息 |
| `actor_messages_handled_total{actor}` | counter | 成功处理 |
| `actor_messages_failed_total{actor}` | counter | 重试耗尽 |
| `actor_messages_dead_lettered_total{actor}` | counter | 进入死信 |
| `actor_messages_dropped_total{actor}` | counter | 背压拒绝 |
| `actor_messages_throttled_total{actor}` | counter | 令牌桶限流等待 |
| `actor_messages_recovered_total{actor}` | counter | 重启后重放 |
| `actor_message_latency_seconds_total` / `_max` / `_avg{actor}` | counter/gauge | 处理延迟（秒） |
| `actor_cluster_actors` / `actor_cluster_remote_actors` | gauge | 本节点 / 远端 Actor 数 |
| `actor_supervisor_restarts_in_window{supervisor}` / `actor_supervisor_escalations_total` | gauge / counter | 监督树状态 |
| `actor_cluster_actors` / `_remote_actors` / `_peers` / `actor_isolated_actors` | gauge | 集群与隔离视图 |
| `actor_pending_requests{kind}` | gauge | 在途请求/控制调用 |
| `actor_store_info{backend}` | gauge | 当前持久化后端 |
| `actor_process_resident_memory_bytes` / `_heap_used_bytes` / `_uptime_seconds` | gauge | 进程指标 |

## 运维：存储后端迁移

把已有 `file` 后端数据搬到 LevelDB：

```bash
node tools/migrate-store.js --data ./data --dry-run        # 先看会做什么
node tools/migrate-store.js --data ./data --purge          # 迁移并重命名源文件
node tools/migrate-store.js --data ./data --actor a1 --json
```

- 逐条按消息 id **校验**后才允许清理源数据；校验不通过就报错退出（退出码 1）。
- **可重复执行**：目标端已存在的消息会被跳过（LevelDB 的键含自增序号，重复写入会变成重复投递）。
- `--purge` 只把源日志重命名为 `*.log.migrated`，**不删除**。
- `--dry-run` 不写任何东西（包括不创建 LevelDB 目录）。
- actorId 从 `msg_store/manifest.json` 读取（落盘名是哈希，无法反推 id）；没有 manifest 时会提示改用 `--actor`。

## 控制台命令

```
help                                              # 命令列表
actors                                            # 本节点 Actor 路径
inspect [path]                                    # 邮箱深度 / 计数器 / 监督信息 / 孩子
state [path]                                      # 当前状态（worker 隔离的 Actor 会跨线程取回）
system                                            # system.stats()
hurt [path] [damage]                              # 扣血（优先级参数已移除，会明确报错）
getState [path]                                   # 查询状态
tell [path] json                                  # 发后不理
ask [path] json                                   # 请求-响应
spawn [path] [modulePath] [inline|worker]         # 用内置定义或模块创建 Actor
kill [path]                                       # 主动停止（不会重启）
crash [path]                                      # 触发崩溃（监督者重启，进程不受影响）
sup info                                          # 根监督者 + 每个 Actor 的重启/升级计数
dlq list | dlq size | dlq clear                   # 死信（装 deadLetters 插件则落盘）
metrics dump | metrics collect                    # 指标快照
pub sub [topic] [path] | pub unsub ...            # 订阅 / 取消订阅
pub pub [topic] json | pub topics | pub subs      # 发布 / 主题 / 订阅者
cluster info | cluster lookup [path] | cluster wait [path]   # 集群视图与发现
peer ping [host] [port]                           # 网关连通性
exit
gateway ping [host] [port]                        # 网关连通性
exit
```

启用鉴权时，第一条命令必须是 `auth <token>`。

## 安全

- **没有运行时编译代码的路径**：旧的 `new Function` / `hotreload` 已删除。想要换逻辑就换模块并重启 Actor（`isolation:'worker'` 的 Actor 崩溃后会用新模块重启），代码加载仍限制在项目根目录内。
- **控制台**：默认只绑定 `127.0.0.1`；若绑定非回环地址而**未**设置 Token，会拒绝启动控制台并告警，而不是把 RCE 暴露到网络。
- **网关 / Gossip**：默认绑定回环。跨机器部署请开启 mTLS（见上）并配合防火墙；未开 TLS 时应只跑在可信网络内。
- **吊销与轮换**：`ACTOR_TLS_CRL` 提供标准 CRL 吊销，`ACTOR_TLS_DENY_NODES` 提供即时黑名单；
  证书文件变更后由 `setSecureContext` 热加载（默认 30s 轮询），已建立的连接不受影响。
  加载失败会保留旧上下文继续服务，绝不因为半写入的文件而中断集群。
- **输入校验**：actorId 限制为 `[A-Za-z0-9._:-]{1,128}`（落盘名再经哈希与转义，无法穿越目录）；优先级、伤害值、JSON 载荷都会校验。
- **文件权限**：`data/` 内含消息与日志，建议部署时限制目录权限。

---

## 测试

```bash
npm test                    # 279 个用例（Node 内置 node:test，无运行时依赖）
npm run typecheck           # tsc 校验 index.d.ts 与公开 API 的类型
npm run gen-test-certs      # 需要时重新生成测试证书（openssl）
```

打包/库化现状：

| 项 | 状态 |
| --- | --- |
| `main` / `exports` / `types` | `index.js` / `{".": {types, require, default}}` / `index.d.ts` |
| 类型声明 | 手写 `index.d.ts`，由 `test/types/public-api.ts` 做编译期验证（`npm run typecheck`） |
| `files` 白名单 | 30 项，**测试与证书不进包**（`npm pack` 实测：51 个文件、101KB，0 个 `.key`） |
| 运行时依赖 | 0（`classic-level` 为 optionalDependencies） |

覆盖重点：

- **回归用例（对应真实缺陷）**
  - 批量中一条消息失败时同批其它消息不丢失，DLQ 归因正确；
  - 单条消息失败进入重试/DLQ，而不是打死 worker 或主进程；
  - 崩溃重启只重放未确认消息，且 **ack 跨重启保持有效**（不会重复投递）；
  - 优先级越界、非数字伤害值不再导致崩溃或 `NaN` 状态；
  - 热更新箭头函数能拿到 `this`，非法代码被拒绝且不影响运行中的 Actor；
  - worker 未捕获异常不会打死主进程，且 Actor 会被重启；
  - 指标真正从 worker 传到主进程（`metrics dump` 不再是 `{}`）；
  - 存活节点的远端 Actor 不会被 TTL 误剔除（负向验证：去掉修复后该用例失败）。
- **单元测试**：配置、Trace、Protobuf 编解码（含未知字段跳过与畸形帧）、共享帧编解码（两种 codec 混用）、
  三后端持久化一致性、CRC 损坏/截断恢复、日志压缩、旧版 `.jsonl` 迁移、manifest 索引、DLQ、注册中心、
  令牌桶、指标合并与 Prometheus 文本格式、网关双工、Gossip LWW/墓碑与二进制帧、框架的监督三策略与升级；已随旧运行时删除的用例：旧优先级邮箱、`supervisor.js`、热更新、队列式 Actor 的批量/DLQ（覆盖已由 `unit-actor-*` 承接）。
- **安全测试**：mTLS 双向投递、不受信任 CA 被拒、无客户端证书被拒、明文客户端无法接入 TLS 网关、
  `nodeId` 与证书 CN 不匹配被拒（网关与 Gossip 各自覆盖）、TLS 配置错误时禁用而非降级明文；
  多 CA 信任链、CRL 吊销生效、CN/id 黑名单、证书热加载（轮换后新连接生效、坏文件不生效且旧上下文继续服务）。
- **迁移工具测试**：dry-run 不落盘、逐条校验、可重复执行不产生重复、`--purge` 只重命名、按 actor 选择性迁移、CLI 退出码。
- **集成测试**：真实 worker 的启动/收发/重启/监控；控制台行缓冲、鉴权与输入校验；双节点集群的 Gossip 发现、
  跨节点投递、跨节点 Pub/Sub、Actor 下线注销、存活保活；指标端点端到端抓取与端口占用降级。

---

## 限制与 Roadmap

**已知限制**

1. Gossip 为最终一致性（LWW + 墓碑），无向量时钟；不适合强一致业务状态。
2. 跨节点投递要求载荷可 JSON 序列化（不传函数、`undefined`、循环引用）。
3. `level` 后端按 Actor 分库：适合中大型 Actor；海量小 Actor 建议用 `file` 后端。
4. 主进程承担路由与聚合，是单线程的；极高吞吐需要按业务分片到多个路由进程。
5. 日志 / 指标 / 死信仍是追加写，生产环境需配置 logrotate。
6. 已支持 CRL 与 CN 黑名单，但尚无 OCSP 在线校验与自动签发（ACME/SPIFFE）。
7. 控制台能 spawn/kill Actor，非回环绑定必须有 `ACTOR_TELNET_TOKEN`，否则拒绝启动。

**Roadmap**

- ~~目录统一~~ ✅ 已完成：内核/传输/存储/可观测/运维分别归入 `packages/core/src/{actor,cluster,store,obs,ops}`
- 把 Gossip 注册表接到 `system.connect()`，实现"按 actor 名自动发现节点"
- 基于 SPIFFE / SPIRE 的自动身份签发与轮换
- OCSP 在线吊销校验
- 迁移工具支持反向（`level` → `file`）与在线迁移（业务不停机）
- 按负载调度 `spawn` 到低负载节点
- 跟踪（Trace）导出到 OTLP

## License

MIT，见 [LICENSE](LICENSE)。

```
【客户端玩家】
     ↓ TCP/WebSocket
【网关集群】（只负责收发包、协议编解码，不跑游戏逻辑）
     ↓ NATS（跨机器消息传输通道，不是Actor邮箱！）
【逻辑服集群 - 机器A】
├─ 主进程（路由、分片、Supervisor）
│   ├─ IPC管道（本机主进程 ↔ Worker 的传输通道）
│   ├─ 物理Worker池（固定数量，例如32个，复用CPU核心）
│   │   └─ 物理Worker #1
│   │      ├─ 物理Worker自身邮箱（内存队列：接收主进程转发过来的消息）
│   │      └─ LogicalActorManager（逻辑Actor管理器）
│   │          ├─ 逻辑Actor player_10001
│   │          │   ├─ ✅ 私有邮箱【内存队列，Actor专属】
│   │          │   └─ 私有状态 state
│   │          ├─ 逻辑Actor player_10002
│   │          │   ├─ ✅ 私有邮箱【内存队列，Actor专属】
│   │          │   └─ 私有状态 state
│   │          └─ 调度循环：逐个取出各个逻辑Actor邮箱消息串行处理
│   │
│   └─ 物理Worker #2 ... #32
│
【逻辑服集群 - 机器B】（同机器A结构，独立分片）
```

## 文档站（零依赖本地构建）

```bash
npm run docs:build     # 读 README/docs/examples 的 md → 写 site/
npm run docs:serve     # 构建 + 起本地预览（默认 4321，可用 DOCS_PORT 覆盖）
```

产物是纯静态文件（`site/`，已 gitignore），**不引入任何依赖**：`tools/docs-site.mjs` 自己渲染仓库里真实
用到的 markdown 子集，并**自动生成 API 参考**——每项导出带类别、**签名（含逐个参数的类型）**、说明与源码
链接，末尾还有一节**类型覆盖进度**（内核公开面在 `packages/core/src/index.d.ts`：**34/34 已声明**；
内核源码 **0 个文件**跳过严格检查）。

类型覆盖不是靠自觉，有**两道门禁**：`test/unit-kernel-surface.test.js` 与 `npm run release:check`
的第 6 项，分别对齐"运行时导出 ↔ 类型声明"和"不许有 `@ts-nocheck`"——因为这两类漂移**不会让任何测试变红**。构建时会检查文档里的**相对链接**：断链直接失败并列出"文件 → 目标"，而不是产出一个
点进去 404 的站点。

> 注意：它渲染的是仓库现有的**工程文档**（设计/决策/实现日志）与 API 参考，不是一份面向使用者的官网
> 叙事——"快速开始/概念/指南"那类内容仍需要写（见 `docs/design/06-roadmap-and-nongoals.md` 的 M5）。

## CI 与文档站部署

```bash
npm run ci     # CI 跑的就是这一条：typecheck + 全量测试 + 文档站构建（含断链门禁）
```

**单一事实来源**：`.github/workflows/ci.yml` 里只写 `npm run ci`，不把步骤再抄一遍——
否则迟早会出现"CI 绿、本地红"（或反过来）。有一条测试专门盯着这件事
（`test/unit-ci-workflows.test.js`）：脚本改名后工作流里的死引用、action 被改成 `@main`、
Pages 上传目录与构建产物不一致、权限少一项……这些都在测试里挡掉。

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push 到 main、所有 PR | `npm ci` + `npm run ci`（Node 24，与 `engines` 一致） |
| `pages.yml` | push 到 main、手动 | 构建文档站 → 发布到 GitHub Pages |

**发布到 Pages 需要你在仓库设置里做一次**：Settings → Pages → Build and deployment → Source 选
**GitHub Actions**（`site/` 是构建产物、不入库，所以每次部署都现场构建；构建时断链会让这一步失败，
而不是发布一个点进去 404 的站点）。

> 环境要求：**Node ≥ 24**（源码直接跑 TypeScript，且 SQL 适配器用 `node:sqlite`）。
> 可选后端 `level` 需要可选依赖 `classic-level`（原生模块）；装不上时相关测试会**显式跳过**
> 并说明原因，不影响核心路径。
>
> 诚实说明：这两条工作流还没有在 GitHub 上跑过（仓库此前没有任何 CI），本地验证的是**它们执行的
> 那条命令**（`npm run ci` 全绿）与工作流文件的结构约束；实际的 runner 行为、Pages 首次部署需要
> 推到远端后才能确认。

## 命令行（脚手架）

```bash
node packages/cli/src/cli.ts new app my-app    # 发布后：actor new app my-app
cd my-app && npm install && npm start          # 起 HTTP
npm test                                       # 4 条端到端用例（含"重启后持久化"）
```

```bash
node packages/cli/src/cli.ts migrate status|up|down   # 迁移：状态/应用/回滚（对接 @actor/data 的迁移框架）
node packages/cli/src/cli.ts doctor                   # 体检：Node/依赖/配置/数据目录/迁移/端口
```

生成的是**开箱即跑**的骨架：CRUD（仓储 + 游标分页 + 乐观锁 409）、Actor（`mode: 'snapshot'`）、
优雅停止、真 HTTP 测试。约定：目标目录非空就拒绝写入（要 `--force`）、不自动装依赖、
退出码有意义（0 成功 / 1 用法错误 / 2 项目或环境问题）且默认不打印堆栈。
`migrate status` **有待处理迁移时退出码 2**，可直接当 CI/启动门禁。
见 [CLI 指南](docs/guide/00-scaffold.md)。

## 测试工具（`@actor/testkit`）

```js
import { createSystem } from 'nodejs-actor-framework';
import { createVirtualClock } from '@actor/testkit';

const vc = createVirtualClock();
const system = createSystem({ clock: vc.clock });

const pending = ref.ask('hi', 1000);          // 超时 1000ms
const timedOut = assert.rejects(() => pending, AskTimeoutError);  // 先挂处理器
await vc.drain();                             // 先让消息真正投递
await vc.advance(1000);                       // 1000ms 虚拟时间，真实时间几乎没走
await timedOut;
```

超时、限流、`ctx.sleep`、outbox/投影的轮询都由**你推进的时间**驱动，顺序确定。
三条规则：**advance 之前先 `drain()`**、**停系统之前先推进**、**网络 I/O 仍需要真实时间**
（时钟只管纯逻辑定时）。见 [测试指南](docs/guide/06-testing.md)。

## 发布前检查与版本策略

```bash
npm run release:check          # = npm run ci（typecheck + 全量测试 + 文档站）+ 打包/一致性检查
npm run release:check -- --skip-ci   # 只跑打包与一致性检查（本地快速自检）
```

它检查的是"**发了会不会出事**"：工作区测试矩阵（有测试的包都要进根 `npm test`）、`npm pack` 内容
（测试/凭据/数据目录不能进 tarball）、CHANGELOG 与版本一致（**没切版本就不许发**）、各包 `engines` 一致、
工作区干净。版本与弃用策略见 [CHANGELOG.md](CHANGELOG.md) 开头那一节（含当前真实的发布状态）。
