/**
 * HalFormatter - HAL 格式化器
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 * 
 * 提供 HAL（Hypertext Application Language）格式化功能
 * 符合 HAL 规范：https://stateless.group/hal-specification.html
 */

'use strict';

const { createLogger } = require('../logger');
const { defaultLinkBuilder } = require('./LinkBuilder');
const logger = createLogger('hal-formatter');

/**
 * HAL 格式结构
 */
const HalStructure = {
  // 标准 HAL 字段
  _links: {
    self: { href: String },
    // 其他链接...
  },
  _embedded: {
    // 嵌入资源
  },
  // 资源数据
  ...data
};

/**
 * HalFormatter 类
 */
class HalFormatter {
  /**
   * @param {Object} config - 配置
   */
  constructor(config = {}) {
    this.linkBuilder = config.linkBuilder || defaultLinkBuilder;
    this.includeEmbedded = config.includeEmbedded !== false;
    this.prettyPrint = config.prettyPrint || false;
    
    logger.info('HalFormatter initialized');
  }

  /**
   * 格式化单个资源
   * @param {Object} data - 资源数据
   * @param {string} resourceType - 资源类型
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的资源
   */
  formatResource(data, resourceType, options = {}) {
    if (!data) {
      return null;
    }
    
    const resourceId = data.id || data._id || options.id;
    if (!resourceId) {
      logger.warn('Resource missing ID', { resourceType });
      return data;
    }
    
    // 构建链接
    const links = this.linkBuilder.buildResourceLinks(
      resourceType,
      resourceId,
      options.context || {}
    );
    
    // 构建嵌入资源
    const embedded = this._buildEmbedded(data, resourceType, options);
    
    // 提取核心数据（排除嵌入字段）
    const coreData = this._extractCoreData(data, resourceType);
    
    // 组合 HAL 结构
    const halResource = {
      _links: links,
      ...coreData
    };
    
    // 添加嵌入资源
    if (embedded && Object.keys(embedded).length > 0) {
      halResource._embedded = embedded;
    }
    
    return halResource;
  }

  /**
   * 格式化资源集合
   * @param {Array} items - 资源列表
   * @param {string} resourceType - 资源类型
   * @param {Object} pagination - 分页信息
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的集合
   */
  formatCollection(items, resourceType, pagination, options = {}) {
    const baseUrl = this.linkBuilder.getResourceBaseUrl(resourceType);
    
    // 构建集合链接
    const links = {
      self: {
        href: this.linkBuilder._buildUrlWithParams(baseUrl, {
          page: pagination.page,
          limit: pagination.limit
        }),
        method: 'GET',
        title: `${resourceType} collection`
      }
    };
    
    // 添加分页链接
    if (pagination.totalPages > 1) {
      const paginationLinks = this.linkBuilder.buildPaginationLinks(
        baseUrl,
        pagination,
        options.query || {}
      );
      Object.assign(links, paginationLinks);
    }
    
    // 格式化每个资源
    const embeddedItems = items.map(item => 
      this.formatResource(item, resourceType, {
        ...options,
        skipCollection: true, // 集合中不包含集合链接
        skipPagination: true
      })
    );
    
    // 组合 HAL 集合结构
    const halCollection = {
      _links: links,
      _embedded: {
        items: embeddedItems
      },
      total: pagination.total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: pagination.totalPages
    };
    
    return halCollection;
  }

  /**
   * 格式化分页响应
   * @param {Array} items - 资源列表
   * @param {string} resourceType - 资源类型
   * @param {Object} pagination - 分页信息 { page, limit, total, totalPages }
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的分页响应
   */
  formatPaginatedResponse(items, resourceType, pagination, options = {}) {
    const totalPages = pagination.totalPages || Math.ceil(pagination.total / pagination.limit);
    
    return this.formatCollection(items, resourceType, {
      ...pagination,
      totalPages
    }, options);
  }

