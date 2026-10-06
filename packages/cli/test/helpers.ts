import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑 CLI 并拿到退出码/stdout/stderr（不抛错：退出码本身是要断言的东西）。 */
export async function cli(args: string[], cwd = ROOT): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** 造一个最小但"结构完整"的项目（不依赖脚手架，测试点更集中）。 */
export function makeProject(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  const defaults: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name,
        type: 'module',
        engines: { node: '>=24' },
        dependencies: { '@actor/app': '*', '@actor/web': '*', '@actor/data': '*' },
      },
      null,
      2,
    ),
    'src/app.ts': 'export default {};\n',
    'main.ts': 'export {};\n',
    'config/default.ts': "import { defineConfig } from '@actor/app';\nexport default defineConfig({ dataDir: { type: 'string', default: './data' } });\n",
  };
  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

export function removeProject(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 两个示例迁移（第二个带 down，便于测回滚）。 */
export const MIGRATIONS_SOURCE = `
export default [
  { version: 1, description: '建表', async up() {}, async down() {} },
  { version: 2, description: '加索引', async up() {}, async down() {} },
];
`;
