/**
 * REQ-00016: 审计日志模块
 * 用于记录 GDPR 相关操作和合规审计
 */

const logger = require('./logger');

// 审计操作类型
const AuditActions = {
  // 用户同意
  CONSENT_GIVEN: 'consent_given',
  CONSENT_WITHDRAWN: 'consent_withdrawn',
  // 数据访问
  DATA_EXPORTED: 'data_exported',
  DATA_VIEWED: 'data_viewed',
  // 数据删除
  DELETION_REQUESTED: 'deletion_requested',
  DELETION_STARTED: 'deletion_started',
  DELETION_COMPLETED: 'deletion_completed',
  DELETION_FAILED: 'deletion_failed',
  // 数据修改
  DATA_UPDATED: 'data_updated',
  DATA_DELETED: 'data_deleted',
  // 认证相关
  LOGIN: 'login',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password_changed',
  // 支付相关
  PAYMENT_CREATED: 'payment_created',
  PAYMENT_COMPLETED: 'payment_completed',
  PAYMENT_REFUNDED: 'payment_refunded',
  // 隐私设置
  PRIVACY_SETTINGS_CHANGED: 'privacy_settings_changed',
  PRIVACY_PREFERENCE_CHANGE: 'privacy_preference_change',
  PRIVACY_POLICY_ACCEPT: 'privacy_policy_accept',
  // 数据跨境传输 - REQ-00089
  DATA_REGION_CHANGED: 'data_region_changed',
  TRANSFER_APPROVED: 'transfer_approved',
  TRANSFER_REJECTED: 'transfer_rejected',
  TRANSFER_REQUESTED: 'transfer_requested',
  // 管理操作
  ADMIN_USER_VIEW: 'admin_user_view',
  ADMIN_USER_MODIFY: 'admin_user_modify',
  ADMIN_DATA_ACCESS: 'admin_data_access'
};

/**
 * Persist authenticated audit data. transactionClient must already be inside
 * the caller's transaction; false requires the caller to roll back its action.
 * db accepts a Pool or the shared pool/getClient adapter, never a bare client.
 */
const encryptedAudit = require('./auditLogEncrypted');
const {
  Pool
} = require('pg');
const {
  fail
} = require('./audit/cryptoPrimitives');
function poolFor(db) {
  if (!db) return undefined;
  if (db instanceof Pool) return db;
  if (typeof db.getPool === 'function') {
    const pool = db.getPool();
    if (!(pool instanceof Pool)) throw fail('AUDIT_DATABASE_INVALID');
    return pool;
  }
  if (db.pool instanceof Pool) return db.pool;
  if (typeof db.getClient === 'function' && typeof db.query === 'function') {
    return {
      connect: db.getClient.bind(db),
      query: db.query.bind(db)
    };
  }
  throw fail('AUDIT_DATABASE_INVALID');
}
async function auditLog(options) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) || arguments.length !== 1) throw fail('AUDIT_INPUT_INVALID', 400);
    const {
      userId,
      action,
      details = {},
      req,
      service = 'unknown',
      db,
      transactionClient,
      resourceType,
      resourceId
    } = options;
    if (db && transactionClient) throw fail('AUDIT_DATABASE_INVALID');
    const auditId = await encryptedAudit.useAuditStore({
      pool: poolFor(db),
      transactionClient
    }, store => store.writeEncryptedAuditLog({
      userId,
      action,
      actionData: details,
      resourceType,
      resourceId,
      ipAddress: req?.ip ?? options.ipAddress ?? null,
      userAgent: req?.headers?.['user-agent'] ?? options.userAgent ?? null,
      requestId: req?.id ?? req?.requestId ?? null,
      service
    }));
    // Do not duplicate private payload, identities, addresses, keys or upstream
    // database/KMS error messages in application logs.
    logger.info({
      code: 'AUDIT_WRITE_PERSISTED',
      auditId
    }, 'Audit record persisted');
    return true;
  } catch {
    logger.error({
      code: 'AUDIT_WRITE_FAILED'
    }, 'Audit persistence failed');
    return false;
  }
}

// These query helpers return metadata only. Decrypted content requires the
// separately authenticated role/MFA boundary; ciphertext/legacy plaintext is
// never substituted for a decrypted response.
async function auditMetadata(options, db) {
  const {
    limit = 100,
    userId,
    action,
    service,
    startDate,
    endDate
  } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('AUDIT_LIMIT_INVALID', 400);
  if (service !== undefined) throw fail('AUDIT_FILTER_INVALID', 400); // service is encrypted
  const filters = {};
  if (userId !== undefined) {
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw fail('AUDIT_SUBJECT_INVALID', 400);
    filters.user_id = userId.toLowerCase();
  }
  if (action !== undefined) {
    if (typeof action !== 'string' || !action.length || action.length > 100) throw fail('AUDIT_INPUT_INVALID', 400);
    filters.action = action;
  }
  const args = [],
    where = [];
  for (const [column, value] of Object.entries(filters)) {
    args.push(value);
    where.push(column + '=$' + args.length);
  }
  for (const [value, operator] of [[startDate, '>='], [endDate, '<=']]) if (value !== undefined) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw fail('AUDIT_DATE_INVALID', 400);
    args.push(date.toISOString());
    where.push('timestamp' + operator + '$' + args.length + '::timestamptz');
  }
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) throw fail('AUDIT_DATE_INVALID', 400);
  args.push(limit);
  return encryptedAudit.useAuditStore({
    pool: poolFor(db)
  }, async store => {
    await store.initialize();
    const result = await store.pool.query('SELECT id::text,user_id,action,entity_type,entity_id,created_at,timestamp,(encrypted_data IS NOT NULL AND encryption_key_id IS NOT NULL AND encryption_iv IS NOT NULL AND encryption_auth_tag IS NOT NULL) AS encrypted FROM audit_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC,id DESC LIMIT $' + args.length, args);
    return result.rows.map(row => ({
      ...row,
      detailsUnavailable: true
    }));
  });
}
async function getUserAuditLogs(userId, options = {}, db) {
  if (!userId || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'action', 'startDate', 'endDate'].includes(key))) throw fail('AUDIT_FILTER_INVALID', 400);
  return auditMetadata({
    ...options,
    userId
  }, db);
}
async function getSystemAuditLogs(options = {}, db) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['limit', 'userId', 'action', 'service', 'startDate', 'endDate'].includes(key))) throw fail('AUDIT_FILTER_INVALID', 400);
  return auditMetadata(options, db);
}
function auditMiddleware(action, getDetails = null) {
  return (req, res, next) => {
    const originalEnd = res.end.bind(res);
    let ending = false;
    res.end = function (...args) {
      if (ending) return res;
      ending = true;
      (async () => {
        const userId = req.user?.sub || req.user?.id;
        try {
          return await auditLog({
            userId,
            action,
            details: getDetails ? await getDetails(req, res) : {},
            req,
            service: req.serviceName || 'api',
            db: req.app.locals.db
          });
        } catch {
          return false;
        }
      })().then(ok => {
        if (ok) return originalEnd(...args);
        // Streaming callers must audit before sending any headers/body. Once
        // bytes escaped, terminate instead of claiming a complete audited reply.
        if (res.headersSent) return res.destroy();
        res.statusCode = 503;
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        originalEnd(JSON.stringify({
          error: 'AUDIT_WRITE_FAILED'
        }));
      }).catch(() => res.destroy());
      return res;
    };
    next();
  };
}
module.exports = {
  auditLog,
  getUserAuditLogs,
  getSystemAuditLogs,
  auditMiddleware,
  AuditActions
};
