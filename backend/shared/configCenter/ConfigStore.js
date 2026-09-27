// backend/shared/configCenter/ConfigStore.js
// E15 配置中心写入侧（网关管理接口使用）：PostgreSQL 事务内写当前值 + 版本历史 + 审计，提交后经 Redis pub/sub 通知所有实例。
//
//   set / remove / rollback / setCanary / promoteCanary / abortCanary / history / list / diffEnvironments
//   乐观并发：传 expectedVersion 时版本不符返回 409
//   敏感配置：shared/fieldCrypto AES-256-GCM 加密存储（未配置 FIELD_ENCRYPTION_KEYS 时拒绝写入敏感配置）；接口与审计只返回掩码
'use strict';

const {
  isValidKey, isValidService, normalizeEnvironment, deepEqual, maskSecret, ConfigValidationError,
} = require('./schema');

const HISTORY_KEEP = 100;
const CHANNEL_PREFIX = 'cfg:changed:';
const SNAPSHOT_PREFIX = 'cfg:snapshot:';
const INSTANCES_PREFIX = 'cfg:instances:';
const INSTANCE_ALIVE_MS = 60_000;

class ConfigStoreError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_REQUEST', details) {
    super(message);
    this.name = 'ConfigStoreError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

function secretContext(environment, service, key) {
  return `config:${environment}:${service}:${key}`;
}

function parseJsonMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

class ConfigStore {
  /**
   * @param {object} deps
   * @param {{ query: Function, transaction: Function }} deps.db
   * @param {() => object|null} [deps.redis]    返回 ioredis 客户端（可为空：只写库、不通知，由实例轮询兜底）
   * @param {import('./schema').ConfigRegistry} deps.registry
   * @param {{ isEnabled, encrypt, decrypt }} [deps.crypto]  shared/fieldCrypto
   * @param {object} [deps.logger]
   */
  constructor({ db, redis, registry, crypto, logger, environment } = {}) {
    if (!db || !registry) throw new Error('ConfigStore 需要 db 与 registry');
    this.db = db;
    this.redis = typeof redis === 'function' ? redis : () => redis || null;
    this.registry = registry;
    this.crypto = crypto || null;
    this.logger = logger || console;
    this.defaultEnvironment = normalizeEnvironment(environment) || 'development';
  }

  // ── 参数校验 ────────────────────────────────────────────────
  env(environment) {
    if (environment === undefined || environment === null || environment === '') return this.defaultEnvironment;
    const e = normalizeEnvironment(environment);
    if (!e) throw new ConfigStoreError(`非法环境：${environment}（可选 development/test/staging/production）`);
    return e;
  }

  checkTarget(service, key) {
    if (!isValidService(service)) throw new ConfigStoreError(`非法服务名：${service}（'*' 表示全局）`);
    if (!isValidKey(key)) throw new ConfigStoreError(`非法配置键：${key}（小写字母开头，段之间用 . _ - 分隔）`);
  }

  validate(key, value) {
    try {
      return this.registry.assertValid(key, value);
    } catch (err) {
      if (err instanceof ConfigValidationError) throw new ConfigStoreError(err.message, 400, 'VALIDATION_ERROR', { errors: err.errors });
      throw err;
    }
  }

  // ── 敏感值编解码 ─────────────────────────────────────────────
  encode(environment, service, key, value, secret) {
    if (!secret) return value;
    if (!this.crypto || !this.crypto.isEnabled()) {
      throw new ConfigStoreError('未配置 FIELD_ENCRYPTION_KEYS，不能保存敏感配置（密码/密钥/令牌类配置必须加密存储）', 400, 'SECRET_ENCRYPTION_UNAVAILABLE');
    }
    return this.crypto.encrypt(JSON.stringify(value), secretContext(environment, service, key));
  }

  decode(environment, service, key, stored, secret) {
    if (!secret || stored === null || stored === undefined) return stored;
    if (!this.crypto || !this.crypto.isEnabled()) return undefined;
    try { return JSON.parse(this.crypto.decrypt(stored, secretContext(environment, service, key))); } catch { return undefined; }
  }

