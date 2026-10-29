import { test } from 'node:test';
import assert from 'node:assert';

import {
  DbDriverMissingError,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
  type DriverResolver,
} from '@actor/resource';

import { defineCollection, describeMongo, mongoAdapter, mongoPoolOptions, parseMongoUrl, resolveMongoDriver } from '../src/index.ts';
import { createFakeMongoDriver, type FakeMongoDriver } from './fake-mongo-driver.ts';

/**
 * MongoDB 适配器测试：**同一套连接管理契约** + 驱动专属断言
 * （池参数映射、事务走 session、逃生通道、事件只转发、集合 sync 端到端）。
 */
function resolverFor(driver: FakeMongoDriver | null): DriverResolver {
  return (specifier: string) => {
    if (driver !== null && specifier === 'mongodb') return driver.module;
    const error = new Error(`Cannot find module '${specifier}'`);
    (error as { code?: string }).code = 'MODULE_NOT_FOUND';
    throw error;
  };
}

const Event = defineCollection({
  name: 'events',
  fields: {
    type: { type: 'string', required: true },
    at: { type: 'date', auto: 'create' },
    version: { type: 'integer', version: true },
  },
  indexes: [{ fields: ['type', 'at'] }],
  validator: { strict: true },
});

function makeTarget() {
  const driver = createFakeMongoDriver();
  const make: ContractResourceFactory = (input) =>
    supervise(mongoAdapter(), {
      connection: { url: 'mongodb://127.0.0.1:27017/app' },
      resolve: resolverFor(driver),
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });
  const makeFailing: ContractResourceFactory = (input) => {
    const broken = createFakeMongoDriver();
    broken.setHealthy(false);
    return supervise(mongoAdapter(), {
      connection: { url: 'mongodb://127.0.0.1:27017/app' },
      resolve: resolverFor(broken),
      onEvent: input.onEvent,
    });
  };
  return { driver, make, makeFailing };
}

const target = makeTarget();

runManagedConnectionContract({
  name: 'mongodb',
  make: target.make,
  makeFailing: target.makeFailing,
  supportsKeepAlive: true,
  setHealthy: target.driver.setHealthy,
});

test('mongodb adapter: 池参数映射到官方驱动字段名（maxPoolSize/minPoolSize/maxIdleTimeMS/serverSelectionTimeoutMS）', async () => {
  const driver = createFakeMongoDriver();
  const resource = supervise(mongoAdapter(), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    pool: { min: 2, max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
    resolve: resolverFor(driver),
  });
  await resource.connect();
  try {
    assert.strictEqual(driver.state.url, 'mongodb://127.0.0.1:27017/app');
    assert.deepStrictEqual(driver.state.clientOptions, {
      maxPoolSize: 20,
      minPoolSize: 2,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 5_000,
    });
    assert.deepStrictEqual(mongoPoolOptions({ max: 5 }), { maxPoolSize: 5 });
    assert.deepStrictEqual(mongoPoolOptions({}), {}, '没给的键不该出现');
  } finally {
    await resource.close();
  }
});

test('mongodb adapter: 集合薄封装 + 逃生通道（withDb/raw）都能用', async () => {
  const driver = createFakeMongoDriver();
  const resource = supervise(mongoAdapter(), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(driver),
  });
  await resource.connect();
  try {
    const db = await resource.acquire();
    const inserted = await db.collection('events').insertOne({ type: 'created' });
    assert.ok(inserted.insertedId !== undefined);
    assert.strictEqual(await db.collection('events').countDocuments({ type: 'created' }), 1);
    const found = await db.collection('events').findOne({ type: 'created' });
    assert.strictEqual(found?.type, 'created');
    // `find()` 返回的是**原生游标**（薄封装直接转调，不做假 promise），所以用 toArray()
    const cursor = db.collection('events').find() as { toArray(): Promise<unknown[]> };
    assert.strictEqual((await cursor.toArray()).length, 1);

    // 逃生通道
    const raw = await db.withDb(async (native) => native.collection('events').countDocuments({}));
    assert.strictEqual(raw, 1);
    assert.ok(db.raw !== undefined, 'raw 应当是原生客户端');
    assert.ok(db.db !== undefined, 'db 应当是原生 db');
  } finally {
    await resource.close();
  }
});

