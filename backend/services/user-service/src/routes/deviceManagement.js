'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../shared/authMiddleware');
const DeviceFingerprint = require('../../../shared/DeviceFingerprint');
const DeviceTrustManager = require('../../../shared/DeviceTrustManager');
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');
const logger = require('../../../shared/logger');

const fingerprint = new DeviceFingerprint();
const trustManager = new DeviceTrustManager();

/**
 * 注册/更新设备
 * POST /api/devices/register
 */
router.post('/register', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceInfo = req.body;
    
    // 生成设备指纹
    const deviceFingerprint = fingerprint.generate(deviceInfo);
    
    // 检查设备是否已存在
    const existingDevice = await db.query(
      `SELECT id, trust_level, last_seen_at 
       FROM user_devices 
       WHERE user_id = $1 AND fingerprint = $2`,
      [userId, deviceFingerprint]
    );

    if (existingDevice.rows.length > 0) {
      // 更新已有设备
      const device = existingDevice.rows[0];
      await db.query(
        `UPDATE user_devices 
         SET last_seen_at = NOW(), 
             login_count = login_count + 1,
             ip_address = $1,
             location = $2,
             user_agent = $3
         WHERE id = $4`,
        [deviceInfo.ipAddress || req.ip, deviceInfo.location, deviceInfo.userAgent, device.id]
      );

      res.json({
        deviceId: device.id,
        fingerprint: deviceFingerprint,
        isNew: false,
        trustLevel: device.trust_level
      });
    } else {
      // 注册新设备
      const deviceType = fingerprint.extractDeviceType(deviceInfo.userAgent);
      const deviceName = fingerprint.extractDeviceName(deviceInfo);
      
      const result = await db.query(
        `INSERT INTO user_devices 
         (user_id, fingerprint, device_name, device_type, ip_address, 
          location, user_agent, trust_level, first_seen_at, last_seen_at, login_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NOW(), NOW(), 1)
         RETURNING id, trust_level`,
        [userId, deviceFingerprint, deviceInfo.deviceName || deviceName, deviceType,
         deviceInfo.ipAddress || req.ip, deviceInfo.location, deviceInfo.userAgent]
      );

      const device = result.rows[0];

      // 发送新设备登录通知
      await sendNewDeviceNotification(userId, deviceInfo, deviceName);

      res.json({
        deviceId: device.id,
        fingerprint: deviceFingerprint,
        isNew: true,
        trustLevel: device.trust_level,
        requiresVerification: true
      });
    }
  } catch (error) {
    logger.error('Device registration error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to register device' });
  }
});

/**
 * 获取用户所有设备
 * GET /api/devices
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      `SELECT 
        id, fingerprint, device_name, device_type, ip_address, 
        location, trust_level, first_seen_at, last_seen_at, 
        login_count, is_active, is_verified
       FROM user_devices 
       WHERE user_id = $1 AND is_active = true
       ORDER BY last_seen_at DESC`,
      [userId]
    );

    const devices = result.rows.map(device => ({
      ...device,
      trustLevelName: trustManager.getLevelName(device.trust_level),
      lastSeenRelative: getRelativeTime(device.last_seen_at)
    }));

    res.json({ devices, total: devices.length });
  } catch (error) {
    logger.error('Failed to fetch devices', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * 获取设备详情与信任评分
 * GET /api/devices/:deviceId
 */
router.get('/:deviceId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;

    const result = await db.query(
      `SELECT * FROM user_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = result.rows[0];

    // 获取设备历史记录
    const history = await db.query(
      `SELECT 
        action, ip_address, location, created_at
       FROM device_activity_log 
       WHERE device_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [deviceId]
    );

    // 计算信任评分
    const deviceHistory = {
      accountAge: Math.floor((Date.now() - new Date(device.first_seen_at)) / (1000 * 60 * 60 * 24)),
      loginCount: device.login_count,
      successfulActions: await getSuccessfulActionCount(deviceId),
      failedActions: await getFailedActionCount(deviceId),
      mfaVerified: device.is_verified,
      locations: history.rows.map(h => h.location).filter(l => l)
    };

    const trustScore = trustManager.calculateTrustScore(deviceHistory);

    res.json({
      device: {
        ...device,
        trustLevelName: trustManager.getLevelName(device.trust_level)
      },
      trustScore,
      history: history.rows
    });
  } catch (error) {
    logger.error('Failed to fetch device details', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch device details' });
  }
});

/**
 * 删除/登出设备
 * DELETE /api/devices/:deviceId
 */
