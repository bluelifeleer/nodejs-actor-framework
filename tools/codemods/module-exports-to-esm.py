import pathlib, re, sys
SRC = pathlib.Path('packages/core/src'); dry = '--dry' in sys.argv

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

def convert(s):
    out, pos = [], 0
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
            body = s[start+1:i-1]
            end = i
            if end < len(s) and s[end] == ';': end += 1
            named, exconst, default_items = [], [], []
            for p in split_top(body):
                if re.fullmatch(r'\w+', p):
                    named.append(p); default_items.append(p)
                else:
                    mm = re.match(r'(\w+)\s*:\s*(.+)$', p, re.S)
                    if mm and re.fullmatch(r'\w+', mm.group(2).strip()):
                        named.append(f"{mm.group(2).strip()} as {mm.group(1)}"); default_items.append(f"{mm.group(1)}: {mm.group(2).strip()}")
                    elif mm:
                        exconst.append(f"export const {mm.group(1)} = {mm.group(2).strip()};")
                        default_items.append(f"{mm.group(1)}: {mm.group(2).strip()}")
            stmts = []
            if named: stmts.append('export { ' + ', '.join(named) + ' };')
            stmts.extend(exconst)
            stmts.append('export default {\n  ' + ',\n  '.join(default_items) + ',\n};')
            out.append('\n'.join(stmts)); pos = end
        else:
            j = s.find(';', start)
            expr = s[start:j if j != -1 else len(s)].strip()
            out.append(f"export default {expr};" + ('\n' if j != -1 else ''))
            pos = (j + 1) if j != -1 else len(s)
    return ''.join(out)

changed = 0
for f in sorted(SRC.rglob('*.ts')):
    if f.name.endswith('.d.ts'): continue
    s = f.read_text()
    if 'module.exports' not in s: continue
    def prop(m):
        x, y = m.group(1), m.group(2).strip()
        if re.fullmatch(r'\w+', y):
            return f"export {{ {y} }};" if x == y else f"export {{ {y} as {x} }};"
        return f"export const {x} = {y};"
    new = re.sub(r"^module\.exports\.(\w+)\s*=\s*(.+?);[ \t]*$", prop, s, flags=re.M)
    new = convert(new)
    if 'module.exports' in new:
        print(f'  ⚠ 仍有残留: {f.relative_to(SRC)}')
    if new != s:
        changed += 1
        if not dry: f.write_text(new)
print(f'{"[dry] " if dry else ""}处理 module.exports: {changed} 个文件')
