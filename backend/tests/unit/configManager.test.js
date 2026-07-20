/**
 * 配置管理器单元测试
 */

const { ConfigManager, getConfigManager, resetConfigManager } = require('../../shared/configManager');

describe('ConfigManager', () => {
  let configManager;

  beforeEach(() => {
    configManager = new ConfigManager();
    // 清理环境变量
    delete process.env.MINEGO_TEST_KEY;
  });

  afterEach(() => {
    configManager.config.clear();
  });

  describe('load()', () => {
    it('should load default config', async () => {
      const config = await configManager.load({
        db_host: 'localhost',
        db_port: 5432
      });
      
      expect(config.db_host).toBe('localhost');
      expect(config.db_port).toBe(5432);
    });

    it('should load environment variables with prefix', async () => {
      process.env.MINEGO_DB_HOST = 'production-host';
      process.env.MINEGO_DB_PORT = '5433';
      
      const config = await configManager.load({
        db_host: 'localhost'
      });
      
      expect(config.db_host).toBe('production-host');
      expect(config.db_port).toBe(5433);
    });

    it('should parse JSON values from env', async () => {
      process.env.MINEGO_ARRAY_VALUE = '["item1","item2"]';
      
      const config = await configManager.load({});
      
      expect(Array.isArray(config.array_value)).toBe(true);
      expect(config.array_value).toEqual(['item1', 'item2']);
    });

    it('should mark config as loaded', async () => {
      expect(configManager.loaded).toBe(false);
      
      await configManager.load({});
      
      expect(configManager.loaded).toBe(true);
    });
  });

  describe('get()', () => {
    it('should return config value', () => {
      configManager.config.set('test_key', { value: 'test_value', source: 'default' });
      
      expect(configManager.get('test_key')).toBe('test_value');
    });

    it('should return default value if not exists', () => {
      expect(configManager.get('non_existent', 'default')).toBe('default');
    });

    it('should return null if not exists and no default', () => {
      expect(configManager.get('non_existent')).toBe(null);
    });
  });

  describe('set()', () => {
    it('should set config value', () => {
      configManager.set('runtime_key', 'runtime_value');
      
      expect(configManager.get('runtime_key')).toBe('runtime_value');
    });

    it('should mark source as runtime', () => {
      configManager.set('runtime_key', 'value');
      
      const meta = configManager.getMeta('runtime_key');
      expect(meta.source).toBe('runtime');
    });

    it('should call onChange callback', () => {
      const onChange = jest.fn();
      configManager.onChange = onChange;
      
      configManager.set('test_key', 'test_value');
      
      expect(onChange).toHaveBeenCalledWith('test_key', 'test_value');
    });
  });

  describe('has()', () => {
    it('should return true if config exists', () => {
      configManager.config.set('test', { value: 'value', source: 'default' });
      
      expect(configManager.has('test')).toBe(true);
    });

    it('should return false if config not exists', () => {
      expect(configManager.has('non_existent')).toBe(false);
    });
  });

  describe('validate()', () => {
    it('should pass validation if all keys exist', () => {
      configManager.config.set('key1', { value: 'value1', source: 'default' });
      configManager.config.set('key2', { value: 'value2', source: 'default' });
      
      expect(() => {
        configManager.validate(['key1', 'key2']);
      }).not.toThrow();
    });

    it('should throw error if keys missing', () => {
      configManager.config.set('key1', { value: 'value1', source: 'default' });
      
      expect(() => {
        configManager.validate(['key1', 'key2', 'key3']);
      }).toThrow('Missing required config: key2, key3');
    });
  });

  describe('getDatabaseConfig()', () => {
    it('should return database config with defaults', async () => {
      await configManager.load({});
      
      const dbConfig = configManager.getDatabaseConfig();
      
      expect(dbConfig.host).toBe('localhost');
      expect(dbConfig.port).toBe(5432);
      expect(dbConfig.database).toBe('minego');
    });

    it('should override with env variables', async () => {
      process.env.MINEGO_DB_HOST = 'prod-db';
      process.env.MINEGO_DB_PORT = '5433';
      
      await configManager.load({});
      
      const dbConfig = configManager.getDatabaseConfig();
      
      expect(dbConfig.host).toBe('prod-db');
      expect(dbConfig.port).toBe(5433);
    });
  });

  describe('getRedisConfig()', () => {
    it('should return Redis config with defaults', async () => {
      await configManager.load({});
      
      const redisConfig = configManager.getRedisConfig();
      
      expect(redisConfig.host).toBe('localhost');
      expect(redisConfig.port).toBe(6379);
      expect(redisConfig.keyPrefix).toBe('minego:');
    });
  });

  describe('getKafkaConfig()', () => {
    it('should return Kafka config with defaults', async () => {
      await configManager.load({});
      
      const kafkaConfig = configManager.getKafkaConfig();
      
      expect(kafkaConfig.brokers).toEqual(['localhost:9092']);
      expect(kafkaConfig.clientId).toBe('minego');
    });

    it('should parse comma-separated brokers', async () => {
      process.env.MINEGO_KAFKA_BROKERS = 'broker1:9092,broker2:9092';
      
      await configManager.load({});
      
      const kafkaConfig = configManager.getKafkaConfig();
      
      expect(kafkaConfig.brokers).toEqual(['broker1:9092', 'broker2:9092']);
    });
  });

  describe('getServiceConfig()', () => {
    it('should return service config with defaults', async () => {
      await configManager.load({});
      
      const serviceConfig = configManager.getServiceConfig('gateway');
      
      expect(serviceConfig.name).toBe('gateway');
      expect(serviceConfig.port).toBe(3000);
      expect(serviceConfig.logLevel).toBe('info');
    });
  });

  describe('getAll()', () => {
    it('should return all config values', () => {
      configManager.config.set('key1', { value: 'value1', source: 'default' });
      configManager.config.set('key2', { value: 'value2', source: 'env' });
      
      const all = configManager.getAll();
      
      expect(all).toEqual({
        key1: 'value1',
        key2: 'value2'
      });
    });
  });

  describe('export()', () => {
    it('should export config with metadata', () => {
      configManager.config.set('key1', { value: 'value1', source: 'default' });
      
      const exported = configManager.export();
      
      expect(exported.key1).toEqual({
        value: 'value1',
        source: 'default'
      });
    });
  });
});

describe('Global ConfigManager', () => {
  afterEach(() => {
    resetConfigManager();
  });

  it('should return same instance', () => {
    const manager1 = getConfigManager();
    const manager2 = getConfigManager();
    
    expect(manager1).toBe(manager2);
  });

  it('should reset global instance', () => {
    const manager1 = getConfigManager();
    resetConfigManager();
    const manager2 = getConfigManager();
    
    expect(manager1).not.toBe(manager2);
  });
});