  present(row, { reveal = false } = {}) {
    if (!row) return null;
    const secret = !!row.is_secret;
    const def = this.registry.get(row.config_key);
    return {
      key: row.config_key,
      service: row.service,
      environment: row.environment,
      value: secret && !reveal ? maskSecret(row.value) : (secret ? this.decode(row.environment, row.service, row.config_key, row.value, true) : row.value),
      description: row.description || (def && def.description) || null,
      isSecret: secret,
      version: row.version,
      canary: row.canary_value !== null && row.canary_value !== undefined
        ? { value: secret ? maskSecret(row.canary_value) : row.canary_value, targets: row.canary_targets }
        : null,
      source: 'db',
      type: def ? def.type : 'json',
      registered: !!def,
      clientVisible: this.registry.isClientVisible(row.config_key),
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at,
    };
  }

  // ── 查询 ───────────────────────────────────────────────────
  async list({ environment, service, prefix, includeDefaults = true } = {}) {
    const envName = this.env(environment);
    const params = [envName];
    let where = 'environment = $1';
    if (service) { params.push(service); where += ` AND service = $${params.length}`; }
    if (prefix) { params.push(`${String(prefix).replace(/[%_\\]/g, '\\$&')}%`); where += ` AND config_key LIKE $${params.length}`; }
    const { rows } = await this.db.query(
      `SELECT environment, service, config_key, value, description, is_secret, version, canary_value, canary_targets, updated_by, updated_at
         FROM config_entries WHERE ${where} ORDER BY config_key, service`, params);
    const items = rows.map((r) => this.present(r));
    if (includeDefaults && (!service || service === '*')) {
      const present = new Set(rows.filter((r) => r.service === '*').map((r) => r.config_key));
      for (const d of this.registry.describe()) {
        if (present.has(d.key)) continue;
        if (prefix && !d.key.startsWith(prefix)) continue;
        items.push({ key: d.key, service: '*', environment: envName, value: d.secret ? maskSecret(d.default) : d.default,
          description: d.description, isSecret: d.secret, version: 0, canary: null, source: 'default', type: d.type,
          registered: true, clientVisible: d.clientVisible, updatedBy: null, updatedAt: null });
      }
      items.sort((a, b) => a.key.localeCompare(b.key) || a.service.localeCompare(b.service));
    }
    return { environment: envName, revision: await this.latestRevision(envName), items };
  }

  async getRow(q, environment, service, key, forUpdate = false) {
    const { rows } = await q(
      `SELECT environment, service, config_key, value, description, is_secret, version, canary_value, canary_targets, updated_by, updated_at
         FROM config_entries WHERE environment = $1 AND service = $2 AND config_key = $3${forUpdate ? ' FOR UPDATE' : ''}`,
      [environment, service, key]);
    return rows[0] || null;
  }

  async get({ environment, service = '*', key, reveal = false }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    const row = await this.getRow((t, p) => this.db.query(t, p), envName, service, key);
    if (row) return this.present(row, { reveal });
    const def = this.registry.get(key);
    if (def && service === '*') {
      return { key, service, environment: envName, value: def.secret ? maskSecret(def.default) : def.default, description: def.description || null,
        isSecret: !!def.secret, version: 0, canary: null, source: 'default', type: def.type, registered: true,
        clientVisible: this.registry.isClientVisible(key), updatedBy: null, updatedAt: null };
    }
    throw new ConfigStoreError(`配置不存在：${service}/${key}`, 404, 'NOT_FOUND');
  }

  async latestRevision(environment) {
    const { rows } = await this.db.query('SELECT COALESCE(MAX(id), 0)::bigint AS rev FROM config_history WHERE environment = $1', [this.env(environment)]);
    return Number(rows[0] ? rows[0].rev : 0);
  }

