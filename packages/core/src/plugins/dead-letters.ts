// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const defaultQueue = require('../store/dead-letter-queue.ts');
const { DeadLetterQueue } = require('../store/dead-letter-queue.ts');

/**
 * Durable dead letters.
 *
 * The system always keeps a bounded in-memory view; this plugin adds the
 * durable record by reusing the file-backed dead-letter queue (bounded growth,
 * tolerant line parsing, `list`/`size`/`clear`).
 *
 *   createSystem({ plugins: [deadLetters()] })                       // default path
 *   createSystem({ plugins: [deadLetters({ path: './my-dlq.jsonl' })] })
 */
/** 插件配置：给 `store` 就用它，否则按 `path`/`baseDir` 建一个文件队列，都没有就用默认队列。 */
interface DeadLettersOptions {
  store?: { init?: () => Promise<void> } | null;
  path?: string;
  baseDir?: string;
  maxEntries?: number;
}

/** 结构型 system 视图（见 rate-limit.ts 的说明）。 */
interface DeadLettersSystem {
  deadLetterStore: unknown;
}

function deadLetters(options: DeadLettersOptions = {}) {
  return {
    name: 'deadLetters',

    async setup(system: DeadLettersSystem) {
      let store = options.store || null;
      if (!store) {
        store = options.path || options.baseDir
          ? new DeadLetterQueue({
            baseDir: options.baseDir || undefined,
            filePath: options.path || undefined,
            maxEntries: options.maxEntries,
          })
          : defaultQueue;
      }
      if (store !== null && typeof (store as { init?: () => Promise<void> }).init === 'function') {
        await (store as { init: () => Promise<void> }).init();
      }
      system.deadLetterStore = store;
    },

    teardown(system: DeadLettersSystem | null) {
      if (system) system.deadLetterStore = null;
    },
  };
}

module.exports = deadLetters;
module.exports.deadLetters = deadLetters;
