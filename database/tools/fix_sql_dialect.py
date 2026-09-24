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


STOP_WORDS = ('NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT',
              'GENERATED', 'COLLATE')


def _column_defs(body, bmask):
    """解析 CREATE TABLE 表体里的列定义 → [(name, type, default or None)]。"""
    cols = []
    for (a, b) in split_top_level(body, bmask):
        item = re.sub(r'--[^\n]*', '', body[a:b]).strip()
        if not item:
            continue
        first = item.split()[0].upper().strip('"')
        if first in ('CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE', 'INDEX', 'KEY', 'LIKE'):
            continue
        if re.search(r'\bGENERATED\b', item, re.I):
            continue
        m = re.match(r'("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(.*)$', item, re.S)
        if not m:
            continue
        name, rest = m.group(1), m.group(2)
        # 类型：直到第一个顶层约束关键字
        toks, depth, i, typ_end = rest, 0, 0, len(rest)
        while i < len(toks):
            ch = toks[i]
            depth += {'(': 1, ')': -1}.get(ch, 0)
            if depth == 0 and (i == 0 or toks[i - 1].isspace()):
                word = re.match(r'[A-Za-z]+', toks[i:])
                if word and word.group(0).upper() in STOP_WORDS:
                    typ_end = i
                    break
            i += 1
        typ = rest[:typ_end].strip()
        default = None
        dm = re.search(r'\bDEFAULT\b', rest[typ_end:], re.I)
        if dm:
            start = typ_end + dm.end()
            depth, j = 0, start
            while j < len(rest):
                ch = rest[j]
                depth += {'(': 1, ')': -1}.get(ch, 0)
                if depth == 0 and rest[j].isspace():
                    word = re.match(r'\s+([A-Za-z]+)', rest[j:])
                    if word and word.group(1).upper() in STOP_WORDS and word.group(1).upper() != 'NULL':
                        break
                j += 1
            default = rest[start:j].strip() or None
        if typ:
            cols.append((name, typ, default))
    return cols


def fix_idempotency(sql):
    """让 CREATE 语句可重复执行，并在 CREATE TABLE IF NOT EXISTS 后补齐已存在旧表缺少的列。"""
    n = 0
    rules = [
        (r'\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)([A-Za-z_])', r'CREATE \1INDEX IF NOT EXISTS \2'),
        (r'\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)([A-Za-z_"])', r'CREATE TABLE IF NOT EXISTS \1'),
        (r'\bCREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)([A-Za-z_])', r'CREATE SEQUENCE IF NOT EXISTS \1'),
        (r'\bCREATE\s+FUNCTION\b', 'CREATE OR REPLACE FUNCTION'),
        (r'\bCREATE\s+VIEW\b', 'CREATE OR REPLACE VIEW'),
        (r'\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)([A-Za-z_"])', r'ADD COLUMN IF NOT EXISTS \1'),
        (r'\bCREATE\s+MATERIALIZED\s+VIEW\s+(?!IF\s+NOT\s+EXISTS)([A-Za-z_])', r'CREATE MATERIALIZED VIEW IF NOT EXISTS \1'),
    ]
    mask = strip_comments_mask(sql)
    for pat, rep in rules:
        out, pos = [], 0
        for m in re.finditer(pat, mask, re.I):
            out.append(sql[pos:m.start()])
            out.append(re.sub(pat, rep, sql[m.start():m.end()], flags=re.I))
            pos = m.end(); n += 1
        out.append(sql[pos:])
        sql = ''.join(out)
        mask = strip_comments_mask(sql)
    # CREATE TYPE ... AS ENUM/(...)：已存在时跳过
    out, pos = [], 0
    for m in re.finditer(r'CREATE\s+TYPE\s+([A-Za-z0-9_."]+)\s+AS\s+[^;]*;', mask, re.I | re.S):
        stmt = sql[m.start():m.end()]
        before = sql[max(0, m.start() - 40):m.start()]
        if 'BEGIN' in before.upper():
            continue
        out.append(sql[pos:m.start()])
        out.append(f'DO $type$ BEGIN {stmt} EXCEPTION WHEN duplicate_object THEN NULL; END $type$;')
        pos = m.end(); n += 1
    out.append(sql[pos:]); sql = ''.join(out); mask = strip_comments_mask(sql)
    # CREATE TRIGGER name ... ON table：先 DROP TRIGGER IF EXISTS
    out, pos = [], 0
    for m in re.finditer(r'CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([A-Za-z0-9_"]+)\b[^;]*?\bON\s+([A-Za-z0-9_."]+)', mask, re.I | re.S):
        prev = sql[max(0, m.start() - 200):m.start()]
        if re.search(r'DROP\s+TRIGGER\s+IF\s+EXISTS\s+' + re.escape(m.group(1)), prev, re.I):
            continue
        out.append(sql[pos:m.start()])
        out.append(f'DROP TRIGGER IF EXISTS {m.group(1)} ON {m.group(2)};\n')
        pos = m.start(); n += 1
    out.append(sql[pos:]); sql = ''.join(out); mask = strip_comments_mask(sql)
    # 补列
    out, pos = [], 0
    for m in re.finditer(r'CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_."]+)\s*\(', mask, re.I):
        open_i = m.end() - 1
        d, k = 0, open_i
        while k < len(mask):
            d += {'(': 1, ')': -1}.get(mask[k], 0)
            if d == 0:
                break
            k += 1
        after = mask[k:k + 200]
        if re.match(r'\)\s*(INHERITS|PARTITION\s+OF)', after, re.I):
            continue
        cols = _column_defs(sql[open_i + 1:k], mask[open_i + 1:k])
        semi = mask.find(';', k)
        if semi < 0 or not cols:
            continue
        adds = []
        for (name, typ, default) in cols:
            t = typ.upper()
            if t in ('SERIAL', 'BIGSERIAL', 'SMALLSERIAL'):
                continue  # 主键列，旧表必然已有
            dflt = f' DEFAULT {default}' if default else ''
            adds.append(f'ALTER TABLE {m.group(1)} ADD COLUMN IF NOT EXISTS {name} {typ}{dflt};')
        marker = '-- [fix_sql_dialect] 补齐已存在旧表缺少的列'
        if marker in sql[semi:semi + 200]:
            continue
        out.append(sql[pos:semi + 1])
        out.append('\n' + marker + '\n' + '\n'.join(adds))
        pos = semi + 1; n += 1
    out.append(sql[pos:])
    return ''.join(out), n


