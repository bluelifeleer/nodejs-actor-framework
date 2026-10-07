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
