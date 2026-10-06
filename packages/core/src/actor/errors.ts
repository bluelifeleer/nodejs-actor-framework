// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/** Base class for everything this framework throws. */
class ActorFrameworkError extends Error {
  /** 错误详情会被**平铺**到错误对象上（例如 `err.actorId`），便于日志与断言。 */
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, details);
  }
}

/** The user's actor definition is not usable. */
class DefinitionError extends ActorFrameworkError {}

/** The mailbox rejected the message because it is full. */
class MailboxFullError extends ActorFrameworkError {}

/** `ask()` did not receive a reply in time. */
class AskTimeoutError extends ActorFrameworkError {}

/** The target actor is stopped, dead, or was never started. */
class ActorStoppedError extends ActorFrameworkError {}

/** No actor is registered under that id/path. */
class ActorNotFoundError extends ActorFrameworkError {}

/** Persistence failed. */
class PersistenceError extends ActorFrameworkError {}

/**
 * A conditional append lost the race: the log already moved past the version the
 * caller expected. Nothing was written.
 *
 * This is the storage-level half of optimistic concurrency (see
 * docs/design/m3-data-evolution.md §6.4): it catches "the same aggregate is owned
 * by two nodes at once". Whether the check is atomic across processes depends on
 * the backend — `adapter.capabilities().conditionalAppend` says which.
 */
class PersistenceConflictError extends PersistenceError {}

/**
 * Raised inside a supervisor when a child exceeded its restart intensity:
 * the supervisor escalates by failing itself, so its own parent decides.
 */
class EscalationError extends ActorFrameworkError {}

module.exports = {
  ActorFrameworkError,
  DefinitionError,
  MailboxFullError,
  AskTimeoutError,
  ActorStoppedError,
  ActorNotFoundError,
  PersistenceError,
  PersistenceConflictError,
  EscalationError,
};
