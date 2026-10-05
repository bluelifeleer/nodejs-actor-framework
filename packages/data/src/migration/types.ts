/**
 * 迁移框架（M3 第 4 步，doc 04 §5）。
 *
 * 三条纪律，设计都围绕它们：
 *   1. **版本表是真相**：已应用（或执行到一半）的迁移记在数据层自己的 store 里；
 *   2. **默认拒绝启动**：有未应用的迁移时不让应用带着旧结构跑（`assertMigrationsApplied`）；
 *   3. **幂等 + 可重入**：一个迁移执行到一半崩溃，版本表里留下 `started` 记录——
 *      框架能**指出是哪个**，下次 `migrate()` 会重跑它（所以你的 `up()` 必须幂等）。
 *
 * 与"回填"的分工（doc 04 §5）：迁移改结构（快、必须幂等）；回填搬数据（大表、要能在线跑）。
 * 这里只做迁移。
 */

/** 版本表里的一条记录。 */
export interface MigrationRecord {
  version: number;
  status: 'started' | 'completed';
  description?: string;
  at: number;
}

/** 版本表（数据层自己的存储）。三个适配器：memory / file / sql。 */
export interface MigrationStore {
  read(): Promise<MigrationRecord[]>;
  /** 写入/覆盖某个版本的状态（幂等：同一版本重复写就是覆盖）。 */
  write(record: MigrationRecord): Promise<void>;
  /** 抹掉某个版本（回滚时用）。 */
  remove(version: number): Promise<void>;
  /** 需要建表/建目录的适配器在这里做（幂等）。 */
  ensure?(): Promise<void>;
}

export interface MigrationContext {
  store: MigrationStore;
  log(message: string, meta?: unknown): void;
}

export interface Migration {
  /** 从 1 开始的整数，全局唯一且单调（不要求连续）。 */
  version: number;
  description?: string;
  /** 幂等：中途崩溃后会被重跑。 */
  up(context: MigrationContext): Promise<void> | void;
  /** 可选：能回滚就写；`rollback()` 遇到没有 down 的迁移会明确报错。 */
  down?(context: MigrationContext): Promise<void> | void;
}

/** 迁移相关的错误基类。 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 有未应用的迁移：**默认拒绝启动**（防"旧结构跑新代码"）。 */
export class MigrationPendingError extends MigrationError {
  readonly pending: number[];
  constructor(pending: number[]) {
    super(
      `有 ${pending.length} 个迁移尚未应用：v${pending.join(', v')}。` +
        '默认拒绝启动（防"旧结构跑新代码"）；请先执行 migrate()，或显式声明你接受风险',
    );
    this.pending = pending;
  }
}

/** 上次执行中断（版本表里是 `started`）：需要重跑（你的 up() 必须幂等）。 */
export class MigrationInterruptedError extends MigrationError {
  readonly versions: number[];
  constructor(versions: number[]) {
    super(
      `有迁移执行到一半就中断了：v${versions.join(', v')} —— 版本表里是 started 而不是 completed。` +
        '重跑 migrate() 会再次执行它们（up() 必须幂等）',
    );
    this.versions = versions;
  }
}

/** 定义写错，或数据里的版本比代码还新（说明代码该升级了）。 */
export class MigrationVersionError extends MigrationError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`迁移定义/版本有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i}`).join('\n'));
    this.issues = issues;
  }
}
