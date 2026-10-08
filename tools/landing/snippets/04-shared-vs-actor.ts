// 同一件事的三种写法：20 个并发请求，每个给账户加 1（读-改-写之间都有一段 await，
// 真实系统里那就是 `await db.get()` / 网络往返 —— 也就是交错真正发生的窗口）。
//
// 三种写法都**真跑**（断言在文件末尾），结果稳定可复现：
//   ① 裸共享状态      → 1   （20 次里 19 次被覆盖）
//   ② 共享状态 + 手动串行 → 20
//   ③ Actor（状态私有 + 消息串行）→ 20
//
// 结论不是"共享状态一定错"，而是：**互斥要由你负责**（漏一处就前功尽弃），
// Actor 把"互斥"变成执行模型的一部分（同一个 Actor 的消息天然串行）。
import assert from 'node:assert';

import { createSystem } from 'nodejs-actor-framework';

const N = 20;

// ---------------------------------------------------------------- ① 裸共享状态
let bare = 0;
async function debitBare(amount: number): Promise<void> {
  const current = bare; // 读
  await Promise.resolve(); // 让出：真实系统里就是一次 IO
  bare = current + amount; // 改-写（这一步会把别人刚写的值覆盖掉）
}

// ------------------------------------------------- ② 共享状态 + 手动串行（当锁用）
let locked = 0;
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
async function debitLocked(amount: number): Promise<void> {
  const current = locked;
  await Promise.resolve();
  locked = current + amount;
}

// --------------------------------------------------------- ③ Actor：状态私有 + 串行
const Account = {
  preStart(this: { state: { balance: number } }) {
    this.state = { balance: 0 };
  },
  // 与上面两段**形状完全相同**的读-改-写（连 await 的位置都一样）
  async receive(this: { state: { balance: number } }, msg: { amount: number }) {
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
// 内核的 ask 签名不带泛型（回复类型运行时才知道），这里显式收窄一次
const actor = (await account.ask({ amount: 0 }, 5000)) as number; // amount: 0 = 只读回当前值
await system.stop();

assert.strictEqual(bare, 1, '裸共享状态：20 个并发只留下 1（19 次更新被覆盖）');
assert.strictEqual(locked, N, '加了互斥就对了 —— 但互斥要你自己保证，漏一处就回到 ①');
assert.strictEqual(actor, N, 'Actor：同一个 Actor 的消息串行处理，一条都不丢');

console.log(`bare=${bare} locked=${locked} actor=${actor}`);
