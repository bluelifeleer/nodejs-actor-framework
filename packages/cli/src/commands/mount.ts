/**
 * `--mount`：把生成出来的骨架**接进**模块文件（`src/module.ts` / 扁平布局的 `src/app.ts`），
 * 以及迁移文件（`src/migrations.ts`）。
 *
 * 为什么默认不做、要 `--mount` 才做：`module.ts` 是**用户的文件**（他很可能改过）。用正则/AST
 * 去猜"插到哪个数组、哪一行"迟早会改坏别人的代码。所以这里的纪律是：
 *
 *   1. **只往显式标记里插**：文件里必须写着 `// @actor:mount <槽位>`，否则**一个字节都不写**，
 *      转而打印"你要加哪一行标记、加在哪里"；
 *   2. **幂等**：要插的那一行已经存在（同 import 路径 / 同条目）就跳过，不产生重复；
 *   3. **原子替换**：先写临时文件再 `rename` —— 要么全写成功，要么原文件不变（不留半截文件）；
 *   4. **`--dry-run` 零写入**：连临时文件都不建；
 *   5. **只插整行、不改已有行**：插入的行由生成器给出（与打印的片段是同一份），
 *      所以 `git diff` 里你一眼能看清改了什么。
 *
 * 槽位（slot）：`imports` / `providers` / `actors` / `routes` / `middleware` / `migrations`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { baseNameFor, camelOf, kebabOf, pascalOf, type GenerateKind, type ProjectLayout } from './generate.ts';
import type { ProjectInfo } from '../project/load.ts';

/** 标记前缀：`// @actor:mount imports`。 */
export const MOUNT_MARKER = '@actor:mount';

/** 支持自动挂载的槽位。 */
export const MOUNT_SLOTS = ['imports', 'providers', 'actors', 'routes', 'middleware', 'migrations'] as const;
export type MountSlot = (typeof MOUNT_SLOTS)[number];

export interface MountTarget {
  /** 相对项目根的目标文件。 */
  file: string;
  /** 这次要往哪些槽位插。 */
  slots: readonly MountSlot[];
  /** 目标文件不存在时，是否允许按模板新建（迁移文件用）。 */
  createIfMissing?: string;
}

export interface MountResult {
  /** 目标文件（相对项目根）；`null` 表示这个 kind 不需要接线。 */
  file: string | null;
  /** 本次真正插进去的行（含缩进），用于打印与断言。 */
  inserted: readonly string[];
  /** 已经有、因此跳过（幂等）。 */
  alreadyPresent: readonly string[];
  /** 文件里没找到的标记（存在这里就要给用户"怎么做"的提示）。 */
  missingMarkers: readonly { slot: MountSlot; marker: string }[];
  dryRun: boolean;
  /**
   * `no-wiring` = 这个 kind 天生不需要接线；`created` = 顺手新建了目标文件；
   * `missing-file` = 目标文件不存在（不是"没有标记"，提示要说清区别）。
   */
  note?: 'no-wiring' | 'created' | 'missing-file';
}

/**
 * `kind` → 目标文件与槽位。
 *
 * **两种布局的模块声明都在 `src/module.ts`**：扁平布局里 `src/app.ts` 只是 `defineApp` 入口
 * （`modules: [appModule]`），真正声明 providers/actors/routes 的是 `src/module.ts`。
 * 早先按"flat → src/app.ts"猜过一次，实测提示"没有标记"——因为那个文件里本来就不该有标记。
 */