  /**
   * 格式化搜索结果
   * @param {Array} items - 搜索结果
   * @param {string} resourceType - 资源类型
   * @param {Object} searchParams - 搜索参数
   * @param {Object} pagination - 分页信息
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的搜索结果
   */
  formatSearchResults(items, resourceType, searchParams, pagination, options = {}) {
    const baseUrl = this.linkBuilder.getResourceBaseUrl(resourceType);
    
    // 构建搜索链接
    const links = {
      self: {
        href: this.linkBuilder._buildUrlWithParams(baseUrl, {
          ...searchParams,
          page: pagination.page,
          limit: pagination.limit
        }),
        method: 'GET',
        title: `${resourceType} search results`
      }
    };
    
    // 添加分页链接
    if (pagination.totalPages > 1) {
      const paginationLinks = this.linkBuilder.buildPaginationLinks(
        baseUrl,
        pagination,
        searchParams
      );
      Object.assign(links, paginationLinks);
    }
    
    // 格式化每个资源
    const embeddedItems = items.map(item =>
      this.formatResource(item, resourceType, {
        ...options,
        skipCollection: true
      })
    );
    
    return {
      _links: links,
      _embedded: {
        items: embeddedItems
      },
      query: searchParams,
      total: pagination.total,
      page: pagination.page,
      totalPages: pagination.totalPages
    };
  }

  /**
   * 格式化关系资源
   * @param {Object} data - 关系数据
   * @param {string} resourceType - 主资源类型
   * @param {string|number} resourceId - 主资源 ID
   * @param {string} relationName - 关系名称
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的关系资源
   */
  formatRelation(data, resourceType, resourceId, relationName, options = {}) {
    const links = {
      self: this.linkBuilder.buildRelatedLink(
        resourceType,
        resourceId,
        relationName
      ),
      parent: this.linkBuilder.buildSelfLink(resourceType, resourceId)
    };
    
    return {
      _links: links,
      data
    };
  }

