#!/usr/bin/env python3
"""把指定 .ts 文件转成 .mts（ESM），并修正全仓引用方。"""
import pathlib, re, subprocess, sys
ROOT = pathlib.Path('.').resolve()
FIXED = {'crypto':'crypto','fs':'fs','path':'path','os':'os','net':'net','http':'http','https':'https','url':'url',
         'events':'events','readline':'readline','worker_threads':'workerThreads','assert':'assert','tls':'tls','util':'util',
         'timers':'timers','string_decoder':'string_decoder'}
EXTRA = {'test','test/reporters','sea','sqlite','wasi','timers/promises','assert/strict','fs/promises','dns/promises','stream/promises','util/types','inspector/promises','readline/promises','stream/consumers','stream/web','path/posix','path/win32'}
import json
BUILTINS = set(json.loads(pathlib.Path('/tmp/builtins.json').read_text()))
def is_builtin(spec):
    b = spec[5:] if spec.startswith('node:') else spec; r = b.split('/')[0]
    return b in BUILTINS or r in BUILTINS or b in EXTRA or r in EXTRA
def resolve_rel(importer, spec):
    t = importer.parent/spec
    for c, e in [(t,''), (t.with_suffix('.ts'),'.ts'), (t.with_suffix('.js'),'.js'), (t.with_suffix('.mts'),'.mts'), (t.with_suffix('.json'),'.json')]:
        if c.is_file(): return spec + e
    for i in ('index.ts','index.js','index.mts'):
        if (t/i).is_file(): return spec.rstrip('/') + '/' + i
    return None
def split_top(body):
    parts, depth, cur, q = [], 0, '', None
    for ch in body:
        if q:
            cur += ch
            if ch == q: q = None
            continue
        if ch in '\'"`': q = ch; cur += ch; continue
        if ch in '([{': depth += 1
        elif ch in ')]}': depth -= 1
        if ch == ',' and depth == 0: parts.append(cur); cur = ''
        else: cur += ch
    if cur.strip(): parts.append(cur)
    return [p.strip() for p in parts if p.strip()]

