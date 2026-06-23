/**
 * KMS Index - 密钥管理系统入口
 * 
 * 统一导出所有 KMS 相关模块。
 * 
 * @module shared/kms
 */

'use strict';

const { KeyVault, getKeyVault } = require('./KeyVault');
const { KeyService, getKeyService, KeyType, KeySensitivity, RotationPeriod } = require('./KeyService');
const { KeyRotationService, getKeyRotationService } = require('./KeyRotationService');
const { EmergencyResponseService, getEmergencyResponseService } = require('./EmergencyResponseService');

module.exports = {
  // 核心类
  KeyVault,
  KeyService,
  KeyRotationService,
  EmergencyResponseService,
  
  // 单例获取函数
  getKeyVault,
  getKeyService,
  getKeyRotationService,
  getEmergencyResponseService,
  
  // 常量
  KeyType,
  KeySensitivity,
  RotationPeriod,
  
  // 便捷方法
  /**
   * 快速获取密钥值
   */
  async getKey(keyName, options) {
    const service = getKeyService();
    return service.getKey(keyName, options);
  },
  
  /**
   * 快速创建密钥
   */
  async createKey(params) {
    const service = getKeyService();
    return service.createKey(params);
  },
  
  /**
   * 快速轮换密钥
   */
  async rotateKey(keyId, reason) {
    const service = getKeyRotationService();
    return service.rotateKey(keyId, reason);
  },
  
  /**
   * 紧急撤销密钥
   */
  async emergencyRevoke(keyName, reason) {
    const service = getEmergencyResponseService();
    return service.revokeKey(keyName, reason);
  },
  
  /**
   * 紧急轮换密钥
   */
  async emergencyRotate(keyName, reason) {
    const service = getEmergencyResponseService();
    return service.emergencyRotate(keyName, reason);
  }
};
