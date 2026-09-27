#!/usr/bin/env python3
"""渲染实施计划中的 Epic 进度表，并同步工作区副本。

  python3 tools/render_plan.py
    - 读 tools/epics.json（归类）+ tools/epic_status.json（进度）+ repo 需求文档当前状态
    - 改写 repo/docs/IMPLEMENTATION-PLAN-20260924.md 中 <!-- EPICS:BEGIN/END --> 区块
    - 复制到工作区 IMPLEMENTATION-PLAN-20260924.md（改写相对链接）
"""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
REPO = os.path.join(WS, 'repo')
PLAN = os.path.join(REPO, 'docs', 'IMPLEMENTATION-PLAN-20260924.md')
GH = 'https://github.com/kkcc2013-arch/mineGo/blob/dev/review-20260924/docs/requirements/'
ICON = {'todo': '⬜', 'doing': '🔄', 'done': '✅', 'implemented': '🟢', 'partial': '🟡', 'deferred': '⏸️'}


def req_status(fname):
    p = os.path.join(REPO, 'docs', 'requirements', fname)
    if not os.path.exists(p):
        return '?'
    head = open(p, encoding='utf-8', errors='replace').read(4000)
    m = re.search(r'状态\**\s*(?:\||[:：])\s*\**\s*([A-Za-z]+)', head)
    return m.group(1).lower() if m else '?'


def main():
    epics = json.load(open(os.path.join(HERE, 'epics.json')))
    st_path = os.path.join(HERE, 'epic_status.json')
    status = json.load(open(st_path)) if os.path.exists(st_path) else {}
    total = done = impl = 0
    rows = []
    for e in sorted(epics, key=lambda e: (e['wave'], e['id'])):
        s = status.get(e['id'], {})
        reqs = []
        n_done = n_impl = 0
        for r in e['reqs']:
            rs = req_status(r['file'])
            total += 1
            if rs == 'done':
                done += 1; n_done += 1
            elif rs == 'implemented':
                impl += 1; n_impl += 1
            mark = {'done': '✅', 'implemented': '🟢', 'partial': '🟡'}.get(rs, '')
            reqs.append(f"[{r['id'][4:]}]({GH}{r['file']}){mark}")
        state = s.get('state', 'todo')
        if e['reqs'] and n_done == len(e['reqs']):
            state = 'done'
        elif e['reqs'] and n_done + n_impl == len(e['reqs']):
            state = 'implemented'
        rows.append(f"| {e['id']} | W{e['wave']} | {e['name']} | {n_done + n_impl}/{len(e['reqs'])} | {ICON.get(state, state)} {s.get('note', '')} | {' '.join(reqs)} |")
    block = [
        '<!-- EPICS:BEGIN（由 tools/render_plan.py 生成，请勿手改） -->',
        f'**需求进度：已验证完成 {done}，代码完成待验证 {impl}，合计 {done + impl} / {total}**（按需求文件计；同一编号多个文件分别计数；2026-09-25 起服务级验证由用户另行安排）',
        '',
        '| Epic | 波次 | 能力 | 完成 | 状态 / 说明 | 需求（✅=已验证 🟢=代码完成待验证 🟡=部分） |',
        '|---|---|---|---|---|---|',
        *rows,
        '<!-- EPICS:END -->',
    ]
    text = open(PLAN, encoding='utf-8').read()
    new = re.sub(r'<!-- EPICS:BEGIN.*?<!-- EPICS:END -->', '\n'.join(block), text, flags=re.S)
    if new == text and '<!-- EPICS:BEGIN' not in text:
        raise SystemExit('plan has no EPICS markers')
    open(PLAN, 'w', encoding='utf-8').write(new)
    ws = new.replace('](review/PROJECT-REVIEW-20260924.md)', '](reports/2026-09-24-1710-initial-review.md)') \
            .replace('](requirements/OPEN-REQUIREMENTS.md)', '](OPEN-REQUIREMENTS.md)')
    open(os.path.join(WS, 'IMPLEMENTATION-PLAN-20260924.md'), 'w', encoding='utf-8').write(ws)
    print(f'rendered: done={done} implemented={impl} total={total}')


if __name__ == '__main__':
    main()
