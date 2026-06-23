/**
 * KMS Admin Routes - 密钥管理系统管理路由
 * 
 * 提供密钥管理的 REST API 接口。
 * 
 * @module gateway/src/routes/admin/kms
 */

'use strict';

const express = require('express');
const router = express.Router();
const kms = require('../../../shared/kms');
const logger = require('../../../shared/logger');

/**
 * 获取所有密钥列表（不包含值）
 * 
 * GET /admin/kms/keys
 */
router.get('/keys', async (req, res) => {
  try {
    const keyService = kms.getKeyService();
    const { limit, offset, sensitivity, keyType } = req.query;
    
    const keys = await keyService.listKeys({
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0,
      sensitivity,
      keyType
    });

    res.json({
      success: true,
      data: keys.rows || keys,
      total: keys.rowCount || (Array.isArray(keys) ? keys.length : 0)
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to list keys:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取密钥详情
 * 
 * GET /admin/kms/keys/:keyName
 */
router.get('/keys/:keyName', async (req, res) => {
  try {
    const { keyName } = req.params;
    const keyService = kms.getKeyService();
    
    const keyMeta = await keyService.getKeyMeta(keyName);

    res.json({
      success: true,
      data: {
        id: keyMeta.id,
        keyName: keyMeta.key_name,
        keyType: keyMeta.key_type,
        sensitivity: keyMeta.sensitivity,
        currentVersion: keyMeta.current_version,
        rotationPeriodDays: keyMeta.rotation_period_days,
        lastRotatedAt: keyMeta.last_rotated_at,
        nextRotationAt: keyMeta.next_rotation_at,
        isActive: keyMeta.is_active,
        createdAt: keyMeta.created_at
      }
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to get key:', error);
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 创建新密钥
 * 
 * POST /admin/kms/keys
 */
router.post('/keys', async (req, res) => {
  try {
    const { keyName, keyType, sensitivity, value, rotationPeriodDays } = req.body;
    
    if (!keyName || !keyType || !sensitivity) {
      return res.status(400).json({
        success: false,
        error: 'keyName, keyType, and sensitivity are required'
      });
    }

    const keyService = kms.getKeyService();
    const result = await keyService.createKey({
      keyName,
      keyType,
      sensitivity,
      value,
      rotationPeriodDays
    });

    logger.info('[KMS Admin] Key created:', { keyName, keyType, sensitivity });

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to create key:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 手动触发轮换
 * 
 * POST /admin/kms/keys/:keyName/rotate
 */
router.post('/keys/:keyName/rotate', async (req, res) => {
  try {
    const { keyName } = req.params;
    const { reason } = req.body;
    
    const rotationService = kms.getKeyRotationService();
    const result = await rotationService.rotateKey(keyName, reason || 'manual');

    logger.info('[KMS Admin] Key rotated:', { keyName, newVersion: result.newVersion });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to rotate key:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取访问日志
 * 
 * GET /admin/kms/keys/:keyName/logs
 */
router.get('/keys/:keyName/logs', async (req, res) => {
  try {
    const { keyName } = req.params;
    const { limit } = req.query;
    
    const keyService = kms.getKeyService();
    const logs = await keyService.getAccessLogs(keyName, {
      limit: parseInt(limit) || 100
    });

    res.json({
      success: true,
      data: logs.rows || logs
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to get access logs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 紧急撤销密钥
 * 
 * POST /admin/kms/keys/:keyName/revoke
 */
router.post('/keys/:keyName/revoke', async (req, res) => {
  try {
    const { keyName } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Reason is required for revocation'
      });
    }

    const emergencyService = kms.getEmergencyResponseService();
    const result = await emergencyService.revokeKey(keyName, reason);

    logger.critical('[KMS Admin] Key emergency revoked:', { keyName, reason });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to revoke key:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 紧急轮换密钥
 * 
 * POST /admin/kms/keys/:keyName/emergency-rotate
 */
router.post('/keys/:keyName/emergency-rotate', async (req, res) => {
  try {
    const { keyName } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Reason is required for emergency rotation'
      });
    }

    const emergencyService = kms.getEmergencyResponseService();
    const result = await emergencyService.emergencyRotate(keyName, reason);

    logger.critical('[KMS Admin] Key emergency rotated:', { keyName, reason });

    res.json({
      success: true,
      data: {
        keyName: result.keyName,
        newVersion: result.newVersion,
        reason: result.reason,
        timestamp: result.timestamp,
        // 注意：不返回 newKeyValue，应通过安全渠道传递
        newKeyValue: '***' // 隐藏实际值
      }
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to emergency rotate key:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取轮换状态
 * 
 * GET /admin/kms/rotation-status
 */
router.get('/rotation-status', async (req, res) => {
  try {
    const rotationService = kms.getKeyRotationService();
    const status = await rotationService.getRotationStatus();

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to get rotation status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 检查密钥健康状态
 * 
 * GET /admin/kms/health
 */
router.get('/health', async (req, res) => {
  try {
    const emergencyService = kms.getEmergencyResponseService();
    const health = await emergencyService.checkKeyHealth();

    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to check key health:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取安全事件历史
 * 
 * GET /admin/kms/incidents
 */
router.get('/incidents', async (req, res) => {
  try {
    const { keyName, limit } = req.query;
    
    const emergencyService = kms.getEmergencyResponseService();
    const incidents = await emergencyService.getIncidentHistory({
      keyName,
      limit: parseInt(limit) || 50
    });

    res.json({
      success: true,
      data: incidents.rows || incidents
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to get incidents:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取缓存统计
 * 
 * GET /admin/kms/cache-stats
 */
router.get('/cache-stats', async (req, res) => {
  try {
    const keyService = kms.getKeyService();
    const stats = keyService.getCacheStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to get cache stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 清除密钥缓存
 * 
 * DELETE /admin/kms/cache/:keyName?
 */
router.delete('/cache/:keyName?', async (req, res) => {
  try {
    const { keyName } = req.params;
    const keyService = kms.getKeyService();
    
    keyService.clearCache(keyName);

    logger.info('[KMS Admin] Cache cleared:', { keyName: keyName || 'all' });

    res.json({
      success: true,
      message: keyName ? `Cache cleared for ${keyName}` : 'All cache cleared'
    });
  } catch (error) {
    logger.error('[KMS Admin] Failed to clear cache:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
