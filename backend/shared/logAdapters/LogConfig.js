/**
 * 日志适配器环境配置
 * 根据环境自动选择输出目标
 */
'use strict';

const StdoutAdapter = require('./StdoutAdapter');
const FileAdapter = require('./FileAdapter');
const KafkaAdapter = require('./KafkaAdapter');
const ElasticsearchAdapter = require('./ElasticsearchAdapter');
const LogAdapterManager = require('./LogAdapterManager');

const ENV_CONFIGS = {
  development: {
    adapters: [
      {
        name: 'stdout',
        type: 'StdoutAdapter',
        enabled: true,
        prettyPrint: true,
        level: 'debug'
      }
    ],
    level: 'debug'
  },
  
  testing: {
    adapters: [
      {
        name: 'stdout',
        type: 'StdoutAdapter',
        enabled: true,
        prettyPrint: false,
        level: 'info'
      },
      {
        name: 'file',
        type: 'FileAdapter',
        enabled: true,
        path: '/tmp/test.log',
        maxSize: '10MB',
        maxFiles: 5
      }
    ],
    level: 'info'
  },
  
  staging: {
    adapters: [
      {
        name: 'stdout',
        type: 'StdoutAdapter',
        enabled: true,
        level: 'info'
      },
      {
        name: 'file',
        type: 'FileAdapter',
        enabled: true,
        path: '/var/log/mineGo/staging.log',
        maxSize: '50MB',
        maxFiles: 10
      }
    ],
    level: 'info'
  },
  
  production: {
    adapters: [
      {
        name: 'stdout',
        type: 'StdoutAdapter',
        enabled: true,
        level: 'info',
        prettyPrint: false,
        isFallback: true
      },
      {
        name: 'kafka',
        type: 'KafkaAdapter',
        enabled: true,
        brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
        topic: process.env.KAFKA_LOG_TOPIC || 'minego-logs-prod',
        clientId: `minego-${process.env.SERVICE_NAME || 'app'}`,
        batchSize: 100,
        retry: { maxRetries: 5, backoffMs: 300 }
      },
      {
        name: 'elasticsearch',
        type: 'ElasticsearchAdapter',
        enabled: process.env.ES_ENABLED === 'true',
        node: process.env.ES_NODE || 'http://elasticsearch:9200',
        index: process.env.ES_LOG_INDEX || 'minego-logs',
        batchSize: 200,
        retry: { maxRetries: 5 }
      }
    ],
    level: 'info'
  }
};

/**
 * 创建适配器实例
 * @param {string} type - 适配器类型
 * @returns {ILogOutputAdapter}
 */
function createAdapter(type) {
  const adapterMap = {
    StdoutAdapter: StdoutAdapter,
    FileAdapter: FileAdapter,
    KafkaAdapter: KafkaAdapter,
    ElasticsearchAdapter: ElasticsearchAdapter
  };
  
  const AdapterClass = adapterMap[type];
  if (!AdapterClass) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  
  return new AdapterClass();
}

/**
 * 根据环境初始化日志适配器管理器
 * @param {string} env - 环境名称 (development/testing/staging/production)
 * @param {Object} customConfig - 自定义配置（可选）
 * @returns {Promise<LogAdapterManager>}
 */
async function initLogAdapterManager(env, customConfig = {}) {
  const manager = new LogAdapterManager();
  const envConfig = ENV_CONFIGS[env] || ENV_CONFIGS.development;
  const config = mergeConfigs(envConfig, customConfig);
  
  for (const adapterConfig of config.adapters) {
    const adapter = createAdapter(adapterConfig.type);
    await manager.registerAdapter(adapter, adapterConfig);
  }
  
  manager.initialized = true;
  return manager;
}

/**
 * 合并配置
 * @param {Object} base - 基础配置
 * @param {Object} custom - 自定义配置
 * @returns {Object}
 */
function mergeConfigs(base, custom) {
  const merged = { ...base };
  
  if (custom.adapters) {
    merged.adapters = base.adapters.map(adapter => {
      const customAdapter = custom.adapters.find(c => c.name === adapter.name);
      return customAdapter ? { ...adapter, ...customAdapter } : adapter;
    });
    
    // 添加自定义适配器
    const newAdapters = custom.adapters.filter(c => !base.adapters.find(a => a.name === c.name));
    merged.adapters.push(...newAdapters);
  }
  
  merged.level = custom.level || base.level;
  
  return merged;
}

/**
 * 获取当前环境配置
 * @returns {Object}
 */
function getEnvironmentConfig() {
  const env = process.env.NODE_ENV || 'development';
  return ENV_CONFIGS[env];
}

/**
 * 验证配置
 * @param {Object} config - 配置对象
 * @returns {boolean}
 */
function validateConfig(config) {
  if (!config.adapters || !Array.isArray(config.adapters)) {
    return false;
  }
  
  for (const adapter of config.adapters) {
    if (!adapter.name || !adapter.type) {
      return false;
    }
    
    // 验证特定适配器配置
    if (adapter.type === 'FileAdapter' && !adapter.path) {
      return false;
    }
    
    if (adapter.type === 'KafkaAdapter' && (!adapter.brokers || !adapter.topic)) {
      return false;
    }
    
    if (adapter.type === 'ElasticsearchAdapter' && !adapter.node) {
      return false;
    }
  }
  
  return true;
}

module.exports = {
  ENV_CONFIGS,
  createAdapter,
  initLogAdapterManager,
  getEnvironmentConfig,
  validateConfig,
  mergeConfigs
};