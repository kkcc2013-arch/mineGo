/**
 * REQ-00038: 敏感数据访问日志记录系统
 * 记录所有敏感数据的访问行为，支持完整的数据访问审计链
 */

'use strict';

const { createLogger } = require('./logger');
const encryptedAudit = require('./auditLogEncrypted');
const { fail } = require('./audit/cryptoPrimitives');

const logger = createLogger('sensitive-data-audit');

// ============================================================
// 敏感数据访问规则
// ============================================================

const SENSITIVE_ACCESS_RULES = {
  'user.email': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '用户邮箱',
  },
  'user.phone': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '用户手机号',
  },
  'user.real_name': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '用户真实姓名',
  },
  'user.id_card': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: true,
    description: '用户身份证号',
  },
  'user.address': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '用户地址',
  },
  'user.birthday': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: false,
    mfaRequired: false,
    description: '用户生日',
  },
  'user.location_history': {
    sensitivity: 'P2',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '用户位置历史',
  },
  'payment.*': {
    sensitivity: 'P0',
    logAccess: true,
    requireReason: true,
    mfaRequired: true,
    description: '支付信息',
  },
  'payment.card_number': {
    sensitivity: 'P0',
    logAccess: true,
    requireReason: true,
    mfaRequired: true,
    description: '银行卡号',
  },
  'payment.billing_address': {
    sensitivity: 'P1',
    logAccess: true,
    requireReason: true,
    mfaRequired: false,
    description: '账单地址',
  },
  'pokemon.iv_values': {
    sensitivity: 'P2',
    logAccess: true,
    requireReason: false,
    mfaRequired: false,
    description: '精灵 IV 值',
  },
  'pokemon.shiny_rate': {
    sensitivity: 'P2',
    logAccess: true,
    requireReason: false,
    mfaRequired: false,
    description: '闪光精灵概率',
  },
};

// ============================================================
// 敏感数据访问日志记录
// ============================================================

/**
 * 记录敏感数据访问
 * @param {object} params - 访问参数
 * @param {string} params.userId - 被访问的用户 ID
 * @param {string} params.accessedBy - 访问者 ID
 * @param {string} params.resourceType - 资源类型 (user, payment, pokemon)
 * @param {string} params.resourceId - 资源 ID
 * @param {string[]} params.accessedFields - 访问的字段列表
 * @param {string} params.accessReason - 访问原因
 * @param {string} params.ipAddress - IP 地址
 * @param {string} params.userAgent - User Agent
 * @returns {Promise<string>} 日志 ID
 */
async function logSensitiveDataAccess(params) {
  if (!params || !Array.isArray(params.accessedFields) || !params.accessedFields.length || params.accessedFields.length > 100 || params.accessedFields.some(field => typeof field !== 'string' || !field.length || field.length > 100)) {
    throw fail('AUDIT_INPUT_INVALID', 400);
  }
  const {
    resourceType,
    accessedFields,
  } = params;

  // 检查是否需要记录
  const shouldLog = accessedFields.some(field => {
    const ruleKey = `${resourceType}.${field}`;
    const rule = SENSITIVE_ACCESS_RULES[ruleKey] || SENSITIVE_ACCESS_RULES[`${resourceType}.*`];
    return rule?.logAccess;
  });

  if (!shouldLog) {
    return null;
  }

  // The store commits the complete authenticated envelope with its audit row.
  // Never copy reason, field names, address or agent into plaintext columns/logs.
  return encryptedAudit.writeSensitiveDataAccess(params);
}

/**
 * 查询用户的敏感数据访问记录
 * @param {object} params - 查询参数
 * @param {string} params.userId - 用户 ID
 * @param {string} params.accessedBy - 访问者 ID（可选）
 * @param {Date} params.startDate - 开始日期
 * @param {Date} params.endDate - 结束日期
 * @param {number} limit - 限制数量
 * @returns {Promise<Array>} 访问记录列表
 */
async function querySensitiveDataAccessLogs(params = {}, limit = 100) {
  return encryptedAudit.querySensitiveDataAccessLogs(params, limit);
}

