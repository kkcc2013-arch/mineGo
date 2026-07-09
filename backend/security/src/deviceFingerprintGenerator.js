/**
 * DeviceFingerprintGenerator - 设备指纹生成器
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 * 
 * 功能：
 * - 设备指纹生成
 * - 设备信息采集
 * - 安全特征检测
 * - 指纹哈希计算
 */

const crypto = require('crypto');
const logger = require('../logger');

class DeviceFingerprintGenerator {
  constructor() {
    this.requiredFields = [
      'platform',
      'model',
      'osVersion',
      'screenResolution',
      'timezone',
      'language'
    ];
  }

  /**
   * 生成设备指纹
   */
  async generate(deviceInfo, securityChecks) {
    try {
      // 验证必要字段
      const validation = this._validateDeviceInfo(deviceInfo);
      if (!validation.valid) {
        throw new Error(`Invalid device info: ${validation.missing.join(', ')}`);
      }

      // 采集设备特征
      const features = await this._collectFeatures(deviceInfo);

      // 整合安全检测结果
      const securityFeatures = this._collectSecurityFeatures(securityChecks);

      // 计算指纹哈希
      const fingerprintHash = this._calculateFingerprintHash(features, securityFeatures);

      // 计算信任分数
      const trustScore = this._calculateTrustScore(features, securityFeatures, securityChecks);

      // 生成设备 ID
      const deviceId = this._generateDeviceId(deviceInfo);

      const fingerprint = {
        deviceId,
        fingerprintHash,
        features,
        securityFeatures,
        trustScore,
        securityFlags: {
          emulatorDetected: securityChecks?.emulatorDetected || false,
          rootDetected: securityChecks?.rootDetected || false,
          fridaDetected: securityChecks?.fridaDetected || false,
          xposedDetected: securityChecks?.xposedDetected || false,
          mockLocationEnabled: securityChecks?.mockLocationEnabled || false,
          securityIntegrityValid: securityChecks?.securityIntegrityValid !== false
        },
        generatedAt: new Date().toISOString()
      };

      logger.info('Device fingerprint generated', {
        deviceId: fingerprint.deviceId,
        trustScore: fingerprint.trustScore
      });

      return fingerprint;
    } catch (error) {
      logger.error('Failed to generate device fingerprint', { error });
      throw error;
    }
  }

