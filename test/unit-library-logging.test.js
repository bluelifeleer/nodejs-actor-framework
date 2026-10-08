import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * P2 门禁：**库代码里不许有"裸 console"**。
 *
 * 为什么要这条：日志出口的纪律是"**库代码不自己决定输出**"（走 `logging.logger` / `app.logSink`，
 * 没配才 console 兜底）。一次疏忽就会变成"框架偷偷打了一行到 stdout"，而且**测试很难发现**
 * （stdout 不太会被断言）。所以这里用**标记制**：
 *
 *   - 每个 `console.*` 必须在**上一行或同一行**带 `// console-ok: <理由>`；
 *   - 内核 `packages/core/**` 暂时豁免（那些文件带 `@ts-nocheck`，见下面的理由），
 *     `packages/cli/**` 也不查（CLI 的输出**就是**它的用户界面，本来就该打 stdout）。
 *
 * 可证伪：往一个临时文件里放一行裸 `console.log`，扫描器必须报出来。
 */

const ROOT = path.join(import.meta.dirname, '..');
/** 被检查的包：应用层与 Web 层（有统一日志出口的地方）。 */
const CHECKED = ['packages/app/src', 'packages/web/src', 'packages/data/src', 'packages/db/src', 'packages/mail/src', 'packages/resource/src', 'packages/redis/src', 'packages/mongodb/src'];

/** 扫描一个目录树里的裸 console（没有 `// console-ok:` 标记的那种）。 */
function findBareConsole(dir, rootLabel = dir) {
  const findings = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/console\.(log|info|warn|error|debug)\s*\(/.test(line)) continue;
        const previous = lines[index - 1] ?? '';
        if (line.includes('// console-ok:') || previous.includes('// console-ok:')) continue;
        findings.push({ file: path.relative(ROOT, full) || rootLabel, line: index + 1, text: line.trim() });
      }
    }
  };
  walk(dir);
  return findings;
}

test('P2: 库代码里没有裸 console（每个调用都带 `// console-ok:` 理由）', () => {
  const findings = CHECKED.flatMap((dir) => findBareConsole(path.join(ROOT, dir)));
  assert.deepStrictEqual(
    findings,
    [],
    '这些 console 调用没有标记理由（要么改成走 logging.logger/app.logSink，要么加 `// console-ok: <理由>`）：\n' +
      findings.map((item) => `  ${item.file}:${String(item.line)}  ${item.text}`).join('\n'),
  );
});

test('P2: 门禁能证伪 —— 一行裸 console 必须被抓到', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-gate-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'bad.ts'),
      ['export function bad(): void {', '  console.log("偷偷打一行");', '}', ''].join('\n'),
      'utf8',
    );
    const found = findBareConsole(tmp);
    assert.strictEqual(found.length, 1, `裸 console 必须被抓到：${JSON.stringify(found)}`);
    assert.match(found[0]?.text ?? '', /偷偷打一行/);

    // 加上标记后就不再报（证明"标记制"本身有效，而不是整段忽略）
    fs.writeFileSync(
      path.join(tmp, 'good.ts'),
      ['export function good(): void {', '  // console-ok: 兜底', '  console.log("ok");', '}', ''].join('\n'),
      'utf8',
    );
    const after = findBareConsole(tmp).filter((item) => item.file.endsWith('good.ts'));
    assert.deepStrictEqual(after, [], '带标记的调用不该被报');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2: 内核与 CLI 的豁免是**显式**的（改口径必须改这条用例）', () => {
  // 内核多数文件带 @ts-nocheck（见 docs/design/next-steps.md §3），且它有自己的日志接缝
  // （`createSystem({ logger })`）；CLI 的输出就是它的用户界面。两条都**有意**不查。
  const core = path.join(ROOT, 'packages/core/src');
  const coreFindings = findBareConsole(core);
  assert.ok(coreFindings.length > 0, '内核当前确实还有裸 console —— 这条豁免是"已知并记录在案"，不是"没有"');
  const cli = path.join(ROOT, 'packages/cli/src');
  assert.ok(fs.existsSync(cli), 'CLI 必须存在');
});
