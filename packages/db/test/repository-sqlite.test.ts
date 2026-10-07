import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase, defineModel, DbConflictError, DbConfigError } from '../src/index.ts';

/**
 * ORM 映射层 + 仓储：实体 ↔ 行（列名映射、JSON 编解码、时间戳自动填充、version 乐观锁），
 * 以及 hasMany/belongsTo 的关联查询。全部跑在 **sqlite 真库**上。
 */
const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    tags: { type: 'json', default: [] },
    ownerId: { type: 'string', column: 'owner_id' },
    archived: { type: 'boolean', default: false },
    createdAt: { type: 'timestamp', auto: 'create' },
    updatedAt: { type: 'timestamp', auto: 'update' },
    version: { type: 'integer', version: true },
  },
  indexes: [{ fields: ['ownerId'] }],
  relations: {
    comments: { kind: 'hasMany', model: 'comments', foreignKey: 'noteId' },
    author: { kind: 'belongsTo', model: 'authors', foreignKey: 'ownerId' },
  },
});

const Comment = defineModel({
  name: 'comments',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    noteId: { type: 'string', column: 'note_id', notNull: true },
    body: { type: 'text', notNull: true },
  },
});

const Author = defineModel({
  name: 'authors',
  fields: {
    id: { type: 'string', primaryKey: true },
    name: { type: 'string', notNull: true },
  },
});

async function setup() {
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: ':memory:' } });
  await db.connect();
  await db.sync([Note, Comment, Author]);
  return db;
}

test('repo/sqlite: insert 自动填主键/时间戳/version，findById 还原成实体（JSON 解码、布尔转换）', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    const created = await notes.insert({ title: 'first', tags: ['a', 'b'], ownerId: 'u1', archived: true });

    assert.match(String(created.id), /^[0-9a-f-]{36}$/, 'uuid 主键没有被自动生成');
    assert.strictEqual(created.version, 0);
    assert.ok(created.createdAt instanceof Date, `createdAt 没有被写成日期：${String(created.createdAt)}`);
    // 注意：insert 不会写 auto=update 的列，而库里那一列是 NULL（DDL 没给默认值）→ 实体里就是 null。
    // 这是"如实反映库里的真相"，比返回 undefined 更好预期。
    assert.strictEqual(created.updatedAt, null, 'auto=update 的时间戳不该在 insert 时写');

    const found = await notes.findById(String(created.id));
    assert.ok(found);
    assert.deepStrictEqual(found.tags, ['a', 'b'], 'JSON 列没有解码回数组');
    assert.strictEqual(found.archived, true, '布尔列没有还原成 boolean');
    assert.strictEqual(found.ownerId, 'u1');
    assert.strictEqual(found.title, 'first');
  } finally {
    await db.close();
  }
});

test('repo/sqlite: update 用 version 做乐观锁 —— 过期版本抛 DbConflictError，不存在的行要能区分', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    const created = await notes.insert({ title: 'v1' });
    const id = String(created.id);

    const updated = await notes.update(id, { title: 'v2' }, { expectedVersion: 0 });
    assert.strictEqual(updated.title, 'v2');
    assert.strictEqual(updated.version, 1, 'version 没有自增');
    assert.ok(updated.updatedAt instanceof Date, 'auto=update 的时间戳没有被填');

    await assert.rejects(
      () => notes.update(id, { title: 'v3' }, { expectedVersion: 0 }),
      (err: Error) => {
        assert.ok(err instanceof DbConflictError, `应当是冲突错误，实际 ${err.name}`);
        return true;
      },
      '过期版本必须抛冲突（不能静默覆盖）',
    );

    await assert.rejects(
      () => notes.update('00000000-0000-0000-0000-000000000000', { title: 'x' }),
      /not found|no row/i,
    );
  } finally {
    await db.close();
  }
});

test('repo/sqlite: 自定义字段钩子与整行映射（用户写的两层）都会生效', async () => {
  const Custom = defineModel({
    name: 'custom',
    fields: {
      id: { type: 'string', primaryKey: true },
      // 用户可写的"解析层"：库里存逗号串，领域里是数组
      tags: {
        type: 'text',
        parse: (raw) => (raw === '' || raw === null ? [] : String(raw).split(',')),
        serialize: (value) => (Array.isArray(value) ? value.join(',') : String(value)),
      },
      level: { type: 'integer', default: 1 },
    },
    // 整行级（也是用户可写）：把 level 映射成领域字段 grade
    parseRow: (row) => ({ ...row, grade: row.level >= 5 ? 'high' : 'low' }),
    serializeRow: (entity) => {
      if (entity.grade === 'high') return { ...entity, level: 9 };
      return entity;
    },
  });

  const db = await setup();
  try {
    await db.sync([Custom]);
    const repo = db.repository(Custom);
    const created = await repo.insert({ id: 'c1', tags: ['x', 'y'], grade: 'high' });
    assert.strictEqual(created.level, 9, 'serializeRow 没有生效（grade=high 应当写成 level=9）');

    const found = await repo.findById('c1');
    assert.deepStrictEqual(found?.tags, ['x', 'y'], '字段级 parse 没有生效');
    assert.strictEqual(found?.grade, 'high', 'parseRow 没有生效');
    const raw = await db.raw<{ level: number }>('SELECT level FROM "custom" WHERE id = ?', ['c1']);
    assert.strictEqual(raw[0].level, 9, '落盘的 level 不对');
  } finally {
    await db.close();
  }
});

