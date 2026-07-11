/**
 * ResourceDiscoverer - 资源发现器
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 * 
 * 提供资源发现端点，客户端可以自动发现可用资源和操作
 */

'use strict';

const { createLogger } = require('../logger');
const { defaultLinkBuilder } = require('./LinkBuilder');
const { defaultHalFormatter } = require('./HalFormatter');
const logger = createLogger('resource-discoverer');

/**
 * 资源定义结构
 */
const ResourceDefinition = {
  name: String,           // 资源名称
  path: String,           // 资源路径
  description: String,    // 资源描述
  methods: Array,         // 支持的 HTTP 方法
  actions: Array,         // 可执行操作
  relationships: Object,  // 关联资源
  schema: Object         // 资源 Schema
};

/**
 * ResourceDiscoverer 类
 */
class ResourceDiscoverer {
  /**
   * @param {Object} config - 配置
   */
  constructor(config = {}) {
    this.linkBuilder = config.linkBuilder || defaultLinkBuilder;
    this.halFormatter = config.halFormatter || defaultHalFormatter;
    this.discoveryCache = new Map();
    this.cacheTTL = config.cacheTTL || 3600000; // 1 小时
    this.resourceDefinitions = new Map();
    this.serviceEndpoints = new Map();
    
    // 初始化默认资源定义
    this._initDefaultResourceDefinitions();
    
    logger.info('ResourceDiscoverer initialized');
  }

  /**
   * 初始化默认资源定义
   */
  _initDefaultResourceDefinitions() {
    // Pokemon 资源
    this.registerResource('pokemon', {
      path: 'pokemon',
      description: 'Pokemon resources',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      actions: ['catch', 'evolve', 'battle', 'trade', 'feed', 'train', 'heal', 'release'],
      relationships: {
        owner: { resource: 'user', type: 'belongsTo' },
        location: { resource: 'location', type: 'belongsTo' },
        stats: { resource: 'stats', type: 'embedded' },
        moves: { resource: 'moves', type: 'hasMany' }
      },
      schema: {
        id: { type: 'string', description: 'Pokemon ID' },
        speciesId: { type: 'string', description: 'Species ID' },
        name: { type: 'string', description: 'Pokemon name' },
        cp: { type: 'number', description: 'Combat Power' },
        hp: { type: 'number', description: 'Health Points' },
        level: { type: 'number', description: 'Pokemon level' }
      }
    });
    
    // User 资源
    this.registerResource('user', {
      path: 'users',
      description: 'User resources',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      actions: ['update', 'delete'],
      relationships: {
        pokemon: { resource: 'pokemon', type: 'hasMany' },
        friends: { resource: 'user', type: 'belongsToMany' },
        items: { resource: 'item', type: 'hasMany' },
        achievements: { resource: 'achievement', type: 'hasMany' }
      },
      schema: {
        id: { type: 'string', description: 'User ID' },
        username: { type: 'string', description: 'Username' },
        email: { type: 'string', description: 'Email address' },
        level: { type: 'number', description: 'User level' },
        xp: { type: 'number', description: 'Experience points' }
      }
    });
    
    // Gym 资源
    this.registerResource('gym', {
      path: 'gyms',
      description: 'Gym resources',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      actions: ['battle', 'claim', 'defend'],
      relationships: {
        owner: { resource: 'user', type: 'belongsTo' },
        members: { resource: 'pokemon', type: 'hasMany' },
        battles: { resource: 'battle', type: 'hasMany' },
        location: { resource: 'location', type: 'belongsTo' }
      },
      schema: {
        id: { type: 'string', description: 'Gym ID' },
        name: { type: 'string', description: 'Gym name' },
        team: { type: 'string', enum: ['red', 'blue', 'yellow'], description: 'Team color' },
        latitude: { type: 'number', description: 'Latitude' },
        longitude: { type: 'number', description: 'Longitude' }
      }
    });
    
    // Location 资源
    this.registerResource('location', {
      path: 'locations',
      description: 'Location resources',
      methods: ['GET'],
      actions: [],
      relationships: {
        pokemon: { resource: 'pokemon', type: 'hasMany' },
        gyms: { resource: 'gym', type: 'hasMany' }
      },
      schema: {
        id: { type: 'string', description: 'Location ID' },
        name: { type: 'string', description: 'Location name' },
        latitude: { type: 'number', description: 'Latitude' },
        longitude: { type: 'number', description: 'Longitude' }
      }
    });
    
    // Item 资源
    this.registerResource('item', {
      path: 'items',
      description: 'Item resources',
      methods: ['GET', 'POST', 'DELETE'],
      actions: ['use', 'sell', 'discard'],
      relationships: {
        owner: { resource: 'user', type: 'belongsTo' }
      },
      schema: {
        id: { type: 'string', description: 'Item ID' },
        name: { type: 'string', description: 'Item name' },
        type: { type: 'string', description: 'Item type' },
        quantity: { type: 'number', description: 'Quantity' }
      }
    });
    
    // Battle 资源
    this.registerResource('battle', {
      path: 'battles',
      description: 'Battle resources',
      methods: ['GET', 'POST'],
      actions: ['attack', 'defend', 'escape'],
      relationships: {
        attacker: { resource: 'pokemon', type: 'belongsTo' },
        defender: { resource: 'pokemon', type: 'belongsTo' },
        gym: { resource: 'gym', type: 'belongsTo' }
      },
      schema: {
        id: { type: 'string', description: 'Battle ID' },
        status: { type: 'string', enum: ['active', 'won', 'lost'], description: 'Battle status' },
        startTime: { type: 'string', format: 'date-time', description: 'Start time' }
      }
    });
    
    // Reward 资源
    this.registerResource('reward', {
      path: 'rewards',
      description: 'Reward resources',
      methods: ['GET', 'POST'],
      actions: ['claim'],
      relationships: {
        user: { resource: 'user', type: 'belongsTo' }
      },
      schema: {
        id: { type: 'string', description: 'Reward ID' },
        type: { type: 'string', description: 'Reward type' },
        value: { type: 'number', description: 'Reward value' },
        claimed: { type: 'boolean', description: 'Claimed status' }
      }
    });
    
    // Payment 资源
    this.registerResource('payment', {
      path: 'payments',
      description: 'Payment resources',
      methods: ['GET', 'POST'],
      actions: ['refund'],
      relationships: {
        user: { resource: 'user', type: 'belongsTo' }
      },
      schema: {
        id: { type: 'string', description: 'Payment ID' },
        amount: { type: 'number', description: 'Payment amount' },
        currency: { type: 'string', description: 'Currency code' },
        status: { type: 'string', enum: ['pending', 'completed', 'failed', 'refunded'], description: 'Payment status' }
      }
    });
  }

