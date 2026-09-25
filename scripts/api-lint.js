#!/usr/bin/env node
/**
 * REQ-00329：API 端点命名规范 Linter 与文档同步
 *
 * 扫描 9 个服务（gateway + user/location/pokemon/catch/gym/social/reward/payment）的路由定义：
 *   app.<method>('path') / router.<method>('path') / app.use('prefix', require('./routes/x'))
 * 并解析挂载前缀得到完整路径，按规则检查：
 *
 *   级别 error（必须修复）
 *     route/invalid-path          路径含空白、'//'、非法字符或多余的结尾斜杠
 *     route/duplicate             同一应用内 method+完整路径重复注册（后注册的永远不会执行）
 *     method/unsafe-get           GET 路径含改变状态的动词（delete/remove/create/update/reset/purchase…）→ 易被 CSRF/预取误触发
 *   级别 warning（存量兼容，新代码应遵守）
 *     naming/kebab-case           路径段应为 kebab-case（小写 + 连字符），不得 camelCase / snake_case
 *     naming/no-verbs             路径不应以动词表达操作（get-/fetch-/list- 等）；资源上的 POST 动作子路径（/evolve、/claim）除外
 *     naming/plural-collection    集合资源应使用复数名词（白名单外的单数首段）
 *     naming/nesting-depth        嵌套资源层级不超过 3 层
 *     gateway/version-prefix      网关对外业务路由应带版本前缀（/v1、/api/vN）
 *     docs/missing-jsdoc          路由上方缺少说明注释（文档同步依据）
 *
 * 用法：
 *   node scripts/api-lint.js                 文本报告（file:line 规则 说明 建议），有 error 时退出码 1
 *   node scripts/api-lint.js --json          JSON 报告
 *   node scripts/api-lint.js --docs          生成 docs/api-spec/generated/routes.json 与 ROUTES.md（从注释提取）
 *   node scripts/api-lint.js --check-docs    检查生成的路由文档与代码是否一致（文档同步验证），不一致退出码 1
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVICES = {
  gateway: 'backend/gateway/src',
  user: 'backend/services/user-service/src',
  location: 'backend/services/location-service/src',
  pokemon: 'backend/services/pokemon-service/src',
  catch: 'backend/services/catch-service/src',
  gym: 'backend/services/gym-service/src',
  social: 'backend/services/social-service/src',
  reward: 'backend/services/reward-service/src',
  payment: 'backend/services/payment-service/src',
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const ROUTE_RE = /\b(app|router|[A-Za-z_$][\w$]*Router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\3/g;
const USE_RE = /\bapp\s*\.\s*use\s*\(\s*(\[[^\]]*\]|(['"`])([^'"`]+)\2)\s*,([\s\S]*?)\);/g;
const REQUIRE_VAR_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\2\s*\)/g;
const UNSAFE_GET_VERBS = /(^|[-/])(delete|remove|create|update|reset|purchase|buy|claim|revoke|ban|unban|transfer|execute|approve|reject|cancel)([-/]|$)/i;
const VERB_PREFIX = /^(get|fetch|list|create|update|delete|remove|do|make)[-_A-Z]/;
const SINGULAR_OK = new Set(['pokemon', 'health', 'metrics', 'me', 'auth', 'map', 'location', 'catch', 'batch', 'inventory', 'pokedex', 'gdpr', 'config', 'security', 'admin', 'api', 'v1', 'v2', 'data', 'info', 'status', 'stats', 'search', 'discover', 'version', 'time', 'weather', 'breeding', 'equipment', 'backup', 'training', 'bag', 'showcase', 'leaderboard', 'marketplace', 'guild', 'pvp', 'payment', 'webhook', 'privacy', 'tutorial', 'mfa', 'state', 'share', 'cdc', 'cdn', 'canary', 'degradation', 'replication', 'autoscaling', 'dependencies', 'quota', 'tracing', 'openapi', 'swagger', 'localization', 'localizations', 'raid', 'season', 'daily', 'stamina', 'friendship', 'evolution', 'energy', 'release', 'compliance', 'consent']);
const APP_ALLOWED_UNVERSIONED = /^\/(health|metrics|api-docs|admin|config|api\/(admin|version|discover|errors|media-types|fieldsets|deprecations|device|events|costs|budgets|time|v\d+))(\/|$)/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['node_modules', '__tests__', 'tests'].includes(f.name)) walk(p, out); }
    else if (f.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function commentAbove(src, idx) {
  const before = src.slice(Math.max(0, idx - 800), idx).replace(/\s+$/, '');
  const lines = before.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^(\/\/|\*|\/\*\*|\*\/)/.test(l)) out.unshift(l.replace(/^\/\*\*?|\*\/$|^\*|^\/\//g, '').trim());
    else break;
  }
  return out.filter(Boolean).join(' ').slice(0, 300);
}

function joinPath(prefix, p) {
  if (!prefix || prefix === '/') return p;
  if (p === '/' || p === '') return prefix;
  return `${prefix.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
}

/** 收集一个服务的全部路由（含挂载前缀解析） */
function collectService(name, rel) {
  const dir = path.join(ROOT, rel);
  const files = walk(dir);
  const mounts = new Map(); // absFile -> [prefix]
  const routes = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const vars = new Map();
    let m;
    REQUIRE_VAR_RE.lastIndex = 0;
    while ((m = REQUIRE_VAR_RE.exec(src))) vars.set(m[1], path.resolve(path.dirname(file), m[3]));
    USE_RE.lastIndex = 0;
    while ((m = USE_RE.exec(src))) {
      const prefixes = m[3] ? [m[3]] : (m[1].match(/['"`]([^'"`]+)['"`]/g) || []).map((s) => s.slice(1, -1));
      const rest = m[4];
      const targets = []; // [文件, 路由对象名|'*']
      for (const r of rest.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) targets.push([path.resolve(path.dirname(file), r[1]), '*']);
      for (const tok of rest.split(',').map((s) => s.trim())) {
        if (vars.has(tok)) targets.push([vars.get(tok), '*']);
        const mm = tok.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/); // apiStdRoutes.publicRouter
        if (mm && vars.has(mm[1])) targets.push([vars.get(mm[1]), mm[2]]);
      }
      for (const [t, routerName] of targets) {
        const abs = fs.existsSync(`${t}.js`) ? `${t}.js` : (fs.existsSync(path.join(t, 'index.js')) ? path.join(t, 'index.js') : t);
        const key = `${abs}#${routerName}`;
        const list = mounts.get(key) || [];
        list.push(...prefixes.map((p) => ({ prefix: p, from: file })));
        mounts.set(key, list);
      }
    }
  }
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    ROUTE_RE.lastIndex = 0;
    const isAppFile = /\bexpress\(\)|ServiceFactory\.createService|postInit/.test(src);
    while ((m = ROUTE_RE.exec(src))) {
      const [, obj, method, , p] = m;
      if (method === 'all' || !p.startsWith('/')) continue;
      const line = lineOf(src, m.index);
      const doc = commentAbove(src, src.lastIndexOf('\n', m.index));
      const prefixes = obj === 'app' || isAppFile && obj === 'app' ? [{ prefix: '' }] : (mounts.get(`${file}#${obj}`) || mounts.get(`${file}#*`) || []);
      if (!prefixes.length) routes.push({ service: name, file: path.relative(ROOT, file), line, method: method.toUpperCase(), path: p, fullPath: p, mounted: false, doc });
      for (const { prefix } of prefixes) routes.push({ service: name, file: path.relative(ROOT, file), line, method: method.toUpperCase(), path: p, fullPath: joinPath(prefix, p), mounted: true, doc });
    }
  }
  return routes;
}

