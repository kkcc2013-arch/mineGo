/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * Sequelize ORM 加密字段集成
 * - 模型层自动加密/解密
 * - 支持虚拟字段（加密存储、明文访问）
 * - 批量查询时的自动解密
 */

'use strict';

const { createLogger } = require('../logger');
const { createEncryptionEngine } = require('./EncryptionEngine');
const { getDefaultKMS } = require('./KeyManagementService');

const logger = createLogger('encrypted-field');

// 全局加密引擎实例
let encryptionEngine = null;

/**
 * 初始化加密引擎
 * @param {Object} options - 配置选项
 */
async function initializeEncryption(options = {}) {
  const kms = options.kms || getDefaultKMS();
  await kms.initialize();

  const masterKey = await kms.getCurrentKey(options.keyId || 'master');

  encryptionEngine = createEncryptionEngine({
    masterKey: masterKey.toString('base64'),
    keyId: options.keyId || 'master',
    keyProvider: {
      getCurrentKey: async (keyId) => kms.getCurrentKey(keyId)
    }
  });

  logger.info('Encryption engine initialized');
}

/**
 * 获取加密引擎实例
 * @returns {EncryptionEngine}
 */
function getEncryptionEngine() {
  if (!encryptionEngine) {
    throw new Error('Encryption not initialized. Call initializeEncryption() first.');
  }
  return encryptionEngine;
}

/**
 * 加密字段装饰器
 * 用于 Sequelize 模型定义
 * 
 * @param {Object} options - 配置选项
 * @param {boolean} options.searchable - 是否支持搜索（确定性加密）
 * @param {string} options.context - 加密上下文
 * @param {Function} options.validate - 自定义验证函数
 * @returns {Object} Sequelize 字段配置
 */
function EncryptedField(options = {}) {
  const {
    searchable = false,
    context,
    validate
  } = options;

  if (!context) {
    throw new Error('EncryptedField requires a context (e.g., "users.phone")');
  }

  return {
    // 字段类型应为 STRING，长度需考虑加密后的大小
    type: undefined, // 由调用者指定
    
    // Getter: 自动解密
    get() {
      const encrypted = this.getDataValue(this._rawFieldName());
      if (encrypted === null || encrypted === undefined) {
        return null;
      }

      try {
        const engine = getEncryptionEngine();
        // 同步解密（如果引擎支持）
        // 这里简化处理，实际可能需要异步 getter
        return encrypted; // 先返回密文，在 afterFind 钩子中处理
      } catch (error) {
        logger.error('Failed to decrypt field', { context, error: error.message });
        return null;
      }
    },

    // Setter: 自动加密
    set(value) {
      if (value === null || value === undefined || value === '') {
        this.setDataValue(this._rawFieldName(), value);
        return;
      }

      try {
        // 同步加密在模型保存前处理
        // 这里存储原始值，在 beforeCreate/beforeUpdate 钩子中加密
        this._pendingEncryption = this._pendingEncryption || {};
        this._pendingEncryption[this._rawFieldName()] = {
          value,
          context,
          searchable
        };
        this.setDataValue(this._rawFieldName(), value);
      } catch (error) {
        logger.error('Failed to set encrypted field', { context, error: error.message });
        throw error;
      }
    },

    // 验证
    validate: validate || undefined,

    // 元数据（用于钩子处理）
    _encryptedField: true,
    _encryptionContext: context,
    _encryptionSearchable: searchable
  };
}

/**
 * 获取原始字段名（处理 Sequelize 别名）
 */
function _rawFieldName() {
  return this.model.rawAttributes[this.attributeName] ? this.attributeName : this.attributeName;
}

/**
 * 创建加密字段模型混入
 * 为模型添加加密相关的方法和钩子
 * 
 * @param {Object} sequelize - Sequelize 实例
 * @param {Object} Model - 模型类
 * @param {Object} options - 配置选项
 */
function setupEncryptedModel(sequelize, Model, options = {}) {
  // 收集加密字段配置
  const encryptedFields = {};
  
  for (const [fieldName, fieldConfig] of Object.entries(Model.rawAttributes || {})) {
    if (fieldConfig._encryptedField) {
      encryptedFields[fieldName] = {
        context: fieldConfig._encryptionContext,
        searchable: fieldConfig._encryptionSearchable
      };
    }
  }

  if (Object.keys(encryptedFields).length === 0) {
    return; // 没有加密字段
  }

  logger.info('Setting up encrypted model', {
    model: Model.name,
    encryptedFields: Object.keys(encryptedFields)
  });

  // beforeCreate 钩子：加密
  Model.addHook('beforeCreate', async (instance, options) => {
    await encryptInstance(instance, encryptedFields);
  });

  // beforeUpdate 钩子：加密
  Model.addHook('beforeUpdate', async (instance, options) => {
    await encryptInstance(instance, encryptedFields);
  });

  // beforeSave 钩子：加密（同时处理 create 和 update）
  Model.addHook('beforeSave', async (instance, options) => {
    await encryptInstance(instance, encryptedFields);
  });

  // afterFind 钩子：解密
  Model.addHook('afterFind', async (result, options) => {
    if (!result) return;

    if (Array.isArray(result)) {
      for (const instance of result) {
        await decryptInstance(instance, encryptedFields);
      }
    } else {
      await decryptInstance(result, encryptedFields);
    }
  });

  // afterCreate 钩子：解密（返回时显示明文）
  Model.addHook('afterCreate', async (instance, options) => {
    await decryptInstance(instance, encryptedFields);
  });

  // afterUpdate 钩子：解密
  Model.addHook('afterUpdate', async (instance, options) => {
    await decryptInstance(instance, encryptedFields);
  });
}

