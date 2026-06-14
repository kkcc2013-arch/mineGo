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
 * 记录审计日志
 * @param {object} options - 审计选项
 * @param {number} options.userId - 用户 ID
 * @param {string} options.action - 操作类型
 * @param {object} options.details - 详细信息
 * @param {object} options.req - Express 请求对象（可选）
 * @param {string} options.service - 服务名称
 * @param {object} options.db - 数据库连接
 */
async function auditLog({ userId, action, details = {}, req, service = 'unknown', db }) {
  try {
    const logData = {
      userId,
      action,
      details,
      ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      userAgent: req?.headers?.['user-agent'] || null,
      service
    };
    
    // 写入数据库
    if (db) {
      await db.query(`
        INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent, service)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId,
        action,
        JSON.stringify(details),
        logData.ipAddress,
        logData.userAgent,
        service
      ]);
    }
    
    // 同时写入应用日志
    logger.info(logData, `Audit: ${action}`);
    
    return true;
  } catch (err) {
    logger.error({ err, userId, action }, 'Failed to write audit log');
    // 审计日志失败不应影响主流程
    return false;
  }
}

/**
 * 查询用户审计日志
 * @param {number} userId - 用户 ID
 * @param {object} options - 查询选项
 * @param {number} options.limit - 限制数量
 * @param {string} options.action - 过滤操作类型
 * @param {Date} options.startDate - 开始日期
 * @param {Date} options.endDate - 结束日期
 * @param {object} db - 数据库连接
 */
async function getUserAuditLogs(userId, options = {}, db) {
  const { limit = 100, action, startDate, endDate } = options;
  
  let query = `
    SELECT id, action, details, ip_address, user_agent, service, created_at
    FROM audit_logs
    WHERE user_id = $1
  `;
  const params = [userId];
  let paramIndex = 2;
  
  if (action) {
    query += ` AND action = $${paramIndex}`;
    params.push(action);
    paramIndex++;
  }
  
  if (startDate) {
    query += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }
  
  if (endDate) {
    query += ` AND created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);
  
  const result = await db.query(query, params);
  return result.rows;
}

/**
 * 查询系统审计日志（管理员）
 * @param {object} options - 查询选项
 * @param {object} db - 数据库连接
 */
async function getSystemAuditLogs(options = {}, db) {
  const { limit = 100, action, userId, service, startDate, endDate } = options;
  
  let query = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  let paramIndex = 1;
  
  if (userId) {
    query += ` AND user_id = $${paramIndex}`;
    params.push(userId);
    paramIndex++;
  }
  
  if (action) {
    query += ` AND action = $${paramIndex}`;
    params.push(action);
    paramIndex++;
  }
  
  if (service) {
    query += ` AND service = $${paramIndex}`;
    params.push(service);
    paramIndex++;
  }
  
  if (startDate) {
    query += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }
  
  if (endDate) {
    query += ` AND created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);
  
  const result = await db.query(query, params);
  return result.rows;
}

/**
 * 创建审计中间件
 * @param {string} action - 操作类型
 * @param {function} getDetails - 获取详细信息的函数
 */
function auditMiddleware(action, getDetails = null) {
  return async (req, res, next) => {
    // 保存原始 end 方法
    const originalEnd = res.end;
    
    res.end = async function(...args) {
      // 在响应结束后记录审计日志
      try {
        const userId = req.user?.id;
        if (userId) {
          const details = getDetails ? await getDetails(req, res) : {};
          
          await auditLog({
            userId,
            action,
            details,
            req,
            service: req.serviceName || 'api',
            db: req.app.locals.db
          });
        }
      } catch (err) {
        logger.error({ err }, 'Audit middleware error');
      }
      
      // 调用原始 end
      originalEnd.apply(this, args);
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