def convert(path, text):
    named, consts, items, whole = [], [], [], []
    pos, out = 0, []
    pat = re.compile(r"^module\.exports\s*=\s*", re.M)
    while True:
        m = pat.search(text, pos)
        if not m: out.append(text[pos:]); break
        out.append(text[pos:m.start()]); start = m.end()
        if text.startswith('{', start):
            depth, i, q = 0, start, None
            while i < len(text):
                c = text[i]
                if q:
                    if c == q: q = None
                elif c in '\'"`': q = c
                elif c == '{': depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0: i += 1; break
                i += 1
            end = i + (1 if i < len(text) and text[i] == ';' else 0)
            for p in split_top(text[start+1:i-1]):
                if re.fullmatch(r'\w+', p): named.append(p); items.append(p)
                else:
                    mm = re.match(r'(\w+)\s*:\s*(.+)$', p, re.S)
                    if mm and re.fullmatch(r'\w+', mm.group(2).strip()):
                        named.append(f"{mm.group(2).strip()} as {mm.group(1)}"); items.append(f"{mm.group(1)}: {mm.group(2).strip()}")
                    elif mm:
                        consts.append(f"export const {mm.group(1)} = {mm.group(2).strip()};"); items.append(f"{mm.group(1)}: {mm.group(2).strip()}")
            out.append(''); pos = end
        else:
            j = text.find(';', start); whole.append(text[start:j if j != -1 else len(text)].strip()); pos = (j+1) if j != -1 else len(text)
    s = ''.join(out)
    def prop(m):
        x, y = m.group(1), m.group(2).strip()
        if re.fullmatch(r'\w+', y):
            if x in named or y in named: return ''
            named.append(y if x == y else f"{y} as {x}"); return ''
        if x in named: return ''
        consts.append(f"export const {x} = {y};"); return ''
    s = re.sub(r"^module\.exports\.(\w+)\s*=\s*(.+?);[ \t]*$", prop, s, flags=re.M)
    stmts, seen, dedup = [], set(), []
    for n in named:
        b = n.split(' as ')[0].strip()
        if b in seen: continue
        seen.add(b); dedup.append(n)
    stmts.extend(dict.fromkeys(consts))
    for w in whole:
        # `module.exports = X`：default 之外必须再给具名导出，否则 CJS 侧
        # `const X = require(...)` 拿到的是命名空间而不是 X 本身（实测 124 个用例失败）。
        if re.fullmatch(r'\w+', w):
            named.append(w); dedup.append(w)
        stmts.append(f"export default {w};")
    if items: stmts.append('export default {\n  ' + ',\n  '.join(items) + ',\n};')
    ordered, seen2 = [], set()
    for n in dedup:
        b = n.split(' as ')[0].strip()
        if b in seen2: continue
        seen2.add(b); ordered.append(n)
    if ordered: stmts.insert(0, 'export { ' + ', '.join(ordered) + ' };')
    s = s + ('\n'.join(stmts) if stmts else '')
    imports = []
    def take(m):
        names, mod = m.group(1), m.group(2)
        braces = names.strip().startswith('{'); raw = ' '.join(names.strip().strip('{} ').split())
        if braces: raw = re.sub(r'(\w+)\s*:\s*(\w+)', r'\2 as \1', raw)
        if is_builtin(mod): spec = 'node:' + (mod[5:] if mod.startswith('node:') else mod)
        elif mod.startswith('.'):
            spec = resolve_rel(path, mod)
            if spec is None: return m.group(0)
        else: spec = mod
        imports.append(f"import {'{ '+raw+' }' if braces else names.strip()} from '{spec}';")
        return ''
    s = re.sub(r"^(?:const|let|var)\s+(\{[^}]+\}|\w+)\s*=\s*require\('([^']+)'\);[ \t]*$", take, s, flags=re.M)
    s = re.sub(r"^'use strict';\n\n?", '', s, count=1)
    if imports:
        first = re.search(r"^(?:import |export |const |let |var |function |class |/\*|//)", s, flags=re.M)
        p = first.start() if first else 0
        s = s[:p] + '\n'.join(dict.fromkeys(imports)) + '\n\n' + s[p:]
    if re.search(r"\brequire\(", s):
        s = "import { createRequire } from 'node:module';\n\n// 动态加载（循环依赖 / 可选依赖 / 按路径加载用户模块）保留 require 语义。\nconst require = createRequire(import.meta.url);\n\n" + s
    return s, {n.split(' as ')[-1].strip() for n in dedup}

for rel in sys.argv[1:]:
    f = ROOT/rel
    text = f.read_text()
    new, exported = convert(f, text)
    f.write_text(new)
    newname = f.with_suffix('.mts')
    subprocess.run(['git','mv',str(f),str(newname)], check=True)
    old_spec, new_spec = f.name, newname.name
    fixed = 0
    for g in [p for p in ROOT.rglob('*.ts') if 'node_modules' not in str(p)] + [p for p in ROOT.rglob('*.js') if 'node_modules' not in str(p)] + [p for p in ROOT.rglob('*.mts') if 'node_modules' not in str(p)]:
        if g == newname: continue
        t = g.read_text(); o = t
        t = re.sub(rf"require\('([^']*/)?{re.escape(old_spec)}'\)", lambda m: f"require('{m.group(1) or ''}{new_spec}')", t)
        t = re.sub(rf"from '([^']*/)?{re.escape(old_spec)}'", lambda m: f"from '{m.group(1) or ''}{new_spec}'", t)
        for name in exported:  # 类/函数：const X = require(...) → 解构
            t = re.sub(rf"const {name} = require\('([^']*{re.escape(new_spec)})'\);", rf"const {{ {name} }} = require('\1');", t)
        if t != o: g.write_text(t); fixed += 1
    print(f'  {rel} → {new_spec}（导出 {len(exported)} 个具名；修正引用方 {fixed} 个文件）')
