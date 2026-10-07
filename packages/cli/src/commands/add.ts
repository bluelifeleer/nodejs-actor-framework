/**
 * `actor add`：给**已有项目**增量加能力/插件。
 *
 * 三条刻意的行为（与脚手架同一套纪律）：
 *   - **非破坏性**：只写"缺失的片段文件"、只动 `package.json` 的依赖与 `src/plugin/index.ts` 桶文件；
 *     已存在的片段文件一律**跳过**（不覆盖用户改过的代码）；
 *   - **明确打印需要手工合并的地方**：不做智能改写。桶文件是我们生成的（可安全重写），
 *     但如果你手改过它，我们只提示；
 *   - **`--dry-run` 一个字节都不写**：先看计划再决定。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../args.ts';
import { assertKnown, graphOf, resolveClosure, type Capability, type WebPlugin } from '../capabilities.ts';
import { AVAILABLE_FRAGMENTS, fragmentTemplates, pluginBarrel, type FragmentName } from '../templates/app.ts';

export interface AddResult {
  readonly dir: string;
  readonly dryRun: boolean;
  /** 新写入的片段模块名（升序）。 */
  readonly added: FragmentName[];
  /** 已经有对应片段、这次跳过的（升序）。 */
  readonly skipped: FragmentName[];
  /** 需要写进 package.json 的依赖（升序）。 */
  readonly packages: string[];
  /** 会被写/改的文件（相对路径，升序）——测试就是靠它证明"没碰别的东西"。 */
  readonly files: string[];
  /** 需要人工确认/配置的事项（打印给用户）。 */
  readonly manualSteps: string[];
}

/** 每个能力配好之后要设的环境变量（打印用；不设也不会崩，见各片段实现）。 */
const ENV_HINTS: Record<FragmentName, string[]> = {
  upload: ['APP_UPLOAD_DIR（可选，默认 ./data/uploads）'],
  auth: ['APP_JWT_SECRET（HMAC 密钥，≥32 字节 —— **不配就不挂 auth**）', 'APP_JWT_ISSUER（可选）'],
  debug: ['APP_DEBUG=1 打开诊断路由', 'APP_DEBUG_TOKEN（≥16 字符）', 'APP_DEBUG_ALLOW_PRODUCTION=1（生产要显式允许）'],
  redis: ['APP_REDIS_URL（**不配就不挂**）'],
  mail: ['APP_MAIL_DIR（可选，默认 ./data/mail）', '换 SMTP：npm i nodemailer + driver: smtp'],
  app: [], web: [], data: [], db: [], mongodb: [],
};

async function frozenGraph(): Promise<ReturnType<typeof graphOf>> {
  const file = path.join(import.meta.dirname, '..', '..', 'templates', 'capabilities.json');
  const frozen = JSON.parse(await fs.readFile(file, 'utf8')) as { packages: Array<{ name: string; dependencies: string[] }> };
  return graphOf(frozen.packages);
}

const exists = (file: string): Promise<boolean> =>
  fs
    .access(file)
    .then(() => true)
    .catch(() => false);

