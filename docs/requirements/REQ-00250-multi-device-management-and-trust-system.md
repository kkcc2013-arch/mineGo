# REQ-00250: 多设备登录管理与设备信任系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00250 |
| 标题 | 多设备登录管理与设备信任系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、game-client、backend/shared、database/migrations、admin-dashboard |
| 创建时间 | 2026-06-16 08:00 |

## 需求描述

实现完整的多设备登录管理与设备信任系统，让用户能够查看、管理和控制所有登录设备，同时系统自动识别可疑设备并建立信任等级机制，提升账号安全性和用户体验。

### 核心功能
1. **设备指纹识别**：采集设备特征生成唯一指纹
2. **设备信任等级**：根据历史行为自动评估信任等级
3. **多设备管理**：用户可查看、删除、冻结已登录设备
4. **异常检测告警**：检测异地登录、新设备登录等异常行为
5. **新设备验证**：新设备登录需要二次验证
6. **设备登录历史**：记录设备登录轨迹与活动时间线

### 业务价值
- 降低账号被盗风险 80%
- 提升用户安全感知和控制力
- 减少 60% 的客服账号安全投诉
- 符合安全最佳实践和合规要求

## 技术方案

### 1. 设备指纹识别引擎

**位置**: `backend/shared/DeviceFingerprint.js`

```javascript
/**
 * 设备指纹生成器
 * 采集多维度设备特征生成唯一指纹
 */
class DeviceFingerprint {
  constructor() {
    this.fingerprintVersion = '1.0';
  }

  /**
   * 生成设备指纹
   * @param {Object} deviceInfo - 设备信息
   * @returns {string} SHA-256 指纹哈希
   */
  generate(deviceInfo) {
    const components = [
      deviceInfo.userAgent || '',
      deviceInfo.screenResolution || '',
      deviceInfo.timezone || '',
      deviceInfo.language || '',
      deviceInfo.platform || '',
      deviceInfo.hardwareConcurrency || '',
      deviceInfo.deviceMemory || '',
      deviceInfo.touchSupport || '',
      deviceInfo.canvasFingerprint || '',
      deviceInfo.webglFingerprint || '',
      deviceInfo.audioFingerprint || ''
    ];

    const rawFingerprint = components.join('|');
    return crypto.createHash('sha256').update(rawFingerprint).digest('hex');
  }

  /**
   * 客户端采集设备信息
   */
  static collectClientInfo() {
    return {
      userAgent: navigator.userAgent,
      screenResolution: `${screen.width}x${screen.height}x${screen.colorDepth}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
      deviceMemory: navigator.deviceMemory || 0,
      touchSupport: 'ontouchstart' in window,
      canvasFingerprint: this.getCanvasFingerprint(),
      webglFingerprint: this.getWebGLFingerprint(),
      audioFingerprint: this.getAudioFingerprint()
    };
  }

  static getCanvasFingerprint() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('device-fingerprint', 2, 2);
    return canvas.toDataURL();
  }

  static getWebGLFingerprint() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return '';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';
  }

  static getAudioFingerprint() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const analyser = audioContext.createAnalyser();
    const gain = audioContext.createGain();
    const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    gain.gain.value = 0;
    oscillator.connect(analyser);
    analyser.connect(scriptProcessor);
    scriptProcessor.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.type = 'triangle';
    oscillator.frequency.value = 10000;

    return audioContext.sampleRate.toString();
  }

  /**
   * 计算指纹相似度（判断是否为相似设备）
   * @param {string} fp1 - 指纹1
   * @param {string} fp2 - 指纹2
   * @returns {number} 相似度 0-1
   */
  calculateSimilarity(fp1, fp2) {
    if (fp1 === fp2) return 1.0;
    
    // 计算汉明距离
    let differences = 0;
    const len = Math.min(fp1.length, fp2.length);
    
    for (let i = 0; i < len; i++) {
      if (fp1[i] !== fp2[i]) differences++;
    }
    
    return 1 - (differences / len);
  }
}

