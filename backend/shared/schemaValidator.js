/**
 * Schema Validator - OpenAPI Schema 验证器
 * 
 * 功能：
 * - 加载和解析 OpenAPI 文档
 * - 编译 JSON Schema 验证器
 * - 提供请求/响应验证接口
 * 
 * @module shared/schemaValidator
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');
const { createLogger } = require('./logger');

const logger = createLogger('schema-validator');

class SchemaValidator {
  constructor(options = {}) {
    this.openapiDocs = new Map();  // version -> OpenAPI document
    this.validators = new Map();   // operationId:type -> Ajv validator
    this.cacheEnabled = options.cacheEnabled ?? true;
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: true,
      useDefaults: true,
    });
    
    // 添加常用格式验证
    addFormats(this.ajv);
    
    // 自定义格式
    this._addCustomFormats();
  }

  /**
   * 加载 OpenAPI Schema
   * @param {string} version - API 版本 (如 'v1', 'v2')
   * @param {string} schemaPath - Schema 文件路径 (JSON 或 YAML)
   */
  async loadSchema(version, schemaPath) {
    try {
      const doc = await this.parseOpenAPI(schemaPath);
      this.openapiDocs.set(version, doc);
      await this.compileValidators(version, doc);
      logger.info(`Loaded OpenAPI schema for ${version}`, {
        version,
        path: schemaPath,
        operations: Object.keys(doc.paths || {}).length,
      });
    } catch (error) {
      logger.error(`Failed to load schema for ${version}`, {
        version,
        path: schemaPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 解析 OpenAPI 文档
   * @param {string} schemaPath - Schema 文件路径
   * @returns {Object} OpenAPI 文档对象
   */
  async parseOpenAPI(schemaPath) {
    const absolutePath = path.resolve(schemaPath);
    const content = await fs.readFile(absolutePath, 'utf8');
    
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.json') {
      return JSON.parse(content);
    } else if (ext === '.yaml' || ext === '.yml') {
      return yaml.load(content);
    }
    
    throw new Error(`Unsupported schema format: ${ext}`);
  }

  /**
   * 编译验证器
   * @param {string} version - API 版本
   * @param {Object} doc - OpenAPI 文档
   */
  async compileValidators(version, doc) {
    if (!doc.paths) {
      logger.warn('OpenAPI document has no paths defined');
      return;
    }

    for (const [routePath, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (typeof operation !== 'object') continue;
        
        const operationId = operation.operationId || `${method}:${routePath}`;
        
        // 编译请求验证器
        const requestSchema = this._buildRequestSchema(operation);
        if (Object.keys(requestSchema).length > 0) {
          const validator = this.ajv.compile(requestSchema);
          this.validators.set(`${version}:${operationId}:request`, validator);
        }
        
        // 编译响应验证器
        if (operation.responses) {
          for (const [statusCode, response] of Object.entries(operation.responses)) {
            const responseSchema = this._buildResponseSchema(response);
            if (responseSchema) {
              const validator = this.ajv.compile(responseSchema);
              this.validators.set(`${version}:${operationId}:response:${statusCode}`, validator);
            }
          }
        }
      }
    }
  }

  /**
   * 构建请求 Schema
   * @param {Object} operation - OpenAPI operation 对象
   * @returns {Object} JSON Schema
   */
  _buildRequestSchema(operation) {
    const schema = {
      type: 'object',
      properties: {},
      required: [],
    };

    // Path 参数
    const pathParams = (operation.parameters || [])
      .filter(p => p.in === 'path')
      .map(p => ({
        name: p.name,
        schema: p.schema,
        required: p.required !== false,
        description: p.description,
      }));

    if (pathParams.length > 0) {
      schema.properties.params = {
        type: 'object',
        properties: {},
        required: [],
      };
      pathParams.forEach(p => {
        schema.properties.params.properties[p.name] = p.schema || {};
        if (p.required) {
          schema.properties.params.required.push(p.name);
        }
      });
    }

    // Query 参数
    const queryParams = (operation.parameters || [])
      .filter(p => p.in === 'query')
      .map(p => ({
        name: p.name,
        schema: p.schema,
        required: p.required === true,
        description: p.description,
      }));

    if (queryParams.length > 0) {
      schema.properties.query = {
        type: 'object',
        properties: {},
        required: [],
      };
      queryParams.forEach(p => {
        schema.properties.query.properties[p.name] = p.schema || {};
        if (p.required) {
          schema.properties.query.required.push(p.name);
        }
      });
    }

    // Header 参数
    const headerParams = (operation.parameters || [])
      .filter(p => p.in === 'header')
      .map(p => ({
        name: p.name.toLowerCase(),
        schema: p.schema,
        required: p.required === true,
        description: p.description,
      }));

    if (headerParams.length > 0) {
      schema.properties.headers = {
        type: 'object',
        properties: {},
        required: [],
      };
      headerParams.forEach(p => {
        schema.properties.headers.properties[p.name] = p.schema || {};
        if (p.required) {
          schema.properties.headers.required.push(p.name);
        }
      });
    }

    // Body 参数
    if (operation.requestBody) {
      const content = operation.requestBody.content;
      if (content && content['application/json']) {
        schema.properties.body = content['application/json'].schema || {};
        if (operation.requestBody.required) {
          schema.required.push('body');
        }
      }
    }

    return schema;
  }

  /**
   * 构建响应 Schema
   * @param {Object} response - OpenAPI response 对象
   * @returns {Object|null} JSON Schema
   */
  _buildResponseSchema(response) {
    if (!response.content || !response.content['application/json']) {
      return null;
    }

    return response.content['application/json'].schema || null;
  }

  /**
   * 添加自定义格式验证
   */
  _addCustomFormats() {
    // ObjectId 格式
    this.ajv.addFormat('objectid', {
      type: 'string',
      validate: (data) => /^[a-f0-9]{24}$/i.test(data),
    });

    // 手机号格式（中国）
    this.ajv.addFormat('phone-cn', {
      type: 'string',
      validate: (data) => /^1[3-9]\d{9}$/.test(data),
    });

    // 坐标格式
    this.ajv.addFormat('lat', {
      type: 'number',
      validate: (data) => data >= -90 && data <= 90,
    });

    this.ajv.addFormat('lng', {
      type: 'number',
      validate: (data) => data >= -180 && data <= 180,
    });
  }

  /**
   * 验证请求
   * @param {string} version - API 版本
   * @param {string} operationId - 操作 ID
   * @param {Object} data - 请求数据 { params, query, headers, body }
   * @returns {Object} { valid: boolean, errors: Array }
   */
  validateRequest(version, operationId, data) {
    const validator = this.validators.get(`${version}:${operationId}:request`);
    
    if (!validator) {
      // 没有找到验证器，跳过验证
      return { valid: true, errors: [] };
    }

    const valid = validator(data);
    
    if (!valid) {
      return {
        valid: false,
        errors: this._formatErrors(validator.errors),
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * 验证响应
   * @param {string} version - API 版本
   * @param {string} operationId - 操作 ID
   * @param {string} statusCode - HTTP 状态码
   * @param {Object} data - 响应数据
   * @returns {Object} { valid: boolean, errors: Array }
   */
  validateResponse(version, operationId, statusCode, data) {
    const validator = this.validators.get(`${version}:${operationId}:response:${statusCode}`);
    
    if (!validator) {
      // 没有找到验证器，跳过验证
      return { valid: true, errors: [] };
    }

    const valid = validator(data);
    
    if (!valid) {
      return {
        valid: false,
        errors: this._formatErrors(validator.errors),
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * 格式化错误信息
   * @param {Array} errors - Ajv 错误数组
   * @returns {Array} 格式化后的错误
   */
  _formatErrors(errors) {
    return errors.map(error => ({
      path: error.instancePath || error.dataPath || '',
      message: error.message,
      keyword: error.keyword,
      params: error.params || {},
      data: error.data,
    }));
  }

  /**
   * 获取所有 operationId
   * @param {string} version - API 版本
   * @returns {Array<string>} operationId 列表
   */
  getOperationIds(version) {
    const prefix = `${version}:`;
    const operations = [];
    
    for (const key of this.validators.keys()) {
      if (key.startsWith(prefix)) {
        const parts = key.substring(prefix.length).split(':');
        if (parts[1] === 'request' || parts[1] === 'response') {
          operations.push(parts[0]);
        }
      }
    }
    
    return [...new Set(operations)];
  }

  /**
   * 获取 Schema 加载状态
   * @returns {Object} 加载状态
   */
  getStatus() {
    const status = {};
    
    for (const [version, doc] of this.openapiDocs.entries()) {
      const operations = this.getOperationIds(version);
      status[version] = {
        loaded: true,
        operations: operations.length,
        validators: [...this.validators.keys()].filter(k => k.startsWith(`${version}:`)).length,
      };
    }
    
    return status;
  }

  /**
   * 清空所有缓存
   */
  clear() {
    this.openapiDocs.clear();
    this.validators.clear();
  }
}

// 单例实例
let instance = null;

/**
 * 获取 SchemaValidator 单例
 * @param {Object} options - 配置选项
 * @returns {SchemaValidator}
 */
function getSchemaValidator(options = {}) {
  if (!instance) {
    instance = new SchemaValidator(options);
  }
  return instance;
}

module.exports = {
  SchemaValidator,
  getSchemaValidator,
};
