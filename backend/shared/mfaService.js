/**
 * REQ-00057: 多因素认证（MFA）服务
 * 支持 TOTP、恢复码、敏感操作二次验证
 */

const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const db = require('./db');
const { logger, metrics } = require('./logger');

class MFAService {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32;
    this.ivLength = 16;
    this.authTagLength = 16;
    this.totpWindow = 2; // 允许前后 2 个时间窗口（60秒容差）
    this.maxFailedAttempts = 5;
    this.lockoutDuration = 15 * 60 * 1000; // 15 分钟
    this.recoveryCodeCount = 8;
    this.trustedDeviceDuration = 7 * 24 * 60 * 60 * 1000; // 7 天
  }

  /**
   * 获取加密密钥（从环境变量）
   */
  getEncryptionKey() {
    const key = process.env.MFA_ENCRYPTION_KEY;
    if (!key || key.length < 32) {
      logger.warn('MFA_ENCRYPTION_KEY not set or too short, using default key (NOT RECOMMENDED FOR PRODUCTION)');
      return crypto.scryptSync('minego-mfa-default-key', 'salt', 32);
    }
    return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf-8');
  }

  /**
   * 加密 TOTP 密钥
   */
  encryptSecret(secret) {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  /**
   * 解密 TOTP 密钥
   */
  decryptSecret(encrypted, iv, authTag) {
    try {
      const key = this.getEncryptionKey();
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        key,
        Buffer.from(iv, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      logger.error('Failed to decrypt MFA secret', { error: error.message });
      return null;
    }
  }

  /**
   * 生成 TOTP 密钥
   */
  generateSecret(email) {
    const secret = speakeasy.generateSecret({
      name: `mineGo:${email}`,
      issuer: 'mineGo',
      length: 20 // 160 bits
    });

    return {
      base32: secret.base32,
      otpauthUrl: secret.otpauth_url
    };
  }

  /**
   * 验证 TOTP 码
   */
  verifyTOTP(secret, code) {
    try {
      return speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: code,
        window: this.totpWindow
      });
    } catch (error) {
      logger.error('TOTP verification failed', { error: error.message });
      return false;
    }
  }

  /**
   * 生成二维码 Data URL
   */
  async generateQRCode(otpauthUrl) {
    try {
      return await QRCode.toDataURL(otpauthUrl, {
        width: 300,
        margin: 2
      });
    } catch (error) {
      logger.error('Failed to generate QR code', { error: error.message });
      throw error;
    }
  }

  /**
   * 生成恢复码
   */
  generateRecoveryCodes(count = this.recoveryCodeCount) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const randomBytes = crypto.randomBytes(4).toString('hex').toUpperCase();
      codes.push(`${randomBytes.slice(0, 4)}-${randomBytes.slice(4)}`);
    }
    return codes;
  }

  /**
   * 哈希恢复码
   */
  hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  /**
   * 初始化 MFA 设置
   */
  async setupMFA(userId, email) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 检查是否已存在 MFA 配置
      const existingResult = await client.query(
        'SELECT * FROM user_mfa WHERE user_id = $1',
        [userId]
      );

      if (existingResult.rows.length > 0 && existingResult.rows[0].is_enabled) {
        throw new Error('MFA already enabled for this user');
      }

      // 生成 TOTP 密钥
      const { base32, otpauthUrl } = this.generateSecret(email);
      
      // 加密密钥
      const { encrypted, iv, authTag } = this.encryptSecret(base32);
      
      // 生成恢复码
      const recoveryCodes = this.generateRecoveryCodes();
      const recoveryCodeHashes = recoveryCodes.map(code => this.hashRecoveryCode(code));

      // 生成二维码
      const qrCodeDataUrl = await this.generateQRCode(otpauthUrl);

      // 插入或更新 MFA 配置
      if (existingResult.rows.length > 0) {
        await client.query(
          `UPDATE user_mfa 
           SET secret_encrypted = $1, secret_iv = $2, is_enabled = false, 
               verified_at = null, updated_at = NOW()
           WHERE user_id = $3`,
          [`${encrypted}:${authTag}`, iv, userId]
        );
        
        // 删除旧的恢复码
        await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
      } else {
        await client.query(
          `INSERT INTO user_mfa (user_id, secret_encrypted, secret_iv, is_enabled)
           VALUES ($1, $2, $3, false)`,
          [userId, `${encrypted}:${authTag}`, iv]
        );
      }

      // 插入恢复码
      for (const codeHash of recoveryCodeHashes) {
        await client.query(
          `INSERT INTO mfa_recovery_codes (user_id, code_hash)
           VALUES ($1, $2)`,
          [userId, codeHash]
        );
      }

      await client.query('COMMIT');

      // 记录指标
      metrics.mfaSetupTotal?.inc({ status: 'initiated' });

      logger.info('MFA setup initiated', { userId });

      return {
        secret: base32,
        qrCodeDataUrl,
        otpauthUrl,
        recoveryCodes
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('MFA setup failed', { userId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 验证并启用 MFA
   */
  async enableMFA(userId, code) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 获取 MFA 配置
      const mfaResult = await client.query(
        'SELECT * FROM user_mfa WHERE user_id = $1',
        [userId]
      );

      if (mfaResult.rows.length === 0) {
        throw new Error('MFA not set up');
      }

      const mfa = mfaResult.rows[0];

      if (mfa.is_enabled) {
        throw new Error('MFA already enabled');
      }

      // 检查是否被锁定
      if (mfa.locked_until && new Date(mfa.locked_until) > new Date()) {
        throw new Error('MFA verification locked due to too many failed attempts');
      }

      // 解密密钥
      const [encrypted, authTag] = mfa.secret_encrypted.split(':');
      const secret = this.decryptSecret(encrypted, mfa.secret_iv, authTag);

      if (!secret) {
        throw new Error('Failed to decrypt MFA secret');
      }

      // 验证 TOTP 码
      const valid = this.verifyTOTP(secret, code);

      if (!valid) {
        // 增加失败次数
        const failedAttempts = mfa.failed_attempts + 1;
        const lockUpdate = failedAttempts >= this.maxFailedAttempts 
          ? ', locked_until = NOW() + INTERVAL \'15 minutes\''
          : '';

        await client.query(
          `UPDATE user_mfa 
           SET failed_attempts = $1, updated_at = NOW() ${lockUpdate}
           WHERE user_id = $2`,
          [failedAttempts, userId]
        );

        await client.query('COMMIT');

        // 记录验证日志
        await this.logVerification(userId, 'totp', false, 'Invalid code');

        metrics.mfaSetupTotal?.inc({ status: 'failed' });

        throw new Error(`Invalid TOTP code. Attempts remaining: ${this.maxFailedAttempts - failedAttempts}`);
      }

      // 启用 MFA
      await client.query(
        `UPDATE user_mfa 
         SET is_enabled = true, verified_at = NOW(), failed_attempts = 0, 
             locked_until = null, backup_codes_generated_at = NOW(), updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      // 更新用户表的 mfa_enabled 字段
      await client.query(
        'UPDATE users SET mfa_enabled = true WHERE id = $1',
        [userId]
      );

      await client.query('COMMIT');

      // 记录验证日志
      await this.logVerification(userId, 'totp', true);

      metrics.mfaSetupTotal?.inc({ status: 'success' });
      metrics.mfaEnabledUsers?.inc();

      logger.info('MFA enabled successfully', { userId });

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('MFA enable failed', { userId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 禁用 MFA
   */
  async disableMFA(userId, code) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 验证 MFA 码
      const verified = await this.verifyMFA(userId, code);
      
      if (!verified) {
        throw new Error('Invalid MFA code');
      }

      // 禁用 MFA
      await client.query(
        `UPDATE user_mfa 
         SET is_enabled = false, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      // 更新用户表
      await client.query(
        'UPDATE users SET mfa_enabled = false WHERE id = $1',
        [userId]
      );

      // 删除恢复码
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);

      // 删除受信任设备
      await client.query('DELETE FROM mfa_trusted_devices WHERE user_id = $1', [userId]);

      await client.query('COMMIT');

      metrics.mfaEnabledUsers?.dec();

      logger.info('MFA disabled', { userId });

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 验证 MFA（支持 TOTP 和恢复码）
   */
  async verifyMFA(userId, code, deviceFingerprint = null, rememberDevice = false) {
    const client = await db.getClient();
    
    try {
      // 获取 MFA 配置
      const mfaResult = await client.query(
        'SELECT * FROM user_mfa WHERE user_id = $1 AND is_enabled = true',
        [userId]
      );

      if (mfaResult.rows.length === 0) {
        return false;
      }

      const mfa = mfaResult.rows[0];

      // 检查是否被锁定
      if (mfa.locked_until && new Date(mfa.locked_until) > new Date()) {
        throw new Error('MFA verification locked');
      }

      // 检查是否为恢复码格式（XXXX-XXXX）
      const isRecoveryCode = /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code.toUpperCase());

      if (isRecoveryCode) {
        return await this.verifyRecoveryCode(userId, code);
      }

      // 解密密钥
      const [encrypted, authTag] = mfa.secret_encrypted.split(':');
      const secret = this.decryptSecret(encrypted, mfa.secret_iv, authTag);

      if (!secret) {
        return false;
      }

      // 验证 TOTP
      const valid = this.verifyTOTP(secret, code);

      if (valid) {
        // 重置失败次数
        await client.query(
          'UPDATE user_mfa SET failed_attempts = 0, locked_until = null WHERE user_id = $1',
          [userId]
        );

        // 如果选择记住设备
        if (rememberDevice && deviceFingerprint) {
          await this.addTrustedDevice(userId, deviceFingerprint);
        }

        await this.logVerification(userId, 'totp', true);
        metrics.mfaVerificationTotal?.inc({ type: 'totp', status: 'success' });

        return true;
      } else {
        // 增加失败次数
        await this.incrementFailedAttempts(userId);
        await this.logVerification(userId, 'totp', false, 'Invalid code');
        metrics.mfaVerificationTotal?.inc({ type: 'totp', status: 'failed' });

        return false;
      }
    } catch (error) {
      logger.error('MFA verification error', { userId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 验证恢复码
   */
  async verifyRecoveryCode(userId, code) {
    const client = await db.getClient();
    
    try {
      const codeHash = this.hashRecoveryCode(code.toUpperCase());

      const result = await client.query(
        `SELECT id FROM mfa_recovery_codes 
         WHERE user_id = $1 AND code_hash = $2 AND is_used = false`,
        [userId, codeHash]
      );

      if (result.rows.length === 0) {
        await this.incrementFailedAttempts(userId);
        await this.logVerification(userId, 'recovery', false, 'Invalid or used recovery code');
        metrics.mfaVerificationTotal?.inc({ type: 'recovery', status: 'failed' });
        return false;
      }

      // 标记恢复码为已使用
      await client.query(
        `UPDATE mfa_recovery_codes 
         SET is_used = true, used_at = NOW()
         WHERE id = $1`,
        [result.rows[0].id]
      );

      // 重置失败次数
      await client.query(
        'UPDATE user_mfa SET failed_attempts = 0, locked_until = null WHERE user_id = $1',
        [userId]
      );

      await this.logVerification(userId, 'recovery', true);
      metrics.mfaVerificationTotal?.inc({ type: 'recovery', status: 'success' });
      metrics.mfaRecoveryCodesUsed?.inc();

      return true;
    } catch (error) {
      logger.error('Recovery code verification error', { userId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 增加失败次数
   */
  async incrementFailedAttempts(userId) {
    const client = await db.getClient();
    
    try {
      const result = await client.query(
        `UPDATE user_mfa 
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE 
               WHEN failed_attempts + 1 >= $1 THEN NOW() + INTERVAL '15 minutes'
               ELSE locked_until
             END
         WHERE user_id = $2
         RETURNING failed_attempts`,
        [this.maxFailedAttempts, userId]
      );

      return result.rows[0]?.failed_attempts || 0;
    } finally {
      client.release();
    }
  }

  /**
   * 记录验证日志
   */
  async logVerification(userId, mfaType, success, failureReason = null, ipAddress = null, userAgent = null) {
    try {
      await db.query(
        `INSERT INTO mfa_verification_logs (user_id, mfa_type, success, failure_reason, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, mfaType, success, failureReason, ipAddress, userAgent]
      );
    } catch (error) {
      logger.error('Failed to log MFA verification', { error: error.message });
    }
  }

  /**
   * 添加受信任设备
   */
  async addTrustedDevice(userId, deviceFingerprint, deviceName = null, ipAddress = null, userAgent = null) {
    try {
      await db.query(
        `INSERT INTO mfa_trusted_devices (user_id, device_fingerprint, device_name, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
         ON CONFLICT (user_id, device_fingerprint) 
         DO UPDATE SET expires_at = NOW() + INTERVAL '7 days', created_at = NOW()`,
        [userId, deviceFingerprint, deviceName, ipAddress, userAgent]
      );

      logger.info('Trusted device added', { userId, deviceFingerprint });
    } catch (error) {
      logger.error('Failed to add trusted device', { error: error.message });
    }
  }

  /**
   * 检查设备是否受信任
   */
  async isTrustedDevice(userId, deviceFingerprint) {
    try {
      const result = await db.query(
        `SELECT id FROM mfa_trusted_devices 
         WHERE user_id = $1 AND device_fingerprint = $2 AND expires_at > NOW()`,
        [userId, deviceFingerprint]
      );

      return result.rows.length > 0;
    } catch (error) {
      logger.error('Failed to check trusted device', { error: error.message });
      return false;
    }
  }

  /**
   * 获取恢复码状态
   */
  async getRecoveryCodesStatus(userId) {
    try {
      const result = await db.query(
        `SELECT 
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE is_used = false) as remaining
         FROM mfa_recovery_codes 
         WHERE user_id = $1`,
        [userId]
      );

      return {
        total: parseInt(result.rows[0].total),
        remaining: parseInt(result.rows[0].remaining)
      };
    } catch (error) {
      logger.error('Failed to get recovery codes status', { error: error.message });
      return { total: 0, remaining: 0 };
    }
  }

  /**
   * 重新生成恢复码
   */
  async regenerateRecoveryCodes(userId, code) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 验证当前 MFA
      const verified = await this.verifyMFA(userId, code);
      
      if (!verified) {
        throw new Error('Invalid MFA code');
      }

      // 删除旧恢复码
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);

      // 生成新恢复码
      const recoveryCodes = this.generateRecoveryCodes();
      const recoveryCodeHashes = recoveryCodes.map(c => this.hashRecoveryCode(c));

      for (const codeHash of recoveryCodeHashes) {
        await client.query(
          `INSERT INTO mfa_recovery_codes (user_id, code_hash)
           VALUES ($1, $2)`,
          [userId, codeHash]
        );
      }

      // 更新备份码生成时间
      await client.query(
        `UPDATE user_mfa 
         SET backup_codes_generated_at = NOW(), updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      await client.query('COMMIT');

      logger.info('Recovery codes regenerated', { userId });

      return { recoveryCodes };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取 MFA 状态
   */
  async getMFAStatus(userId) {
    try {
      const result = await db.query(
        `SELECT is_enabled, verified_at, backup_codes_generated_at, created_at
         FROM user_mfa 
         WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return { enabled: false };
      }

      const mfa = result.rows[0];
      const recoveryStatus = await this.getRecoveryCodesStatus(userId);

      return {
        enabled: mfa.is_enabled,
        verifiedAt: mfa.verified_at,
        backupCodesGeneratedAt: mfa.backup_codes_generated_at,
        recoveryCodesRemaining: recoveryStatus.remaining,
        createdAt: mfa.created_at
      };
    } catch (error) {
      logger.error('Failed to get MFA status', { error: error.message });
      return { enabled: false };
    }
  }
}

// 初始化 Prometheus 指标
const mfaMetrics = {};
if (typeof promClient !== 'undefined') {
  const { Counter, Gauge } = require('prom-client');
  
  mfaMetrics.mfaSetupTotal = new Counter({
    name: 'mfa_setup_total',
    help: 'Total MFA setup attempts',
    labelNames: ['status']
  });

  mfaMetrics.mfaVerificationTotal = new Counter({
    name: 'mfa_verification_total',
    help: 'Total MFA verifications',
    labelNames: ['type', 'status']
  });

  mfaMetrics.mfaRecoveryCodesUsed = new Counter({
    name: 'mfa_recovery_codes_used_total',
    help: 'Total MFA recovery codes used'
  });

  mfaMetrics.mfaEnabledUsers = new Gauge({
    name: 'mfa_enabled_users',
    help: 'Number of users with MFA enabled'
  });
}

module.exports = new MFAService();
