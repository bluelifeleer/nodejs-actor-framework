/**
 * **能力（capability）模型**：脚手架"选择包"的单一真相。
 *
 * 依赖闭包**不手写**：在仓库里就直接递归读各包 `package.json` 的 `dependencies`，
 * 再固化成 `templates/capabilities.json`（对外发布时用），并有一条测试断言"固化结果 == 真实闭包"——
 * 否则闭包一定会随着包依赖变化而烂掉。
 *
 * 概念区分（用户决策）：
 *   - `@actor/core` 是**内核**，恒在、不可选（由 `@actor/app` 带进来）；
 *   - 可选的是**能力包**：app / web / data / db / redis / mongodb / mail；
 *   - `upload` / `auth` / `debug` **不是包**，是 `@actor/web` 的**插件选项**（`--web-plugins`）。
 */

/** 可选能力 → 包名。 */
export const CAPABILITY_PACKAGES = {
  app: '@actor/app',
  web: '@actor/web',
  data: '@actor/data',
  db: '@actor/db',
  redis: '@actor/redis',
  mongodb: '@actor/mongodb',
  mail: '@actor/mail',
} as const;

export type Capability = keyof typeof CAPABILITY_PACKAGES;

/** web 的插件选项（不是包；选了就要求 web）。 */
export const WEB_PLUGINS = ['upload', 'auth', 'debug'] as const;
export type WebPlugin = (typeof WEB_PLUGINS)[number];

/** 默认只给最小可跑的一套：web（带 app）+ data。 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = ['web', 'data'];

export interface CapabilityClosure {
  /** 选中的能力（含闭包补进来的）。 */
  readonly capabilities: readonly Capability[];
  /** 选中的能力对应的包名（升序）。 */
  readonly packages: readonly string[];
  /**
   * **传递闭包**里所有 `@actor/*` 包（升序）。
   *
   * 生成的项目要把这些写进 `package.json` —— 它 import 的是真实用到的包
   * （例如 redis 片段会用 `@actor/resource`），不能指望"传递依赖恰好被提升到顶层"。
   */
  readonly transitivePackages: readonly string[];
  /** 选中的 web 插件（升序）。 */
  readonly webPlugins: readonly WebPlugin[];
}

export class CapabilityError extends Error {
  /** 给用户的下一步（错误信息里必须能照着做）。 */
  readonly hint: string;
  // 注意：不能用 TS 参数属性（`constructor(msg, readonly hint)`）——Node 的类型剥离不支持。
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'CapabilityError';
    this.hint = hint;
  }
}

interface WorkspacePackage {
  readonly name: string;
  readonly dependencies: readonly string[];
}

/** 闭包推导需要的"包依赖图"。 */
export type PackageGraph = ReadonlyMap<string, WorkspacePackage>;

/** 解析一次：能力名 → 包的依赖（递归用）。 */
export function resolveClosure(
  requested: readonly Capability[],
  webPlugins: readonly WebPlugin[],
  graph: PackageGraph,
): CapabilityClosure {
  const selected = new Set<Capability>();
  const transitives = new Set<string>();
  const queue: Capability[] = [...requested];

  // web 插件必须挂在 web 上（否则生成的接线没有对应包）
  if (webPlugins.length > 0 && !requested.includes('web')) {
    throw new CapabilityError(
      `--web-plugins ${webPlugins.join(',')} 需要同时选 --with web`,
      'web 插件是 @actor/web 的插件选项；加上 `--with web`（或去掉 --web-plugins）',
    );
  }

  while (queue.length > 0) {
    const capability = queue.shift() as Capability;
    if (selected.has(capability)) continue;
    const pkg = CAPABILITY_PACKAGES[capability];
    const node = graph.get(pkg);
    if (node === undefined) {
      throw new CapabilityError(
        `能力 '${capability}' 对应的包 ${pkg} 不在依赖图里`,
        '仓库内请确认 packages/ 下有这个包；对外请检查 templates/capabilities.json 是否过期',
      );
    }
    selected.add(capability);
    for (const dependency of node.dependencies) {
      // 依赖里凡是"能映射回能力"的，就一起选上（能力闭包）
      const nested = (Object.keys(CAPABILITY_PACKAGES) as Capability[]).find((key) => CAPABILITY_PACKAGES[key] === dependency);
      if (nested !== undefined && !selected.has(nested)) queue.push(nested);
      // 其余 @actor/* 依赖进"传递包"（生成的项目要声明它们）
      if (dependency.startsWith('@actor/') && dependency !== CAPABILITY_PACKAGES[capability]) transitives.add(dependency);
    }
  }

  const packages = [...selected].map((capability) => CAPABILITY_PACKAGES[capability]);
  return {
    capabilities: [...selected].sort(),
    packages: [...packages].sort(),
    transitivePackages: [...new Set([...packages, ...transitives])].sort(),
    webPlugins: [...webPlugins].sort(),
  };
}

/** 从一段"固化数据"（或仓库实时读取的结果）造依赖图。 */
export function graphOf(entries: readonly { name: string; dependencies?: readonly string[] }[]): PackageGraph {
  const map = new Map<string, WorkspacePackage>();
  for (const entry of entries) {
    map.set(entry.name, { name: entry.name, dependencies: [...(entry.dependencies ?? [])].sort() });
  }
  return map;
}

/** 固化数据形状：`templates/capabilities.json`。 */
export interface FrozenCapabilities {
  readonly generatedBy: string;
  readonly packages: readonly { name: string; dependencies: readonly string[] }[];
}

/** 校验请求里的名字，给出"拼错了"时的明确提示。 */
export function assertKnown(requested: readonly string[], webPlugins: readonly string[]): void {
  for (const name of requested) {
    if (!(name in CAPABILITY_PACKAGES)) {
      throw new CapabilityError(
        `未知能力 '${name}'`,
        `可选：${Object.keys(CAPABILITY_PACKAGES).join(' / ')}（内核 @actor/core 恒在，不用选）`,
      );
    }
  }
  for (const name of webPlugins) {
    if (!(WEB_PLUGINS as readonly string[]).includes(name)) {
      throw new CapabilityError(`未知的 web 插件 '${name}'`, `可选：${WEB_PLUGINS.join(' / ')}`);
    }
  }
}
