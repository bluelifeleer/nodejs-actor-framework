/**
 * API 签名提取（零依赖，纯文本解析）。
 *
 * **为什么不用 TypeScript 的编译器 API**：本仓库的 devDependency 是 **typescript 7**（原生端口），
 * 它**不暴露** `createSourceFile` 这类 JS 编译器 API（实测只有 `version` / `default` 两个键）。
 * 为了一个文档生成器再引一份 typescript 5 不划算，所以这里按**声明文本**提取：
 * 函数取参数列表与返回标注、接口取字段、类取构造与公开方法。
 *
 * 两条来源：
 *   - **内核**：手写的 `packages/core/src/index.d.ts`（公开面声明）——内部实现文件仍有
 *     `@ts-nocheck`，所以"类型"的真相在 .d.ts 上；
 *   - **typed 包**（@actor/app|web|data|cli|testkit）：读源码。
 *
 * 只呈现**写出来的**标注：没标注就显示"未标注"，绝不猜一个类型出来（猜的没法核对，比空着更糟）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（门禁与页面都用它拼路径）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 `text[openIndex]` 开始读到配对的收尾括号，返回括号内的内容。 */
function readBalanced(text, openIndex, open = '(', close = ')') {
  let depth = 0;
  let index = openIndex;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, index), end: index };
    }
  }
  return { body: text.slice(openIndex + 1), end: text.length };
}

/** 按顶层逗号切分（忽略括号/尖括号/字符串里的逗号）。 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if ('([{<'.includes(char)) depth += 1;
    if (')]}>'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 解析形如 `name: Type` / `name?: Type` / `...name: Type[]` 的参数。 */
function parseParameter(text) {
  const [left, ...rest] = text.split(':');
  const namePart = left.trim();
  const type = rest.length === 0 ? null : rest.join(':').trim();
  return {
    name: namePart.replace(/^\.\.\./, '').replace(/[?!]$/, ''),
    rest: namePart.startsWith('...'),
    optional: namePart.includes('?') || text.includes('='),
    type: type === null ? null : collapse(type.replace(/\s*=\s*[\s\S]*$/, '').trim()),
  };
}

/** 多行类型（内联对象字面量）压成 `{ … }`：表格里放不下，细节另列。 */
function collapse(type) {
  return type.includes('\n') ? '{ … }' : type;
}

/** 声明上方紧邻的 JSDoc 摘要（取第一条非空、非 @ 开头的行）。 */
function docAbove(text, index) {
  const before = text.slice(0, index);
  const end = before.lastIndexOf('*/');
  if (end === -1) return null;
  const start = before.lastIndexOf('/**', end);
  if (start === -1) return null;
  // 中间不能隔着空行之外的代码：简单判断 "*/" 与声明之间只有空白
  if (before.slice(end + 2).trim() !== '') return null;
  const block = before.slice(start + 3, end);
  const line = block
    .split('\n')
    .map((entry) => entry.replace(/^\s*\*?\s?/, '').trim())
    .find((entry) => entry !== '' && !entry.startsWith('@'));
  return line ?? null;
}

const KIND_BY_KEYWORD = { function: '函数', class: '类', interface: '接口', type: '类型', const: '值', let: '值' };

