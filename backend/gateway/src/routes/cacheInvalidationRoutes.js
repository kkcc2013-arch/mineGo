/**
 * 缓存失效管理路由
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * API 端点：
 * - GET /api/admin/cache-invalidation/status - 获取系统状态
 * - GET /api/admin/cache-invalidation/metrics - 获取监控指标
 * - GET /api/admin/cache-invalidation/rules - 获取失效规则
 * - POST /api/admin/cache-invalidation/rules - 添加失效规则
 * - DELETE /api/admin/cache-invalidation/rules/:table - 移除失效规则
 * - POST /api/admin/cache-invalidation/reload - 重新加载配置
 * - POST /api/admin/cache-invalidation/invalidate - 手动失效缓存
 * - GET /api/admin/cache-invalidation/health - 健康检查
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('cache-invalidation-routes');

// 缓存失效引擎实例（由启动脚本注入）
let cacheInvalidationEngine = null;
let cdcAdapter = null;

/**
 * 设置引擎实例
 */
function setEngines(invalidationEngine, adapter) {
  cacheInvalidationEngine = invalidationEngine;
  cdcAdapter = adapter;
}

/**
 * 获取系统状态
 * GET /api/admin/cache-invalidation/status
 */
router.get('/status', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const status = {
      invalidationEngine: cacheInvalidationEngine.isInitialized ? 'running' : 'stopped',
      cdcAdapter: cdcAdapter ? (cdcAdapter.isRunning ? 'running' : 'stopped') : 'unavailable',
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get status');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取监控指标
 * GET /api/admin/cache-invalidation/metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const metrics = cacheInvalidationEngine.getMetrics();
    
    // 添加成功率计算
    const successRate = metrics.totalChanges > 0
      ? ((metrics.invalidatedKeys / metrics.totalChanges) * 100).toFixed(2)
      : 100;
    
    res.json({
      success: true,
      data: {
        ...metrics,
        successRate: `${successRate}%`,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取失效规则
 * GET /api/admin/cache-invalidation/rules
 */
router.get('/rules', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const rules = [];
    for (const [tableName, config] of cacheInvalidationEngine.invalidationRules) {
      rules.push({
        table: tableName,
        primaryKey: config.primaryKey,
        cacheKeys: config.cacheKeys
      });
    }
    
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get rules');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 添加失效规则
 * POST /api/admin/cache-invalidation/rules
 * 
 * Body:
 * {
 *   "table": "my_table",
 *   "primaryKey": "id",
 *   "cacheKeys": [
 *     { "pattern": "my_table:{id}", "type": "exact" }
 *   ]
 * }
 */
router.post('/rules', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const { table, primaryKey, cacheKeys } = req.body;
    
    if (!table || !primaryKey || !cacheKeys || !Array.isArray(cacheKeys)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: table, primaryKey, cacheKeys'
      });
    }
    
    cacheInvalidationEngine.addInvalidationRule(table, {
      primaryKey,
      cacheKeys
    });
    
    logger.info({ table, userId: req.user?.id }, 'Invalidation rule added');
    
    res.json({
      success: true,
      message: `Invalidation rule added for table ${table}`
    });
  } catch (error) {
    logger.error({ error }, 'Failed to add rule');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 移除失效规则
 * DELETE /api/admin/cache-invalidation/rules/:table
 */
router.delete('/rules/:table', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const { table } = req.params;
    
    const removed = cacheInvalidationEngine.removeInvalidationRule(table);
    
    if (removed) {
      logger.info({ table, userId: req.user?.id }, 'Invalidation rule removed');
      
      res.json({
        success: true,
        message: `Invalidation rule removed for table ${table}`
      });
    } else {
      res.status(404).json({
        success: false,
        error: `No rule found for table ${table}`
      });
    }
  } catch (error) {
    logger.error({ error }, 'Failed to remove rule');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 重新加载配置
 * POST /api/admin/cache-invalidation/reload
 */
router.post('/reload', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    await cacheInvalidationEngine.reloadConfig();
    
    logger.info({ userId: req.user?.id }, 'Invalidation rules reloaded');
    
    res.json({
      success: true,
      message: 'Invalidation rules reloaded successfully'
    });
  } catch (error) {
    logger.error({ error }, 'Failed to reload config');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 手动失效缓存
 * POST /api/admin/cache-invalidation/invalidate
 * 
 * Body:
 * {
 *   "keys": ["user:123", "pokemon:456"],
 *   "pattern": "pokemon:*"  // 可选，使用通配符
 * }
 */
router.post('/invalidate', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const { keys, pattern } = req.body;
    
    if (!keys && !pattern) {
      return res.status(400).json({
        success: false,
        error: 'Either keys or pattern must be provided'
      });
    }
    
    const invalidatedKeys = [];
    
    // 处理精确键列表
    if (keys && Array.isArray(keys)) {
      for (const key of keys) {
        await cacheInvalidationEngine.invalidateCache(key, 'manual');
        invalidatedKeys.push(key);
      }
    }
    
    // 处理模式匹配
    if (pattern) {
      const matchedKeys = cacheInvalidationEngine.findKeysByPrefix(pattern);
      for (const key of matchedKeys) {
        await cacheInvalidationEngine.invalidateCache(key, 'manual');
        invalidatedKeys.push(key);
      }
    }
    
    logger.info({ 
      keysCount: invalidatedKeys.length, 
      userId: req.user?.id 
    }, 'Cache manually invalidated');
    
    res.json({
      success: true,
      data: {
        keysInvalidated: invalidatedKeys.length,
        keys: invalidatedKeys
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to invalidate cache');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 健康检查
 * GET /api/admin/cache-invalidation/health
 */
router.get('/health', async (req, res) => {
  try {
    if (!cacheInvalidationEngine) {
      return res.status(503).json({
        success: false,
        error: 'Cache invalidation engine not initialized'
      });
    }
    
    const health = await cacheInvalidationEngine.healthCheck();
    
    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    logger.error({ error }, 'Health check failed');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * CDC 适配器状态
 * GET /api/admin/cache-invalidation/cdc/status
 */
router.get('/cdc/status', async (req, res) => {
  try {
    if (!cdcAdapter) {
      return res.status(503).json({
        success: false,
        error: 'CDC adapter not available'
      });
    }
    
    const health = await cdcAdapter.healthCheck();
    
    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get CDC status');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = {
  router,
  setEngines
};
