// backend/shared/middleware/degradationMiddleware.js
'use strict';

const { getDegradationManager, DEGRADATION_LEVELS } = require('../DegradationManager');
const { createLogger } = require('../logger');

const logger = createLogger('degradation-middleware');

/**
 * 创建降级中间件
 * @param {string} serviceName - 服务名称
 * @param {Object} options - 配置选项
 */
function createDegradationMiddleware(serviceName, options = {}) {
  const degradationManager = getDegradationManager(options);
  
  return async (req, res, next) => {
    // 检查请求是否已标记为降级
    if (req.degraded) {
      return next();
    }
    
    const state = degradationManager.getServiceState(serviceName);
    
    // 如果服务正常，直接继续
    if (state.level === DEGRADATION_LEVELS.NORMAL) {
      return next();
    }
    
    // 检查用户等级豁免
    const userTier = req.user?.tier || 'free';
    if (degradationManager.isUserExempt(userTier)) {
      // VIP 用户不受降级影响
      logger.debug({
        service: serviceName,
        userTier,
        userId: req.user?.id
      }, 'User exempt from degradation');
      return next();
    }
    
    // 检查用户降级延迟
    const degradationDelay = degradationManager.getUserDegradationDelay(userTier);
    if (degradationDelay > 0) {
      // 检查是否仍在延迟时间内
      const degradationStart = req.headers['x-degradation-start'];
      if (degradationStart) {
        const startTime = parseInt(degradationStart, 10);
        const elapsed = (Date.now() - startTime) / 1000;
        
        if (elapsed < degradationDelay) {
          logger.debug({
            service: serviceName,
            userTier,
            elapsed,
            delay: degradationDelay
          }, 'User still in degradation delay period');
          return next();
        }
      }
    }
    
    // 获取接口降级配置
    const endpointConfig = degradationManager.getEndpointConfig(req.path);
    
    // 应用降级策略
    if (endpointConfig?.degradation) {
      if (endpointConfig.degradation.disable) {
        // 接口完全禁用
        return res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_DEGRADED',
            message: endpointConfig.degradation.fallbackResponse?.message || '服务暂时降级中',
            degraded: true,
            level: state.level
          }
        });
      }
      
      if (endpointConfig.degradation.cacheOnly) {
        // 仅返回缓存数据
        const cacheKey = endpointConfig.degradation.fallbackData;
        const userId = req.user?.id;
        
        const cachedData = await degradationManager.getFallbackData(cacheKey, userId);
        
        if (cachedData) {
          return res.json({
            success: true,
            data: cachedData,
            degraded: true,
            cached: true,
            level: state.level
          });
        }
        
        // 无缓存数据，继续请求但标记为降级
        req.degraded = true;
        req.degradationLevel = state.level;
        return next();
      }
    }
    
    // 根据降级级别处理
    switch (state.level) {
      case DEGRADATION_LEVELS.LEVEL_1:
        // 轻度降级：尝试缓存，标记请求
        req.degraded = true;
        req.degradationLevel = state.level;
        req.degradationActions = state.actions;
        break;
        
      case DEGRADATION_LEVELS.LEVEL_2:
        // 中度降级：严格限制
        if (req.method !== 'GET') {
          // 非读取请求可能受限
          return res.status(503).json({
            success: false,
            error: {
              code: 'SERVICE_DEGRADED_READ_ONLY',
              message: '服务处于只读模式，请稍后重试',
              degraded: true,
              level: state.level
            }
          });
        }
        req.degraded = true;
        req.degradationLevel = state.level;
        req.degradationActions = state.actions;
        break;
        
      case DEGRADATION_LEVELS.LEVEL_3:
        // 重度降级：返回备用响应
        return res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: '服务暂时不可用，请稍后重试',
            degraded: true,
            level: state.level,
            actions: state.actions
          }
        });
    }
    
    // 设置降级响应头
    res.setHeader('X-Degradation-Level', state.level);
    res.setHeader('X-Degradation-Actions', state.actions.join(','));
    
    next();
  };
}

/**
 * 创建降级响应处理器
 */
function createDegradationResponseHandler(serviceName, options = {}) {
  const degradationManager = getDegradationManager(options);
  
  return (req, res, next) => {
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);
    
    // 重写 json 方法
    res.json = function(data) {
      if (req.degraded) {
        // 添加降级标记到响应
        const response = {
          ...data,
          _meta: {
            ...(data._meta || {}),
            degraded: true,
            level: req.degradationLevel,
            actions: req.degradationActions
          }
        };
        
        return originalJson(response);
      }
      
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * 创建服务级降级装饰器
 */
function withDegradation(serviceName, operationType = 'read') {
  const degradationManager = getDegradationManager();
  
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const state = degradationManager.getServiceState(serviceName);
      
      // 检查是否可以执行
      if (state.level !== DEGRADATION_LEVELS.NORMAL) {
        // 根据操作类型判断是否允许
        if (operationType === 'write' && state.level === DEGRADATION_LEVELS.LEVEL_2) {
          throw new Error('Service is in read-only mode');
        }
        
        if (state.level === DEGRADATION_LEVELS.LEVEL_3) {
          throw new Error('Service is unavailable');
        }
      }
      
      return originalMethod.apply(this, args);
    };
    
    return descriptor;
  };
}

/**
 * 降级降级错误处理器
 */
function degradationErrorHandler(err, req, res, next) {
  if (err.message.includes('Service is in read-only mode')) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_READ_ONLY',
        message: '服务暂时处于只读模式',
        degraded: true
      }
    });
  }
  
  if (err.message.includes('Service is unavailable')) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂时不可用',
        degraded: true
      }
    });
  }
  
  next(err);
}

/**
 * 检查服务是否处于降级状态的工具函数
 */
function isServiceDegraded(serviceName) {
  const manager = getDegradationManager();
  const state = manager.getServiceState(serviceName);
  return state.level !== DEGRADATION_LEVELS.NORMAL;
}

/**
 * 获取当前降级级别
 */
function getDegradationLevel(serviceName) {
  const manager = getDegradationManager();
  return manager.getServiceState(serviceName).level;
}

module.exports = {
  createDegradationMiddleware,
  createDegradationResponseHandler,
  withDegradation,
  degradationErrorHandler,
  isServiceDegraded,
  getDegradationLevel
};