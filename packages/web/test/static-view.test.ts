import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineController, defineRoutes, get, httpPlugin, staticPlugin, viewPlugin, reply } from '../src/index.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeApp(root: string, views: string) {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'api',
          routes: defineRoutes([
            get('/api/ping', () => reply.json({ ok: true })),
            get(
              '/page',
              defineController({
                async handle(_input, ctx) {
                  return ctx.render?.('page.html', { name: '<b>Alice</b>', nested: { value: 42 } }) ?? reply.text('no view');
                },
              }),
            ),
          ]),
        }),
      ],
      plugins: [staticPlugin({ root, spaFallback: true }), viewPlugin({ root: views }), http],
    }),
    { configDir: tempDir('actor-static-config-'), env: {} },
  );
  return { app, http };
}

test('staticPlugin: files, immutable assets, SPA fallback, route precedence, ETag', async () => {
  const root = tempDir('actor-static-');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root">spa</div>', 'utf8');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("ok");', 'utf8');
  fs.writeFileSync(path.join(root, 'api-ping'), 'file should not win', 'utf8');
  const views = tempDir('actor-views-');
  fs.writeFileSync(path.join(views, 'page.html'), '<!doctype html><h1>{{name}}</h1><p>{{nested.value}}</p>', 'utf8');
  const { app, http } = makeApp(root, views);
  await app.start();
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;
  try {
    const index = await fetch(`${base}/`);
    assert.strictEqual(index.status, 200);
    assert.match(await index.text(), /spa/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.strictEqual(asset.status, 200);
    assert.strictEqual(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(String(asset.headers.get('cache-control')), /immutable/);

    const spa = await fetch(`${base}/instances/123`, { headers: { accept: 'text/html' } });
    assert.strictEqual(spa.status, 200);
    assert.match(await spa.text(), /spa/);

    const api = await fetch(`${base}/api/ping`);
    assert.strictEqual(api.status, 200);
    assert.deepStrictEqual(await api.json(), { ok: true });

    const missingAsset = await fetch(`${base}/missing.js`);
    assert.strictEqual(missingAsset.status, 404, '带扩展名的静态请求不能 fallback 到 index');

    const etag = asset.headers.get('etag');
    assert.ok(etag);
    const cached = await fetch(`${base}/assets/app.js`, { headers: { 'if-none-match': String(etag) } });
    assert.strictEqual(cached.status, 304);

    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    assert.strictEqual(traversal.status, 404, '路径穿越必须被拒绝');
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(views, { recursive: true, force: true });
  }
});

test('viewPlugin: controller renders a template with escaped data and initial data', async () => {
  const root = tempDir('actor-static-');
  fs.writeFileSync(path.join(root, 'index.html'), '<div id="root"></div>', 'utf8');
  const views = tempDir('actor-views-');
  fs.writeFileSync(path.join(views, 'page.html'), '<!doctype html><html><head></head><body><h1>{{name}}</h1><p>{{nested.value}}</p></body></html>', 'utf8');
  const { app, http } = makeApp(root, views);
  await app.start();
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;
  try {
    const response = await fetch(`${base}/page`);
    assert.strictEqual(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('&lt;b&gt;Alice&lt;/b&gt;'), '模板变量必须转义');
    assert.ok(html.includes('42'));
    assert.match(html, /window\.__INITIAL_DATA__/);
    assert.ok(!html.includes('<b>Alice</b>'));
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(views, { recursive: true, force: true });
  }
});
