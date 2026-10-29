/**
 * `actor new plugin <name> --kind web|resource`：生成**能自证合规**的插件包骨架。
 *
 * 与脚手架同一套纪律：拒绝覆盖非空目录、不自动装依赖、`--dry-run` 一个字节都不写。
 * 生成的 `test/contract.test.ts` 直接用框架**已发布**的契约套件 —— 插件一出生就能自证。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../args.ts';
import {
  PLUGIN_KINDS,
  PLUGIN_KIND_DEPS,
  PLUGIN_KIND_PROOF,
  pluginIdentifier,
  pluginTemplates,
  type PluginKind,
} from '../templates/plugin.ts';

export interface NewPluginResult {
  readonly dir: string;
  readonly kind: PluginKind;
  readonly name: string;
  readonly dryRun: boolean;
  readonly files: readonly string[];
  /** 仓库内模式：四张矩阵的接线清单（漏一处就不会进 CI/类型检查/API 文档）。 */
  readonly wiring: readonly string[];
}

const NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(() => true).catch(() => false);

export async function newPlugin(
  name: string,
  options: { kind?: string; dir?: string; force?: boolean; dryRun?: boolean; repo?: boolean } = {},
): Promise<NewPluginResult> {
  if (name === undefined || String(name).trim() === '') {
    throw new UsageError('缺少插件名', `用法：actor new plugin <name> --kind ${PLUGIN_KINDS.join('|')}`);
  }
  const pluginName = String(name).trim();
  if (!NAME_PATTERN.test(pluginName)) {
    throw new UsageError(
      `插件名不合法：'${pluginName}'`,
      '用 npm 包名风格（小写、可带作用域）：例如 my-actor-plugin 或 @me/actor-plugin',
    );
  }
  const kind = options.kind ?? 'web';
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(
      `未知的插件类型 '${String(kind)}'`,
      `可选：${PLUGIN_KINDS.join(' / ')}`,
    );
  }
  const typedKind = kind as PluginKind;

  const shortName = pluginName.replace(/^@[^/]+\//, '');
  const parent = path.resolve(options.dir ?? process.cwd());
  const dir = path.join(parent, shortName);

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

  const templates = await pluginTemplates(typedKind, { name: pluginName, identifier: pluginIdentifier(pluginName) });
  if (options.dryRun !== true) {
    for (const file of templates) {
      const destination = path.join(dir, file.relative);
      const stat = await fs.lstat(destination).catch(() => null);
      if (stat?.isSymbolicLink()) {
        throw new UsageError(`拒绝写入符号链接：${file.relative}`, '符号链接可能指向项目外；请先移除它');
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, 'utf8');
    }
  }

  const relativeDir = path.relative(process.cwd(), dir) || '.';
  const wiring = [
    `依赖：${PLUGIN_KIND_DEPS[typedKind]}`,
    `自证合规：${PLUGIN_KIND_PROOF[typedKind]}`,
    `1) 工作区测试矩阵：根 package.json 的 scripts.test 加上 '${relativeDir}/test/*.test.ts'`,
    `2) 类型检查：根 tsconfig.json 的 include 加上 '${relativeDir}/src/**/*.ts'`,
    `3) API 文档：tools/docs-site.mjs 的 PACKAGES 加上它（公开包才需要）`,
    `4) 导出基线：test/unit-package-surfaces.test.js 里加上运行时导出名`,
    '（test/unit-package-matrices.test.js 会检查这四张矩阵 —— 漏一处不会静默）',
  ];

  return {
    dir,
    kind: typedKind,
    name: pluginName,
    dryRun: options.dryRun === true,
    files: templates.map((file) => file.relative),
    wiring: options.repo === true ? wiring : [],
  };
}

void exists;
