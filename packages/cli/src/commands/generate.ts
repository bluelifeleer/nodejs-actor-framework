/**
 * `actor generate <kind> <name>`：生成**常用骨架**（controller / actor / service / model / schema / middleware / test）。
 *
 * 与 `actor new app` / `actor add` 同一套纪律：
 *   - **非破坏性**：已存在的文件**默认拒绝覆盖**（`--force` 才写），`--dry-run` 一个字节都不写；
 *   - **不智能改写用户代码**：需要接线的位置（`src/module.ts`）**只打印要粘贴的片段**；
 *   - **生成的东西自带可跑的测试**（默认生成；`--no-test` 关掉），且必须能过 typecheck；
 *   - 形状跟随项目布局（layered：`src/<层>/`；flat：`src/` 扁平）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../args.ts';
import { mountWiring, type MountResult } from './mount.ts';
import { loadProject, ProjectError, type ProjectInfo } from '../project/load.ts';

/** 支持的骨架种类。 */
export const GENERATE_KINDS = [
  'controller',
  'actor',
  'service',
  'model',
  'schema',
  'middleware',
  'test',
  'command',
  'migration',
] as const;
export type GenerateKind = (typeof GENERATE_KINDS)[number];

/** 项目布局（决定生成到哪个目录）。 */
export type ProjectLayout = 'layered' | 'flat';

export interface FieldSpec {
  name: string;
  type: string;
}

/**
 * 算下一个迁移版本号。
 *
 * 做法：读 `src/migrations/**` 与 `src/migrations.ts` 的文本，抓所有 `version: <数字>`，
 * 取最大值 + 1（抓不到就从 1 开始）。**文本扫描而非导入**：导入用户迁移会执行它的副作用，
 * 而生成器只该读一眼。
 */
export async function nextMigration(project: ProjectInfo, explicit?: number): Promise<{ version: number }> {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1) {
      throw new UsageError(`--migration-version 必须是 >= 1 的整数（当前 ${String(explicit)}）`);
    }
    return { version: explicit };
  }
  const dir = path.join(project.dir, 'src', 'migrations');
  const candidates: string[] = [];
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    for (const entry of entries) if (String(entry).endsWith('.ts')) candidates.push(path.join(dir, String(entry)));
  } catch {
    /* 还没有 src/migrations/ 目录 */
  }
  const barrel = path.join(project.dir, 'src', 'migrations.ts');
  if (await exists(barrel)) candidates.push(barrel);

  let max = 0;
  for (const file of candidates) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/version:\s*(\d+)/g)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  return { version: max + 1 };
}

