#!/usr/bin/env python3
"""
修复迁移文件中的外键类型不匹配（例如 user_id INTEGER REFERENCES users(id)，而 users.id 是 UUID）。

用法：
  python3 database/tools/fix_fk_types.py [--dry-run] <migration.sql> ...
  python3 database/tools/fix_fk_types.py --from-report database/bootstrap-report.json

规则：
  * 从 V1 初始 schema 和被修复文件自身的 CREATE TABLE 中收集"表.列 -> 类型"
  * 对每个外键（列内联 REFERENCES t(c) 或表级 FOREIGN KEY (x) REFERENCES t(c)），
    若引用列类型与被引用列类型不属于同一类型族，则把引用列的类型改成被引用列的类型
    （SERIAL -> INTEGER，BIGSERIAL -> BIGINT）
  * 只改列定义里的类型关键字，不动其它内容
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TYPE_RE = r"(UUID|BIGSERIAL|SERIAL|BIGINT|INTEGER|INT|SMALLINT|VARCHAR\(\d+\)|TEXT|CHAR\(\d+\))"
CREATE_RE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?\"?(\w+)\"?\s*\(", re.I)


def family(t):
    t = t.upper()
    if t == 'UUID':
        return 'uuid'
    if t in ('BIGSERIAL', 'SERIAL', 'BIGINT', 'INTEGER', 'INT', 'SMALLINT'):
        return 'int'
    return 'text'


def ref_type(t):
    t = t.upper()
    return {'SERIAL': 'INTEGER', 'BIGSERIAL': 'BIGINT'}.get(t, t)


def table_blocks(sql):
    """yield (table, start, end) for every CREATE TABLE (...) body"""
    for m in CREATE_RE.finditer(sql):
        depth, i = 1, m.end()
        while i < len(sql) and depth:
            if sql[i] == '(':
                depth += 1
            elif sql[i] == ')':
                depth -= 1
            i += 1
        yield m.group(1).lower(), m.end(), i - 1


def collect_types(sql, types):
    for table, s, e in table_blocks(sql):
        for line in sql[s:e].split('\n'):
            m = re.match(r"\s*\"?(\w+)\"?\s+" + TYPE_RE + r"\b", line, re.I)
            if m and m.group(1).upper() not in ('PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT', 'CHECK'):
                types.setdefault(table, {})[m.group(1).lower()] = m.group(2).upper()


def fix_file(path, base_types, dry_run=False):
    sql = path.read_text(encoding='utf-8')
    types = {t: dict(c) for t, c in base_types.items()}
    collect_types(sql, types)
    changes = []
    out = sql
    for table, s, e in sorted(table_blocks(sql), key=lambda x: -x[1]):
        body = out[s:e]
        cols = {}
        for line in body.split('\n'):
            m = re.match(r"\s*\"?(\w+)\"?\s+" + TYPE_RE + r"\b", line, re.I)
            if m:
                cols[m.group(1).lower()] = m.group(2).upper()
        fks = []  # (column, ref_table, ref_col)
        for m in re.finditer(r"^\s*\"?(\w+)\"?\s+" + TYPE_RE + r"\b[^,\n]*?REFERENCES\s+(?:public\.)?\"?(\w+)\"?\s*\(\s*\"?(\w+)\"?\s*\)", body, re.I | re.M):
            fks.append((m.group(1).lower(), m.group(3).lower(), m.group(4).lower()))
        for m in re.finditer(r"FOREIGN\s+KEY\s*\(\s*\"?(\w+)\"?\s*\)\s*REFERENCES\s+(?:public\.)?\"?(\w+)\"?\s*\(\s*\"?(\w+)\"?\s*\)", body, re.I):
            fks.append((m.group(1).lower(), m.group(2).lower(), m.group(3).lower()))
        new_body = body
        for col, rt, rc in fks:
            want = types.get(rt, {}).get(rc)
            have = cols.get(col)
            if not want or not have or family(want) == family(have):
                continue
            target = ref_type(want)
            pat = re.compile(r"^(\s*\"?" + re.escape(col) + r"\"?\s+)" + TYPE_RE + r"\b", re.I | re.M)
            new_body, n = pat.subn(lambda m: m.group(1) + target, new_body, count=1)
            if n:
                changes.append(f"{table}.{col}: {have} -> {target} (references {rt}.{rc})")
        out = out[:s] + new_body + out[e:]
    # ALTER TABLE ... ADD COLUMN x TYPE REFERENCES t(c)
    def alter_fix(m):
        col, have, rt, rc = m.group(2).lower(), m.group(3).upper(), m.group(5).lower(), m.group(6).lower()
        want = types.get(rt, {}).get(rc)
        if want and family(want) != family(have):
            changes.append(f"ALTER ADD COLUMN {col}: {have} -> {ref_type(want)} (references {rt}.{rc})")
            return m.group(1) + ref_type(want) + m.group(4)
        return m.group(0)
    out = re.sub(r"(ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?\"?(\w+)\"?\s+)" + TYPE_RE + r"(\b[^;\n]*?REFERENCES\s+(?:public\.)?\"?(\w+)\"?\s*\(\s*\"?(\w+)\"?\s*\))",
                 alter_fix, out, flags=re.I)
    if changes and not dry_run:
        path.write_text(out, encoding='utf-8')
    return changes


def main(argv):
    dry = '--dry-run' in argv
    argv = [a for a in argv if a != '--dry-run']
    files = []
    if argv and argv[0] == '--from-report':
        report = json.loads(Path(argv[1]).read_text(encoding='utf-8'))
        files = [ROOT / f['file'] for f in report['failed'] if 'cannot be implemented' in f['error']]
    else:
        files = [Path(a) for a in argv]
    base = {}
    collect_types((ROOT / 'migrations' / 'V1__initial_schema.sql').read_text(encoding='utf-8'), base)
    # 其它迁移中新建的表也可能被引用
    for d in ('pending', 'migrations'):
        for f in sorted((ROOT / d).glob('*.sql')):
            collect_types(f.read_text(encoding='utf-8', errors='ignore'), base)
    # V1 的定义优先（后续迁移可能用 IF NOT EXISTS 重复定义同名表）
    collect_v1 = {}
    collect_types((ROOT / 'migrations' / 'V1__initial_schema.sql').read_text(encoding='utf-8'), collect_v1)
    for t, cols in collect_v1.items():
        base.setdefault(t, {}).update(cols)
    total = 0
    for f in files:
        ch = fix_file(f, base, dry)
        total += len(ch)
        print(f"{f.relative_to(ROOT)}: {len(ch)} change(s)")
        for c in ch:
            print('   ', c)
    print(f"total changes: {total}{' (dry run)' if dry else ''}")


if __name__ == '__main__':
    main(sys.argv[1:])