export async function addCapability(
  target: string,
  options: {
    capabilities?: readonly Capability[];
    webPlugins?: readonly WebPlugin[];
    force?: boolean;
    dryRun?: boolean;
    graph?: ReturnType<typeof graphOf>;
  } = {},
): Promise<AddResult> {
  if (target === undefined || String(target).trim() === '') {
    throw new UsageError('缺少目标目录', '用法：actor add <capability> [--web-plugin <name>] [--dry-run] [--dir <项目目录>]');
  }
  const dir = path.resolve(String(target));
  const packageFile = path.join(dir, 'package.json');
  if (!(await exists(packageFile))) {
    throw new UsageError(`不是一个项目目录（没有 package.json）：${dir}`, '在项目根目录执行，或加 --dir <项目目录>');
  }
  const layered = await exists(path.join(dir, 'server.ts'));
  if (!layered) {
    throw new UsageError(
      `${dir} 看起来是 flat 布局（没有 server.ts）`,
      '能力片段需要 layered 的 src/plugin/ 桶文件；flat 项目请手工接线（或重新用 `actor new app --layout layered` 生成）',
    );
  }

  const capabilities = [...new Set(options.capabilities ?? [])].sort();
  const webPlugins = [...new Set(options.webPlugins ?? [])].sort();
  const requested: FragmentName[] = [...capabilities, ...webPlugins];
  if (requested.length === 0) {
    throw new UsageError('没说要加什么', `用法：actor add <capability>（可选：${AVAILABLE_FRAGMENTS.join(' / ')}）`);
  }
  try {
    assertKnown(capabilities, webPlugins);
  } catch (err) {
    const error = err as { message: string; hint?: string };
    throw new UsageError(error.message, error.hint ?? '');
  }
  const missing = requested.filter((name) => !AVAILABLE_FRAGMENTS.includes(name));
  if (missing.length > 0) {
    throw new UsageError(
      `这些能力的片段还没实现：${missing.join(', ')}`,
      `目前可用：${AVAILABLE_FRAGMENTS.join(' / ')}（不静默跳过）`,
    );
  }

  // 已有的片段 = src/plugin/ 下的模块（index.ts 是桶文件，不算片段）
  const pluginDir = path.join(dir, 'src', 'plugin');
  const existing: FragmentName[] = [];
  try {
    for (const entry of await fs.readdir(pluginDir)) {
      if (!entry.endsWith('.ts') || entry === 'index.ts') continue;
      existing.push(entry.slice(0, -'.ts'.length) as FragmentName);
    }
  } catch {
    // 目录不存在 → 没有已有片段
  }
  const added = requested.filter((name) => !existing.includes(name)).sort();
  const skipped = requested.filter((name) => existing.includes(name)).sort();

  const files: string[] = [];
  const writes: Array<{ relative: string; content: string }> = [];
  for (const name of added) {
    for (const file of await fragmentTemplates(name)) {
      if (options.force !== true && (await exists(path.join(dir, file.relative)))) continue; // 绝不覆盖
      writes.push(file);
      files.push(file.relative);
    }
  }
  // 桶文件重写成"已有 + 新增"的并集（它是生成物，可以安全重写；用户手改过的内容不保留 —— 见 manualSteps）
  const barrelNames = [...new Set([...existing, ...requested])].sort() as FragmentName[];
  writes.push({ relative: 'src/plugin/index.ts', content: pluginBarrel(barrelNames) });
  files.push('src/plugin/index.ts');

  const graph = options.graph ?? (await frozenGraph());
  const closure = resolveClosure([...capabilities, 'web', 'data'], webPlugins, graph);
  const current = JSON.parse(await fs.readFile(packageFile, 'utf8')) as { dependencies?: Record<string, string> };
  const dependencies: Record<string, string> = { ...(current.dependencies ?? {}) };
  let depsChanged = false;
  for (const name of closure.transitivePackages) {
    if (dependencies[name] === undefined) {
      dependencies[name] = '*';
      depsChanged = true;
    }
  }
  if (depsChanged) files.push('package.json');

  const manualSteps: string[] = [];
  for (const name of added) manualSteps.push(...ENV_HINTS[name].map((hint) => `${name}: ${hint}`));
  manualSteps.push('`src/plugin/index.ts` 是生成物，会被重写；你若手改过它，请对照本次输出重新合并');

  if (options.dryRun !== true) {
    for (const file of writes) {
      const destination = path.join(dir, file.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, 'utf8');
    }
    if (depsChanged) await fs.writeFile(packageFile, `${JSON.stringify({ ...current, dependencies }, null, 2)}\n`, 'utf8');
  }

  return {
    dir,
    dryRun: options.dryRun === true,
    added,
    skipped,
    packages: closure.transitivePackages,
    files: [...new Set(files)].sort(),
    manualSteps,
  };
}
