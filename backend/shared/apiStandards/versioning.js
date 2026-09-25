/**
 * REQ-00201 / REQ-00520 / REQ-00407: 版本协商、版本生命周期、版本间转换、端点弃用
 *
 * VersionRegistry
 *   - 版本来源优先级：URL（/api/vN/、/vN/）> 媒体类型（application/vnd.minego.vN+json）
 *                    > Accept-Version > X-API-Version > 默认（当前稳定版）
 *   - 生命周期：development → testing → stable → deprecated → sunset（下线返回 410）
 *   - deprecated：Deprecation（RFC 9745，@epoch）/ Sunset（RFC 8594）/ Link rel="successor-version"
 *   - 使用统计：内存聚合，定期写 api_version_usage（按天/版本/端点）
 * TransformEngine
 *   - 声明式规则 { version, method, path, response:[ops], request:[ops] }，
 *     op：remove / rename / default / set / move；作用于 data（标准信封）或根对象，数组逐项
 * DeprecationRegistry（端点级，REQ-00407）
 *   - api_deprecations 表；按 method + 路径模式匹配（:param、*）
 *   - 响应头 + 响应体 deprecation 字段；下线后 410；按客户端统计调用量（client_migration_status）
 */
'use strict';

const LIFECYCLE = ['development', 'testing', 'stable', 'deprecated', 'sunset'];
const TRANSITIONS = {
  development: ['testing', 'stable'],
  testing: ['development', 'stable'],
  stable: ['deprecated'],
  deprecated: ['stable', 'sunset'],
  sunset: [],
};

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function epochSeconds(d) {
  return Math.floor(d.getTime() / 1000);
}

/** 合并追加 Link 头（分页、弃用、successor 可能同时存在） */
function appendLinkHeader(res, value) {
  if (!value) return;
  const prev = res.getHeader('Link');
  const list = prev ? (Array.isArray(prev) ? prev.join(', ') : String(prev)) : '';
  if (list.includes(value)) return;
  res.setHeader('Link', list ? `${list}, ${value}` : value);
}

class VersionRegistry {
  /**
   * @param {object} opts { versions: {n: {...}}, currentVersion, query(sql, params), logger }
   */
  constructor({ versions = {}, currentVersion = null, query = null, logger = null, now = () => new Date() } = {}) {
    this.versions = new Map();
    this.query = query;
    this.logger = logger;
    this.now = now;
    for (const [k, v] of Object.entries(versions)) this._set(Number(k), v);
    this.explicitCurrent = currentVersion;
    this.usage = new Map(); // `${date}|${version}|${endpoint}` -> { count, last }
    this.loadedAt = 0;
  }

  _set(version, v) {
    const entry = {
      version,
      status: LIFECYCLE.includes(v.status) ? v.status : (v.sunset ? 'sunset' : v.deprecated ? 'deprecated' : 'stable'),
      released: v.released || null,
      deprecatedAt: toDate(v.deprecatedAt || v.deprecated),
      sunsetAt: toDate(v.sunsetAt || v.sunset),
      successor: v.successor || v.successor_version || null,
      migrationGuide: v.migrationGuide || v.migration_guide || null,
      description: v.description || '',
      changes: v.changes || [],
    };
    this.versions.set(version, entry);
    return entry;
  }

  get(version) { return this.versions.get(Number(version)) || null; }

  list() {
    return [...this.versions.values()].sort((a, b) => a.version - b.version).map((v) => this.describe(v));
  }

  describe(v) {
    const e = typeof v === 'number' ? this.get(v) : v;
    if (!e) return null;
    return {
      version: e.version,
      status: this.effectiveStatus(e),
      configuredStatus: e.status,
      released: e.released,
      deprecatedAt: e.deprecatedAt ? e.deprecatedAt.toISOString() : null,
      sunsetAt: e.sunsetAt ? e.sunsetAt.toISOString() : null,
      successor: e.successor,
      migrationGuide: e.migrationGuide,
      description: e.description,
    };
  }

