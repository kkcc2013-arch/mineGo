/**
 * Epic E25 API 设计规范：网关路由
 *
 *   publicRouter  挂载 /api        —— /discover /errors /media-types /fieldsets /deprecations（公开，只读）
 *   batchRouter   挂载 /api/v1/batch（需登录）—— 批量请求 + 预定义模板（REQ-00308）
 *   pipelineRouter   挂载 /api/v1/pipelines（管理员）；transformerRouter 挂载 /api/v1/transformers（管理员）（REQ-00542）
 *   deprecationAdminRouter 挂载 /api/admin/deprecations 与 /admin/api/deprecations（管理员，REQ-00407）
 *   versionAdminRouter     挂载 /api/admin/api-versions（管理员，REQ-00201/520）
 *   adminRouter            挂载 /api/admin/api-standards（管理员：契约/字段集/配置/性能预算/lint/兼容性/重试）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { buildErrorBody, listCatalog, lookup } = require('@pmg/shared/apiStandards/errorCatalog');
const { generateMigrationGuide, LIFECYCLE } = require('@pmg/shared/apiStandards/versioning');
const { mockFromSchema, Validator } = require('@pmg/shared/apiStandards/jsonSchema');
const compat = require('@pmg/shared/apiStandards/compatibility');
const { BatchError, expandTemplate } = require('@pmg/shared/apiStandards/batch');
const setup = require('../apiStandards/setup');

const { apiStd, query, logger } = setup;
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

function sendError(res, name, opts = {}) {
  const { status, body } = buildErrorBody(name, opts);
  return res.status(opts.status || status).json(body);
}

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, code: 0, message: 'ok', data });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err.status && err.status < 500) return sendError(res, err.status === 404 ? 'NOT_FOUND' : err.status === 409 ? 'CONFLICT' : 'INVALID_REQUEST', { status: err.status, message: err.message, details: err.allowed ? { allowed: err.allowed } : err.details });
  logger.error({ err: err.message, path: req.path }, 'api-standards route failed');
  return sendError(res, 'INTERNAL_ERROR', { message: '内部错误' });
});

function userIdOf(req) { return req.user && (req.user.sub || req.user.id) ? (req.user.sub || req.user.id) : null; }

// ══════════════════════════════════════════════════════════════
// 公开只读
// ══════════════════════════════════════════════════════════════
const publicRouter = express.Router();

publicRouter.get('/discover', (req, res) => res.json(apiStd.discoverer.discover()));

publicRouter.get('/errors', (req, res) => ok(res, { total: listCatalog().length, errors: listCatalog() }));
publicRouter.get('/errors/:name', (req, res) => {
  const e = lookup(String(req.params.name).toUpperCase());
  if (!e) return sendError(res, 'NOT_FOUND', { message: `错误码 ${req.params.name} 不存在` });
  return ok(res, e);
});

publicRouter.get('/media-types', (req, res) => ok(res, { default: 'application/json', mediaTypes: apiStd.mediaRegistry.list() }));

publicRouter.get('/fieldsets', (req, res) => ok(res, apiStd.fieldsets.list(req.query.resource ? String(req.query.resource) : undefined)));

publicRouter.get('/deprecations', (req, res) => ok(res, { total: apiStd.deprecations.list().length, deprecations: apiStd.deprecations.list() }));

publicRouter.get('/deprecations/:id/migration-guide', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return sendError(res, 'INVALID_REQUEST', { message: 'id 无效' });
  const { rows: [d] } = await query('SELECT * FROM api_deprecations WHERE id = $1', [id]);
  if (!d) return sendError(res, 'NOT_FOUND', { message: '弃用记录不存在' });
  const { rows: [st] } = await query('SELECT COUNT(*)::int AS clients, COALESCE(SUM(deprecated_call_count),0)::int AS calls FROM client_migration_status WHERE deprecation_id = $1 AND migrated_at IS NULL', [id]);
  const md = generateMigrationGuide(d, { stats: st });
  if (req.query.format === 'json') return ok(res, { id, markdown: md });
  res.type('text/markdown; charset=utf-8').send(md);
}));

// ══════════════════════════════════════════════════════════════
// REQ-00308 批量请求
// ══════════════════════════════════════════════════════════════
const batchRouter = express.Router();
batchRouter.use(express.json({ limit: '256kb' }));

async function batchRateLimit(req) {
  const uid = userIdOf(req) || req.ip;
  const r = setup.redis();
  if (!r) return { allowed: true };
  const key = `batch:rl:${uid}:${Math.floor(Date.now() / 60000)}`;
  const n = await r.incr(key).catch(() => 1);
  if (n === 1) r.expire(key, 70).catch(() => {});
  const limit = Number(process.env.BATCH_RATE_LIMIT_PER_MIN || 60);
  return { allowed: n <= limit, count: n, limit, retryAfter: 60 - Math.floor((Date.now() % 60000) / 1000) };
}

async function userCacheScope(req) {
  const uid = userIdOf(req);
  if (!uid) return null;
  const r = setup.redis();
  const ver = r ? await r.get(`cache:ver:${uid}`).catch(() => '0') : '0';
  return `u:${uid}:v${ver || '0'}`;
}

async function runBatch(req, res, payload, template) {
  if (req.headers['x-batch-subrequest']) return sendError(res, 'INVALID_REQUEST', { message: '不允许嵌套批量请求' });
  const rl = await batchRateLimit(req);
  res.setHeader('X-Batch-RateLimit-Limit', String(rl.limit || ''));
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return sendError(res, 'BATCH_RATE_LIMITED', { message: `批量请求超过每分钟 ${rl.limit} 次`, retryAfter: rl.retryAfter });
  }
  const streamMode = req.query.stream === '1' || /application\/x-ndjson/.test(String(req.headers.accept || ''));
  const ctx = {
    userId: userIdOf(req),
    cacheScope: await userCacheScope(req),
    template,
    requestId: req.headers['x-request-id'],
    headers: req.headers,
    clientIp: req.ip,
  };
  try {
    setup.batchExecutor.validate(payload);
  } catch (err) {
    if (err instanceof BatchError) return sendError(res, err.name === 'BATCH_LIMIT_EXCEEDED' ? 'BATCH_LIMIT_EXCEEDED' : 'INVALID_REQUEST', { message: err.message, details: err.details });
    throw err;
  }
  if (streamMode) {
    // 流式：每个子请求完成即输出一行（高优先级先执行先返回），最后一行为 summary（REQ-00308 + REQ-00526）
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Stream', '1');
    ctx.onResult = (r) => res.write(`${JSON.stringify({ type: 'response', ...r })}\n`);
    const out = await setup.batchExecutor.execute(payload, ctx);
    res.end(`${JSON.stringify({ type: 'summary', summary: out.summary })}\n`);
    recordBatchStats(ctx, out.summary);
    return undefined;
  }
  const out = await setup.batchExecutor.execute(payload, ctx);
  recordBatchStats(ctx, out.summary);
  return ok(res, out);
}

function recordBatchStats(ctx, s) {
  query(`INSERT INTO batch_request_stats (user_id, request_count, success_count, cached_count, total_duration_ms, cost_saved_usd, endpoint_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.userId, s.total, s.success, s.cached, s.totalDuration, s.costSaved, ctx.template || 'adhoc']).catch(() => {});
}

batchRouter.post('/', wrap(async (req, res) => runBatch(req, res, req.body, null)));

batchRouter.get('/templates', wrap(async (req, res) => {
  const { rows } = await query('SELECT name, description, requests, options, usage_count FROM batch_request_templates ORDER BY name');
  return ok(res, { total: rows.length, templates: rows });
}));

batchRouter.post('/templates/:name', wrap(async (req, res) => {
  const { rows: [t] } = await query('SELECT * FROM batch_request_templates WHERE name = $1', [req.params.name]);
  if (!t) return sendError(res, 'NOT_FOUND', { message: `模板 ${req.params.name} 不存在` });
  const params = (req.body && req.body.params) || {};
  let requests;
  try {
    requests = t.requests.map((r) => ({ ...r, path: expandTemplate(r.path, params) }));
  } catch (err) {
    return sendError(res, 'INVALID_REQUEST', { message: err.message, details: err.details });
  }
  query('UPDATE batch_request_templates SET usage_count = usage_count + 1, updated_at = NOW() WHERE id = $1', [t.id]).catch(() => {});
  return runBatch(req, res, { requests, options: { ...(t.options || {}), ...((req.body && req.body.options) || {}) } }, t.name);
}));

batchRouter.get('/stats', wrap(async (req, res) => {
  const { rows: [s] } = await query(`SELECT COUNT(*)::int AS batches, COALESCE(SUM(request_count),0)::int AS subrequests, COALESCE(SUM(cached_count),0)::int AS cached,
      COALESCE(SUM(cost_saved_usd),0)::float AS cost_saved_usd, COALESCE(AVG(total_duration_ms),0)::float AS avg_duration_ms
      FROM batch_request_stats WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [userIdOf(req)]);
  return ok(res, s);
}));

// ══════════════════════════════════════════════════════════════
// REQ-00542 管道与转换器管理（管理员）
// ══════════════════════════════════════════════════════════════
const pipelineRouter = express.Router();
pipelineRouter.use(express.json({ limit: '64kb' }));
const PERIODS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

pipelineRouter.get('/', (req, res) => {
  const pipelines = apiStd.engine.list();
  return ok(res, { total: pipelines.length, pipelines, cacheEntries: apiStd.engine.cache.size });
});

pipelineRouter.get('/:name', (req, res) => {
  const p = apiStd.engine.get(req.params.name);
  if (!p) return sendError(res, 'NOT_FOUND', { message: `管道 ${req.params.name} 不存在` });
  return ok(res, { ...apiStd.engine.describe(p), metrics: apiStd.engine.getStats(p.name) });
});

pipelineRouter.get('/:name/metrics', (req, res) => {
  const p = apiStd.engine.get(req.params.name);
  if (!p) return sendError(res, 'NOT_FOUND', { message: `管道 ${req.params.name} 不存在` });
  const period = PERIODS[req.query.period] ? req.query.period : '1h';
  return ok(res, { period, ...apiStd.engine.getStats(p.name, { periodMs: PERIODS[period] }) });
});

async function savePipeline(req, res, name, config, isNew) {
  if (!config || typeof config !== 'object') return sendError(res, 'INVALID_REQUEST', { message: 'config 必须是对象' });
  const existing = apiStd.engine.get(name);
  if (isNew && existing) return sendError(res, 'CONFLICT', { status: 409, message: `管道 ${name} 已存在` });
  if (!isNew && !existing) return sendError(res, 'NOT_FOUND', { message: `管道 ${name} 不存在` });
  const desc = apiStd.engine.define(name, { ...config, builtin: false }); // 校验失败抛 400
  await query(`INSERT INTO api_transform_pipelines (name, config, updated_by) VALUES ($1, $2, $3)
               ON CONFLICT (name) DO UPDATE SET config = $2, updated_by = $3, enabled = true, updated_at = NOW()`, [name, JSON.stringify(config), userIdOf(req)]);
  return ok(res, { pipeline: desc }, isNew ? 201 : 200);
}

pipelineRouter.post('/', wrap(async (req, res) => {
  const { name, config } = req.body || {};
  if (!name) return sendError(res, 'INVALID_REQUEST', { message: 'name 必填' });
  return savePipeline(req, res, String(name), config, true);
}));

pipelineRouter.put('/:name', wrap(async (req, res) => savePipeline(req, res, req.params.name, (req.body || {}).config, false)));

pipelineRouter.delete('/:name', wrap(async (req, res) => {
  const p = apiStd.engine.get(req.params.name);
  if (!p) return sendError(res, 'NOT_FOUND', { message: `管道 ${req.params.name} 不存在` });
  if (p.builtin) return sendError(res, 'CONFLICT', { status: 409, message: '内置管道不能删除（可通过配置文件调整）' });
  apiStd.engine.remove(p.name);
  await query('UPDATE api_transform_pipelines SET enabled = false, updated_at = NOW() WHERE name = $1', [p.name]);
  return ok(res, { deleted: p.name });
}));

pipelineRouter.post('/:name/refresh-cache', (req, res) => {
  if (!apiStd.engine.get(req.params.name)) return sendError(res, 'NOT_FOUND', { message: `管道 ${req.params.name} 不存在` });
  return ok(res, { cleared: apiStd.engine.clearCache(req.params.name) });
});

const transformerRouter = express.Router();
transformerRouter.use(express.json({ limit: '32kb' }));
transformerRouter.get('/', (req, res) => ok(res, { transformers: apiStd.transformerRegistry.list() }));
transformerRouter.post('/', wrap(async (req, res) => {
  const { name, config = {} } = req.body || {};
  const type = (req.body && req.body.type) || config.type;
  if (!name || !type) return sendError(res, 'INVALID_REQUEST', { message: 'name 与 type 必填（声明式类型：renameFields/removeFields/addFields/setHeader）' });
  const t = apiStd.transformerRegistry.registerDeclarative(String(name), { type, config: config.config || config, description: req.body.description });
  await query(`INSERT INTO api_transformers (name, type, config, description, created_by) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (name) DO UPDATE SET type = $2, config = $3, description = $4, enabled = true`,
  [t.name, type, JSON.stringify(t.declarative.config), t.description, userIdOf(req)]);
  return ok(res, { transformer: apiStd.transformerRegistry.list().find((x) => x.name === t.name) }, 201);
}));
transformerRouter.delete('/:name', wrap(async (req, res) => {
  const removed = apiStd.transformerRegistry.unregister(req.params.name);
  if (!removed) return sendError(res, 'NOT_FOUND', { message: '转换器不存在' });
  await query('UPDATE api_transformers SET enabled = false WHERE name = $1', [req.params.name]);
  return ok(res, { deleted: req.params.name });
}));

// ══════════════════════════════════════════════════════════════
// REQ-00407 弃用管理（管理员）
// ══════════════════════════════════════════════════════════════
const deprecationAdminRouter = express.Router();
deprecationAdminRouter.use(express.json({ limit: '64kb' }));

function validDate(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }

deprecationAdminRouter.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const endpoint = String(b.endpoint || '');
  const method = String(b.method || 'GET').toUpperCase();
  if (!/^\/[A-Za-z0-9/_:*.-]{1,250}$/.test(endpoint)) return sendError(res, 'INVALID_REQUEST', { message: 'endpoint 必须是以 / 开头的路径（支持 :param 与 *）' });
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'].includes(method)) return sendError(res, 'INVALID_REQUEST', { message: 'method 无效' });
  const sunset = validDate(b.sunsetAt);
  const deprecatedAt = b.deprecatedAt ? validDate(b.deprecatedAt) : new Date();
  if (!sunset || !deprecatedAt || sunset <= deprecatedAt) return sendError(res, 'INVALID_REQUEST', { message: 'sunsetAt 必须是晚于弃用时间的有效日期' });
  const { rows: [d] } = await query(
    `INSERT INTO api_deprecations (endpoint, method, deprecated_at, sunset_at, successor_endpoint, migration_guide, breaking_changes, affected_clients, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [endpoint, method, deprecatedAt, sunset, b.successorEndpoint || null, b.migrationGuide || null, JSON.stringify(b.breakingChanges || []), JSON.stringify(b.affectedClients || []), userIdOf(req)]);
  await apiStd.deprecations.load();
  setup.refreshDeprecationGauge();
  return ok(res, d, 201);
}));

deprecationAdminRouter.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT d.*, COALESCE(s.clients,0)::int AS active_clients, COALESCE(s.calls,0)::int AS total_calls, COALESCE(s.migrated,0)::int AS migrated_clients
       FROM api_deprecations d
       LEFT JOIN (SELECT deprecation_id, COUNT(*) FILTER (WHERE migrated_at IS NULL) AS clients, SUM(deprecated_call_count) AS calls,
                         COUNT(*) FILTER (WHERE migrated_at IS NOT NULL) AS migrated
                    FROM client_migration_status GROUP BY deprecation_id) s ON s.deprecation_id = d.id
      WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.sunset_at`, [req.query.status || null]);
  const items = rows.map((r) => ({ ...r, migrationProgress: r.active_clients + r.migrated_clients ? +(r.migrated_clients / (r.active_clients + r.migrated_clients)).toFixed(4) : null, daysRemaining: Math.ceil((new Date(r.sunset_at) - Date.now()) / 86400000) }));
  return ok(res, { total: items.length, deprecations: items });
}));

deprecationAdminRouter.post('/notify', wrap(async (req, res) => ok(res, await setup.runDeprecationNotifier({ days: Number(req.body && req.body.days) || 30, minCalls: Number(req.body && req.body.minCalls) || 5 }))));

deprecationAdminRouter.get('/:id', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM api_deprecations WHERE id = $1', [Number(req.params.id) || 0]);
  if (!d) return sendError(res, 'NOT_FOUND', { message: '弃用记录不存在' });
  await apiStd.deprecations.flush();
  const { rows: clients } = await query('SELECT client_id, client_version, user_id, deprecated_call_count, last_deprecated_call_at, migrated_at, notification_sent_at FROM client_migration_status WHERE deprecation_id = $1 ORDER BY deprecated_call_count DESC LIMIT 100', [d.id]);
  return ok(res, { ...d, clients });
}));

deprecationAdminRouter.patch('/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (b.sunsetAt !== undefined) { const d = validDate(b.sunsetAt); if (!d) return sendError(res, 'INVALID_REQUEST', { message: 'sunsetAt 无效' }); add('sunset_at', d); }
  if (b.deprecatedAt !== undefined) { const d = validDate(b.deprecatedAt); if (!d) return sendError(res, 'INVALID_REQUEST', { message: 'deprecatedAt 无效' }); add('deprecated_at', d); }
  if (b.successorEndpoint !== undefined) add('successor_endpoint', b.successorEndpoint);
  if (b.migrationGuide !== undefined) add('migration_guide', b.migrationGuide);
  if (b.breakingChanges !== undefined) add('breaking_changes', JSON.stringify(b.breakingChanges));
  if (b.status !== undefined) { if (!['active', 'sunset', 'removed', 'cancelled'].includes(b.status)) return sendError(res, 'INVALID_REQUEST', { message: 'status 无效' }); add('status', b.status); }
  if (!sets.length) return sendError(res, 'INVALID_REQUEST', { message: '没有可更新的字段' });
  params.push(Number(req.params.id) || 0);
  const { rows: [d] } = await query(`UPDATE api_deprecations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params);
  if (!d) return sendError(res, 'NOT_FOUND', { message: '弃用记录不存在' });
  await apiStd.deprecations.load();
  setup.refreshDeprecationGauge();
  return ok(res, d);
}));

deprecationAdminRouter.delete('/:id', wrap(async (req, res) => {
  const { rows: [d] } = await query(`UPDATE api_deprecations SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id`, [Number(req.params.id) || 0]);
  if (!d) return sendError(res, 'NOT_FOUND', { message: '弃用记录不存在' });
  await apiStd.deprecations.load();
  setup.refreshDeprecationGauge();
  return ok(res, { cancelled: d.id });
}));

deprecationAdminRouter.post('/:id/clients/:clientId/migrated', wrap(async (req, res) => {
  const { rowCount } = await query('UPDATE client_migration_status SET migrated_at = NOW() WHERE deprecation_id = $1 AND client_id = $2', [Number(req.params.id) || 0, req.params.clientId]);
  return ok(res, { updated: rowCount });
}));

// ══════════════════════════════════════════════════════════════
// REQ-00201 / REQ-00520 版本管理（管理员）
// ══════════════════════════════════════════════════════════════
const versionAdminRouter = express.Router();
versionAdminRouter.use(express.json({ limit: '64kb' }));

versionAdminRouter.get('/', wrap(async (req, res) => {
  await apiStd.versionRegistry.flushUsage();
  const { rows: usage } = await query(`SELECT version, date, SUM(request_count)::bigint AS requests, COUNT(DISTINCT endpoint)::int AS endpoints
      FROM api_version_usage WHERE date > CURRENT_DATE - 7 GROUP BY version, date ORDER BY date DESC, version`).catch(() => ({ rows: [] }));
  const { rows: top } = await query(`SELECT version, endpoint, SUM(request_count)::bigint AS requests FROM api_version_usage
      WHERE date > CURRENT_DATE - 7 GROUP BY version, endpoint ORDER BY requests DESC LIMIT 20`).catch(() => ({ rows: [] }));
  return ok(res, { lifecycle: LIFECYCLE, current: apiStd.versionRegistry.current(), versions: apiStd.versionRegistry.list(), usage, topEndpoints: top });
}));

versionAdminRouter.get('/transforms', (req, res) => ok(res, { rules: apiStd.transforms.list() }));

versionAdminRouter.post('/transforms', wrap(async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!/^[a-z0-9][a-z0-9._-]{2,99}$/i.test(id)) return sendError(res, 'INVALID_REQUEST', { message: 'id 需为 3-100 位字母数字' });
  const version = Number(b.version);
  if (!apiStd.versionRegistry.get(version)) return sendError(res, 'INVALID_REQUEST', { message: `版本 ${b.version} 不存在` });
  const okOp = (op) => op && ['remove', 'rename', 'default', 'set', 'move'].includes(op.op) && (op.path || (op.from && op.to));
  const response = Array.isArray(b.response) ? b.response : [];
  const request = Array.isArray(b.request) ? b.request : [];
  if (![...response, ...request].every(okOp)) return sendError(res, 'INVALID_REQUEST', { message: 'op 只能是 remove/rename/default/set/move 且需要 path 或 from/to' });
  if (!b.path || !String(b.path).startsWith('/')) return sendError(res, 'INVALID_REQUEST', { message: 'path 必填' });
  await query(`INSERT INTO api_version_transforms (id, version, method, path, description, request_ops, response_ops, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id) DO UPDATE SET version=$2, method=$3, path=$4, description=$5, request_ops=$6, response_ops=$7, enabled=true, updated_at=NOW()`,
  [id, version, String(b.method || '*').toUpperCase(), b.path, b.description || null, JSON.stringify(request), JSON.stringify(response), userIdOf(req)]);
  await apiStd.loadTransforms();
  return ok(res, { rule: apiStd.transforms.list().find((r) => r.id === id) }, 201);
}));

versionAdminRouter.delete('/transforms/:id', wrap(async (req, res) => {
  const { rowCount } = await query('UPDATE api_version_transforms SET enabled = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
  await apiStd.loadTransforms();
  if (!rowCount) return sendError(res, 'NOT_FOUND', { message: '规则不存在或为内置规则' });
  return ok(res, { disabled: req.params.id });
}));

versionAdminRouter.patch('/:version', wrap(async (req, res) => {
  const v = Number(req.params.version);
  const b = req.body || {};
  const desc = apiStd.versionRegistry.transition(v, b.status, { deprecatedAt: b.deprecatedAt, sunsetAt: b.sunsetAt, successor: b.successor, migrationGuide: b.migrationGuide, force: b.force === true });
  await apiStd.versionRegistry.persist(v);
  logger.warn({ version: v, status: desc.status, by: userIdOf(req) }, 'API 版本状态变更');
  return ok(res, desc);
}));

versionAdminRouter.post('/:version/changes', wrap(async (req, res) => {
  const v = Number(req.params.version);
  const b = req.body || {};
  if (!apiStd.versionRegistry.get(v)) return sendError(res, 'NOT_FOUND', { message: `版本 ${v} 不存在` });
  if (!b.path || !b.description) return sendError(res, 'INVALID_REQUEST', { message: 'path 与 description 必填' });
  const { rows: [c] } = await query(`INSERT INTO api_changes (version, change_type, path, description, breaking_change, migration_notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [v, String(b.changeType || 'changed').slice(0, 20), b.path, b.description, !!b.breaking, b.migrationNotes || null]);
  return ok(res, c, 201);
}));

// ══════════════════════════════════════════════════════════════
// 管理：契约 / 字段集 / 运行时配置 / 性能预算 / lint / 兼容性 / 重试
// ══════════════════════════════════════════════════════════════
const adminRouter = express.Router();
adminRouter.use(express.json({ limit: '256kb' }));

adminRouter.get('/config', (req, res) => ok(res, { schemaValidation: apiStd.config.schemaValidation, maxBufferBytes: apiStd.config.maxBufferBytes, maxFields: apiStd.config.maxFields, enabled: apiStd.config.enabled }));
adminRouter.patch('/config', (req, res) => {
  const sv = (req.body || {}).schemaValidation;
  if (sv) {
    if (sv.mode !== undefined && !['enforce', 'sample', 'off'].includes(sv.mode)) return sendError(res, 'INVALID_REQUEST', { message: 'mode 只能是 enforce/sample/off' });
    if (sv.sampleRate !== undefined && !(Number(sv.sampleRate) >= 0 && Number(sv.sampleRate) <= 1)) return sendError(res, 'INVALID_REQUEST', { message: 'sampleRate 取值 0-1' });
    Object.assign(apiStd.config.schemaValidation, sv.mode !== undefined ? { mode: sv.mode } : {}, sv.sampleRate !== undefined ? { sampleRate: Number(sv.sampleRate) } : {});
    apiStd.engine.clearCache();
  }
  logger.warn({ config: apiStd.config.schemaValidation, by: userIdOf(req), pid: process.pid }, 'API standards runtime config changed (per process)');
  return ok(res, { schemaValidation: apiStd.config.schemaValidation, scope: 'process', pid: process.pid });
});

adminRouter.get('/schemas', (req, res) => ok(res, { total: apiStd.schemas.list().length, contracts: apiStd.schemas.list() }));
adminRouter.get('/schemas/violations', (req, res) => ok(res, { total: apiStd.violations.length, violations: apiStd.violations }));
adminRouter.get('/schemas/:id', wrap(async (req, res) => {
  const c = apiStd.schemas.get(req.params.id);
  if (!c) return sendError(res, 'NOT_FOUND', { message: `契约 ${req.params.id} 不存在` });
  const history = await apiStd.schemas.history(c.id).catch(() => []);
  return ok(res, { id: c.id, method: c.method, route: c.route, service: c.service, status: c.status || '2xx', schema: c.schema, requestSchema: c.requestSchema || null, hash: c.hash, history });
}));
adminRouter.get('/schemas/:id/mock', (req, res) => {
  const c = apiStd.schemas.get(req.params.id);
  if (!c) return sendError(res, 'NOT_FOUND', { message: `契约 ${req.params.id} 不存在` });
  const resolve = (name) => apiStd.schemas.files.get(name) || null;
  return ok(res, { contract: c.id, mock: mockFromSchema(c.schema, { resolveExternal: resolve }) });
});
adminRouter.post('/schemas/:id/validate', (req, res) => {
  const c = apiStd.schemas.get(req.params.id);
  if (!c) return sendError(res, 'NOT_FOUND', { message: `契约 ${req.params.id} 不存在` });
  return ok(res, apiStd.schemas.validate(c, (req.body || {}).body));
});
adminRouter.get('/schemas/:id/diff', wrap(async (req, res) => {
  const c = apiStd.schemas.get(req.params.id);
  if (!c) return sendError(res, 'NOT_FOUND', { message: `契约 ${req.params.id} 不存在` });
  const from = await apiStd.schemas.getVersion(c.id, Number(req.query.from) || 1);
  if (!from) return sendError(res, 'NOT_FOUND', { message: '指定的历史版本不存在' });
  const to = req.query.to ? await apiStd.schemas.getVersion(c.id, Number(req.query.to)) : { schema: c.schema, request_schema: c.requestSchema, method: c.method, route: c.route };
  if (!to) return sendError(res, 'NOT_FOUND', { message: '指定的目标版本不存在' });
  const mkResolver = (defs) => (ref) => {
    const [name, frag] = ref.split('#');
    const file = defs && defs[name] ? { definitions: defs[name] } : apiStd.schemas.files.get(name);
    return file && frag ? frag.slice(1).split('/').reduce((n, k) => (n ? n[k] : undefined), file) : null;
  };
  const r = compat.detectContractChanges(
    { [c.id]: { method: from.method, route: from.route, schema: from.schema, requestSchema: from.request_schema || undefined } },
    { [c.id]: { method: to.method, route: to.route, schema: to.schema, requestSchema: to.request_schema || undefined } },
    { resolveOld: mkResolver(from.definitions), resolveNew: mkResolver(to.definitions) });
  return ok(res, r);
}));

adminRouter.get('/fieldsets', (req, res) => ok(res, apiStd.fieldsets.list()));
adminRouter.post('/fieldsets', wrap(async (req, res) => {
  const { resourceType, fieldsetName, fields, description, isDefault } = req.body || {};
  if (!/^[a-z][a-z0-9_-]{1,49}$/i.test(resourceType || '') || !/^[a-z][a-z0-9_-]{1,49}$/i.test(fieldsetName || '')) return sendError(res, 'INVALID_REQUEST', { message: 'resourceType / fieldsetName 无效' });
  if (fields !== null && (!Array.isArray(fields) || !fields.length || fields.length > 50 || !fields.every((f) => typeof f === 'string' && /^[A-Za-z_][A-Za-z0-9_.[\]]{0,99}$/.test(f)))) return sendError(res, 'INVALID_REQUEST', { message: 'fields 必须是 1-50 个字段名，或 null 表示完整字段' });
  await query(`INSERT INTO fieldset_configs (resource_type, fieldset_name, fields, description, is_default) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (resource_type, fieldset_name) DO UPDATE SET fields = $3, description = $4, is_default = $5, updated_at = NOW()`,
  [resourceType, fieldsetName, fields === null ? null : JSON.stringify(fields), description || null, !!isDefault]);
  apiStd.fieldsets.register(resourceType, fieldsetName, fields, { description, isDefault });
  apiStd.engine.clearCache();
  return ok(res, { resourceType, fieldsetName, fields }, 201);
}));
adminRouter.get('/field-usage/:resourceType', wrap(async (req, res) => {
  await apiStd.fieldUsage.flush();
  const { rows } = await query('SELECT field_name, request_count, last_requested_at FROM field_usage_stats WHERE resource_type = $1 ORDER BY request_count DESC LIMIT 50', [req.params.resourceType]);
  return ok(res, rows);
}));

adminRouter.get('/performance', wrap(async (req, res) => {
  const report = setup.budgetManager.report();
  const trend = await setup.budgetManager.trend(Math.min(168, Number(req.query.hours) || 24));
  return ok(res, { ...report, trend, budgets: setup.budgetConfig.budgets.map(({ re, ...b }) => b) });
}));
adminRouter.post('/performance/evaluate', (req, res) => ok(res, setup.budgetManager.evaluate()));

adminRouter.get('/lint', wrap(async (req, res) => {
  const lint = require(path.join(REPO_ROOT, 'scripts', 'api-lint.js'));
  const r = lint.lintRepo({ root: REPO_ROOT });
  return ok(res, { summary: r.summary, byRule: r.byRule, errors: r.issues.filter((i) => i.severity === 'error').slice(0, 100), warnings: r.issues.filter((i) => i.severity === 'warning').slice(0, 100) });
}));

adminRouter.get('/compat-report', wrap(async (req, res) => {
  const snapFile = path.join(REPO_ROOT, 'docs', 'api-spec', 'contracts', 'schema-snapshot.json');
  if (!fs.existsSync(snapFile)) return sendError(res, 'NOT_FOUND', { message: '尚未生成契约快照（node scripts/contract-snapshot.js --update）' });
  const old = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const cur = apiStd.schemas.snapshot();
  const resolver = (defs) => (ref) => { const [n, f] = ref.split('#'); const file = defs[n] ? { definitions: defs[n] } : null; return file && f ? f.slice(1).split('/').reduce((x, k) => (x ? x[k] : undefined), file) : null; };
  const r = compat.detectContractChanges(old.contracts, cur.contracts, { resolveOld: resolver(old.definitions), resolveNew: resolver(cur.definitions) });
  if (req.query.format === 'markdown') return res.type('text/markdown; charset=utf-8').send(compat.generateMigrationGuide(r, { title: 'API 兼容性报告（契约快照 → 当前）' }));
  return ok(res, r);
}));

adminRouter.get('/retry', wrap(async (req, res) => {
  await setup.retryRecorder.flush();
  const { rows: configs } = await query('SELECT service_name, max_retries, initial_delay_ms, max_delay_ms, backoff_type, jitter_type, timeout_ms, retry_budget_max FROM retry_configs ORDER BY service_name');
  const { rows: stats } = await query(`SELECT service_name, operation_name, hour_timestamp, total_attempts, successful_attempts, retry_attempts, avg_delay_ms, error_breakdown
      FROM retry_stats_hourly WHERE hour_timestamp > NOW() - INTERVAL '24 hours' ORDER BY hour_timestamp DESC LIMIT 100`);
  return ok(res, { configs, stats, budgets: { batch: setup.retryManagers.batch.retryBudget.getBudget() } });
}));

adminRouter.post('/validate-body', (req, res) => {
  const { schema, body } = req.body || {};
  if (!schema || typeof schema !== 'object') return sendError(res, 'INVALID_REQUEST', { message: 'schema 必填' });
  const v = new Validator({ resolveExternal: (n) => apiStd.schemas.files.get(n) || null });
  return ok(res, v.validate(schema, body));
});

module.exports = {
  publicRouter,
  batchRouter,
  pipelineRouter,
  transformerRouter,
  deprecationAdminRouter,
  versionAdminRouter,
  adminRouter,
};