  async history({ environment, service = '*', key, limit = HISTORY_KEEP }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    const n = Math.min(Math.max(parseInt(limit, 10) || HISTORY_KEEP, 1), HISTORY_KEEP);
    const { rows } = await this.db.query(
      `SELECT id AS revision, version, action, old_value, new_value, canary_value, canary_targets, is_secret, changed_by, change_reason, request_id, created_at
         FROM config_history WHERE environment = $1 AND service = $2 AND config_key = $3 ORDER BY id DESC LIMIT $4`,
      [envName, service, key, n]);
    return rows.map((r) => ({
      revision: Number(r.revision),
      version: r.version,
      action: r.action,
      oldValue: r.is_secret ? maskSecret(r.old_value) : r.old_value,
      newValue: r.is_secret ? maskSecret(r.new_value) : r.new_value,
      canary: r.canary_value !== null && r.canary_value !== undefined ? { value: r.is_secret ? maskSecret(r.canary_value) : r.canary_value, targets: r.canary_targets } : null,
      changedBy: r.changed_by,
      reason: r.change_reason,
      requestId: r.request_id,
      createdAt: r.created_at,
    }));
  }

  /** 审计日志（config_audit_log），可按服务名/键/环境过滤 */
  async audit({ environment, serviceName, key, limit = 100, offset = 0 } = {}) {
    const params = [];
    const where = [];
    if (environment) { params.push(this.env(environment)); where.push(`environment = $${params.length}`); }
    if (serviceName) { params.push(serviceName); where.push(`service_name = $${params.length}`); }
    if (key) { params.push(key); where.push(`config_key = $${params.length}`); }
    params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));
    const { rows } = await this.db.query(
      `SELECT id, environment, service_name, config_key, action, version, old_value, new_value, changed_by, actor_id, reason, request_id, ip, created_at
         FROM config_audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows;
  }

  // ── 写入 ───────────────────────────────────────────────────
  async nextVersion(q, environment, service, key, row) {
    if (row) return row.version + 1;
    const { rows } = await q(
      'SELECT COALESCE(MAX(version), 0) AS v FROM config_history WHERE environment = $1 AND service = $2 AND config_key = $3',
      [environment, service, key]);
    return Number(rows[0] ? rows[0].v : 0) + 1;
  }

  async writeHistory(q, h) {
    const { rows } = await q(
      `INSERT INTO config_history (environment, service, config_key, version, action, old_value, new_value, canary_value, canary_targets, is_secret, changed_by, change_reason, request_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13) RETURNING id`,
      [h.environment, h.service, h.key, h.version, h.action, json(h.oldValue), json(h.newValue), json(h.canaryValue), json(h.canaryTargets),
        !!h.secret, h.actorId || null, h.reason || null, h.requestId || null]);
    // 每个键只保留最近 HISTORY_KEEP 个版本（审计日志永久保留）
    await q(
      `DELETE FROM config_history WHERE environment = $1 AND service = $2 AND config_key = $3
          AND id < (SELECT id FROM config_history WHERE environment = $1 AND service = $2 AND config_key = $3 ORDER BY id DESC OFFSET ${HISTORY_KEEP - 1} LIMIT 1)`,
      [h.environment, h.service, h.key]);
    return Number(rows[0].id);
  }

  async writeAudit(q, a) {
    const mask = (v) => (a.secret && v !== null && v !== undefined ? maskSecret(v) : v);
    await q(
      `INSERT INTO config_audit_log (service_name, config_key, old_value, new_value, changed_by, reason, environment, action, version, actor_id, request_id, ip)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [a.serviceName || a.service, a.key, json(mask(a.oldValue)), json(mask(a.newValue)), String(a.actorId || 'system'), a.reason || null,
        a.environment || null, a.action, a.version || null, isUuid(a.actorId) ? a.actorId : null, a.requestId || null, a.ip || null]);
  }

  /** 供其它模块（实验、限流管理）写审计 */
  async recordAudit(entry) {
    await this.writeAudit((t, p) => this.db.query(t, p), entry);
  }

  /**
   * 创建或更新配置
   * @returns {{ changed, revision, version, entry }}
   */
  async set({ environment, service = '*', key, value, description, isSecret, reason, actorId, expectedVersion, requestId, ip, action }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    if (value === undefined) throw new ConfigStoreError('缺少 value');
    const normalized = this.validate(key, value);
    const secret = isSecret === undefined ? this.registry.isSecret(key) : !!isSecret;
    if (!secret && this.registry.get(key) && this.registry.get(key).secret) throw new ConfigStoreError(`${key} 是敏感配置，不能以明文保存`);
    if (secret && this.registry.isClientVisible(key)) throw new ConfigStoreError(`${key} 客户端可见，不能标记为敏感配置`);
    if (envName === 'production' && !reason) throw new ConfigStoreError('生产环境变更必须填写 reason（变更原因）');

    const result = await this.db.transaction(async (client) => {
      const q = (t, p) => client.query(t, p);
      const row = await this.getRow(q, envName, service, key, true);
      if (expectedVersion !== undefined && expectedVersion !== null) {
        const current = row ? row.version : 0;
        if (Number(expectedVersion) !== current) {
          throw new ConfigStoreError(`版本冲突：当前版本 ${current}，提交基于 ${expectedVersion}`, 409, 'CONFLICT', { currentVersion: current });
        }
      }
      const oldPlain = row ? this.decode(envName, service, key, row.value, row.is_secret) : undefined;
      if (row && !!row.is_secret === secret && oldPlain !== undefined && deepEqual(oldPlain, normalized)
        && (description === undefined || description === row.description)) {
        return { changed: false, revision: null, version: row.version, row };
      }
      const version = await this.nextVersion(q, envName, service, key, row);
      const stored = this.encode(envName, service, key, normalized, secret);
      const { rows } = await q(
        `INSERT INTO config_entries (environment, service, config_key, value, description, is_secret, version, created_by, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8)
         ON CONFLICT (environment, service, config_key) DO UPDATE SET
           value = EXCLUDED.value,
           description = COALESCE(EXCLUDED.description, config_entries.description),
           is_secret = EXCLUDED.is_secret,
           version = EXCLUDED.version,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         RETURNING environment, service, config_key, value, description, is_secret, version, canary_value, canary_targets, updated_by, updated_at`,
        [envName, service, key, json(stored), description === undefined ? null : description, secret, version, isUuid(actorId) ? actorId : null]);
      const act = action || (row ? 'update' : 'create');
      const revision = await this.writeHistory(q, { environment: envName, service, key, version, action: act,
        oldValue: row ? row.value : null, newValue: stored, secret, actorId: isUuid(actorId) ? actorId : null, reason, requestId });
      await this.writeAudit(q, { environment: envName, service, key, version, action: `config.${act}`,
        oldValue: row ? oldPlain : null, newValue: normalized, secret, actorId, reason, requestId, ip });
      return { changed: true, revision, version, row: rows[0] };
    });
    if (result.changed) await this.afterWrite(envName, service, key, result.revision, action || 'set', result.row);
    return { changed: result.changed, revision: result.revision, version: result.version, entry: this.present(result.row) };
  }

  async remove({ environment, service = '*', key, reason, actorId, requestId, ip }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    if (envName === 'production' && !reason) throw new ConfigStoreError('生产环境变更必须填写 reason（变更原因）');
    const result = await this.db.transaction(async (client) => {
      const q = (t, p) => client.query(t, p);
      const row = await this.getRow(q, envName, service, key, true);
      if (!row) throw new ConfigStoreError(`配置不存在：${service}/${key}`, 404, 'NOT_FOUND');
      await q('DELETE FROM config_entries WHERE environment = $1 AND service = $2 AND config_key = $3', [envName, service, key]);
      const version = row.version + 1;
      const revision = await this.writeHistory(q, { environment: envName, service, key, version, action: 'delete',
        oldValue: row.value, newValue: null, secret: row.is_secret, actorId: isUuid(actorId) ? actorId : null, reason, requestId });
      await this.writeAudit(q, { environment: envName, service, key, version, action: 'config.delete',
        oldValue: this.decode(envName, service, key, row.value, row.is_secret), newValue: null, secret: row.is_secret, actorId, reason, requestId, ip });
      return { revision, version };
    });
    await this.afterWrite(envName, service, key, result.revision, 'delete', null);
    return { changed: true, revision: result.revision, version: result.version };
  }

  /** 回滚到历史版本（version 对应的 new_value）；目标版本是删除操作时回滚即删除 */
  async rollback({ environment, service = '*', key, version, reason, actorId, requestId, ip }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    const v = parseInt(version, 10);
    if (!Number.isInteger(v) || v < 1) throw new ConfigStoreError('version 必须是正整数');
    const { rows } = await this.db.query(
      `SELECT version, action, new_value, is_secret FROM config_history
        WHERE environment = $1 AND service = $2 AND config_key = $3 AND version = $4 ORDER BY id DESC LIMIT 1`,
      [envName, service, key, v]);
    const h = rows[0];
    if (!h) throw new ConfigStoreError(`历史版本不存在或已超出保留范围（最近 ${HISTORY_KEEP} 版）：${key}@${v}`, 404, 'NOT_FOUND');
    const why = reason || `rollback to version ${v}`;
    if (h.action === 'delete' || h.new_value === null) {
      return this.remove({ environment: envName, service, key, reason: why, actorId, requestId, ip });
    }
    const value = this.decode(envName, service, key, h.new_value, h.is_secret);
    if (value === undefined) throw new ConfigStoreError('无法解密历史版本（加密密钥不可用）', 409, 'CONFLICT');
    return this.set({ environment: envName, service, key, value, isSecret: h.is_secret, reason: why, actorId, requestId, ip, action: 'rollback' });
  }

  // ── 灰度发布 ─────────────────────────────────────────────────
  normalizeTargets(targets) {
    const out = {};
    for (const k of ['instances', 'groups', 'services']) {
      const list = targets && targets[k];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 100 || list.some((x) => typeof x !== 'string' || !x || x.length > 128)) {
        throw new ConfigStoreError(`targets.${k} 应为字符串数组（≤100 项）`);
      }
      if (list.length) out[k] = [...new Set(list)];
    }
    if (!Object.keys(out).length) throw new ConfigStoreError('灰度目标不能为空：targets.instances / groups / services 至少一项');
    return out;
  }

  async canaryOp({ environment, service = '*', key, op, canaryValue, targets, reason, actorId, requestId, ip }) {
    const envName = this.env(environment);
    this.checkTarget(service, key);
    if (envName === 'production' && !reason) throw new ConfigStoreError('生产环境变更必须填写 reason（变更原因）');
    const normalizedTargets = op === 'canary_set' ? this.normalizeTargets(targets) : null;
    const normalizedValue = op === 'canary_set' ? this.validate(key, canaryValue) : undefined;
    const result = await this.db.transaction(async (client) => {
      const q = (t, p) => client.query(t, p);
      let row = await this.getRow(q, envName, service, key, true);
      if (!row) {
        if (op !== 'canary_set') throw new ConfigStoreError(`配置不存在：${service}/${key}`, 404, 'NOT_FOUND');
        const def = this.registry.get(key);
        if (!def || def.default === undefined) throw new ConfigStoreError('灰度发布前请先发布基础值（该键没有默认值）');
        const secret0 = this.registry.isSecret(key);
        const base = this.encode(envName, service, key, def.default, secret0);
        const ins = await q(
          `INSERT INTO config_entries (environment, service, config_key, value, is_secret, version, created_by, updated_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)
           RETURNING environment, service, config_key, value, description, is_secret, version, canary_value, canary_targets, updated_by, updated_at`,
          [envName, service, key, json(base), secret0, await this.nextVersion(q, envName, service, key, null) - 1 || 1, isUuid(actorId) ? actorId : null]);
        row = ins.rows[0];
      }
      const secret = !!row.is_secret;
      let sql; let params; let newValue = row.value; let canaryValueStored = null; let canaryTargets = null;
      if (op === 'canary_set') {
        canaryValueStored = this.encode(envName, service, key, normalizedValue, secret);
        canaryTargets = normalizedTargets;
        sql = 'UPDATE config_entries SET canary_value = $4::jsonb, canary_targets = $5::jsonb, version = version + 1, updated_by = $6, updated_at = NOW()';
        params = [json(canaryValueStored), json(canaryTargets), isUuid(actorId) ? actorId : null];
      } else if (op === 'canary_promote') {
        if (row.canary_value === null || row.canary_value === undefined) throw new ConfigStoreError('当前没有进行中的灰度', 409, 'CONFLICT');
        newValue = row.canary_value;
        sql = 'UPDATE config_entries SET value = canary_value, canary_value = NULL, canary_targets = NULL, version = version + 1, updated_by = $4, updated_at = NOW()';
        params = [isUuid(actorId) ? actorId : null];
      } else {
        if (row.canary_value === null || row.canary_value === undefined) throw new ConfigStoreError('当前没有进行中的灰度', 409, 'CONFLICT');
        sql = 'UPDATE config_entries SET canary_value = NULL, canary_targets = NULL, version = version + 1, updated_by = $4, updated_at = NOW()';
        params = [isUuid(actorId) ? actorId : null];
      }
      const { rows } = await q(`${sql} WHERE environment = $1 AND service = $2 AND config_key = $3
        RETURNING environment, service, config_key, value, description, is_secret, version, canary_value, canary_targets, updated_by, updated_at`,
      [envName, service, key, ...params]);
      const updated = rows[0];
      const revision = await this.writeHistory(q, { environment: envName, service, key, version: updated.version, action: op,
        oldValue: row.value, newValue, canaryValue: canaryValueStored, canaryTargets, secret, actorId: isUuid(actorId) ? actorId : null, reason, requestId });
      await this.writeAudit(q, { environment: envName, service, key, version: updated.version, action: `config.${op}`,
        oldValue: op === 'canary_set' ? null : this.decode(envName, service, key, row.canary_value, secret),
        newValue: op === 'canary_set' ? { value: normalizedValue, targets: normalizedTargets } : this.decode(envName, service, key, newValue, secret),
        secret, actorId, reason, requestId, ip });
      return { revision, row: updated };
    });
    await this.afterWrite(envName, service, key, result.revision, op, result.row);
    return { changed: true, revision: result.revision, version: result.row.version, entry: this.present(result.row) };
  }

  setCanary(args) { return this.canaryOp({ ...args, op: 'canary_set' }); }
  promoteCanary(args) { return this.canaryOp({ ...args, op: 'canary_promote' }); }
  abortCanary(args) { return this.canaryOp({ ...args, op: 'canary_abort' }); }

  // ── 通知与 Redis 快照 ─────────────────────────────────────────
  async afterWrite(environment, service, key, revision, action, row) {
    const redis = this.redis();
    if (!redis) return;
    try {
      const field = `${service}|${key}`;
      const multi = redis.multi();
      if (row) {
        multi.hset(`${SNAPSHOT_PREFIX}${environment}`, field, JSON.stringify({
          value: row.value, canary_value: row.canary_value, canary_targets: row.canary_targets, version: row.version, is_secret: row.is_secret,
        }));
      } else {
        multi.hdel(`${SNAPSHOT_PREFIX}${environment}`, field);
      }
      multi.set(`${SNAPSHOT_PREFIX}${environment}:revision`, String(revision));
      multi.publish(`${CHANNEL_PREFIX}${environment}`, JSON.stringify({ type: 'config', revision, service, key, action, at: Date.now() }));
      await multi.exec();
    } catch (err) {
      // 通知失败不影响写入：各实例按 config_history 修订号轮询兜底（默认 10 秒）
      this.logger.warn({ err: err.message, key, revision }, 'config change notify failed; instances will catch up by polling');
    }
  }

  /** 发布非配置类通知（如实验变更），复用同一频道 */
  async notify(environment, message) {
    const redis = this.redis();
    if (!redis) return false;
    try {
      await redis.publish(`${CHANNEL_PREFIX}${this.env(environment)}`, JSON.stringify({ ...message, at: Date.now() }));
      return true;
    } catch { return false; }
  }

  /** 用数据库全量重建 Redis 快照（网关启动时与管理接口调用） */
  async rebuildSnapshot(environment) {
    const envName = this.env(environment);
    const redis = this.redis();
    if (!redis) return { ok: false, reason: 'redis unavailable' };
    const { rows } = await this.db.query(
      'SELECT service, config_key, value, canary_value, canary_targets, version, is_secret FROM config_entries WHERE environment = $1', [envName]);
    const revision = await this.latestRevision(envName);
    const key = `${SNAPSHOT_PREFIX}${envName}`;
    const multi = redis.multi();
    multi.del(key);
    for (const r of rows) {
      multi.hset(key, `${r.service}|${r.config_key}`, JSON.stringify({
        value: r.value, canary_value: r.canary_value, canary_targets: r.canary_targets, version: r.version, is_secret: r.is_secret,
      }));
    }
    multi.set(`${key}:revision`, String(revision));
    await multi.exec();
    return { ok: true, entries: rows.length, revision };
  }

  /** 各实例同步状态（ConfigClient 每次加载后上报） */
  async instances(environment) {
    const envName = this.env(environment);
    const latest = await this.latestRevision(envName);
    const redis = this.redis();
    let raw = {};
    if (redis) {
      try { raw = (await redis.hgetall(`${INSTANCES_PREFIX}${envName}`)) || {}; } catch { raw = {}; }
    }
    const now = Date.now();
    const list = Object.entries(raw).map(([id, v]) => {
      const s = parseJsonMaybe(v) || {};
      const alive = now - (s.updatedAt || 0) < INSTANCE_ALIVE_MS;
      return { instanceId: id, ...s, alive, inSync: Number(s.revision || 0) >= latest, lagRevisions: Math.max(0, latest - Number(s.revision || 0)) };
    }).sort((a, b) => String(a.service).localeCompare(String(b.service)) || a.instanceId.localeCompare(b.instanceId));
    return { environment: envName, latestRevision: latest, instances: list,
      alive: list.filter((i) => i.alive).length, inSync: list.filter((i) => i.alive && i.inSync).length };
  }

  /** 环境间配置对比（发现配置漂移；敏感值只比较是否存在） */
  async diffEnvironments({ from, to, service }) {
    const a = this.env(from);
    const b = this.env(to);
    const params = [a, b];
    let where = 'environment IN ($1, $2)';
    if (service) { params.push(service); where += ' AND service = $3'; }
    const { rows } = await this.db.query(
      `SELECT environment, service, config_key, value, is_secret, version FROM config_entries WHERE ${where}`, params);
    const map = new Map();
    for (const r of rows) {
      const id = `${r.service}|${r.config_key}`;
      if (!map.has(id)) map.set(id, { service: r.service, key: r.config_key });
      map.get(id)[r.environment === a ? 'from' : 'to'] = r;
    }
    const diffs = [];
    for (const d of map.values()) {
      const fa = d.from; const fb = d.to;
      const secret = (fa && fa.is_secret) || (fb && fb.is_secret);
      const same = fa && fb && (secret ? true : deepEqual(fa.value, fb.value));
      if (same) continue;
      diffs.push({ service: d.service, key: d.key, secret: !!secret,
        from: fa ? (secret ? maskSecret(fa.value) : fa.value) : null,
        to: fb ? (secret ? maskSecret(fb.value) : fb.value) : null,
        status: !fa ? 'only_in_to' : !fb ? 'only_in_from' : 'different' });
    }
    return { from: a, to: b, differences: diffs.sort((x, y) => x.key.localeCompare(y.key)) };
  }
}

function json(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

module.exports = {
  ConfigStore,
  ConfigStoreError,
  secretContext,
  CHANNEL_PREFIX,
  SNAPSHOT_PREFIX,
  INSTANCES_PREFIX,
  HISTORY_KEEP,
};