  /** 按时间推导的有效状态：到达 sunsetAt 即视为下线 */
  effectiveStatus(e) {
    const now = this.now();
    if (e.status === 'sunset' || (e.sunsetAt && now >= e.sunsetAt)) return 'sunset';
    if (e.status === 'deprecated' || (e.deprecatedAt && now >= e.deprecatedAt && e.status === 'stable')) return 'deprecated';
    return e.status;
  }

  /** 对外可用（testing/stable/deprecated）的版本 */
  supported() {
    return [...this.versions.values()].filter((e) => ['testing', 'stable', 'deprecated'].includes(this.effectiveStatus(e))).map((e) => e.version).sort((a, b) => a - b);
  }

  current() {
    if (this.explicitCurrent && this.get(this.explicitCurrent) && this.effectiveStatus(this.get(this.explicitCurrent)) === 'stable') return this.explicitCurrent;
    const stable = [...this.versions.values()].filter((e) => this.effectiveStatus(e) === 'stable').map((e) => e.version);
    return stable.length ? Math.max(...stable) : (this.explicitCurrent || 1);
  }

  static extractPathVersion(path) {
    const m = String(path || '').match(/^\/(?:api\/)?v(\d+)(?:\/|$)/);
    return m ? parseInt(m[1], 10) : null;
  }

