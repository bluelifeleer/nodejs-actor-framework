/**
 * 插件包骨架的模板读取（与 app 模板同一套纪律：**真实文件**、随包发布、占位符替换）。
 *
 * `--kind` 决定生成哪种骨架；每种骨架都自带 `test/contract.test.ts`，用的是框架**已发布**的契约套件
 * （`@actor/web` / `@actor/resource` 的 `src/` 随包发布）—— 生成的插件**一出生就能自证合规**。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_KINDS = ['web', 'resource'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** 每种 kind 需要的依赖（生成到 package.json）。 */
export const PLUGIN_KIND_DEPS: Record<PluginKind, string> = {
  web: '@actor/web',
  resource: '@actor/resource',
};

const PLUGIN_ROOT = path.join(import.meta.dirname, '..', '..', 'templates', 'plugin');
const SUBSTITUTE = new Set(['package.json', 'README.md', 'src/index.ts', 'test/contract.test.ts']);

export interface PluginTemplateFile {
  relative: string;
  content: string;
}

async function walk(dir: string, prefix = ''): Promise<{ relative: string; absolute: string }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: { relative: string; absolute: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await walk(absolute, relative)));
    else found.push({ relative, absolute });
  }
  return found;
}

/** `my-plugin` → `myPlugin`（用作导出的标识符）。 */
export function pluginIdentifier(name: string): string {
  const parts = name.replace(/^@[^/]+\//, '').split(/[^a-zA-Z0-9]+/).filter((part) => part !== '');
  if (parts.length === 0) return 'myPlugin';
  return parts
    .map((part, index) => (index === 0 ? part[0]?.toLowerCase() + part.slice(1) : part[0]?.toUpperCase() + part.slice(1)))
    .join('');
}

/** 读某种 kind 的骨架（含占位符替换）。 */
export async function pluginTemplates(
  kind: PluginKind,
  options: { name: string; identifier: string },
): Promise<PluginTemplateFile[]> {
  const root = path.join(PLUGIN_ROOT, kind);
  const dep = PLUGIN_KIND_DEPS[kind];
  const files: PluginTemplateFile[] = [];
  for (const { relative, absolute } of await walk(root)) {
    const raw = await fs.readFile(absolute, 'utf8');
    const content = SUBSTITUTE.has(relative)
      ? raw.replaceAll('__PLUGIN_NAME__', options.name).replaceAll('__PLUGIN_CAMEL__', options.identifier).replaceAll('__PLUGIN_DEP__', dep)
      : raw;
    files.push({ relative, content });
  }
  return files;
}
