/**
 * 读取脚手架模板并做占位符替换。
 *
 * 模板放在 `packages/cli/templates/`（**随包发布**：`package.json` 的 `files` 必须包含它，
 * 有测试盯着这条）。设计文档 §3.2 最初想内嵌字符串，但那样生成的代码里就不能出现模板字面量与
 * 反引号——**骨架是给人读的**，不该为了模板机制而变形，所以改成真实文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { WEB_PLUGINS, type Capability, type WebPlugin } from '../capabilities.ts';

/** 片段名：web 插件片段 + 能力片段（两者形状一样：片段目录里放 `src/plugin/<name>.ts` + 测试）。 */
export type FragmentName = WebPlugin | Capability;

/** 已经有片段的片段名（其余能力暂时会明确报错，而不是生成一半）。 */
export const AVAILABLE_FRAGMENTS: readonly FragmentName[] = ['upload', 'auth', 'debug', 'redis', 'mail'];

/** 支持的布局：`layered`（默认，按业务分层）/ `flat`（最小扁平形状）。 */
export const LAYOUTS = ['layered', 'flat'] as const;
export type Layout = (typeof LAYOUTS)[number];

const TEMPLATE_ROOTS: Record<Layout, string> = {
  layered: path.join(import.meta.dirname, '..', '..', 'templates', 'app'),
  flat: path.join(import.meta.dirname, '..', '..', 'templates', 'app-flat'),
};

/** 需要做占位符替换的文本文件。 */
const SUBSTITUTE = new Set(['package.json', 'README.md']);

export interface TemplateFile {
  /** 相对生成目录的路径。 */
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

/** 生成文件清单（含占位符替换）。`projectName` 用于 package.json / README；`layout` 选模板形状。 */
export async function appTemplates(projectName = 'my-actor-app', layout: Layout = 'layered'): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  for (const { relative, absolute } of await walk(TEMPLATE_ROOTS[layout])) {
    const raw = await fs.readFile(absolute, 'utf8');
    const content = SUBSTITUTE.has(relative) ? raw.replaceAll('__PROJECT_NAME__', projectName) : raw;
    files.push({ relative, content });
  }
  return files;
}

const FRAGMENT_ROOT = path.join(import.meta.dirname, '..', '..', 'templates', 'fragments');

/** 某个 web 插件片段的文件清单（片段目录与生成目录同构，直接拷进去）。 */
export async function fragmentTemplates(name: FragmentName): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  for (const { relative, absolute } of await walk(path.join(FRAGMENT_ROOT, name))) {
    files.push({ relative, content: await fs.readFile(absolute, 'utf8') });
  }
  return files;
}

/**
 * 生成插件桶 `src/plugin/index.ts`。
 *
 * 这是"能力选择"能work的关键：`server.ts` 永远只 import 桶文件，于是**不需要**用文本替换去改
 * `server.ts`（那种做法很脆）。片段导出的可以是单个 `PluginSpec`，也可以是 `PluginSpec[]`
 * （空数组 = 没配置就不挂，例如没给 JWT 密钥时的 auth）。
 */
export function pluginBarrel(names: readonly FragmentName[]): string {
  const imports = names.map((name) => `import ${name} from './${name}.ts';`).join('\n');
  const list = names.join(', ');
  return `import type { PluginSpec } from '@actor/app';

${names.length === 0 ? '' : `${imports}\n\n`}/**
 * 插件桶（由脚手架按你选的能力生成，**不要手改**：加能力请用 \`actor add\`）。
 *
 * 每个片段可以导出单个 PluginSpec，或 PluginSpec[]（空数组 = 该能力没被配置，就不挂）。
 */
const fragments: Array<PluginSpec | PluginSpec[]> = [${list}];

export default fragments.flat() as PluginSpec[];
`;
}

export const WEB_PLUGIN_NAMES: readonly WebPlugin[] = [...WEB_PLUGINS];

export const templateRoot = TEMPLATE_ROOTS.layered;
export const templateRootOf = (layout: Layout = 'layered'): string => TEMPLATE_ROOTS[layout];
