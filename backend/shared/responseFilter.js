/**
 * REQ-00038: API 响应字段级过滤中间件
 * 根据用户角色动态过滤响应中的敏感字段
 */

'use strict';

const { createLogger } = require('./logger');
const { maskData } = require('./dataMaskingEngine');

const logger = createLogger('response-filter');

// ============================================================
// 敏感度级别定义
// ============================================================

const SENSITIVITY_LEVELS = {
  P0: ['password', 'payment_token', 'card_number', 'cvv', 'card_cvv', 'ssn', 'id_card_number'],
  P1: ['email', 'phone', 'real_name', 'address', 'billing_address', 'shipping_address', 'full_name'],
  P2: ['birthday', 'gender', 'location_history', 'ip_address', 'device_id', 'last_login_ip'],
  P3: ['user_id', 'username', 'avatar', 'nickname', 'display_name'],
};

// 反向映射：字段 -> 敏感度级别
const FIELD_SENSITIVITY = {};
Object.entries(SENSITIVITY_LEVELS).forEach(([level, fields]) => {
  fields.forEach(field => {
    FIELD_SENSITIVITY[field.toLowerCase()] = level;
  });
});

// ============================================================
// 角色权限定义
// ============================================================

const ROLE_PERMISSIONS = {
  'user': { 
    allowedLevels: ['P3'], 
    partialLevels: ['P2'],
    description: '普通用户：只能看到公开和部分脱敏的 P2 数据'
  },
  'premium': { 
    allowedLevels: ['P3', 'P2'], 
    partialLevels: ['P1'],
    description: '高级用户：可以看到 P2 数据，P1 数据部分脱敏'
  },
  'admin': { 
    allowedLevels: ['P3', 'P2', 'P1'], 
    partialLevels: [],
    description: '管理员：可以看到 P1 及以下数据，P0 数据需要特殊权限'
  },
  'system': { 
    allowedLevels: ['P3', 'P2', 'P1', 'P0'], 
    partialLevels: [],
    description: '系统服务：可以访问所有数据'
  },
  'superadmin': { 
    allowedLevels: ['P3', 'P2', 'P1', 'P0'], 
    partialLevels: [],
    description: '超级管理员：可以访问所有数据'
  },
};

// ============================================================
// 字段脱敏规则
// ============================================================

const MASKING_RULES = {
  'P0': { action: 'remove' },           // 完全移除
  'P1': { action: 'mask', type: 'partial' }, // 部分脱敏
  'P2': { action: 'mask', type: 'fuzzy' },   // 模糊化
  'P3': { action: 'keep' },             // 保持原样
};

// ============================================================
// 特殊字段处理规则
// ============================================================

const SPECIAL_FIELD_RULES = {
  // 支付相关字段
  'card_number': { 
    sensitivity: 'P0',
    maskRule: 'keep_last4',
    adminViewable: true,
    requiresMFA: true,
  },
  'cvv': { 
    sensitivity: 'P0',
    maskRule: 'remove',
    adminViewable: false,
  },
  'payment_token': {
    sensitivity: 'P0',
    maskRule: 'remove',
    adminViewable: false,
  },
  
  // 用户信息字段
  'email': { 
    sensitivity: 'P1',
    maskRule: 'keep_prefix',
    visibleChars: 3,
  },
  'phone': { 
    sensitivity: 'P1',
    maskRule: 'keep_suffix',
    visibleChars: 4,
  },
  'real_name': { 
    sensitivity: 'P1',
    maskRule: 'keep_first',
    visibleChars: 1,
  },
  'address': { 
    sensitivity: 'P1',
    maskRule: 'remove_detail',
  },
  
  // 位置相关字段
  'location_history': { 
    sensitivity: 'P2',
    maskRule: 'fuzzy_location',
  },
  'last_location': {
    sensitivity: 'P2',
    maskRule: 'fuzzy_location',
  },
  'ip_address': { 
    sensitivity: 'P2',
    maskRule: 'mask_last_octet',
  },
  
  // 精灵相关字段
  'iv_values': {
    sensitivity: 'P2',
    maskRule: 'partial',
    ownerViewable: true,
  },
  'shiny_rate': {
    sensitivity: 'P2',
    maskRule: 'remove',
    adminViewable: true,
  },
};

// ============================================================
// 敏感数据访问日志记录
// ============================================================

const sensitiveAccessLogBuffer = [];
const FLUSH_INTERVAL = 5000; // 5秒

/**
 * 记录敏感数据访问
 */
