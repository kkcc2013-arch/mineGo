/**
 * REQ-00044: API 版本管理路由
 * 提供版本信息查询和管理接口
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getVersionManager } = require('@pmg/shared/apiVersionManager');
const { requireAuth, requireAdmin } = require('@pmg/shared/authMiddleware');

const logger = require('@pmg/shared/logger').createLogger('api-version-routes');

// ============================================================
// 公开接口
// ============================================================

/**
 * GET /api/versions
 * 获取所有 API 版本信息
 */
router.get('/versions', (req, res) => {
  const manager = getVersionManager();
  const versions = manager.getAllVersions();
  
  res.json({
    currentVersion: manager.currentVersion,
    supportedVersions: manager.supportedVersions,
    deprecatedVersions: manager.deprecatedVersions,
    versions
  });
});

/**
 * GET /api/versions/:version
 * 获取指定版本详情
 */
router.get('/versions/:version', (req, res) => {
  const { version } = req.params;
  const manager = getVersionManager();
  
  const v = parseInt(version);
  const info = manager.getVersionInfo(v);
  
  if (!info) {
    return res.status(404).json({
      code: 1047,
      message: `版本 ${version} 不存在`
    });
  }
  
  res.json({
    version: v,
    ...info,
    isCurrent: v === manager.currentVersion,
    isDeprecated: manager.isDeprecated(v),
    deprecationWarning: manager.getDeprecationWarning(v)
  });
});

/**
 * GET /api/versions/:version/changelog
 * 获取版本变更日志
 */
router.get('/versions/:version/changelog', (req, res) => {
  const { version } = req.params;
  const manager = getVersionManager();
  
  const v = parseInt(version);
  const changelog = manager.generateChangelog(1, v);
  
  res.json({
    fromVersion: 1,
    toVersion: v,
    changelog
  });
});

/**
 * GET /api/versions/usage
 * 获取版本使用统计
 */
router.get('/versions/usage', (req, res) => {
  const manager = getVersionManager();
  const stats = manager.getUsageStats();
  
  res.json({
    usage: stats,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// 管理接口（需要管理员权限）
// ============================================================

/**
 * POST /api/versions/:version/deprecate
 * 标记版本废弃
 */
router.post('/versions/:version/deprecate', requireAuth, requireAdmin, (req, res) => {
  const { version } = req.params;
  const { deprecationDate, deprecationPeriod } = req.body;
  
  const manager = getVersionManager();
  const v = parseInt(version);
  
  try {
    const info = manager.deprecateVersion(v, {
      deprecationDate,
      deprecationPeriod
    });
    
    logger.info({ 
      version: v, 
      deprecated: info.deprecated,
      sunset: info.sunset,
      admin: req.user.id
    }, 'API version deprecated by admin');
    
    res.json({
      success: true,
      message: `API v${v} 已标记废弃`,
      deprecated: info.deprecated,
      sunset: info.sunset
    });
  } catch (err) {
    res.status(400).json({
      code: 1048,
      message: err.message
    });
  }
});

/**
 * POST /api/versions/:version/changes
 * 添加变更记录
 */
router.post('/versions/:version/changes', requireAuth, requireAdmin, (req, res) => {
  const { version } = req.params;
  const { type, path, description } = req.body;
  
  if (!type || !path || !description) {
    return res.status(400).json({
      code: 1049,
      message: '缺少必要字段: type, path, description'
    });
  }
  
  const manager = getVersionManager();
  const v = parseInt(version);
  
  try {
    manager.addChange(v, { type, path, description });
    
    res.json({
      success: true,
      message: '变更记录已添加'
    });
  } catch (err) {
    res.status(400).json({
      code: 1050,
      message: err.message
    });
  }
});

/**
 * GET /api/versions/:version/sunset-check
 * 检查版本是否可安全下线
 */
router.get('/versions/:version/sunset-check', requireAuth, requireAdmin, (req, res) => {
  const { version } = req.params;
  const manager = getVersionManager();
  const v = parseInt(version);
  
  const canSunset = manager.canSafelySunset(v);
  const stats = manager.getUsageStats();
  const versionUsage = stats[v]?.total || 0;
  const totalUsage = Object.values(stats).reduce((sum, s) => sum + s.total, 0);
  
  res.json({
    version: v,
    canSafelySunset: canSunset,
    usageRate: totalUsage > 0 ? versionUsage / totalUsage : 0,
    versionUsage,
    totalUsage,
    threshold: 0.05
  });
});

module.exports = router;
