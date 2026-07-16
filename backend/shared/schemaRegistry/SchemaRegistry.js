'use strict';
/**
 * Schema Registry - API Schema 集中管理与版本控制
 * REQ-00547: API 响应 Schema 强制执行与合约测试自动化系统
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { getRedis } = require('../redis');
const { getPool } = require('../DatabasePool');
const logger = require('../logger');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/**
 * Schema Registry 配置
 */
const DEFAULT_CONFIG = {
  redisKeyPrefix: 'schema:registry:',
  cacheTTL: 3600, // 1 小时
  enableCache: true,
  enablePostgresPersistence: true
};

/**
 * Schema Registry 类
 */
class SchemaRegistry {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redisClient = config.redisClient || getRedis();
    this.dbPool = config.dbPool || getPool('gateway');
    this.localCache = new Map();
    this.compiledValidators = new Map();
    this.initialized = false;
  }

  /**
   * 初始化 Registry（创建数据库表）
   */
  async initialize() {
    if (this.initialized) return;

    try {
      await this.dbPool.query(`
        CREATE TABLE IF NOT EXISTS schema_registry (
          id SERIAL PRIMARY KEY,
          service_name VARCHAR(100) NOT NULL,
          route VARCHAR(255) NOT NULL,
          version VARCHAR(20) NOT NULL,
          schema_json JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT true,
          UNIQUE(service_name, route, version)
        );
        
        CREATE INDEX IF NOT EXISTS idx_schema_service_route 
        ON schema_registry(service_name, route);
        
        CREATE INDEX IF NOT EXISTS idx_schema_active 
        ON schema_registry(is_active);
      `);

      this.initialized = true;
      logger.info('SchemaRegistry initialized');
    } catch (error) {
      logger.error('Failed to initialize SchemaRegistry', { error: error.message });
      throw error;
    }
  }

  /**
   * 注册 Schema
   */
  async registerSchema(serviceName, route, version, schema) {
    await this.initialize();

    // 校验 Schema 本身有效性
    const schemaValidation = this.validateSchemaDefinition(schema);
    if (!schemaValidation.valid) {
      throw new Error(`Invalid schema: ${schemaValidation.errors.join(', ')}`);
    }

    const cacheKey = `${serviceName}:${route}:${version}`;

    try {
      // 持久化到数据库
      await this.dbPool.query(
        `INSERT INTO schema_registry (service_name, route, version, schema_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (service_name, route, version)
         DO UPDATE SET schema_json = $4, updated_at = CURRENT_TIMESTAMP`,
        [serviceName, route, version, JSON.stringify(schema)]
      );

      // 更新缓存
      if (this.config.enableCache) {
        const redisKey = `${this.config.redisKeyPrefix}${cacheKey}`;
        await this.redisClient.setex(
          redisKey,
          this.config.cacheTTL,
          JSON.stringify(schema)
        );
      }

      // 更新本地缓存
      this.localCache.set(cacheKey, schema);

      // 编译并缓存 Validator
      const validator = ajv.compile(schema);
      this.compiledValidators.set(cacheKey, validator);

      logger.info('Schema registered', {
        serviceName,
        route,
        version,
        title: schema.title || 'Untitled'
      });

      return {
        serviceName,
        route,
        version,
        registered: true,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to register schema', {
        serviceName,
        route,
        version,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 获取 Schema
   */
  async getSchema(serviceName, route, version = 'latest') {
    await this.initialize();

    const cacheKey = `${serviceName}:${route}:${version}`;

    // 先检查本地缓存
    if (this.localCache.has(cacheKey)) {
      return this.localCache.get(cacheKey);
    }

    // 检查 Redis 缓存
    if (this.config.enableCache) {
      const redisKey = `${this.config.redisKeyPrefix}${cacheKey}`;
      const cached = await this.redisClient.get(redisKey);
      if (cached) {
        const schema = JSON.parse(cached);
        this.localCache.set(cacheKey, schema);
        return schema;
      }
    }

    // 从数据库查询
    try {
      const query = version === 'latest'
        ? `SELECT schema_json FROM schema_registry 
           WHERE service_name = $1 AND route = $2 AND is_active = true 
           ORDER BY created_at DESC LIMIT 1`
        : `SELECT schema_json FROM schema_registry 
           WHERE service_name = $1 AND route = $2 AND version = $3 AND is_active = true`;

      const params = version === 'latest'
        ? [serviceName, route]
        : [serviceName, route, version];

      const result = await this.dbPool.query(query, params);

      if (result.rows.length === 0) {
        return null;
      }

      const schema = result.rows[0].schema_json;

      // 更新缓存
      this.localCache.set(cacheKey, schema);
      if (this.config.enableCache) {
        const redisKey = `${this.config.redisKeyPrefix}${cacheKey}`;
        await this.redisClient.setex(
          redisKey,
          this.config.cacheTTL,
          JSON.stringify(schema)
        );
      }

      return schema;
    } catch (error) {
      logger.error('Failed to get schema', {
        serviceName,
        route,
        version,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 列出服务的所有 Schema
   */
  async listSchemas(serviceName) {
    await this.initialize();

    try {
      const result = await this.dbPool.query(
        `SELECT route, version, schema_json->>'title' as title, 
                created_at, updated_at, is_active
         FROM schema_registry
         WHERE service_name = $1
         ORDER BY route, version`,
        [serviceName]
      );

      return result.rows.map(row => ({
        route: row.route,
        version: row.version,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active
      }));
    } catch (error) {
      logger.error('Failed to list schemas', {
        serviceName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 校验 Schema 定义本身
   */
  validateSchemaDefinition(schema) {
    const errors = [];

    if (!schema || typeof schema !== 'object') {
      return { valid: false, errors: ['Schema must be an object'] };
    }

    // 检查必需字段
    if (!schema['$schema']) {
      errors.push('Missing $schema field');
    }

    if (!schema.type) {
      errors.push('Missing type field');
    }

    // 尝试编译 Schema
    try {
      ajv.compile(schema);
    } catch (error) {
      errors.push(`Schema compilation error: ${error.message}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 校验数据是否符合 Schema
   */
  async validateAgainstSchema(data, schema) {
    let validator;

    // 使用缓存的编译器
    const schemaId = schema['$id'] || JSON.stringify(schema);
    if (this.compiledValidators.has(schemaId)) {
      validator = this.compiledValidators.get(schemaId);
    } else {
      validator = ajv.compile(schema);
      this.compiledValidators.set(schemaId, validator);
    }

    const valid = validator(data);

    return {
      valid,
      errors: valid ? [] : validator.errors.map(err => ({
        path: err.instancePath || '/',
        message: err.message,
        keyword: err.keyword
      }))
    };
  }

  /**
   * 获取版本历史
   */
  async getVersionHistory(serviceName, route) {
    await this.initialize();

    try {
      const result = await this.dbPool.query(
        `SELECT version, schema_json->>'title' as title, 
                created_at, updated_at, is_active
         FROM schema_registry
         WHERE service_name = $1 AND route = $2
         ORDER BY created_at DESC`,
        [serviceName, route]
      );

      return result.rows;
    } catch (error) {
      logger.error('Failed to get version history', {
        serviceName,
        route,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 对比两个版本的 Schema
   */
  async diffVersions(serviceName, route, v1, v2) {
    const schema1 = await this.getSchema(serviceName, route, v1);
    const schema2 = await this.getSchema(serviceName, route, v2);

    if (!schema1 || !schema2) {
      throw new Error('One or both schemas not found');
    }

    const differences = this.compareSchemas(schema1, schema2);

    return {
      serviceName,
      route,
      v1,
      v2,
      differences,
      breakingChanges: differences.filter(d => d.breaking),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 比较两个 Schema
   */
  compareSchemas(schema1, schema2) {
    const differences = [];

    // 检查 required 字段变化
    const required1 = schema1.required || [];
    const required2 = schema2.required || [];

    // 新增的必需字段（破坏性变更）
    const addedRequired = required2.filter(r => !required1.includes(r));
    if (addedRequired.length > 0) {
      differences.push({
        type: 'required_added',
        breaking: true,
        fields: addedRequired,
        message: `New required fields added: ${addedRequired.join(', ')}`
      });
    }

    // 移除的必需字段
    const removedRequired = required1.filter(r => !required2.includes(r));
    if (removedRequired.length > 0) {
      differences.push({
        type: 'required_removed',
        breaking: false,
        fields: removedRequired,
        message: `Required fields removed: ${removedRequired.join(', ')}`
      });
    }

    // 检查属性类型变化
    const props1 = schema1.properties || {};
    const props2 = schema2.properties || {};

    for (const [key, prop2] of Object.entries(props2)) {
      const prop1 = props1[key];
      if (!prop1) {
        differences.push({
          type: 'property_added',
          breaking: false,
          field: key,
          message: `New property added: ${key}`
        });
      } else if (prop1.type !== prop2.type) {
        differences.push({
          type: 'type_changed',
          breaking: true,
          field: key,
          from: prop1.type,
          to: prop2.type,
          message: `Property ${key} type changed from ${prop1.type} to ${prop2.type}`
        });
      }
    }

    for (const key of Object.keys(props1)) {
      if (!props2[key]) {
        differences.push({
          type: 'property_removed',
          breaking: true,
          field: key,
          message: `Property removed: ${key}`
        });
      }
    }

    return differences;
  }

  /**
   * 停用 Schema
   */
  async deactivateSchema(serviceName, route, version) {
    await this.initialize();

    try {
      await this.dbPool.query(
        `UPDATE schema_registry 
         SET is_active = false, updated_at = CURRENT_TIMESTAMP
         WHERE service_name = $1 AND route = $2 AND version = $3`,
        [serviceName, route, version]
      );

      // 清除缓存
      const cacheKey = `${serviceName}:${route}:${version}`;
      this.localCache.delete(cacheKey);
      this.compiledValidators.delete(cacheKey);

      if (this.config.enableCache) {
        const redisKey = `${this.config.redisKeyPrefix}${cacheKey}`;
        await this.redisClient.del(redisKey);
      }

      logger.info('Schema deactivated', { serviceName, route, version });

      return { deactivated: true, serviceName, route, version };
    } catch (error) {
      logger.error('Failed to deactivate schema', {
        serviceName,
        route,
        version,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 清除所有缓存
   */
  async clearCache() {
    this.localCache.clear();
    this.compiledValidators.clear();

    if (this.config.enableCache) {
      const pattern = `${this.config.redisKeyPrefix}*`;
      const keys = await this.redisClient.keys(pattern);
      if (keys.length > 0) {
        await this.redisClient.del(keys);
      }
    }

    logger.info('SchemaRegistry cache cleared');
  }
}

// 单例实例
let registryInstance = null;

/**
 * 获取 Schema Registry 实例
 */
function getSchemaRegistry(config = {}) {
  if (!registryInstance) {
    registryInstance = new SchemaRegistry(config);
  }
  return registryInstance;
}

module.exports = {
  SchemaRegistry,
  getSchemaRegistry
};