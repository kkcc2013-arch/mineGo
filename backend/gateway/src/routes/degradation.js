// backend/gateway/src/routes/degradation.js
'use strict';

const express = require('express');
const router = express.Router();
const { getDegradationManager, DEGRADATION_LEVELS } = require('@pmg/shared/DegradationManager');
const { createLogger } = require('@pmg/shared/logger');
const { requireAdmin } = require('@pmg/shared/auth');

const logger = createLogger('degradation-routes');

/**
 * 获取所有服务降级状态
 * GET /api/degradation/status
 */
router.get('/status', async (req, res) => {
  try {
    const manager = getDegradationManager();
    const status = manager.getAllServicesStatus();
    
    res.json({
      success: true,
      data: status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get degradation status');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取降级状态失败'
      }
    });
  }
});

/**
 * 获取单个服务降级状态
 * GET /api/degradation/status/:service
 */
router.get('/status/:service', async (req, res) => {
  try {
    const { service } = req.params;
    const manager = getDegradationManager();
    
    const status = manager.getServiceState(service);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SERVICE_NOT_FOUND',
          message: `服务 ${service} 不存在`
        }
      });
    }
    
    res.json({
      success: true,
      data: status
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get service degradation status');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取服务降级状态失败'
      }
    });
  }
});

/**
 * 手动触发降级
 * POST /api/degradation/:service/degrade
 * 管理员权限
 */
router.post('/:service/degrade', requireAdmin, async (req, res) => {
  try {
    const { service } = req.params;
    const { level, reason } = req.body;
    const changedBy = req.user?.id || 'admin';
    
    if (!level) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_LEVEL',
          message: '请指定降级级别 (level1, level2, level3)'
        }
      });
    }
    
    if (!Object.values(DEGRADATION_LEVELS).includes(level) && level !== DEGRADATION_LEVELS.NORMAL) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LEVEL',
          message: '无效的降级级别',
          validLevels: Object.values(DEGRADATION_LEVELS)
        }
      });
    }
    
    const manager = getDegradationManager();
    
    const result = await manager.manualDegradation(service, level, reason || '手动降级', changedBy);
    
    logger.info({
      service,
      level,
      reason,
      changedBy
    }, 'Manual degradation triggered');
    
    res.json({
      success: true,
      data: {
        service,
        level,
        reason,
        changedBy,
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to trigger manual degradation');
    
    if (err.message.includes('Unknown service')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SERVICE_NOT_FOUND',
          message: err.message
        }
      });
    }
    
    if (err.message.includes('Unknown degradation level')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LEVEL',
          message: err.message
        }
      });
    }
    
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '降级操作失败'
      }
    });
  }
});

/**
 * 手动恢复服务
 * POST /api/degradation/:service/recover
 * 管理员权限
 */
router.post('/:service/recover', requireAdmin, async (req, res) => {
  try {
    const { service } = req.params;
    const changedBy = req.user?.id || 'admin';
    
    const manager = getDegradationManager();
    
    const result = await manager.forceRecover(service, changedBy);
    
    logger.info({
      service,
      changedBy,
      previousLevel: result.previousLevel
    }, 'Manual recovery triggered');
    
    res.json({
      success: true,
      data: {
        service,
        previousLevel: result.previousLevel,
        currentLevel: DEGRADATION_LEVELS.NORMAL,
        changedBy,
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to recover service');
    
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '恢复操作失败'
      }
    });
  }
});

/**
 * 获取降级历史
 * GET /api/degradation/history
 */
router.get('/history', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const manager = getDegradationManager();
    
    const history = manager.getDegradationHistory(parseInt(limit, 10));
    
    res.json({
      success: true,
      data: history,
      total: history.length
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get degradation history');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取降级历史失败'
      }
    });
  }
});

/**
 * 获取服务降级审计日志
 * GET /api/degradation/audit/:service
 */
router.get('/audit/:service', async (req, res) => {
  try {
    const { service } = req.params;
    const { limit = 50 } = req.query;
    const manager = getDegradationManager();
    
    const logs = await manager.getServiceAuditLog(service, parseInt(limit, 10));
    
    res.json({
      success: true,
      data: logs,
      total: logs.length
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get audit logs');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取审计日志失败'
      }
    });
  }
});

/**
 * 订阅降级事件（WebSocket 连接）
 * 此端点返回订阅信息，实际订阅通过 WebSocket 实现
 */
router.get('/subscribe/info', async (req, res) => {
  res.json({
    success: true,
    data: {
      channel: 'degradation:events',
      events: ['degradation', 'recovery', 'configUpdate'],
      connection: 'WebSocket'
    }
  });
});

/**
 * 获取用户等级配置
 * GET /api/degradation/config/user-tiers
 */
router.get('/config/user-tiers', async (req, res) => {
  try {
    const manager = getDegradationManager();
    
    res.json({
      success: true,
      data: manager.config.userTiers
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get user tier config');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取用户等级配置失败'
      }
    });
  }
});

/**
 * 获取接口降级配置
 * GET /api/degradation/config/endpoints
 */
router.get('/config/endpoints', async (req, res) => {
  try {
    const manager = getDegradationManager();
    
    res.json({
      success: true,
      data: manager.config.endpoints
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get endpoint config');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取接口配置失败'
      }
    });
  }
});

/**
 * 获取服务降级配置
 * GET /api/degradation/config/services
 */
router.get('/config/services', async (req, res) => {
  try {
    const manager = getDegradationManager();
    
    // 移除敏感信息，只返回配置概览
    const servicesConfig = {};
    for (const [name, config] of Object.entries(manager.config.services)) {
      servicesConfig[name] = {
        priority: config.priority,
        levels: Object.keys(config.degradationLevels)
      };
    }
    
    res.json({
      success: true,
      data: servicesConfig
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get services config');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取服务配置失败'
      }
    });
  }
});

/**
 * 更新降级配置
 * PUT /api/degradation/config
 * 管理员权限
 */
router.put('/config', requireAdmin, async (req, res) => {
  try {
    const { config } = req.body;
    const changedBy = req.user?.id || 'admin';
    
    if (!config) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_CONFIG',
          message: '请提供配置内容'
        }
      });
    }
    
    const manager = getDegradationManager();
    manager.updateConfig(config);
    
    logger.info({
      changedBy,
      configKeys: Object.keys(config)
    }, 'Degradation config updated');
    
    res.json({
      success: true,
      data: {
        updated: true,
        changedBy,
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to update config');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '更新配置失败'
      }
    });
  }
});

module.exports = router;