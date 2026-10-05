/**
 * Outbox（M3 第 5 步）：**用事件日志当 outbox** + 投递游标 + 至少一次 + 消费幂等。
 */

export {
  OutboxDeliveryError,
  OutboxError,
  type OutboxCursorStore,
  type OutboxEntry,
  type OutboxLogReader,
  type OutboxStats,
} from './types.ts';

export {
  createFileOutboxCursor,
  createMemoryOutboxCursor,
  createOutboxLogReader,
  createSqlOutboxCursor,
  type FileOutboxCursorOptions,
  type OutboxLogReaderOptions,
  type OutboxSqlRunner,
  type SqlOutboxCursorOptions,
} from './stores.ts';

export {
  createDedupeSet,
  createIdempotentConsumer,
  createOutboxDispatcher,
  type DedupeSet,
  type IdempotentConsumerOptions,
  type OutboxDispatcher,
  type OutboxDispatcherOptions,
  type OutboxDrainResult,
} from './dispatcher.ts';
