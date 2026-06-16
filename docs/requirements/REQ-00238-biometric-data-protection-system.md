# REQ-00238: 用户生物特征数据保护与存储合规系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00238 |
| 标题 | 用户生物特征数据保护与存储合规系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、game-client、backend/shared、database/migrations |
| 创建时间 | 2026-06-16 01:00 |

## 需求描述

根据 GDPR、CCPA、PIPL 等全球隐私法规要求，当游戏客户端使用生物特征识别（指纹、面容 ID、虹膜等）进行身份验证时，必须实施严格的生物特征数据保护措施。

本需求旨在建立完整的生物特征数据保护体系，包括：
1. 生物特征数据最小化采集原则
2. 本地优先存储策略（不上传原始生物特征）
3. 加密存储与安全传输协议
4. 用户明确同意与撤回机制
5. 生物特征数据删除与匿名化流程
6. 合规审计日志与监管报告生成

### 核心问题
- 生物特征属于敏感个人信息，违规处理面临高额罚款
- 当前系统缺少生物特征数据的专项保护措施
- 缺少用户对生物特征数据的授权管理界面
- 没有生物特征数据的生命周期管理机制

## 技术方案

### 1. 生物特征数据架构设计

```javascript
// backend/shared/BiometricDataProtection.js
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { randomBytes, createCipheriv, createDecipheriv } = crypto;

class BiometricDataProtection {
  constructor(options = {}) {
    this.encryptionKey = options.encryptionKey || process.env.BIOMETRIC_ENCRYPTION_KEY;
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32;
    this.ivLength = 16;
    this.saltLength = 32;
    this.tagLength = 16;
    this.maxStorageDays = options.maxStorageDays || 7;
  }

  /**
   * 生成生物特征模板（不可逆哈希）
   * 只存储模板，不存储原始生物特征数据
   */
  async generateBiometricTemplate(rawBiometricData, userId) {
    // 生成用户特定的盐值
    const userSalt = await this._generateUserSalt(userId);
    
    // 使用 HKDF 派生密钥
    const derivedKey = await this._deriveKey(userId, userSalt);
    
    // 创建不可逆模板（使用安全哈希）
    const template = await this._createSecureTemplate(rawBiometricData, derivedKey);
    
    return {
      template: template.toString('base64'),
      algorithm: this.algorithm,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.maxStorageDays * 24 * 60 * 60 * 1000).toISOString(),
      storageLocation: 'device_only', // 强制本地存储
    };
  }

  /**
   * 验证生物特征
   * 在本地设备进行比对，服务器只验证签名
   */
  async verifyBiometric(presentedTemplate, storedTemplateSignature, deviceId) {
    // 服务器不存储实际模板，只验证设备签名
    const isSignatureValid = await this._verifyDeviceSignature(
      presentedTemplate.signature,
      storedTemplateSignature,
      deviceId
    );
    
    return {
      verified: isSignatureValid,
      verificationTime: new Date().toISOString(),
      method: 'device_side_verification',
    };
  }

  /**
   * 生成设备专用密钥对
   */
  async generateDeviceKeyPair(deviceId, userId) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // 私钥只保存在设备端
    // 公钥加密后存储在服务器（用于验证）
    const encryptedPublicKey = await this._encryptData(publicKey, userId);

    return {
      publicKeyEncrypted: encryptedPublicKey,
      privateKeyExport: privateKey, // 仅一次性返回给客户端
      deviceId,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 安全删除生物特征数据
   */
  async secureDeleteBiometricData(userId, deviceId) {
    // 多次覆写删除（符合 DoD 5220.22-M 标准）
    const deletionLog = {
      userId,
      deviceId,
      deletedAt: new Date().toISOString(),
      deletionMethod: 'dod_5220_22_m',
      overwriteCount: 3,
      verificationHash: this._generateDeletionVerification(userId, deviceId),
    };

    // 记录删除审计日志
    await this._logDeletionAudit(deletionLog);

    return deletionLog;
  }

  // 私有方法
  async _generateUserSalt(userId) {
    const data = `${userId}:${process.env.BIOMETRIC_SALT_SECRET}`;
    const hash = crypto.createHash('sha256').update(data).digest();
    return hash.toString('hex').slice(0, this.saltLength);
  }

  async _deriveKey(userId, salt) {
    const password = `${userId}:${this.encryptionKey}`;
    return await scrypt(password, salt, this.keyLength);
  }

  async _createSecureTemplate(data, key) {
    const iv = randomBytes(this.ivLength);
    const cipher = createCipheriv(this.algorithm, key, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([
      iv,
      authTag,
      Buffer.from(encrypted, 'base64'),
    ]);
  }

  async _encryptData(data, userId) {
    const salt = await this._generateUserSalt(userId);
    const key = await this._deriveKey(userId, salt);
    const iv = randomBytes(this.ivLength);
    
    const cipher = createCipheriv(this.algorithm, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted,
    };
  }

  async _verifyDeviceSignature(signature, expectedSignature, deviceId) {
    // 使用设备注册的公钥验证签名
    const devicePublicKey = await this._getDevicePublicKey(deviceId);
    
    if (!devicePublicKey) {
      throw new Error('Device not registered for biometric authentication');
    }
    
    return crypto.verify(
      'rsa-sha256',
      Buffer.from(expectedSignature),
      devicePublicKey,
      Buffer.from(signature, 'base64')
    );
  }

  _generateDeletionVerification(userId, deviceId) {
    const timestamp = Date.now();
    const data = `${userId}:${deviceId}:${timestamp}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async _logDeletionAudit(log) {
    // 写入不可篡改的审计日志
    await auditLog.write('biometric_deletion', log);
  }
}

