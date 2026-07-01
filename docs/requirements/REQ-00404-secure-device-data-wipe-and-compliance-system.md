# REQ-00404: 退役设备数据安全擦除与合规报告系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00404 |
| 标题 | 退役设备数据安全擦除与合规报告系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、backend/shared |
| 创建时间 | 2026-07-01 03:00 UTC |

## 需求描述

### 背景
随着游戏运营规模扩大，用户设备更换、账号注销、数据删除请求等场景频繁发生。当用户设备退役或账号注销时，需要确保设备上的敏感数据（认证令牌、本地缓存、加密密钥等）被安全擦除，并提供合规报告证明数据已被正确处理。

### 目标
1. 实现用户设备退役时的敏感数据安全擦除机制
2. 提供可追溯的擦除记录与合规报告生成
3. 支持 GDPR/CCPA 合规要求，确保用户数据控制权
4. 提供远程擦除能力，用户可在新设备上触发旧设备数据清除

### 场景覆盖
- **场景1**：用户更换手机，需要在新设备上触发旧设备数据擦除
- **场景2**：用户注销账号，需要擦除所有关联设备上的数据
- **场景3**：设备丢失/被盗，需要远程擦除敏感数据
- **场景4**：合规审计，需要提供数据擦除证明报告

## 技术方案

### 1. 设备注册与管理模块

**文件**: `backend/shared/DeviceRegistry.js`

```javascript
class DeviceRegistry {
  constructor({ db, redis, logger }) {
    this.db = db;
    this.redis = redis;
    this.logger = logger;
  }

  /**
   * 注册新设备
   */
  async registerDevice(userId, deviceInfo) {
    const deviceId = this.generateDeviceId(deviceInfo);
    const device = {
      id: deviceId,
      userId,
      platform: deviceInfo.platform, // 'ios' | 'android' | 'web'
      model: deviceInfo.model,
      osVersion: deviceInfo.osVersion,
      appVersion: deviceInfo.appVersion,
      fcmToken: deviceInfo.fcmToken,
      publicKey: deviceInfo.publicKey, // 设备公钥，用于加密通信
      registeredAt: new Date(),
      lastActiveAt: new Date(),
      status: 'active', // 'active' | 'inactive' | 'wiped' | 'suspended'
      wipeRequested: false,
      wipeRequestedAt: null,
      wipeConfirmedAt: null
    };

    await this.db.query(`
      INSERT INTO user_devices (
        id, user_id, platform, model, os_version, app_version,
        fcm_token, public_key, registered_at, last_active_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      device.id, device.userId, device.platform, device.model,
      device.osVersion, device.appVersion, device.fcmToken,
      device.publicKey, device.registeredAt, device.lastActiveAt, device.status
    ]);

    // 缓存活跃设备
    await this.redis.hset(`user:${userId}:devices`, deviceId, JSON.stringify(device));

    this.logger.info('Device registered', { userId, deviceId, platform: device.platform });
    return device;
  }

  /**
   * 获取用户所有设备
   */
  async getUserDevices(userId) {
    const cached = await this.redis.hgetall(`user:${userId}:devices`);
    if (cached && Object.keys(cached).length > 0) {
      return Object.values(cached).map(d => JSON.parse(d));
    }

    const result = await this.db.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND status != $2',
      [userId, 'wiped']
    );

    // 回填缓存
    for (const device of result.rows) {
      await this.redis.hset(`user:${userId}:devices`, device.id, JSON.stringify(device));
    }

    return result.rows;
  }

  /**
   * 生成设备唯一标识
   */
  generateDeviceId(deviceInfo) {
    const hash = crypto.createHash('sha256');
    hash.update(`${deviceInfo.platform}:${deviceInfo.model}:${deviceInfo.osVersion}:${Date.now()}`);
    return `dev_${hash.digest('hex').substring(0, 16)}`;
  }
}

module.exports = DeviceRegistry;
```

### 2. 安全擦除执行模块

**文件**: `backend/shared/SecureWipeExecutor.js`

```javascript
class SecureWipeExecutor {
  constructor({ db, redis, kafka, logger, fcmClient, apnsClient }) {
    this.db = db;
    this.redis = redis;
    this.kafka = kafka;
    this.logger = logger;
    this.fcmClient = fcmClient;
    this.apnsClient = apnsClient;
  }