  static extractMediaTypeVersion(accept) {
    const m = String(accept || '').match(/application\/vnd\.minego(?:\.[a-z0-9-]+)?\.v(\d+)\+json/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /** 解析请求的版本与来源 */
  resolve(req) {
    const pathVersion = VersionRegistry.extractPathVersion(req.path);
    const mediaVersion = VersionRegistry.extractMediaTypeVersion(req.headers.accept);
    const hv = req.headers['accept-version'] || req.headers['x-api-version'];
    const headerVersion = hv !== undefined && /^\s*v?\d+\s*$/i.test(String(hv)) ? parseInt(String(hv).replace(/v/i, ''), 10) : null;
    const invalidHeader = hv !== undefined && headerVersion === null;
    let version, source;
    if (pathVersion) { version = pathVersion; source = 'path'; }
    else if (mediaVersion) { version = mediaVersion; source = 'media-type'; }
    else if (headerVersion) { version = headerVersion; source = 'header'; }
    else { version = this.current(); source = 'default'; }
    const negotiated = mediaVersion || headerVersion;
    return { version, source, pathVersion, mediaVersion, headerVersion, invalidHeader, conflict: !!(pathVersion && negotiated && negotiated !== pathVersion) };
  }

  /** 状态迁移（带生命周期校验） */
  transition(version, status, { deprecatedAt, sunsetAt, successor, migrationGuide, force = false } = {}) {
    const e = this.get(version);
    if (!e) throw Object.assign(new Error(`版本 ${version} 不存在`), { status: 404 });
    if (!LIFECYCLE.includes(status)) throw Object.assign(new Error(`无效状态 ${status}，可选：${LIFECYCLE.join(' → ')}`), { status: 400 });
    if (status !== e.status && !force && !(TRANSITIONS[e.status] || []).includes(status)) {
      throw Object.assign(new Error(`不允许的生命周期迁移：${e.status} → ${status}`), { status: 409, allowed: TRANSITIONS[e.status] });
    }
    e.status = status;
    if (status === 'deprecated') {
      e.deprecatedAt = toDate(deprecatedAt) || e.deprecatedAt || this.now();
      e.sunsetAt = toDate(sunsetAt) || e.sunsetAt || new Date(this.now().getTime() + 180 * 86400000);
    }
    if (status === 'sunset') e.sunsetAt = toDate(sunsetAt) || e.sunsetAt || this.now();
    if (status === 'stable') { e.deprecatedAt = null; e.sunsetAt = null; }
    if (successor !== undefined) e.successor = successor;
    if (migrationGuide !== undefined) e.migrationGuide = migrationGuide;
    return this.describe(e);
  }

  /** 弃用响应头 */
  deprecationHeaders(version) {
    const e = this.get(version);
    if (!e) return {};
    const status = this.effectiveStatus(e);
    if (status !== 'deprecated' && status !== 'sunset') return {};
    const h = {};
    const dep = e.deprecatedAt || this.now();
    h.Deprecation = `@${epochSeconds(dep)}`;
    if (e.sunsetAt) h.Sunset = e.sunsetAt.toUTCString();
    const links = [];
    if (e.successor) links.push(`</api/v${e.successor}/>; rel="successor-version"`);
    if (e.migrationGuide) links.push(`<${e.migrationGuide}>; rel="deprecation"; type="text/html"`);
    if (links.length) h.Link = links.join(', ');
    return h;
  }

  recordUsage(version, endpoint) {
    const day = this.now().toISOString().slice(0, 10);
    const key = `${day}|${version}|${String(endpoint).slice(0, 200)}`;
    const u = this.usage.get(key) || { count: 0, last: null };
    u.count++;
    u.last = this.now();
    this.usage.set(key, u);
    if (this.usage.size > 5000) this.flushUsage().catch(() => {});
  }

  usageSnapshot() {
    const out = {};
    for (const [k, u] of this.usage) {
      const [day, version] = k.split('|');
      out[day] = out[day] || {};
      out[day][`v${version}`] = (out[day][`v${version}`] || 0) + u.count;
    }
    return out;
  }

  async flushUsage() {
    if (!this.query || !this.usage.size) return 0;
    const entries = [...this.usage.entries()];
    this.usage.clear();
    let n = 0;
    for (const [k, u] of entries) {
      const [day, version, endpoint] = k.split('|');
      try {
        await this.query(
          `INSERT INTO api_version_usage (version, endpoint, request_count, last_used_at, date)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (version, endpoint, date)
           DO UPDATE SET request_count = api_version_usage.request_count + EXCLUDED.request_count, last_used_at = EXCLUDED.last_used_at`,
          [Number(version), endpoint, u.count, u.last, day]);
        n++;
      } catch (err) {
        if (this.logger) this.logger.debug({ err: err.message }, 'api_version_usage flush failed');
      }
    }
    return n;
  }

  async load() {
    if (!this.query) return false;
    try {
      const { rows } = await this.query('SELECT * FROM api_versions ORDER BY version');
      for (const row of rows) {
        const prev = this.get(row.version) || {};
        this._set(row.version, {
          status: row.status || prev.status,
          released: row.released ? new Date(row.released).toISOString().slice(0, 10) : prev.released,
          deprecatedAt: row.deprecated,
          sunsetAt: row.sunset,
          successor: row.successor_version,
          migrationGuide: row.migration_guide,
          description: row.description || prev.description,
          changes: prev.changes,
        });
      }
      this.loadedAt = Date.now();
      return true;
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'load api_versions failed, using defaults');
      return false;
    }
  }

  async persist(version) {
    const e = this.get(version);
    if (!this.query || !e) return;
    await this.query(
      `INSERT INTO api_versions (version, released, deprecated, sunset, description, status, successor_version, migration_guide, updated_at)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (version) DO UPDATE SET deprecated = $3, sunset = $4, status = $6, successor_version = $7,
         migration_guide = $8, updated_at = NOW()`,
      [e.version, e.released, e.deprecatedAt, e.sunsetAt, e.description, e.status, e.successor, e.migrationGuide]);
  }

  /** 破坏性变更（api_changes 表） */
  async breakingChanges(version) {
    if (!this.query) return [];
    const { rows } = await this.query(
      `SELECT id, version, change_type, path, description, change_date, breaking_change, migration_notes
         FROM api_changes WHERE ($1::int IS NULL OR version = $1) ORDER BY version, id`, [version || null]);
    return rows;
  }
}

// ── 版本间数据转换 ──────────────────────────────────────────
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}
function deletePath(obj, path) {
  const parts = path.split('.');
  const parent = parts.length > 1 ? getPath(obj, parts.slice(0, -1).join('.')) : obj;
  if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]];
}

