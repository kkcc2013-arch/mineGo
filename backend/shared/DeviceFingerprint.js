'use strict';

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
    const crypto = require('crypto');
    
    const components = [
      deviceInfo.userAgent || '',
      deviceInfo.screenResolution || '',
      deviceInfo.timezone || '',
      deviceInfo.language || '',
      deviceInfo.platform || '',
      deviceInfo.hardwareConcurrency || '',
      deviceInfo.deviceMemory || '',
      String(deviceInfo.touchSupport || false),
      deviceInfo.canvasFingerprint || '',
      deviceInfo.webglFingerprint || '',
      deviceInfo.audioFingerprint || ''
    ];

    const rawFingerprint = components.join('|');
    return crypto.createHash('sha256').update(rawFingerprint).digest('hex');
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

  /**
   * 验证指纹格式
   * @param {string} fingerprint - 指纹
   * @returns {boolean}
   */
  isValid(fingerprint) {
    return typeof fingerprint === 'string' && 
           fingerprint.length === 64 && 
           /^[a-f0-9]{64}$/.test(fingerprint);
  }

  /**
   * 提取设备类型
   * @param {string} userAgent - User Agent 字符串
   * @returns {string} 设备类型
   */
  extractDeviceType(userAgent) {
    if (!userAgent) return 'unknown';
    
    const ua = userAgent.toLowerCase();
    
    if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) {
      if (/tablet|ipad/i.test(ua)) {
        return 'tablet';
      }
      return 'mobile';
    }
    
    if (/tablet|ipad/i.test(ua)) {
      return 'tablet';
    }
    
    return 'desktop';
  }

  /**
   * 提取设备名称
   * @param {Object} deviceInfo - 设备信息
   * @returns {string} 设备名称
   */
  extractDeviceName(deviceInfo) {
    const ua = deviceInfo.userAgent || '';
    
    // 尝试提取品牌和型号
    const brandPatterns = [
      { pattern: /iphone/i, name: 'iPhone' },
      { pattern: /ipad/i, name: 'iPad' },
      { pattern: /samsung|galaxy/i, name: 'Samsung' },
      { pattern: /huawei/i, name: 'Huawei' },
      { pattern: /xiaomi|redmi/i, name: 'Xiaomi' },
      { pattern: /oneplus/i, name: 'OnePlus' },
      { pattern: /pixel/i, name: 'Google Pixel' },
      { pattern: /windows nt/i, name: 'Windows PC' },
      { pattern: /macintosh|mac os x/i, name: 'Mac' },
      { pattern: /linux/i, name: 'Linux' }
    ];
    
    for (const { pattern, name } of brandPatterns) {
      if (pattern.test(ua)) {
        return name;
      }
    }
    
    return 'Unknown Device';
  }
}

module.exports = DeviceFingerprint;
