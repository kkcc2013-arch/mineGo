// backend/gateway/src/routes/configRoutes.js
'use strict';

const express = require('express');
const { getConfigCenter } = require('../../../shared/ConfigCenter');
const { createLogger } = require('../../../shared/logger');
const { query } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redis');

const logger = createLogger('config-routes');
const router = express.Router();

// 管理员权限中间件
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  
  // 检查是否是管理员（根据实际权限系统调整）
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  
  next();
}

/**
 * GET /admin/config
 * 获取所有服务的配置概览
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const redis = getRedis();
    const environment = process.env.NODE_ENV || 'development';
    
    // 获取所有服务的配置键
    const keys = await redis.keys(`config:${environment}:*`);
    
    const services = {};
    for (const key of keys) {
      const serviceName = key.split(':')[2];
      if (!services[serviceName]) {
        services[serviceName] = {
          name: serviceName,
          keys: []
        };
      }
      
      const configData = await redis.hgetall(key);
      services[serviceName].keys = Object.keys(configData);
    }
    
    res.json({
      success: true,
      data: {
        environment,
        services: Object.values(services)
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to get config overview');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/config/:serviceName
 * 获取指定服务的配置
 */
router.get('/:serviceName', requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const configCenter = getConfigCenter({ serviceName });
    
    const config = await configCenter.getAll();
    const version = configCenter.getVersion();
    const history = await configCenter.getHistory(10);
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        environment: process.env.NODE_ENV || 'development',
        version,
        config,
        recentHistory: history
      }
    });
    
  } catch (err) {
    logger.error({ err, service: req.params.serviceName }, 'Failed to get service config');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/config/:serviceName/:key
 * 获取指定配置项
 */
router.get('/:serviceName/:key', requireAdmin, async (req, res) => {
  try {
    const { serviceName, key } = req.params;
    const configCenter = getConfigCenter({ serviceName });
    
    const value = await configCenter.get(key);
    
    if (value === null) {
      return res.status(404).json({ success: false, error: 'Config key not found' });
    }
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        key,
        value,
        version: configCenter.getVersion()
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to get config key');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /admin/config/:serviceName/:key
 * 更新单个配置项
 */
router.put('/:serviceName/:key', requireAdmin, async (req, res) => {
  try {
    const { serviceName, key } = req.params;
    const { value, reason } = req.body;
    const changedBy = req.user.sub || req.user.id || 'admin';
    
    if (value === undefined) {
      return res.status(400).json({ success: false, error: 'Value is required' });
    }
    
    const configCenter = getConfigCenter({ serviceName });
    const result = await configCenter.set(key, value, changedBy);
    
    // 记录到审计日志
    await query(`
      INSERT INTO config_audit_log (service_name, config_key, old_value, new_value, changed_by, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [serviceName, key, null, JSON.stringify(value), changedBy, reason || '']);
    
    logger.info({ 
      service: serviceName, 
      key, 
      changedBy,
      reason 
    }, 'Config updated');
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        key,
        value,
        version: result.version,
        changedBy
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to update config');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /admin/config/:serviceName/batch
 * 批量更新配置
 */
router.post('/:serviceName/batch', requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { config, reason } = req.body;
    const changedBy = req.user.sub || req.user.id || 'admin';
    
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ success: false, error: 'Config object is required' });
    }
    
    const configCenter = getConfigCenter({ serviceName });
    const oldConfig = await configCenter.getAll();
    
    const result = await configCenter.updateConfig(config, changedBy, reason || 'Batch update');
    
    // 记录到审计日志
    await query(`
      INSERT INTO config_audit_log (service_name, config_key, old_value, new_value, changed_by, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [serviceName, 'batch', JSON.stringify(oldConfig), JSON.stringify(config), changedBy, reason || '']);
    
    logger.info({ 
      service: serviceName, 
      keys: Object.keys(config),
      changedBy,
      reason 
    }, 'Config batch updated');
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        version: result.version,
        updatedKeys: Object.keys(config),
        changedBy
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to batch update config');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /admin/config/:serviceName/:key
 * 删除配置项
 */
router.delete('/:serviceName/:key', requireAdmin, async (req, res) => {
  try {
    const { serviceName, key } = req.params;
    const { reason } = req.query;
    const changedBy = req.user.sub || req.user.id || 'admin';
    
    const configCenter = getConfigCenter({ serviceName });
    const oldValue = await configCenter.get(key);
    
    await configCenter.delete(key, changedBy);
    
    // 记录到审计日志
    await query(`
      INSERT INTO config_audit_log (service_name, config_key, old_value, new_value, changed_by, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [serviceName, key, JSON.stringify(oldValue), null, changedBy, reason || 'Deleted']);
    
    logger.info({ 
      service: serviceName, 
      key,
      changedBy 
    }, 'Config deleted');
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        key,
        deletedBy: changedBy
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to delete config');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/config/:serviceName/history
 * 获取配置变更历史
 */
router.get('/:serviceName/history', requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { limit = 50 } = req.query;
    
    const configCenter = getConfigCenter({ serviceName });
    const history = await configCenter.getHistory(parseInt(limit, 10));
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        history
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to get config history');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /admin/config/:serviceName/rollback
 * 回滚到指定版本
 */
router.post('/:serviceName/rollback', requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { version, reason } = req.body;
    const changedBy = req.user.sub || req.user.id || 'admin';
    
    if (!version) {
      return res.status(400).json({ success: false, error: 'Version is required' });
    }
    
    const configCenter = getConfigCenter({ serviceName });
    const result = await configCenter.rollback(parseInt(version, 10), changedBy);
    
    // 记录到审计日志
    await query(`
      INSERT INTO config_audit_log (service_name, config_key, old_value, new_value, changed_by, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [serviceName, 'rollback', null, JSON.stringify({ targetVersion: version }), changedBy, reason || `Rollback to version ${version}`]);
    
    logger.info({ 
      service: serviceName, 
      targetVersion: version,
      changedBy 
    }, 'Config rolled back');
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        targetVersion: version,
        newVersion: result.version,
        changedBy
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to rollback config');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/config/:serviceName/audit
 * 获取配置审计日志
 */
router.get('/:serviceName/audit', requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    const { rows } = await query(`
      SELECT id, service_name, config_key, old_value, new_value, changed_by, reason, created_at
      FROM config_audit_log
      WHERE service_name = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [serviceName, parseInt(limit, 10), parseInt(offset, 10)]);
    
    const { rows: [{ count }] } = await query(`
      SELECT COUNT(*) FROM config_audit_log WHERE service_name = $1
    `, [serviceName]);
    
    res.json({
      success: true,
      data: {
        service: serviceName,
        logs: rows,
        total: parseInt(count, 10)
      }
    });
    
  } catch (err) {
    logger.error({ err }, 'Failed to get audit logs');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/config/health
 * 配置中心健康检查
 */
router.get('/health', async (req, res) => {
  try {
    const configCenter = getConfigCenter();
    const health = await configCenter.healthCheck();
    
    res.json({
      success: true,
      data: health
    });
    
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
