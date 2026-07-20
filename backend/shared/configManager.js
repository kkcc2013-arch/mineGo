/**
 * 配置管理器 - 统一管理服务配置
 * 
 * 配置加载优先级：
 * 1. 环境变量（最高）
 * 2. 配置中心（如果启用）
 * 3. 本地配置文件
 * 4. 默认值（最低）
 * 
 * @module configManager
 */

const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor(options = {}) {
    this.config = new Map();
    this.loaded = false;
    this.configDir = options.configDir || process.cwd();
    this.envPrefix = options.envPrefix || 'MINEGO_';
    this.onChange = options.onChange || null;
  }

  /**
   * 加载配置
   * @param {Object} defaultConfig - 默认配置
   * @returns {Object} 合并后的配置
   */
  async load(defaultConfig = {}) {
    // 1. 应用默认配置
    this._applyConfig(defaultConfig, 'default');

    // 2. 加载本地配置文件
    await this._loadConfigFile();

    // 3. 加载环境变量
    this._loadEnvVariables();

    // 4. 加载配置中心（如果启用）
    if (process.env.CONFIG_CENTER_ENABLED === 'true') {
      await this._loadConfigCenter();
    }

    this.loaded = true;
    return this.getAll();
  }

  /**
   * 应用配置对象
   * @private
   */
  _applyConfig(config, source = 'unknown') {
    for (const [key, value] of Object.entries(config)) {
      this.config.set(key, {
        value,
        source
      });
    }
  }

  /**
   * 加载本地配置文件
   * @private
   */
  async _loadConfigFile() {
    const configPath = path.join(this.configDir, 'config', 'config.json');
    
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        this._applyConfig(config, 'file');
      } catch (error) {
        console.error('Failed to load config file:', error.message);
      }
    }
  }

  /**
   * 加载环境变量
   * @private
   */
  _loadEnvVariables() {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(this.envPrefix)) {
        const configKey = key.substring(this.envPrefix.length).toLowerCase();
        
        // 尝试解析 JSON 值
        let parsedValue = value;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // 保持原字符串
        }

        this.config.set(configKey, {
          value: parsedValue,
          source: 'env'
        });
      }
    }
  }

  /**
   * 加载配置中心
   * @private
   */
  async _loadConfigCenter() {
    // 这里简化实现，实际项目可集成 Consul、etcd 等
    const configCenterUrl = process.env.CONFIG_CENTER_URL;
    
    if (configCenterUrl) {
      try {
        // 示例：从配置中心获取配置
        // const response = await fetch(`${configCenterUrl}/config`);
        // const config = await response.json();
        // this._applyConfig(config, 'config-center');
      } catch (error) {
        console.error('Failed to load from config center:', error.message);
      }
    }
  }

  /**
   * 获取配置值
   * @param {string} key - 配置键
   * @param {*} defaultValue - 默认值
   * @returns {*} 配置值
   */
  get(key, defaultValue = null) {
    const entry = this.config.get(key);
    return entry ? entry.value : defaultValue;
  }

  /**
   * 获取所有配置
   * @returns {Object} 所有配置
   */
  getAll() {
    const result = {};
    for (const [key, entry] of this.config.entries()) {
      result[key] = entry.value;
    }
    return result;
  }

  /**
   * 设置配置值
   * @param {string} key - 配置键
   * @param {*} value - 配置值
   */
  set(key, value) {
    this.config.set(key, {
      value,
      source: 'runtime'
    });

    // 触发变更回调
    if (this.onChange) {
      this.onChange(key, value);
    }
  }

  /**
   * 检查配置是否存在
   */
  has(key) {
    return this.config.has(key);
  }

  /**
   * 获取配置元数据
   */
  getMeta(key) {
    return this.config.get(key);
  }

  /**
   * 验证必需配置
   * @param {string[]} requiredKeys - 必需的配置键
   * @throws {Error} 如果缺少必需配置
   */
  validate(requiredKeys) {
    const missing = [];
    
    for (const key of requiredKeys) {
      if (!this.has(key) || this.get(key) === null) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      throw new Error(`Missing required config: ${missing.join(', ')}`);
    }
  }

  /**
   * 获取数据库配置
   */
  getDatabaseConfig() {
    return {
      host: this.get('db_host', 'localhost'),
      port: this.get('db_port', 5432),
      database: this.get('db_name', 'minego'),
      user: this.get('db_user', 'postgres'),
      password: this.get('db_password', ''),
      max: this.get('db_pool_max', 20),
      idleTimeoutMillis: this.get('db_idle_timeout', 30000),
      connectionTimeoutMillis: this.get('db_connection_timeout', 2000)
    };
  }

  /**
   * 获取 Redis 配置
   */
  getRedisConfig() {
    return {
      host: this.get('redis_host', 'localhost'),
      port: this.get('redis_port', 6379),
      password: this.get('redis_password', ''),
      db: this.get('redis_db', 0),
      keyPrefix: this.get('redis_prefix', 'minego:')
    };
  }

  /**
   * 获取 Kafka 配置
   */
  getKafkaConfig() {
    return {
      brokers: this.get('kafka_brokers', 'localhost:9092').split(','),
      clientId: this.get('kafka_client_id', 'minego'),
      groupId: this.get('kafka_group_id', 'minego-group')
    };
  }

  /**
   * 获取服务配置
   */
  getServiceConfig(serviceName) {
    return {
      name: serviceName,
      port: this.get(`${serviceName}_port`, 3000),
      host: this.get(`${serviceName}_host`, '0.0.0.0'),
      logLevel: this.get('log_level', 'info'),
      env: this.get('node_env', 'development')
    };
  }

  /**
   * 导出配置（用于调试）
   */
  export() {
    const result = {};
    for (const [key, entry] of this.config.entries()) {
      result[key] = {
        value: entry.value,
        source: entry.source
      };
    }
    return result;
  }
}

// 全局配置管理器实例
let globalConfigManager = null;

/**
 * 获取全局配置管理器
 */
function getConfigManager() {
  if (!globalConfigManager) {
    globalConfigManager = new ConfigManager();
  }
  return globalConfigManager;
}

/**
 * 重置配置管理器（测试用）
 */
function resetConfigManager() {
  globalConfigManager = null;
}

module.exports = {
  ConfigManager,
  getConfigManager,
  resetConfigManager
};