/** 从一个文件里提取被导出的声明。 */
export function extractFromSource(text, fileName) {
  const found = new Map();
  // `export abstract class` 之类的修饰都要覆盖：漏一个，公开面门禁就会误报"缺声明"
  const pattern = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)(<[^>{}()]*>)?/gm;

  /** 由一次声明匹配建出条目（主循环与"非 export 的 CJS 导出"共用同一套解析）。 */
  const buildEntry = (match) => {
    const [full, keyword, name] = match;
    const generics = (match[3] ?? '').trim();
    const at = match.index ?? 0;
    const afterName = at + full.length;
    const doc = docAbove(text, at);
    const entry = { name, kind: KIND_BY_KEYWORD[keyword] ?? '其它', doc, params: [], returns: '—', signature: null };

    if (keyword === 'function') {
      const paren = text.indexOf('(', afterName);
      const { body, end } = readBalanced(text, paren);
      entry.params = splitTopLevel(body).map(parseParameter);
      const returnMatch = /^\s*:\s*([^;{=\n]+)/.exec(text.slice(end + 1));
      entry.returns = returnMatch === null ? '（未标注）' : returnMatch[1].trim().replace(/\s+$/, '');
      entry.signature = `${name}${generics}(${entry.params.map(fmtParam).join(', ')}) => ${entry.returns}`;
    } else if (keyword === 'const' || keyword === 'let') {
      const typeMatch = /^\s*:\s*([^=]+)=/.exec(text.slice(afterName));
      const rawType = typeMatch === null ? null : typeMatch[1].trim();
      entry.returns = rawType === null ? '（未标注）' : rawType.includes('\n') ? '{ … }' : rawType;
      // `export const plugins: { … } = {…}`：顺手把对象里的键列出来
      const braced = /^\s*:\s*\{([\s\S]*?)\}/.exec(text.slice(afterName));
      if (braced !== null) {
        entry.members = splitTopLevel(braced[1].replace(/\n/g, ' '))
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(0, 20);
      }
    } else if (keyword === 'interface') {
      const brace = text.indexOf('{', afterName);
      const { body } = readBalanced(text, brace, '{', '}');
      entry.members = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('//'))
        .slice(0, 20);
      entry.returns = '—';
    } else if (keyword === 'type') {
      const eq = text.indexOf('=', afterName);
      entry.returns = eq === -1 ? '—' : text.slice(eq + 1).split('\n')[0].trim();
    } else if (keyword === 'class') {
      const brace = text.indexOf('{', afterName);
      const { body } = readBalanced(text, brace, '{', '}');
      const constructorMatch = /constructor\s*\(/.exec(body);
      if (constructorMatch !== null) {
        const { body: ctorBody } = readBalanced(body, constructorMatch.index + constructorMatch[0].length - 1);
        entry.params = splitTopLevel(ctorBody).map(parseParameter);
      }
      entry.returns = '实例';
      entry.members = [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*(\([^)]*\))?\s*:\s*([^;]+);/gm)]
        .map((member) => `${member[1]}${member[2] ?? ''}: ${member[3].trim()}`)
        .slice(0, 20);
    }
    return entry;
  };

  for (const match of text.matchAll(pattern)) {
    const name = match[2];
    if (found.has(name)) continue;
    found.set(name, buildEntry(match));
  }

  // --- CJS 导出名：`module.exports = X` / `module.exports.N = X` / `module.exports = { a, b }` ---
  // 内核的函数/类刻意**不带 `export`**，只通过 `module.exports` 暴露。所以要先把"导出名"收集起来，
  // 再去同文件里找同名声明——否则源码侧只剩一个"值"，与手写声明一比对就全是假漂移。
  const cjsNames = new Set();
  for (const match of text.matchAll(/^module\.exports(?:\.([A-Za-z_$][\w$]*))?\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
    cjsNames.add(match[1] ?? match[2]);
  }
  for (const match of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const raw of splitTopLevel(match[1])) {
      const name = raw.split(':')[0].trim();
      if (name !== '') cjsNames.add(name);
    }
  }
  if (cjsNames.size > 0) {
    const bare = /^(?:abstract\s+)?(function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)(<[^>{}()]*>)?/gm;
    for (const match of text.matchAll(bare)) {
      const name = match[2];
      if (!cjsNames.has(name) || found.has(name)) continue;
      found.set(name, buildEntry(match));
    }
  }
  // 找不到同名声明的（命名空间对象等）保留"值"这一项，页面上照样能看到名字
  for (const name of cjsNames) {
    if (!found.has(name)) found.set(name, { name, kind: '值', doc: null, params: [], returns: '—' });
  }
  return { found, fileName };
}

function fmtParam(param) {
  return `${param.rest ? '...' : ''}${param.name}${param.optional ? '?' : ''}${param.type === null ? '' : `: ${param.type}`}`;
}

/** 解析声明文件（内核的 `.d.ts`）。 */
export function extractFromDeclarationFile(filePath) {
  return extractFromSource(fs.readFileSync(filePath, 'utf8'), filePath);
}

/** 递归列出包里的 `.ts` 源码（不含测试与声明文件）。 */
export function sourceFiles(root, packageDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'test'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };
  walk(path.join(root, packageDir));
  return found.sort();
}

/** 统计哪些源码文件还带 `@ts-nocheck`（构建时如实展示"类型覆盖进度"）。 */
export function untypedFiles(root, packageDir = 'packages/core') {
  return sourceFiles(root, packageDir)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('@ts-nocheck'))
    .map((file) => path.relative(root, file));
}

/**
 * 内核公开面门禁：**每个运行时导出都必须在手写声明文件里有声明**。
 *
 * 为什么值得单列一条检查：`index.d.ts` 是使用者看到的类型，而运行时导出才是真正存在的 API。
 * 两者一旦漂移，使用者要么拿到"不存在的类型"，要么拿到 `any`——而这两种都不会让任何测试变红。
 * 所以这里把它们逐名对齐，并且**门禁本身可被测试证伪**（喂一个假导出名，检查必须报缺）。
 */
