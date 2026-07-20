// backend/gateway/src/middleware/consistencyMiddleware.js
'use strict';

const { getReadWriteSplitManager } = require('../../shared/dbReadWriteSplit/ReadWriteSplitManager');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('consistency-middleware');

/**
 * 强一致性中间件
 * 根据 Header 或路径决定是否使用强一致性读取
 */
function consistencyMiddleware(options = {}) {
  const manager = getReadWriteSplitManager();
  
  const config = {
    header: options.header || 'x-consistency-level',
    strongConsistencyPaths: options.strongConsistencyPaths || [
      '/api/payment',
      '/api/users/balance',
      '/api/trade',
      '/api/gym/battle',
      '/api/catch/rare'
    ],
    
    // 强一致性查询参数
    strongConsistencyParams: options.strongConsistencyParams || ['force_master', 'strong']
  };
  
  return async (req, res, next) => {
    // 检查是否需要强一致性
    const needsStrongConsistency = checkStrongConsistency(req, config);
    
    if (needsStrongConsistency) {
      // 设置强一致性标志
      req.consistencyLevel = 'strong';
      
      logger.debug({
        path: req.path,
        method: req.method,
        consistency: 'strong'
      }, 'Strong consistency enabled');
      
      // 健康检查：验证主库可用
      try {
        const health = manager.getHealthSummary();
        
        if (!health.primary.healthy) {
          logger.error('Primary database unhealthy');
          return res.status(503).json({
            code: 5030,
            message: 'Service temporarily unavailable',
            detail: 'Primary database unavailable'
          });
        }
        
      } catch (err) {
        logger.error({ err }, 'Failed to check primary health');
        return res.status(503).json({
          code: 5030,
          message: 'Service temporarily unavailable'
        });
      }
      
    } else {
      req.consistencyLevel = 'eventual';
    }
    
    // 添加切换一致性的方法
    req.setConsistencyLevel = (level) => {
      req.consistencyLevel = level;
      logger.debug({ level }, 'Consistency level changed');
    };
    
    next();
  };
}

/**
 * 检查是否需要强一致性
 */
function checkStrongConsistency(req, config) {
  // 1. 显式指定 Header
  const headerValue = req.get(config.header);
  if (headerValue === 'strong' || headerValue === 'master') {
    return true;
  }
  
  // 2. 查询参数
  if (config.strongConsistencyParams.some(param => req.query[param] === 'true')) {
    return true;
  }
  
  // 3. 路径匹配
  if (config.strongConsistencyPaths.some(path => req.path.startsWith(path))) {
    return true;
  }
  
  // 4. 写操作（POST/PUT/DELETE/PATCH）
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return true;
  }
  
  return false;
}

/**
 * 副本延迟检查中间件
 * 如果副本延迟过高，自动切换到主库
 */
function replicaLagMiddleware(options = {}) {
  const manager = getReadWriteSplitManager();
  
  const config = {
    maxLagMs: options.maxLagMs || 2000,
    fallbackToPrimary: options.fallbackToPrimary !== false
  };
  
  return async (req, res, next) => {
    // 如果已经是强一致性，跳过检查
    if (req.consistencyLevel === 'strong') {
      return next();
    }
    
    try {
      const health = manager.getHealthSummary();
      
      // 检查是否有健康的副本
      const healthyReplicas = health.replicas.filter(r => 
        r.healthy && r.lag < config.maxLagMs
      );
      
      if (healthyReplicas.length === 0) {
        logger.warn({
          path: req.path,
          reason: 'no_healthy_replica'
        }, 'No healthy replica available, switching to primary');
        
        if (config.fallbackToPrimary) {
          req.consistencyLevel = 'strong';
          req.replicaFallback = true;
        }
      }
      
      // 添加延迟信息到响应头（调试用）
      if (process.env.NODE_ENV !== 'production') {
        const lagInfo = health.replicas.map(r => 
          `${r.id}:${r.lag}ms`
        ).join(',');
        
        res.set('X-Replica-Lag', lagInfo);
      }
      
      next();
      
    } catch (err) {
      logger.error({ err }, 'Replica lag check failed');
      
      // 出错时降级到主库
      if (config.fallbackToPrimary) {
        req.consistencyLevel = 'strong';
        req.replicaFallback = true;
      }
      
      next();
    }
  };
}

/**
 * 数据库路由中间件
 * 为请求附加数据库查询方法
 */
function databaseRouterMiddleware(options = {}) {
  const manager = getReadWriteSplitManager();
  
  return async (req, res, next) => {
    // 附加查询方法
    req.dbQuery = async (sql, params = [], queryOptions = {}) => {
      const options = {
        ...queryOptions,
        consistency: req.consistencyLevel || 'eventual',
        path: req.path,
        requestId: req.requestId
      };
      
      return await manager.query(sql, params, options);
    };
    
    // 事务方法
    req.dbTransaction = async (callback) => {
      // 事务始终在主库执行
      const client = await manager.primaryPool.connect();
      
      try {
        await client.query('BEGIN');
        
        const result = await callback(client);
        
        await client.query('COMMIT');
        return result;
        
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
        
      } finally {
        client.release();
      }
    };
    
    next();
  };
}

/**
 * 健康检查端点
 */
function healthCheckEndpoint(req, res) {
  const manager = getReadWriteSplitManager();
  
  try {
    const health = manager.getHealthSummary();
    
    const allHealthy = health.primary.healthy && 
                       health.replicas.some(r => r.healthy);
    
    const status = allHealthy ? 200 : 503;
    
    res.status(status).json({
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      primary: health.primary,
      replicas: health.replicas
    });
    
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message
    });
  }
}

/**
 * 延迟数据端点
 */
async function lagDataEndpoint(req, res) {
  const { getReplicaLagMonitor } = require('../../jobs/replicaLagMonitor');
  const monitor = getReplicaLagMonitor();
  
  try {
    const lagData = await monitor.getLagData();
    
    res.json({
      ...lagData,
      thresholds: {
        warning: parseInt(process.env.REPLICA_LAG_WARNING_MS || '500'),
        critical: parseInt(process.env.REPLICA_LAG_CRITICAL_MS || '2000')
      }
    });
    
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
}

module.exports = {
  consistencyMiddleware,
  replicaLagMiddleware,
  databaseRouterMiddleware,
  healthCheckEndpoint,
  lagDataEndpoint
};
