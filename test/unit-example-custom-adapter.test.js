import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * **用户自装适配器**的验收（设计见 docs/design/m7-multi-database.md §8）。
 *
 * 两件事：
 *   1. 示例里的自装适配器要过**同一套**连接管理契约（`runManagedConnectionContract`）——
 *      这正是把契约套件放在 `@actor/db-core` 的 `src/`（而不是 `test/`）的意义：
 *      **发布出去的包**里带着它，使用者能拿它自证合规；
 *   2. 客户端语义（写/读/list/删）与"关闭时落盘"要对。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_FILE = path.join(ROOT, 'examples/app-multi-db/src/json-store-adapter.ts');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-json-store-'));
  return path.join(dir, 'store.json');
}

test('example custom adapter: 用同一套连接管理契约自证合规', async () => {
  const core = await import('@actor/db-core');
  const { jsonStoreAdapter } = await import(pathToFileURL(ADAPTER_FILE).href);
  const file = tempFile();
  // 落到一个"不可能是文件"的路径（父级是文件）→ 建连必然失败
  const impossible = path.join(file, 'nested', 'store.json');
  fs.writeFileSync(file, '{}');

  const make = ({ onEvent, drainTimeoutMs, healthCheckIntervalMs }) =>
    core.supervise(jsonStoreAdapter(), {
      connection: { kind: 'json-store', filename: file },
      onEvent,
      ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
      ...(healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs }),
    });
  const makeFailing = ({ onEvent }) =>
    core.supervise(jsonStoreAdapter(), { connection: { kind: 'json-store', filename: impossible }, onEvent });

  core.runManagedConnectionContract({ name: 'json-store(example)', make, makeFailing });
});

test('example custom adapter: 客户端语义（写/读/list/删）与关闭时落盘', async () => {
  const { jsonStoreAdapter } = await import(pathToFileURL(ADAPTER_FILE).href);
  const { supervise } = await import('@actor/db-core');
  const file = tempFile();

  const resource = supervise(jsonStoreAdapter(), { connection: { kind: 'json-store', filename: file } });
  await resource.connect();
  const store = await resource.acquire();

  assert.strictEqual(await store.get('missing'), null);
  await store.set('a', { n: 1 });
  assert.deepStrictEqual(await store.get('a'), { n: 1 });
  assert.deepStrictEqual((await store.list()).sort(), ['a']);
  assert.strictEqual(await store.delete('a'), true);
  assert.strictEqual(await store.delete('a'), false);
  assert.deepStrictEqual(await store.list(), []);

  await store.set('persisted', 'yes');
  await resource.close(); // 关闭必须落盘

  const reopened = supervise(jsonStoreAdapter(), { connection: { kind: 'json-store', filename: file } });
  await reopened.connect();
  try {
    const store2 = await reopened.acquire();
    assert.strictEqual(await store2.get('persisted'), 'yes', '关闭后应当能从文件里读回来');
  } finally {
    await reopened.close();
  }
});

test('example custom adapter: 驱动事件原样转发（框架只转发，不解释）', async () => {
  const { jsonStoreAdapter } = await import(pathToFileURL(ADAPTER_FILE).href);
  const { supervise } = await import('@actor/db-core');
  const file = tempFile();
  const events = [];
  const resource = supervise(jsonStoreAdapter(), {
    connection: { kind: 'json-store', filename: file },
    onEvent: (event) => events.push(event.type === 'driver_event' ? `driver_event:${String(event.event)}` : event.type),
  });
  await resource.connect();
  await resource.close();
  assert.ok(
    events.some((event) => event.startsWith('driver_event:')),
    `自装适配器也可以报驱动事件并被转发：${JSON.stringify(events)}`,
  );
});
