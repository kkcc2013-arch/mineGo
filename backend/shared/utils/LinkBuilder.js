/**
 * LinkBuilder - HATEOAS 链接构建器
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 * 
 * 提供标准化的链接构建方法，支持 HAL 规范
 */

'use strict';

const { createLogger } = require('../logger');
const logger = createLogger('link-builder');

/**
 * 链接结构定义（符合 HAL 规范）
 */
const LinkStructure = {
  href: String,         // 必填：链接地址
  method: String,       // HTTP 方法（GET/POST/PUT/DELETE/PATCH）
  title: String,        // 链接描述
  templated: Boolean,   // 是否是模板链接（需要替换变量）
  type: String,         // 预期响应类型
  name: String,         // 链接名称
  deprecation: String,  // 废弃提示 URL
  profile: String       // 资源 Profile URL
};

/**
 * LinkBuilder 类
 */
class LinkBuilder {
  /**
   * @param {Object} config - 配置
   * @param {string} config.baseUrl - API 基础 URL
   * @param {string} config.apiVersion - API 版本（如 v1）
   */
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.API_BASE_URL || '';
    this.apiVersion = config.apiVersion || 'v1';
    this.linkTemplates = new Map();
    this.relationships = new Map();
    
    // 初始化默认链接模板
    this._initDefaultTemplates();
    