  /**
   * 注册资源定义
   * @param {string} name - 资源名称
   * @param {Object} definition - 资源定义
   */
  registerResource(name, definition) {
    this.resourceDefinitions.set(name, {
      name,
      ...definition
    });
    
    // 同步到 LinkBuilder
    if (definition.path) {
      this.linkBuilder.registerResourcePath(name, definition.path);
    }
    
    if (definition.relationships) {
      this.linkBuilder.registerRelationships(name, definition.relationships);
    }
    
    logger.info('Resource registered', { name, path: definition.path });
  }

  /**
   * 注册服务端点
   * @param {string} serviceName - 服务名称
   * @param {Object} endpoint - 端点配置
   */
  registerServiceEndpoint(serviceName, endpoint) {
    this.serviceEndpoints.set(serviceName, endpoint);
    logger.info('Service endpoint registered', { serviceName, url: endpoint.url });
  }

  /**
   * 发现所有资源
   * @param {Object} options - 选项
   * @returns {Object} HAL 格式的发现响应
   */
  async discoverAll(options = {}) {
    const cacheKey = 'all';
    
    // 检查缓存
    const cached = this._getFromCache(cacheKey);
    if (cached && !options.skipCache) {
      return cached;
    }
    
    const endpoints = {};
    
    // 添加所有资源端点
    for (const [name, definition] of this.resourceDefinitions) {
      const baseUrl = this.linkBuilder.getResourceBaseUrl(name);
      
      endpoints[name] = {
        href: baseUrl,
        method: 'GET',
        title: definition.description || `${name} collection`,
        methods: definition.methods,
        actions: definition.actions
      };
    }
    
    // 添加服务端点
    for (const [serviceName, endpoint] of this.serviceEndpoints) {
      endpoints[serviceName] = {
        href: endpoint.url,
        method: 'GET',
        title: endpoint.description || serviceName
      };
    }
    
    // 添加其他特殊端点
    endpoints.docs = {
      href: '/api/docs',
      method: 'GET',
      title: 'API Documentation'
    };
    
    endpoints.health = {
      href: '/health',
      method: 'GET',
      title: 'Service Health'
    };
    
    endpoints.metrics = {
      href: '/metrics',
      method: 'GET',
      title: 'Service Metrics'
    };
    
    // 格式化为 HAL
    const discoveryResponse = this.halFormatter.formatDiscoveryResponse(endpoints, {
      apiVersion: options.apiVersion,
      documentationUrl: '/api/docs'
    });
    
    // 缓存响应
    this._setCache(cacheKey, discoveryResponse);
    
    return discoveryResponse;
  }

