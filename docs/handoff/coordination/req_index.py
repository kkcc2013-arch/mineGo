#!/usr/bin/env python3
"""Index docs/requirements/REQ-*.md -> JSON (id, file, title, category, priority, status, services)."""
import json, os, re, sys
root = sys.argv[1] if len(sys.argv) > 1 else '.'
d = os.path.join(root, 'docs', 'requirements')
out = []
def field(text, names):
    for n in names:
        m = re.search(r'^\|\s*\**' + n + r'\**\s*\|\s*(.+?)\s*\|\s*$', text, re.M)
        if m: return m.group(1).strip().strip('*`')
        m = re.search(r'^\s*[-|]*\s*\**' + n + r'\**\s*[:：]\s*\**(.+?)\**\s*$', text, re.M)
        if m: return m.group(1).strip().strip('*`')
    return ''
for f in sorted(os.listdir(d)):
    m = re.match(r'(REQ-\d{5})', f)
    if not m or not f.endswith('.md'): continue
    text = open(os.path.join(d, f), encoding='utf-8', errors='replace').read()
    head = text[:4000]
    title = re.search(r'^#\s*REQ-\d+\s*[:：]?\s*(.+)$', head, re.M)
    status = field(head, ['状态', 'Status', 'status']).lower()
    status = re.split(r'[\s（(]', status)[0] if status else ''
    out.append(dict(id=m.group(1), file=f, title=(title.group(1).strip() if title else field(head, ['标题'])),
                    category=field(head, ['类别', 'Category']), priority=field(head, ['优先级', 'Priority']).upper()[:2],
                    status=status, services=field(head, ['涉及服务', '影响服务', 'Services'])))
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
