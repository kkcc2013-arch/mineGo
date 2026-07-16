// mockService/core/MockConfig.js - Mock 服务配置管理
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * MockConfig - Mock 服务配置管理器
 * 
 * 特性：
 * - YAML/JSON 配置文件支持
 * - 环境变量覆盖
 * - 配置热重载
 * - 配置验证
 */

const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml');
const { createLogger } = require('../../logger');

const logger = createLogger('mock-config');

/**
 * 默认配置结构
 */
const DEFAULT_CONFIG_SCHEMA = {
  // 服务器配置
  server: {
    port: { type: 'number', default: 9000 },
    host: { type: 'string', default: '0.0.0.0' },
    mode: { type: 'string', enum: ['replay', 'record', 'passthrough'], default: 'replay' },
    enableMetrics: { type: 'boolean', default: true },
    enableLogging: { type: 'boolean', default: true }
  },
  
  // 响应配置
  response: {
    defaultDelay: { type: 'number', default: 0 },
    defaultStatus: { type: 'number', default: 200 },
    injectErrors: { type: 'boolean', default: false },
    errorRate: { type: 'number', default: 0.1 }
  },
  
  // 录制配置
  recording: {
    enabled: { type: 'boolean', default: false },
    maxRecords: { type: 'number', default: 10000 },
    outputPath: { type: 'string', default: './mock-recordings' },
    flushInterval: { type: 'number', default: 60000 }
  },
  
  // 数据工厂配置
  dataFactory: {
    seed: { type: 'number', default: null },
    locale: { type: 'string', default: 'en' },
    generateImages: { type: 'boolean', default: false }
  }
};

/**
 * Mock 配置类
 */
class MockConfig {
  constructor(config = {}) {
    this.config = {};
    this.configPath = null;
    this.watchers = new Map();
    
    // 加载配置
    this._loadConfig(config);
    
    logger.info({ config: this.config }, 'MockConfig initialized');
  }

  /**
   * 加载配置（优先级：环境变量 > 参数 > 文件 > 默认值）
   */
  _loadConfig(config) {
    // 从默认值开始
    this.config = this._loadDefaults();
    
    // 应用参数配置
    this._mergeConfig(config);
    
    // 应用环境变量
    this._loadFromEnv();
    
    return this.config;
  }

  /**
   * 加载默认配置
   */
  _loadDefaults() {
    const defaults = {};
    
    for (const [section, fields] of Object.entries(DEFAULT_CONFIG_SCHEMA)) {
      defaults[section] = {};
      for (const [key, schema] of Object.entries(fields)) {
        defaults[section][key] = schema.default;
      }
    }
    
    return defaults;
  }

  /**
   * 合并配置
   */
  _mergeConfig(newConfig) {
    for (const [section, values] of Object.entries(newConfig)) {
      if (!this.config[section]) {
        this.config[section] = {};
      }
      this.config[section] = { ...this.config[section], ...values };
    }
  }

  /**
   * 从环境变量加载配置
   */
  _loadFromEnv() {
    const envMappings = {
      'MOCK_PORT': 'server.port',
      'MOCK_HOST': 'server.host',
      'MOCK_MODE': 'server.mode',
      'MOCK_METRICS': 'server.enableMetrics',
      'MOCK_LOGGING': 'server.enableLogging',
      'MOCK_DELAY': 'response.defaultDelay',
      'MOCK_RECORD': 'recording.enabled',
      'MOCK_SEED': 'dataFactory.seed',
      'MOCK_LOCALE': 'dataFactory.locale'
    };

    for (const [envKey, configPath] of Object.entries(envMappings)) {
      if (process.env[envKey] !== undefined) {
        const value = process.env[envKey];
        this._setNestedValue(configPath, this._parseEnvValue(value));
      }
    }
  }

