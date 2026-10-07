/**
 * 项目定位与加载：CLI 只在**约定位置**找东西，找不到就明确说"我期待什么、你在哪"。
 *
 * 约定（骨架就是按这个生成的，见 templates/app）：
 *   <dir>/package.json        项目根
 *   <dir>/config/default.ts   配置（defineConfig）
 *   <dir>/src/migrations.ts   迁移（可选；没有就当作"没有迁移"，不是错误）
 *   <dir>/src/app.ts          应用定义（doctor 用来做基础检查）
 *   数据目录                   `--data` > `APP_DATA_DIR` > <dir>/data
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ProjectInfo {
  /** 项目根（绝对路径）。 */
  dir: string;
  name: string;
  /** 数据目录（绝对路径）。 */
  dataDir: string;
  hasMigrations: boolean;
  configDir: string;
  /** package.json（解析后的内容；读不到时为 null）。 */
  manifest: Record<string, unknown> | null;
}

export class ProjectError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ProjectError';
    this.hint = hint;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 从 `<dir>` 向上找 package.json？不——只用给定的目录，避免"跑到父目录去动别人的项目"。 */
export async function loadProject(dir: string, options: { data?: string | undefined } = {}): Promise<ProjectInfo> {
  const root = path.resolve(dir);
  const stat = await fs.stat(root).catch(() => null);
  if (stat === null || !stat.isDirectory()) {
    throw new ProjectError(`目录不存在：${root}`, '传项目根目录，例如 `actor doctor --dir ./my-app`');
  }
  const manifestPath = path.join(root, 'package.json');
  if (!(await exists(manifestPath))) {
    throw new ProjectError(
      `${root} 看起来不是 actor 项目（没有 package.json）`,
      '在项目根目录执行，或用 --dir 指定；新建项目：actor new app <dir>',
    );
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : path.basename(root);

  const dataDir = path.resolve(options.data ?? process.env.APP_DATA_DIR ?? path.join(root, 'data'));
  return {
    dir: root,
    name,
    dataDir,
    configDir: path.join(root, 'config'),
    hasMigrations: await exists(path.join(root, 'src', 'migrations.ts')),
    manifest,
  };
}

/** 加载项目的迁移数组：支持 default 导出（数组或返回数组的函数）与具名 `migrations`。 */
export async function loadMigrations(project: ProjectInfo): Promise<unknown[]> {
  const file = path.join(project.dir, 'src', 'migrations.ts');
  if (!(await exists(file))) return [];
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    throw new ProjectError(
      `加载 ${path.relative(project.dir, file)} 失败：${err instanceof Error ? err.message : String(err)}`,
      '这个文件必须是可独立导入的模块（依赖要在项目的 node_modules 里）',
    );
  }
  const candidate = module.default ?? module.migrations;
  if (candidate === undefined) {
    throw new ProjectError(
      `${path.relative(project.dir, file)} 没有导出迁移`,
      '导出默认值或具名 `migrations`：可以是数组，也可以是返回数组的函数',
    );
  }
  const resolved = typeof candidate === 'function' ? await (candidate as () => unknown)() : candidate;
  if (!Array.isArray(resolved)) {
    throw new ProjectError(
      `迁移不是数组（拿到 ${typeof resolved}）`,
      '形如：export default [{ version: 1, description: "...", async up() {} }]',
    );
  }
  return resolved;
}
