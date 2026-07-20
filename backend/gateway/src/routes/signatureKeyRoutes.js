/**
 * 签名密钥管理 API
 * @module SignatureKeyRoutes
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getInstance } = require('../../../shared/requestSignatureService');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('signature-key-routes');

/**
 * 获取当前签名密钥信息（需要认证）
 */
router.get('/current', authenticate, async (req, res) => {
  try {
    const signatureService = getInstance();
    const stats = signatureService.getStats();
    
    // 只返回密钥版本，不返回实际密钥
    res.json({
      keyVersion: 'current',
      createdAt: stats.keyCreatedAt,
      maxTimestampDrift: stats.maxTimestampDrift,
      nonceExpiry: stats.nonceExpiry,
      sensitiveEndpoints: stats.sensitiveEndpoints
    });
  } catch (error) {
    logger.error('Failed to get current key', { error: error.message });
    res.status(500).json({ error: 'Failed to get current key' });
  }
});

/**
 * 管理员：触发密钥轮换
 */
router.post('/rotate', authenticate, requireAdmin, async (req, res) => {
  try {
    const signatureService = getInstance();
    
    // 生成新密钥
    const newKey = crypto.randomBytes(32).toString('hex');
    const newVersion = await signatureService.rotateKey(newKey);
    
    logger.info('Signature key rotated by admin', {
      adminId: req.user.id,
      newVersion
    });
    
    res.json({
      success: true,
      newVersion,
      timestamp: new Date().toISOString(),
      message: 'Signature key rotated successfully'
    });
  } catch (error) {
    logger.error('Failed to rotate key', { 
      error: error.message,
      adminId: req.user.id 
    });
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

/**
 * 管理员：获取密钥状态
 */
router.get('/status', authenticate, requireAdmin, (req, res) => {
  try {
    const signatureService = getInstance();
    const stats = signatureService.getStats();
    
    res.json({
      keyVersions: stats.keyVersions,
      activeVersion: 'current',
      nonceCacheSize: stats.nonceCacheSize,
      sensitiveEndpoints: stats.sensitiveEndpoints,
      keyCreatedAt: stats.keyCreatedAt,
      config: {
        maxTimestampDrift: stats.maxTimestampDrift,
        nonceExpiry: stats.nonceExpiry
      }
    });
  } catch (error) {
    logger.error('Failed to get key status', { error: error.message });
    res.status(500).json({ error: 'Failed to get key status' });
  }
});

/**
 * 管理员：添加敏感端点
 */
router.post('/endpoints', authenticate, requireAdmin, (req, res) => {
  try {
    const { method, path } = req.body;
    
    if (!method || !path) {
      return res.status(400).json({ 
        error: 'Missing required fields: method, path' 
      });
    }
    
    const signatureService = getInstance();
    signatureService.addSensitiveEndpoint(method, path);
    
    logger.info('Sensitive endpoint added by admin', {
      adminId: req.user.id,
      method,
      path
    });
    
    res.json({
      success: true,
      endpoint: `${method}:${path}`,
      sensitiveEndpoints: Array.from(signatureService.sensitiveEndpoints)
    });
  } catch (error) {
    logger.error('Failed to add endpoint', { error: error.message });
    res.status(500).json({ error: 'Failed to add endpoint' });
  }
});

/**
 * 管理员：移除敏感端点
 */
router.delete('/endpoints', authenticate, requireAdmin, (req, res) => {
  try {
    const { method, path } = req.body;
    
    if (!method || !path) {
      return res.status(400).json({ 
        error: 'Missing required fields: method, path' 
      });
    }
    
    const signatureService = getInstance();
    signatureService.removeSensitiveEndpoint(method, path);
    
    logger.info('Sensitive endpoint removed by admin', {
      adminId: req.user.id,
      method,
      path
    });
    
    res.json({
      success: true,
      endpoint: `${method}:${path}`,
      sensitiveEndpoints: Array.from(signatureService.sensitiveEndpoints)
    });
  } catch (error) {
    logger.error('Failed to remove endpoint', { error: error.message });
    res.status(500).json({ error: 'Failed to remove endpoint' });
  }
});

/**
 * 测试签名验证（仅开发环境）
 */
if (process.env.NODE_ENV !== 'production') {
  router.post('/test', authenticate, (req, res) => {
    try {
      const signatureService = getInstance();
      const { method, path, body } = req.body;
      
      // 生成签名
      const signatureData = signatureService.generateSignature(
        method || 'POST',
        path || '/v1/pokemon/catch',
        body || {}
      );
      
      res.json({
        success: true,
        signatureData,
        test: {
          message: 'Use these headers in your test request',
          headers: {
            'X-Signature': signatureData.signature,
            'X-Timestamp': signatureData.timestamp.toString(),
            'X-Nonce': signatureData.nonce,
            'X-Key-Version': signatureData.keyVersion
          }
        }
      });
    } catch (error) {
      logger.error('Test signature generation failed', { error: error.message });
      res.status(500).json({ error: 'Test signature generation failed' });
    }
  });
}

module.exports = router;
