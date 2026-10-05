import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 应用层配置系统（M1）。
 *
 * 分层（后者覆盖前者）：schema 默认值 → `config/default.*` → `config/<APP_ENV>.*`
 * → 环境变量（默认前缀 `APP_`，嵌套用 `__`）→ 显式 overrides（测试用）。
 * 校验在启动时一次性报出**全部**问题；`secret: true` 的键在诊断/日志中打码。
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'json';

export interface FieldSpec {
  type: FieldType;
  /** 有默认值即非必填（0 / false / '' 都算有值）。 */
  default?: unknown;
  /** 机密项：诊断与 redacted() 中打码。 */
  secret?: boolean;
  /** 允许显式 null。 */
  nullable?: boolean;
  min?: number;
  max?: number;
  regex?: RegExp | string;
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

export type ConfigSchema = { [key: string]: FieldSpec | ConfigSchema };

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(
      `配置校验失败（${issues.length} 项）：\n` +
        issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export interface ConfigDefinition<S extends ConfigSchema = ConfigSchema> {
  readonly __kind: 'actor.config';
  readonly schema: S;
  readonly fields: Map<string, FieldSpec>;
}

export interface LoadConfigOptions {
  /** 配置目录，默认 `<cwd>/config`。 */
  configDir?: string;
  /** 环境变量来源，默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 环境变量前缀，默认 `APP_`。 */
  envPrefix?: string;
  /** 显式覆盖（优先级最高，供测试与 CLI 使用）。 */
  overrides?: Record<string, unknown>;
}

export interface LoadedConfig {
  /** 扁平路径读取，如 `get('gateway.url')`。 */
  get<T = unknown>(dottedPath: string): T;
  /** 展开成嵌套对象（含机密真实值，仅限内部使用）。 */
  all(): Record<string, unknown>;
  /** 诊断用：机密项已打码。 */
  redacted(): Record<string, unknown>;
  /** 生效过的层级来源，便于排查"这个值从哪来"。 */
  readonly sources: readonly string[];
}

function isFieldSpec(value: unknown): value is FieldSpec {
  return typeof value === 'object' && value !== null && typeof (value as FieldSpec).type === 'string';
}

function flattenSchema(
  schema: ConfigSchema,
  prefix = '',
  out = new Map<string, FieldSpec>(),
): Map<string, FieldSpec> {
  for (const [key, value] of Object.entries(schema)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isFieldSpec(value)) out.set(dotted, value);
    else flattenSchema(value as ConfigSchema, dotted, out);
  }
  return out;
}

export function defineConfig<const S extends ConfigSchema>(schema: S): ConfigDefinition<S> {
  return Object.freeze({ __kind: 'actor.config' as const, schema, fields: flattenSchema(schema) });
}

function setDeep(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function getDeep(source: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = source;
  for (const part of dotted.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * 只写「已知配置项」的深合并。
 *
 * 为什么不用泛型版 `deepMerge<T, U>`：那里的 `T extends Record<string, unknown>`
 * 并不能让 interface 类型的对象通过（TS 只给对象字面量类型隐式索引签名），函数体里
 * 照样要强制转换，而签名却暗示了"类型级合并"这个运行时并不存在的承诺。
 * 这里改成表达**真实契约**：只接受白名单内的路径，未知路径作为问题回报（附来源标签，
 * 于是报错能指出是哪个文件写错了，而不只是"某处有 typo"）。
 */
function mergeKnown(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  known: ReadonlyMap<string, FieldSpec>,
  sourceLabel: string,
  issues: ConfigIssue[],
): void {
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
      if (isPlainObject && !known.has(dotted)) {
        // 未知子树：继续下探，好让每个叶子都能单独报错（含已知叶子照常写入）
        walk(value as Record<string, unknown>, dotted);
        continue;
      }
      if (isPlainObject) {
        setDeep(target, dotted, value); // json 类型字段：整体覆盖
        continue;
      }
      if (!known.has(dotted)) {
        issues.push({ path: dotted, message: `未知配置项（来自 ${sourceLabel}，拼写错误？）` });
        continue;
      }
      setDeep(target, dotted, value);
    }
  };
  walk(source, '');
}

function unflatten(values: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [dotted, value] of values) setDeep(out, dotted, value);
  return out;
}

function redact(
  nested: Record<string, unknown>,
  fields: Map<string, FieldSpec>,
): Record<string, unknown> {
  const clone = structuredClone(nested);
  for (const [dotted, spec] of fields) {
    if (spec.secret) setDeep(clone, dotted, '***');
  }
  return clone;
}

async function readConfigFile(file: string): Promise<Record<string, unknown> | null> {
  if (!fs.existsSync(file)) return null;
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} 必须是 JSON 对象`);
    return parsed as Record<string, unknown>;
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const value = mod.default ?? mod;
  if (typeof value !== 'object' || value === null) throw new Error(`${file} 必须默认导出一个配置对象`);
  return value as Record<string, unknown>;
}

async function loadFileLayers(
  configDir: string,
  envName: string,
  known: ReadonlyMap<string, FieldSpec>,
  issues: ConfigIssue[],
): Promise<{ merged: Record<string, unknown>; sources: string[] }> {
  const merged: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const base of ['default', envName]) {
    if (!base) continue;
    for (const ext of ['.json', '.ts', '.js', '.mjs']) {
      const file = path.join(configDir, `${base}${ext}`);
      const data = await readConfigFile(file);
      if (data) {
        const label = path.relative(process.cwd(), file);
        mergeKnown(merged, data, known, label, issues);
        sources.push(label);
        break; // 每个 base 只取第一个存在的文件
      }
    }
  }
  return { merged, sources };
}

function coerce(
  dotted: string,
  raw: unknown,
  spec: FieldSpec,
  issues: ConfigIssue[],
): unknown {
  switch (spec.type) {
    case 'number': {
      if (typeof raw === 'number') return raw;
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) issues.push({ path: dotted, message: `期望 number，实际 ${JSON.stringify(raw)}` });
      return parsed;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
      issues.push({ path: dotted, message: `期望 boolean，实际 ${JSON.stringify(raw)}` });
      return undefined;
    }
    case 'string': {
      if (typeof raw === 'string') return raw;
      issues.push({ path: dotted, message: `期望 string，实际 ${JSON.stringify(raw)}` });
      return undefined;
    }
    case 'json': {
      if (typeof raw === 'object' && raw !== null) return raw;
      try {
        return JSON.parse(String(raw)) as unknown;
      } catch {
        issues.push({ path: dotted, message: `期望 JSON，无法解析 ${JSON.stringify(raw)}` });
        return undefined;
      }
    }
    default:
      issues.push({ path: dotted, message: `未知的字段类型 ${String(spec.type)}` });
      return undefined;
  }
}

function validate(dotted: string, value: unknown, spec: FieldSpec, issues: ConfigIssue[]): void {
  if (spec.type === 'number' && typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) issues.push({ path: dotted, message: `不得小于 ${spec.min}（实际 ${value}）` });
    if (spec.max !== undefined && value > spec.max) issues.push({ path: dotted, message: `不得大于 ${spec.max}（实际 ${value}）` });
  }
  if (spec.type === 'string' && typeof value === 'string' && spec.regex) {
    const re = spec.regex instanceof RegExp ? spec.regex : new RegExp(spec.regex);
    if (!re.test(value)) issues.push({ path: dotted, message: `不匹配 ${re}` });
  }
  if (spec.enum && !spec.enum.includes(value as string | number | boolean)) {
    issues.push({ path: dotted, message: `取值必须是 ${spec.enum.map((v) => JSON.stringify(v)).join(' / ')}` });
  }
}

export async function loadConfig<S extends ConfigSchema>(
  definition: ConfigDefinition<S>,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const prefix = options.envPrefix ?? 'APP_';
  const envName = env.APP_ENV ?? env.NODE_ENV ?? 'development';
  const configDir = options.configDir ?? path.join(process.cwd(), 'config');

  const issues: ConfigIssue[] = [];
  const { merged, sources } = await loadFileLayers(configDir, envName, definition.fields, issues);

  // 环境变量命名约定：camelCase 字段 → UPPER_SNAKE，嵌套层级用 `__`
  // 例：tickMs → APP_TICK_MS；gateway.url → APP_GATEWAY__URL
  const envSegment = (segment: string): string =>
    segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

  for (const dotted of definition.fields.keys()) {
    const envKey = prefix + dotted.split('.').map(envSegment).join('__');
    if (env[envKey] !== undefined) {
      setDeep(merged, dotted, env[envKey]);
      sources.push(`env:${envKey}`);
    }
  }
  if (options.overrides) mergeKnown(merged, options.overrides, definition.fields, 'overrides', issues);
  const values = new Map<string, unknown>();
  for (const [dotted, spec] of definition.fields) {
    let raw = getDeep(merged, dotted);
    if (raw === undefined) {
      if (spec.default !== undefined) raw = spec.default;
      else if (spec.nullable) { values.set(dotted, null); continue; }
      else { issues.push({ path: dotted, message: '缺少必填配置（无默认值，且配置文件中未提供）' }); continue; }
    }
    if (raw === null && spec.nullable) { values.set(dotted, null); continue; }
    const coerced = coerce(dotted, raw, spec, issues);
    if (coerced === undefined) continue;
    validate(dotted, coerced, spec, issues);
    values.set(dotted, coerced);
  }
  if (issues.length > 0) throw new ConfigValidationError(issues);

  const nested = unflatten(values);
  return Object.freeze({
    get: <T = unknown>(dottedPath: string): T => values.get(dottedPath) as T,
    all: () => structuredClone(nested),
    redacted: () => redact(nested, definition.fields),
    sources: Object.freeze([...sources]),
  });
}
