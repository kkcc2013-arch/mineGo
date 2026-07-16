/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * 加密模块导出
 */

'use strict';

module.exports = {
  // 加密引擎
  EncryptionEngine: require('./EncryptionEngine').EncryptionEngine,
  createEncryptionEngine: require('./EncryptionEngine').createEncryptionEngine,
  
  // 密钥管理
  KeyManagementService: require('./KeyManagementService').KeyManagementService,
  createKeyManagementService: require('./KeyManagementService').createKeyManagementService,
  getDefaultKMS: require('./KeyManagementService').getDefaultKMS,
  
  // ORM 集成
  EncryptedField: require('./EncryptedField').EncryptedField,
  setupEncryptedModel: require('./EncryptedField').setupEncryptedModel,
  initializeEncryption: require('./EncryptedField').initializeEncryption,
  getEncryptionEngine: require('./EncryptedField').getEncryptionEngine,
  encryptQueryValue: require('./EncryptedField').encryptQueryValue,
  encryptBatchData: require('./EncryptedField').encryptBatchData,
  decryptBatchData: require('./EncryptedField').decryptBatchData
};