export function checkPublicSurface({ root, runtimeNames, declarationFile = KERNEL_DECLARATION_FILE }) {
  const declared = extractFromDeclarationFile(path.join(root, declarationFile)).found;
  const missing = runtimeNames.filter((name) => !declared.has(name));
  return {
    ok: missing.length === 0,
    total: runtimeNames.length,
    declared: runtimeNames.length - missing.length,
    missing,
    declarationFile,
  };
}

/** 内核源码里还带 `@ts-nocheck` 的文件（目标恒为 0；非 0 说明严格检查有盲区）。 */
export const KERNEL_DECLARATION_FILE = 'packages/core/src/index.d.ts';

export function kernelUntypedFiles(root) {
  return untypedFiles(root, 'packages/core');
}

/** 源码侧收集"有真实声明"的条目（CJS 的 `module.exports` 只登记名字，不该盖住定义文件）。 */
export function collectSourceDeclarations(root, packageDir = 'packages/core') {
  const byName = new Map();
  const rank = (entry) => (entry.kind === '值' ? 0 : 1);
  for (const file of sourceFiles(root, packageDir)) {
    const parsed = extractFromSource(fs.readFileSync(file, 'utf8'), path.relative(root, file));
    for (const [name, entry] of parsed.found) {
      const current = byName.get(name);
      if (current === undefined || rank(entry) > rank(current)) byName.set(name, entry);
    }
  }
  return byName;
}

/**
 * 交叉核对：手写声明文件（对外承诺）与**源码**（实现）是否漂移。
 *
 * 只比对能可靠比对的东西，宁可少报也不误报：
 *   - 名称与类别（函数 / 类）；
 *   - 函数的**参数个数**（两边都没有 rest 参数时）。
 *
 * 刻意跳过：命名空间对象/接口/类型（两边表达方式不同，硬比会全是噪音）；
 * 带 rest 参数的函数（个数本来就可以不同）。这条检查的价值在于：
 * **`.d.ts` 与源码漂移时，没有任何测试会变红**——使用者会拿到与实现不符的类型。
 */