export function mountTargetFor(kind: GenerateKind, layout: ProjectLayout): MountTarget | null {
  void layout; // 目标文件与布局无关（生成到哪个目录才与布局有关）
  const moduleFile = 'src/module.ts';
  switch (kind) {
    case 'controller':
      return { file: moduleFile, slots: ['imports', 'routes'] };
    case 'actor':
      return { file: moduleFile, slots: ['imports', 'actors'] };
    case 'service':
      return { file: moduleFile, slots: ['imports', 'providers'] };
    case 'middleware':
      return { file: moduleFile, slots: ['imports', 'middleware'] };
    case 'migration':
      return {
        file: 'src/migrations.ts',
        slots: ['imports', 'migrations'],
        createIfMissing: [
          "import type { Migration } from '@actor/data';",
          '',
          `// ${MOUNT_MARKER} imports`,
          '',
          'const migrations: Migration[] = [',
          `  // ${MOUNT_MARKER} migrations`,
          '];',
          '',
          'export default migrations;',
          '',
        ].join('\n'),
      };
    // 这几个不需要接线：模型/表声明是用到的地方自己 import；测试与自定义命令各有自己的发现机制
    case 'model':
    case 'schema':
    case 'test':
    case 'command':
      return null;
    default:
      return null;
  }
}

/** 每个槽位要插入的行（与 `wiringSnippet` 里打印给用户的是同一份）。 */
export function mountLines(options: {
  kind: GenerateKind;
  name: string;
  layout: ProjectLayout;
  /** `migration` 用：生成的文件名（不含扩展名）。 */
  migrationFile?: string;
}): Partial<Record<MountSlot, string[]>> {
  const camel = camelOf(baseNameFor(options.name, options.kind));
  const pascal = pascalOf(baseNameFor(options.name, options.kind));
  const kebab = kebabOf(options.name);

  // 导入路径必须与 `generatedFiles` 生成的**落盘位置**一致：layered 在 `src/<层>/`，flat 在 `src/`
  const layered = options.layout === 'layered';
  const fileFor = (base: string, suffix: string, layer: string): string =>
    layered ? `./${layer}/${base}${suffix}` : `./${base}${suffix}`;

  switch (options.kind) {
    case 'controller':
      return {
        imports: [`import { ${camel} } from '${fileFor(kebab, '.controller.ts', 'controller')}';`],
        routes: [`get('/${kebab}?name=', ${camel}),`],
      };
    case 'actor':
      return {
        imports: [`import { ${camel}Actor } from '${fileFor(kebab, '.actor.ts', 'actor')}';`],
        actors: [`${pascal}: { definition: ${camel}Actor },`],
      };
    case 'service':
      return {
        imports: [`import { create${pascal}Service } from '${fileFor(kebab, '.service.ts', 'service')}';`],
        // 单行、可直接跑；用 TODO 明确"还要把 dsn 接到配置上"（不替用户猜配置键名）
        providers: [`${camel}: () => create${pascal}Service({ dsn: '' }), // TODO: 把 dsn 接到 config 上`],
      };
    case 'middleware':
      return {
        imports: [`import { ${camel}Middleware } from '${fileFor(kebab, '.ts', 'middleware')}';`],
        middleware: [`${camel}Middleware,`],
      };
    case 'migration':
      return {
        imports: [`import ${camel} from './migrations/${options.migrationFile ?? kebab}';`],
        migrations: [`${camel},`],
      };
    default:
      return {};
  }
}

/** 缩进：`imports` 必须在顶层（第 0 列），其余槽位跟随标记自身的缩进。 */
function indentFor(slot: MountSlot, markerIndent: string): string {
  return slot === 'imports' ? '' : markerIndent;
}

/** 一行是否"已经在文件里"（幂等判据：去空白后全文包含）。 */
function alreadyThere(content: string, line: string): boolean {
  const needle = line.trim();
  if (needle === '') return true;
  return content
    .split('\n')
    .some((existing) => existing.trim() === needle);
}

export interface InsertPlan {
  content: string;
  inserted: string[];
  alreadyPresent: string[];
  missingMarkers: { slot: MountSlot; marker: string }[];
}

/**
 * 纯函数：在内存里算出"插完之后的内容"（不碰磁盘，便于测试与 `--dry-run`）。
 *
 * 每个槽位只插一次：在**第一处**该槽位的标记后面按顺序插入所有行（保持参数顺序）。
 */
