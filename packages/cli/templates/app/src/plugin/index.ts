import type { PluginSpec } from '@actor/app';

/**
 * 插件桶（由脚手架按你选的能力生成）。
 *
 * `server.ts` 只 import 这个文件，**不关心**你选了哪些能力 —— 生成器改的是这里，
 * 不需要去改 `server.ts`（避免脆弱的文本改写）。每个能力片段可以导出：
 *   - 一个 `PluginSpec`；或
 *   - 一个 `PluginSpec[]`（**空数组 = 该能力没配置，就不挂**，例如没给 JWT 密钥时的 auth）。
 */
const plugins: PluginSpec[] = [];

export default plugins;