/**
 * 检查敏感数据访问权限
 * @param {object} params - 检查参数
 * @param {string} params.resourceType - 资源类型
 * @param {string} params.field - 字段名
 * @param {string} params.accessedBy - 访问者角色
 * @param {boolean} params.hasMFA - 是否通过 MFA 验证
 * @param {string} params.accessReason - 访问原因
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkSensitiveDataAccess(params) {
  const { resourceType, field, accessedBy, hasMFA, accessReason } = params;

  const ruleKey = `${resourceType}.${field}`;
  const rule = SENSITIVE_ACCESS_RULES[ruleKey] || SENSITIVE_ACCESS_RULES[`${resourceType}.*`];

  if (!rule) {
    return { allowed: true }; // 未定义规则，默认允许
  }

  // 检查 MFA 要求
  if (rule.mfaRequired && !hasMFA) {
    return {
      allowed: false,
      reason: `访问 ${rule.description} 需要二次验证（MFA）`,
    };
  }

  // 检查访问原因
  if (rule.requireReason && !accessReason) {
    return {
      allowed: false,
      reason: `访问 ${rule.description} 需要提供访问原因`,
    };
  }

  return { allowed: true };
}

/**
 * 获取资源的敏感字段列表
 * @param {string} resourceType - 资源类型
 * @returns {string[]} 敏感字段列表
 */
function getSensitiveFields(resourceType) {
  const fields = [];

  for (const [key, rule] of Object.entries(SENSITIVE_ACCESS_RULES)) {
    if (key.startsWith(`${resourceType}.`)) {
      fields.push({
        field: key.split('.')[1],
        sensitivity: rule.sensitivity,
        description: rule.description,
        mfaRequired: rule.mfaRequired,
      });
    }
  }

  return fields;
}

/**
 * 生成敏感数据访问报告
 * @param {object} params - 报告参数
 * @param {string} params.userId - 用户 ID
 * @param {Date} params.startDate - 开始日期
 * @param {Date} params.endDate - 结束日期
 * @returns {Promise<object>} 访问报告
 */
async function generateSensitiveAccessReport(params) {
  const logs = await querySensitiveDataAccessLogs(params, 1000);

  // 统计访问次数
  const stats = {
    totalAccesses: logs.length,
    unavailableAccesses: logs.filter(log => log.error).length,
    byResourceType: {},
    byAccessor: {},
    byField: {},
  };

  logs.forEach(log => {
    // 按资源类型统计
    stats.byResourceType[log.resourceType] = (stats.byResourceType[log.resourceType] || 0) + 1;

    // 按访问者统计
    stats.byAccessor[log.accessedBy] = (stats.byAccessor[log.accessedBy] || 0) + 1;

    // 按字段统计
    (log.accessedFields || []).forEach(field => {
      stats.byField[field] = (stats.byField[field] || 0) + 1;
    });
  });

  return {
    period: {
      start: params.startDate,
      end: params.endDate,
    },
    stats,
    recentAccesses: logs.slice(0, 20), // 最近 20 条记录
  };
}

// ============================================================
// Express 中间件：自动记录敏感数据访问
// ============================================================

/**
 * 敏感数据访问记录中间件
 * @param {object} options - 配置选项
 * @param {string} options.resourceType - 资源类型
 * @param {string[]} options.sensitiveFields - 敏感字段列表
 * @returns {function} Express 中间件
 */
function sensitiveDataAccessMiddleware(options = {}) {
  const { resourceType, sensitiveFields = [] } = options;

  return async (req, res, next) => {
    // 保存原始 res.json 方法
    const originalJson = res.json.bind(res);

    res.json = async function(data) {
      try {
        const accessedBy = req.user?.sub || req.user?.user_id || req.user?.id;
        const userId = req.params?.userId || req.params?.id || req.body?.user_id;
        const accessedFields = sensitiveFields.filter(field => data && (
          Object.hasOwn(data, field) || (data.data && Object.hasOwn(data.data, field))
        ));

        if (accessedFields.length > 0) {
          if (!userId || !accessedBy) throw fail('AUDIT_SUBJECT_INVALID');
          const logId = await logSensitiveDataAccess({
            userId,
            accessedBy,
            resourceType,
            resourceId: userId,
            accessedFields,
            accessReason: req.headers['x-access-reason'] || 'api_request',
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
          });
          if (!logId) throw fail('AUDIT_ACCESS_NOT_RECORDED');
        }
        return originalJson(data);
      } catch {
        logger.error({ code: 'SENSITIVE_ACCESS_AUDIT_UNAVAILABLE' }, 'Sensitive access response withheld');
        res.status(503);
        return originalJson({ error: 'SENSITIVE_ACCESS_AUDIT_UNAVAILABLE' });
      }
    };

    next();
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  logSensitiveDataAccess,
  querySensitiveDataAccessLogs,
  checkSensitiveDataAccess,
  getSensitiveFields,
  generateSensitiveAccessReport,
  sensitiveDataAccessMiddleware,
  SENSITIVE_ACCESS_RULES,
};
