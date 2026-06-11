/**
 * REQ-00057: MFA API 路由
 * 用户 MFA 管理 API
 */

const express = require('express');
const router = express.Router();
const mfaService = require('../../../../shared/mfaService');
const { generateMfaToken, mfaRequired } = require('../../../../gateway/src/middleware/mfaRequired');
const { createLogger } = require('../../../../shared/logger');
const metrics = require('../../../../shared/metrics');
const logger = createLogger('user-service');

/**
 * 获取 MFA 状态
 * GET /api/users/me/mfa
 */
router.get('/', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const status = await mfaService.getMFAStatus(req.user.id);

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Failed to get MFA status', { error: error.message });
    res.status(500).json({ code: 1050, message: '获取 MFA 状态失败' });
  }
});

/**
 * 初始化 MFA 设置
 * POST /api/users/me/mfa/setup
 */
router.post('/setup', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const email = req.user.email;
    if (!email) {
      return res.status(400).json({ code: 1051, message: '用户邮箱不存在' });
    }

    const result = await mfaService.setupMFA(req.user.id, email);

    // 注意：secret 和 recoveryCodes 仅在此返回一次
    res.json({
      success: true,
      data: {
        secret: result.secret,
        qrCodeDataUrl: result.qrCodeDataUrl,
        otpauthUrl: result.otpauthUrl,
        recoveryCodes: result.recoveryCodes
      },
      warning: '请妥善保管密钥和恢复码，这是唯一一次显示'
    });
  } catch (error) {
    logger.error('MFA setup failed', { userId: req.user?.id, error: error.message });
    
    if (error.message.includes('already enabled')) {
      return res.status(400).json({ code: 1052, message: 'MFA 已启用，请先禁用后再重新设置' });
    }
    
    res.status(500).json({ code: 1053, message: 'MFA 设置失败' });
  }
});

/**
 * 验证并启用 MFA
 * POST /api/users/me/mfa/enable
 */
router.post('/enable', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const { code } = req.body;
    
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ code: 1054, message: '请输入 6 位验证码' });
    }

    const result = await mfaService.enableMFA(req.user.id, code);

    res.json({
      success: true,
      message: 'MFA 启用成功',
      data: {
        enabled: true,
        enabledAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('MFA enable failed', { userId: req.user?.id, error: error.message });
    
    if (error.message.includes('Invalid TOTP code')) {
      return res.status(400).json({ 
        code: 1055, 
        message: error.message 
      });
    }
    
    if (error.message.includes('locked')) {
      return res.status(429).json({ 
        code: 1056, 
        message: 'MFA 验证已锁定，请稍后再试' 
      });
    }
    
    res.status(500).json({ code: 1057, message: 'MFA 启用失败' });
  }
});

/**
 * 禁用 MFA（需要 MFA 验证）
 * POST /api/users/me/mfa/disable
 */
router.post('/disable', mfaRequired(), async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ code: 1058, message: '请输入验证码或恢复码' });
    }

    const result = await mfaService.disableMFA(req.user.id, code);

    res.json({
      success: true,
      message: 'MFA 已禁用'
    });
  } catch (error) {
    logger.error('MFA disable failed', { userId: req.user?.id, error: error.message });
    
    if (error.message.includes('Invalid MFA code')) {
      return res.status(400).json({ code: 1059, message: '验证码无效' });
    }
    
    res.status(500).json({ code: 1060, message: 'MFA 禁用失败' });
  }
});

/**
 * 获取恢复码状态
 * GET /api/users/me/mfa/recovery-codes
 */
router.get('/recovery-codes', mfaRequired(), async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const status = await mfaService.getRecoveryCodesStatus(req.user.id);

    res.json({
      success: true,
      data: {
        total: status.total,
        remaining: status.remaining,
        used: status.total - status.remaining
      }
    });
  } catch (error) {
    logger.error('Failed to get recovery codes status', { error: error.message });
    res.status(500).json({ code: 1061, message: '获取恢复码状态失败' });
  }
});

/**
 * 重新生成恢复码（需要 MFA 验证）
 * POST /api/users/me/mfa/recovery-codes/regenerate
 */
