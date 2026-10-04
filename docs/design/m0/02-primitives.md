# M0.2 内核原语：定时器 / FSM / stash / receive-timeout / 消息校验（设计草案）

> 你点名的五件缺失。本文给**确切签名、语义、边界、测试计划**。
> 全部是**新增能力**：不改 `receive`、监督、持久化的现有语义；不装不用时走快路径。

## 0. 共同前提：可注入时钟（先做）

```ts
export interface Clock {
  now(): number;
  /** 返回句柄；实现方负责在 cancel 后不再触发 */
  setTimer(fn: () => void, delayMs: number): TimerId;
  clearTimer(id: TimerId): void;
}
export type TimerId = unknown;

// 默认实现用 Node 定时器；测试注入虚拟时钟
createSystem({ clock });         // 不传 = RealClock
```

- **一个 Actor 世界只有一个时钟源**：定时器、receive-timeout、重试退避、告警评估周期都用它。
- 虚拟时钟的语义：`clock.advance(ms)` 同步推进并把到期的回调按 `dueAt` 排序执行（同一时刻按注册序，保证确定性）。
- 这是后面所有原语能被**确定性测试**的前提，必须先落地。

---

## 1. 定时器

### 1.1 签名

```ts
export interface TimerHandle {
  readonly id: string;
  readonly dueAt: number;          // 绝对时间（clock.now() 参考系）
  readonly active: boolean;
  cancel(): boolean;               // 已触发/已取消 → false
}

export interface ActorContext {
  /** 一次性：delayMs 后向自己投递 msg */
  schedule(delayMs: number, msg: unknown): TimerHandle;
  /** 周期：默认 fixed-delay（上一次处理完再等 intervalMs），可切 fixed-rate */
  scheduleEvery(intervalMs: number, msg: unknown, opts?: {
    mode?: 'fixed-delay' | 'fixed-rate';   // 默认 fixed-delay
    immediate?: boolean;                    // true = 立即先发一次
    maxFires?: number;                      // 到达次数后自动停止
  }): TimerHandle;
  cancelAllTimers(): number;                // 返回取消数量
  readonly timerCount: number;
}
```

### 1.2 语义与边界

| 项 | 设计 |
|---|---|
| 存放位置 | **cell**（不是 actor 实例），所以框架能保证清理；`inspect()` 暴露数量 |
| 投递路径 | 通过邮箱，标记 system 优先级（不被业务消息饿死），消息体是用户给的 `msg`；`envelope.timerId` 供追踪 |
| 实现 | **调度器持有唯一定时器（最小堆/时间轮）**，不是每个 timer 一个 Node timer。1 万 Actor × 1 timer 仍只有 1 个 Node timer |
| fixed-delay vs fixed-rate | 默认 fixed-delay（慢 handler 不会堆积）；fixed-rate 时若上一轮未完成则**跳过并计数**（`counters.timerSkipped++`），文档写明 |
| 重启/崩溃 | **取消该 Actor 全部定时器**；重启后不自动恢复（fresh incarnation）。在 `preStart` 里注册的周期定时器会随重启自动重新武装——这是常见用法，天然正确 |
| 停止 | `stop()` 取消全部定时器；`system.stop()` **不等定时器**（调度器定时器 unref） |
| worker 隔离 | 定时器仍在主线程（cell）持有；worker Actor 里的 `ctx.schedule()` 通过 ctx 代理回主线程注册，到期消息再投递进 worker。到期消息必须可结构化克隆（不可克隆 → 注册时报错，不静默丢） |
| 上限 | `maxTimersPerActor`（默认 1000）；超限抛 `TimerLimitError`（给出 actorPath 与当前值） |
| 精度 | 毫秒；文档声明"不保证精确到毫秒级"，调度粒度 ≥ 10ms（可配） |
| 负数/NaN delay | 抛 `DefinitionError`（显式失败优于静默当成 0） |
| 持久化定时器 | **M0 不做**（远期：事件化 + 重启重新武装 + 停机期间到期的补投策略） |

### 1.3 测试计划

