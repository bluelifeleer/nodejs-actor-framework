#!/usr/bin/env python3
"""core 包（src + test + fixtures）CJS 语法 → ESM 语法，含具名导出去重。"""
import pathlib, re, sys
ROOT = pathlib.Path('.').resolve(); CORE = ROOT/'packages/core'
dry = '--dry' in sys.argv
FIXED = {'crypto':'crypto','fs':'fs','path':'path','os':'os','net':'net','http':'http','https':'https','url':'url',
         'events':'events','readline':'readline','worker_threads':'workerThreads','assert':'assert','tls':'tls','util':'util'}

def split_top(body):
    parts, depth, cur, quote = [], 0, '', None
    for ch in body:
        if quote:
            cur += ch
            if ch == quote: quote = None
            continue
        if ch in '\'"`': quote = ch; cur += ch; continue
        if ch in '([{': depth += 1
        elif ch in ')]}': depth -= 1
        if ch == ',' and depth == 0: parts.append(cur); cur = ''
        else: cur += ch
    if cur.strip(): parts.append(cur)
    return [p.strip() for p in parts if p.strip()]

def conv_exports(s):
    named_all, consts, defaults = [], [], []
    pos = 0; out = []
    pat = re.compile(r"^module\.exports\s*=\s*", re.M)
    while True:
        m = pat.search(s, pos)
        if not m: out.append(s[pos:]); break
        out.append(s[pos:m.start()]); start = m.end()
        if s.startswith('{', start):
            depth, i, quote = 0, start, None
            while i < len(s):
                c = s[i]
                if quote:
                    if c == quote: quote = None
                elif c in '\'"`': quote = c
                elif c == '{': depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0: i += 1; break
                i += 1
            body, end = s[start+1:i-1], i
            if end < len(s) and s[end] == ';': end += 1
            for p in split_top(body):
                if re.fullmatch(r'\w+', p):
                    named_all.append(p); defaults.append(p)
                else:
                    mm = re.match(r'(\w+)\s*:\s*(.+)$', p, re.S)
                    if mm and re.fullmatch(r'\w+', mm.group(2).strip()):
                        named_all.append(f"{mm.group(2).strip()} as {mm.group(1)}"); defaults.append(f"{mm.group(1)}: {mm.group(2).strip()}")
                    elif mm:
                        consts.append(f"export const {mm.group(1)} = {mm.group(2).strip()};")
                        defaults.append(f"{mm.group(1)}: {mm.group(2).strip()}")
            out.append(''); pos = end
        else:
            j = s.find(';', start)
            expr = s[start:j if j != -1 else len(s)].strip()
            defaults.append(f"__whole: {expr}")
            pos = (j + 1) if j != -1 else len(s)
    s = ''.join(out)
    # module.exports.X = expr → export const/具名（去重）
    def prop(m):
        x, y = m.group(1), m.group(2).strip()
        if re.fullmatch(r'\w+', y):
            if x in named_all or y in named_all: return ''
            named_all.append(y if x == y else f"{y} as {x}"); return ''
        if x in named_all: return ''
        consts.append(f"export const {x} = {y};"); return ''
    s = re.sub(r"^module\.exports\.(\w+)\s*=\s*(.+?);[ \t]*$", prop, s, flags=re.M)
    stmts = []
    seen = set()
    dedup = []
    for n in named_all:
        base = n.split(' as ')[0].strip()
        if base in seen: continue
        seen.add(base); dedup.append(n)
    if dedup: stmts.append('export { ' + ', '.join(dedup) + ' };')
    stmts.extend(dict.fromkeys(consts))
    # 单一 module.exports = X 的情况 → export default X；对象字面量 → default 对象
    whole = [d for d in defaults if d.startswith('__whole: ')]
    items = [d for d in defaults if not d.startswith('__whole: ')]
    if whole:
        for w in whole: stmts.append(f"export default {w[len('__whole: '):]};")
    elif items:
        stmts.append('export default {\n  ' + ',\n  '.join(items) + ',\n};')
    return s + ('\n'.join(stmts) if stmts else '')

def convert(path, text):
    s = text; imports = []
    def take(m):
        names, mod = m.group(1), m.group(2)
        base = mod[5:] if mod.startswith('node:') else mod
        braces = names.strip().startswith('{'); raw = names.strip().strip('{} ')
        if base in FIXED:
            imports.append(f"import {'{ '+raw+' }' if braces else names.strip()} from 'node:{base}';"); return ''
        spec = mod if re.search(r'\.(ts|mts|cts|js|mjs|json)$', mod) else mod + ('.ts' if path.suffix == '.ts' else '.js')
        imports.append(f"import {'{ '+raw+' }' if braces else names.strip()} from '{spec}';"); return ''
    s = re.sub(r"^(?:const|let|var)\s+(\{[^}]+\}|\w+)\s*=\s*require\('([^']+)'\);[ \t]*$", take, s, flags=re.M)
    s = conv_exports(s)
    s = s.replace('__dirname', 'import.meta.dirname')
    s = re.sub(r"^'use strict';\n\n?", '', s, count=1)
    if imports:
        first = re.search(r"^(?:import |export |const |let |var |function |class |/\*|//)", s, flags=re.M)
        pos = first.start() if first else 0
        s = s[:pos] + '\n'.join(dict.fromkeys(imports)) + '\n\n' + s[pos:]
    if re.search(r"\brequire\(", s):
        s = ("import { createRequire } from 'node:module';\n\n// 动态加载（循环依赖 / 可选依赖 / 按路径加载用户模块）保留 require 语义。\n"
             "const require = createRequire(import.meta.url);\n\n") + s
    return s

targets = [p for p in list((CORE/'src').rglob('*.ts')) + list((CORE/'test').rglob('*.js')) if not p.name.endswith('.d.ts')]
n = 0
for f in targets:
    t = f.read_text()
    new = convert(f, t)
    if 'module.exports' in new: print('  ⚠ 残留 module.exports:', f.relative_to(CORE))
    if new != t:
        n += 1
        if not dry: f.write_text(new)
print(f'{"[dry] " if dry else ""}改写 {n}/{len(targets)} 个文件（src+test+fixtures）')
