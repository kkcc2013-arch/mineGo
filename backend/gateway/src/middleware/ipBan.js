/**
 * IP 封禁中间件
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 */

const IpBanManager = require('../../../shared/IpBanManager');
const { logger, metrics } = require('../../../shared/index');

// 全局 IP 封禁管理器实例
let ipBanManager = null;

/**
 * 初始化 IP 封禁管理器
 */
function initIpBanManager(options = {}) {
  ipBanManager = new IpBanManager(options);
  return ipBanManager;
}

/**
 * 获取 IP 封禁管理器实例
 */
function getIpBanManager() {
  return ipBanManager;
}

/**
 * IP 封禁检查中间件
 */
async function ipBanMiddleware(req, res, next) {
  if (!ipBanManager) {
    logger.warn('IpBanManager not initialized');
    return next();
  }

  // 获取客户端 IP
  const ipAddress = getClientIp(req);
  
  try {
    // 检查是否被封禁
    const blockResult = await ipBanManager.isBlocked(ipAddress);
    
    if (blockResult.blocked) {
      // 记录阻断日志
      await ipBanManager.logAccess(
        ipAddress,
        req.user?.id || null,
        req.path,
        req.method,
        403,
        0,
        true,
        blockResult.reason,
        req.get('user-agent')
      );
      
      // 更新指标
      metrics.increment('ip_access_blocked_total', 1, { reason: blockResult.reason });
      
      logger.warn('IP blocked', { 
        ipAddress, 
        reason: blockResult.reason,
        expires: blockResult.expires,
        path: req.path 
      });
      
      return res.status(403).json({
        error: 'IP_BLOCKED',
        code: 'IP_BAN_001',
        message: '您的 IP 已被封禁，如有疑问请联系客服',
        reason: blockResult.reason === 'whitelisted' ? undefined : blockResult.reason
      });
    }
    
    // 检查风险评分
    const riskScore = await ipBanManager.getRiskScore(ipAddress);
    if (riskScore >= 80) {
      req.highRiskIp = true;
      req.ipRiskScore = riskScore;
      logger.info('High risk IP access', { ipAddress, riskScore, path: req.path });
    }
    
    // 设置 IP 信息到请求对象
    req.clientIp = ipAddress;
    req.ipRiskScore = riskScore;
    
    next();
  } catch (error) {
    logger.error('IP ban middleware error', { 
      ipAddress, 
      error: error.message,
      stack: error.stack 
    });
    
    // 出错时放行，避免影响正常访问
    next();
  }
}

/**
 * IP 访问日志中间件（请求结束时记录）
 */
function ipAccessLogMiddleware(req, res, next) {
  if (!ipBanManager) {
    return next();
  }

  const startTime = Date.now();
  const ipAddress = getClientIp(req);
  
  // 响应结束后记录
  res.on('finish', async () => {
    try {
      const responseTime = Date.now() - startTime;
      
      await ipBanManager.logAccess(
        ipAddress,
        req.user?.id || null,
        req.path,
        req.method,
        res.statusCode,
        responseTime,
        false,
        null,
        req.get('user-agent')
      );
      
      // 更新指标
      metrics.increment('ip_access_total', 1, { status: 'allowed' });
    } catch (error) {
      logger.error('Failed to log IP access', { error: error.message });
    }
  });
  
  next();
}

/**
 * 获取客户端真实 IP
 */
function getClientIp(req) {
  // 优先检查代理头
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For 可能包含多个 IP，取第一个
    return forwarded.split(',')[0].trim();
  }
  
  // 其他常见代理头
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }
  
  // 直连 IP
  return req.ip || req.connection?.remoteAddress || '0.0.0.0';
}

/**
 * 记录触发事件中间件工厂
 */
function createTriggerMiddleware(triggerType) {
  return async (req, res, next) => {
    if (!ipBanManager) {
      return next();
    }

    const ipAddress = getClientIp(req);
    
    try {
      const result = await ipBanManager.recordTrigger(ipAddress, triggerType);
      
      if (result.autoBanned) {
        logger.warn('IP auto-banned', { ipAddress, triggerType });
        return res.status(403).json({
          error: 'IP_BLOCKED',
          code: 'IP_BAN_002',
          message: '检测到异常行为，IP 已被临时封禁'
        });
      }
    } catch (error) {
      logger.error('Failed to record trigger', { ipAddress, triggerType, error: error.message });
    }
    
    next();
  };
}

/**
 * 限流触发记录中间件
 */
async function rateLimitTriggerMiddleware(req, res, next) {
  if (!ipBanManager || !req.rateLimitExceeded) {
    return next();
  }

  const ipAddress = getClientIp(req);
  
  try {
    await ipBanManager.recordTrigger(ipAddress, 'rate_limit');
  } catch (error) {
    logger.error('Failed to record rate limit trigger', { ipAddress, error: error.message });
  }
  
  next();
}

/**
 * 高风险 IP 限流中间件
 */
function highRiskRateLimitMiddleware(req, res, next) {
  if (req.highRiskIp) {
    // 高风险 IP 强制添加延迟
    setTimeout(() => {
      next();
    }, 1000);
  } else {
    next();
  }
}

module.exports = {
  initIpBanManager,
  getIpBanManager,
  ipBanMiddleware,
  ipAccessLogMiddleware,
  createTriggerMiddleware,
  rateLimitTriggerMiddleware,
  highRiskRateLimitMiddleware,
  getClientIp
};
