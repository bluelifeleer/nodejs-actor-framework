/**
 * ESM 入口（**仓库内开发用**）：把 CJS **源码**显式重导出为具名导出。
 *
 * 为什么需要第二个包装：CJS 的具名导出探测（cjs-module-lexer）认不全本包的公共名，
 * 所以 ESM 用户必须走"手写重导出列表"这条路（见 index.mjs 的说明）。
 * 而仓库内要的是**零构建**：改完 `src/` 立刻生效。两者不能共用一个文件 ——
 * 于是 `development` 条件指向这里（导入 src），发布形态的 `import` 指向 index.mjs（导入 dist）。
 * 两个文件的**具名导出列表必须一致**，由 test/unit-package-shape.test.js 断言。
 *
 * 为什么指向 `dist/`：发布形态的默认入口是编译产物（见 package.json 的 exports 条件）；
 * 仓库内跑测试/示例时由 `development` 条件解析到 `src/index.ts`（零构建），不会走这里。
 *
 * 为什么不直接让 Node 从 CJS 推导具名导出：那依赖 cjs-module-lexer 的启发式分析，
 * 实测本包的公共名里只有一小半能被识别（`plugins`、全部错误类等都拿不到），
 * 于是 `import { ActorStoppedError } from 'nodejs-actor-framework'` 会直接报错，
 * 而 `require` 一切正常——只有 ESM 用户踩坑。显式列出是唯一可靠的方式。
 */
import cjs from './src/index.ts';

export default cjs;

export const {
  // 可注入时钟
  createRealClock,
  // 日志适配
  createLogAdapter,
  // 集群治理（一致性哈希环：所有权 = ownerOfShard(ring, shard)）
  ring,
  // 集群治理（所有权守卫 + fencing：createOwnershipGuard）
  ownership,
  // 编程模型
  Actor,
  defineActor,
  ActorDefinition,
  createSystem,
  ActorSystem,
  ActorRef,
  DeadLetterRef,
  // 位置透明
  RemoteRef,
  Peer,
  // 枚举与辅助
  RestartStrategy,
  Overflow,
  // 可选能力（插件）
  plugins,
  cluster,
  pubsub,
  metrics,
  tracing,
  deadLetters,
  rateLimit,
  // 持久化/监督/邮箱
  MemoryPersistence,
  FilePersistence,
  ChildSupervisor,
  Mailbox,
  // 错误类型
  ActorFrameworkError,
  DefinitionError,
  MailboxFullError,
  AskTimeoutError,
  ActorStoppedError,
  ActorNotFoundError,
  PersistenceError,
  EscalationError,
} = cjs;
