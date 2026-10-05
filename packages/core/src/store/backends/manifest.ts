// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Actor-id manifest.
 *
 * On-disk names are derived from a hash of the actor id, so the id itself
 * cannot be recovered from a filename. Operational tooling (migration, size
 * reporting, "which actors have state?") therefore needs an explicit index.
 *
 * The manifest is best-effort: a missing or corrupt file is treated as empty
 * and rebuilt as actors write again, because it is derived data, not a source
 * of truth.
 */
class Manifest {
  constructor(baseDir, fileName = 'manifest.json') {
    this.baseDir = baseDir;
    this.path = path.join(baseDir, fileName);
    this.entries = null;
    this._chain = Promise.resolve();
  }

  async _load() {
    if (this.entries) return this.entries;
    try {
      const raw = await fsp.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.entries = parsed && typeof parsed === 'object' && parsed.actors ? parsed.actors : {};
    } catch {
      this.entries = {};
    }
    return this.entries;
  }

  /** Remember that `actorId` lives in `file`. Cheap when already recorded. */
  async record(actorId, file) {
    const entries = await this._load();
    const key = String(actorId);
    if (entries[key] && entries[key].file === file) return false;
    entries[key] = { file, updatedAt: Date.now() };
    this._chain = this._chain
      .then(() => this._persist())
      .catch(() => {});
    await this._chain;
    return true;
  }

  async remove(actorId) {
    const entries = await this._load();
    delete entries[String(actorId)];
    this._chain = this._chain
      .then(() => this._persist())
      .catch(() => {});
    await this._chain;
  }

  async _persist() {
    const entries = await this._load();
    const tmp = `${this.path}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify({ version: 1, actors: entries }, null, 2)}\n`);
    await fsp.rename(tmp, this.path);
  }

  /** @returns {Promise<Array<{actorId:string, file:string, updatedAt:number}>>} */
  async list() {
    const entries = await this._load();
    return Object.entries(entries)
      .map(([actorId, meta]) => ({ actorId, file: meta.file, updatedAt: meta.updatedAt || 0 }))
      .sort((a, b) => a.actorId.localeCompare(b.actorId));
  }

  exists() {
    return fs.existsSync(this.path);
  }
}

module.exports = Manifest;
module.exports.Manifest = Manifest;