  /**
   * 格式化操作结果
   * @param {Object} result - 操作结果
   * @param {string} resourceType - 资源类型
   * @param {string|number} resourceId - 资源 ID
   * @param {string} action - 操作名称
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的操作结果
   */
  formatActionResult(result, resourceType, resourceId, action, options = {}) {
    const links = {
      self: this.linkBuilder.buildSelfLink(resourceType, resourceId),
      action: this.linkBuilder.buildActionLink(resourceType, resourceId, action)
    };
    
    return {
      _links: links,
      action,
      result,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 格式化发现响应（资源发现端点）
   * @param {Object} endpoints - 可用端点
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的发现响应
   */
  formatDiscoveryResponse(endpoints, options = {}) {
    const links = {
      self: {
        href: '/api/discover',
        method: 'GET',
        title: 'API Resource Discovery'
      }
    };
    
    // 添加所有端点链接
    for (const [name, endpoint] of Object.entries(endpoints)) {
      links[name] = {
        href: endpoint.href || endpoint,
        method: endpoint.method || 'GET',
        title: endpoint.title || `${name} collection`
      };
    }
    
    return {
      _links: links,
      _meta: {
        api_version: options.apiVersion || this.linkBuilder.apiVersion,
        documentation: options.documentationUrl || '/api/docs',
        server_time: new Date().toISOString(),
        generator: 'HalFormatter'
      }
    };
  }

  /**
   * 格式化错误响应
   * @param {Object} error - 错误信息
   * @param {Object} options - 格式化选项
   * @returns {Object} HAL 格式的错误响应
   */
  formatError(error, options = {}) {
    const links = {
      self: {
        href: options.requestUrl || '/api',
        method: options.method || 'GET'
      },
      help: {
        href: '/api/docs/errors',
        title: 'Error documentation'
      }
    };
    
    // 如果有相关资源，添加链接
    if (options.resourceType && options.resourceId) {
      links.related = this.linkBuilder.buildSelfLink(
        options.resourceType,
        options.resourceId
      );
    }
    
    return {
      _links: links,
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'An error occurred',
        details: error.details || null,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * 构建嵌入资源
   * @param {Object} data - 原始数据
   * @param {string} resourceType - 资源类型
   * @param {Object} options - 格式化选项
   * @returns {Object} 嵌入资源对象
   */
  _buildEmbedded(data, resourceType, options) {
    if (!this.includeEmbedded) return null;
    
    const relationships = this.linkBuilder.relationships.get(resourceType);
    if (!relationships) return null;
    
    const embedded = {};
    
    for (const [name, rel] of Object.entries(relationships)) {
      if (rel.embedded && data[name]) {
        // 嵌入资源
        if (Array.isArray(data[name])) {
          embedded[name] = data[name].map(item =>
            this.formatResource(item, rel.resource, { skipEmbedded: true })
          );
        } else {
          embedded[name] = this.formatResource(data[name], rel.resource, { skipEmbedded: true });
        }
      }
    }
    
    return embedded;
  }

  /**
   * 提取核心数据（排除嵌入字段）
   * @param {Object} data - 原始数据
   * @param {string} resourceType - 资源类型
   * @returns {Object} 核心数据
   */
  _extractCoreData(data, resourceType) {
    const relationships = this.linkBuilder.relationships.get(resourceType);
    if (!relationships) return data;
    
    const coreData = { ...data };
    
    // 移除嵌入字段（已在 _embedded 中）
    for (const [name, rel] of Object.entries(relationships)) {
      if (rel.embedded && coreData[name]) {
        delete coreData[name];
      }
    }
    
    // 移除内部字段
    delete coreData.__v;
    delete coreData._id;
    
    return coreData;
  }

  /**
   * 序列化为 JSON
   * @param {Object} halResource - HAL 资源
   * @returns {string} JSON 字符串
   */
  toJson(halResource) {
    if (this.prettyPrint) {
      return JSON.stringify(halResource, null, 2);
    }
    return JSON.stringify(halResource);
  }

  /**
   * 从 JSON 解析
   * @param {string} json - JSON 字符串
   * @returns {Object} HAL 资源
   */
  fromJson(json) {
    try {
      return JSON.parse(json);
    } catch (error) {
      logger.error('Failed to parse HAL JSON', { error: error.message });
      return null;
    }
  }

  /**
   * 验证 HAL 结构
   * @param {Object} halResource - HAL 资源
   * @returns {Object} 验证结果 { valid, errors }
   */
  validate(halResource) {
    const errors = [];
    
    // 必须包含 _links
    if (!halResource._links) {
      errors.push('Missing _links property');
    }
    
    // _links 必须包含 self
    if (!halResource._links?.self) {
      errors.push('Missing self link in _links');
    }
    
    // self 链接必须包含 href
    if (!halResource._links?.self?.href) {
      errors.push('Missing href in self link');
    }
    
    // _embedded 中的每个资源必须是有效的 HAL 结构
    if (halResource._embedded) {
      for (const [name, embedded] of Object.entries(halResource._embedded)) {
        if (Array.isArray(embedded)) {
          for (const item of embedded) {
            const itemValidation = this.validate(item);
            if (!itemValidation.valid) {
              errors.push(`Invalid embedded resource in ${name}: ${itemValidation.errors.join(', ')}`);
            }
          }
        } else if (typeof embedded === 'object') {
          const embeddedValidation = this.validate(embedded);
          if (!embeddedValidation.valid) {
            errors.push(`Invalid embedded resource ${name}: ${embeddedValidation.errors.join(', ')}`);
          }
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 设置链接构建器
   * @param {LinkBuilder} linkBuilder - 链接构建器实例
   */
  setLinkBuilder(linkBuilder) {
    this.linkBuilder = linkBuilder;
    logger.info('LinkBuilder updated');
  }

  /**
   * 设置格式化选项
   * @param {Object} options - 选项
   */
  setOptions(options) {
    if (options.includeEmbedded !== undefined) {
      this.includeEmbedded = options.includeEmbedded;
    }
    if (options.prettyPrint !== undefined) {
      this.prettyPrint = options.prettyPrint;
    }
    logger.info('Formatter options updated', options);
  }
}

// 导出单例
const defaultHalFormatter = new HalFormatter();

module.exports = {
  HalFormatter,
  defaultHalFormatter,
  HalStructure
};