  /**
   * 验证设备信息
   */
  _validateDeviceInfo(deviceInfo) {
    const missing = this.requiredFields.filter(field => !deviceInfo[field]);
    
    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * 采集设备特征
   */
  async _collectFeatures(deviceInfo) {
    return {
      // 基础信息
      platform: deviceInfo.platform,
      model: deviceInfo.model,
      manufacturer: deviceInfo.manufacturer || 'unknown',
      osVersion: deviceInfo.osVersion,
      deviceName: deviceInfo.deviceName || 'unknown',
      
      // 屏幕信息
      screenResolution: deviceInfo.screenResolution,
      screenDensity: deviceInfo.screenDensity || 1,
      screenSize: deviceInfo.screenSize || 'unknown',
      
      // 网络信息
      networkType: deviceInfo.networkType || 'unknown',
      carrier: deviceInfo.carrier || 'unknown',
      
      // 时区和语言
      timezone: deviceInfo.timezone,
      timezoneOffset: new Date().getTimezoneOffset(),
      language: deviceInfo.language,
      locale: deviceInfo.locale || deviceInfo.language,
      
      // 其他特征
      userAgent: deviceInfo.userAgent || 'unknown',
      appId: deviceInfo.appId || 'minego',
      appVersion: deviceInfo.appVersion || '1.0.0',
      buildNumber: deviceInfo.buildNumber || '1',
      
      // 硬件特征
      cpuCores: deviceInfo.cpuCores || navigator?.hardwareConcurrency || 1,
      totalMemory: deviceInfo.totalMemory || 'unknown',
      
      // 传感器信息
      sensors: deviceInfo.sensors || [],
      sensorCount: (deviceInfo.sensors || []).length
    };
  }

  /**
   * 采集安全特征
   */
  _collectSecurityFeatures(securityChecks) {
    return {
      // 环境检测
      isEmulator: securityChecks?.emulatorDetected || false,
      isRooted: securityChecks?.rootDetected || false,
      isJailbroken: securityChecks?.jailbrokenDetected || false,
      
      // 注入检测
      hasFrida: securityChecks?.fridaDetected || false,
      hasXposed: securityChecks?.xposedDetected || false,
      hasMagisk: securityChecks?.magiskDetected || false,
      
      // 调试检测
      isDebuggable: securityChecks?.debuggable || false,
      hasDebugger: securityChecks?.debuggerConnected || false,
      
      // 位置检测
      mockLocation: securityChecks?.mockLocationEnabled || false,
      
      // 完整性检测
      signatureValid: securityChecks?.signatureValid !== false,
      integrityValid: securityChecks?.integrityValid !== false,
      
      // 其他安全标记
      hasScreenReader: securityChecks?.screenReaderEnabled || false,
      hasAdbEnabled: securityChecks?.adbEnabled || false,
      hasUsbDebugging: securityChecks?.usbDebuggingEnabled || false
    };
  }

  /**
   * 计算指纹哈希
   */
  _calculateFingerprintHash(features, securityFeatures) {
    // 构建指纹字符串（排除可能变化的字段）
    const fingerprintData = {
      platform: features.platform,
      model: features.model,
      manufacturer: features.manufacturer,
      osVersion: features.osVersion,
      screenResolution: features.screenResolution,
      cpuCores: features.cpuCores,
      sensorCount: features.sensorCount,
      language: features.language,
      timezone: features.timezone,
      appId: features.appId
    };

    // 排序并序列化
    const fingerprintString = JSON.stringify(fingerprintData, Object.keys(fingerprintData).sort());
    
    // 计算 SHA-256 哈希
    return crypto.createHash('sha256').update(fingerprintString).digest('hex');
  }

  /**
   * 计算信任分数
   */
  _calculateTrustScore(features, securityFeatures, securityChecks) {
    let score = 100;
    const deductions = [];

    // 模拟器检测（-40分）
    if (securityFeatures.isEmulator) {
      score -= 40;
      deductions.push({ reason: 'emulator_detected', points: -40 });
    }

    // Root/越狱检测（-25分）
    if (securityFeatures.isRooted || securityFeatures.isJailbroken) {
      score -= 25;
      deductions.push({ reason: 'root_detected', points: -25 });
    }

    // 注入框架检测（-50分）
    if (securityFeatures.hasFrida || securityFeatures.hasXposed || securityFeatures.hasMagisk) {
      score -= 50;
      deductions.push({ reason: 'injection_framework', points: -50 });
    }

    // 调试器检测（-20分）
    if (securityFeatures.hasDebugger || securityFeatures.isDebuggable) {
      score -= 20;
      deductions.push({ reason: 'debugger_detected', points: -20 });
    }

    // Mock Location（-30分）
    if (securityFeatures.mockLocation) {
      score -= 30;
      deductions.push({ reason: 'mock_location', points: -30 });
    }

    // 签名/完整性验证失败（-35分）
    if (!securityFeatures.signatureValid || !securityFeatures.integrityValid) {
      score -= 35;
      deductions.push({ reason: 'integrity_violation', points: -35 });
    }

    // ADB/USB调试开启（-10分）
    if (securityFeatures.hasAdbEnabled || securityFeatures.hasUsbDebugging) {
      score -= 10;
      deductions.push({ reason: 'debug_mode_enabled', points: -10 });
    }

    // 传感器数量异常（-15分）
    if (features.sensorCount < 3) {
      score -= 15;
      deductions.push({ reason: 'insufficient_sensors', points: -15 });
    }

    // 屏幕分辨率异常（-5分）
    if (features.screenResolution === '0x0' || features.screenResolution === 'unknown') {
      score -= 5;
      deductions.push({ reason: 'invalid_screen_resolution', points: -5 });
    }

    // 应用完整性检查（如果有）
    if (securityChecks?.securityIntegrityValid === false) {
      score -= 40;
      deductions.push({ reason: 'security_integrity_failed', points: -40 });
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 生成设备 ID
   */
  _generateDeviceId(deviceInfo) {
    // 使用设备唯一标识符（如果有）
    if (deviceInfo.deviceId) {
      return deviceInfo.deviceId;
    }

    // 使用硬件信息生成
    const deviceIdData = {
      platform: deviceInfo.platform,
      model: deviceInfo.model,
      osVersion: deviceInfo.osVersion
    };

    const deviceIdString = JSON.stringify(deviceIdData);
    const hash = crypto.createHash('md5').update(deviceIdString).digest('hex');
    
    // 格式化为 UUID 风格
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32)
    ].join('-');
  }

  /**
   * 验证指纹一致性
   */
  validateConsistency(currentFingerprint, storedFingerprint) {
    const changes = [];
    
    // 检查关键字段变化
    const criticalFields = ['platform', 'model', 'manufacturer'];
    criticalFields.forEach(field => {
      if (currentFingerprint.features[field] !== storedFingerprint.features[field]) {
        changes.push({
          field,
          oldValue: storedFingerprint.features[field],
          newValue: currentFingerprint.features[field]
        });
      }
    });

    // 检查安全状态变化
    const securityFields = ['isEmulator', 'isRooted', 'hasFrida', 'hasXposed'];
    securityFields.forEach(field => {
      if (currentFingerprint.securityFeatures[field] !== storedFingerprint.securityFeatures[field]) {
        changes.push({
          field: `security.${field}`,
          oldValue: storedFingerprint.securityFeatures[field],
          newValue: currentFingerprint.securityFeatures[field]
        });
      }
    });

    return {
      consistent: changes.length === 0,
      changes
    };
  }
}

module.exports = DeviceFingerprintGenerator;