OPTIONAL_EXT = ('pg_cron', 'pg_stat_statements', 'timescaledb', 'pg_partman', 'pg_repack', 'pgaudit', 'pg_hint_plan', 'hypopg')


def fix_optional_extensions(sql):
    """可选扩展（pg_cron/pg_stat_statements 等）不可用或无权限时跳过，相关 cron.* 调用仅在扩展存在时执行。"""
    n = 0
    mask = strip_comments_mask(sql)
    out, pos = [], 0
    pat = re.compile(r'CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(' + '|'.join(OPTIONAL_EXT) + r')"?[^;]*;', re.I)
    for m in pat.finditer(mask):
        if 'BEGIN' in sql[max(0, m.start() - 30):m.start()].upper():
            continue
        ext = m.group(1)
        out.append(sql[pos:m.start()])
        out.append(f"DO $ext$ BEGIN CREATE EXTENSION IF NOT EXISTS {ext}; "
                   f"EXCEPTION WHEN OTHERS THEN RAISE NOTICE '扩展 {ext} 不可用，跳过：%', SQLERRM; END $ext$;")
        pos = m.end(); n += 1
    out.append(sql[pos:]); sql = ''.join(out); mask = strip_comments_mask(sql)
    out, pos = [], 0
    for m in re.finditer(r'SELECT\s+(cron\.\w+\s*\([^;]*\))\s*;', mask, re.I | re.S):
        call = sql[m.start(1):m.end(1)]
        out.append(sql[pos:m.start()])
        out.append(f"DO $cron$ BEGIN IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN "
                   f"PERFORM {call}; END IF; END $cron$;")
        pos = m.end(); n += 1
    out.append(sql[pos:])
    return ''.join(out), n


def fix_trailing_value_commas(sql):
    pat = re.compile(r',([ \t]*(?:--[^\n]*)?\n(?:[ \t]*--[^\n]*\n|[ \t]*\n)*)([ \t]*)(ON\s+CONFLICT\b|;)', re.I)
    new, n = pat.subn(lambda m: m.group(1) + m.group(2) + m.group(3), sql)
    return new, n


def main():
    args = sys.argv[1:]
    idem = '--idempotent' in args
    args = [a for a in args if a != '--idempotent']
    for path in args:
        sql = open(path, encoding='utf-8').read()
        orig = sql
        sql, c1 = fix_line_comments(sql)
        sql, c2 = fix_create_tables(sql)
        sql, c3 = fix_trailing_value_commas(sql)
        sql, c4 = fix_index_expressions(sql)
        sql, c5 = fix_role_grants(sql)
        sql, c7 = fix_optional_extensions(sql)
        c5 += c7
        c3 += c4 + c5
        if idem:
            sql, c6 = fix_idempotency(sql)
            c3 += c6
        if sql != orig:
            open(path, 'w', encoding='utf-8').write(sql)
        print(f'{path}: comments={c1} inline-index/unique={c2} trailing-commas={c3}')


if __name__ == '__main__':
    main()
