/**
 * `actor new app <dir>`：生成可运行骨架。
 *
 * 两条刻意的行为：
 *   - **拒绝覆盖非空目录**（除非 `--force`）：脚手架最糟的事故是"手一抖把已有项目覆盖了"；
 *   - **生成后不自动装依赖**：装依赖要联网、可能要编译原生模块，脚手架不该替用户决定。
 *     生成完打印下一步（`cd <dir> && npm install && npm start`）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../args.ts';
import { assertKnown, graphOf, resolveClosure, type Capability } from '../capabilities.ts';
import {
  appTemplates,
  AVAILABLE_FRAGMENTS,
  fragmentTemplates,
  LAYOUTS,
  pluginBarrel,
  type FragmentName,
  type Layout,
} from '../templates/app.ts';

import type { WebPlugin } from '../capabilities.ts';

/** 读**固化的**能力依赖图：对外发布时读不到 monorepo，所以闭包必须来自这份数据。 */
async function frozenGraph(): Promise<ReturnType<typeof graphOf>> {
  const file = path.join(import.meta.dirname, '..', '..', 'templates', 'capabilities.json');
  const frozen = JSON.parse(await fs.readFile(file, 'utf8')) as {
    packages: Array<{ name: string; dependencies: string[] }>;
  };
  return graphOf(frozen.packages);
}

export interface NewAppResult {
  dir: string;
  /** 实际使用的布局（默认 layered）。 */
  layout: Layout;
  /** 选中的 web 插件（升序）。 */
  webPlugins: WebPlugin[];
  /** 追加的能力（升序；基础模板自带 web + data）。 */
  capabilities: Capability[];
  /** 写进生成项目 package.json 的依赖（升序）。 */
  packages: readonly string[];
  files: string[];
  nextSteps: string[];
}

export async function newApp(
  target: string,
  options: {
    force?: boolean;
    layout?: Layout;
    webPlugins?: readonly WebPlugin[];
    /** **追加**能力（基础模板自带 web + data，它们不是可选项）。 */
    capabilities?: readonly Capability[];
    /** 依赖图（测试注入；默认用固化数据）。 */
    graph?: ReturnType<typeof graphOf>;
    /** 只打印计划，一个字节都不写。 */
    dryRun?: boolean;
  } = {},
): Promise<NewAppResult> {
  if (target === undefined || String(target).trim() === '') {
    throw new UsageError('缺少目标目录', `用法：actor new app <dir> [--layout ${LAYOUTS.join('|')}] [--force]`);
  }
  const layout = options.layout ?? 'layered';
  if (!LAYOUTS.includes(layout)) {
    throw new UsageError(`未知的布局 '${String(layout)}'`, `可选：${LAYOUTS.join(' / ')}`);
  }
  const webPlugins = [...new Set(options.webPlugins ?? [])].sort();
  if (webPlugins.length > 0 && layout === 'flat') {
    throw new UsageError(
      'flat 布局不支持 --web-plugins',
      'web 插件需要 layered 的 src/plugin/ 桶文件；用默认布局，或去掉 --web-plugins',
    );
  }
  const capabilities = [...new Set(options.capabilities ?? [])].sort();
  try {
    assertKnown(capabilities, webPlugins);
  } catch (err) {
    const error = err as { message: string; hint?: string };
    throw new UsageError(error.message, error.hint ?? '');
  }

  // 依赖闭包：基础模板固定要 web + data（模板代码依赖它们），--with 是**追加**
  const graph = options.graph ?? (await frozenGraph());
  const closure = resolveClosure([...capabilities, 'web', 'data'], webPlugins, graph);

  // 还没有片段的能力：**明确拒绝**（不生成一半、也不静默少给）
  const fragments: FragmentName[] = [...capabilities, ...webPlugins];
  const missing = fragments.filter((name) => !AVAILABLE_FRAGMENTS.includes(name));
  if (missing.length > 0) {
    throw new UsageError(
      `这些能力/插件的片段还没实现：${missing.join(', ')}`,
      `目前可用：${AVAILABLE_FRAGMENTS.join(' / ')}（其余在 M9b 余下补；不静默生成一半）`,
    );
  }
  const dir = path.resolve(String(target));

  let existing: string[] = [];
  try {
    existing = await fs.readdir(dir);
  } catch {
    existing = [];
  }
  if (existing.length > 0 && options.force !== true) {
    throw new UsageError(
      `目标目录非空：${dir}（${existing.length} 个条目）`,
      '确认要写入就用 --force；脚手架不覆盖已有项目，这是刻意的',
    );
  }

  const projectName = path.basename(dir).replace(/[^\w.-]/g, '-') || 'actor-app';
  const templates = await appTemplates(projectName, layout);
  // 片段：直接按同构路径拷进项目（每个片段自带它的接线与冒烟测试）
  for (const name of fragments) {
    templates.push(...(await fragmentTemplates(name)));
  }
  // package.json 的依赖按**闭包**写（生成的项目声明它真正 import 的包，不指望传递依赖恰好被提升）
  const packageFile = templates.find((file) => file.relative === 'package.json');
  if (packageFile !== undefined) {
    const pkg = JSON.parse(packageFile.content) as { dependencies?: Record<string, string> };
    const dependencies: Record<string, string> = {};
    for (const name of closure.transitivePackages) dependencies[name] = '*';
    pkg.dependencies = dependencies;
    packageFile.content = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  // 桶文件只给 layered：flat 的 src/app.ts 不消费它（塞进去就是死文件）
  if (layout === 'layered') {
    templates.push({ relative: 'src/plugin/index.ts', content: pluginBarrel(fragments) });
  }

  if (options.dryRun !== true) {
    for (const file of templates) {
      const destination = path.join(dir, file.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, 'utf8');
    }
  }

  return {
    dir,
    layout,
    webPlugins,
    capabilities,
    packages: closure.transitivePackages,
    files: [...new Set(templates.map((file) => file.relative))].sort(),
    nextSteps: [`cd ${dir}`, 'npm install', 'npm start', 'npm test'],
  };
}