export function planMount(content: string, lines: Partial<Record<MountSlot, string[]>>): InsertPlan {
  const inserted: string[] = [];
  const alreadyPresent: string[] = [];
  const missingMarkers: { slot: MountSlot; marker: string }[] = [];
  let working = content;

  for (const slot of MOUNT_SLOTS) {
    const wanted = lines[slot];
    if (wanted === undefined || wanted.length === 0) continue;
    const marker = `// ${MOUNT_MARKER} ${slot}`;
    const rows = working.split('\n');
    const markerIndex = rows.findIndex((row) => row.trim() === marker);
    if (markerIndex === -1) {
      missingMarkers.push({ slot, marker });
      continue;
    }
    const markerIndent = /^(\s*)/.exec(rows[markerIndex] ?? '')?.[1] ?? '';
    const fresh = wanted.filter((line) => !alreadyThere(working, line));
    alreadyPresent.push(...wanted.filter((line) => alreadyThere(working, line)));
    if (fresh.length === 0) continue;
    const block = fresh.map((line) => `${indentFor(slot, markerIndent)}${line}`);
    rows.splice(markerIndex + 1, 0, ...block);
    working = rows.join('\n');
    inserted.push(...block);
  }

  return { content: working, inserted, alreadyPresent, missingMarkers };
}

/** 「没找到标记」时给用户的操作说明（含可以直接粘的两行标记）。 */
export function missingMarkerHelp(file: string, missing: readonly { slot: MountSlot; marker: string }[]): string {
  const where: Record<MountSlot, string> = {
    imports: '文件顶部的 import 区（顶层，不要缩进）',
    providers: '`providers: {` 之后',
    actors: '`actors: {` 之后',
    routes: '`routes: defineRoutes([` 之后',
    middleware: '`middleware: [` 之后',
    migrations: '迁移数组里',
  };
  const lines = [
    `${file} 里没有找到这些挂载标记，所以**一个字节都没改**。要自动挂载，先加上标记：`,
    ...missing.map((item) => `  ${where[item.slot]} 加一行：${item.marker}`),
    '',
    '或者按上面打印的片段手工合并（两种方式都行）。',
  ];
  return lines.join('\n');
}

/**
 * 执行挂载。
 *
 * 目标文件不存在：`createIfMissing` 存在就按它新建（迁移文件）；否则报"缺文件"（由调用方转成提示）。
 */
export async function mountWiring(options: {
  project: ProjectInfo;
  kind: GenerateKind;
  name: string;
  layout: ProjectLayout;
  migrationFile?: string;
  dryRun?: boolean;
}): Promise<MountResult> {
  const target = mountTargetFor(options.kind, options.layout);
  if (target === null) {
    return { file: null, inserted: [], alreadyPresent: [], missingMarkers: [], dryRun: options.dryRun === true, note: 'no-wiring' };
  }

  const absolute = path.join(options.project.dir, target.file);
  let content: string | null = null;
  let created = false;
  try {
    content = await fs.readFile(absolute, 'utf8');
  } catch {
    if (target.createIfMissing !== undefined) {
      content = target.createIfMissing;
      created = true;
    } else {
      // 目标文件**不存在**：与"存在但没有标记"分开报（否则提示会误导成"你没写标记"）
      return {
        file: target.file,
        inserted: [],
        alreadyPresent: [],
        missingMarkers: [],
        dryRun: options.dryRun === true,
        note: 'missing-file',
      };
    }
  }

  const lines = mountLines({
    kind: options.kind,
    name: options.name,
    layout: options.layout,
    ...(options.migrationFile === undefined ? {} : { migrationFile: options.migrationFile }),
  });
  const plan = planMount(content, lines);

  // 只有"确实要插东西"时才写盘（幂等：第二次跑不会改动文件）
  if (plan.inserted.length > 0 && options.dryRun !== true) {
    // 原子替换：先写临时文件，再 rename —— 中途失败也不会留下半截 module.ts
    const temp = `${absolute}.mount-${process.pid}.tmp`;
    await fs.writeFile(temp, plan.content, 'utf8');
    await fs.rename(temp, absolute);
  }

  return {
    file: target.file,
    inserted: plan.inserted,
    alreadyPresent: plan.alreadyPresent,
    missingMarkers: plan.missingMarkers,
    dryRun: options.dryRun === true,
    ...(created ? { note: 'created' as const } : {}),
  };
}