export interface GenerateResult {
  readonly dir: string;
  readonly kind: GenerateKind;
  readonly name: string;
  readonly layout: ProjectLayout;
  readonly dryRun: boolean;
  /** 会被写/改的文件（相对项目根，升序）。 */
  readonly files: readonly string[];
  /** `kind: 'migration'` 时：算出来的版本号（自动接续现有迁移）。 */
  readonly migrationVersion?: number;
  /** 已存在、因此**跳过**的文件（升序）。 */
  readonly skipped: readonly string[];
  /** 需要人工粘贴到 `src/module.ts` 的片段（`--mount` 未命中标记时会用到它）。 */
  readonly snippet: string;
  /** `--mount` 的结果（没给 `--mount` 就是 undefined）。 */
  readonly mount?: MountResult;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*([-_][a-zA-Z0-9]+)*$/;

/** `note-item` / `note_item` → `noteItem`。 */
export function camelOf(name: string): string {
  const parts = name.split(/[-_]/).filter((part) => part !== '');
  return parts.map((part, index) => (index === 0 ? part : part[0]?.toUpperCase() + part.slice(1))).join('');
}

/** `noteItem` → `NoteItem`（用于类型名）。 */
export function pascalOf(name: string): string {
  const camel = camelOf(name);
  return camel[0]?.toUpperCase() + camel.slice(1);
}

/** `noteItem` → `note-item`（用于文件名）。 */
export function kebabOf(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * 名字里已经带了"这一层"的后缀时，去掉它再拼标识符：`demo-actor` → `demoActor`（不是 `demoActorActor`）。
 *
 * 文件名仍按用户给的名字（`demo-actor.actor.ts`），只有**标识符**去重后缀 ——
 * 早先 `actor generate actor cart` 得到 `cartActor`（对），但 `actor generate actor demo-actor`
 * 会得到 `demoActorActor`（读起来像打错了）。文件名不动，避免生成两套命名规则。
 */
const KIND_SUFFIXES: Partial<Record<GenerateKind, string>> = {
  actor: 'actor',
  controller: 'controller',
  service: 'service',
  middleware: 'middleware',
  schema: 'schema',
  model: 'model',
};

export function baseNameFor(name: string, kind: GenerateKind): string {
  const suffix = KIND_SUFFIXES[kind];
  if (suffix === undefined) return name;
  const pattern = new RegExp(`(^|[-_])${suffix}$`, 'i');
  return pattern.test(name) ? name.replace(pattern, '') || name : name;
}

/** 解析 `--field title:string` → `{ name, type }`。 */
export function parseField(raw: string): FieldSpec {
  const [name, type] = raw.split(':', 2);
  if (name === undefined || name.trim() === '') {
    throw new UsageError(`--field 的格式是 <名字>:<类型>（拿到 '${raw}'）`, '例如：--field title:string --field done:bool');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())) {
    throw new UsageError(`--field 的字段名不合法：'${name.trim()}'`, '字段名必须是 TypeScript 标识符（字母/下划线开头）');
  }
  if (['id', 'createdAt', 'updatedAt', 'version'].includes(name.trim())) {
    throw new UsageError(`--field 的字段名 '${name.trim()}' 是保留名`, 'id/createdAt/updatedAt/version 由模型自己维护');
  }
  const normalized = (type ?? 'string').trim().toLowerCase();
  const allowed = ['string', 'text', 'number', 'int', 'bool', 'boolean', 'json', 'timestamp', 'uuid'];
  if (!allowed.includes(normalized)) {
    throw new UsageError(`--field 的类型不认识：'${normalized}'`, `支持：${allowed.join(' / ')}`);
  }
  return { name: name.trim(), type: normalized === 'int' ? 'number' : normalized === 'boolean' ? 'bool' : normalized };
}

/**
 * 判断项目布局（决定生成到 `src/<层>/` 还是 `src/` 扁平）。
 *
 * 判据按**证据强弱**来：
 *   ① 已经存在分层目录（`src/controller/` 或 `src/actor/`）→ layered；
 *   ② 只有扁平装配文件 `src/app.ts` → flat；
 *   ③ 只有 `src/module.ts`（layered 的装配文件）→ layered；
 *   ④ 都没有 → layered（脚手架默认；调用方会把布局打印出来，用户能立刻发现选错）。
 *
 * 为什么不用"有没有 module.ts"单独判断：实测生成项目在生成前**没有** `module.ts`，
 * 于是 flat 项目被误判成 layered（真踩过 —— `packages/cli/test/generate.test.ts` 里有这条用例）。
 */
export async function detectLayout(project: ProjectInfo): Promise<ProjectLayout> {
  const src = path.join(project.dir, 'src');
  if ((await exists(path.join(src, 'controller'))) || (await exists(path.join(src, 'actor')))) return 'layered';
  if (await exists(path.join(src, 'app.ts'))) return 'flat';
  if (await exists(path.join(src, 'module.ts'))) return 'layered';
  return 'layered';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 生成的文件内容（相对项目根 → 内容）。 */
export interface GeneratedFile {
  relative: string;
  content: string;
}

/** 把字段规格渲染成 `defineModel` 的字段声明。 */
function modelFields(fields: readonly FieldSpec[], options: { version: boolean }): string {
  const lines = [
    '    id: { type: \'uuid\', primaryKey: true },',
    ...fields.map((field) => {
      const map: Record<string, string> = {
        string: "{ type: 'string', length: 200, notNull: true }",
        text: "{ type: 'text', default: '' }",
        number: "{ type: 'integer', default: 0 }",
        bool: "{ type: 'boolean', default: false }",
        json: "{ type: 'json', default: [] }",
        timestamp: "{ type: 'timestamp', auto: 'create' }",
        uuid: "{ type: 'uuid' }",
      };
      return `    ${field.name}: ${map[field.type] ?? "{ type: 'string' }"},`;
    }),
    ...(options.version ? ["    version: { type: 'integer', version: true }, // 乐观锁"] : []),
    "    createdAt: { type: 'timestamp', auto: 'create' },",
  ];
  return lines.join('\n');
}

/** TypeScript 类型（model 的领域侧）。 */
function tsTypeOf(type: string): string {
  switch (type) {
    case 'number':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'json':
      return 'unknown[]';
    case 'timestamp':
      return 'string';
    default:
      return 'string';
  }
}

/** 生成骨架（纯函数：给名字/字段/布局，产出文件内容；不碰磁盘）。 */
export function generatedFiles(options: {
  kind: GenerateKind;
  name: string;
  layout: ProjectLayout;
  fields: readonly FieldSpec[];
  version: boolean;
  /** `kind: 'test'` 时：被测模块名（默认与 name 相同）。 */
  withTest: boolean;
  /** `kind: 'migration'` 时：版本号（不给就用调用方算好的接续值）。 */
  migrationVersion?: number;
}): GeneratedFile[] {
  const kebab = kebabOf(options.name);
  // 标识符用去重后缀的基名（`demo-actor` → `demoActor`），文件名仍用用户给的名字
  const camel = camelOf(baseNameFor(options.name, options.kind));
  const pascal = pascalOf(baseNameFor(options.name, options.kind));
  const files: GeneratedFile[] = [];
  const layered = options.layout === 'layered';

  if (options.kind === 'controller') {
    files.push({
      relative: layered ? `src/controller/${kebab}.controller.ts` : `src/${kebab}.controller.ts`,
      content: `import { defineController } from '@actor/web';

/**
 * ${pascal} 控制器：只放 **HTTP 语义**（输入校验、状态码、错误翻译）。
 *
 * 路由要挂到模块上（\`src/module.ts\`）——本命令**不改你的 module.ts**。
 */
export const ${camel} = defineController({
  input: {
    // 字符串简写 = 必填；要默认值写 { type: 'string', default: '' }
    name: 'string',
  },
  async handle(input) {
    return { ok: true, name: input.name };
  },
});

export default ${camel};
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.controller.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { buildRouteTable, dispatch, get } from '@actor/web';

import { ${camel} } from '../${layered ? 'src/controller' : 'src'}/${kebab}.controller.ts';

// 直接 dispatch（不起服务器）：验证输入校验与响应形状
const { routes, issues } = buildRouteTable([get('/${kebab}?name=', ${camel})]);
assert.deepStrictEqual(issues, [], '路由声明本身不该有问题');

test('${kebab} controller: 合法输入 → 200', async () => {
  const hit = await dispatch({ routes, request: { method: 'GET', url: '/${kebab}?name=alice' } });
  assert.strictEqual(hit.status, 200);
  assert.deepStrictEqual(JSON.parse(String(hit.response.body)), { ok: true, name: 'alice' });
});

test('${kebab} controller: 缺必填 → 400（不是 500）', async () => {
  const hit = await dispatch({ routes, request: { method: 'GET', url: '/${kebab}' } });
  assert.strictEqual(hit.status, 400);
});
`,
      });
    }
  }

  if (options.kind === 'actor') {
    files.push({
      relative: layered ? `src/actor/${kebab}.actor.ts` : `src/${kebab}.actor.ts`,
      content: `/**
 * ${pascal} Actor。
 *
 * **状态只放 \`this.state\`**（快照/恢复的契约就是你声明的这个属性）；
 * 状态写到别的字段看起来能跑，但重启后会归零。
 *
 * 持久化在模块的 \`actors\` 声明里开：
 *   \`{ definition: ${camel}Actor, options: { persistence: { mode: 'snapshot' } } }\`
 */
export interface ${pascal}State {
  hits: number;
}

export const ${camel}Actor = {
  preStart(this: { state: ${pascal}State }) {
    this.state = { hits: 0 };
  },

  async receive(this: { state: ${pascal}State }, msg: { type: 'ping' } | { type: 'reset' }) {
    if (msg.type === 'reset') {
      this.state.hits = 0;
      return this.state.hits;
    }
    this.state.hits += 1;
    return this.state.hits;
  },
};

export default ${camel}Actor;
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.actor.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';

import { ${camel}Actor } from '../${layered ? 'src/actor' : 'src'}/${kebab}.actor.ts';

test('${kebab} actor: 消息串行累加，ask 拿到返回值', async () => {
  const app = createApp(
    // actors 的**键就是路径**（不写 id 时）：这里用 ${pascal}
    defineApp({ modules: [defineModule({ name: 'test', actors: { ${pascal}: { definition: ${camel}Actor } } })] }),
    { configDir: '', env: {} },
  );
  await app.start();
  try {
    // ctx.actor() 故意返回 unknown（不把内核类型漏到应用层）：边界上显式收窄一次
    const ref = app.actor('${pascal}') as { ask<R = unknown>(msg: unknown, timeoutMs?: number): Promise<R> };
    assert.strictEqual(await ref.ask({ type: 'ping' }), 1);
    assert.strictEqual(await ref.ask({ type: 'ping' }), 2);
    assert.strictEqual(await ref.ask({ type: 'reset' }), 0);
  } finally {
    await app.stop();
  }
});
`,
      });
    }
  }

