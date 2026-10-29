import { test } from 'node:test';
import assert from 'node:assert';

import {
  checkCollectionDrift,
  defineCollection,
  syncCollections,
} from '../src/collection-model.ts';
import { createFakeMongoDb } from './fake-mongo.ts';

/**
 * `defineCollection` 的**声明 → `$jsonSchema` → sync/漂移**。
 *
 * 诚实边界（设计文档 §6.3）：MongoDB 是 schemaless —— **没有 `$jsonSchema` validator 的集合无法谈字段漂移**，
 * 只能检索引漂移。这一条必须有测试盯着，否则"漂移检测"听起来比实际能做到的多。
 */
const Events = defineCollection({
  name: 'events',
  description: '领域事件',
  fields: {
    _id: { type: 'objectId' },
    type: { type: 'string', required: true, description: '事件类型' },
    payload: { type: 'object' },
    tags: { type: 'array', items: 'string' },
    at: { type: 'date', auto: 'create' },
    seq: { type: 'integer' },
    score: { type: 'double' },
    ok: { type: 'boolean' },
    blob: { type: 'binary' },
    version: { type: 'integer', version: true },
  },
  indexes: [
    { fields: ['type', 'at'] },
    { fields: ['seq'], unique: true },
  ],
  validator: { strict: true },
});

test('collection: defineCollection 归一字段与索引（确定性索引名）', () => {
  assert.strictEqual(Events.name, 'events');
  assert.deepStrictEqual(Events.primaryKey, '_id');
  assert.strictEqual(Events.versionField, 'version');
  assert.deepStrictEqual(
    Events.indexes.map((index) => index.name),
    ['events_type_at', 'events_seq'],
    '索引名要确定（默认 `${集合名}_${字段列表}`），否则每次 sync 都会建新索引',
  );
  assert.strictEqual(Events.indexes[1].unique, true);
  assert.deepStrictEqual(Events.autoCreateFields, ['at']);
  assert.deepStrictEqual(Events.autoUpdateFields, []);
});

test('collection: $jsonSchema 逐类型对照（含 int/long、可空、strict）', () => {
  const schema = Events.jsonSchema as Record<string, unknown>;
  assert.strictEqual(schema.bsonType, 'object');
  assert.strictEqual(schema.additionalProperties, false, 'strict: true → 不许出现未声明字段');
  assert.strictEqual(schema.description, '领域事件');
  assert.deepStrictEqual(schema.required, ['type'], '只有 required: true 的才进 required');

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepStrictEqual(properties._id, { bsonType: 'objectId' });
  assert.deepStrictEqual(properties.type, { bsonType: 'string', description: '事件类型' });
  // 可选字段允许缺省，也允许显式 null（MongoDB 里 null 是常态）
  assert.deepStrictEqual(properties.payload.bsonType, ['object', 'null']);
  assert.deepStrictEqual(properties.tags, { bsonType: ['array', 'null'], items: { bsonType: 'string' } });
  assert.deepStrictEqual(properties.at.bsonType, ['date', 'null']);
  assert.deepStrictEqual(properties.seq.bsonType, ['int', 'long', 'null'], 'MongoDB 的整数是 int 或 long');
  assert.deepStrictEqual(properties.score.bsonType, ['double', 'int', 'long', 'decimal', 'null']);
  assert.deepStrictEqual(properties.ok.bsonType, ['bool', 'null']);
  assert.deepStrictEqual(properties.blob.bsonType, ['binData', 'null']);
  // 必填字段不允许 null
  assert.deepStrictEqual(properties.type.bsonType, 'string');
});

test('collection: 没有字段声明时不生成 validator（不假装能做字段漂移）', () => {
  const loose = defineCollection({ name: 'loose' });
  assert.strictEqual(loose.jsonSchema, null, '没有 fields 就不该编一个 $jsonSchema 出来');
});