module.exports = DeviceFingerprint;
```

### 2. 设备信任等级系统

**位置**: `backend/shared/DeviceTrustManager.js`

```javascript
/**
 * 设备信任管理器
 * 根据设备行为历史自动评估信任等级
 */
class DeviceTrustManager {
  constructor() {
    // 信任等级定义
    this.trustLevels = {
      UNTRUSTED: 0,    // 新设备/可疑设备
      LOW: 1,          // 少量历史记录
      MEDIUM: 2,       // 正常使用设备
      HIGH: 3,         // 长期信任设备
      VERIFIED: 4      // 已验证设备（通过MFA等）
    };

    // 信任评分规则
    this.trustFactors = {
      accountAge: { weight: 0.15, maxScore: 100 },
      loginCount: { weight: 0.20, maxScore: 100 },
      successfulActions: { weight: 0.25, maxScore: 100 },
      mfaVerified: { weight: 0.25, maxScore: 100 },
      consistentLocation: { weight: 0.15, maxScore: 100 }
    };
  }

  /**
   * 计算设备信任评分
   * @param {Object} deviceHistory - 设备历史记录
   * @returns {Object} { score, level, factors }
   */
  calculateTrustScore(deviceHistory) {
    const factors = {};
    let totalScore = 0;

    // 账号年龄因素
    factors.accountAge = this._calculateAgeScore(deviceHistory.accountAge);
    totalScore += factors.accountAge * this.trustFactors.accountAge.weight;

    // 登录次数因素
    factors.loginCount = this._calculateLoginScore(deviceHistory.loginCount);
    totalScore += factors.loginCount * this.trustFactors.loginCount.weight;

    // 成功操作因素
    factors.successfulActions = this._calculateActionScore(
      deviceHistory.successfulActions,
      deviceHistory.failedActions
    );
    totalScore += factors.successfulActions * this.trustFactors.successfulActions.weight;

    // MFA 验证因素
    factors.mfaVerified = deviceHistory.mfaVerified ? 100 : 0;
    totalScore += factors.mfaVerified * this.trustFactors.mfaVerified.weight;

    // 地理位置一致性因素
    factors.consistentLocation = this._calculateLocationScore(
      deviceHistory.locations
    );
    totalScore += factors.consistentLocation * this.trustFactors.consistentLocation.weight;

    // 确定信任等级
    const level = this._determineLevel(totalScore);

    return {
      score: Math.round(totalScore),
      level,
      levelName: this._getLevelName(level),
      factors
    };
  }

  _calculateAgeScore(ageDays) {
    if (ageDays >= 365) return 100;
    if (ageDays >= 180) return 80;
    if (ageDays >= 90) return 60;
    if (ageDays >= 30) return 40;
    if (ageDays >= 7) return 20;
    return 0;
  }

  _calculateLoginScore(loginCount) {
    if (loginCount >= 100) return 100;
    if (loginCount >= 50) return 80;
    if (loginCount >= 20) return 60;
    if (loginCount >= 10) return 40;
    if (loginCount >= 5) return 20;
    return 0;
  }

  _calculateActionScore(successCount, failCount) {
    if (successCount === 0 && failCount === 0) return 0;
    
    const total = successCount + failCount;
    const successRate = (successCount / total) * 100;
    
    // 成功率权重 70%，次数权重 30%
    const rateScore = successRate * 0.7;
    const countScore = Math.min(100, total * 0.3);
    
    return Math.round(rateScore + countScore);
  }

  _calculateLocationScore(locations) {
    if (!locations || locations.length === 0) return 50;
    
    // 计算位置集中度
    const uniqueLocations = [...new Set(locations)];
    const concentration = 1 - (uniqueLocations.length / locations.length);
    
    // 集中度越高，评分越高
    return Math.round(concentration * 100);
  }

  _determineLevel(score) {
    if (score >= 90) return this.trustLevels.VERIFIED;
    if (score >= 70) return this.trustLevels.HIGH;
    if (score >= 50) return this.trustLevels.MEDIUM;
    if (score >= 30) return this.trustLevels.LOW;
    return this.trustLevels.UNTRUSTED;
  }

