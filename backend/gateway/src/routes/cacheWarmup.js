/**
 * 缓存预热管理 API 路由
 * 
 * REQ-00039: 热点数据缓存预热系统
 * 
 * 提供预热状态查询和手动触发接口
 */

const express = require('express');
const router = express.Router();
const cacheWarmup = require('../../../shared/cacheWarmup');
const { getConfigNames, getConfig } = require('../../../shared/cacheWarmupConfig');
const { createLogger } = require('../../../shared/logger');
const { requireAuth, requireAdmin } = require('../../../shared/auth');

const logger = createLogger('cache-warmup-routes');

/**
 * GET /admin/cache/warmup/status
 * 获取预热服务状态
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = cacheWarmup.getStatus();
    const configs = getConfigNames().map(name => {
      const config = getConfig(name);
      return {
        name,
        enabled: config?.enabled || false,
        priority: config?.priority || 99,
        ttl: config?.ttl || 0,
        refreshInterval: config?.refreshInterval || 0,
      };
    });
    
    res.json({
      success: true,
      data: {
        status,
        configs,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get warmup status');
    res.status(500).json({
      success: false,
      error: 'Failed to get warmup status',
      message: err.message,
    });
  }
});

/**
 * POST /admin/cache/warmup/trigger
 * 手动触发预热
 * 
 * Body:
 * - name: 可选，指定数据集名称。不传则预热所有
 */
router.post('/trigger', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    
    // 如果指定了名称，验证配置存在
    if (name) {
      const config = getConfig(name);
      if (!config) {
        return res.status(400).json({
          success: false,
          error: `Unknown data name: ${name}`,
          availableNames: getConfigNames(),
        });
      }
    }
    
    logger.info({ name, user: req.user?.sub }, 'Manual warmup triggered');
    
    const result = await cacheWarmup.triggerWarmup(name || null);
    
    res.json({
      success: true,
      message: name 
        ? `Warmup completed for ${name}` 
        : 'Warmup completed for all data',
      data: result,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger warmup');
    
    if (err.message === 'Warmup already in progress') {
      return res.status(409).json({
        success: false,
        error: 'Warmup already in progress',
        message: 'Please wait for the current warmup to complete',
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to trigger warmup',
      message: err.message,
    });
  }
});

/**
 * POST /admin/cache/warmup/reset
 * 重置预热统计信息
 */
router.post('/reset', requireAuth, async (req, res) => {
  try {
    cacheWarmup.resetStats();
    
    logger.info({ user: req.user?.sub }, 'Warmup stats reset');
    
    res.json({
      success: true,
      message: 'Warmup stats reset',
    });
  } catch (err) {
    logger.error({ err }, 'Failed to reset warmup stats');
    res.status(500).json({
      success: false,
      error: 'Failed to reset warmup stats',
      message: err.message,
    });
  }
});

/**
 * GET /admin/cache/warmup/config
 * 获取预热配置列表
 */
router.get('/config', requireAuth, async (req, res) => {
  try {
    const configs = getConfigNames().map(name => {
      const config = getConfig(name);
      return {
        name,
        description: config?.description || '',
        enabled: config?.enabled || false,
        priority: config?.priority || 99,
        ttl: config?.ttl || 0,
        ttlFormatted: formatTTL(config?.ttl || 0),
        refreshInterval: config?.refreshInterval || 0,
        refreshIntervalFormatted: formatInterval(config?.refreshInterval || 0),
        keys: config?.keys || [],
      };
    }).sort((a, b) => a.priority - b.priority);
    
    res.json({
      success: true,
      data: configs,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get warmup config');
    res.status(500).json({
      success: false,
      error: 'Failed to get warmup config',
      message: err.message,
    });
  }
});

/**
 * 格式化 TTL
 */
function formatTTL(seconds) {
  if (!seconds) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * 格式化刷新间隔
 */
function formatInterval(ms) {
  if (!ms) return '-';
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

module.exports = router;
