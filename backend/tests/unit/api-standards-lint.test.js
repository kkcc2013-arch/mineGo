// REQ-00329：API 端点命名规范 Linter —— 规则单测 + 仓库现有路由无 error + 路由文档与代码同步
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const lint = require(path.join(ROOT, 'scripts', 'api-lint.js'));

const route = (method, fullPath, extra = {}) => ({ service: 'gateway', file: 'x.js', line: 1, method, path: fullPath, fullPath, mounted: true, doc: 'doc', ...extra });

test('规则：非法路径 / 重复注册 / 不安全 GET / kebab-case / 动词 / 复数 / 嵌套 / 版本前缀 / 缺注释', () => {
  const seen = new Map();
  const rules = (r) => lint.checkRoute(r, seen).map((i) => i.rule);
  assert.ok(rules(route('GET', '/v1/users//me')).includes('route/invalid-path'));
  assert.ok(rules(route('GET', '/v1/users/')).includes('route/invalid-path'));
  rules(route('GET', '/v1/dupe', { line: 1 }));
  assert.ok(rules(route('GET', '/v1/dupe', { line: 2 })).includes('route/duplicate'));
  assert.ok(rules(route('GET', '/v1/items/:id/delete')).includes('method/unsafe-get'));
  assert.ok(rules(route('GET', '/v1/delete-account')).includes('method/unsafe-get'));
  assert.ok(!rules(route('GET', '/v1/transfer-logs')).includes('method/unsafe-get'));
  assert.ok(!rules(route('POST', '/v1/items/:id/delete')).includes('method/unsafe-get'));
  const k = lint.checkRoute(route('GET', '/v1/userProfiles'), new Map());
  assert.ok(k.find((i) => i.rule === 'naming/kebab-case' && /user-profiles/.test(i.suggestion)));
  assert.ok(rules(route('POST', '/v1/getThings')).includes('naming/no-verbs'));
  assert.ok(rules(route('GET', '/v1/gym')).includes('naming/plural-collection'));
  assert.ok(!rules(route('GET', '/v1/gyms')).includes('naming/plural-collection'));
  assert.ok(rules(route('GET', '/v1/a/:a/b/:b/c/:c/d/:d/e')).includes('naming/nesting-depth'));
  assert.ok(rules(route('GET', '/shop/items')).includes('gateway/version-prefix'));
  assert.ok(rules(route('GET', '/v1/things', { doc: '' })).includes('docs/missing-jsdoc'));
  const issue = lint.checkRoute(route('GET', '/v1/items/:id/delete'), new Map())[0];
  for (const k2 of ['file', 'line', 'rule', 'message', 'suggestion', 'severity']) assert.ok(issue[k2] !== undefined, k2);
});

test('仓库现有路由：扫描 9 个服务，无 error（warning 可接受）', () => {
  const r = lint.lintRepo();
  assert.equal(r.summary.services, 9);
  assert.equal(Object.keys(r.summary.byService).length, 9);
  assert.ok(r.summary.routes > 500);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.issues.filter((i) => i.severity === 'error').slice(0, 5)));
});

test('文档同步验证：从注释生成路由清单，能检测文档与代码的新增/删除差异', () => {
  const { json, md, openapi } = lint.renderDocs(lint.lintRepo().routes);
  const oa = JSON.parse(openapi);
  assert.equal(oa.openapi, '3.1.0');
  const disc = oa.paths['/api/discover'].get;
  assert.ok(disc.tags.includes('gateway') && disc.summary && disc['x-source']);
  assert.ok(Object.values(oa.paths).some((ops) => Object.values(ops).some((op) => op.description)), '说明取自注释');
  assert.ok(oa.paths['/v1/pokemon/my/{id}'] || Object.keys(oa.paths).some((p) => p.includes('{')), '路径参数转为 {param}');
  const doc = JSON.parse(json);
  assert.ok(doc.total > 500);
  assert.ok(doc.routes.every((r) => r.service && r.method && r.path.startsWith('/')));
  assert.ok(doc.routes.some((r) => r.description), '从注释提取说明');
  assert.match(md, /\| GET \| `\/api\/discover` \|/);
  const stale = JSON.stringify({ total: doc.total - 1, routes: [...doc.routes.slice(1), { service: 'gateway', method: 'GET', path: '/v1/removed-endpoint' }] }, null, 2);
  const d = lint.compareDocs(stale, json);
  assert.equal(d.inSync, false);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.removed, ['gateway|GET|/v1/removed-endpoint']);
  // CLI 可运行（仓库内文档是否最新由 CI 的 --check-docs 步骤把关，不在单测里强制，避免并行分支互相阻塞）
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'api-lint.js'), '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).summary.errors, 0);
});

test('分页迁移报告：处理函数分类（已迁移 / 自定义参数 / 固定 LIMIT / 非列表），报告列出已迁移的 4 个接口（REQ-00302）', () => {
  const rep = require(path.join(ROOT, 'scripts', 'pagination-migration-report.js'));
  assert.equal(rep.classify("app.get('/x', offsetPaginationMiddleware(), async (req, res) => res.paginated(rows, { total }))").status, 'migrated');
  const legacy = rep.classify("router.get('/x', async (req, res) => { const { page = 1, limit = 20 } = req.query; await query('SELECT * FROM t LIMIT $1 OFFSET $2', [limit, (page - 1) * limit]); })");
  assert.equal(legacy.status, 'legacy-params');
  assert.deepEqual(legacy.params.sort(), ['limit', 'page']);
  assert.equal(rep.classify("router.get('/top', async () => query('SELECT id FROM users ORDER BY xp DESC LIMIT 100'))").limit, 100);
  assert.equal(rep.classify("router.get('/me', async (req, res) => res.json({ ok: true }))").status, 'not-list');
  const r = rep.buildReport();
  const migrated = r.routes.filter((x) => x.status === 'migrated').map((x) => `${x.service} ${x.path}`);
  for (const p of ['pokemon /pokemon/my', 'pokemon /pokemon/species', 'social /friends', 'reward /rewards/leaderboard']) assert.ok(migrated.includes(p), p);
  assert.match(rep.toMarkdown(r), /## 迁移方法/);
});
