import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  CAPABILITY_PACKAGES,
  DEFAULT_CAPABILITIES,
  WEB_PLUGINS,
  assertKnown,
  graphOf,
  resolveClosure,
  type Capability,
  type FrozenCapabilities,
  type WebPlugin,
} from '../src/capabilities.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const FROZEN = path.join(ROOT, 'packages', 'cli', 'templates', 'capabilities.json');

/** 仓库实时依赖图（逐包读 package.json 的 dependencies）。 */
function liveGraph(): ReturnType<typeof graphOf> {
  const entries: Array<{ name: string; dependencies: string[] }> = [];
  for (const dir of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const file = path.join(ROOT, 'packages', dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; dependencies?: Record<string, string> };
    if (pkg.name === undefined) continue;
    entries.push({ name: pkg.name, dependencies: Object.keys(pkg.dependencies ?? {}) });
  }
  return graphOf(entries);
}

test('capabilities: 能力名都对应真实存在的包', () => {
  const graph = liveGraph();
  for (const [capability, pkg] of Object.entries(CAPABILITY_PACKAGES)) {
    assert.ok(graph.has(pkg), `能力 ${capability} 对应的 ${pkg} 必须在 packages/ 里存在`);
  }
});

test('capabilities: 闭包从 package.json 推导（web → app；redis/mail → resource）', () => {
  const graph = liveGraph();
  const web = resolveClosure(['web'], [], graph);
  assert.deepStrictEqual(web.capabilities, ['app', 'web'], `web 应当带上 app：${JSON.stringify(web)}`);
  assert.deepStrictEqual(web.packages, ['@actor/app', '@actor/web']);

  const redis = resolveClosure(['web', 'redis'], [], graph);
  assert.ok(redis.capabilities.includes('redis') && redis.capabilities.includes('web'), JSON.stringify(redis));
  // resource 不是"可选能力"，但它是 redis 的依赖 —— 只要求它出现在包的依赖链里（不要求进 packages 列表）
  assert.ok(!redis.packages.includes('@actor/resource'), '本次只把"可选能力"写进依赖列表，resource 由包自身带');

  const mail = resolveClosure(['mail'], [], graph);
  assert.deepStrictEqual(mail.capabilities, ['mail'], JSON.stringify(mail));
});

test('capabilities: 默认只给最小一套；未知名字给明确提示；web 插件必须挂在 web 上', () => {
  const graph = liveGraph();
  assert.deepStrictEqual([...DEFAULT_CAPABILITIES], ['web', 'data']);
  assert.throws(() => assertKnown(['nope'], []), /未知能力 'nope'/);
  assert.throws(() => assertKnown([], ['nope']), /未知的 web 插件 'nope'/);
  assert.throws(
    () => resolveClosure(['data'], ['auth'], graph),
    /需要同时选 --with web/,
    'web 插件不能挂在不含 web 的组合上',
  );
  const ok = resolveClosure(['web'], ['auth', 'upload'], graph);
  assert.deepStrictEqual(ok.webPlugins, ['auth', 'upload']);
});

test('capabilities: 固化数据与仓库实时闭包一致（否则对外发布的闭包会烂掉）', () => {
  assert.ok(fs.existsSync(FROZEN), `缺少固化文件：${FROZEN}（用 npm run capabilities:freeze 生成）`);
  const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8')) as FrozenCapabilities;
  const frozenGraph = graphOf(frozen.packages);
  const live = liveGraph();

  // 只比对"能力相关的包"：闭包必须完全一致
  for (const pkg of Object.values(CAPABILITY_PACKAGES)) {
    const fromFrozen = frozenGraph.get(pkg);
    const fromLive = live.get(pkg);
    assert.ok(fromFrozen !== undefined, `固化数据里缺 ${pkg}`);
    assert.deepStrictEqual(
      fromFrozen.dependencies,
      fromLive?.dependencies,
      `${pkg} 的依赖在固化数据与 package.json 里不一致 —— 重新跑 npm run capabilities:freeze`,
    );
  }

  // 用固化数据推出来的闭包 == 用实时数据推出来的闭包
  for (const requested of [['web'], ['data'], ['web', 'data'], ['web', 'redis'], ['mail'], ['db']] as Capability[][]) {
    assert.deepStrictEqual(
      resolveClosure(requested, [], frozenGraph).capabilities,
      resolveClosure(requested, [], live).capabilities,
      `组合 ${requested.join(',')} 的闭包不一致`,
    );
  }
  void (WEB_PLUGINS as readonly WebPlugin[]);
});
