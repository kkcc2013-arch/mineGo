/**
 * 智能限流中间件
 * 集成到 gateway，对每个请求进行限流检查
 */

const rateLimiter = require('../../shared/IntelligentRateLimiter');
const { logger } = require('../../shared/logger');

/**
 * 智能限流中间件
 */
async function intelligentRateLimitMiddleware(req, res, next) {
  // 排除健康检查等接口
  const excludedPaths = ['/health', '/metrics', '/favicon.ico', '/api-docs'];
  if (excludedPaths.some(path => req.path.startsWith(path))) {
    return next();
  }
  
  // 未登录用户使用 IP 限流
  const userId = req.user?.id || `ip:${req.ip}`;
  const endpoint = req.path;
  const method = req.method;
  
  try {
    const result = await rateLimiter.checkLimit(userId, endpoint, method);
    
    // 设置响应头
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);
    res.setHeader('X-Reputation-Level', result.reputationLevel);
    
    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      
      logger.warn('Request rate limited', {
        userId,
        endpoint,
        method,
        current: result.current,
        limit: result.limit,
        reputationLevel: result.reputationLevel,
        ip: req.ip
      });
      
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '请求过于频繁，请稍后再试',
        retryAfter: result.retryAfter,
        reputationLevel: result.reputationLevel
      });
    }
    
    next();
  } catch (error) {
    logger.error('Rate limit check failed', {
      userId,
      endpoint,
      method,
      error: error.message
    });
    
    // 限流检查失败时放行，避免影响正常请求
    next();
  }
}

module.exports = intelligentRateLimitMiddleware;