  /**
   * 解析环境变量值
   */
  _parseEnvValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (!isNaN(value)) return parseFloat(value);
    return value;
  }

  /**
   * 设置嵌套值
   */
  _setNestedValue(pathStr, value) {
    const parts = pathStr.split('.');
    let current = this.config;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current[parts[parts.length - 1]] = value;
  }

  /**
   * 从文件加载配置
   */
  async loadFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();
      
      let config;
      if (ext === '.yaml' || ext === '.yml') {
        config = yaml.parse(content);
      } else {
        config = JSON.parse(content);
      }
      
      this._mergeConfig(config);
      this.configPath = filePath;
      
      logger.info({ path: filePath }, 'Configuration loaded from file');
      return this.config;
      
    } catch (error) {
      logger.error({ error: error.message, path: filePath }, 'Failed to load config file');
      throw error;
    }
  }

  /**
   * 保存配置到文件
   */
  async saveToFile(filePath) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      let content;
      
      if (ext === '.yaml' || ext === '.yml') {
        content = yaml.stringify(this.config);
      } else {
        content = JSON.stringify(this.config, null, 2);
      }
      
      await fs.writeFile(filePath, content, 'utf8');
      
      logger.info({ path: filePath }, 'Configuration saved to file');
      
    } catch (error) {
      logger.error({ error: error.message, path: filePath }, 'Failed to save config file');
      throw error;
    }
  }

  /**
   * 获取配置值
   */
  get(pathStr, defaultValue = undefined) {
    const parts = pathStr.split('.');
    let current = this.config;
    
    for (const part of parts) {
      if (current === undefined || current === null) {
        return defaultValue;
      }
      current = current[part];
    }
    
    return current !== undefined ? current : defaultValue;
  }

  /**
   * 设置配置值
   */
  set(pathStr, value) {
    this._setNestedValue(pathStr, value);
    return this;
  }

  /**
   * 验证配置
   */
  validate() {
    const errors = [];
    
    for (const [section, fields] of Object.entries(DEFAULT_CONFIG_SCHEMA)) {
      for (const [key, schema] of Object.entries(fields)) {
        const value = this.get(`${section}.${key}`);
        
        // 类型检查
        if (value !== undefined) {
          if (schema.type === 'number' && typeof value !== 'number') {
            errors.push(`${section}.${key} must be a number, got ${typeof value}`);
          } else if (schema.type === 'string' && typeof value !== 'string') {
            errors.push(`${section}.${key} must be a string, got ${typeof value}`);
          } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
            errors.push(`${section}.${key} must be a boolean, got ${typeof value}`);
          }
          
          // 枚举检查
          if (schema.enum && !schema.enum.includes(value)) {
            errors.push(`${section}.${key} must be one of: ${schema.enum.join(', ')}`);
          }
        }
      }
    }
    
    if (errors.length > 0) {
      logger.error({ errors }, 'Configuration validation failed');
      return { valid: false, errors };
    }
    
    return { valid: true, errors: [] };
  }

  /**
   * 监视配置文件变化
   */
  async watch(filePath) {
    const absolutePath = path.resolve(filePath);
    
    if (this.watchers.has(absolutePath)) {
      return;
    }
    
    try {
      const { watch } = require('fs');
      const watcher = watch(absolutePath, async (eventType) => {
        if (eventType === 'change') {
          logger.info({ path: absolutePath }, 'Config file changed, reloading');
          try {
            await this.loadFromFile(absolutePath);
            this.emit('reload', this.config);
          } catch (error) {
            logger.error({ error: error.message }, 'Failed to reload config');
          }
        }
      });
      
      this.watchers.set(absolutePath, watcher);
      logger.info({ path: absolutePath }, 'Watching config file');
      
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to watch config file');
    }
  }

  /**
   * 停止监视
   */
  unwatch(filePath) {
    const absolutePath = path.resolve(filePath);
    const watcher = this.watchers.get(absolutePath);
    
    if (watcher) {
      watcher.close();
      this.watchers.delete(absolutePath);
      logger.info({ path: absolutePath }, 'Stopped watching config file');
    }
  }

  /**
   * 导出配置
   */
  toJSON() {
    return { ...this.config };
  }

  /**
   * 克隆配置
   */
  clone() {
    return new MockConfig(JSON.parse(JSON.stringify(this.config)));
  }
}

// 添加 EventEmitter 支持
const EventEmitter = require('events');
Object.assign(MockConfig.prototype, EventEmitter.prototype);

module.exports = MockConfig;