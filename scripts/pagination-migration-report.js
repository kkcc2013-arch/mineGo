#!/usr/bin/env node
/**
 * REQ-00302 / REQ-00465：分页迁移报告
 *
 * 静态扫描 9 个服务的 GET 路由处理函数（复用 api-lint 的路由收集与挂载前缀解析），按分页实现分类：
 *   migrated        已用统一分页（offsetPaginationMiddleware / cursorPaginationMiddleware / res.paginated / addPaginationMeta / ApiResponse.paginated）
 *   legacy-params   自己解析 limit/offset/page 查询参数（参数名、默认值、上限各不相同）→ 需要迁移
 *   fixed-limit     SQL 写死 LIMIT N、不支持翻页 → 列表变大后需要迁移
 *   not-list        未发现列表查询
 *
 * 用法：
 *   node scripts/pagination-migration-report.js              Markdown 报告输出到标准输出
 *   node scripts/pagination-migration-report.js --json       JSON
 *   node scripts/pagination-migration-report.js --out docs/api-spec/generated/pagination-migration.md
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lint = require('./api-lint');

const ROOT = path.resolve(__dirname, '..');

const MIGRATED_RE = /offsetPaginationMiddleware|cursorPaginationMiddleware|res\.paginated\(|addPaginationMeta\(|ApiResponse\.(paginated|paginatedWithLinks|halPaginated)\(/;
const LEGACY_PARAM_RE = /req\.query\.(limit|offset|page|pageSize|page_size|per_page|size|cursor)\b|\{[^}]*\b(limit|offset|page|pageSize)\b[^}]*\}\s*=\s*req\.query/;
const SQL_LIMIT_PARAM_RE = /LIMIT\s+\$\d+|LIMIT\s+\$\{/i;
const SQL_LIMIT_FIXED_RE = /LIMIT\s+(\d+)/i;

/** 截取某个路由定义的处理函数源码：从定义行到同文件下一个路由定义（或文件结尾） */
function handlerSource(src, line, nextLine) {
  const lines = src.split('\n');
  return lines.slice(line - 1, nextLine ? nextLine - 1 : Math.min(lines.length, line + 200)).join('\n');
}

/** 对单个处理函数源码分类 */
function classify(code) {
  if (MIGRATED_RE.test(code)) return { status: 'migrated' };
  const legacy = LEGACY_PARAM_RE.test(code);
  if (legacy || SQL_LIMIT_PARAM_RE.test(code) && /req\.query/.test(code)) {
    const params = [...new Set([...code.matchAll(/req\.query\.(\w+)/g)].map((m) => m[1]).filter((p) => /^(limit|offset|page|pageSize|page_size|per_page|size|cursor)$/.test(p)))];
    const destructured = code.match(/\{([^{}]*)\}\s*=\s*req\.query/);
    if (destructured) for (const p of destructured[1].split(',').map((x) => x.split('=')[0].trim())) if (/^(limit|offset|page|pageSize|page_size|per_page|size|cursor)$/.test(p) && !params.includes(p)) params.push(p);
    return { status: 'legacy-params', params, suggestion: '改用 offsetPaginationMiddleware（page/pageSize，兼容 limit/offset）+ res.paginated(items, { total })' };
  }
  const fixed = code.match(SQL_LIMIT_FIXED_RE);
  if (fixed && /SELECT/i.test(code)) {
    return { status: 'fixed-limit', limit: Number(fixed[1]), suggestion: `当前固定返回前 ${fixed[1]} 条：数据量大时改为分页（默认 pageSize=${fixed[1]} 保持旧行为）` };
  }
  return { status: 'not-list' };
}

