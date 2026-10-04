#!/usr/bin/env python3
"""core 的 CJS 语法 → ESM 语法。--dry 只报告。"""
import pathlib, re, sys
ROOT = pathlib.Path('.').resolve()
SRC = ROOT/'packages/core/src'
dry = '--dry' in sys.argv
CORE_FIXED = {'crypto':'crypto','fs':'fs','path':'path','os':'os','net':'net','http':'http','https':'https',
              'url':'url','events':'events','readline':'readline','worker_threads':'workerThreads','assert':'assert','tls':'tls'}
report = []
for f in sorted(SRC.rglob('*.ts')):
    if f.name.endswith('.d.ts'): continue
    s0 = s = f.read_text()
    imports, used = [], set()

    def take(m):
        names, mod = m.group(1), m.group(2)
        base = mod[5:] if mod.startswith('node:') else mod
        braces = names.strip().startswith('{')
        raw = names.strip().strip('{} ')
        if base in CORE_FIXED and braces:
            imports.append(f"import {{ {raw} }} from 'node:{base}';"); return ''
        if base in CORE_FIXED:
            imports.append(f"import {names.strip()} from 'node:{base}';"); return ''
        spec = mod if re.search(r'\.(ts|mts|cts|json)$', mod) else mod + '.ts'
        if braces:
            imports.append(f"import {{ {raw} }} from '{spec}';")
        else:
            imports.append(f"import {names.strip()} from '{spec}';")
        return ''

    s = re.sub(r"^(?:const|let|var)\s+(\{[^}]+\}|\w+)\s*=\s*require\('([^']+)'\);[ \t]*$", take, s, flags=re.M)

    # module.exports.X = Y  （X 已在导出列表里则删）
    exp_names = set()
    m0 = re.search(r"module\.exports\s*=\s*\{([^}]*)\}", s, re.S)
    if m0: exp_names = {n.strip().split(':')[0].strip() for n in m0.group(1).split(',') if n.strip()}
    def prop(m):
        x, y = m.group(1), m.group(2)
        if x in exp_names: return ''
        return f"export {{ {y} }};" if x == y else f"export {{ {y} as {x} }};"
    s = re.sub(r"^module\.exports\.(\w+)\s*=\s*(\w+);[ \t]*$", prop, s, flags=re.M)

    # module.exports = { ... } → export {...} + export default {...}
    def obj(m):
        body = m.group(1)
        names = [n.strip().split(':')[0].strip() for n in body.split(',') if n.strip()]
        simple = all(re.fullmatch(r'\w+', n) for n in names)
        if simple:
            j = ', '.join(names)
            return f"export {{ {j} }};\nexport default {{ {j} }};"
        return m.group(0)
    s = re.sub(r"^module\.exports\s*=\s*(\{[^;]*?\});", obj, s, flags=re.M | re.S)
    # module.exports = class / 标识符
    s = re.sub(r"^module\.exports\s*=\s*(class\s+\w+)", r"export default \1", s, flags=re.M)
    s = re.sub(r"^module\.exports\s*=\s*(\w+);", r"export default \1;", s, flags=re.M)

    s = s.replace('__dirname', 'import.meta.dirname')
    s = re.sub(r"^'use strict';\n\n?", '', s, count=1)

    if imports:
        first = re.search(r"^(?:import |export |const |let |var |function |class |/\*|//)", s, flags=re.M)
        pos = first.start() if first else 0
        s = s[:pos] + '\n'.join(dict.fromkeys(imports)) + '\n\n' + s[pos:]

    # 仍含 require( 的文件（动态加载）→ createRequire 前导
    leftover = re.findall(r"\brequire\(", s)
    if leftover:
        pre = "import { createRequire } from 'node:module';\n\n// 动态加载（循环依赖 / 可选依赖 / 按路径加载用户模块）必须保留 require 语义。\nconst require = createRequire(import.meta.url);\n\n"
        s = pre + s
    if s != s0:
        report.append((str(f.relative_to(SRC)), len(imports), len(leftover), 'module.exports' in s))
        if not dry: f.write_text(s)
print(f'{"[dry] " if dry else ""}改写 {len(report)} 个文件')
for r in report[:6]: print(f'   {r[0]:34s} imports+{r[1]:2d} 动态require:{r[2]}')
rest = [r[0] for r in report if r[3]]
print(f'   仍有 module.exports 的文件: {len(rest)} {rest[:5]}')
