/**
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * API 路由 - 监控和管理接口
 */

const express = require('express');
const router = express.Router();
const { getCacheInvalidationCenter } = require('../../shared/cdc');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * 获取统计信息
 * GET /api/v1/cache-invalidation/stats
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const center = getCacheInvalidationCenter();
    const stats = await center.getStats();
    
    res.json({
      timestamp: new Date().toISOString(),
      ...stats
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get stats',
      message: error.message 
    });
  }
});

/**
 * 健康检查
 * GET /api/v1/cache-invalidation/health
 */
router.get('/health', async (req, res) => {
  try {
    const center = getCacheInvalidationCenter();
    const health = await center.healthCheck();
    
    res.json(health);
  } catch (error) {
    res.status(503).json({ 
      status: 'error',
      message: error.message 
    });
  }
});

/**
 * 手动触发失效（管理员）
 * POST /api/v1/admin/cache-invalidation/invalidate
 */
router.post('/admin/invalidate', requireAdmin, async (req, res) => {
  try {
    const { table, operation, data, pattern } = req.body;
    
    const center = getCacheInvalidationCenter();
    
    if (pattern) {
      // 按模式失效
      await center.invalidateByPattern(pattern);
      
      res.json({
        success: true,
        pattern,
        message: 'Cache invalidated by pattern'
      });
      
    } else if (table && operation && data) {
      // 按表操作失效
      await center.manualInvalidate(table, operation, data);
      
      res.json({
        success: true,
        table,
        operation,
        message: 'Cache invalidated manually'
      });
      
    } else {
      res.status(400).json({ 
        error: 'INVALID_REQUEST',
        message: 'Provide either (table, operation, data) or pattern'
      });
    }
  } catch (error) {
    res.status(500).json({ 
      error: 'INVALIDATION_FAILED',
      message: error.message 
    });
  }
});

/**
 * 获取映射规则
 * GET /api/v1/cache-invalidation/rules
 */
router.get('/rules', requireAdmin, (req, res) => {
  try {
    const center = getCacheInvalidationCenter();
    const rules = center.mapper.getMappingRules();
    
    res.json({
      tables: Object.keys(rules).length,
      rules
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get rules',
      message: error.message 
    });
  }
});

/**
 * 添加映射规则（管理员）
 * POST /api/v1/admin/cache-invalidation/rules
 */
router.post('/admin/rules', requireAdmin, async (req, res) => {
  try {
    const { table, operation, patterns } = req.body;
    
    if (!table || !operation || !patterns || !Array.isArray(patterns)) {
      return res.status(400).json({ 
        error: 'INVALID_REQUEST',
        message: 'Provide table, operation, and patterns array'
      });
    }
    
    const center = getCacheInvalidationCenter();
    center.mapper.addTableMapping(table, { [operation]: patterns });
    
    res.json({
      success: true,
      table,
      operation,
      patterns: patterns.length
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to add rule',
      message: error.message 
    });
  }
});

module.exports = router;