  if (options.kind === 'service') {
    files.push({
      relative: layered ? `src/service/${kebab}.service.ts` : `src/${kebab}.service.ts`,
      content: `/**
 * ${pascal} 服务：**装配点**（外部依赖/仓储都在这里接），别把业务塞进控制器。
 *
 * 换实现只改这一个文件；控制器按"结构化形状"用它（\`ctx.get('${camel}')\`）。
 */
export interface ${pascal}Options {
  /** 例如 DSN / 目录 / 上游地址。 */
  dsn: string;
}

export interface ${pascal}Service {
  readonly dsn: string;
  ping(): Promise<{ ok: true; dsn: string }>;
}

/** 工厂：在模块的 providers 里调用它（见模块片段）。 */
export function create${pascal}Service(options: ${pascal}Options): ${pascal}Service {
  return {
    dsn: options.dsn,
    async ping() {
      return { ok: true, dsn: options.dsn };
    },
  };
}

export default create${pascal}Service;
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.service.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { create${pascal}Service } from '../${layered ? 'src/service' : 'src'}/${kebab}.service.ts';

test('${kebab} service: 工厂产出的服务能应答（形状可替换）', async () => {
  const service = create${pascal}Service({ dsn: 'memory:' });
  assert.strictEqual(service.dsn, 'memory:');
  assert.deepStrictEqual(await service.ping(), { ok: true, dsn: 'memory:' });
});
`,
      });
    }
  }

  if (options.kind === 'model') {
    const fields = options.fields.length > 0 ? options.fields : [{ name: 'title', type: 'string' }];
    files.push({
      relative: layered ? `src/model/${kebab}.ts` : `src/${kebab}.ts`,
      content: `/**
 * ${pascal} 领域模型（**领域侧**类型；与库里那张表的映射在 \`src/schema/\` 的 defineModel 里）。
 */
export interface ${pascal} {
${fields.map((field) => `  ${field.name}: ${tsTypeOf(field.type)};`).join('\n')}
  id: string;
  createdAt: string;
}

export type ${pascal}Input = Omit<${pascal}, 'id' | 'createdAt'>;

/** Row（库里那行）→ 领域对象的映射；字段少时可以直接断言，多了建议显式逐字段。 */
export function to${pascal}(row: Record<string, unknown>): ${pascal} {
  return row as unknown as ${pascal};
}
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.model.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { to${pascal} } from '../${layered ? 'src/model' : 'src'}/${kebab}.ts';

test('${kebab} model: 行 → 领域对象映射可用（按需换成显式逐字段）', () => {
  const row = { id: '1', createdAt: '2026-01-01T00:00:00.000Z', ${fields.map((field) => `${field.name}: ${field.type === 'number' ? '1' : field.type === 'bool' ? 'true' : "'x'"} `).join(', ')} };
  const entity = to${pascal}(row);
  assert.strictEqual(entity.id, '1');
});
`,
      });
    }
  }

  if (options.kind === 'schema') {
    const fields = options.fields.length > 0 ? options.fields : [{ name: 'title', type: 'string' }];
    files.push({
      relative: layered ? `src/schema/${kebab}.schema.ts` : `src/${kebab}.schema.ts`,
      content: `import { defineModel } from '@actor/db';

/**
 * ${pascal} 的表声明（**声明式**：建表/漂移检测/行映射都由它推导）。
 *
 * 用它建表：\`db.sync([${pascal}])\`（开发）或写一个迁移（生产，见 docs 的迁移一节）。
 */
export const ${pascal} = defineModel({
  name: '${kebab.replace(/-/g, '_')}s',
  fields: {
${modelFields(fields, { version: options.version })}
  },
  indexes: [],
});

export default ${pascal};
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.schema.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { dialectFor } from '@actor/db';

import { ${pascal} } from '../${layered ? 'src/schema' : 'src'}/${kebab}.schema.ts';

test('${kebab} schema: 同一声明能在三种方言下建表', () => {
  for (const dialect of ['sqlite', 'pgsql', 'mysql'] as const) {
    const ddl = ${pascal}.createTableSql(dialectFor({ dialect }));
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS/);
  }
  const sqlite = ${pascal}.createTableSql(dialectFor({ dialect: 'sqlite' }));
  assert.match(sqlite, /"id" text NOT NULL PRIMARY KEY/, '主键要按方言渲染');
});
`,
      });
    }
  }

  if (options.kind === 'middleware') {
    files.push({
      relative: layered ? `src/middleware/${kebab}.ts` : `src/${kebab}.ts`,
      content: `import { atPre } from '@actor/web';

/**
 * ${pascal} 中间件（**阶段即函数名**：顺序由框架保证，不用你排）。
 *
 * 常用阶段：atPre（日志/限流/CORS）、atAuth（鉴权）、atPost（后置）。
 * 短路：不调 next() 直接返回即可；抛 HttpError 也会被映射成响应。
 */
export const ${camel}Middleware = atPre(async (ctx, next) => {
  ctx.state['${camel}'] = { at: Date.now() };
  return next();
}, '${kebab}');

export default ${camel}Middleware;
`,
    });
    if (options.withTest) {
      files.push({
        relative: `test/${kebab}.middleware.test.ts`,
        content: `import { test } from 'node:test';
import assert from 'node:assert';

import { buildRouteTable, defineController, dispatch, get } from '@actor/web';

import { ${camel}Middleware } from '../${layered ? 'src/middleware' : 'src'}/${kebab}.ts';

test('${kebab} middleware: 在控制器之前跑，并把派生值放进 ctx.state', async () => {
  const controller = defineController({ handle: (_input, ctx) => ({ seen: ctx.state['${camel}'] !== undefined }) });
  const { routes } = buildRouteTable([get('/mw', controller, [${camel}Middleware])]);
  const hit = await dispatch({ routes, request: { method: 'GET', url: '/mw' } });
  assert.strictEqual(hit.status, 200);
  assert.deepStrictEqual(JSON.parse(String(hit.response.body)), { seen: true });
});
`,
      });
    }
  }

  if (options.kind === 'migration') {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const version = options.migrationVersion ?? 1;
    files.push({
      relative: `src/migrations/${stamp}-${kebab}.ts`,
      content: `import type { Migration } from '@actor/data';

/**
 * 迁移 v${String(version)}：${pascal}
 *
 * 两条硬约束（\`@actor/data\` 的迁移运行器会检查）：
 *   1. \`version\` 从 1 开始、全局唯一且单调（不要求连续）；
 *   2. \`up\` 必须**幂等** —— 中途崩溃后会被重跑，所以优先用 \`IF NOT EXISTS\` / 先判存在再建。
 *
 * 写完之后：把它加进 \`src/migrations.ts\` 并放进数组（运行器按 version 排序，放哪都行）。
 * 想省事可以让 \`src/migrations.ts\` 显式 import 每个文件并 \`export default [...]\`。
 */
const migration: Migration = {
  version: ${String(version)},
  description: '${kebab}',

  // 迁移上下文**只有 \`store\` 与 \`log\`**（没有 \`run\`）：DDL 走你的数据层适配器，
  // 例如 \`db.sync([...])\` / 适配器自己的 \`query(sql)\`。下面先把"要做的事"记清楚。
  async up({ log }) {
    log('${kebab}: TODO 写建表/加列/建索引（必须幂等：崩溃后会被重跑）');
  },

  // 能回滚就写；没有 down 的迁移在 \`actor migrate down --to <v>\` 时会明确报错（不是静默跳过）
  // async down({ log }) {
  //   log('${kebab}: TODO 回滚');
  // },
};

export default migration;
`,
    });
  }

  if (options.kind === 'command') {
    // 自定义命令：写到 `.actor/commands/<kebab>.ts`（P4 的发现目录），并生成一条最小用例
    files.push({
      relative: `.actor/commands/${kebab}.ts`,
      content: `// 直接从 CLI 包导入（CLI 随项目发布；子进程执行时也能解析到）
import { defineCommand } from '@actor/cli/commands';

/**
 * \`actor ${kebab}\` —— 项目自己的命令。
 *
 * 约定：退出码 0 成功 / 1 用法错误 / 2 环境问题；\`--help\` 由框架自动生成（读下面的 flags 声明）。
 * 执行环境是**子进程**：这里的 process.exit / 抛错不会影响主 CLI。
 */
export default defineCommand({
  name: '${kebab}',
  summary: '${pascal}（把 summary 改成一句话说明）',
  usage: 'actor ${kebab} [--dry-run]',
  flags: {
    'dry-run': { type: 'boolean', default: false, description: '只打印计划，不落盘' },
    count: { type: 'number', default: 10, description: '处理条数' },
  },
  async run({ cwd, args, flags, stdout }) {
    if (args.length > 0) {
      throw new Error('${kebab} 不接受位置参数（要传值请用选项）');
    }
    stdout(\`项目目录：\${cwd}\`);
    stdout(\`dryRun=\${String(flags['dry-run'])} count=\${String(flags.count)}\`);
    // 这里写你的逻辑：读文件、连库、生成代码…
    return 0;
  },
});
`,
    });
  }

  if (options.kind === 'test') {
    // `actor generate test <name>`：给**同名控制器/actor**补一条端到端用例的骨架
    files.push({
      relative: `test/${kebab}.test.ts`,
      content: `import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';
import { httpPlugin } from '@actor/web';

/**
 * ${pascal} 的端到端用例骨架：**真起应用、真发请求**（不 mock 框架）。
 *
 * 把路由挂进模块后再断言；现在先用一条"起得来、停得掉"的用例占位。
 */
test('${kebab}: 应用起得来、停得掉（把路由接上后替换成真断言）', async () => {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'test' })], plugins: [http] }),
    { configDir: '', env: {} },
  );
  await app.start();
  try {
    const address = http.address();
    const base = \`http://127.0.0.1:\${String(address?.port)}\`;
    assert.strictEqual((await fetch(\`\${base}/nope\`)).status, 404, '未声明的路由就是 404');
  } finally {
    await app.stop();
  }
});
`,
    });
  }

  return files;
}

