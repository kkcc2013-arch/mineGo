/**
 * 统一 API 响应工具类
 * REQ-00518: 增强 HATEOAS 支持
 * 
 * 标准响应格式（HAL 规范）：
 * - 成功：{ success: true, data: {}, _links: {...}, meta: { requestId, timestamp } }
 * - 分页：{ success: true, data: [], _links: {...}, pagination: {...}, meta: {...} }
 * - 错误：{ success: false, error: { code, message, ... }, _links: {...}, meta: {...} }
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { defaultHalFormatter } = require('./HalFormatter');
const { defaultLinkBuilder } = require('./LinkBuilder');

class ApiResponse {
  /**
   * HATEOAS 配置
   */
  static hateoasConfig = {
    enabled: true,
    includeLinks: true,
    includeEmbedded: true
  };

  /**
   * 启用/禁用 HATEOAS
   */
  static setHateoasEnabled(enabled) {
    this.hateoasConfig.enabled = enabled;
  }

  /**
   * 生成请求元数据
   */
  static _generateMeta(res, options = {}) {
    return {
      requestId: res.locals?.requestId || uuidv4(),
      timestamp: new Date().toISOString(),
      ...options.meta
    };
  }

  /**
   * 成功响应（支持 HATEOAS）
   * @param {Object} res - Express response 对象
   * @param {*} data - 响应数据
   * @param {Object} options - 可选配置
   */
  static success(res, data, options = {}) {
    const response = {
      success: true,
      data,
      meta: this._generateMeta(res, options)
    };

    // 添加 HATEOAS 链接（如果启用）
    if (this.hateoasConfig.enabled && options.resourceType) {
      response._links = this._buildLinks(res, data, options);
    }

    return res.status(options.status || 200).json(response);
  }

  /**
   * 构建 HATEOAS 链接
   */
  static _buildLinks(res, data, options) {
    const { resourceType, resourceId, context } = options;
    
    if (!resourceType) return undefined;
    
    const id = resourceId || data?.id || data?._id;
    if (!id) return undefined;
    
    return defaultLinkBuilder.buildResourceLinks(resourceType, id, context || {});
  }

  /**
   * 创建成功响应 (201)
   * @param {Object} res - Express response 对象
   * @param {*} data - 响应数据
   * @param {Object} options - 可选配置
   */
  static created(res, data, options = {}) {
    return this.success(res, data, { ...options, status: 201 });
  }

  /**
   * 无内容响应 (204)
   * @param {Object} res - Express response 对象
   */
  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * 分页响应（支持 HATEOAS）
   * @param {Object} res - Express response 对象
   * @param {Array} items - 列表数据
   * @param {Object} pagination - 分页信息 { page, limit, total }
   * @param {Object} options - 可选配置
   */
  static paginated(res, items, pagination, options = {}) {
    const { page, limit, total } = pagination;
    const totalPages = Math.ceil(total / limit);

    const response = {
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        totalPages,
        hasMore: page < totalPages
      },
      meta: this._generateMeta(res, options)
    };

    // 添加 HATEOAS 分页链接
    if (this.hateoasConfig.enabled && options.resourceType) {
      const baseUrl = defaultLinkBuilder.getResourceBaseUrl(options.resourceType);
      response._links = {
        self: {
          href: `${baseUrl}?page=${page}&limit=${limit}`,
          method: 'GET',
          title: `${options.resourceType} collection page ${page}`
        }
      };

      // 添加分页链接
      if (totalPages > 1) {
        const paginationLinks = defaultLinkBuilder.buildPaginationLinks(baseUrl, pagination, options.query || {});
        Object.assign(response._links, paginationLinks);
      }
    }

    return res.status(200).json(response);
  }

  /**
   * HAL 格式响应（完全符合 HAL 规范）
   * @param {Object} res - Express response 对象
   * @param {*} data - 响应数据
   * @param {string} resourceType - 资源类型
   * @param {Object} options - 可选配置
   */
  static hal(res, data, resourceType, options = {}) {
    const halResponse = defaultHalFormatter.formatResource(data, resourceType, {
      ...options,
      context: options.context || {}
    });
    
    // 添加 meta
    halResponse._meta = this._generateMeta(res, options);
    
    return res.status(options.status || 200).json(halResponse);
  }

  /**
   * HAL 分页响应
   * @param {Object} res - Express response 对象
   * @param {Array} items - 列表数据
   * @param {string} resourceType - 资源类型
   * @param {Object} pagination - 分页信息
   * @param {Object} options - 可选配置
   */
  static halPaginated(res, items, resourceType, pagination, options = {}) {
    const halResponse = defaultHalFormatter.formatPaginatedResponse(items, resourceType, pagination, options);
    
    // 添加 meta
    halResponse._meta = this._generateMeta(res, options);
    
    return res.status(200).json(halResponse);
  }

  /**
   * 资源发现响应
   * @param {Object} res - Express response 对象
   * @param {Object} options - 可选配置
   */
  static discovery(res, options = {}) {
    const { defaultResourceDiscoverer } = require('./ResourceDiscoverer');
    
    const discoveryResponse = defaultResourceDiscoverer.discoverAll(options);
    
    // 添加 meta
    discoveryResponse._meta = {
      ...discoveryResponse._meta,
      requestId: res.locals?.requestId || uuidv4(),
      timestamp: new Date().toISOString()
    };

    return res.status(200).json(discoveryResponse);
  }

  /**
   * 操作确认响应
   * @param {Object} res - Express response 对象
   * @param {Object} result - 操作结果
   * @param {Object} options - 可选配置
   */
  static actionResult(res, result, options = {}) {
    return this.success(res, result, options);
  }

  /**
   * 删除成功响应
   * @param {Object} res - Express response 对象
   * @param {number} affected - 影响的记录数
   */
  static deleted(res, affected = 1) {
    return this.success(res, { 
      affected,
      message: `Successfully deleted ${affected} item(s)`
    });
  }

  /**
   * 更新成功响应
   * @param {Object} res - Express response 对象
   * @param {Object} data - 更新后的数据
   */
  static updated(res, data) {
    return this.success(res, data);
  }

  /**
   * 批量操作响应
   * @param {Object} res - Express response 对象
   * @param {Object} result - 批量操作结果
   */
  static batchResult(res, result) {
    const { succeeded = [], failed = [], total = 0 } = result;
    
    return this.success(res, {
      total,
      succeeded: succeeded.length,
      failed: failed.length,
      details: { succeeded, failed }
    });
  }
}

module.exports = ApiResponse;
