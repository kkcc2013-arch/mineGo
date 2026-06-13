const BaseError = require('./BaseError');

/**
 * RateLimitError - 限流错误
 * 用于请求频率超过限制的情况
 */
class RateLimitError extends BaseError {
  constructor(message, details = {}) {
    super(429, message, {
      statusCode: 429,
      details,
      isOperational: true
    });
  }
}

/**
 * 创建全局限流错误
 */
RateLimitError.global = (retryAfter) => {
  return new RateLimitError('Too many requests', {
    reason: 'global_rate_limit',
    retryAfter
  });
};

/**
 * 创建用户限流错误
 */
RateLimitError.userLimit = (userId, limit, windowMs) => {
  return new RateLimitError(`Rate limit exceeded for user ${userId}`, {
    reason: 'user_rate_limit',
    userId,
    limit,
    windowMs,
    retryAfter: Math.ceil(windowMs / 1000)
  });
};

/**
 * 创建 IP 限流错误
 */
RateLimitError.ipLimit = (ip, limit, windowMs) => {
  return new RateLimitError(`Rate limit exceeded for IP ${ip}`, {
    reason: 'ip_rate_limit',
    ip,
    limit,
    windowMs,
    retryAfter: Math.ceil(windowMs / 1000)
  });
};

/**
 * 创建 API 限流错误
 */
RateLimitError.apiLimit = (endpoint, limit, windowMs) => {
  return new RateLimitError(`Rate limit exceeded for endpoint ${endpoint}`, {
    reason: 'api_rate_limit',
    endpoint,
    limit,
    windowMs,
    retryAfter: Math.ceil(windowMs / 1000)
  });
};

/**
 * 创建并发限制错误
 */
RateLimitError.concurrentLimit = (maxConcurrent) => {
  return new RateLimitError(`Concurrent request limit exceeded (max: ${maxConcurrent})`, {
    reason: 'concurrent_limit',
    maxConcurrent
  });
};

module.exports = RateLimitError;