  _getLevelName(level) {
    const names = ['UNTRUSTED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED'];
    return names[level];
  }

  /**
   * 检查设备是否需要额外验证
   * @param {number} trustLevel - 信任等级
   * @param {Object} context - 登录上下文
   * @returns {Object} { required, methods }
   */
  requireAdditionalVerification(trustLevel, context) {
    const verification = { required: false, methods: [] };

    // 新设备或低信任设备
    if (trustLevel <= this.trustLevels.LOW) {
      verification.required = true;
      verification.methods.push('email', 'sms');
    }

    // 异地登录检测
    if (context.isNewLocation && trustLevel < this.trustLevels.HIGH) {
      verification.required = true;
      verification.methods.push('email');
    }

    // 敏感操作
    if (context.isSensitiveAction && trustLevel < this.trustLevels.VERIFIED) {
      verification.required = true;
      verification.methods.push('mfa');
    }

    return verification;
  }
}

module.exports = DeviceTrustManager;
```

### 3. 设备管理服务

**位置**: `backend/services/user-service/src/routes/deviceManagement.js`

```javascript
const express = require('express');
const router = express.Router();
const { authenticate, optionalAuth } = require('../middleware/auth');
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
        [deviceInfo.ipAddress, deviceInfo.location, deviceInfo.userAgent, device.id]
      );

      res.json({
        deviceId: device.id,
        fingerprint: deviceFingerprint,
        isNew: false,
        trustLevel: device.trust_level
      });
    } else {
      // 注册新设备
      const result = await db.query(
        `INSERT INTO user_devices 
         (user_id, fingerprint, device_name, device_type, ip_address, 
          location, user_agent, trust_level, first_seen_at, last_seen_at, login_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NOW(), NOW(), 1)
         RETURNING id, trust_level`,
        [userId, deviceFingerprint, deviceInfo.deviceName, deviceInfo.deviceType,
         deviceInfo.ipAddress, deviceInfo.location, deviceInfo.userAgent]
      );

      const device = result.rows[0];

      // 发送新设备登录通知
      await sendNewDeviceNotification(userId, deviceInfo);

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
      trustLevelName: trustManager._getLevelName(device.trust_level),
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
      locations: history.rows.map(h => h.location)
    };

    const trustScore = trustManager.calculateTrustScore(deviceHistory);

    res.json({
      device: {
        ...device,
        trustLevelName: trustManager._getLevelName(device.trust_level)
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
    await redis.del(`session:${userId}:device:${deviceId}`);

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
    await redis.del(`session:${userId}:device:${deviceId}`);

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
async function sendNewDeviceNotification(userId, deviceInfo) {
  // 发送邮件/短信通知
  const user = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (user.rows.length > 0) {
    // TODO: 集成邮件服务发送通知
    logger.info('New device login notification sent', { userId, device: deviceInfo.deviceName });
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
  const result = await db.query(
    `SELECT COUNT(*) as count FROM device_activity_log 
     WHERE device_id = $1 AND action NOT LIKE '%failed%'`,
    [deviceId]
  );
  return parseInt(result.rows[0].count);
}

async function getFailedActionCount(deviceId) {
  const result = await db.query(
    `SELECT COUNT(*) as count FROM device_activity_log 
     WHERE device_id = $1 AND action LIKE '%failed%'`,
    [deviceId]
  );
  return parseInt(result.rows[0].count);
}

async function verifyMFA(userId, code) {
  // TODO: 集成 MFA 服务验证
  return true;
}

module.exports = router;
```

### 4. 数据库迁移脚本

**位置**: `database/migrations/20260616_080000__add_device_management_system.sql`

```sql
-- 设备管理表
CREATE TABLE user_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50), -- 'mobile', 'tablet', 'desktop'
  ip_address INET,
  location VARCHAR(255),
  user_agent TEXT,
  trust_level INTEGER DEFAULT 0, -- 0-4
  is_verified BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  is_frozen BOOLEAN DEFAULT false,
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW(),
  login_count INTEGER DEFAULT 1,
  verified_at TIMESTAMP,
  frozen_at TIMESTAMP,
  frozen_reason VARCHAR(255),
  unfrozen_at TIMESTAMP,
  revoked_at TIMESTAMP,
  revoked_reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id, fingerprint)
);

-- 设备活动日志表
CREATE TABLE device_activity_log (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  ip_address INET,
  location VARCHAR(255),
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX idx_user_devices_fingerprint ON user_devices(fingerprint);
CREATE INDEX idx_user_devices_trust_level ON user_devices(trust_level);
CREATE INDEX idx_user_devices_last_seen ON user_devices(last_seen_at DESC);
CREATE INDEX idx_device_activity_log_device_id ON device_activity_log(device_id);
CREATE INDEX idx_device_activity_log_user_id ON device_activity_log(user_id);
CREATE INDEX idx_device_activity_log_created_at ON device_activity_log(created_at DESC);

-- 注释
COMMENT ON TABLE user_devices IS '用户设备管理表 - 存储用户登录设备信息与信任等级';
COMMENT ON TABLE device_activity_log IS '设备活动日志表 - 记录设备所有操作行为';
COMMENT ON COLUMN user_devices.trust_level IS '信任等级: 0=UNTRUSTED, 1=LOW, 2=MEDIUM, 3=HIGH, 4=VERIFIED';
COMMENT ON COLUMN user_devices.fingerprint IS '设备指纹 SHA-256 哈希值';
```

### 5. 异常设备检测中间件

**位置**: `backend/gateway/src/middleware/deviceAnomalyDetector.js`

```javascript
const logger = require('../../../shared/logger');
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');

/**
 * 设备异常检测中间件
 */
class DeviceAnomalyDetector {
  constructor() {
    this.anomalyThresholds = {
      maxDevicesPerUser: 10,
      maxFailedLoginsPerDevice: 5,
      maxLocationsPerDay: 3,
      suspiciousIpPatterns: []
    };
  }

  async detect(req, res, next) {
    try {
      const userId = req.user?.id;
      const deviceFingerprint = req.headers['x-device-fingerprint'];
      const ipAddress = req.ip;
      const location = req.headers['x-location'];

      if (!userId || !deviceFingerprint) {
        return next();
      }

      // 异步检测异常（不阻塞请求）
      this._checkAnomalies(userId, deviceFingerprint, ipAddress, location).catch(err => {
        logger.error('Device anomaly check failed', { error: err.message });
      });

      next();
    } catch (error) {
      logger.error('Device anomaly detector error', { error: error.message });
      next();
    }
  }

  async _checkAnomalies(userId, fingerprint, ipAddress, location) {
    const anomalies = [];

    // 检查设备数量
    const deviceCount = await db.query(
      `SELECT COUNT(*) FROM user_devices WHERE user_id = $1 AND is_active = true`,
      [userId]
    );
    if (parseInt(deviceCount.rows[0].count) > this.anomalyThresholds.maxDevicesPerUser) {
      anomalies.push('too_many_devices');
    }

    // 检查失败登录次数
    const failedLogins = await redis.get(`failed_login:${fingerprint}`);
    if (failedLogins && parseInt(failedLogins) > this.anomalyThresholds.maxFailedLoginsPerDevice) {
      anomalies.push('too_many_failed_logins');
    }

    // 检查位置变化
    const today = new Date().toISOString().split('T')[0];
    const locations = await redis.smembers(`locations:${userId}:${today}`);
    if (locations.length > this.anomalyThresholds.maxLocationsPerDay) {
      anomalies.push('too_many_locations');
    }

    // 记录当前位置
    if (location) {
      await redis.sadd(`locations:${userId}:${today}`, location);
      await redis.expire(`locations:${userId}:${today}`, 86400);
    }

    // 如果发现异常，记录并告警
    if (anomalies.length > 0) {
      logger.warn('Device anomalies detected', { userId, fingerprint, anomalies, ipAddress, location });
      
      // 记录到数据库
      await db.query(
        `INSERT INTO device_activity_log (device_id, user_id, action, ip_address, location, metadata)
         SELECT id, $1, 'anomaly_detected', $2, $3, $4
         FROM user_devices 
         WHERE user_id = $1 AND fingerprint = $5`,
        [userId, ipAddress, location, JSON.stringify({ anomalies }), fingerprint]
      );

      // 发送告警（可通过 WebSocket 推送给用户）
      await redis.publish('device:anomaly', JSON.stringify({
        userId,
        fingerprint,
        anomalies,
        timestamp: Date.now()
      }));
    }
  }
}

module.exports = new DeviceAnomalyDetector();
```

### 6. 前端设备管理组件

**位置**: `frontend/game-client/src/components/DeviceManager.js`

```javascript
/**
 * 设备管理组件
 * 展示用户所有登录设备，支持删除、冻结等操作
 */
class DeviceManager {
  constructor(container) {
    this.container = container;
    this.devices = [];
    this.currentDeviceId = null;
  }

  async init() {
    await this.loadDevices();
    this.render();
    this.bindEvents();
  }

  async loadDevices() {
    try {
      const response = await fetch('/api/devices', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'X-Device-Fingerprint': await this.getDeviceFingerprint()
        }
      });
      
      const data = await response.json();
      this.devices = data.devices;
      this.currentDeviceId = this.devices.find(d => d.isCurrent)?.id;
    } catch (error) {
      console.error('Failed to load devices:', error);
      this.showError('Failed to load devices');
    }
  }

  async getDeviceFingerprint() {
    const deviceInfo = {
      userAgent: navigator.userAgent,
      screenResolution: `${screen.width}x${screen.height}x${screen.colorDepth}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
      deviceMemory: navigator.deviceMemory || 0,
      touchSupport: 'ontouchstart' in window
    };

    const rawFingerprint = Object.values(deviceInfo).join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(rawFingerprint);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  render() {
    const html = `
      <div class="device-manager">
        <div class="device-manager__header">
          <h2>Device Management</h2>
          <span class="device-manager__count">${this.devices.length} devices</span>
        </div>
        
        <div class="device-manager__list">
          ${this.devices.map(device => this.renderDevice(device)).join('')}
        </div>
        
        <div class="device-manager__info">
          <p><strong>Trust Levels:</strong></p>
          <ul>
            <li><span class="trust-badge trust-badge--verified">VERIFIED</span> - Passed MFA verification</li>
            <li><span class="trust-badge trust-badge--high">HIGH</span> - Frequently used device</li>
            <li><span class="trust-badge trust-badge--medium">MEDIUM</span> - Normal device</li>
            <li><span class="trust-badge trust-badge--low">LOW</span> - New device</li>
            <li><span class="trust-badge trust-badge--untrusted">UNTRUSTED</span> - Suspicious device</li>
          </ul>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
  }

  renderDevice(device) {
    const isCurrentDevice = device.id === this.currentDeviceId;
    const deviceIcon = this.getDeviceIcon(device.device_type);
    
    return `
      <div class="device-card ${isCurrentDevice ? 'device-card--current' : ''}" data-device-id="${device.id}">
        <div class="device-card__header">
          ${deviceIcon}
          <div class="device-card__info">
            <h3>${device.device_name || 'Unknown Device'}</h3>
            <span class="device-card__location">${device.location || 'Unknown Location'}</span>
          </div>
          <span class="trust-badge trust-badge--${device.trustLevelName.toLowerCase()}">${device.trustLevelName}</span>
        </div>
        
        <div class="device-card__details">
          <div class="device-card__detail">
            <span class="device-card__label">IP Address:</span>
            <span class="device-card__value">${device.ip_address || 'Unknown'}</span>
          </div>
          <div class="device-card__detail">
            <span class="device-card__label">Last Active:</span>
            <span class="device-card__value">${device.lastSeenRelative}</span>
          </div>
          <div class="device-card__detail">
            <span class="device-card__label">Login Count:</span>
            <span class="device-card__value">${device.login_count}</span>
          </div>
          ${device.is_verified ? '<span class="device-card__verified">✓ Verified</span>' : ''}
        </div>
        
        <div class="device-card__actions">
          ${!isCurrentDevice ? `
            <button class="btn btn--danger" data-action="delete" data-device-id="${device.id}">
              Remove Device
            </button>
            ${device.trust_level < 3 ? `
              <button class="btn btn--warning" data-action="freeze" data-device-id="${device.id}">
                Freeze Device
              </button>
            ` : ''}
          ` : `
            <span class="device-card__current-badge">Current Device</span>
          `}
          <button class="btn btn--secondary" data-action="details" data-device-id="${device.id}">
            View Details
          </button>
        </div>
      </div>
    `;
  }

  getDeviceIcon(deviceType) {
    const icons = {
      mobile: '📱',
      tablet: '📟',
      desktop: '💻',
      unknown: '🔌'
    };
    return `<span class="device-card__icon">${icons[deviceType] || icons.unknown}</span>`;
  }

  bindEvents() {
    this.container.addEventListener('click', async (e) => {
      const button = e.target.closest('button[data-action]');
      if (!button) return;

      const action = button.dataset.action;
      const deviceId = button.dataset.deviceId;

      switch (action) {
        case 'delete':
          await this.deleteDevice(deviceId);
          break;
        case 'freeze':
          await this.freezeDevice(deviceId);
          break;
        case 'details':
          await this.showDeviceDetails(deviceId);
          break;
      }
    });
  }

  async deleteDevice(deviceId) {
    if (!confirm('Are you sure you want to remove this device? The device will be logged out.')) {
      return;
    }

    try {
      const response = await fetch(`/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        await this.loadDevices();
        this.render();
        this.showSuccess('Device removed successfully');
      } else {
        throw new Error('Failed to delete device');
      }
    } catch (error) {
      console.error('Delete device error:', error);
      this.showError('Failed to delete device');
    }
  }

  async freezeDevice(deviceId) {
    if (!confirm('Are you sure you want to freeze this device? The device will be temporarily blocked.')) {
      return;
    }

    try {
      const response = await fetch(`/api/devices/${deviceId}/freeze`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'user_initiated' })
      });

      if (response.ok) {
        await this.loadDevices();
        this.render();
        this.showSuccess('Device frozen successfully');
      } else {
        throw new Error('Failed to freeze device');
      }
    } catch (error) {
      console.error('Freeze device error:', error);
      this.showError('Failed to freeze device');
    }
  }

  async showDeviceDetails(deviceId) {
    // TODO: 实现设备详情弹窗
    console.log('Show device details:', deviceId);
  }

  showSuccess(message) {
    // TODO: 实现成功提示
    alert(message);
  }

  showError(message) {
    // TODO: 实现错误提示
    alert(message);
  }
}

module.exports = DeviceManager;
```

### 7. 管理后台设备管理页面

**位置**: `frontend/admin-dashboard/src/pages/DeviceManagement.jsx`

```jsx
import React, { useState, useEffect } from 'react';
import { Line, Pie } from 'react-chartjs-2';

export default function DeviceManagement() {
  const [stats, setStats] = useState(null);
  const [anomalies, setAnomalies] = useState([]);

  useEffect(() => {
    loadStats();
    loadAnomalies();
    
    // 实时更新异常告警
    const interval = setInterval(loadAnomalies, 5000);
    return () => clearInterval(interval);
  }, []);

  async function loadStats() {
    const response = await fetch('/api/admin/devices/stats');
    const data = await response.json();
    setStats(data);
  }

  async function loadAnomalies() {
    const response = await fetch('/api/admin/devices/anomalies?limit=20');
    const data = await response.json();
    setAnomalies(data.anomalies);
  }

  return (
    <div className="device-management">
      <h1>Device Management Dashboard</h1>
      
      {/* 统计卡片 */}
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total Devices</h3>
          <p className="stat-value">{stats?.totalDevices || 0}</p>
        </div>
        <div className="stat-card">
          <h3>Active Devices</h3>
          <p className="stat-value">{stats?.activeDevices || 0}</p>
        </div>
        <div className="stat-card">
          <h3>Verified Devices</h3>
          <p className="stat-value">{stats?.verifiedDevices || 0}</p>
        </div>
        <div className="stat-card stat-card--danger">
          <h3>Anomalies Today</h3>
          <p className="stat-value">{anomalies.length}</p>
        </div>
      </div>

      {/* 信任等级分布 */}
      <div className="chart-container">
        <h2>Trust Level Distribution</h2>
        <Pie data={stats?.trustDistribution} />
      </div>

      {/* 设备类型分布 */}
      <div className="chart-container">
        <h2>Device Type Distribution</h2>
        <Pie data={stats?.deviceTypeDistribution} />
      </div>

      {/* 异常告警列表 */}
      <div className="anomaly-list">
        <h2>Recent Anomalies</h2>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Device</th>
              <th>Anomaly Type</th>
              <th>IP Address</th>
              <th>Location</th>
              <th>Time</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {anomalies.map(anomaly => (
              <tr key={anomaly.id}>
                <td>{anomaly.userEmail}</td>
                <td>{anomaly.deviceName}</td>
                <td>{anomaly.anomalies.join(', ')}</td>
                <td>{anomaly.ipAddress}</td>
                <td>{anomaly.location}</td>
                <td>{new Date(anomaly.timestamp).toLocaleString()}</td>
                <td>
                  <button onClick={() => freezeDevice(anomaly.deviceId)}>
                    Freeze
                  </button>
                  <button onClick={() => notifyUser(anomaly.userId)}>
                    Notify User
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  async function freezeDevice(deviceId) {
    await fetch(`/api/admin/devices/${deviceId}/freeze`, { method: 'POST' });
    loadAnomalies();
  }

  async function notifyUser(userId) {
    await fetch(`/api/admin/users/${userId}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Security alert: suspicious device activity detected' })
    });
  }
}
```

## 验收标准

- [ ] 设备指纹生成成功率 ≥ 99%
- [ ] 指纹碰撞率 < 0.01%
- [ ] 设备管理接口响应时间 < 200ms
- [ ] 信任评分计算准确性 ≥ 95%
- [ ] 新设备登录通知发送成功率 100%
- [ ] 异常设备检测准确率 ≥ 90%
- [ ] 设备删除后会话清除成功率 100%
- [ ] 前端设备列表加载时间 < 1s
- [ ] 管理后台实时告警延迟 < 5s
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖核心流程
- [ ] API 文档完整且准确

## 影响范围

### 新增文件
- `backend/shared/DeviceFingerprint.js` - 设备指纹生成器
- `backend/shared/DeviceTrustManager.js` - 设备信任管理器
- `backend/services/user-service/src/routes/deviceManagement.js` - 设备管理路由
- `backend/gateway/src/middleware/deviceAnomalyDetector.js` - 异常检测中间件
- `frontend/game-client/src/components/DeviceManager.js` - 前端设备管理组件
- `frontend/admin-dashboard/src/pages/DeviceManagement.jsx` - 管理后台页面
- `database/migrations/20260616_080000__add_device_management_system.sql` - 数据库迁移

### 修改文件
- `backend/services/user-service/src/index.js` - 挂载设备管理路由
- `backend/gateway/src/index.js` - 添加异常检测中间件
- `frontend/game-client/src/settings.js` - 添加设备管理入口
- `docs/api-spec/openapi.yml` - 更新 API 文档

### 数据库变更
- 新增 `user_devices` 表
- 新增 `device_activity_log` 表
- 新增相关索引

## 参考

- [FingerprintJS - Browser Fingerprinting](https://github.com/fingerprintjs/fingerprintjs)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Google Device Management Best Practices](https://support.google.com/accounts/answer/2519266)
- [Apple Two-Factor Authentication](https://support.apple.com/en-us/HT204915)
- [NIST Digital Identity Guidelines - SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html)
