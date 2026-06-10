'use strict';
/**
 * ContractSchema - 契约 Schema 定义类
 * 用于定义 API 契约的请求和响应 Schema
 */

const Joi = require('joi');

class ContractSchema {
  /**
   * 创建契约 Schema
   * @param {string} name - 服务名称
   * @param {string} version - 契约版本
   */
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.endpoints = new Map();
    this.schemas = new Map();
    this.metadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * 定义可复用 Schema
   * @param {string} name - Schema 名称
   * @param {Joi.Schema} schema - Joi Schema
   * @returns {ContractSchema}
   */
  defineSchema(name, schema) {
    this.schemas.set(name, schema);
    return this;
  }

  /**
   * 获取已定义的 Schema
   * @param {string} name - Schema 名称
   * @returns {Joi.Schema|null}
   */
  getSchema(name) {
    return this.schemas.get(name) || null;
  }

  /**
   * 定义端点契约
   * @param {Object} options - 端点选项
   * @param {string} options.method - HTTP 方法
   * @param {string} options.path - 端点路径
   * @param {string} options.description - 端点描述
   * @param {Joi.Schema} options.request - 请求 Schema
   * @param {Joi.Schema} options.response - 响应 Schema
   * @param {number} options.expectedStatus - 期望状态码
   * @returns {ContractSchema}
   */
  defineEndpoint(options) {
    const {
      method = 'GET',
      path,
      description = '',
      request,
      response,
      expectedStatus = 200
    } = options;

    if (!path) {
      throw new Error('Endpoint path is required');
    }

    const key = `${method.toUpperCase()}:${path}`;
    
    this.endpoints.set(key, {
      method: method.toUpperCase(),
      path,
      description,
      request: request || null,
      response: response || null,
      expectedStatus
    });

    return this;
  }

  /**
   * 定义请求 Schema（简化方法）
   * @param {string} path - 端点路径
   * @param {Joi.Schema} schema - 请求 Schema
   * @param {string} method - HTTP 方法
   * @returns {ContractSchema}
   */
  defineRequest(path, schema, method = 'GET') {
    const key = `${method.toUpperCase()}:${path}`;
    const existing = this.endpoints.get(key) || { method: method.toUpperCase(), path };
    existing.request = schema;
    this.endpoints.set(key, existing);
    return this;
  }

  /**
   * 定义响应 Schema（简化方法）
   * @param {string} path - 端点路径
   * @param {Joi.Schema} schema - 响应 Schema
   * @param {string} method - HTTP 方法
   * @returns {ContractSchema}
   */
  defineResponse(path, schema, method = 'GET') {
    const key = `${method.toUpperCase()}:${path}`;
    const existing = this.endpoints.get(key) || { method: method.toUpperCase(), path };
    existing.response = schema;
    this.endpoints.set(key, existing);
    return this;
  }

  /**
   * 获取端点契约
   * @param {string} method - HTTP 方法
   * @param {string} path - 端点路径
   * @returns {Object|null}
   */
  getEndpoint(method, path) {
    const key = `${method.toUpperCase()}:${path}`;
    return this.endpoints.get(key) || null;
  }

  /**
   * 验证请求
   * @param {string} method - HTTP 方法
   * @param {string} path - 端点路径
   * @param {Object} data - 请求数据
   * @returns {Object} 验证结果 { error, value }
   */
  validateRequest(method, path, data) {
    const endpoint = this.getEndpoint(method, path);
    if (!endpoint) {
      return { error: new Error(`Endpoint not found: ${method} ${path}`), value: null };
    }
    if (!endpoint.request) {
      return { error: null, value: data };
    }
    return endpoint.request.validate(data, { abortEarly: false });
  }

  /**
   * 验证响应
   * @param {string} method - HTTP 方法
   * @param {string} path - 端点路径
   * @param {Object} data - 响应数据
   * @returns {Object} 验证结果 { error, value }
   */
  validateResponse(method, path, data) {
    const endpoint = this.getEndpoint(method, path);
    if (!endpoint) {
      return { error: new Error(`Endpoint not found: ${method} ${path}`), value: null };
    }
    if (!endpoint.response) {
      return { error: null, value: data };
    }
    return endpoint.response.validate(data, { abortEarly: false });
  }

  /**
   * 获取所有端点
   * @returns {Array}
   */
  getAllEndpoints() {
    return Array.from(this.endpoints.entries()).map(([key, value]) => ({
      key,
      ...value
    }));
  }

  /**
   * 导出契约为 JSON
   * @returns {Object}
   */
  toJSON() {
    return {
      name: this.name,
      version: this.version,
      metadata: this.metadata,
      schemas: Array.from(this.schemas.keys()),
      endpoints: this.getAllEndpoints().map(e => ({
        method: e.method,
        path: e.path,
        description: e.description,
        expectedStatus: e.expectedStatus
      }))
    };
  }
}

module.exports = { ContractSchema };