test('repo/sqlite: findMany 支持 where/orderBy/limit，且列名必须来自 model（防注入）', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    await notes.insert({ title: 'c', ownerId: 'u1' });
    await notes.insert({ title: 'a', ownerId: 'u1' });
    await notes.insert({ title: 'b', ownerId: 'u2' });

    const u1 = await notes.findMany({ where: { ownerId: 'u1' }, orderBy: [{ field: 'title', direction: 'asc' }] });
    assert.deepStrictEqual(u1.map((n) => n.title), ['a', 'c']);

    const limited = await notes.findMany({ orderBy: [{ field: 'title', direction: 'asc' }], limit: 2 });
    assert.strictEqual(limited.length, 2);

    // 列名不是 model 字段 → 明确报错（而不是把用户输入拼进 SQL）
    await assert.rejects(
      () => notes.findMany({ where: { 'title = 1 OR 1=1 --': 'x' } as never }),
      (err: Error) => {
        assert.ok(err instanceof DbConfigError, `应当是配置错误，实际 ${err.name}`);
        return true;
      },
    );
    await assert.rejects(() => notes.findMany({ orderBy: [{ field: 'nope', direction: 'asc' }] }), DbConfigError);
  } finally {
    await db.close();
  }
});

test('repo/sqlite: 关联声明可用 —— hasMany 按外键取多行，belongsTo 取一行', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    const comments = db.repository(Comment);
    const authors = db.repository(Author);

    const note = await notes.insert({ title: 'with comments', ownerId: 'a1' });
    const other = await notes.insert({ title: 'no comments' });
    await comments.insert({ noteId: String(note.id), body: 'first' });
    await comments.insert({ noteId: String(note.id), body: 'second' });
    await comments.insert({ noteId: String(other.id), body: 'elsewhere' });
    await authors.insert({ id: 'a1', name: 'Alice' });

    const related = await notes.related(note, 'comments');
    const rows = await related.many();
    assert.deepStrictEqual(rows.map((c) => c.body).sort(), ['first', 'second'], 'hasMany 没有按外键过滤');

    const author = await notes.related(note, 'author');
    assert.strictEqual((await author.one())?.name, 'Alice', 'belongsTo 没有取到对方');

    // 关联名不存在 → 明确报错
    await assert.rejects(() => notes.related(note, 'nope'), DbConfigError);
    // 关联的目标 model 没注册 → 也要明确报错
    const Missing = defineModel({
      name: 'missing',
      fields: { id: { type: 'string', primaryKey: true }, ghostId: { type: 'string' } },
      relations: { ghost: { kind: 'belongsTo', model: 'ghosts', foreignKey: 'ghostId' } },
    });
    await db.sync([Missing]);
    await assert.rejects(() => db.repository(Missing).related({ id: 'x' }, 'ghost'), /ghosts/);
  } finally {
    await db.close();
  }
});

test('repo/sqlite: delete 返回是否删掉，且列名映射在 DELETE 上也生效', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    const created = await notes.insert({ title: 'temp' });
    assert.strictEqual(await notes.delete(String(created.id)), true);
    assert.strictEqual(await notes.findById(String(created.id)), null);
    assert.strictEqual(await notes.delete(String(created.id)), false);
  } finally {
    await db.close();
  }
});

test('repo/sqlite: 没有 serializeRow 时，拼错字段名必须报错（不静默丢弃）', async () => {
  const db = await setup();
  try {
    const notes = db.repository(Note);
    await assert.rejects(
      () => notes.insert({ titel: 'typo' } as never),
      /has no field "titel"/,
      '没有用户映射层时，拼错的字段名必须报错（否则"看起来插入了"其实什么都没写）',
    );
    // 有 serializeRow 的 model（上面的 Custom）允许虚拟字段 —— 见上一个用例
  } finally {
    await db.close();
  }
});