function applyOps(target, ops) {
  const apply = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    for (const op of ops) {
      switch (op.op) {
        case 'remove': deletePath(obj, op.path); break;
        case 'rename': {
          const v = getPath(obj, op.from);
          if (v !== undefined) { deletePath(obj, op.from); setPath(obj, op.to, v); }
          break;
        }
        case 'default': if (getPath(obj, op.path) === undefined) setPath(obj, op.path, op.value); break;
        case 'set': setPath(obj, op.path, op.value); break;
        case 'move': {
          const v = getPath(obj, op.from);
          if (v !== undefined) { deletePath(obj, op.from); setPath(obj, op.to, v); }
          break;
        }
        default: break;
      }
    }
    return obj;
  };
  return Array.isArray(target) ? target.map(apply) : apply(target);
}

function pathPatternToRegex(pattern) {
  const esc = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '*');
  const re = esc.replace(/\/:[A-Za-z0-9_]+/g, '/[^/]+').replace(/\*/g, '.*');
  return new RegExp(`^${re}/?$`);
}

class TransformEngine {
  constructor(rules = []) {
    this.rules = [];
    for (const r of rules) this.add(r);
  }
  add(rule) {
    const r = { id: rule.id || `rule-${this.rules.length + 1}`, version: Number(rule.version), method: (rule.method || '*').toUpperCase(), path: rule.path, description: rule.description || '', request: rule.request || [], response: rule.response || [], builtin: !!rule.builtin };
    r.re = pathPatternToRegex(r.path);
    this.rules = this.rules.filter((x) => x.id !== r.id);
    this.rules.push(r);
    return r;
  }
  remove(id) { const n = this.rules.length; this.rules = this.rules.filter((r) => r.id !== id); return this.rules.length < n; }
  list() { return this.rules.map(({ re, ...r }) => r); }
  match(version, method, path) {
    return this.rules.filter((r) => r.version === Number(version) && (r.method === '*' || r.method === method) && r.re.test(path));
  }
  /** 转换响应体：标准信封时作用于 data（对象或数组），否则作用于根 */
  transformResponse(version, method, path, body) {
    const rules = this.match(version, method, path).filter((r) => r.response.length);
    if (!rules.length || !body || typeof body !== 'object') return { body, applied: [] };
    for (const r of rules) {
      if (body.data !== undefined && body.data !== null && typeof body.data === 'object') body.data = applyOps(body.data, r.response);
      else applyOps(body, r.response);
    }
    return { body, applied: rules.map((r) => r.id) };
  }
  transformRequest(version, method, path, reqBody) {
    const rules = this.match(version, method, path).filter((r) => r.request.length);
    if (!rules.length || !reqBody || typeof reqBody !== 'object') return { body: reqBody, applied: [] };
    for (const r of rules) applyOps(reqBody, r.request);
    return { body: reqBody, applied: rules.map((r) => r.id) };
  }
}

// ── 端点弃用（REQ-00407） ───────────────────────────────────
function sanitizeClient(v, max = 64) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[^A-Za-z0-9._:@/-]/g, '').slice(0, max);
  return s || null;
}

class DeprecationRegistry {
  constructor({ query = null, logger = null, now = () => new Date(), metrics = null, guideBase = '/api/deprecations' } = {}) {
    this.query = query;
    this.logger = logger;
    this.now = now;
    this.metrics = metrics;
    this.guideBase = guideBase;
    this.items = [];
    this.pending = new Map();
    this.loadedAt = 0;
  }

  _compile(row) {
    return {
      id: row.id,
      endpoint: row.endpoint,
      method: String(row.method || '*').toUpperCase(),
      deprecatedAt: toDate(row.deprecated_at || row.deprecatedAt) || this.now(),
      sunsetAt: toDate(row.sunset_at || row.sunsetAt),
      successor: row.successor_endpoint || row.successor || null,
      migrationGuide: row.migration_guide || row.migrationGuide || null,
      breakingChanges: row.breaking_changes || row.breakingChanges || [],
      status: row.status || 'active',
      re: pathPatternToRegex(row.endpoint),
    };
  }

  setAll(rows) { this.items = rows.map((r) => this._compile(r)).filter((d) => d.status !== 'cancelled'); this.loadedAt = Date.now(); }