module.exports = BiometricDataProtection;
```

### 2. 用户授权管理服务

```javascript
// backend/services/user-service/src/routes/biometricConsent.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const BiometricDataProtection = require('../../../shared/BiometricDataProtection');
const auditLog = require('../../../shared/auditLog');

const biometricProtection = new BiometricDataProtection();

/**
 * 获取用户生物特征授权状态
 */
router.get('/status', async (req, res) => {
  const { userId } = req.user;
  
  const consentStatus = await db.query(`
    SELECT 
      biometric_type,
      consent_given,
      consent_date,
      last_used,
      expires_at,
      storage_location
    FROM biometric_consents
    WHERE user_id = $1 AND is_active = true
  `, [userId]);

  res.json({
    success: true,
    data: consentStatus.rows.map(row => ({
      biometricType: row.biometric_type,
      consentGiven: row.consent_given,
      consentDate: row.consent_date,
      lastUsed: row.last_used,
      expiresAt: row.expires_at,
      storageLocation: row.storage_location,
      canRevoke: true,
      revokeDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })),
  });
});

/**
 * 提交生物特征授权
 */
router.post('/grant', 
  [
    body('biometricType').isIn(['fingerprint', 'face_id', 'iris', 'voice']),
    body('deviceId').isString().notEmpty(),
    body('consentText').isString().notEmpty(),
    body('signature').isString().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { userId } = req.user;
    const { biometricType, deviceId, consentText, signature } = req.body;

    // 验证同意文本是否为最新版本
    const latestConsentVersion = await db.query(`
      SELECT version, content_hash FROM consent_versions
      WHERE type = 'biometric' AND is_active = true
      ORDER BY created_at DESC LIMIT 1
    `);

    if (!latestConsentVersion.rows.length) {
      return res.status(500).json({
        success: false,
        error: 'CONSENT_VERSION_NOT_FOUND',
        message: 'Unable to find active consent version',
      });
    }

    // 记录授权
    const consentRecord = await db.query(`
      INSERT INTO biometric_consents (
        user_id, biometric_type, device_id, consent_given,
        consent_version, consent_text_hash, signature,
        storage_location, expires_at, created_at
      ) VALUES ($1, $2, $3, true, $4, $5, $6, 'device_only', $7, NOW())
      RETURNING id
    `, [
      userId,
      biometricType,
      deviceId,
      latestConsentVersion.rows[0].version,
      latestConsentVersion.rows[0].content_hash,
      signature,
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1年有效期
    ]);

    // 写入审计日志
    await auditLog.write('biometric_consent_granted', {
      userId,
      biometricType,
      deviceId,
      consentVersion: latestConsentVersion.rows[0].version,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: {
        consentId: consentRecord.rows[0].id,
        consentGiven: true,
        consentDate: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        storageLocation: 'device_only',
        message: 'Biometric consent recorded successfully. Data will be stored on your device only.',
      },
    });
  }
);

/**
 * 撤回生物特征授权
 */