| 用例 | 断言 |
|---|---|
| 一次性定时器按期触发 | 虚拟时钟推进后收到消息，且只收到一次 |
| cancel 生效 | cancel 后推进时钟，不收到消息；`handle.active=false` |
| 周期定时器 | 推进 10×interval → 收到 10 条，`dueAt` 严格递增 |
| fixed-delay 语义 | handler 耗时 2×interval → 不堆积（收到的次数 ≈ 推进时间/耗时，而非 interval 数） |
| fixed-rate 跳过 | 同上但 `mode:'fixed-rate'` → 收到次数更多 + `timerSkipped > 0` |
| 崩溃重启清理 | 注册 5s 炸弹 → 触发崩溃 → 重启后推进 5s → **不触发**，`timerCount=0` |
| preStart 重新武装 | `preStart` 里 scheduleEvery → 崩溃重启后仍会触发 |
| 规模：1 万 Actor × 1 timer | 调度器内部 Node timer 数 = 1；spawn 与推进耗时可接受（对比现状无回归） |
| worker 隔离 | `isolation:'worker'` 的 Actor 能 schedule 并收到消息；注册不可克隆消息 → 报错 |
| 上下限 | 超过 maxTimersPerActor → `TimerLimitError`；`delay=-1` → `DefinitionError` |
| 确定性 | 同一虚拟时钟脚本跑两次，消息顺序完全一致 |
| stop 取消 | `stop()` 后推进时钟无消息；`system.stop()` 不被定时器拖住（预算内返回） |

---

## 2. FSM（状态机）

### 2.1 签名

```ts
export interface StateMachineSpec<S extends string, E extends string> {
  initial: S;
  states: Record<S, Partial<Record<E, S>>>;
  /** 当前状态收到未定义事件时的行为，默认 'error' */
  onUnexpected?: 'error' | 'stash' | 'deadLetter';
  /** 历史长度上限，默认 20 */
  historyLimit?: number;
}

export interface StateMachine<S extends string, E extends string> {
  readonly state: S;
  readonly history: readonly S[];
  can(event: E): boolean;
  transition(event: E): S;                                  // 非法 → DefinitionError
  onTransition(fn: (from: S, to: S, event: E) => void): () => void;  // 返回取消订阅
}

export interface ActorContext {
  stateMachine<S extends string, E extends string>(
    name: string,
    spec: StateMachineSpec<S, E>,
    opts?: { persist?: boolean },                            // 默认 false
  ): StateMachine<S, E>;
}
```

### 2.2 语义与边界

| 项 | 设计 |
|---|---|
| 定位 | M0 只做**显式状态机对象**（可校验、可观测）；OTP 的 `become/unbecome` 行为栈留作远期低层 API（见 doc 06 的取舍） |
| 非法转移 | 默认 `DefinitionError`（fail fast，暴露状态机与调用方的 bug）；`onUnexpected` 可改为 `stash` 或 `deadLetter` |
| 与 `receive` 的关系 | FSM **不接管**消息分发——`receive` 自己 switch。状态机只负责"当前状态 + 合法转移 + 变更通知"（避免隐式魔法，保持可读） |
| 持久化 | `persist: true` 时，当前状态随快照一起存取（存进快照信封的 `__fsm: { [name]: state }`）；恢复时自动回填。默认 `false` → 重启回 `initial` |
| 多状态机 | 一个 Actor 可有多个具名状态机（如 `status` + `phase`） |
| 可观测 | `inspect().fsm = { status: 'opened', phase: 'idle' }`；`history` 便于排障 |
| worker 隔离 | 状态机对象活在 worker 内；状态通过 `ref.state()` 可读（已在 state 里或单独暴露） |
| 恢复冲突 | 快照里的状态在当前 spec 中不存在 → 抛 `DefinitionError`（宁可启动失败，不要带错状态运行） |

### 2.3 测试计划

| 用例 | 断言 |
|---|---|
| 正常转移 | `closed → opened → closed`，`state` 正确 |
| 非法转移 | 抛 `DefinitionError`，消息含 from/event/allowed |
| `can()` | 合法 true，非法 false，且不改变状态 |
| `onUnexpected: stash` | 非法事件被暂存，后续 `unstashAll` 后仍能处理 |
| `onUnexpected: deadLetter` | 进死信，Actor 不崩 |
| `onTransition` 钩子 | 收到 (from,to,event)，取消订阅后不再触发 |
| `persist: true` | 快照恢复后状态保持（跨重启、跨系统） |
| `persist: false` | 重启回 initial |
| 历史有界 | 转移 100 次，`history.length ≤ 20` |
| spec 不匹配 | 快照含未知状态 → 启动报错 |
| inspect | FSM 状态出现在 `inspect()` |
| worker 隔离 | worker Actor 的 FSM 状态可通过 `ref.state()` 读到 |

---

## 3. stash / unstash

### 3.1 签名

