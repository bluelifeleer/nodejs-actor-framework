/**
 * 读取脚手架模板并做占位符替换。
 *
 * 模板放在 `packages/cli/templates/`（**随包发布**：`package.json` 的 `files` 必须包含它，
 * 有测试盯着这条）。设计文档 §3.2 最初想内嵌字符串，但那样生成的代码里就不能出现模板字面量与
 * 反引号——**骨架是给人读的**，不该为了模板机制而变形，所以改成真实文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE_ROOT = path.join(import.meta.dirname, '..', '..', 'templates', 'app');

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

/** 生成文件清单（含占位符替换）。`projectName` 用于 package.json / README。 */
export async function appTemplates(projectName = 'my-actor-app'): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  for (const { relative, absolute } of await walk(TEMPLATE_ROOT)) {
    const raw = await fs.readFile(absolute, 'utf8');
    const content = SUBSTITUTE.has(relative) ? raw.replaceAll('__PROJECT_NAME__', projectName) : raw;
    files.push({ relative, content });
  }
  return files;
}

export const templateRoot = TEMPLATE_ROOT;