function buildReport() {
  const out = [];
  for (const [service, rel] of Object.entries(lint.SERVICES)) {
    const routes = lint.collectService(service, rel).filter((r) => r.method === 'GET');
    const byFile = new Map();
    for (const r of routes) {
      const list = byFile.get(r.file) || [];
      list.push(r);
      byFile.set(r.file, list);
    }
    for (const [file, list] of byFile) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // 该文件所有路由定义行（含非 GET），用于确定处理函数边界
      const allLines = [...src.matchAll(/\b(?:app|router|[A-Za-z_$][\w$]*Router)\s*\.\s*(?:get|post|put|patch|delete)\s*\(/g)]
        .map((m) => src.slice(0, m.index).split('\n').length).sort((a, b) => a - b);
      const seen = new Set();
      for (const r of list) {
        const key = `${r.line}|${r.fullPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const next = allLines.find((l) => l > r.line);
        const c = classify(handlerSource(src, r.line, next));
        out.push({ service, method: r.method, path: r.fullPath, file, line: r.line, ...c });
      }
    }
  }
  const counts = {};
  for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1;
  const lists = out.filter((r) => r.status !== 'not-list');
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    summary: { getRoutes: out.length, listRoutes: lists.length, ...counts, migrationRate: lists.length ? +((counts.migrated || 0) / lists.length).toFixed(4) : null },
    routes: out,
  };
}

function toMarkdown(rep) {
  const s = rep.summary;
  const lines = [
    '# 分页迁移报告（自动生成）', '',
    '> node scripts/pagination-migration-report.js 生成；分类依据见脚本头注释。', '',
    `- GET 路由 ${s.getRoutes} 个，其中列表类 ${s.listRoutes} 个`,
    `- 已迁移 ${s.migrated || 0}，自定义分页参数 ${s['legacy-params'] || 0}，固定 LIMIT ${s['fixed-limit'] || 0}；迁移率 ${s.migrationRate === null ? '–' : `${(s.migrationRate * 100).toFixed(1)}%`}`,
    '',
  ];
  for (const [status, title] of [['migrated', '已迁移'], ['legacy-params', '待迁移：自定义分页参数'], ['fixed-limit', '待评估：固定 LIMIT']]) {
    const rows = rep.routes.filter((r) => r.status === status);
    if (!rows.length) continue;
    lines.push(`## ${title}（${rows.length}）`, '', '| 服务 | 接口 | 位置 | 说明 |', '|---|---|---|---|');
    for (const r of rows.sort((a, b) => a.service.localeCompare(b.service) || a.path.localeCompare(b.path))) {
      const note = status === 'legacy-params' ? `参数：${(r.params || []).join(', ') || '—'}` : status === 'fixed-limit' ? `LIMIT ${r.limit}` : '';
      lines.push(`| ${r.service} | \`GET ${r.path}\` | ${r.file}:${r.line} | ${note} |`);
    }
    lines.push('');
  }
  lines.push('## 迁移方法', '',
    '1. 路由加 `offsetPaginationMiddleware({ defaultPageSize, maxPageSize })`（或按排序键稳定的列表用 `cursorPaginationMiddleware`）；',
    '2. SQL 用 `req.pagination.limit / req.pagination.offset`，另查 total（大表用 `countWithStrategy` 估算）；偏移量 > 1000 用 `deferredJoinSql`；',
    '3. 响应改为 `res.paginated(items, { total })`（或保留旧 data 结构并附加 `pagination` / `meta.pagination` / `_links`）；',
    '4. 旧参数 limit/offset 继续有效（中间件自动换算），默认页大小保持旧行为，客户端无需同步修改。', '');
  return `${lines.join('\n')}\n`;
}

function main() {
  const rep = buildReport();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); return 0; }
  const md = toMarkdown(rep);
  const i = process.argv.indexOf('--out');
  if (i > 0 && process.argv[i + 1]) {
    fs.writeFileSync(path.resolve(ROOT, process.argv[i + 1]), md);
    console.log(`已生成 ${process.argv[i + 1]}（列表接口 ${rep.summary.listRoutes}，已迁移 ${rep.summary.migrated || 0}）`);
  } else process.stdout.write(md);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { classify, buildReport, toMarkdown };