  async load() {
    if (!this.query) return false;
    try {
      const { rows } = await this.query(`SELECT * FROM api_deprecations WHERE status <> 'cancelled' ORDER BY id`);
      this.setAll(rows);
      return true;
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'load api_deprecations failed');
      return false;
    }
  }

  find(method, path) {
    const m = String(method).toUpperCase();
    // 更具体的模式优先（字面量字符多者优先）
    const hits = this.items.filter((d) => (d.method === '*' || d.method === m || (m === 'HEAD' && d.method === 'GET')) && d.re.test(path));
    if (!hits.length) return null;
    return hits.sort((a, b) => b.endpoint.replace(/[:*][A-Za-z0-9_]*/g, '').length - a.endpoint.replace(/[:*][A-Za-z0-9_]*/g, '').length)[0];
  }

  isSunset(d) { return d.status === 'removed' || d.status === 'sunset' || (d.sunsetAt && this.now() >= d.sunsetAt); }

  guideUrl(d) { return d.migrationGuide && /^https?:\/\//.test(d.migrationGuide) ? d.migrationGuide : `${this.guideBase}/${d.id}/migration-guide`; }

  headers(d) {
    const h = { Deprecation: `@${epochSeconds(d.deprecatedAt)}` };
    if (d.sunsetAt) h.Sunset = d.sunsetAt.toUTCString();
    const links = [];
    if (d.successor) links.push(`<${d.successor}>; rel="successor-version"`);
    links.push(`<${this.guideUrl(d)}>; rel="deprecation"; type="text/markdown"`);
    h.Link = links.join(', ');
    if (d.sunsetAt) h['X-API-Deprecation-Warning'] = `This API will be removed on ${d.sunsetAt.toISOString()}`;
    else h['X-API-Deprecation-Warning'] = 'This API is deprecated';
    return h;
  }

  bodyField(d) {
    const days = d.sunsetAt ? Math.max(0, Math.ceil((d.sunsetAt - this.now()) / 86400000)) : null;
    return {
      deprecated: true,
      deprecatedAt: d.deprecatedAt.toISOString(),
      sunsetAt: d.sunsetAt ? d.sunsetAt.toISOString() : null,
      daysRemaining: days,
      successorApi: d.successor,
      migrationGuide: this.guideUrl(d),
      breakingChanges: d.breakingChanges || [],
    };
  }

  /** 记录一次弃用接口调用（内存聚合，定期 flush 到 client_migration_status） */
  recordCall(d, { clientId, clientVersion, userId } = {}) {
    const cid = sanitizeClient(clientId) || (userId ? `user:${userId}` : 'anonymous');
    const cver = sanitizeClient(clientVersion, 32) || 'unknown';
    if (this.metrics && this.metrics.calls) {
      try { this.metrics.calls.inc({ endpoint: d.endpoint, method: d.method, client_id: sanitizeClient(clientId) || 'unknown', client_version: cver }); } catch { /* ignore */ }
    }
    const key = `${d.id}|${cid}|${cver}`;
    const p = this.pending.get(key) || { deprecationId: d.id, clientId: cid, clientVersion: cver, userId: userId || null, count: 0, last: null };
    p.count++;
    p.last = this.now();
    this.pending.set(key, p);
  }

  async flush() {
    if (!this.pending.size) return 0;
    const batch = [...this.pending.values()];
    this.pending.clear();
    if (this.metrics && this.metrics.byClient) {
      for (const p of batch) { try { this.metrics.byClient.observe({ endpoint: String(p.deprecationId), client_id: p.clientId.startsWith('user:') ? 'user' : p.clientId }, p.count); } catch { /* ignore */ } }
    }
    if (!this.query) return 0;
    let n = 0;
    for (const p of batch) {
      try {
        await this.query(
          `INSERT INTO client_migration_status (client_id, client_version, deprecation_id, user_id, last_deprecated_call_at, deprecated_call_count)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (client_id, deprecation_id) DO UPDATE SET
             client_version = EXCLUDED.client_version,
             last_deprecated_call_at = EXCLUDED.last_deprecated_call_at,
             deprecated_call_count = client_migration_status.deprecated_call_count + EXCLUDED.deprecated_call_count,
             migrated_at = NULL`,
          [p.clientId, p.clientVersion, p.deprecationId, p.userId, p.last, p.count]);
        n++;
      } catch (err) {
        if (this.logger) this.logger.debug({ err: err.message }, 'client_migration_status flush failed');
      }
    }
    return n;
  }

  list() {
    return this.items.map((d) => ({ id: d.id, endpoint: d.endpoint, method: d.method, deprecatedAt: d.deprecatedAt.toISOString(), sunsetAt: d.sunsetAt ? d.sunsetAt.toISOString() : null, successor: d.successor, status: this.isSunset(d) ? 'sunset' : d.status, migrationGuide: this.guideUrl(d) }));
  }
}

