#!/usr/bin/env python3
"""把迁移里常见的 MySQL 风格 / 非法 PostgreSQL 写法机械地改成等价的 PostgreSQL。

处理项（只改能确定语义的写法）：
  1. CREATE TABLE 内的 `INDEX name (cols)` / `KEY name (cols)` / `UNIQUE INDEX|KEY name (cols)`
     → 移出表定义，改为表后的 `CREATE [UNIQUE] INDEX IF NOT EXISTS name ON table (cols);`
  2. CREATE TABLE 内带 WHERE 的部分唯一约束 `[CONSTRAINT n] UNIQUE (cols) WHERE cond`，
     以及含表达式的唯一约束（如 `UNIQUE (a, b::date)`）
     → 改为 `CREATE UNIQUE INDEX IF NOT EXISTS n ON table (cols) [WHERE cond];`
  3. 行注释 `// ...`（不在字符串内）→ `-- ...`
  4. VALUES 列表最后一行多余的逗号（后面紧跟 ON CONFLICT 或 `;`）

用法：python3 database/tools/fix_sql_dialect.py <file.sql> [...]   （原地修改，打印改动摘要）
"""
import re
import sys

IDENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def strip_comments_mask(sql):
    """返回与 sql 等长的掩码字符串：字符串/注释内的字符替换为空格，便于做括号匹配。"""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'" and j + 1 < n and sql[j + 1] == "'":
                    j += 2
                    continue
                if sql[j] == "'":
                    break
                j += 1
            out.append(' ' * (j - i + 1))
            i = j + 1
            continue
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i))
            i = j
            continue
        if sql.startswith('/*', i):
            j = sql.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(''.join(ch if ch == '\n' else ' ' for ch in sql[i:j]))
            i = j
            continue
        if c == '$':
            m = re.match(r'\$[A-Za-z0-9_]*\$', sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                j = n if j < 0 else j + len(tag)
                out.append(''.join(ch if ch == '\n' else ' ' for ch in sql[i:j]))
                i = j
                continue
        out.append(c)
        i += 1
    return ''.join(out)


def fix_line_comments(sql):
    lines = sql.split('\n')
    changed = 0
    for k, line in enumerate(lines):
        pos = line.find('//')
        while pos >= 0:
            before = line[:pos]
            if before.count("'") % 2 == 0 and '--' not in before and not before.rstrip().endswith(':'):
                lines[k] = before + '--' + line[pos + 2:]
                changed += 1
                break
            pos = line.find('//', pos + 2)
    return '\n'.join(lines), changed


def split_top_level(body, mask):
    """按深度 0 的逗号切分表体，返回 [(start, end)]。"""
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(mask):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append((start, i))
            start = i + 1
    parts.append((start, len(body)))
    return parts


def index_cols(cols):
    items, depth, cur = [], 0, ''
    for ch in cols:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            items.append(cur.strip())
            cur = ''
        else:
            cur += ch
    if cur.strip():
        items.append(cur.strip())
    fixed = []
    for it in items:
        head = re.sub(r'\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$', '', it, flags=re.I)
        if IDENT.match(head) or (head.startswith('(') and head.endswith(')')) \
                or re.match(r'^[A-Za-z_]\w*(\s+[A-Za-z_]\w*)+$', head):  # 列 + 操作符类/COLLATE
            fixed.append(it)
        else:
            fixed.append(f'({head})' + it[len(head):])
    return ', '.join(fixed)


def scoped_name(name, table):
    """MySQL 的索引名是表内作用域，PostgreSQL 是 schema 级：不含表名的通用名加上表名前缀，避免同名索引被 IF NOT EXISTS 静默跳过。"""
    t = table.split('.')[-1].strip('"')
    if t.lower() in name.lower():
        return name
    base = name[4:] if name.lower().startswith('idx_') else name
    return f'idx_{t}_{base}'[:63]


def fix_create_tables(sql):
    mask = strip_comments_mask(sql)
    out, pos, changes = [], 0, 0
    for m in re.finditer(r'CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)\s*\(', mask, re.I):
        if m.start() < pos:
            continue
        table = m.group(1)
        open_i = m.end() - 1
        depth, j = 0, open_i
        while j < len(mask):
            if mask[j] == '(':
                depth += 1
            elif mask[j] == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        close_i = j
        body, bmask = sql[open_i + 1:close_i], mask[open_i + 1:close_i]
        keep, extra = [], []
        for (a, b) in split_top_level(body, bmask):
            item, imask = body[a:b], bmask[a:b].strip()
            mi = re.match(r'(UNIQUE\s+)?(?:INDEX|KEY)\s+([A-Za-z0-9_]+)\s*\((.*?)\)\s*(WHERE\s+.*)?$', imask, re.S | re.I)
            if mi and not re.match(r'\s*(PRIMARY|FOREIGN)', imask, re.I):
                uniq = 'UNIQUE ' if mi.group(1) else ''
                real = re.sub(r'--[^\n]*', '', item).strip()
                open_p = real.index('(')
                d, k = 0, open_p
                while k < len(real):
                    d += {'(': 1, ')': -1}.get(real[k], 0)
                    if d == 0:
                        break
                    k += 1
                cols = index_cols(real[open_p + 1:k])
                where = real[k + 1:].strip()
                where = f' {where}' if where else ''
                extra.append(f'CREATE {uniq}INDEX IF NOT EXISTS {scoped_name(mi.group(2), table)} ON {table} ({cols}){where};')
                changes += 1
                continue
            mu = re.match(r'(?:CONSTRAINT\s+([A-Za-z0-9_]+)\s+)?UNIQUE\s*\((.*?)\)\s*(WHERE\s+(.*))?$', imask, re.S | re.I)
            if mu:
                real = item.strip()
                real_nc = re.sub(r'--[^\n]*', '', real)
                ci = real_nc.index('(')
                depth2, k = 0, ci
                while k < len(real_nc):
                    if real_nc[k] == '(':
                        depth2 += 1
                    elif real_nc[k] == ')':
                        depth2 -= 1
                        if depth2 == 0:
                            break
                    k += 1
                cols_raw = real_nc[ci + 1:k]
                rest = real_nc[k + 1:].strip()
                has_expr = any(not IDENT.match(c.strip()) for c in cols_raw.split(','))
                if rest.upper().startswith('WHERE') or has_expr:
                    name = mu.group(1) or f"{table.split('.')[-1].strip(chr(34))}_{'_'.join(re.findall(r'[A-Za-z0-9_]+', cols_raw))[:40]}_uniq"
                    where = f' {rest}' if rest else ''
                    extra.append(f'CREATE UNIQUE INDEX IF NOT EXISTS {name} ON {table} ({index_cols(cols_raw)}){where};')
                    changes += 1
                    continue
            keep.append(item)
        if not extra:
            continue
        new_body = ','.join(keep).rstrip()
        # 语句结束的分号
        semi = mask.find(';', close_i)
        semi = len(sql) if semi < 0 else semi
        out.append(sql[pos:open_i + 1])
        out.append(new_body + '\n')
        out.append(sql[close_i:semi + 1])
        out.append('\n' + '\n'.join(extra))
        pos = semi + 1
    out.append(sql[pos:])
    return ''.join(out), changes


def fix_index_expressions(sql):
    """CREATE INDEX ... ON t (a, b::date) → ON t (a, (b::date))。"""
    mask = strip_comments_mask(sql)
    out, pos, n = [], 0, 0
    for m in re.finditer(r'CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;(]*?\bON\s+[A-Za-z0-9_."]+\s*(?:USING\s+\w+\s*)?\(', mask, re.I):
        if m.start() < pos:
            continue
        open_i = m.end() - 1
        d, k = 0, open_i
        while k < len(mask):
            d += {'(': 1, ')': -1}.get(mask[k], 0)
            if d == 0:
                break
            k += 1
        cols = sql[open_i + 1:k]
        fixed = index_cols(cols)
        if fixed != ', '.join(c.strip() for c in cols.split(',')) and fixed.replace(' ', '') != cols.replace(' ', '').replace('\n', ''):
            out.append(sql[pos:open_i + 1]); out.append(fixed); pos = k; n += 1
    out.append(sql[pos:])
    return ''.join(out), n


def fix_role_grants(sql):
    """GRANT/REVOKE ... TO|FROM 某角色 → 角色存在时才执行（新库/其他环境没有这些角色）。"""
    pat = re.compile(r'^([ \t]*)((?:GRANT|REVOKE|ALTER\s+(?:TABLE|DEFAULT\s+PRIVILEGES)[^;]*?OWNER\s+TO)[^;]*?\b(?:TO|FROM)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;)', re.I | re.M)

    def repl(m):
        role = m.group(3)
        if role.lower() in ('public', 'current_user', 'session_user'):
            return m.group(0)
        stmt = m.group(2).rstrip(';').replace("'", "''")
        return (f"{m.group(1)}DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
                f"THEN EXECUTE '{stmt}'; END IF; END $grant$;")
    mask = strip_comments_mask(sql)
    out, pos, n = [], 0, 0
    for m in pat.finditer(sql):
        if mask[m.start(2):m.start(2) + 5].strip() == '':  # 在注释/字符串里
            continue
        out.append(sql[pos:m.start()]); out.append(repl(m)); pos = m.end(); n += 1
    out.append(sql[pos:])
    return ''.join(out), n


def fix_trailing_value_commas(sql):
    pat = re.compile(r',([ \t]*(?:--[^\n]*)?\n(?:[ \t]*--[^\n]*\n|[ \t]*\n)*)([ \t]*)(ON\s+CONFLICT\b|;)', re.I)
    new, n = pat.subn(lambda m: m.group(1) + m.group(2) + m.group(3), sql)
    return new, n


def main():
    for path in sys.argv[1:]:
        sql = open(path, encoding='utf-8').read()
        orig = sql
        sql, c1 = fix_line_comments(sql)
        sql, c2 = fix_create_tables(sql)
        sql, c3 = fix_trailing_value_commas(sql)
        sql, c4 = fix_index_expressions(sql)
        sql, c5 = fix_role_grants(sql)
        c3 += c4 + c5
        if sql != orig:
            open(path, 'w', encoding='utf-8').write(sql)
        print(f'{path}: comments={c1} inline-index/unique={c2} trailing-commas={c3}')


if __name__ == '__main__':
    main()
