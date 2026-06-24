'use strict';
/**
 * 验证错误码定义
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 * 
 * 标准化的错误码与 HTTP 状态码映射
 */

/**
 * 验证错误码枚举
 * 每个错误码包含：code（错误码）、http（HTTP状态码）、message（默认消息）
 */
const ValidationErrorCodes = {
  // ===== 通用验证错误 (1000-1099) =====
  VALIDATION_ERROR: { 
    code: 'VALIDATION_ERROR', 
    http: 400, 
    message: '请求参数验证失败' 
  },
  MISSING_REQUIRED_FIELD: { 
    code: 'MISSING_REQUIRED_FIELD', 
    http: 400, 
    message: '缺少必填字段' 
  },
  INVALID_FORMAT: { 
    code: 'INVALID_FORMAT', 
    http: 400, 
    message: '格式无效' 
  },
  VALUE_OUT_OF_RANGE: { 
    code: 'VALUE_OUT_OF_RANGE', 
    http: 400, 
    message: '值超出范围' 
  },
  EMPTY_VALUE: { 
    code: 'EMPTY_VALUE', 
    http: 400, 
    message: '值不能为空' 
  },
  
  // ===== 类型错误 (1100-1199) =====
  INVALID_TYPE: { 
    code: 'INVALID_TYPE', 
    http: 400, 
    message: '字段类型无效' 
  },
  INVALID_NUMBER: { 
    code: 'INVALID_NUMBER', 
    http: 400, 
    message: '数字格式无效' 
  },
  INVALID_STRING: { 
    code: 'INVALID_STRING', 
    http: 400, 
    message: '字符串格式无效' 
  },
  INVALID_BOOLEAN: { 
    code: 'INVALID_BOOLEAN', 
    http: 400, 
    message: '布尔值格式无效' 
  },
  INVALID_DATE: { 
    code: 'INVALID_DATE', 
    http: 400, 
    message: '日期格式无效' 
  },
  INVALID_ARRAY: { 
    code: 'INVALID_ARRAY', 
    http: 400, 
    message: '数组格式无效' 
  },
  INVALID_OBJECT: { 
    code: 'INVALID_OBJECT', 
    http: 400, 
    message: '对象格式无效' 
  },
  
  // ===== 业务实体错误 (1200-1299) =====
  INVALID_OBJECT_ID: { 
    code: 'INVALID_OBJECT_ID', 
    http: 400, 
    message: '无效的 ObjectId' 
  },
  INVALID_POKEMON_ID: { 
    code: 'INVALID_POKEMON_ID', 
    http: 400, 
    message: '无效的精灵 ID' 
  },
  INVALID_USER_ID: { 
    code: 'INVALID_USER_ID', 
    http: 400, 
    message: '无效的用户 ID' 
  },
  INVALID_GYM_ID: { 
    code: 'INVALID_GYM_ID', 
    http: 400, 
    message: '无效的道馆 ID' 
  },
  INVALID_COORDINATES: { 
    code: 'INVALID_COORDINATES', 
    http: 400, 
    message: '坐标格式无效' 
  },
  INVALID_LATITUDE: { 
    code: 'INVALID_LATITUDE', 
    http: 400, 
    message: '纬度无效（范围：-90 ~ 90）' 
  },
  INVALID_LONGITUDE: { 
    code: 'INVALID_LONGITUDE', 
    http: 400, 
    message: '经度无效（范围：-180 ~ 180）' 
  },
  INVALID_EMAIL: { 
    code: 'INVALID_EMAIL', 
    http: 400, 
    message: '邮箱格式无效' 
  },
  INVALID_PHONE: { 
    code: 'INVALID_PHONE', 
    http: 400, 
    message: '手机号格式无效' 
  },
  INVALID_PASSWORD: { 
    code: 'INVALID_PASSWORD', 
    http: 400, 
    message: '密码格式无效' 
  },
  INVALID_USERNAME: { 
    code: 'INVALID_USERNAME', 
    http: 400, 
    message: '用户名格式无效' 
  },
  INVALID_NICKNAME: { 
    code: 'INVALID_NICKNAME', 
    http: 400, 
    message: '昵称格式无效' 
  },
  
  // ===== 分页错误 (1300-1399) =====
  INVALID_PAGINATION: { 
    code: 'INVALID_PAGINATION', 
    http: 400, 
    message: '分页参数无效' 
  },
  PAGE_OUT_OF_RANGE: { 
    code: 'PAGE_OUT_OF_RANGE', 
    http: 400, 
    message: '页码超出范围' 
  },
  INVALID_PAGE_SIZE: { 
    code: 'INVALID_PAGE_SIZE', 
    http: 400, 
    message: '每页数量无效' 
  },
  INVALID_CURSOR: { 
    code: 'INVALID_CURSOR', 
    http: 400, 
    message: '游标格式无效' 
  },
  
  // ===== 字符串验证错误 (1400-1499) =====
  STRING_TOO_SHORT: { 
    code: 'STRING_TOO_SHORT', 
    http: 400, 
    message: '字符串长度不足' 
  },
  STRING_TOO_LONG: { 
    code: 'STRING_TOO_LONG', 
    http: 400, 
    message: '字符串超出最大长度' 
  },
  STRING_PATTERN_MISMATCH: { 
    code: 'STRING_PATTERN_MISMATCH', 
    http: 400, 
    message: '字符串格式不符合要求' 
  },
  
  // ===== 数值验证错误 (1500-1599) =====
  NUMBER_TOO_SMALL: { 
    code: 'NUMBER_TOO_SMALL', 
    http: 400, 
    message: '数值太小' 
  },
  NUMBER_TOO_LARGE: { 
    code: 'NUMBER_TOO_LARGE', 
    http: 400, 
    message: '数值太大' 
  },
  NUMBER_NOT_INTEGER: { 
    code: 'NUMBER_NOT_INTEGER', 
    http: 400, 
    message: '数值必须为整数' 
  },
  NUMBER_NOT_POSITIVE: { 
    code: 'NUMBER_NOT_POSITIVE', 
    http: 400, 
    message: '数值必须为正数' 
  },
  
  // ===== 枚举验证错误 (1600-1699) =====
  INVALID_ENUM_VALUE: { 
    code: 'INVALID_ENUM_VALUE', 
    http: 400, 
    message: '枚举值无效' 
  },
  
  // ===== 文件验证错误 (1700-1799) =====
  FILE_TOO_LARGE: { 
    code: 'FILE_TOO_LARGE', 
    http: 400, 
    message: '文件大小超出限制' 
  },
  INVALID_FILE_TYPE: { 
    code: 'INVALID_FILE_TYPE', 
    http: 400, 
    message: '文件类型不允许' 
  },
  INVALID_FILE_NAME: { 
    code: 'INVALID_FILE_NAME', 
    http: 400, 
    message: '文件名无效' 
  },
  
  // ===== 业务逻辑错误 (2000-2999) =====
  RESOURCE_NOT_FOUND: { 
    code: 'RESOURCE_NOT_FOUND', 
    http: 404, 
    message: '资源不存在' 
  },
  RESOURCE_ALREADY_EXISTS: { 
    code: 'RESOURCE_ALREADY_EXISTS', 
    http: 409, 
    message: '资源已存在' 
  },
  RESOURCE_CONFLICT: { 
    code: 'RESOURCE_CONFLICT', 
    http: 409, 
    message: '资源冲突' 
  },
  OPERATION_NOT_ALLOWED: { 
    code: 'OPERATION_NOT_ALLOWED', 
    http: 403, 
    message: '操作不允许' 
  },
  DUPLICATE_VALUE: { 
    code: 'DUPLICATE_VALUE', 
    http: 409, 
    message: '值已存在' 
  }
};