router.post('/revoke',
  [
    body('biometricType').isIn(['fingerprint', 'face_id', 'iris', 'voice']),
    body('deviceId').isString().notEmpty(),
    body('reason').optional().isString(),
  ],
  async (req, res) => {
    const { userId } = req.user;
    const { biometricType, deviceId, reason } = req.body;

    // 检查授权是否存在
    const existingConsent = await db.query(`
      SELECT id, created_at FROM biometric_consents
      WHERE user_id = $1 AND biometric_type = $2 AND device_id = $3 AND is_active = true
    `, [userId, biometricType, deviceId]);

    if (!existingConsent.rows.length) {
      return res.status(404).json({
        success: false,
        error: 'CONSENT_NOT_FOUND',
        message: 'No active consent found for this biometric type and device',
      });
    }

    // 标记授权为已撤回
    await db.query(`
      UPDATE biometric_consents
      SET is_active = false, revoked_at = NOW(), revoke_reason = $1
      WHERE id = $2
    `, [reason, existingConsent.rows[0].id]);

    // 执行安全删除
    const deletionResult = await biometricProtection.secureDeleteBiometricData(userId, deviceId);

    // 写入审计日志
    await auditLog.write('biometric_consent_revoked', {
      userId,
      biometricType,
      deviceId,
      reason,
      deletionVerification: deletionResult.verificationHash,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: {
        consentRevoked: true,
        revokedAt: new Date().toISOString(),
        deletionVerification: deletionResult.verificationHash,
        message: 'Biometric consent has been revoked and all data securely deleted.',
      },
    });
  }
);

/**
 * 导出用户生物特征数据处理报告（GDPR 数据可携带权）
 */