```ts
export interface ActorContext {
  /** 暂存当前正在处理的消息；返回 false = 暂存已满（进死信 + 计数） */
  stash(): boolean;
  /** 把暂存消息放回邮箱**队首**，保持原有相对顺序；返回放回数量 */
  unstashAll(): number;
  clearStash(): number;
  readonly stashSize: number;
}
```

### 3.2 语义与边界

| 项 | 设计 |
|---|---|
| 只能暂存"当前消息" | 在 `receive` 之外调用 → `DefinitionError`；同一 handler 内调用两次 → `DefinitionError`（一次只能暂存一条） |
| 顺序 | `unstashAll()` 插回**队首**且保持暂存时的相对顺序（先暂存的先处理） |
| 有界 | 默认 1000（可配 `stashCapacity`）；溢出 → 该消息进死信（`reason:'stash_full'`）+ `counters.stashOverflow++`，**不抛错**（协议驱动的暂存不应该炸掉 Actor） |
| 重启 | 清空 stash（易失，与邮箱内存态一致） |
| 与持久化 | stash **不落盘**（与 `mailbox` 模式的差异要写清：邮箱持久化会重放未确认消息，但 stash 不会） |
| 可观测 | `inspect().stashSize` |

### 3.3 测试计划

| 用例 | 断言 |
|---|---|
| 暂存后放回 | 顺序与暂存顺序一致，且优先于暂存期间到达的新消息（队首语义） |
| 空 stash | `unstashAll()` 返回 0，无副作用 |
| 非法调用 | `receive` 外调用 / 一次调用两次 → `DefinitionError` |
| 溢出 | 超过容量 → 死信 + 计数，Actor 继续可用 |
| 重启清空 | 崩溃重启后 `stashSize=0`，内容不再出现 |
| inspect | 深度可见 |
| 与定时器共存 | 暂存不影响已注册定时器；到期消息按系统优先级进入队列 |

---

## 4. receive-timeout（空闲超时）

### 4.1 签名

```ts
export interface ActorContext {
  /** 0 = 关闭；默认投递 { type: 'receiveTimeout' }，可自定义消息 */
  setReceiveTimeout(ms: number, opts?: { message?: unknown }): void;
  readonly receiveTimeoutMs: number;
}
```

### 4.2 语义与边界

| 项 | 设计 |
|---|---|
| 计时起点 | Actor **变成空闲**时（邮箱空且当前 handler 已完成）开始计时 |
| 重置 | 任何消息到达（含定时器消息）都重置计时 |
| 触发后 | **继续重新计时**（OTP 语义：空闲期间会反复触发）；关闭用 `setReceiveTimeout(0)` |
| 投递路径 | 邮箱（system 优先级），与普通消息同序处理 |
| `dueAt` | 用**时钟**计算，虚拟时钟下可精确测试 |
| 重启 | 不自动恢复（除非在 `preStart` 重新设置） |
| 与 stash 的交互 | stash 不重置计时（stash 是处理中的动作）；文档写明 |
| worker 隔离 | 由 cell 计时，消息进 worker |

### 4.3 测试计划

| 用例 | 断言 |
|---|---|
| 空闲触发 | 推进 ms 后收到超时消息 |
| 忙碌不触发 | handler 耗时 > ms 期间不触发；结束后重新计时 |
| 消息重置 | 中途来消息 → 计时重置（旧超时不触发） |
| 反复触发 | 一直空闲 → 每 ms 触发一次，计数正确 |
| 关闭 | `setReceiveTimeout(0)` 后不再触发 |
| 自定义消息 | `opts.message` 生效 |
| 重启 | 重启后不触发（除非 preStart 重设） |
| 确定性 | 虚拟时钟下触发时刻精确等于 `idleStart + ms` |

---

## 5. 消息校验

### 5.1 签名

```ts
/** 校验器接口：与 zod 的 safeParse 形状对齐，便于适配 */
export interface Validator<T = unknown> {
  parse(input: unknown): T;          // 失败抛错（错误里带结构化 issues）
}

export type FieldSpec = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  optional?: boolean;
  min?: number; max?: number;        // number/string/array 长度
  pattern?: string;                  // string 正则
  enum?: readonly (string | number)[];
  items?: FieldSpec;                 // array
  fields?: Record<string, FieldSpec>;// object
  nullable?: boolean;
};

export interface ActorOptions {
  /** 按 message.type 声明；'*' 为兜底 */
  schema?: Record<string, Record<string, FieldSpec> | Validator> | Validator;
  /** 未声明 type 的消息如何处理：'allow'（默认）| 'reject' */
  unknownMessages?: 'allow' | 'reject';
  /** 校验失败行为：默认 'deadLetter' */
  onInvalid?: 'deadLetter' | 'crash';
}
```

