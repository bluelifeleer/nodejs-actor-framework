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
import { appTemplates, LAYOUTS, type Layout } from '../templates/app.ts';

export interface NewAppResult {
  dir: string;
  /** 实际使用的布局（默认 layered）。 */
  layout: Layout;
  files: string[];
  nextSteps: string[];
}

export async function newApp(
  target: string,
  options: { force?: boolean; layout?: Layout } = {},
): Promise<NewAppResult> {
  if (target === undefined || String(target).trim() === '') {
    throw new UsageError('缺少目标目录', `用法：actor new app <dir> [--layout ${LAYOUTS.join('|')}] [--force]`);
  }
  const layout = options.layout ?? 'layered';
  if (!LAYOUTS.includes(layout)) {
    throw new UsageError(`未知的布局 '${String(layout)}'`, `可选：${LAYOUTS.join(' / ')}`);
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
  for (const file of templates) {
    const destination = path.join(dir, file.relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, 'utf8');
  }

  return {
    dir,
    layout,
    files: templates.map((file) => file.relative),
    nextSteps: [`cd ${dir}`, 'npm install', 'npm start', 'npm test'],
  };
}
