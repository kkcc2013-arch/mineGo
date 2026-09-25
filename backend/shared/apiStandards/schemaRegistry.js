/**
 * REQ-00315 / REQ-00547: Schema Registry（契约注册中心）
 *
 * - 从 schemas/*.json 加载契约：{ id, method, route, status?, auth?, requestSchema?, schema }
 *   文件内 "#/definitions/x" 指向本文件，"common#/definitions/x" 指向其他文件（按 $id 注册）
 * - match(method, path, status)：精确路由优先，其次 "*" 通配契约（如所有错误响应）
 * - validate()：零依赖校验器；记录耗时
 * - 版本化：每个契约的规范化 JSON 取 sha256，写入 api_schema_registry（hash 变化 → version+1），
 *   可查询历史并对任意两个版本做兼容性对比
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Validator } = require('./jsonSchema');
const { pathPatternToRegex } = require('./versioning');

const DEFAULT_DIR = path.join(__dirname, 'schemas');

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function hashOf(v) {
  return crypto.createHash('sha256').update(canonical(v)).digest('hex');
}

/** 把文件内部的 #/definitions/x 改写为 <fileId>#/definitions/x，便于跨文件解析 */
function qualifyRefs(node, fileId) {
  if (Array.isArray(node)) return node.map((n) => qualifyRefs(n, fileId));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) out[k] = `${fileId}${v}`;
    else out[k] = qualifyRefs(v, fileId);
  }
  return out;
}

function statusMatches(spec, status) {
  if (spec === undefined || spec === null) return status >= 200 && status < 300;
  const parts = String(spec).split('|');
  return parts.some((p) => {
    p = p.trim();
    if (/^\dxx$/i.test(p)) return Math.floor(status / 100) === Number(p[0]);
    return Number(p) === status;
  });
}

class SchemaRegistry {
  constructor({ dir = DEFAULT_DIR, query = null, logger = null } = {}) {
    this.dir = dir;
    this.query = query;
    this.logger = logger;
    this.files = new Map();     // $id -> { definitions, ... }
    this.contracts = new Map(); // id -> contract
    this.validator = new Validator({ resolveExternal: (name) => this.files.get(name) || null });
    this.versions = new Map();  // id -> { version, hash }
  }