test('mongodb adapter: 事务走 session.withTransaction（与 SQL 侧同签名）', async () => {
  const driver = createFakeMongoDriver();
  const resource = supervise(mongoAdapter(), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(driver),
  });
  await resource.connect();
  try {
    const db = await resource.acquire();
    const result = await db.transaction(async (scoped) => {
      await scoped.collection('events').insertOne({ type: 'in-tx' });
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(driver.state.sessions, 1, '事务必须开一个 session');
    const inTx = driver.state.operationOptions.filter((options) => options?.session === driver.state.lastSession);
    assert.ok(inTx.length >= 1, '事务里的每个操作都必须带 session（不能只开一个空会话）');
    assert.strictEqual(await db.collection('events').countDocuments({ type: 'in-tx' }), 1);
  } finally {
    await resource.close();
  }
});

test('mongodb adapter: 驱动事件只被转发（框架不自己重连）', async () => {
  const driver = createFakeMongoDriver();
  const events: Array<{ type: string; event?: string }> = [];
  const resource = supervise(mongoAdapter(), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(driver),
    onEvent: (event) => events.push({ type: event.type, ...('event' in event ? { event: String(event.event) } : {}) }),
  });
  await resource.connect();
  driver.fire('serverHeartbeatFailed', { message: '心跳超时' });
  await resource.close();
  const forwarded = events.filter((event) => event.type === 'driver_event').map((event) => event.event);
  assert.ok(forwarded.includes('open'), `open 应当被转发：${JSON.stringify(forwarded)}`);
  assert.ok(forwarded.includes('serverHeartbeatFailed'), `驱动事件应当原样转发：${JSON.stringify(forwarded)}`);
});

test('mongodb adapter: 声明式集合 —— 建集合/索引；validator 漂移默认报错，auto 才改', async () => {
  // 全新库：connect 时建集合 + 索引
  const fresh = createFakeMongoDriver();
  const created = supervise(mongoAdapter({ collections: [Event] }), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(fresh),
  });
  await created.connect();
  // 断言"集合真的建了"要用 listCollections（docs 那个 Map 是文档存储，不是集合目录）
  assert.strictEqual((await fresh.db.listCollections({ name: 'events' }).toArray()).length, 1, '集合应当被建出来');
  assert.deepStrictEqual(fresh.db.indexCommands.map((cmd) => cmd.name), ['events_type_at']);
  await created.close();

  // 已有的集合 + 旧 validator → 默认报错（不偷偷改）
  const drifted = createFakeMongoDriver();
  await drifted.db.createCollection('events', { validator: { $jsonSchema: { bsonType: 'object', properties: {} } } });
  const strict = supervise(mongoAdapter({ collections: [Event] }), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(drifted),
  });
  await assert.rejects(() => strict.connect(), /drifted from the declarations/);

  // auto: true → collMod 应用新 validator
  const auto = createFakeMongoDriver();
  await auto.db.createCollection('events', { validator: { $jsonSchema: { bsonType: 'object', properties: {} } } });
  const applied = supervise(mongoAdapter({ collections: [Event], auto: true }), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(auto),
  });
  await applied.connect();
  const collMod = auto.db.commands.find((cmd) => 'collMod' in cmd);
  assert.ok(collMod, 'auto: true 时应当发 collMod');
  assert.deepStrictEqual(collMod.validator, { $jsonSchema: Event.jsonSchema });
  await applied.close();
});

test('mongodb adapter: 没装驱动要有安装提示；不认识的驱动名要报错', async () => {
  const resource = supervise(mongoAdapter(), {
    connection: { url: 'mongodb://127.0.0.1:27017/app' },
    resolve: resolverFor(null),
  });
  await assert.rejects(
    () => resource.connect(),
    (err: unknown) => {
      assert.ok(err instanceof DbDriverMissingError);
      assert.match((err as Error).message, /npm i mongodb/);
      return true;
    },
  );
  assert.throws(() => resolveMongoDriver('mongoose'), /unknown mongodb driver "mongoose"/);
  assert.strictEqual(resolveMongoDriver('mongodb').packageName, 'mongodb');
});

test('mongodb adapter: DSN 解析与免密描述（mongodb+srv / authSource / TLS）', () => {
  const plain = parseMongoUrl('mongodb://user:secret@db.internal:27017/app?authSource=admin');
  assert.strictEqual(plain.host, 'db.internal');
  assert.strictEqual(plain.port, 27017);
  assert.strictEqual(plain.database, 'app');
  assert.strictEqual(plain.authSource, 'admin');
  assert.strictEqual(plain.tls, false);
  assert.strictEqual(describeMongo(plain), 'mongodb://db.internal:27017/app?authSource=admin');
  assert.ok(!describeMongo(plain).includes('secret'), '描述里绝不能有密码');

  const srv = parseMongoUrl('mongodb+srv://user:pw@cluster.example.net/app?tls=true');
  assert.strictEqual(srv.tls, true);
  assert.strictEqual(srv.port, undefined, 'SRV 没有端口');
  assert.strictEqual(parseMongoUrl('mongodb://localhost').database, undefined);
  assert.throws(() => parseMongoUrl('redis://x'), /must start with mongodb:\/\//);
});
