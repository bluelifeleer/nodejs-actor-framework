// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
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
function deadLetters(options = {}) {
  return {
    name: 'deadLetters',

    async setup(system) {
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
      if (typeof store.init === 'function') await store.init();
      system.deadLetterStore = store;
    },

    teardown(system) {
      if (system) system.deadLetterStore = null;
    },
  };
}

module.exports = deadLetters;
module.exports.deadLetters = deadLetters;