/** 需要粘贴到模块文件里的片段（**不自动改写用户代码**）。 */
export function wiringSnippet(options: {
  kind: GenerateKind;
  name: string;
  layout: ProjectLayout;
  fields: readonly FieldSpec[];
  /** `kind: 'migration'`：生成的文件名与版本（片段里要写对）。 */
  migrationFile?: string;
  migrationVersion?: number;
}): string {
  const baseName = baseNameFor(options.name, options.kind);
  const camel = camelOf(baseName);
  const pascal = pascalOf(baseName);
  const kebab = kebabOf(options.name);
  const prefix = options.layout === 'layered' ? `./${options.kind === 'schema' ? 'schema' : options.kind}/` : './';

  switch (options.kind) {
    case 'controller':
      return [
        `// src/module.ts —— 1) 顶部 import`,
        `import { ${camel} } from '${prefix}${kebab}.controller.ts';`,
        ``,
        `// 2) routes 里加一行（路径与输入来源自定）`,
        `get('/${kebab}?name=', ${camel}),`,
      ].join('\n');
    case 'actor':
      return [
        `// src/module.ts —— 1) 顶部 import`,
        `import { ${camel}Actor } from '${prefix}${kebab}.actor.ts';`,
        ``,
        `// 2) actors 里加一行（要持久化就加 options）`,
        `${pascal}: { definition: ${camel}Actor, options: { persistence: { mode: 'snapshot' } } },`,
      ].join('\n');
    case 'service':
      return [
        `// src/module.ts —— 1) 顶部 import`,
        `import { create${pascal}Service } from '${prefix}${kebab}.service.ts';`,
        ``,
        `// 2) providers 里加一行（控制器用 ctx.get('${camel}') 取）`,
        `${camel}: (deps) => {`,
        `  const config = deps['config'] as { get<T>(key: string): T };`,
        `  return create${pascal}Service({ dsn: config.get<string>('${camel}Dsn') });`,
        `},`,
      ].join('\n');
    case 'model':
    case 'schema':
      return [
        `// 模型/表声明不需要接线；用到它的地方直接 import：`,
        `import { ${pascal} } from '${prefix}${kebab}${options.kind === 'schema' ? '.schema' : ''}.ts';`,
        ``,
        `// 建表（开发/测试）：在 databaseAdapter 的 models 里加上它，或调 db.sync([${pascal}])`,
      ].join('\n');
    case 'middleware':
      return [
        `// src/module.ts —— 1) 顶部 import`,
        `import { ${camel}Middleware } from '${prefix}${kebab}.ts';`,
        ``,
        `// 2) 挂到模块（整棵子树）或单条路由`,
        `middleware: [${camel}Middleware],`,
      ].join('\n');
    case 'test':
      return '// 测试不需要接线：把路由挂进模块后，把占位断言换成真断言。';
    case 'migration':
      return [
        `// src/migrations.ts —— 把新迁移 import 进来并放进数组（文件名与版本号都对好了）`,
        `import v${String(options.migrationVersion ?? 1)} from './migrations/${options.migrationFile ?? kebabOf(options.name)}.ts';`,
        ``,
        `export default [/* 既有迁移… */, v${String(options.migrationVersion ?? 1)}];`,
        ``,
        `// 之后：actor migrate status → actor migrate up（生产上线前用 status 当门禁：有 pending 就退出码 2）`,
      ].join('\n');
    case 'command':
      return [
        `// 自定义命令不需要接线：文件放在 .actor/commands/ 下就会被自动发现`,
        `// 跑一下：actor ${kebab} --dry-run`,
        `// 看列表：actor commands`,
      ].join('\n');
    default:
      return '';
  }
}