  loadFromDir(dir = this.dir) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      this.addFile(raw, f);
    }
    return this;
  }

  addFile(raw, source = 'inline') {
    const fileId = raw.$id || path.basename(source, '.json');
    const q = qualifyRefs({ definitions: raw.definitions || {} }, fileId);
    this.files.set(fileId, { ...raw, definitions: q.definitions });
    for (const c of raw.contracts || []) {
      this.register({
        ...c,
        service: c.service || raw.service || fileId,
        schema: qualifyRefs(c.schema, fileId),
        requestSchema: c.requestSchema ? qualifyRefs(c.requestSchema, fileId) : undefined,
        source,
      });
    }
  }

  register(contract) {
    const c = { ...contract, method: String(contract.method || 'GET').toUpperCase() };
    c.re = c.route === '*' ? /.*/ : pathPatternToRegex(c.route);
    c.hash = hashOf({ method: c.method, route: c.route, schema: c.schema, requestSchema: c.requestSchema || null });
    this.contracts.set(c.id, c);
    return c;
  }

  get(id) { return this.contracts.get(id) || null; }

  list() {
    return [...this.contracts.values()].map((c) => ({
      id: c.id, method: c.method, route: c.route, service: c.service, status: c.status || '2xx', auth: c.auth || null,
      description: c.description || '', hash: c.hash.slice(0, 12), version: (this.versions.get(c.id) || {}).version || null,
    }));
  }

  /** 匹配契约：先精确路由，再通配 */
  match(method, reqPath, status) {
    const m = String(method).toUpperCase();
    let wildcard = null;
    for (const c of this.contracts.values()) {
      if (!statusMatches(c.status, status)) continue;
      if (c.method !== '*' && c.method !== m) continue;
      if (c.route === '*') { wildcard = wildcard || c; continue; }
      if (c.re.test(reqPath)) return c;
    }
    return wildcard;
  }

  validate(contractOrId, body) {
    const c = typeof contractOrId === 'string' ? this.get(contractOrId) : contractOrId;
    if (!c) return { valid: true, errors: [], skipped: true };
    const t0 = process.hrtime.bigint();
    const r = this.validator.validate(c.schema, body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ...r, contract: c.id, durationMs: +ms.toFixed(3) };
  }

  validateRequest(contractOrId, body) {
    const c = typeof contractOrId === 'string' ? this.get(contractOrId) : contractOrId;
    if (!c || !c.requestSchema) return { valid: true, errors: [], skipped: true };
    return this.validator.validate(c.requestSchema, body);
  }

  resolver() {
    return (ref) => {
      const [name, frag] = ref.split('#');
      const file = this.files.get(name);
      if (!file || !frag) return file || null;
      return frag.slice(1).split('/').reduce((n, k) => (n ? n[k] : undefined), file) || null;
    };
  }

  /** 契约快照（用于破坏性变更检测与 TS/OpenAPI 生成） */
  snapshot() {
    const out = {};
    for (const c of [...this.contracts.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      out[c.id] = { method: c.method, route: c.route, auth: c.auth || null, status: c.status || null, service: c.service, schema: c.schema, ...(c.requestSchema ? { requestSchema: c.requestSchema } : {}), hash: c.hash };
    }
    return { definitions: Object.fromEntries([...this.files.entries()].map(([k, f]) => [k, f.definitions])), contracts: out };
  }

  /** 把契约版本写入数据库（hash 变化时生成新版本） */
  async syncVersions() {
    if (!this.query) return { synced: 0 };
    let created = 0;
    for (const c of this.contracts.values()) {
      try {
        const { rows } = await this.query(
          'SELECT version, hash FROM api_schema_registry WHERE contract_id = $1 ORDER BY version DESC LIMIT 1', [c.id]);
        if (rows[0] && rows[0].hash === c.hash) { this.versions.set(c.id, { version: rows[0].version, hash: c.hash }); continue; }
        const version = rows[0] ? rows[0].version + 1 : 1;
        await this.query(
          `INSERT INTO api_schema_registry (contract_id, version, hash, service, method, route, schema, request_schema, definitions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (contract_id, hash) DO NOTHING`,
          [c.id, version, c.hash, c.service || null, c.method, c.route, JSON.stringify(c.schema), c.requestSchema ? JSON.stringify(c.requestSchema) : null,
            JSON.stringify(Object.fromEntries([...this.files.entries()].map(([k, f]) => [k, f.definitions])))]);
        this.versions.set(c.id, { version, hash: c.hash });
        created++;
      } catch (err) {
        if (this.logger) this.logger.debug({ err: err.message, contract: c.id }, 'schema registry sync failed');
      }
    }
    return { synced: this.contracts.size, created };
  }

  async history(contractId) {
    if (!this.query) return [];
    const { rows } = await this.query(
      'SELECT contract_id, version, hash, method, route, created_at FROM api_schema_registry WHERE contract_id = $1 ORDER BY version DESC', [contractId]);
    return rows;
  }

  async getVersion(contractId, version) {
    if (!this.query) return null;
    const { rows } = await this.query('SELECT * FROM api_schema_registry WHERE contract_id = $1 AND version = $2', [contractId, version]);
    return rows[0] || null;
  }
}

let defaultRegistry = null;
function getSchemaRegistry(opts) {
  if (!defaultRegistry) defaultRegistry = new SchemaRegistry(opts).loadFromDir();
  return defaultRegistry;
}

module.exports = { SchemaRegistry, getSchemaRegistry, hashOf, canonical, qualifyRefs, statusMatches, DEFAULT_DIR };