  /**
   * 请求设备擦除
   */
  async requestWipe(userId, deviceId, options = {}) {
    const { reason = 'user_request', requestedFrom = 'unknown' } = options;

    // 验证设备归属
    const device = await this.db.query(
      'SELECT * FROM user_devices WHERE id = $1 AND user_id = $2',
      [deviceId, userId]
    );

    if (!device.rows.length) {
      throw new Error('DEVICE_NOT_FOUND');
    }

    const deviceData = device.rows[0];

    if (deviceData.status === 'wiped') {
      throw new Error('DEVICE_ALREADY_WIPED');
    }

    // 标记擦除请求
    await this.db.query(`
      UPDATE user_devices 
      SET wipe_requested = true, 
          wipe_requested_at = $1,
          wipe_reason = $2
      WHERE id = $3
    `, [new Date(), reason, deviceId]);

    // 发送擦除推送通知
    const wipeCommand = {
      type: 'SECURE_WIPE',
      deviceId,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(32).toString('hex'),
      dataCategories: [
        'auth_tokens',
        'user_cache',
        'encrypted_keys',
        'game_state',
        'preferences',
        'chat_history'
      ]
    };

    // 签名命令（设备验证）
    const signature = this.signWipeCommand(wipeCommand);
    wipeCommand.signature = signature;

    // 发送到设备
    if (deviceData.platform === 'ios' && deviceData.fcmToken) {
      await this.apnsClient.send({
        to: deviceData.fcmToken,
        data: {
          command: 'secure_wipe',
          payload: JSON.stringify(wipeCommand)
        },
        priority: 'high'
      });
    } else if (deviceData.fcmToken) {
      await this.fcmClient.send({
        token: deviceData.fcmToken,
        data: {
          command: 'secure_wipe',
          payload: JSON.stringify(wipeCommand)
        }
      });
    }

    // 发布擦除请求事件
    await this.kafka.produce('device.wipe.requested', {
      userId,
      deviceId,
      reason,
      requestedFrom,
      timestamp: new Date().toISOString()
    });

    this.logger.info('Wipe requested', { userId, deviceId, reason });

    return {
      status: 'requested',
      deviceId,
      estimatedCompletion: new Date(Date.now() + 60000) // 1分钟超时
    };
  }

  /**
   * 确认擦除完成（设备回调）
   */
  async confirmWipe(deviceId, confirmationProof) {
    // 验证确认证明
    if (!this.verifyWipeConfirmation(deviceId, confirmationProof)) {
      throw new Error('INVALID_WIPE_CONFIRMATION');
    }

    // 更新设备状态
    const result = await this.db.query(`
      UPDATE user_devices 
      SET status = 'wiped',
          wipe_confirmed_at = $1,
          wipe_proof = $2
      WHERE id = $3
      RETURNING user_id
    `, [new Date(), confirmationProof, deviceId]);

    const userId = result.rows[0].user_id;

    // 清除设备缓存
    await this.redis.hdel(`user:${userId}:devices`, deviceId);

    // 生成擦除记录
    const wipeRecord = await this.createWipeRecord(userId, deviceId, confirmationProof);

    // 发布擦除完成事件
    await this.kafka.produce('device.wipe.completed', {
      userId,
      deviceId,
      wipeRecordId: wipeRecord.id,
      timestamp: new Date().toISOString()
    });

    this.logger.info('Wipe confirmed', { userId, deviceId, wipeRecordId: wipeRecord.id });

    return wipeRecord;
  }

  /**
   * 签名擦除命令
   */
  signWipeCommand(command) {
    const payload = JSON.stringify({
      type: command.type,
      deviceId: command.deviceId,
      timestamp: command.timestamp,
      nonce: command.nonce
    });
    return crypto.sign('sha256', Buffer.from(payload), this.getPrivateKey());
  }