test('collection: sync —— 缺集合就建（带 validator）、缺索引就建、报告如实', async () => {
  const db = createFakeMongoDb();
  const report = await syncCollections(db, [Events]);
  assert.deepStrictEqual(report.created, ['events']);
  assert.deepStrictEqual(report.indexes.sort(), ['events_seq', 'events_type_at']);
  assert.deepStrictEqual(report.drift, []);
  assert.deepStrictEqual(report.validatorApplied, ['events']);

  // 幂等：再跑一次什么都不做
  const again = await syncCollections(db, [Events]);
  assert.deepStrictEqual(again.created, []);
  assert.deepStrictEqual(again.indexes, []);
  assert.deepStrictEqual(again.drift, []);
});

test('collection: validator 不一致属于漂移 —— 默认报错，auto: true 才 collMod', async () => {
  const db = createFakeMongoDb({
    collections: {
      events: {
        validator: { $jsonSchema: { bsonType: 'object', properties: {} } }, // 旧 validator
        indexes: [{ name: 'events_type_at', keys: { type: 1, at: 1 } }],
      },
    },
  });

  // 默认：只检测、不改（与 SQL 侧 migrations.auto 的纪律一致）
  const strictReport = await syncCollections(db, [Events]);
  assert.deepStrictEqual(strictReport.validatorApplied, [], '默认不该偷偷改 validator');
  assert.ok(
    strictReport.drift.some((item) => item.kind === 'validator' && item.collection === 'events'),
    `validator 不一致必须被报成漂移：${JSON.stringify(strictReport.drift)}`,
  );
  assert.deepStrictEqual(db.commands.filter((cmd) => 'collMod' in cmd), [], '默认不许发 collMod');

  // auto: true → 明确要求应用变更
  const autoReport = await syncCollections(db, [Events], { auto: true });
  assert.deepStrictEqual(autoReport.validatorApplied, ['events']);
  assert.deepStrictEqual(autoReport.drift, []);
  const collMod = db.commands.find((cmd) => 'collMod' in cmd);
  assert.ok(collMod, '应当发出 collMod');
  // `collMod` 是命令对象 `{ collMod: 'events', validator: { $jsonSchema } }`
  assert.strictEqual(collMod.collMod, 'events');
  assert.deepStrictEqual(collMod.validator, { $jsonSchema: Events.jsonSchema });
});

test('collection: 缺索引要被建出来（不是漂移），unique 也要带上', async () => {
  const db = createFakeMongoDb({ collections: { events: { validator: { $jsonSchema: Events.jsonSchema }, indexes: [] } } });
  const report = await syncCollections(db, [Events]);
  assert.deepStrictEqual(report.indexes.sort(), ['events_seq', 'events_type_at']);
  const created = db.indexCommands.find((cmd) => cmd.name === 'events_seq');
  assert.deepStrictEqual(created?.options, { name: 'events_seq', unique: true });
});

test('collection: 没有 validator 的集合 —— 只能检索引漂移（诚实边界，明确报告）', async () => {
  const db = createFakeMongoDb({
    collections: { events: { validator: null, indexes: [{ name: 'events_type_at', keys: { type: 1, at: 1 } }] } },
  });
  const report = await syncCollections(db, [Events], { auto: true });
  // 已有的集合没有 validator → 我们不擅自加（那是别人的集合），但要**如实说明"字段漂移检不了"**
  assert.ok(
    report.fieldDriftUnavailable.includes('events'),
    `必须如实报告"这个集合检不了字段漂移"：${JSON.stringify(report)}`,
  );
  assert.deepStrictEqual(report.validatorApplied, []);
});

test('collection: checkCollectionDrift 单集合查询（缺集合/缺索引/validator 不一致）', () => {
  const missing = checkCollectionDrift(Events, { exists: false, validator: null, indexes: [] });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.drift.some((item) => item.kind === 'missing'));

  const noIndex = checkCollectionDrift(Events, { exists: true, validator: { $jsonSchema: Events.jsonSchema }, indexes: [] });
  assert.ok(noIndex.drift.some((item) => item.kind === 'index'));

  const ok = checkCollectionDrift(Events, {
    exists: true,
    validator: { $jsonSchema: Events.jsonSchema },
    indexes: [
      { name: 'events_type_at', keys: { type: 1, at: 1 } },
      { name: 'events_seq', keys: { seq: 1 }, unique: true },
    ],
  });
  assert.strictEqual(ok.ok, true, `不该报漂移：${JSON.stringify(ok.drift)}`);
});
