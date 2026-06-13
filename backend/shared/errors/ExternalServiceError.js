const BaseError = require('./BaseError');

/**
 * ExternalServiceError - 外部服务错误
 * 用于调用外部服务（支付、推送、地图等）失败的情况
 */
class ExternalServiceError extends BaseError {
  constructor(service, message, details = {}) {
    super(503, `External service error (${service}): ${message}`, {
      statusCode: 503,
      details: {
        service,
        ...details
      },
      isOperational: true
    });
  }
}

/**
 * 创建服务不可用错误
 */
ExternalServiceError.serviceUnavailable = (service, reason = '') => {
  const message = reason 
    ? `Service '${service}' is unavailable: ${reason}`
    : `Service '${service}' is unavailable`;
  
  return new ExternalServiceError(service, message, {
    reason: 'service_unavailable'
  });
};

/**
 * 创建超时错误
 */
ExternalServiceError.timeout = (service, timeoutMs) => {
  return new ExternalServiceError(service, `Request timeout after ${timeoutMs}ms`, {
    reason: 'timeout',
    timeoutMs
  });
};

/**
 * 创建响应错误
 */
ExternalServiceError.invalidResponse = (service, statusCode, responseBody) => {
  return new ExternalServiceError(service, `Invalid response (status: ${statusCode})`, {
    reason: 'invalid_response',
    statusCode,
    responseBody: typeof responseBody === 'string' 
      ? responseBody.substring(0, 500) 
      : responseBody
  });
};

/**
 * 创建支付服务错误
 */
ExternalServiceError.payment = (message, details = {}) => {
  return new ExternalServiceError('payment-service', message, {
    reason: 'payment_error',
    ...details
  });
};

/**
 * 创建推送服务错误
 */
ExternalServiceError.pushNotification = (provider, message, details = {}) => {
  return new ExternalServiceError('push-notification', message, {
    provider,
    reason: 'push_error',
    ...details
  });
};

/**
 * 创建地图服务错误
 */
ExternalServiceError.map = (provider, message, details = {}) => {
  return new ExternalServiceError('map-service', message, {
    provider,
    reason: 'map_error',
    ...details
  });
};

module.exports = ExternalServiceError;