/** 迁移文档（Markdown） */
function generateMigrationGuide(d, { stats = null } = {}) {
  const dep = d.deprecated_at || d.deprecatedAt;
  const sun = d.sunset_at || d.sunsetAt;
  const succ = d.successor_endpoint || d.successor || null;
  const method = String(d.method || 'GET').toUpperCase();
  const bcs = d.breaking_changes || d.breakingChanges || [];
  const lines = [];
  lines.push(`# 迁移指南：${method} ${d.endpoint}`, '');
  lines.push('## 概述', '');
  lines.push(`- 弃用时间：${dep ? new Date(dep).toISOString() : '-'}`);
  lines.push(`- 下线时间：${sun ? new Date(sun).toISOString() : '未定'}（到期后返回 410 Gone）`);
  lines.push(`- 替代接口：${succ ? `\`${method} ${succ}\`` : '无（功能下线）'}`);
  if (stats) lines.push(`- 仍在调用的客户端：${stats.clients} 个，累计调用 ${stats.calls} 次`);
  lines.push('');
  lines.push('## 请求对比', '', '| | 旧 | 新 |', '|---|---|---|', `| 方法 | ${method} | ${method} |`, `| 路径 | \`${d.endpoint}\` | ${succ ? `\`${succ}\`` : '-'} |`, '');
  lines.push('## 响应对比', '');
  lines.push('弃用期间旧接口响应额外包含 `Deprecation` / `Sunset` / `Link` 响应头与 `deprecation` 字段，其余字段不变。', '');
  lines.push('## Breaking Changes', '');
  if (!bcs.length) lines.push('无字段级不兼容变更。');
  else {
    lines.push('| 字段 | 变更 | 旧类型 | 新类型 |', '|---|---|---|---|');
    for (const b of bcs) lines.push(`| ${b.field || '-'} | ${b.change || b.description || '-'} | ${b.oldType || '-'} | ${b.newType || '-'} |`);
  }
  lines.push('');
  lines.push('## 代码示例', '');
  lines.push('### 旧 API（已弃用）', '', '```javascript', `const res = await fetch('${d.endpoint}', { method: '${method}', headers: { Authorization: \`Bearer \${token}\` } });`, '```', '');
  if (succ) {
    lines.push('### 新 API（推荐）', '', '```javascript', `const res = await fetch('${succ}', { method: '${method}', headers: { Authorization: \`Bearer \${token}\` } });`);
    for (const b of bcs.filter((x) => x.field && /renamed to (\S+)/.test(x.change || ''))) {
      lines.push(`// 字段 ${b.field} 已改名为 ${(b.change.match(/renamed to (\S+)/) || [])[1]}`);
    }
    lines.push('```', '');
  }
  if (d.migration_guide && !/^https?:/.test(d.migration_guide)) lines.push('## 补充说明', '', d.migration_guide, '');
  return lines.join('\n');
}

module.exports = {
  LIFECYCLE,
  TRANSITIONS,
  VersionRegistry,
  TransformEngine,
  DeprecationRegistry,
  generateMigrationGuide,
  appendLinkHeader,
  pathPatternToRegex,
  applyOps,
  sanitizeClient,
};