function segmentsOf(p) {
  return p.split('?')[0].split('/').filter(Boolean);
}

function checkRoute(r, seen) {
  const issues = [];
  const add = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion, service: r.service, file: r.file, line: r.line, method: r.method, path: r.fullPath });
  const p = r.fullPath;
  if (/\s/.test(p) || p.includes('//') || (p.length > 1 && p.endsWith('/') && !p.endsWith('(*)/')) || /[^A-Za-z0-9/_:.*()?+\-\\[\]|$^]/.test(p)) {
    add('error', 'route/invalid-path', `非法路径 "${p}"`, '去掉多余斜杠/空白，使用 kebab-case 字面量与 :param');
  }
  const key = `${r.service}|${r.method}|${p}`;
  // 只对能解析出完整挂载路径的路由做重复检测（未挂载的 router 文件路径是相对的，不可比）
  if (r.mounted && seen.has(key) && seen.get(key) !== `${r.file}:${r.line}`) {
    add('error', 'route/duplicate', `${r.method} ${p} 已在 ${seen.get(key)} 注册，本处永远不会被执行`, '删除重复定义或合并处理逻辑');
  } else if (r.mounted && !seen.has(key)) seen.set(key, `${r.file}:${r.line}`);
  const segs = segmentsOf(p);
  const staticSegs = segs.filter((s) => !s.startsWith(':') && !s.includes('*') && !s.includes('('));
  // 动词作为整段（/delete）或祈使式开头（/delete-account）才算；名词短语（/transfer-logs、/geo-ban）不算
  const isImperative = (s) => {
    const m = s.match(/^([a-z]+)(-|$)/i);
    if (!m || !UNSAFE_GET_VERBS.test(`/${m[1]}`)) return false;
    return s === m[1] || !/(s|history|status|info|list|stats|config)$/i.test(s);
  };
  if (r.method === 'GET' && staticSegs.some(isImperative)) {
    add('error', 'method/unsafe-get', `GET ${p} 含改变状态的动词`, '改用 POST/PATCH/DELETE；保留旧 GET 时登记弃用并加 CSRF 防护');
  }
  for (const s of staticSegs) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)?$/.test(s) && !/^v\d+$/.test(s)) {
      const kebab = s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
      add('warning', 'naming/kebab-case', `路径段 "${s}" 不是 kebab-case`, `改为 "${kebab}"（旧路径保留为别名并登记弃用）`);
    }
    if (VERB_PREFIX.test(s)) add('warning', 'naming/no-verbs', `路径段 "${s}" 以动词开头`, '用 HTTP 方法表达动作，路径使用名词');
  }
  const first = staticSegs.find((s) => !/^(api|v\d+|admin|internal)$/.test(s));
  if (first && !first.endsWith('s') && !SINGULAR_OK.has(first) && !/-/.test(first) && r.method === 'GET') {
    add('warning', 'naming/plural-collection', `集合资源 "${first}" 建议使用复数`, `如 "${first}s"`);
  }
  const resources = segs.filter((s) => !s.startsWith(':') && !/^(api|v\d+)$/.test(s)).length;
  if (resources > 4) add('warning', 'naming/nesting-depth', `嵌套层级 ${resources} 超过建议的 3 层`, '拆分为顶层资源 + 查询参数');
  if (r.service === 'gateway' && r.mounted && p.startsWith('/') && !APP_ALLOWED_UNVERSIONED.test(p) && !/^\/v\d+\//.test(p) && !/^\/api\/v\d+\//.test(p)) {
    add('warning', 'gateway/version-prefix', `网关路由 ${p} 缺少版本前缀`, '迁移到 /api/v1/... 并为旧路径登记弃用');
  }
  if (!r.doc) add('warning', 'docs/missing-jsdoc', `${r.method} ${p} 缺少说明注释`, '在路由上方添加 // 或 /** */ 注释（文档生成依据）');
  return issues;
}

