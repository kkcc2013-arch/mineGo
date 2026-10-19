'use strict';

const crypto = require('node:crypto');
const {
  CONFIG,
  AuditCryptoError,
  fail,
  seal,
  open,
  jsonBytes
} = require('./cryptoPrimitives');
const {
  providerFromEnvironment
} = require('./KeyProviders');
const PREFIX = 'audit1:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function user(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !uuid.test(value)) throw fail('AUDIT_SUBJECT_INVALID', 400);
  return value.toLowerCase();
}
function text(value, max, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !value.length || value.length > max) throw fail('AUDIT_INPUT_INVALID', 400);
  return value;
}
function id(value) {
  const valueString = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(valueString) || BigInt(valueString) > 9223372036854775807n || typeof value === 'number' && !Number.isSafeInteger(value)) throw fail('AUDIT_ID_INVALID', 400);
  return valueString;
}
function wrapped(row) {
  if (row.algorithm !== CONFIG.algorithm || !Buffer.isBuffer(row.encrypted_key) || row.encrypted_key.length > 32768) throw fail('AUDIT_KEY_ENVELOPE_INVALID');
  let envelope;
  try {
    envelope = JSON.parse(row.encrypted_key.toString('utf8'));
  } catch {
    throw fail('AUDIT_KEY_ENVELOPE_INVALID');
  }
  if (envelope?.v !== 1 || typeof envelope.masterKeyId !== 'string') throw fail('AUDIT_KEY_ENVELOPE_INVALID');
  return envelope;
}
class EncryptedAuditStore {
  constructor({
    pool,
    provider,
    env = process.env,
    nodeEnv = env.NODE_ENV,
    namespace = env.AUDIT_KEY_NAMESPACE
  } = {}) {
    this.pool = pool || null;
    this.ownsProvider = !provider;
    this.closed = false;
    this.namespaceInput = namespace || '';
    this.namespace = null;
    this.initializing = null;
    if (typeof this.namespaceInput !== 'string' || this.namespaceInput.length > 100 || nodeEnv === 'production' && !this.namespaceInput) throw fail('AUDIT_KEY_CONFIGURATION');
    this.provider = provider || providerFromEnvironment(env);
    if (nodeEnv === 'production' && this.provider.kind !== 'aws-kms') {
      if (this.ownsProvider) this.provider.close();
      throw fail('AUDIT_KEY_CONFIGURATION');
    }
  }
  async initialize() {
    if (this.closed) throw fail('AUDIT_STORE_CLOSED');
    this.pool = this.pool || require('../db').getPool();
    if (this.namespace) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const client = await this.pool.connect();
      try {
        const current = (await client.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0];
        for (const table of ['audit_logs', 'encryption_keys', 'sensitive_data_access_logs']) {
          const relation = (await client.query('SELECT n.nspname AS schema,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', [table])).rows[0];
          if (!relation || relation.schema !== current.schema || !['r', 'p'].includes(relation.relkind)) throw fail('AUDIT_SCHEMA_MISMATCH');
        }
        await client.query('SELECT id,encrypted_data,encryption_key_id,encryption_iv,encryption_auth_tag,entity_type,entity_id,created_at,timestamp FROM audit_logs LIMIT 0');
        await client.query('SELECT id,algorithm,encrypted_key,created_at,expires_at,is_active,rotated_from,key_version,created_by FROM encryption_keys LIMIT 0');
        this.namespace = crypto.createHash('sha256').update(JSON.stringify([this.namespaceInput, current.database, current.schema])).digest('hex');
      } finally {
        client.release();
      }
    })().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }
  async transaction(work) {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  keyContext(keyId) {
    return {
      purpose: 'minego-audit-v1',
      namespace: this.namespace,
      id: keyId
    };
  }
  dataContext(keyId, binding = {}) {
    return {
      v: 1,
      domain: 'minego-audit-data',
      namespace: this.namespace,
      keyId,
      binding
    };
  }
  async unwrap(row) {
    if (!row.id.startsWith(PREFIX)) {
      if (row.algorithm !== CONFIG.algorithm || !this.provider.unwrapLegacy) throw fail('AUDIT_LEGACY_KEY_UNAVAILABLE');
      return this.provider.unwrapLegacy(row.encrypted_key);
    }
    return this.provider.unwrap(wrapped(row), this.keyContext(row.id));
  }
  async active(client, {
    force = false,
    actor = null
  } = {}) {
    // Fast path holds only a shared row lock. Rotation never waits for a reader
    // that is itself waiting for the creation lock.
    if (!force) {
      const candidates = (await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM encryption_keys WHERE id LIKE 'audit1:%' AND is_active=TRUE ORDER BY created_at DESC,id")).rows;
      if (candidates.length > 1) throw fail('AUDIT_ACTIVE_KEY_CONFLICT');
      const row = candidates[0];
      if (row?.valid && wrapped(row).masterKeyId === this.provider.activeKeyId) {
        const locked = (await client.query("SELECT * FROM encryption_keys WHERE id=$1 AND is_active=TRUE AND expires_at>clock_timestamp() FOR SHARE", [row.id])).rows[0];
        if (locked) {
          if (wrapped(locked).masterKeyId !== this.provider.activeKeyId) throw fail('AUDIT_KEY_CHANGED');
          return {
            id: locked.id,
            key: await this.unwrap(locked)
          };
        }
      }
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['minego-audit-key:' + this.namespace]);
    const rows = (await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM encryption_keys WHERE id LIKE 'audit1:%' AND is_active=TRUE ORDER BY created_at DESC,id FOR UPDATE")).rows;
    if (rows.length > 1) throw fail('AUDIT_ACTIVE_KEY_CONFLICT');
    const previous = rows[0];
    if (!force && previous?.valid && wrapped(previous).masterKeyId === this.provider.activeKeyId) return {
      id: previous.id,
      key: await this.unwrap(previous)
    };
    const keyId = PREFIX + crypto.randomUUID();
    const generated = await this.provider.generate(this.keyContext(keyId));
    if (!Buffer.isBuffer(generated.key) || generated.key.length !== 32) {
      if (Buffer.isBuffer(generated.key)) generated.key.fill(0);
      throw fail('AUDIT_KEY_INVALID');
    }
    try {
      const next = Number((await client.query("SELECT COALESCE(max(key_version)::bigint,0)+1 AS version FROM encryption_keys WHERE id LIKE 'audit1:%'")).rows[0].version);
      if (!Number.isSafeInteger(next) || next < 1 || next > 2147483647) throw fail('AUDIT_KEY_VERSION_EXHAUSTED');
      await client.query("UPDATE encryption_keys SET is_active=FALSE WHERE id LIKE 'audit1:%' AND is_active=TRUE");
      await client.query("INSERT INTO encryption_keys(id,algorithm,encrypted_key,created_at,expires_at,is_active,rotated_from,key_version,created_by) VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+INTERVAL '90 days',TRUE,$4,$5,$6)", [keyId, CONFIG.algorithm, Buffer.from(JSON.stringify(generated.wrapped)), previous?.id ?? null, next, user(actor)]);
      return {
        id: keyId,
        key: generated.key
      };
    } catch (error) {
      generated.key.fill(0);
      throw error;
    }
  }
  async encryptAuditLog(data, binding = {}) {
    const bytes = jsonBytes(data);
    try {
      return await this.transaction(async client => {
        const key = await this.active(client);
        try {
          const result = seal(bytes, key.key, this.dataContext(key.id, binding));
          return {
            encryptedData: result.ciphertext,
            iv: result.iv,
            authTag: result.tag,
            keyId: key.id
          };
        } finally {
          key.key.fill(0);
        }
      });
    } finally {
      bytes.fill(0);
    }
  }
  async decryptAuditLog(encryptedData, iv, authTag, keyId, binding = {}) {
    text(keyId, 64);
    await this.initialize();
    const row = (await this.pool.query('SELECT * FROM encryption_keys WHERE id=$1', [keyId])).rows[0];
    if (!row) throw fail('AUDIT_KEY_UNAVAILABLE');
    const key = await this.unwrap(row);
    try {
      const plaintext = open({
        ciphertext: encryptedData,
        iv,
        tag: authTag
      }, key, keyId.startsWith(PREFIX) ? this.dataContext(keyId, binding) : null);
      try {
        return JSON.parse(plaintext.toString('utf8'));
      } catch {
        throw fail('AUDIT_PAYLOAD_INVALID');
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  }
  auditBinding(row) {
    return {
      kind: 'audit',
      id: id(row.id),
      userId: row.user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id
    };
  }
  async writeEncryptedAuditLog(params) {
    const actor = user(params?.userId),
      action = text(params?.action, 100),
      entityType = text(params?.resourceType, 50, true),
      entityId = text(params?.resourceId, 100, true);
    const bytes = jsonBytes({
      actionData: params.actionData ?? params.details ?? {},
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      service: params.service ?? null
    });
    try {
      return await this.transaction(async client => {
        const key = await this.active(client);
        try {
          const row = (await client.query("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,ip_addr,ip_address,user_agent,created_at,timestamp) VALUES($1,$2,$3,$4,NULL,NULL,NULL,NULL,statement_timestamp() AT TIME ZONE 'UTC',statement_timestamp()) RETURNING id::text,user_id,action,entity_type,entity_id,created_at::text", [actor, action, entityType, entityId])).rows[0];
          const encrypted = seal(bytes, key.key, this.dataContext(key.id, this.auditBinding(row)));
          const result = await client.query('UPDATE audit_logs SET encrypted_data=$1,encryption_key_id=$2,encryption_iv=$3,encryption_auth_tag=$4 WHERE id=$5::bigint AND created_at=$6::timestamp', [Buffer.from(encrypted.ciphertext, 'hex'), key.id, encrypted.iv, encrypted.tag, row.id, row.created_at]);
          if (result.rowCount !== 1) throw fail('AUDIT_WRITE_INCOMPLETE');
          return row.id;
        } finally {
          key.key.fill(0);
        }
      });
    } finally {
      bytes.fill(0);
    }
  }
  async decryptRow(row) {
    if (!row.encrypted_data || !row.encryption_key_id || !row.encryption_iv || !row.encryption_auth_tag) throw fail('AUDIT_LEGACY_UNENCRYPTED_OR_INCOMPLETE', 409);
    return this.decryptAuditLog(row.encrypted_data.toString('hex'), row.encryption_iv, row.encryption_auth_tag, row.encryption_key_id, this.auditBinding(row));
  }
  async readEncryptedAuditLog(logId) {
    await this.initialize();
    const row = (await this.pool.query('SELECT * FROM audit_logs WHERE id=$1::bigint', [id(logId)])).rows;
    if (row.length !== 1) throw fail(row.length ? 'AUDIT_ID_CONFLICT' : 'AUDIT_NOT_FOUND', row.length ? 503 : 404);
    return {
      id: id(row[0].id),
      userId: row[0].user_id,
      action: row[0].action,
      resourceType: row[0].entity_type,
      resourceId: row[0].entity_id,
      data: await this.decryptRow(row[0])
    };
  }
  async queryDecryptedAuditLogs(filters = {}, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('AUDIT_LIMIT_INVALID', 400);
    if (!filters || Array.isArray(filters) || typeof filters !== 'object' || Object.keys(filters).some(k => !['userId', 'action', 'startDate', 'endDate'].includes(k))) throw fail('AUDIT_FILTER_INVALID', 400);
    const values = [],
      where = [];
    for (const [key, column, normalize] of [['userId', 'user_id', user], ['action', 'action', v => text(v, 100)]]) if (filters[key] !== undefined) {
      values.push(normalize(filters[key]));
      where.push(column + ' IS NOT DISTINCT FROM $' + values.length);
    }
    for (const [key, operator] of [['startDate', '>='], ['endDate', '<=']]) if (filters[key] !== undefined) {
      const date = new Date(filters[key]);
      if (!Number.isFinite(date.getTime())) throw fail('AUDIT_DATE_INVALID', 400);
      values.push(date.toISOString());
      where.push('timestamp' + operator + '$' + values.length + '::timestamptz');
    }
    if (filters.startDate && filters.endDate && new Date(filters.startDate) > new Date(filters.endDate)) throw fail('AUDIT_DATE_INVALID', 400);
    values.push(limit);
    await this.initialize();
    const rows = (await this.pool.query('SELECT * FROM audit_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC,id DESC LIMIT $' + values.length, values)).rows;
    const results = [];
    for (const row of rows) {
      try {
        results.push({
          id: id(row.id),
          userId: row.user_id,
          action: row.action,
          resourceType: row.entity_type,
          resourceId: row.entity_id,
          data: await this.decryptRow(row)
        });
      } catch (error) {
        if (!(error instanceof AuditCryptoError)) throw error;
        results.push({
          id: id(row.id),
          error: error.code
        });
      }
    }
    return results;
  }
  sensitiveBinding(row) {
    return {
      kind: 'sensitive-access',
      id: row.id,
      userId: row.user_id,
      accessedBy: row.accessed_by,
      resourceType: row.resource_type,
      resourceId: row.resource_id
    };
  }
  async writeSensitiveDataAccess(params) {
    const subject = user(params?.userId),
      accessor = user(params?.accessedBy),
      resource = user(params?.resourceId),
      resourceType = text(params?.resourceType, 50);
    if (!subject || !accessor || !resource || !Array.isArray(params.accessedFields) || !params.accessedFields.length || params.accessedFields.length > 100) throw fail('AUDIT_INPUT_INVALID', 400);
    const accessedFields = [...new Set(params.accessedFields.map(field => text(field, 100)))];
    const bytes = jsonBytes({
      accessedFields,
      accessReason: params.accessReason == null ? null : text(params.accessReason, 4096, true),
      ipAddress: params.ipAddress == null ? null : text(params.ipAddress, 200),
      userAgent: params.userAgent == null ? null : text(params.userAgent, 8192)
    });
    try {
      return await this.transaction(async client => {
        const key = await this.active(client);
        try {
          const row = (await client.query("INSERT INTO sensitive_data_access_logs(user_id,accessed_by,resource_type,resource_id,accessed_fields,access_reason,timestamp,retention_days) VALUES($1,$2,$3,$4,'{}',NULL,statement_timestamp(),90) RETURNING id,user_id,accessed_by,resource_type,resource_id", [subject, accessor, resourceType, resource])).rows[0];
          const cipher = seal(bytes, key.key, this.dataContext(key.id, this.sensitiveBinding(row)));
          const blob = Buffer.from(JSON.stringify({
            v: 1,
            keyId: key.id,
            ...cipher
          }));
          const result = await client.query('UPDATE sensitive_data_access_logs SET encrypted_ip_address=$1,encryption_key_id=$2 WHERE id=$3', [blob, key.id, row.id]);
          if (result.rowCount !== 1) throw fail('AUDIT_WRITE_INCOMPLETE');
          return row.id;
        } finally {
          key.key.fill(0);
        }
      });
    } finally {
      bytes.fill(0);
    }
  }
  async decryptSensitiveRow(row) {
    const blob = row.encrypted_ip_address;
    if (!Buffer.isBuffer(blob) || !blob.length || blob.length > 2100000 || !row.encryption_key_id) throw fail('AUDIT_LEGACY_UNENCRYPTED_OR_INCOMPLETE', 409);
    let envelope;
    try {
      envelope = JSON.parse(blob.toString('utf8'));
    } catch {
      throw fail('AUDIT_LEGACY_UNENCRYPTED_OR_INCOMPLETE', 409);
    }
    if (envelope?.v !== 1 || envelope.keyId !== row.encryption_key_id) throw fail('AUDIT_KEY_ENVELOPE_INVALID');
    return this.decryptAuditLog(envelope.ciphertext, envelope.iv, envelope.tag, envelope.keyId, this.sensitiveBinding(row));
  }
  async querySensitiveDataAccessLogs(filters = {}, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('AUDIT_LIMIT_INVALID', 400);
    if (!filters || Array.isArray(filters) || typeof filters !== 'object' || Object.keys(filters).some(k => !['userId', 'accessedBy', 'startDate', 'endDate'].includes(k))) throw fail('AUDIT_FILTER_INVALID', 400);
    const subject = user(filters.userId);
    if (!subject) throw fail('AUDIT_SUBJECT_INVALID', 400);
    const values = [subject],
      where = ['user_id=$1'];
    if (filters.accessedBy !== undefined) {
      const accessor = user(filters.accessedBy);
      if (!accessor) throw fail('AUDIT_SUBJECT_INVALID', 400);
      values.push(accessor);
      where.push('accessed_by=$' + values.length);
    }
    for (const [key, operator] of [['startDate', '>='], ['endDate', '<=']]) if (filters[key] !== undefined) {
      const date = new Date(filters[key]);
      if (!Number.isFinite(date.getTime())) throw fail('AUDIT_DATE_INVALID', 400);
      values.push(date.toISOString());
      where.push('timestamp' + operator + '$' + values.length + '::timestamptz');
    }
    if (filters.startDate && filters.endDate && new Date(filters.startDate) > new Date(filters.endDate)) throw fail('AUDIT_DATE_INVALID', 400);
    values.push(limit);
    await this.initialize();
    const rows = (await this.pool.query('SELECT * FROM sensitive_data_access_logs WHERE ' + where.join(' AND ') + ' ORDER BY timestamp DESC,id DESC LIMIT $' + values.length, values)).rows;
    const results = [];
    for (const row of rows) {
      const metadata = {
        id: row.id,
        userId: row.user_id,
        accessedBy: row.accessed_by,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        timestamp: row.timestamp,
        retentionDays: row.retention_days
      };
      try {
        const data = await this.decryptSensitiveRow(row);
        results.push({
          ...metadata,
          accessedFields: data.accessedFields,
          accessReason: data.accessReason,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent
        });
      } catch (error) {
        if (!(error instanceof AuditCryptoError)) throw error;
        results.push({
          ...metadata,
          error: error.code
        });
      }
    }
    return results;
  }
  async rotateEncryptionKey({
    actor = null
  } = {}) {
    return this.transaction(async client => {
      const key = await this.active(client, {
        force: true,
        actor
      });
      key.key.fill(0);
      return {
        newKeyId: key.id,
        rotatedAt: new Date()
      };
    });
  }
  async getEncryptionKeyStatus() {
    await this.initialize();
    return (await this.pool.query("SELECT id AS \"keyId\",algorithm,created_at AS \"createdAt\",expires_at AS \"expiresAt\",is_active AS \"isActive\",key_version AS version FROM encryption_keys WHERE id LIKE 'audit1:%' ORDER BY created_at DESC,id")).rows;
  }
  async close() {
    this.closed = true;
    if (this.ownsProvider) await this.provider.close();
  }
}
module.exports = {
  EncryptedAuditStore,
  PREFIX
};