    logger.info('LinkBuilder initialized', {
      baseUrl: this.baseUrl,
      apiVersion: this.apiVersion
    });
  }

  /**
   * 初始化默认链接模板
   */
  _initDefaultTemplates() {
    // 资源类型 -> 基础路径映射
    this.resourcePaths = {
      pokemon: 'pokemon',
      user: 'users',
      gym: 'gyms',
      location: 'locations',
      catch: 'catches',
      social: 'social',
      reward: 'rewards',
      payment: 'payments',
      item: 'items',
      battle: 'battles'
    };
    
    // 资源关系映射
    this.relationships.set('pokemon', {
      owner: { resource: 'user', relation: 'owner' },
      location: { resource: 'location', relation: 'spawn' },
      gym: { resource: 'gym', relation: 'member' },
      stats: { resource: 'stats', embedded: true },
      moves: { resource: 'moves', embedded: true }
    });
    
    this.relationships.set('user', {
      pokemon: { resource: 'pokemon', relation: 'owned' },
      friends: { resource: 'user', relation: 'friends' },
      items: { resource: 'item', relation: 'inventory' },
      achievements: { resource: 'achievement', relation: 'earned' }
    });
    
    this.relationships.set('gym', {
      owner: { resource: 'user', relation: 'owner' },
      members: { resource: 'pokemon', relation: 'members' },
      battles: { resource: 'battle', relation: 'history' },
      location: { resource: 'location', relation: 'position' }
    });
  }

  /**
   * 构建资源基础 URL
   * @param {string} resourceType - 资源类型
   * @returns {string} 资源基础 URL
   */
  getResourceBaseUrl(resourceType) {
    const path = this.resourcePaths[resourceType] || resourceType;
    return `${this.baseUrl}/api/${this.apiVersion}/${path}`;
  }

  /**
   * 构建 self 链接
   * @param {string} resourceType - 资源类型
   * @param {string|number} id - 资源 ID
   * @param {Object} options - 可选配置
   * @returns {Object} 链接对象
   */
  buildSelfLink(resourceType, id, options = {}) {
    const baseUrl = this.getResourceBaseUrl(resourceType);
    return {
      href: `${baseUrl}/${id}`,
      method: 'GET',
      title: options.title || `${resourceType} resource`,
      ...options.extra
    };
  }

  /**
   * 构建集合链接
   * @param {string} resourceType - 资源类型
   * @param {Object} query - 查询参数（可选）
   * @returns {Object} 链接对象
   */
  buildCollectionLink(resourceType, query = {}) {
    const baseUrl = this.getResourceBaseUrl(resourceType);
    const queryString = this._buildQueryString(query);
    
    return {
      href: queryString ? `${baseUrl}?${queryString}` : baseUrl,
      method: 'GET',
      title: `${resourceType} collection`
    };
  }

  /**
   * 构建分页链接
   * @param {string} baseUrl - 基础 URL
   * @param {Object} pagination - 分页信息 { page, limit, totalPages }
   * @param {Object} query - 其他查询参数
   * @returns {Object} 分页链接对象
   */
  buildPaginationLinks(baseUrl, pagination, query = {}) {
    const { page, limit, totalPages } = pagination;
    const links = {};
    
    // First 链接
    links.first = {
      href: this._buildUrlWithParams(baseUrl, { ...query, page: 1, limit }),
      method: 'GET',
      title: 'First page'
    };
    
    // Previous 链接
    if (page > 1) {
      links.prev = {
        href: this._buildUrlWithParams(baseUrl, { ...query, page: page - 1, limit }),
        method: 'GET',
        title: 'Previous page'
      };
    }
    
    // Next 链接
    if (page < totalPages) {
      links.next = {
        href: this._buildUrlWithParams(baseUrl, { ...query, page: page + 1, limit }),
        method: 'GET',
        title: 'Next page'
      };
    }
    
    // Last 链接
    links.last = {
      href: this._buildUrlWithParams(baseUrl, { ...query, page: totalPages, limit }),
      method: 'GET',
      title: 'Last page'
    };
    
    return links;
  }

  /**
   * 构建关联资源链接
   * @param {string} resourceType - 主资源类型
   * @param {string|number} id - 主资源 ID
   * @param {string} relatedResource - 关联资源类型
   * @param {Object} options - 可选配置
   * @returns {Object} 链接对象
   */
  buildRelatedLink(resourceType, id, relatedResource, options = {}) {
    const baseUrl = this.getResourceBaseUrl(resourceType);
    const relatedPath = this.resourcePaths[relatedResource] || relatedResource;
    
    return {
      href: `${baseUrl}/${id}/${relatedPath}`,
      method: options.method || 'GET',
      title: options.title || `${resourceType}'s ${relatedResource}`,
      ...options.extra
    };
  }

  /**
   * 构建操作链接
   * @param {string} resourceType - 资源类型
   * @param {string|number} id - 资源 ID
   * @param {string} action - 操作名称
   * @param {Object} options - 可选配置
   * @returns {Object} 链接对象
   */
  buildActionLink(resourceType, id, action, options = {}) {
    const baseUrl = this.getResourceBaseUrl(resourceType);
    const methodMap = {
      create: 'POST',
      update: 'PUT',
      delete: 'DELETE',
      catch: 'POST',
      evolve: 'POST',
      battle: 'POST',
      trade: 'POST',
      feed: 'POST',
      train: 'POST',
      heal: 'POST',
      release: 'DELETE'
    };
    
    return {
      href: `${baseUrl}/${id}/${action}`,
      method: methodMap[action] || options.method || 'POST',
      title: options.title || `${action} ${resourceType}`,
      type: options.type || 'application/json',
      ...options.extra
    };
  }

  /**
   * 构建模板链接（需要替换变量）
   * @param {string} resourceType - 资源类型
   * @param {string} template - URI 模板（如 /pokemon/{id}/catch）
   * @param {Object} options - 可选配置
   * @returns {Object} 模板链接对象
   */
  buildTemplatedLink(resourceType, template, options = {}) {
    const baseUrl = this.getResourceBaseUrl(resourceType);
    
    return {
      href: `${baseUrl}/${template}`,
      templated: true,
      method: options.method || 'GET',
      title: options.title || template,
      ...options.extra
    };
  }

  /**
   * 构建资源的所有标准链接
   * @param {string} resourceType - 资源类型
   * @param {string|number} id - 资源 ID
   * @param {Object} context - 上下文信息（分页、关联等）
   * @returns {Object} 链接集合
   */
  buildResourceLinks(resourceType, id, context = {}) {
    const links = {
      self: this.buildSelfLink(resourceType, id)
    };
    
    // 添加集合链接
    if (!context.skipCollection) {
      links.collection = this.buildCollectionLink(resourceType);
    }
    
    // 添加关联链接
    const relationships = this.relationships.get(resourceType);
    if (relationships && !context.skipRelated) {
      for (const [name, rel] of Object.entries(relationships)) {
        if (!rel.embedded) {
          links[name] = this.buildRelatedLink(resourceType, id, rel.resource, {
            title: `${resourceType}'s ${name}`
          });
        }
      }
    }
    
    // 添加操作链接
    const actions = this._getAvailableActions(resourceType, context);
    for (const action of actions) {
      links[action] = this.buildActionLink(resourceType, id, action);
    }
    
    return links;
  }

  /**
   * 获取资源可执行操作
   * @param {string} resourceType - 资源类型
   * @param {Object} context - 上下文（包含状态信息）
   * @returns {Array} 可执行操作列表
   */
  _getAvailableActions(resourceType, context = {}) {
    const actionMap = {
      pokemon: ['catch', 'evolve', 'battle', 'trade', 'feed', 'train', 'heal', 'release'],
      user: ['update', 'delete'],
      gym: ['battle', 'claim', 'defend'],
      item: ['use', 'sell', 'discard']
    };
    
    const available = actionMap[resourceType] || [];
    
    // 根据上下文过滤操作
    if (context.state) {
      return this._filterActionsByState(available, context.state);
    }
    
    return available;
  }

  /**
   * 根据状态过滤操作
   * @param {Array} actions - 操作列表
   * @param {Object} state - 资源状态
   * @returns {Array} 过滤后的操作
   */
  _filterActionsByState(actions, state) {
    // 示例：捕捉状态精灵不能再次捕捉
    if (state.caught) {
      return actions.filter(a => a !== 'catch');
    }
    
    // 示例：战斗中的精灵不能交易
    if (state.inBattle) {
      return actions.filter(a => a !== 'trade');
    }
    
    return actions;
  }

  /**
   * 构建查询字符串
   * @param {Object} params - 参数对象
   * @returns {string} 查询字符串
   */
  _buildQueryString(params) {
    if (!params || Object.keys(params).length === 0) return '';
    
    return Object.entries(params)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  /**
   * 构建 URL 带参数
   * @param {string} baseUrl - 基础 URL
   * @param {Object} params - 参数对象
   * @returns {string} 完整 URL
   */
  _buildUrlWithParams(baseUrl, params) {
    const queryString = this._buildQueryString(params);
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }

  /**
   * 注册自定义链接模板
   * @param {string} name - 模板名称
   * @param {Function} builder - 链接构建函数
   */
  registerTemplate(name, builder) {
    this.linkTemplates.set(name, builder);
    logger.info('Custom link template registered', { name });
  }

  /**
   * 使用自定义模板构建链接
   * @param {string} name - 模板名称
   * @param {Object} params - 参数
   * @returns {Object} 链接对象
   */
  buildFromTemplate(name, params) {
    const builder = this.linkTemplates.get(name);
    if (!builder) {
      logger.warn('Link template not found', { name });
      return null;
    }
    
    return builder(params);
  }

  /**
   * 注册资源关系
   * @param {string} resourceType - 资源类型
   * @param {Object} relations - 关系配置
   */
  registerRelationships(resourceType, relations) {
    this.relationships.set(resourceType, relations);
    logger.info('Resource relationships registered', { resourceType });
  }

  /**
   * 注册资源路径
   * @param {string} resourceType - 资源类型
   * @param {string} path - 资源路径
   */
  registerResourcePath(resourceType, path) {
    this.resourcePaths[resourceType] = path;
    logger.info('Resource path registered', { resourceType, path });
  }

  /**
   * 获取所有注册的资源类型
   * @returns {Array} 资源类型列表
   */
  getRegisteredResourceTypes() {
    return Object.keys(this.resourcePaths);
  }

  /**
   * 获取所有注册的资源关系
   * @returns {Map} 资源关系映射
   */
  getRelationships() {
    return this.relationships;
  }
}

// 导出单例
const defaultLinkBuilder = new LinkBuilder();

module.exports = {
  LinkBuilder,
  defaultLinkBuilder,
  LinkStructure
};