router.post('/recovery-codes/regenerate', mfaRequired(), async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ code: 1062, message: '请输入验证码' });
    }

    const result = await mfaService.regenerateRecoveryCodes(req.user.id, code);

    res.json({
      success: true,
      data: {
        recoveryCodes: result.recoveryCodes
      },
      warning: '请妥善保管新的恢复码，旧的恢复码已失效'
    });
  } catch (error) {
    logger.error('Failed to regenerate recovery codes', { error: error.message });
    
    if (error.message.includes('Invalid MFA code')) {
      return res.status(400).json({ code: 1063, message: '验证码无效' });
    }
    
    res.status(500).json({ code: 1064, message: '重新生成恢复码失败' });
  }
});

/**
 * MFA 验证（登录时）
 * POST /api/auth/mfa/verify
 */
router.post('/verify', async (req, res) => {
  try {
    const { userId, code, deviceFingerprint, rememberDevice } = req.body;
    
    if (!userId || !code) {
      return res.status(400).json({ 
        code: 1065, 
        message: '缺少必要参数' 
      });
    }

    // 验证 MFA
    const valid = await mfaService.verifyMFA(
      userId, 
      code, 
      deviceFingerprint, 
      rememberDevice
    );

    if (!valid) {
      return res.status(401).json({ 
        code: 1066, 
        message: '验证码无效' 
      });
    }

    // 生成 MFA token（用于后续敏感操作）
    const mfaToken = generateMfaToken(userId);

    res.json({
      success: true,
      data: {
        verified: true,
        mfaToken,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    logger.error('MFA verification failed', { error: error.message });
    
    if (error.message.includes('locked')) {
      return res.status(429).json({ 
        code: 1067, 
        message: 'MFA 验证已锁定，请稍后再试' 
      });
    }
    
    res.status(500).json({ code: 1068, message: 'MFA 验证失败' });
  }
});

/**
 * 使用恢复码验证
 * POST /api/auth/mfa/recovery
 */
router.post('/recovery', async (req, res) => {
  try {
    const { userId, code } = req.body;
    
    if (!userId || !code) {
      return res.status(400).json({ 
        code: 1069, 
        message: '缺少必要参数' 
      });
    }

    const valid = await mfaService.verifyMFA(userId, code);

    if (!valid) {
      return res.status(401).json({ 
        code: 1070, 
        message: '恢复码无效或已使用' 
      });
    }

    const mfaToken = generateMfaToken(userId);

    // 获取剩余恢复码数量
    const status = await mfaService.getRecoveryCodesStatus(userId);

    res.json({
      success: true,
      data: {
        verified: true,
        mfaToken,
        recoveryCodesRemaining: status.remaining,
        warning: status.remaining <= 2 
          ? `警告：仅剩 ${status.remaining} 个恢复码，建议重新生成` 
          : undefined
      }
    });
  } catch (error) {
    logger.error('Recovery code verification failed', { error: error.message });
    res.status(500).json({ code: 1071, message: '恢复码验证失败' });
  }
});

/**
 * 检查设备是否受信任
 * POST /api/auth/mfa/check-device
 */
router.post('/check-device', async (req, res) => {
  try {
    const { userId, deviceFingerprint } = req.body;
    
    if (!userId || !deviceFingerprint) {
      return res.status(400).json({ 
        code: 1072, 
        message: '缺少必要参数' 
      });
    }

    const isTrusted = await mfaService.isTrustedDevice(userId, deviceFingerprint);

    res.json({
      success: true,
      data: {
        isTrusted
      }
    });
  } catch (error) {
    logger.error('Failed to check trusted device', { error: error.message });
    res.status(500).json({ code: 1073, message: '检查设备失败' });
  }
});

/**
 * 删除受信任设备
 * DELETE /api/users/me/mfa/trusted-devices
 */
router.delete('/trusted-devices', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }

    const db = require('../../shared/db');
    await db.query(
      'DELETE FROM mfa_trusted_devices WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      message: '已清除所有受信任设备'
    });
  } catch (error) {
    logger.error('Failed to delete trusted devices', { error: error.message });
    res.status(500).json({ code: 1074, message: '删除受信任设备失败' });
  }
});

module.exports = router;