  /**
   * 发现单个资源
   * @param {string} resourceName - 资源名称
   * @param {Object} options - 选项
   * @returns {Object} 资源详细信息
   */
  async discoverResource(resourceName, options = {}) {
    const definition = this.resourceDefinitions.get(resourceName);
    if (!definition) {
      return null;
    }
    
    const baseUrl = this.linkBuilder.getResourceBaseUrl(resourceName);
    
    const links = {
      self: {
        href: baseUrl,
        method: 'GET',
        title: definition.description || `${resourceName} collection`
      }
    };
    
    // 添加操作链接
    for (const action of definition.actions || []) {
      links[action] = this.linkBuilder.buildTemplatedLink(
        resourceName,
        '{id}/' + action,
        { title: `${action} ${resourceName}` }
      );
    }
    
    // 添加关系链接
    for (const [relName, rel] of Object.entries(definition.relationships || {})) {
      if (rel.type !== 'embedded') {
        links[relName] = this.linkBuilder.buildTemplatedLink(
          resourceName,
          `{id}/${this.linkBuilder.resourcePaths[rel.resource] || rel.resource}`,
          { title: `${resourceName}'s ${relName}` }
        );
      }
    }
    
    return {
      _links: links,
      name: resourceName,
      description: definition.description,
      methods: definition.methods,
      actions: definition.actions,
      schema: definition.schema,
      relationships: definition.relationships
    };
  }

  /**
   * 获取资源 Schema
   * @param {string} resourceName - 资源名称
   * @returns {Object} 资源 Schema
   */
  getResourceSchema(resourceName) {
    const definition = this.resourceDefinitions.get(resourceName);
    return definition?.schema || null;
  }

  /**
   * 获取资源操作
   * @param {string} resourceName - 资源名称
   * @returns {Array} 可用操作列表
   */
  getResourceActions(resourceName) {
    const definition = this.resourceDefinitions.get(resourceName);
    return definition?.actions || [];
  }

  /**
   * 获取资源关系
   * @param {string} resourceName - 资源名称
   * @returns {Object} 资源关系
   */
  getResourceRelationships(resourceName) {
    const definition = this.resourceDefinitions.get(resourceName);
    return definition?.relationships || {};
  }

  /**
   * 获取所有注册的资源
   * @returns {Array} 资源列表
   */
  getAllResources() {
    return Array.from(this.resourceDefinitions.entries()).map(([name, definition]) => ({
      name,
      path: definition.path,
      description: definition.description,
      methods: definition.methods,
      actions: definition.actions
    }));
  }

  /**
   * 检查资源是否存在
   * @param {string} resourceName - 资源名称
   * @returns {boolean} 是否存在
   */
  hasResource(resourceName) {
    return this.resourceDefinitions.has(resourceName);
  }

  /**
   * 从缓存获取
   * @param {string} key - 缓存键
   * @returns {Object|null} 缓存值
   */
  _getFromCache(key) {
    const cached = this.discoveryCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.discoveryCache.delete(key);
      return null;
    }
    
    return cached.value;
  }

  /**
   * 设置缓存
   * @param {string} key - 缓存键
   * @param {Object} value - 缓存值
   */
  _setCache(key, value) {
    this.discoveryCache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  /**
   * 清除缓存
   * @param {string} key - 缓存键（可选，不传则清除所有）
   */
  clearCache(key) {
    if (key) {
      this.discoveryCache.delete(key);
    } else {
      this.discoveryCache.clear();
    }
    logger.info('Discovery cache cleared', { key: key || 'all' });
  }

  /**
   * 设置缓存 TTL
   * @param {number} ttl - TTL（毫秒）
   */
  setCacheTTL(ttl) {
    this.cacheTTL = ttl;
    logger.info('Cache TTL updated', { ttl });
  }

  /**
   * 获取发现器统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      resourceCount: this.resourceDefinitions.size,
      serviceEndpointCount: this.serviceEndpoints.size,
      cacheSize: this.discoveryCache.size,
      cacheTTL: this.cacheTTL
    };
  }
}

// 导出单例
const defaultResourceDiscoverer = new ResourceDiscoverer();

module.exports = {
  ResourceDiscoverer,
  defaultResourceDiscoverer,
  ResourceDefinition
};