function lintRepo({ root = ROOT } = {}) {
  void root;
  const routes = [];
  for (const [name, rel] of Object.entries(SERVICES)) routes.push(...collectService(name, rel));
  const seen = new Map();
  const issues = [];
  for (const r of routes) issues.push(...checkRoute(r, seen));
  const byRule = {};
  for (const i of issues) byRule[i.rule] = (byRule[i.rule] || 0) + 1;
  const withIssues = new Set(issues.filter((i) => i.rule !== 'docs/missing-jsdoc').map((i) => `${i.service}|${i.method}|${i.path}`));
  const byService = {};
  for (const r of routes) byService[r.service] = (byService[r.service] || 0) + 1;
  const summary = {
    services: Object.keys(SERVICES).length,
    routes: routes.length,
    byService,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    compliantRoutes: routes.length - withIssues.size,
    complianceRate: routes.length ? +((routes.length - withIssues.size) / routes.length).toFixed(4) : 1,
  };
  return { summary, byRule, issues, routes };
}

function renderDocs(routes) {
  const inventory = routes
    .filter((r) => r.mounted)
    .map((r) => ({ service: r.service, method: r.method, path: r.fullPath, description: r.doc || null, source: `${r.file}` }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const uniq = [];
  const k = new Set();
  for (const r of inventory) { const key = `${r.service}|${r.method}|${r.path}`; if (!k.has(key)) { k.add(key); uniq.push(r); } }
  const md = ['# 路由清单（自动生成）', '', '> node scripts/api-lint.js --docs 生成；CI 用 --check-docs 校验与代码一致。', ''];
  let cur = null;
  for (const r of uniq) {
    if (r.service !== cur) { cur = r.service; md.push('', `## ${cur}`, '', '| 方法 | 路径 | 说明 |', '|---|---|---|'); }
    md.push(`| ${r.method} | \`${r.path}\` | ${(r.description || '').replace(/\|/g, '\\|')} |`);
  }
  // OpenAPI 3.1 骨架：路径、方法、服务标签、路径参数；summary / description 取自路由上方注释（JSDoc / 行注释）
  const paths = {};
  for (const r of uniq) {
    if (/[*()]/.test(r.path)) continue;
    const p = r.path.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}');
    const params = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const summary = (r.description || '').split(/[。；;]|\s{2,}/)[0].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+\S+\s*[—-]?\s*/i, '').slice(0, 120) || `${r.method} ${r.path}`;
    paths[p] = paths[p] || {};
    paths[p][r.method.toLowerCase()] = {
      summary,
      ...(r.description ? { description: r.description } : {}),
      tags: [r.service],
      operationId: `${r.service}_${r.method.toLowerCase()}_${r.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      ...(params.length ? { parameters: params } : {}),
      responses: { default: { description: '统一响应格式，见 docs/api-guidelines.md' } },
      'x-source': r.source,
    };
  }
  const openapi = { openapi: '3.1.0', info: { title: 'mineGo 路由清单（从代码与注释生成）', version: '1.0.0', description: 'node scripts/api-lint.js --docs 生成；接口契约（请求/响应 Schema）见 docs/api-spec/openapi.yaml' }, paths };
  return { json: `${JSON.stringify({ total: uniq.length, routes: uniq }, null, 2)}\n`, md: `${md.join('\n')}\n`, openapi: `${JSON.stringify(openapi, null, 2)}\n` };
}

/** 对比两份路由清单（JSON 文本），返回代码新增 / 文档多余的路由 */
function compareDocs(docJson, codeJson) {
  const a = docJson ? JSON.parse(docJson).routes : [];
  const b = JSON.parse(codeJson).routes;
  const ka = new Set(a.map((x) => `${x.service}|${x.method}|${x.path}`));
  const kb = new Set(b.map((x) => `${x.service}|${x.method}|${x.path}`));
  return { added: [...kb].filter((x) => !ka.has(x)), removed: [...ka].filter((x) => !kb.has(x)), inSync: docJson === codeJson };
}

function main() {
  const args = process.argv.slice(2);
  const r = lintRepo();
  const outDir = path.join(ROOT, 'docs', 'api-spec', 'generated');
  if (args.includes('--docs') || args.includes('--check-docs')) {
    const { json, md, openapi } = renderDocs(r.routes);
    const jf = path.join(outDir, 'routes.json');
    const mf = path.join(outDir, 'ROUTES.md');
    if (args.includes('--docs')) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(jf, json);
      fs.writeFileSync(mf, md);
      fs.writeFileSync(path.join(outDir, 'routes.openapi.json'), openapi);
      console.log(`已生成 ${path.relative(ROOT, jf)}（${JSON.parse(json).total} 条路由）`);
      return 0;
    }
    const cur = fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : '';
    if (cur !== json) {
      const { added, removed } = compareDocs(cur, json);
      console.error(`路由文档与代码不同步：新增 ${added.length}、删除 ${removed.length}（运行 node scripts/api-lint.js --docs）`);
      for (const x of added.slice(0, 20)) console.error(`  + ${x}`);
      for (const x of removed.slice(0, 20)) console.error(`  - ${x}`);
      return 1;
    }
    console.log('路由文档与代码同步');
    return 0;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary: r.summary, byRule: r.byRule, issues: r.issues }, null, 2));
  } else {
    const show = args.includes('--all') ? r.issues : r.issues.filter((i) => i.severity === 'error');
    for (const i of show) console.log(`${i.file}:${i.line}  ${i.severity.padEnd(7)} ${i.rule.padEnd(26)} ${i.method} ${i.path}  — ${i.message}；建议：${i.suggestion}`);
    console.log(`\n${r.summary.routes} 条路由（${r.summary.services} 个服务），error ${r.summary.errors}，warning ${r.summary.warnings}，合规率 ${(r.summary.complianceRate * 100).toFixed(1)}%`);
    console.log(Object.entries(r.byRule).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
  }
  return r.summary.errors ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { lintRepo, checkRoute, collectService, renderDocs, compareDocs, SERVICES };