async function logSensitiveDataAccess(accessLog) {
  const logEntry = {
    user_id: accessLog.userId,
    accessed_by: accessLog.accessedBy,
    resource_type: accessLog.resourceType,
    resource_id: accessLog.resourceId,
    accessed_fields: accessLog.accessedFields,
    access_reason: accessLog.accessReason || 'api_request',
    ip_address: accessLog.ipAddress,
    timestamp: new Date().toISOString(),
  };
  
  sensitiveAccessLogBuffer.push(logEntry);
  
  // 定期刷新到数据库
  if (sensitiveAccessLogBuffer.length >= 10) {
    await flushSensitiveAccessLogs();
  }
}

/**
 * 刷新敏感数据访问日志到数据库
 */
async function flushSensitiveAccessLogs() {
  if (sensitiveAccessLogBuffer.length === 0) return;
  
  const logs = [...sensitiveAccessLogBuffer];
  sensitiveAccessLogBuffer.length = 0;
  
  try {
    const { query } = require('./db');
    
    // 批量插入
    for (const log of logs) {
      await query(
        `INSERT INTO sensitive_data_access_logs 
         (user_id, accessed_by, resource_type, resource_id, accessed_fields, access_reason, encrypted_ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          log.user_id,
          log.accessed_by,
          log.resource_type,
          log.resource_id,
          log.accessed_fields,
          log.access_reason,
          log.ip_address, // 会在触发器中加密
        ]
      );
    }
    
    logger.debug({ count: logs.length }, 'Flushed sensitive access logs');
  } catch (err) {
    logger.error({ err }, 'Failed to flush sensitive access logs');
    // 失败时重新放回缓冲区
    sensitiveAccessLogBuffer.push(...logs);
  }
}

// 定期刷新
setInterval(flushSensitiveAccessLogs, FLUSH_INTERVAL);

// ============================================================
// 核心过滤函数
// ============================================================

/**
 * 判断字段敏感度级别
 */
function getFieldSensitivity(fieldName) {
  const lowerField = fieldName.toLowerCase();
  
  // 先检查特殊规则
  if (SPECIAL_FIELD_RULES[lowerField]) {
    return SPECIAL_FIELD_RULES[lowerField].sensitivity;
  }
  
  // 再检查通用映射
  return FIELD_SENSITIVITY[lowerField] || 'P3';
}

/**
 * 判断用户是否可以访问该敏感度级别的字段
 */
function canAccessField(userRole, sensitivity, context = {}) {
  const permissions = ROLE_PERMISSIONS[userRole] || ROLE_PERMISSIONS['user'];
  
  // 完全允许
  if (permissions.allowedLevels.includes(sensitivity)) {
    return { canAccess: true, shouldMask: false };
  }
  
  // 部分脱敏
  if (permissions.partialLevels.includes(sensitivity)) {
    return { canAccess: true, shouldMask: true };
  }
  
  // 检查特殊上下文
  if (context.isOwner && SPECIAL_FIELD_RULES[context.field]?.ownerViewable) {
    return { canAccess: true, shouldMask: false };
  }
  
  if (context.hasMFA && SPECIAL_FIELD_RULES[context.field]?.requiresMFA) {
    return { canAccess: true, shouldMask: false };
  }
  
  return { canAccess: false, shouldMask: false };
}

/**
 * 过滤单个字段值
 */
function filterFieldValue(fieldName, value, userRole, context = {}) {
  if (value === null || value === undefined) {
    return value;
  }
  
  const sensitivity = getFieldSensitivity(fieldName);
  const { canAccess, shouldMask } = canAccessField(userRole, sensitivity, {
    ...context,
    field: fieldName.toLowerCase(),
  });
  
  if (!canAccess) {
    return undefined; // 移除该字段
  }
  
  if (shouldMask) {
    return maskData(fieldName.toLowerCase(), value);
  }
  
  return value;
}

/**
 * 递归过滤对象
 */
function filterObject(obj, userRole, context = {}, parentPath = '') {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  // 数组处理
  if (Array.isArray(obj)) {
    return obj.map(item => filterObject(item, userRole, context, parentPath));
  }
  
  const filtered = {};
  const accessedFields = [];
  
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = parentPath ? `${parentPath}.${key}` : key;
    const sensitivity = getFieldSensitivity(key);
    
    // 记录敏感字段访问
    if (['P0', 'P1'].includes(sensitivity)) {
      accessedFields.push(key);
    }
    
    const { canAccess, shouldMask } = canAccessField(userRole, sensitivity, {
      ...context,
      field: key.toLowerCase(),
    });
    
    if (!canAccess) {
      // 跳过该字段
      continue;
    }
    
    if (shouldMask && value !== null && value !== undefined) {
      // 脱敏处理
      filtered[key] = maskData(key.toLowerCase(), value);
    } else if (value && typeof value === 'object') {
      // 递归处理嵌套对象
      filtered[key] = filterObject(value, userRole, context, fieldPath);
    } else {
      filtered[key] = value;
    }
  }
  
  // 记录敏感数据访问日志
  if (accessedFields.length > 0 && context.logSensitiveAccess) {
    logSensitiveDataAccess({
      userId: context.resourceId,
      accessedBy: context.accessedBy,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
      accessedFields,
      accessReason: context.accessReason,
      ipAddress: context.ipAddress,
    }).catch(err => logger.error({ err }, 'Failed to log sensitive access'));
  }
  
  return filtered;
}

// ============================================================
// Express 中间件
// ============================================================

/**
 * 响应过滤中间件
 */
function responseFilterMiddleware(options = {}) {
  const {
    enableAutoFilter = true,
    customRules = {},
    logSensitiveAccess = true,
    excludedPaths = ['/health', '/metrics', '/api/docs'],
  } = options;
  
  return (req, res, next) => {
    // 跳过排除的路径
    if (excludedPaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // 跳过非 GET 请求（只过滤读取响应）
    if (req.method !== 'GET' && !options.filterMutations) {
      return next();
    }
    
    // 获取用户角色
    const userRole = req.user?.role || 'user';
    const accessedBy = req.user?.id;
    
    // 保存原始的 json 方法
    const originalJson = res.json.bind(res);
    
    // 覆盖 json 方法
    res.json = function(data) {
      if (!enableAutoFilter || !data) {
        return originalJson(data);
      }
      
      try {
        const context = {
          accessedBy,
          resourceType: req.resourceType || extractResourceType(req.path),
          resourceId: req.resourceId || extractResourceId(req.path, data),
          logSensitiveAccess,
          accessReason: 'api_request',
          ipAddress: req.ip || req.connection?.remoteAddress,
          isOwner: req.user?.id === extractResourceId(req.path, data),
          hasMFA: req.user?.mfaVerified || false,
        };
        
        // 应用自定义规则
        if (customRules[req.path]) {
          const customFilter = customRules[req.path];
          if (typeof customFilter === 'function') {
            data = customFilter(data, userRole, context);
          }
        }
        
        // 过滤响应数据
        const filteredData = filterObject(data, userRole, context);
        
        return originalJson(filteredData);
      } catch (err) {
        logger.error({ err, path: req.path }, 'Response filter failed');
        // 过滤失败时返回原始数据（降级）
        return originalJson(data);
      }
    };
    
    next();
  };
}

/**
 * 从路径提取资源类型
 */
function extractResourceType(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'api' && parts[1]) {
    return parts[1].replace(/-/g, '_');
  }
  return 'unknown';
}

/**
 * 从路径或数据提取资源 ID
 */
function extractResourceId(path, data) {
  const parts = path.split('/').filter(Boolean);
  
  // 尝试从路径提取
  if (parts.length >= 3 && parts[0] === 'api') {
    const potentialId = parts[2];
    if (/^[0-9a-f-]{36}$/i.test(potentialId) || /^\d+$/.test(potentialId)) {
      return potentialId;
    }
  }
  
  // 从数据提取
  return data?.id || data?.user_id || data?._id;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 获取字段的敏感度级别
 */
function getSensitivityLevel(fieldName) {
  return getFieldSensitivity(fieldName);
}

/**
 * 手动过滤数据（用于非中间件场景）
 */
function filterData(data, userRole, context = {}) {
  return filterObject(data, userRole, { ...context, logSensitiveAccess: false });
}

/**
 * 注册自定义敏感字段
 */
function registerSensitiveField(fieldName, sensitivity, options = {}) {
  const lowerField = fieldName.toLowerCase();
  FIELD_SENSITIVITY[lowerField] = sensitivity;
  
  if (Object.keys(options).length > 0) {
    SPECIAL_FIELD_RULES[lowerField] = {
      sensitivity,
      ...options,
    };
  }
}

/**
 * 获取所有敏感字段定义
 */
function getSensitiveFieldsDefinition() {
  return {
    sensitivityLevels: SENSITIVITY_LEVELS,
    fieldSensitivity: FIELD_SENSITIVITY,
    specialRules: SPECIAL_FIELD_RULES,
    rolePermissions: ROLE_PERMISSIONS,
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  responseFilterMiddleware,
  filterObject,
  filterData,
  filterFieldValue,
  getFieldSensitivity,
  getSensitivityLevel,
  canAccessField,
  registerSensitiveField,
  getSensitiveFieldsDefinition,
  logSensitiveDataAccess,
  SENSITIVITY_LEVELS,
  ROLE_PERMISSIONS,
  SPECIAL_FIELD_RULES,
};