/**
 * 加密实例字段
 */
async function encryptInstance(instance, encryptedFields) {
  const engine = getEncryptionEngine();

  for (const [fieldName, fieldConfig] of Object.entries(encryptedFields)) {
    const value = instance.getDataValue(fieldName);
    
    if (value === null || value === undefined || value === '') {
      continue;
    }

    try {
      const encrypted = fieldConfig.searchable
        ? await engine.encryptDeterministic(value, fieldConfig.context)
        : await engine.encryptRandom(value, fieldConfig.context);
      
      instance.setDataValue(fieldName, encrypted);
      
      // 存储明文到虚拟属性（用于后续解密）
      instance._plainTextValues = instance._plainTextValues || {};
      instance._plainTextValues[fieldName] = value;
    } catch (error) {
      logger.error('Failed to encrypt field', {
        fieldName,
        context: fieldConfig.context,
        error: error.message
      });
      throw error;
    }
  }
}

/**
 * 解密实例字段
 */
async function decryptInstance(instance, encryptedFields) {
  if (!instance) return;

  const engine = getEncryptionEngine();

  for (const [fieldName, fieldConfig] of Object.entries(encryptedFields)) {
    const encrypted = instance.getDataValue(fieldName);
    
    if (encrypted === null || encrypted === undefined || encrypted === '') {
      continue;
    }

    try {
      const decrypted = await engine.decrypt(encrypted, fieldConfig.context);
      instance.setDataValue(fieldName, decrypted);
      
      // 更新虚拟属性
      instance._plainTextValues = instance._plainTextValues || {};
      instance._plainTextValues[fieldName] = decrypted;
    } catch (error) {
      logger.error('Failed to decrypt field', {
        fieldName,
        context: fieldConfig.context,
        error: error.message
      });
      // 解密失败时保留密文
    }
  }
}

/**
 * 加密查询工具
 * 用于构建加密字段的查询条件
 * 
 * @param {string} value - 要查询的值
 * @param {string} context - 加密上下文
 * @returns {Promise<string>} 加密后的值
 */
async function encryptQueryValue(value, context) {
  const engine = getEncryptionEngine();
  return engine.encryptDeterministic(value, context);
}

/**
 * 批量加密数据
 * 
 * @param {Array<Object>} data - 数据数组
 * @param {Object} fieldMappings - 字段映射 { fieldName: context }
 * @returns {Promise<Array<Object>>} 加密后的数据
 */
async function encryptBatchData(data, fieldMappings) {
  const engine = getEncryptionEngine();
  const result = [];

  for (const item of data) {
    const encryptedItem = { ...item };
    
    for (const [fieldName, context] of Object.entries(fieldMappings)) {
      if (encryptedItem[fieldName] !== null && encryptedItem[fieldName] !== undefined) {
        encryptedItem[fieldName] = await engine.encryptRandom(encryptedItem[fieldName], context);
      }
    }
    
    result.push(encryptedItem);
  }

  return result;
}

/**
 * 批量解密数据
 * 
 * @param {Array<Object>} data - 数据数组
 * @param {Object} fieldMappings - 字段映射 { fieldName: context }
 * @returns {Promise<Array<Object>>} 解密后的数据
 */
async function decryptBatchData(data, fieldMappings) {
  const engine = getEncryptionEngine();
  const result = [];

  for (const item of data) {
    const decryptedItem = { ...item };
    
    for (const [fieldName, context] of Object.entries(fieldMappings)) {
      if (decryptedItem[fieldName] !== null && decryptedItem[fieldName] !== undefined) {
        try {
          decryptedItem[fieldName] = await engine.decrypt(decryptedItem[fieldName], context);
        } catch (error) {
          logger.error('Batch decryption failed', { fieldName, error: error.message });
        }
      }
    }
    
    result.push(decryptedItem);
  }

  return result;
}

module.exports = {
  initializeEncryption,
  getEncryptionEngine,
  EncryptedField,
  setupEncryptedModel,
  encryptQueryValue,
  encryptBatchData,
  decryptBatchData
};