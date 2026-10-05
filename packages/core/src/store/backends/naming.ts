// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const crypto = require('crypto');

function slugify(raw, pattern) {
  return raw
    .replace(pattern, '_')
    .replace(/^[_-]+/, '')
    .replace(/[_-]+$/, '')
    .slice(0, 40) || 'actor';
}

function hashOf(raw) {
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * Traversal-safe, collision-resistant on-disk name for an actor id.
 * Used by every disk-backed store so an actor id like "../../etc/passwd"
 * can never escape the data directory.
 */
function fileName(actorId, extension = '.log') {
  const raw = String(actorId);
  return `${slugify(raw, /[^A-Za-z0-9_-]+/g)}__${hashOf(raw)}${extension}`;
}

/**
 * The pre-1.1 on-disk name (`<slug>__<sha1-16>.jsonl`), kept so existing
 * deployments can be migrated to the framed log automatically. The old slug
 * allowed dots, so the name is not always derivable from the new scheme.
 */
function legacyFileName(actorId) {
  const raw = String(actorId);
  return `${slugify(raw, /[^A-Za-z0-9._-]/g)}__${hashOf(raw)}.jsonl`;
}

module.exports = { fileName, legacyFileName };