### 5.2 语义与边界

| 项 | 设计 |
|---|---|
| 校验时机 | 出队后、`receive` 前（**不是**入队时）：入队时的校验会让"非法消息"不计数、且影响背压语义 |
| 失败行为 | 默认：**死信**（`reason:'schema'`）+ `counters.invalid++`，**不重启**。这是与"handler 抛错"不同的归类，便于运维区分"非法输入"与"代码 bug" |
| ask 语义 | 非法消息若来自 `ask`，调用方立即收到 `ValidationError`（含字段级 issues），不是超时 |
| 失败响应格式 | `[{ path: 'damage', code: 'max', message: 'must be <= 1000' }]` |
| 未声明 type | 默认放行（向后兼容）；`unknownMessages:'reject'` 时进死信（推荐对外部入口开启） |
| 内置校验器 | 覆盖上表 FieldSpec；零依赖 |
| 适配器 | `validator: zodValidator(zodSchema)` / `ajvValidator(schema)`；web 包提供，core 不依赖 |
| 零开销 | 未配置 schema → 完全跳过（无对象分配、无函数调用） |
| worker 隔离 | **在主线程校验**（出队后、跨线程投递前）：非法数据不进入 worker，也避免线程内再抛错 |
| 与 cluster 的关系 | 跨节点消息同样校验（对端不可信） |
| 性能 | 校验是每消息成本；基准测试要求：有 schema 时单消息开销 < 5µs（简单对象），并给"只对入口 actor 开启"的建议 |

### 5.3 测试计划

| 用例 | 断言 |
|---|---|
| 合法通过 | handler 收到并处理，`counters.invalid=0` |
| 非法 → 死信 | 死信 `reason='schema'`；**Actor 未重启**（`restarts=0`）；Actor 继续可用 |
| ask 立即失败 | 收到 `ValidationError` + issues；耗时刻 < 超时值 |
| 按 type 分别校验 | `hurt` 非法、`move` 合法，互不影响 |
| 未声明 type | 默认放行；`reject` 模式下进死信 |
| `onInvalid:'crash'` | 显式选择时按崩溃处理（可被监督重启） |
| 适配器 | 注入一个假 zod（抛结构化错误）→ issues 正确映射 |
| 零开销 | 无 schema 时的路径与现状一致（对比基准无回归） |
| worker 隔离 | 非法消息在**主线程**被拦（worker 未收到）；计数器正确 |
| 跨节点 | 通过网关发来的非法消息同样进死信 |

---

## 6. 原语 × 现有语义的交互矩阵（实现时必须逐格验证）

| | 崩溃/重启 | 快照恢复 | worker 隔离 | `stop()` | 背压/邮箱满 |
|---|---|---|---|---|---|
| 定时器 | 全部取消（preStart 里的会重装） | 不恢复（M0） | 主线程持有，消息进 worker | 取消 | 到期消息也受邮箱满影响 → 计入 `timerSkipped` |
| FSM | `persist:false` 回 initial / `true` 随快照 | ✅ 支持 | 状态可读 | 无特殊 | 无 |
| stash | 清空 | 不落盘 | 在 worker 内（随实例） | 丢弃 | 满 → 死信 |
| receive-timeout | 不恢复 | 不落盘 | cell 计时 | 取消 | 无 |
| 校验 | 不重启（默认） | 无 | 主线程校验 | 无 | 无 |

## 7. 本节待确认

| # | 事项 | 建议 |
|---|---|---|
| P1 | 定时器默认 fixed-delay | 是（避免慢 handler 堆积）；fixed-rate 显式开启 |
| P2 | FSM 默认 `onUnexpected: 'error'` | 是（fail fast）；协议驱动场景显式改 stash/deadLetter |
| P3 | FSM 状态是否默认持久化 | 默认否（显式 `persist: true`） |
| P4 | stash 容量默认值 | 1000，与邮箱默认一致 |
| P5 | receive-timeout 是否反复触发 | 是（OTP 语义），文档写清 |
| P6 | 校验失败默认死信而非崩溃 | 是；`onInvalid:'crash'` 供需要严格失败的用户 |
| P7 | 原语是"内核内置"还是"M0 以 behavior/mixin 形式提供" | 内核内置（`ctx` 上），但实现按 behavior 组织，便于将来抽出 |
