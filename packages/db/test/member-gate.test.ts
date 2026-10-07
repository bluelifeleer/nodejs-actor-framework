import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { checkDocumentedMembers } from '../../../tools/api-extract.mjs';

/**
 * **成员级**文档门禁：用户指南里 `db.xxx` 用到的成员，必须在 `src/index.d.ts` 里有声明。
 *
 * 为什么单独一条（内核那条只管内核的接收者 `ctx/system/cluster/app/pubsub`）：
 * 文档里写的 `db.connect()`、`db.repository()`、`db.rawRun()`…… 都属于**本包**的公开面；
 * 少了这条，本包就会重复内核当初那个洞（"文档在用、声明面没有"）。
 */
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DOCS = ['README.md', 'docs/guide/08-database.md', 'docs/design/m6-db-package.md'];

test('db member gate: 指南里 `db.*` 用到的成员都在 index.d.ts 里有声明', () => {
  const docs = DOCS.filter((file) => fs.existsSync(path.join(ROOT, file))).map((file) => ({
    file,
    text: fs.readFileSync(path.join(ROOT, file), 'utf8'),
  }));
  assert.ok(docs.length >= 2, `文档清单不对：${DOCS.join(', ')}`);
  const declaration = fs.readFileSync(path.join(ROOT, 'packages/db/src/index.d.ts'), 'utf8');
  const missing = checkDocumentedMembers(docs, declaration, { receivers: ['db'] });
  assert.deepStrictEqual(
    missing,
    [],
    `这些成员在文档里被使用者照着写，却没有类型声明：\n${missing.map((m) => `  db.${m.member}  ← ${m.file}`).join('\n')}`,
  );
});

test('db member gate: 能证伪 —— 从声明里删掉一个成员必须被抓到', () => {
  const docs = [
    { file: 'fake.md', text: '```js\nawait db.healthCheck();\n```\n' },
  ];
  const declaration = 'export interface Database {\n  connect(): Promise<void>;\n}\n';
  const caught = checkDocumentedMembers(docs, declaration, { receivers: ['db'] });
  assert.deepStrictEqual(caught.map((m) => m.member), ['healthCheck'], '删掉成员后门禁没抓到');
});