export function checkDeclarationDrift({ root, runtimeNames, declarationFile = KERNEL_DECLARATION_FILE }) {
  const declared = extractFromDeclarationFile(path.join(root, declarationFile)).found;
  const source = collectSourceDeclarations(root);
  const comparable = new Set(['函数', '类']);
  const findings = [];

  for (const name of runtimeNames) {
    const publicEntry = declared.get(name);
    if (publicEntry === undefined) continue; // 公开面缺失由 checkPublicSurface 负责
    if (!comparable.has(publicEntry.kind)) continue; // 命名空间/接口/类型不参与
    const sourceEntry = source.get(name);
    if (sourceEntry === undefined) {
      findings.push({ name, reason: '源码里找不到定义（声明与实现可能已不同步）' });
      continue;
    }
    if (sourceEntry.kind !== publicEntry.kind) {
      findings.push({ name, reason: `类别不同：声明是${publicEntry.kind}，源码是${sourceEntry.kind}` });
      continue;
    }
    if (publicEntry.kind === '函数') {
      const publicRest = publicEntry.params.some((param) => param.rest);
      const sourceRest = sourceEntry.params.some((param) => param.rest);
      if (!publicRest && !sourceRest && publicEntry.params.length !== sourceEntry.params.length) {
        findings.push({
          name,
          reason: `参数个数不同：声明 ${publicEntry.params.length} 个，源码 ${sourceEntry.params.length} 个`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings, compared: [...runtimeNames].filter((n) => comparable.has(declared.get(n)?.kind)).length };
}

/**
 * 文档里用到的**公开成员**（`ctx.clock`、`cluster.drain()`、`system.persistenceCapabilities()` …）。
 *
 * 为什么需要它：公开面门禁原先只比"顶层导出名 + 函数参数个数"，所以文档大量使用的
 * `ctx.sleep` / `spawn(def, { rateLimit })` / `cluster.drain()` 这些**成员**完全漏在
 * `index.d.ts` 之外，而使用者照文档写 TS 会直接报类型错误（审计的"文档承诺一致性 §7"）。
 *
 * 抽取方式（机械、可复核）：在 README 与 docs/**\/*.md 里找
 * `(ctx|system|cluster|app|ref|peer|this.<已知类型>).<成员>` 形式的用法，
 * 减去显式声明的"内部成员"（INTERNAL_MEMBERS，每条都要写理由），
 * 剩下的每个成员名都必须能在 `packages/core/src/index.d.ts` 里找到声明。
 */
export const DOC_RECEIVERS = ['ctx', 'system', 'cluster', 'app', 'pubsub'];

/**
 * 文档里出现、但属于**应用层/Web 层**而不是内核声明面的成员。
 *
 * 说明：`@actor/app` 与 `@actor/web` 目前**不发布 .d.ts**（只有内核有 `index.d.ts`），
 * 所以这些成员无法用本门禁核对。列在这里是为了让"为什么没查它"是**显式**的，
 * 而不是被静默跳过（这也是审计里"文档在用、公开面没有"那条的一部分）。
 */
export const APP_LAYER_MEMBERS = new Set([
  'actor',      // guide 03：@actor/web 的 ctx.actor(name)（Web 请求上下文，不是内核 ActorContext）
  'repository', // guide 04：@actor/web 的 ctx.repository(name)
  'get',        // guide 08：@actor/web 的 ctx.get(name)（按名字取应用服务/provider，内核 ActorContext 没有它）
  'game',       // README：应用自己注册到 system 上的服务名
]);

/** 明确"文档里出现但**不属于**公开声明面"的成员，必须逐条给理由。 */
export const INTERNAL_MEMBERS = new Set([
  // 内核内部结构（文档在讲实现细节时才提到）
  'cells', 'peers', 'installed', 'scheduler', 'rootSupervisor', 'mailbox',
  // 插件之间互相写的字段
  'metricsExporter', 'deadLetterStore', 'rateLimitPolicy', 'tracer',
  // 文档里作为"反例/边界"提到的
  'index', 'pending',
]);

/**
 * 只从**围栏代码块**里抽成员用法。
 *
 * 第一版我在整篇文档（含散文与 JSON 示例）上抽，结果噪声压过了信号：`app.json`、`req.body`、
 * `repo.get` 这些都会命中，设计文档里的未来 API（`ctx.stash`、`ctx.stateMachine`）也被算成"缺声明"。
 * 代码块 + 只扫面向使用者的文档（README/guide/quickstart），才让这条门禁有意义。
 */
export function extractMembersFromCodeBlocks(markdown, receivers = DOC_RECEIVERS) {
  return extractDocumentedMembers(codeBlocksOf(markdown), receivers);
}

/** 从文本里抽 `receiver.member` 用法。 */
export function extractDocumentedMembers(text, receivers = DOC_RECEIVERS) {
  const found = new Map(); // member -> 出现次数
  for (const receiver of receivers) {
    // 前面不能是词字符、`.`、`/`、`-`：否则 `packages/app/test`、`examples/app-data` 这类**路径**
    // 会被当成 `app.test` / `app.data` 用法（第一版就是这么误报的）。
    // 前面不能是：词字符、`.`、`/`、`-`、`@`、`:`、引号。
    //   - `packages/app/test`、`examples/app-data` 这类**路径**；
    //   - `pgsql://app:secret@db.internal:5432` 这类 **URL 主机名**；
    //   - `host: 'db.internal'` 这类**字符串字面量**（引号一围就说明它不是成员访问）。
    const re = new RegExp(`(?<![\\w./@:'"\u0060-])${receiver}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g');
    for (const match of text.matchAll(re)) {
      const member = match[1];
      if (INTERNAL_MEMBERS.has(member) || APP_LAYER_MEMBERS.has(member)) continue;
      found.set(member, (found.get(member) ?? 0) + 1);
    }
  }
  return [...found.keys()].sort();
}

/** 声明文本里出现过的成员名（`foo?:`、`foo(`、`foo:` 都算）。 */
export function declaredMemberNames(declarationText) {
  const names = new Set();
  // `<` 也要算：泛型方法（`spawn<M, R>(...)`）的第一版没被认出来，于是 `ctx.spawn` 被误报成"缺声明"
  for (const match of declarationText.matchAll(/^\s*(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*[?:(<]/gm)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * 返回"文档在用、但公开类型声明里没有"的成员。
 * 结果为空 = 文档里出现的公开成员都有类型声明。
 */
export function checkDocumentedMembers(docs, declarationText, options = {}) {
  const receivers = options.receivers ?? DOC_RECEIVERS;
  const declared = declaredMemberNames(declarationText);
  const missing = [];
  for (const doc of docs) {
    const codeText = doc.codeOnly === false ? doc.text : codeBlocksOf(doc.text);
    for (const member of extractDocumentedMembers(codeText, receivers)) {
      if (!declared.has(member)) missing.push({ member, file: doc.file });
    }
  }
  return missing;
}

/** 取出 markdown 里所有围栏代码块的内容。 */
export function codeBlocksOf(markdown) {
  const parts = [];
  for (const match of String(markdown).matchAll(/```[^\n]*\n([\s\S]*?)```/g)) parts.push(match[1]);
  return parts.join('\n');
}