router.delete('/:deviceId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;

    // 检查是否为当前设备
    const currentFingerprint = req.headers['x-device-fingerprint'];
    const device = await db.query(
      `SELECT fingerprint FROM user_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    if (device.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const isCurrentDevice = device.rows[0].fingerprint === currentFingerprint;

    // 软删除设备
    await db.query(
      `UPDATE user_devices 
       SET is_active = false, revoked_at = NOW(), revoked_reason = $1
       WHERE id = $2`,
      ['user_revoked', deviceId]
    );

    // 清除该设备的所有会话
    try {
      await redis.del(`session:${userId}:device:${deviceId}`);
    } catch (e) {
      logger.warn('Failed to clear device session from Redis', { error: e.message });
    }

    // 记录审计日志
    await db.query(
      `INSERT INTO device_activity_log 
       (device_id, user_id, action, ip_address)
       VALUES ($1, $2, 'device_revoked', $3)`,
      [deviceId, userId, req.ip]
    );

    res.json({ 
      success: true, 
      message: isCurrentDevice ? 'Current device logged out' : 'Device removed successfully',
      isCurrentDevice
    });
  } catch (error) {
    logger.error('Failed to delete device', { error: error.message });
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

/**
 * 冻结可疑设备
 * POST /api/devices/:deviceId/freeze
 */
router.post('/:deviceId/freeze', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;
    const { reason } = req.body;

    await db.query(
      `UPDATE user_devices 
       SET is_frozen = true, frozen_at = NOW(), frozen_reason = $1
       WHERE id = $2 AND user_id = $3`,
      [reason || 'user_initiated', deviceId, userId]
    );

    // 清除冻结设备的所有会话
    try {
      await redis.del(`session:${userId}:device:${deviceId}`);
    } catch (e) {
      logger.warn('Failed to clear device session from Redis', { error: e.message });
    }

    res.json({ success: true, message: 'Device frozen successfully' });
  } catch (error) {
    logger.error('Failed to freeze device', { error: error.message });
    res.status(500).json({ error: 'Failed to freeze device' });
  }
});

/**
 * 解冻设备
 * POST /api/devices/:deviceId/unfreeze
 */
router.post('/:deviceId/unfreeze', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;

    await db.query(
      `UPDATE user_devices 
       SET is_frozen = false, unfrozen_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    res.json({ success: true, message: 'Device unfrozen successfully' });
  } catch (error) {
    logger.error('Failed to unfreeze device', { error: error.message });
    res.status(500).json({ error: 'Failed to unfreeze device' });
  }
});

/**
 * 验证设备（通过 MFA）
 * POST /api/devices/:deviceId/verify
 */
router.post('/:deviceId/verify', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;
    const { mfaCode } = req.body;

    // 验证 MFA 代码
    const isValid = await verifyMFA(userId, mfaCode);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid MFA code' });
    }

    // 更新设备为已验证
    await db.query(
      `UPDATE user_devices 
       SET is_verified = true, verified_at = NOW(), trust_level = 4
       WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    res.json({ success: true, message: 'Device verified successfully' });
  } catch (error) {
    logger.error('Failed to verify device', { error: error.message });
    res.status(500).json({ error: 'Failed to verify device' });
  }
});

/**
 * 设备活动日志
 * GET /api/devices/:deviceId/activity
 */
router.get('/:deviceId/activity', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.params.deviceId;
    const { limit = 100, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT 
        action, ip_address, location, user_agent, 
        created_at, metadata
       FROM device_activity_log 
       WHERE device_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [deviceId, userId, limit, offset]
    );

    res.json({ 
      activities: result.rows, 
      total: result.rows.length 
    });
  } catch (error) {
    logger.error('Failed to fetch device activity', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch device activity' });
  }
});

// Helper functions
async function sendNewDeviceNotification(userId, deviceInfo, deviceName) {
  try {
    const user = await db.query('SELECT email, username FROM users WHERE id = $1', [userId]);
    if (user.rows.length > 0) {
      logger.info('New device login notification', { 
        userId, 
        email: user.rows[0].email,
        device: deviceName || deviceInfo.deviceName 
      });
      
      // TODO: 集成邮件服务发送通知
      // await emailService.send({
      //   to: user.rows[0].email,
      //   subject: '新设备登录通知',
      //   body: `您的账号在新设备 "${deviceName}" 上登录，如非本人操作请立即修改密码。`
      // });
    }
  } catch (e) {
    logger.error('Failed to send device notification', { error: e.message });
  }
}

function getRelativeTime(timestamp) {
  const now = Date.now();
  const time = new Date(timestamp).getTime();
  const diff = now - time;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'Just now';
}

async function getSuccessfulActionCount(deviceId) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) as count FROM device_activity_log 
       WHERE device_id = $1 AND action NOT LIKE '%failed%'`,
      [deviceId]
    );
    return parseInt(result.rows[0].count) || 0;
  } catch (e) {
    return 0;
  }
}

async function getFailedActionCount(deviceId) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) as count FROM device_activity_log 
       WHERE device_id = $1 AND action LIKE '%failed%'`,
      [deviceId]
    );
    return parseInt(result.rows[0].count) || 0;
  } catch (e) {
    return 0;
  }
}

async function verifyMFA(userId, code) {
  // TODO: 集成 MFA 服务验证
  // 这里简化实现，实际应调用 MFA 验证服务
  if (!code || code.length < 6) {
    return false;
  }
  
  try {
    const result = await db.query(
      `SELECT mfa_secret FROM user_mfa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      return false;
    }
    
    // TODO: 使用 speakeasy 或 otplib 验证 TOTP
    // const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: code });
    return true; // 临时返回 true，实际需要验证
  } catch (e) {
    logger.error('MFA verification error', { error: e.message });
    return false;
  }
}

module.exports = router;
