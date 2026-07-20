/**
 * API 签名验证中间件
 * @module SignatureVerificationMiddleware
 */

const { getInstance } = require('../../../shared/requestSignatureService');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

const logger = createLogger('signature-verification-middleware');

/**
 * 签名验证中间件
 */
function signatureVerificationMiddleware(options = {}) {
  const { 
    skipPaths = [], 
    enforce = true,
    skipWhenDisabled = true 
  } = options;

  const signatureService = getInstance();

  return async (req, res, next) => {
    const startTime = Date.now();
    
    // 如果签名验证被禁用且配置允许跳过
    if (skipWhenDisabled && process.env.SIGNATURE_VERIFICATION_ENABLED === 'false') {
      logger.debug('Signature verification disabled');
      return next();
    }
    
    // 跳过不需要验证的路径
    if (skipPaths.some(p => req.path.startsWith(p))) {
      logger.debug('Path skipped from signature verification', { path: req.path });
      return next();
    }
    
    // 检查是否需要签名验证
    if (!signatureService.requiresSignature(req.method, req.path)) {
      logger.debug('Path does not require signature verification', { 
        method: req.method, 
        path: req.path 
      });
      return next();
    }
    
    try {
      const result = await signatureService.verifySignature({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body
      });
      
      const duration = Date.now() - startTime;
      metrics.timing('signature_verification_middleware_duration', duration);
      
      if (!result.valid) {
        logger.warn('Signature verification failed', {
          reason: result.reason,
          path: req.path,
          method: req.method,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          duration
        });
        
        metrics.increment('signature_verification_middleware_failed', 1, { 
          reason: result.reason 
        });
        
        if (enforce) {
          return res.status(401).json({
            error: 'SIGNATURE_VERIFICATION_FAILED',
            message: 'Request signature is invalid or missing',
            code: 'AUTH_010',
            details: {
              reason: result.reason
            }
          });
        } else {
          // 宽松模式：记录失败但继续处理
          req.signatureVerificationFailed = true;
          req.signatureFailureReason = result.reason;
        }
      }
      
      metrics.increment('signature_verification_middleware_passed', 1);
      logger.debug('Signature verification passed', {
        method: req.method,
        path: req.path,
        duration
      });
      
      next();
    } catch (error) {
      logger.error('Signature verification error', {
        error: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method
      });
      
      metrics.increment('signature_verification_middleware_error', 1);
      
      if (enforce) {
        return res.status(500).json({
          error: 'SIGNATURE_VERIFICATION_ERROR',
          message: 'Internal error during signature verification',
          code: 'AUTH_011'
        });
      }
      
      // 宽松模式：出错也继续处理
      req.signatureVerificationError = error.message;
      next();
    }
  };
}

/**
 * 为特定路由添加签名验证
 */
function requireSignature(req, res, next) {
  const signatureService = getInstance();
  
  if (!signatureService.requiresSignature(req.method, req.path)) {
    // 临时添加验证要求
    signatureService.addSensitiveEndpoint(req.method, req.path);
  }
  
  next();
}

/**
 * 创建签名验证失败处理器
 */
function signatureVerificationErrorHandler(err, req, res, next) {
  if (err.name === 'SignatureVerificationError') {
    logger.error('Signature verification error in error handler', {
      error: err.message,
      path: req.path
    });
    
    return res.status(401).json({
      error: 'SIGNATURE_VERIFICATION_FAILED',
      message: err.message,
      code: 'AUTH_010'
    });
  }
  
  next(err);
}

module.exports = {
  signatureVerificationMiddleware,
  requireSignature,
  signatureVerificationErrorHandler
};