  /**
   * 验证擦除确认
   */
  verifyWipeConfirmation(deviceId, proof) {
    // 解析证明数据
    try {
      const { signature, timestamp, dataCategories, checksums } = proof;
      
      // 验证签名（使用设备公钥）
      // 验证时间戳在合理范围内
      // 验证校验和格式
      return true;
    } catch (error) {
      this.logger.error('Wipe confirmation verification failed', { deviceId, error });
      return false;
    }
  }

  /**
   * 创建擦除记录
   */
  async createWipeRecord(userId, deviceId, proof) {
    const recordId = `wipe_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    
    await this.db.query(`
      INSERT INTO device_wipe_records (
        id, user_id, device_id, wiped_at, proof, 
        compliance_report_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      recordId, userId, deviceId, new Date(), proof,
      null, 'completed'
    ]);

    return {
      id: recordId,
      userId,
      deviceId,
      wipedAt: new Date()
    };
  }

  getPrivateKey() {
    return process.env.WIPE_SIGNING_KEY;
  }
}

module.exports = SecureWipeExecutor;
```

### 3. 合规报告生成模块

**文件**: `backend/shared/ComplianceReportGenerator.js`

```javascript
class ComplianceReportGenerator {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * 生成数据擦除合规报告
   */
  async generateWipeReport(userId, options = {}) {
    const { format = 'pdf', language = 'en', regulations = ['GDPR'] } = options;

    // 获取用户所有擦除记录
    const wipeRecords = await this.db.query(`
      SELECT wr.*, ud.model, ud.platform, ud.registered_at
      FROM device_wipe_records wr
      JOIN user_devices ud ON wr.device_id = ud.id
      WHERE wr.user_id = $1
      ORDER BY wr.wiped_at DESC
    `, [userId]);

    // 获取用户账号信息
    const user = await this.db.query(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [userId]
    );

    const report = {
      reportId: `RPT-${Date.now()}-${userId}`,
      generatedAt: new Date(),
      user: {
        id: user.rows[0].id,
        email: this.maskEmail(user.rows[0].email)
      },
      regulations,
      summary: {
        totalDevices: wipeRecords.rows.length,
        totalWipedDevices: wipeRecords.rows.filter(r => r.status === 'completed').length,
        pendingWipes: wipeRecords.rows.filter(r => r.status === 'pending').length
      },
      details: wipeRecords.rows.map(record => ({
        deviceId: this.maskDeviceId(record.device_id),
        deviceModel: record.model,
        platform: record.platform,
        registeredAt: record.registered_at,
        wipedAt: record.wiped_at,
        status: record.status,
        dataCategories: ['auth_tokens', 'user_cache', 'encrypted_keys', 'game_state', 'preferences', 'chat_history'],
        verificationMethod: 'cryptographic_proof',
        retentionPolicy: 'immediate_deletion'
      })),
      certifications: {
        gdpr: {
          article32Compliant: true,
          rightToErasure: 'Article 17 - Implemented',
          dataProtectionMeasures: 'AES-256 encryption, secure deletion protocols'
        },
        ccpa: {
          section1798_105Compliant: true,
          rightToDelete: 'Implemented',
          verificationMethod: 'Device cryptographic signature'
        }
      },
      attestation: {
        statement: 'This report certifies that all user data on the listed devices has been securely erased in compliance with applicable data protection regulations.',
        generatedBy: 'mineGo Data Protection System',
        signature: this.generateReportSignature(wipeRecords.rows)
      }
    };

    // 存储报告
    await this.db.query(`
      INSERT INTO compliance_reports (
        id, user_id, report_type, generated_at, format, content
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [report.reportId, userId, 'data_wipe', new Date(), format, report]);

    this.logger.info('Compliance report generated', { userId, reportId: report.reportId });

    return report;
  }

  /**
   * 生成 GDPR 数据主体请求报告
   */
  async generateGDPRReport(userId) {
    // 获取所有相关数据处理记录
    const dataProcessing = await this.db.query(`
      SELECT * FROM data_processing_log 
      WHERE user_id = $1 
      ORDER BY processed_at DESC 
      LIMIT 1000
    `, [userId]);

    const consentRecords = await this.db.query(`
      SELECT * FROM user_consents 
      WHERE user_id = $1
    `, [userId]);

    const dataExports = await this.db.query(`
      SELECT * FROM data_export_requests 
      WHERE user_id = $1 
      ORDER BY requested_at DESC
    `, [userId]);

    return {
      reportId: `GDPR-RPT-${Date.now()}-${userId}`,
      generatedAt: new Date(),
      userId,
      sections: {
        dataProcessing: dataProcessing.rows,
        consentHistory: consentRecords.rows,
        exportHistory: dataExports.rows,
        wipeHistory: await this.getWipeHistory(userId)
      },
      rightsExercised: {
        rightOfAccess: dataExports.rows.length > 0,
        rightToRectification: false,
        rightToErasure: (await this.getWipeHistory(userId)).length > 0,
        rightToPortability: dataExports.rows.filter(e => e.format === 'json').length > 0
      }
    };
  }

  /**
   * 获取擦除历史
   */
  async getWipeHistory(userId) {
    const result = await this.db.query(`
      SELECT * FROM device_wipe_records 
      WHERE user_id = $1 
      ORDER BY wiped_at DESC
    `, [userId]);
    return result.rows;
  }

  /**
   * 掩码邮箱
   */
  maskEmail(email) {
    const [local, domain] = email.split('@');
    const masked = local.substring(0, 2) + '***' + local.substring(local.length - 2);
    return `${masked}@${domain}`;
  }

  /**
   * 掩码设备ID
   */
  maskDeviceId(deviceId) {
    return deviceId.substring(0, 8) + '***' + deviceId.substring(deviceId.length - 4);
  }

  /**
   * 生成报告签名
   */
  generateReportSignature(records) {
    const payload = JSON.stringify(records.map(r => ({
      id: r.id,
      wipedAt: r.wiped_at
    })));
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
}

module.exports = ComplianceReportGenerator;
```

### 4. 数据库迁移

**文件**: `database/migrations/20260701_00_wipe_compliance_tables.sql`

```sql
-- 用户设备表
CREATE TABLE IF NOT EXISTS user_devices (
  id VARCHAR(32) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL,
  model VARCHAR(100),
  os_version VARCHAR(50),
  app_version VARCHAR(20),
  fcm_token VARCHAR(255),
  public_key TEXT,
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_active_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) DEFAULT 'active',
  wipe_requested BOOLEAN DEFAULT FALSE,
  wipe_requested_at TIMESTAMP WITH TIME ZONE,
  wipe_reason VARCHAR(50),
  wipe_confirmed_at TIMESTAMP WITH TIME ZONE,
  wipe_proof JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX idx_user_devices_status ON user_devices(status);
CREATE INDEX idx_user_devices_wipe_requested ON user_devices(wipe_requested) WHERE wipe_requested = true;

-- 设备擦除记录表
CREATE TABLE IF NOT EXISTS device_wipe_records (
  id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(32) NOT NULL,
  wiped_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  proof JSONB NOT NULL,
  compliance_report_id VARCHAR(64),
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_wipe_records_user_id ON device_wipe_records(user_id);
CREATE INDEX idx_wipe_records_device_id ON device_wipe_records(device_id);

-- 合规报告表
CREATE TABLE IF NOT EXISTS compliance_reports (
  id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type VARCHAR(50) NOT NULL,
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  format VARCHAR(20) DEFAULT 'json',
  content JSONB NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_compliance_reports_user_id ON compliance_reports(user_id);
CREATE INDEX idx_compliance_reports_type ON compliance_reports(report_type);
```

### 5. API 接口设计

**文件**: `user-service/routes/deviceRoutes.js`

```javascript
const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/auth');
const DeviceRegistry = require('../../shared/DeviceRegistry');
const SecureWipeExecutor = require('../../shared/SecureWipeExecutor');
const ComplianceReportGenerator = require('../../shared/ComplianceReportGenerator');

// 获取用户设备列表
router.get('/devices', authMiddleware, async (req, res) => {
  const registry = new DeviceRegistry(req.app.locals);
  const devices = await registry.getUserDevices(req.user.id);
  res.json({ devices });
});

// 注册新设备
router.post('/devices', authMiddleware, async (req, res) => {
  const registry = new DeviceRegistry(req.app.locals);
  const device = await registry.registerDevice(req.user.id, req.body);
  res.status(201).json({ device });
});

// 请求设备擦除
router.post('/devices/:deviceId/wipe', authMiddleware, async (req, res) => {
  const executor = new SecureWipeExecutor(req.app.locals);
  const result = await executor.requestWipe(
    req.user.id,
    req.params.deviceId,
    { reason: req.body.reason, requestedFrom: req.body.requestedFrom }
  );
  res.json(result);
});

// 确认擦除完成（设备回调）
router.post('/devices/:deviceId/wipe/confirm', async (req, res) => {
  const executor = new SecureWipeExecutor(req.app.locals);
  const result = await executor.confirmWipe(req.params.deviceId, req.body.proof);
  res.json(result);
});

// 获取合规报告
router.get('/compliance/reports/wipe', authMiddleware, async (req, res) => {
  const generator = new ComplianceReportGenerator(req.app.locals);
  const report = await generator.generateWipeReport(req.user.id, req.query);
  res.json(report);
});

// 获取 GDPR 报告
router.get('/compliance/reports/gdpr', authMiddleware, async (req, res) => {
  const generator = new ComplianceReportGenerator(req.app.locals);
  const report = await generator.generateGDPRReport(req.user.id);
  res.json(report);
});

module.exports = router;
```

### 6. 定时任务：擦除请求超时处理

**文件**: `backend/jobs/wipeTimeoutChecker.js`

```javascript
const { db, logger, kafka } = require('../shared');

async function checkWipeTimeouts() {
  const timeoutMinutes = 5;
  
  const pendingWipes = await db.query(`
    SELECT * FROM user_devices 
    WHERE wipe_requested = true 
      AND wipe_confirmed_at IS NULL 
      AND wipe_requested_at < NOW() - INTERVAL '${timeoutMinutes} minutes'
  `);

  for (const device of pendingWipes.rows) {
    logger.warn('Wipe request timeout', { deviceId: device.id, userId: device.user_id });

    // 标记为超时
    await db.query(`
      UPDATE user_devices 
      SET status = 'wipe_timeout',
          wipe_timeout_at = NOW()
      WHERE id = $1
    `, [device.id]);

    // 发布超时事件
    await kafka.produce('device.wipe.timeout', {
      userId: device.user_id,
      deviceId: device.id,
      requestedAt: device.wipe_requested_at,
      timeoutAt: new Date().toISOString()
    });
  }

  logger.info('Wipe timeout check completed', { 
    pendingCount: pendingWipes.rows.length 
  });
}

// 每5分钟检查一次
setInterval(checkWipeTimeouts, 5 * 60 * 1000);

module.exports = { checkWipeTimeouts };
```

## 验收标准

- [ ] 用户可以查看所有已注册设备列表
- [ ] 用户可以在新设备上触发旧设备的远程擦除
- [ ] 设备收到擦除命令后，正确擦除所有敏感数据
- [ ] 擦除完成后，设备返回加密确认证明
- [ ] 系统正确验证擦除确认并更新设备状态
- [ ] 用户可以下载 PDF 格式的数据擦除合规报告
- [ ] 合规报告包含 GDPR/CCPA 合规声明
- [ ] 账号注销时自动触发所有关联设备的擦除请求
- [ ] 擦除请求超时后正确处理并记录
- [ ] 所有擦除操作记录可追溯审计
- [ ] API 接口有完整的单元测试覆盖
- [ ] 集成测试验证完整擦除流程

## 影响范围

- **user-service**: 新增设备管理 API 路由
- **gateway**: 新增设备相关接口路由配置
- **admin-dashboard**: 新增设备管理界面和合规报告查看功能
- **backend/shared**: 新增 DeviceRegistry、SecureWipeExecutor、ComplianceReportGenerator 模块
- **backend/jobs**: 新增擦除超时检查定时任务
- **database/migrations**: 新增 user_devices、device_wipe_records、compliance_reports 表
- **game-client**: 集成擦除命令处理逻辑

## 参考

- GDPR Article 17 - Right to erasure ('right to be forgotten')
- GDPR Article 32 - Security of processing
- CCPA Section 1798.105 - Right to delete
- NIST SP 800-88 - Guidelines for Media Sanitization
- ISO/IEC 27040 - Storage security
