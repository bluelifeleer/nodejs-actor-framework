import { test } from 'node:test';
import assert from 'node:assert';

import {
  createSnapshotEnvelope,
  decodeSnapshot,
  isSnapshotEnvelope,
  SNAPSHOT_FORMAT_VERSION,
  StateEvolutionError,
} from '../src/index.ts';

test('snapshot: 版本一致时直接用；写出来的是带信封的快照', () => {
  const envelope = createSnapshotEnvelope({ hp: 9 }, { stateVersion: 3, takenAt: 111 });
  assert.deepStrictEqual(envelope, {
    snapshotVersion: SNAPSHOT_FORMAT_VERSION,
    stateVersion: 3,
    takenAt: 111,
    state: { hp: 9 },
  });
  assert.ok(isSnapshotEnvelope(envelope));

  assert.deepStrictEqual(decodeSnapshot(envelope, { version: 3 }), { hp: 9 });
});

test('snapshot: 版本不一致且有迁移 → 迁移后用；迁移拿到 from/to', () => {
  const raw = createSnapshotEnvelope({ hp: 9, hits: 2 }, { stateVersion: 1 });
  const seen: { from: number; to: number }[] = [];
  const migrated = decodeSnapshot(raw, {
    version: 3,
    migrate: (state, meta) => {
      seen.push(meta);
      return { ...(state as object), armor: 5, to: meta.to };
    },
  });
  assert.deepStrictEqual(seen, [{ from: 1, to: 3 }]);
  assert.deepStrictEqual(migrated, { hp: 9, hits: 2, armor: 5, to: 3 });
});

test('snapshot: 版本不一致且没有迁移 → 拒绝（不静默用错结构），错误里指名版本', () => {
  const raw = createSnapshotEnvelope({ hp: 9 }, { stateVersion: 1 });
  assert.throws(
    () => decodeSnapshot(raw, { version: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof StateEvolutionError);
      assert.strictEqual(err.name, 'StateEvolutionError');
      assert.strictEqual(err.found, 1);
      assert.strictEqual(err.expected, 3);
      assert.match(err.message, /v1/);
      assert.match(err.message, /v3/);
      assert.match(err.message, /没有注册迁移函数/);
      return true;
    },
  );
});

test('snapshot: 旧格式（无信封）视为 legacyVersion（默认 1）', () => {
  // 默认：旧快照 = v1；代码期望 v1 时直接用
  assert.deepStrictEqual(decodeSnapshot({ hp: 1 }, { version: 1 }), { hp: 1 });
  // 代码期望 v2 且注册了迁移 → 旧快照按 v1 迁移
  assert.deepStrictEqual(
    decodeSnapshot({ hp: 1 }, { version: 2, migrate: (state, { from }) => ({ ...(state as object), from }) }),
    { hp: 1, from: 1 },
  );
  // 存量快照其实不是"新方案第 1 版"时，用 legacyVersion 说明
  assert.deepStrictEqual(decodeSnapshot({ hp: 1 }, { version: 4, legacyVersion: 4 }), { hp: 1 });
  // 期望 v4 但没有迁移 → 拒绝，且 found 是 legacyVersion
  assert.throws(
    () => decodeSnapshot({ hp: 1 }, { version: 4, legacyVersion: 2 }),
    (err: unknown) => err instanceof StateEvolutionError && err.found === 2 && err.expected === 4,
  );
});

test('snapshot: 信封格式比代码新 → 拒绝（旧代码不得猜新格式）', () => {
  assert.throws(
    () => decodeSnapshot({ snapshotVersion: 99, stateVersion: 1, takenAt: 0, state: { hp: 1 } }, { version: 1 }),
    /信封格式 v99 比本代码支持的 v1 更新/,
  );
});

test('snapshot: 工具与入参校验', () => {
  assert.strictEqual(isSnapshotEnvelope({ state: {} }), false, '缺版本字段不算信封');
  assert.strictEqual(isSnapshotEnvelope({ stateVersion: 1, state: {} }), false, '缺 snapshotVersion 不算信封');
  assert.strictEqual(isSnapshotEnvelope(null), false);

  assert.throws(() => createSnapshotEnvelope({}, { stateVersion: 0 }), /stateVersion 必须是 >= 1/);
  assert.throws(() => decodeSnapshot({}, { version: 0 }), /schema.version 必须是 >= 1/);
});
