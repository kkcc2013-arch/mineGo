/**
 * 敏感 API 二次验证路由
 * 
 * REQ-00588: 敏感 API 二次身份验证与风控行为分级系统
 */

'use strict';

const express = require('express');
const router = express.Router();
const { logger } = require('../../../shared/logger');
const SensitiveApiMfaService = require('../../security/src/sensitiveApiMfa');

// 服务实例（在 app.js 中初始化）
let mfaService = null;

/**
 * 初始化服务
 */
function initMfaService(db, redis) {
  if (!mfaService) {
    mfaService = new SensitiveApiMfaService(db, redis);
  }
  return mfaService;
}

/**
 * 获取可用验证方式
 * GET /api/v1/mfa/methods
 */
router.get('/methods', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    
    const methods = await mfaService.getAvailableVerificationMethods(userId);
    
    res.json({
      success: true,
      methods,
      defaultMethod: methods[0]?.type || null
    });
    
  } catch (error) {
    logger.error('Failed to get MFA methods', { error: error.message });
    res.status(500).json({ error: 'SYSTEM_ERROR', message: '系统错误' });
  }
});

/**
 * 发起二次验证
 * POST /api/v1/mfa/initiate
 */
router.post('/initiate', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    
    const { challengeToken, verificationType, quickVerify } = req.body;
    
    if (!challengeToken) {
      return res.status(400).json({ 
        error: 'MISSING_CHALLENGE_TOKEN', 
        message: '缺少挑战令牌' 
      });
    }
    
    if (!verificationType) {
      return res.status(400).json({ 
        error: 'MISSING_VERIFICATION_TYPE', 
        message: '请选择验证方式' 
      });
    }
    
    const result = await mfaService.initiateVerification(
      userId,
      challengeToken,
      verificationType,
      { quickVerify }
    );
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
    
  } catch (error) {
    logger.error('Failed to initiate MFA', { error: error.message });
    res.status(500).json({ error: 'SYSTEM_ERROR', message: '系统错误' });
  }
});

/**
 * 验证验证码
 * POST /api/v1/mfa/verify
 */
router.post('/verify', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    
    const { verificationId, code } = req.body;
    
    if (!verificationId || !code) {
      return res.status(400).json({ 
        error: 'MISSING_PARAMS', 
        message: '请提供验证 ID 和验证码' 
      });
    }
    
    const result = await mfaService.verifyCode(verificationId, code);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
    
  } catch (error) {
    logger.error('Failed to verify MFA code', { error: error.message });
    res.status(500).json({ error: 'SYSTEM_ERROR', message: '系统错误' });
  }
});

/**
 * 重新发送验证码
 * POST /api/v1/mfa/resend
 */
router.post('/resend', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    
    const { verificationId } = req.body;
    
    if (!verificationId) {
      return res.status(400).json({ 
        error: 'MISSING_VERIFICATION_ID', 
        message: '缺少验证 ID' 
      });
    }
    
    // 获取原有验证信息
    const verificationKey = `mfa_verification:${verificationId}`;
    const data = await mfaService.redis.hgetall(verificationKey);
    
    if (!data || !data.userId) {
      return res.status(404).json({ 
        error: 'VERIFICATION_NOT_FOUND', 
        message: '验证请求不存在或已过期' 
      });
    }
    
    // 发起新的验证
    const result = await mfaService.initiateVerification(
      userId,
      data.challengeToken,
      data.verificationType
    );
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
    
  } catch (error) {
    logger.error('Failed to resend MFA code', { error: error.message });
    res.status(500).json({ error: 'SYSTEM_ERROR', message: '系统错误' });
  }
});

/**
 * 检查验证状态
 * GET /api/v1/mfa/status/:verificationId
 */
router.get('/status/:verificationId', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    
    const { verificationId } = req.params;
    const verificationKey = `mfa_verification:${verificationId}`;
    const data = await mfaService.redis.hgetall(verificationKey);
    
    if (!data || !data.userId) {
      return res.status(404).json({ 
        error: 'VERIFICATION_NOT_FOUND', 
        message: '验证请求不存在或已过期' 
      });
    }
    
    res.json({
      success: true,
      status: 'pending',
      verificationType: data.verificationType,
      attempts: parseInt(data.attempts || '0'),
      remainingAttempts: mfaService.config.maxAttempts - parseInt(data.attempts || '0')
    });
    
  } catch (error) {
    logger.error('Failed to get MFA status', { error: error.message });
    res.status(500).json({ error: 'SYSTEM_ERROR', message: '系统错误' });
  }
});

module.exports = {
  router,
  initMfaService
};