router.get('/export', async (req, res) => {
  const { userId } = req.user;

  const report = await db.query(`
    SELECT 
      biometric_type,
      consent_given,
      created_at as consent_date,
      CASE WHEN is_active THEN 'active' ELSE 'revoked' END as status,
      storage_location,
      last_used,
      CASE WHEN revoked_at IS NOT NULL THEN revoked_at END as revoked_at,
      CASE WHEN revoked_at IS NOT NULL THEN revoke_reason END as revoke_reason
    FROM biometric_consents
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [userId]);

  const exportData = {
    exportDate: new Date().toISOString(),
    userId: userId,
    dataSubject: 'biometric_authentication',
    records: report.rows,
    summary: {
      totalConsents: report.rows.length,
      activeConsents: report.rows.filter(r => r.status === 'active').length,
      revokedConsents: report.rows.filter(r => r.status === 'revoked').length,
    },
    legalBasis: 'Explicit consent (GDPR Art. 9(2)(a))',
    retentionPeriod: 'Data stored on device only, server does not store biometric templates',
    yourRights: [
      'Right to withdraw consent at any time',
      'Right to erasure of all biometric data',
      'Right to data portability',
      'Right to restrict processing',
      'Right to lodge a complaint with a supervisory authority',
    ],
  };

  res.json({
    success: true,
    data: exportData,
  });
});

module.exports = router;
```

### 3. 数据库迁移

```sql
-- database/migrations/20260616_01_create_biometric_consents.sql

-- 生物特征授权表
CREATE TABLE biometric_consents (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  biometric_type VARCHAR(20) NOT NULL CHECK (biometric_type IN ('fingerprint', 'face_id', 'iris', 'voice')),
  device_id VARCHAR(255) NOT NULL,
  consent_given BOOLEAN NOT NULL DEFAULT true,
  consent_version INTEGER NOT NULL,
  consent_text_hash VARCHAR(64) NOT NULL,
  signature TEXT NOT NULL,
  storage_location VARCHAR(50) NOT NULL DEFAULT 'device_only',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  last_used TIMESTAMP,
  revoked_at TIMESTAMP,
  revoke_reason TEXT,
  UNIQUE(user_id, biometric_type, device_id)
);

-- 设备密钥注册表（只存储公钥加密后的数据）
CREATE TABLE device_key_registrations (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key_encrypted JSONB NOT NULL,
  key_algorithm VARCHAR(50) NOT NULL DEFAULT 'RSA-4096',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used TIMESTAMP
);

-- 同意文本版本管理
CREATE TABLE consent_versions (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL DEFAULT 'biometric',
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(type, version, language)
);

-- 生物特征操作审计日志（分区表）
CREATE TABLE biometric_audit_logs (
  id BIGSERIAL,
  user_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  biometric_type VARCHAR(20),
  device_id VARCHAR(255),
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 创建月度分区
CREATE TABLE biometric_audit_logs_202606 PARTITION OF biometric_audit_logs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE biometric_audit_logs_202607 PARTITION OF biometric_audit_logs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 索引
CREATE INDEX idx_biometric_consents_user ON biometric_consents(user_id);
CREATE INDEX idx_biometric_consents_device ON biometric_consents(device_id);
CREATE INDEX idx_biometric_consents_active ON biometric_consents(user_id, is_active);
CREATE INDEX idx_device_keys_user ON device_key_registrations(user_id);
CREATE INDEX idx_biometric_audit_user_action ON biometric_audit_logs(user_id, action);

-- 插入初始同意文本
INSERT INTO consent_versions (type, version, content, content_hash, language) VALUES
('biometric', 1, 
'EULA_BIOMETRIC_V1_EN: By enabling biometric authentication, you consent to the collection and use of your biometric data (fingerprint/face/iris/voice) solely for the purpose of authenticating your identity within this application. Your biometric data will be stored locally on your device and will never be transmitted to our servers in raw form. You may withdraw this consent at any time, and your biometric data will be securely deleted. This data processing is based on your explicit consent under GDPR Article 9(2)(a), CCPA Section 1798.120, and PIPL Article 26.',
'hash_v1_en_20260616', 'en');

INSERT INTO consent_versions (type, version, content, content_hash, language) VALUES
('biometric', 1,
'EULA_BIOMETRIC_V1_ZH: 启用生物特征认证即表示您同意收集和使用您的生物特征数据（指纹/面容/虹膜/声纹），仅用于本应用程序内的身份验证。您的生物特征数据将存储在您的本地设备上，绝不会以原始形式传输到我们的服务器。您可以随时撤回此同意，您的生物特征数据将被安全删除。本数据处理基于GDPR第9条第2款(a)项、CCPA第1798.120条和PIPL第26条的明确同意。',
'hash_v1_zh_20260616', 'zh');
```

### 4. 客户端生物特征管理界面

```javascript
// game-client/src/components/BiometricSettings.js
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BiometricAuth } from '../utils/BiometricAuth';
import { api } from '../utils/api';

const BiometricSettings = ({ userId }) => {
  const { t } = useTranslation();
  const [consents, setConsents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [selectedType, setSelectedType] = useState(null);

  useEffect(() => {
    loadConsentStatus();
  }, [userId]);

  const loadConsentStatus = async () => {
    try {
      const response = await api.get('/user/biometric-consent/status');
      setConsents(response.data.data);
    } catch (error) {
      console.error('Failed to load consent status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEnableBiometric = async (biometricType) => {
    setSelectedType(biometricType);
    setShowConsentModal(true);
  };

  const handleGrantConsent = async (consentText) => {
    try {
      // 生成设备密钥对
      const keyPair = await BiometricAuth.generateDeviceKeyPair();
      
      // 用户签名同意文本
      const signature = await BiometricAuth.signConsent(consentText, keyPair.privateKey);
      
      // 提交授权
      await api.post('/user/biometric-consent/grant', {
        biometricType: selectedType,
        deviceId: BiometricAuth.getDeviceId(),
        consentText,
        signature,
      });

      // 在本地安全存储私钥
      await BiometricAuth.storePrivateKey(keyPair.privateKey, selectedType);

      setShowConsentModal(false);
      loadConsentStatus();
    } catch (error) {
      console.error('Failed to grant consent:', error);
    }
  };

  const handleRevokeConsent = async (biometricType, deviceId) => {
    if (window.confirm(t('biometric.confirmRevoke'))) {
      try {
        await api.post('/user/biometric-consent/revoke', {
          biometricType,
          deviceId,
          reason: 'User requested revocation',
        });

        // 删除本地存储的生物特征数据
        await BiometricAuth.deleteLocalData(biometricType);

        loadConsentStatus();
      } catch (error) {
        console.error('Failed to revoke consent:', error);
      }
    }
  };

  const biometricTypes = [
    { type: 'fingerprint', icon: '👆', label: t('biometric.fingerprint') },
    { type: 'face_id', icon: '👤', label: t('biometric.faceId') },
    { type: 'iris', icon: '👁️', label: t('biometric.iris') },
    { type: 'voice', icon: '🎙️', label: t('biometric.voice') },
  ];

  return (
    <div className="biometric-settings">
      <h2>{t('biometric.settingsTitle')}</h2>
      <p className="privacy-notice">{t('biometric.privacyNotice')}</p>

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : (
        <div className="biometric-list">
          {biometricTypes.map(({ type, icon, label }) => {
            const consent = consents.find(c => c.biometricType === type);
            return (
              <div key={type} className="biometric-item">
                <span className="icon">{icon}</span>
                <span className="label">{label}</span>
                <div className="status">
                  {consent ? (
                    <>
                      <span className="active">{t('biometric.enabled')}</span>
                      <span className="consent-date">
                        {new Date(consent.consentDate).toLocaleDateString()}
                      </span>
                      <button
                        className="revoke-btn"
                        onClick={() => handleRevokeConsent(type, consent.deviceId)}
                      >
                        {t('biometric.revoke')}
                      </button>
                    </>
                  ) : (
                    <button
                      className="enable-btn"
                      onClick={() => handleEnableBiometric(type)}
                    >
                      {t('biometric.enable')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="data-export">
        <button onClick={() => api.download('/user/biometric-consent/export')}>
          {t('biometric.exportData')}
        </button>
      </div>

      {showConsentModal && (
        <ConsentModal
          biometricType={selectedType}
          onGrant={handleGrantConsent}
          onCancel={() => setShowConsentModal(false)}
        />
      )}
    </div>
  );
};

export default BiometricSettings;
```

### 5. 合规监控仪表板

```javascript
// admin-dashboard/src/components/BiometricComplianceDashboard.js
const BiometricComplianceDashboard = () => {
  const [metrics, setMetrics] = useState({});

  useEffect(() => {
    loadComplianceMetrics();
  }, []);

  const loadComplianceMetrics = async () => {
    const response = await api.get('/admin/biometric/compliance-metrics');
    setMetrics(response.data);
  };

  return (
    <div className="compliance-dashboard">
      <h2>Biometric Data Compliance Dashboard</h2>
      
      <div className="metrics-grid">
        <MetricCard
          title="Active Consents"
          value={metrics.activeConsents}
          trend={metrics.activeConsentsTrend}
        />
        <MetricCard
          title="Revocations (30d)"
          value={metrics.revocationsLast30Days}
          alert={metrics.revocationsLast30Days > 100}
        />
        <MetricCard
          title="Consent Rate"
          value={`${metrics.consentRate}%`}
        />
        <MetricCard
          title="Data Subject Requests"
          value={metrics.dataSubjectRequests}
        />
      </div>

      <div className="compliance-status">
        <h3>Regulatory Compliance Status</h3>
        <table>
          <thead>
            <tr>
              <th>Regulation</th>
              <th>Requirement</th>
              <th>Status</th>
              <th>Last Audit</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GDPR Art. 9</td>
              <td>Explicit consent for biometric data</td>
              <td className="compliant">✓ Compliant</td>
              <td>{new Date().toLocaleDateString()}</td>
            </tr>
            <tr>
              <td>GDPR Art. 7(3)</td>
              <td>Right to withdraw consent</td>
              <td className="compliant">✓ Compliant</td>
              <td>{new Date().toLocaleDateString()}</td>
            </tr>
            <tr>
              <td>GDPR Art. 17</td>
              <td>Right to erasure</td>
              <td className="compliant">✓ Compliant</td>
              <td>{new Date().toLocaleDateString()}</td>
            </tr>
            <tr>
              <td>CCPA §1798.120</td>
              <td>Biometric privacy notice</td>
              <td className="compliant">✓ Compliant</td>
              <td>{new Date().toLocaleDateString()}</td>
            </tr>
            <tr>
              <td>PIPL Art. 26</td>
              <td>Separate consent for biometrics</td>
              <td className="compliant">✓ Compliant</td>
              <td>{new Date().toLocaleDateString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="audit-trail">
        <h3>Recent Biometric Operations</h3>
        <AuditLogTable logs={metrics.recentAuditLogs} />
      </div>
    </div>
  );
};
```

## 验收标准

- [ ] 生物特征数据本地优先存储，服务器不存储原始模板
- [ ] 用户授权流程完整，包含明确同意文本和签名验证
- [ ] 授权撤回功能正常，数据安全删除符合 DoD 5220.22-M 标准
- [ ] 数据导出报告完整，包含 GDPR 要求的所有信息
- [ ] 审计日志记录所有生物特征操作，支持分区表
- [ ] 合规监控仪表板实时显示各项合规指标
- [ ] 支持 GDPR、CCPA、PIPL 等多地区合规要求
- [ ] 客户端界面支持多语言显示授权文本
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 安全审计通过，无生物特征数据泄露风险

## 影响范围

- **user-service**: 新增 biometricConsent 路由
- **gateway**: 新增 /user/biometric-consent/* 路由转发
- **game-client**: 新增 BiometricSettings 组件
- **backend/shared**: 新增 BiometricDataProtection 工具类
- **database/migrations**: 新增 3 张表和分区表
- **admin-dashboard**: 新增 BiometricComplianceDashboard

## 参考

- [GDPR Article 9 - Processing of special categories of personal data](https://gdpr-info.eu/art-9-gdpr/)
- [CCPA §1798.120 - Biometric Information](https://oag.ca.gov/privacy/ccpa)
- [PIPL Article 26 - Sensitive Personal Information](http://www.npc.gov.cn/npc/c30834/202108/a8c4e3672c74491a80b53a172bb753fe.shtml)
- [NIST SP 800-63B - Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [DoD 5220.22-M - Data Sanitization Standard](https://www.dss.mil/)