/**
 * 根据错误码获取 HTTP 状态码
 * @param {string} errorCode - 错误码
 * @returns {number} HTTP 状态码
 */
function getHttpStatus(errorCode) {
  // 查找错误码定义
  const errorDef = Object.values(ValidationErrorCodes).find(e => e.code === errorCode);
  
  if (errorDef) {
    return errorDef.http;
  }
  
  // 默认返回 400
  return 400;
}

/**
 * 根据错误码获取默认消息
 * @param {string} errorCode - 错误码
 * @returns {string} 默认消息
 */
function getDefaultMessage(errorCode) {
  const errorDef = Object.values(ValidationErrorCodes).find(e => e.code === errorCode);
  return errorDef?.message || '未知错误';
}

/**
 * 检查错误码是否存在
 * @param {string} errorCode - 错误码
 * @returns {boolean}
 */
function isValidErrorCode(errorCode) {
  return Object.values(ValidationErrorCodes).some(e => e.code === errorCode);
}

/**
 * 获取所有错误码列表
 * @returns {Array<{code: string, http: number, message: string}>}
 */
function getAllErrorCodes() {
  return Object.entries(ValidationErrorCodes).map(([key, value]) => ({
    key,
    ...value
  }));
}

/**
 * 按类别获取错误码
 * @param {string} category - 类别（如 'TYPE', 'ENTITY', 'PAGINATION'）
 * @returns {Array}
 */
function getErrorCodesByCategory(category) {
  const prefix = category.toUpperCase();
  return Object.entries(ValidationErrorCodes)
    .filter(([key]) => key.includes(prefix))
    .map(([key, value]) => ({ key, ...value }));
}

/**
 * 错误码范围定义
 */
const ErrorCodeRanges = {
  GENERAL: { start: 1000, end: 1099, description: '通用验证错误' },
  TYPE: { start: 1100, end: 1199, description: '类型错误' },
  ENTITY: { start: 1200, end: 1299, description: '业务实体错误' },
  PAGINATION: { start: 1300, end: 1399, description: '分页错误' },
  STRING: { start: 1400, end: 1499, description: '字符串验证错误' },
  NUMBER: { start: 1500, end: 1599, description: '数值验证错误' },
  ENUM: { start: 1600, end: 1699, description: '枚举验证错误' },
  FILE: { start: 1700, end: 1799, description: '文件验证错误' },
  BUSINESS: { start: 2000, end: 2999, description: '业务逻辑错误' }
};

/**
 * 生成 OpenAPI 错误响应 Schema
 * @param {string[]} errorCodes - 错误码列表
 * @returns {Object} OpenAPI Schema 对象
 */
function generateOpenAPIErrorSchema(errorCodes) {
  const examples = {};
  
  for (const code of errorCodes) {
    const def = Object.values(ValidationErrorCodes).find(e => e.code === code);
    if (def) {
      examples[code] = {
        value: {
          success: false,
          error: {
            code: def.code,
            message: def.message,
            details: [],
            requestId: 'req_example_123'
          },
          meta: {
            requestId: 'req_example_123',
            timestamp: new Date().toISOString(),
            duration: 12
          }
        }
      };
    }
  }
  
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string', example: '请求参数验证失败' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                message: { type: 'string' },
                value: {},
                constraint: { type: 'string' }
              }
            }
          },
          requestId: { type: 'string' }
        }
      },
      meta: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          duration: { type: 'number' }
        }
      }
    },
    examples
  };
}

module.exports = {
  ValidationErrorCodes,
  getHttpStatus,
  getDefaultMessage,
  isValidErrorCode,
  getAllErrorCodes,
  getErrorCodesByCategory,
  ErrorCodeRanges,
  generateOpenAPIErrorSchema
};
