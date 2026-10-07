/**
 * `actor doctor`：把"跑不起来"的常见原因一次查完，并给出**可执行的下一步**。
 *
 * 与其它命令一样：不猜、不修（修是用户的事），只报告 + 退出码。
 * 每项检查都返回 { name, ok, detail, fix? }，所以既能给人看也能 `--json` 给脚本看。
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createFileMigrationStore, createMigrationRunner } from '@actor/data';

import { ProjectError, loadMigrations, loadProject } from '../project/load.ts';

export interface Check {
  name: string;
  ok: boolean;
  /** 通过时的简短说明；失败时是**问题描述**。 */
  detail: string;
  /** 失败时给出"下一步该做什么"。 */
  fix?: string;
}

export interface DoctorResult {
  project: string;
  dir: string;
  dataDir: string;
  checks: Check[];
  problems: number;
}

/** 试着绑一下端口，判断"能不能监听"（不依赖应用层，也不真的起服务）。 */
async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export async function doctor(dir: string, options: { data?: string; port?: number } = {}): Promise<DoctorResult> {
  const checks: Check[] = [];
  const project = await loadProject(dir, { data: options.data });

  // 1) Node 版本：源码直接跑 TS 且用 node:sqlite，低于 24 起不来
  const required = Number(String((project.manifest?.engines as { node?: string } | undefined)?.node ?? '>=24').replace(/[^\d]/g, '').slice(0, 2));
  const current = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node 版本',
    ok: current >= required,
    detail: `当前 v${process.versions.node}，项目要求 >= ${required}`,
    fix: `升级 Node 到 ${required} 或更高（nvm install ${required}）`,
  });

  // 2) 依赖：用户项目只该依赖 @actor/*（不该直接依赖内核）
  const deps = { ...(project.manifest?.dependencies as Record<string, string> | undefined) };
  const hasAppLayer = ['@actor/app', '@actor/web'].some((name) => name in deps);
  checks.push({
    name: '依赖声明',
    ok: hasAppLayer,
    detail: hasAppLayer ? `声明了 ${Object.keys(deps).filter((d) => d.startsWith('@actor/')).join(', ')}` : '没有声明 @actor/app 或 @actor/web',
    fix: 'npm install @actor/app @actor/web（用户项目不直接依赖内核 nodejs-actor-framework）',
  });

  // 3) 关键文件在不在（**两种布局都认**：layered 用 server.ts，flat 用 src/app.ts）
  const exists = (relative: string): Promise<boolean> =>
    fs
      .access(path.join(project.dir, relative))
      .then(() => true)
      .catch(() => false);
  const layered = await exists('server.ts');
  checks.push({
    name: '布局',
    ok: true,
    detail: layered ? 'layered（server.ts 装配 + 按业务分层）' : 'flat（src/app.ts + 扁平 src/）',
  });
  for (const [relative, why] of [
    [layered ? 'server.ts' : 'src/app.ts', layered ? '应用装配（defineApp + 插件接线）' : '应用定义（defineApp）'],
    ['config/default.ts', '配置（defineConfig）'],
    ['main.ts', '启动入口'],
  ] as const) {
    const present = await exists(relative);
    checks.push({
      name: `文件 ${relative}`,
      ok: present,
      detail: present ? `存在（${why}）` : `缺少（${why}）`,
      fix: present ? undefined : '用 `actor new app <dir>` 生成骨架对照着看',
    });
  }

  // 4) 配置能不能加载（这一步会真的导入项目里的配置模块）
  const configFile = path.join(project.configDir, 'default.ts');
  let configOk = true;
  let configDetail = '配置可加载';
  try {
    const loaded = (await import(pathToFileURL(configFile).href)) as { default?: { fields?: Map<string, unknown> } };
    if (loaded.default === undefined) throw new Error('没有 default 导出');
    const fields = loaded.default.fields?.size ?? 0;
    configDetail = `配置可加载（${fields} 个字段）`;
  } catch (err) {
    configOk = false;
    configDetail = `配置加载失败：${err instanceof Error ? err.message : String(err)}`;
  }
  checks.push({
    name: '配置',
    ok: configOk,
    detail: configDetail,
    fix: configOk ? undefined : 'config/default.ts 必须 `export default defineConfig({...})`，且依赖能在项目里解析',
  });

  // 5) 数据目录可写
  let dataOk = true;
  let dataDetail = `可写（${project.dataDir}）`;
  try {
    await fs.mkdir(project.dataDir, { recursive: true });
    const probe = path.join(project.dataDir, `.doctor-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  } catch (err) {
    dataOk = false;
    dataDetail = `不可写：${err instanceof Error ? err.message : String(err)}`;
  }
  checks.push({
    name: '数据目录',
    ok: dataOk,
    detail: dataDetail,
    fix: dataOk ? undefined : '检查目录权限，或用 --data / APP_DATA_DIR 指定别的位置',
  });

  // 6) 迁移状态（有迁移文件才查；"数据比代码新"是最该早发现的一种）
  if (project.hasMigrations) {
    try {
      const migrations = await loadMigrations(project);
      const runner = createMigrationRunner({
        store: createFileMigrationStore({ dir: project.dataDir }),
        migrations: migrations as never,
      });
      const status = await runner.status();
      const clean = status.pending.length === 0 && status.interrupted.length === 0 && status.unknown.length === 0;
      const parts = [
        `已应用 ${status.applied.length}`,
        status.pending.length > 0 ? `待应用 ${status.pending.map((v) => `v${v}`).join(',')}` : null,
        status.interrupted.length > 0 ? `中断 ${status.interrupted.map((v) => `v${v}`).join(',')}` : null,
        status.unknown.length > 0 ? `数据比代码新 ${status.unknown.map((v) => `v${v}`).join(',')}` : null,
      ].filter((part): part is string => part !== null);
      checks.push({
        name: '迁移',
        ok: clean,
        detail: `${migrations.length} 个迁移；${parts.join('；')}`,
        fix: clean
          ? undefined
          : status.unknown.length > 0
            ? '数据里的版本比代码新：先升级代码，不要降级跑'
            : '跑 `actor migrate up`（应用前会先看 `actor migrate status`）',
      });
    } catch (err) {
      checks.push({
        name: '迁移',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: 'src/migrations.ts 要能独立导入，并导出迁移数组',
      });
    }
  } else {
    checks.push({ name: '迁移', ok: true, detail: '这个项目没有迁移（约定位置 src/migrations.ts）' });
  }

  // 7) 端口能不能绑（默认 3000；被占用是最常见的"起不来"）
  const port = options.port ?? Number(process.env.APP_PLUGINS__HTTP__PORT ?? 3000);
  if (port !== 0 && Number.isInteger(port)) {
    const free = await canListen(port);
    checks.push({
      name: `端口 ${port}`,
      ok: free,
      detail: free ? '可监听' : '已被占用',
      fix: free ? undefined : `换端口：APP_PLUGINS__HTTP__PORT=<其它端口> npm start（或 0 = 随机）`,
    });
  }

  return {
    project: project.name,
    dir: project.dir,
    dataDir: project.dataDir,
    checks,
    problems: checks.filter((check) => !check.ok).length,
  };
}

export { ProjectError };