/** 执行生成（`--dry-run` 时只算不写）。 */
export async function generate(
  kind: GenerateKind,
  name: string,
  options: {
    dir?: string;
    fields?: readonly FieldSpec[];
    version?: boolean;
    force?: boolean;
    dryRun?: boolean;
    test?: boolean;
    /** `kind: 'migration'`：显式指定版本号（不指定就自动接续现有迁移）。 */
    migrationVersion?: number;
    /** `--mount`：把接线插进模块文件的 `// @actor:mount <槽位>` 标记后面（没有标记就只给提示）。 */
    mount?: boolean;
  } = {},
): Promise<GenerateResult> {
  if (name === undefined || String(name).trim() === '') {
    throw new UsageError('缺少名字', `用法：actor generate ${kind} <name>`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new UsageError(
      `名字不合法：'${name}'`,
      '用 camelCase / kebab-case（字母开头，可含数字、-、_）：例如 note 或 note-item',
    );
  }

  // 项目定位：**必须**是已有项目（生成器不改项目形状，只往里加文件）
  let project: ProjectInfo;
  try {
    project = await loadProject(options.dir ?? process.cwd());
  } catch (error) {
    if (error instanceof ProjectError) {
      throw new UsageError(error.message, error.hint ?? '在项目根目录执行，或用 --dir 指定项目');
    }
    throw error;
  }

  const layout = await detectLayout(project);
  const fields = options.fields ?? [];
  const migration = kind === 'migration' ? await nextMigration(project, options.migrationVersion) : undefined;
  const generated = generatedFiles({
    kind,
    name,
    layout,
    fields,
    version: options.version === true,
    withTest: options.test !== false,
    ...(migration === undefined ? {} : { migrationVersion: migration.version }),
  });

  const written: string[] = [];
  const skipped: string[] = [];
  // 源文件被跳过时，配套测试也必须跳过：否则会造出一个 import 不存在导出的必然失败测试
  const skippedSources = new Set(
    (await Promise.all(
      generated
        .filter((file) => file.relative.startsWith('src/'))
        .map(async (file) => ((await exists(path.join(project.dir, file.relative))) && options.force !== true ? file.relative : null)),
    )).filter((file): file is string => file !== null),
  );
  for (const file of generated) {
    const destination = path.join(project.dir, file.relative);
    if (file.relative.startsWith('test/')) {
      const imported = /\.\.\/(src\/[^'"\s]+\.ts)/.exec(file.content)?.[1];
      if (imported !== undefined && skippedSources.has(imported)) {
        skipped.push(file.relative);
        continue;
      }
    }
    const link = await fs.lstat(destination).catch(() => null);
    if (link?.isSymbolicLink()) {
      throw new UsageError(`拒绝写入符号链接：${file.relative}`, '符号链接可能指向项目外；请先移除它');
    }
    if (await exists(destination) && options.force !== true) {
      skipped.push(file.relative);
      continue;
    }
    if (options.dryRun !== true) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, 'utf8');
    }
    written.push(file.relative);
  }

  // `--mount`：只往显式标记里插；没有标记 → 一个字节都不写（结果里带 missingMarkers 供 CLI 提示）
  const mount =
    options.mount === true
      ? await mountWiring({
          project,
          kind,
          name,
          layout,
          ...(migration === undefined
            ? {}
            : {
                migrationFile:
                  generated
                    .find((file) => file.relative.startsWith('src/migrations/'))
                    ?.relative.replace(/^src\/migrations\//, '')
                    .replace(/\.ts$/, '') ?? kebabOf(name),
              }),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        })
      : undefined;

  return {
    dir: project.dir,
    kind,
    name,
    layout,
    dryRun: options.dryRun === true,
    files: written.sort(),
    skipped: skipped.sort(),
    snippet: wiringSnippet({
      kind,
      name,
      layout,
      fields,
      ...(migration === undefined ? {} : { migrationFile: generated.find((file) => file.relative.startsWith('src/migrations/'))?.relative.replace(/^src\/migrations\//, '').replace(/\.ts$/, '') ?? kebabOf(name), migrationVersion: migration.version }),
    }),
    ...(migration === undefined ? {} : { migrationVersion: migration.version }),
    ...(mount === undefined ? {} : { mount }),
  };
}
