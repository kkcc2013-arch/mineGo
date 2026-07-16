'use strict';
/**
 * Schema Validation Middleware - API 响应 Schema 校验中间件
 * REQ-00547: API 响应 Schema 强制执行与合约测试自动化系统
 */

const { getSchemaRegistry } = require('../../shared/schemaRegistry/SchemaRegistry');
const logger = require('../../shared/logger');

/**
 * Schema 校验中间件配置
 */
const DEFAULT_CONFIG = {
  enabled: true,
  strictMode: false, // 严格模式（生产环境也阻断）
  excludePaths: ['/health', '/metrics', '/lifecycle/state'],
  logViolations: true,
  reportViolations: true,
  serviceName: null // 从环境变量读取
};

/**
 * Schema 校验中间件
 */
function schemaValidationMiddleware(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const registry = getSchemaRegistry();

  // 跳过特定路径
  const shouldSkip = (path) => {
    return config.excludePaths.some(excludePath => path.startsWith(excludePath));
  };

  return async (req, res, next) => {
    if (!config.enabled || shouldSkip(req.path)) {
      return next();
    }

    const serviceName = config.serviceName || process.env.SERVICE_NAME;
    const route = req.route?.path || req.path;
    const apiVersion = req.apiVersion || req.headers['x-api-version'] || 'v1';

    // 拦截 res.json
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        // 获取 Schema
        const schema = await registry.getSchema(serviceName, route, apiVersion);

        if (!schema) {
          // 没有 Schema 定义，记录警告但不阻断
          if (config.logViolations) {
            logger.warn('No schema definition found', {
              serviceName,
              route,
              apiVersion
            });
          }
          return originalJson(body);
        }

        // 校验响应
        const result = await registry.validateAgainstSchema(body, schema);

        if (!result.valid) {
          // 记录违规
          const violationReport = {
            serviceName,
            route,
            apiVersion,
            statusCode: res.statusCode,
            errors: result.errors,
            timestamp: new Date().toISOString(),
            requestBody: req.body,
            actualResponse: body
          };

          if (config.logViolations) {
            logger.error('Schema validation failed', violationReport);
          }

          // 上报违规到监控系统
          if (config.reportViolations) {
            await reportViolation(violationReport);
          }

          // 非生产环境或严格模式下返回错误
          const shouldBlock = config.strictMode || process.env.NODE_ENV !== 'production';
          
          if (shouldBlock) {
            return originalJson({
              success: false,
              code: 500,
              message: 'Schema validation failed',
              errors: result.errors,
              _meta: {
                serviceName,
                route,
                apiVersion
              }
            });
          }
        }

        return originalJson(body);
      } catch (error) {
        logger.error('Schema validation middleware error', {
          error: error.message,
          stack: error.stack
        });
        return originalJson(body);
      }
    };

    next();
  };
}

/**
 * 上报违规到监控系统
 */
async function reportViolation(report) {
  try {
    const { getRedis } = require('../../shared/redis');
    const redis = getRedis();
    
    const key = `schema:violations:${report.serviceName}`;
    const value = JSON.stringify(report);
    
    // 存储到 Redis List（保留最近 100 条）
    await redis.lpush(key, value);
    await redis.ltrim(key, 0, 99);
    await redis.expire(key, 86400); // 24 小时过期
    
    // 发布事件
    await redis.publish('schema:violation', value);
  } catch (error) {
    logger.error('Failed to report violation', { error: error.message });
  }
}

/**
 * 自动注册 Schema 中间件
 * 从请求中自动提取 Schema 并注册
 */
function autoRegisterSchemaMiddleware(options = {}) {
  const registry = getSchemaRegistry();
  
  return async (req, res, next) => {
    // 仅在开发环境启用
    if (process.env.NODE_ENV === 'production') {
      return next();
    }

    const serviceName = process.env.SERVICE_NAME;
    const route = req.route?.path || req.path;
    const apiVersion = req.headers['x-api-version'] || 'v1';

    // 拦截 res.json
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        // 检查是否已有 Schema
        const existingSchema = await registry.getSchema(serviceName, route, apiVersion);

        if (!existingSchema && req.query._generate_schema === 'true') {
          // 自动生成 Schema
          const generatedSchema = generateSchemaFromResponse(body);
          
          await registry.registerSchema(serviceName, route, apiVersion, generatedSchema);
          
          logger.info('Schema auto-generated and registered', {
            serviceName,
            route,
            apiVersion
          });
        }
      } catch (error) {
        logger.error('Auto schema generation failed', { error: error.message });
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * 从响应自动生成 Schema
 */
function generateSchemaFromResponse(response) {
  const schema = {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    title: 'Auto-generated Schema',
    type: 'object',
    required: [],
    properties: {}
  };

  if (response && typeof response === 'object') {
    const props = schema.properties;

    for (const [key, value] of Object.entries(response)) {
      props[key] = inferType(value);

      // 必需字段推断
      if (value !== null && value !== undefined) {
        schema.required.push(key);
      }
    }
  }

  return schema;
}

/**
 * 推断值的类型
 */
function inferType(value) {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'null' };

  const type = typeof value;

  switch (type) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object':
      if (Array.isArray(value)) {
        if (value.length > 0) {
          return {
            type: 'array',
            items: inferType(value[0])
          };
        }
        return { type: 'array' };
      }
      // 递归处理嵌套对象
      const nestedProps = {};
      for (const [k, v] of Object.entries(value)) {
        nestedProps[k] = inferType(v);
      }
      return {
        type: 'object',
        properties: nestedProps
      };
    default:
      return { type: 'string' };
  }
}

/**
 * Schema 差异检测中间件
 * 检测实际响应与 Schema 的差异
 */
function schemaDiffDetectionMiddleware(options = {}) {
  const registry = getSchemaRegistry();
  const config = {
    enabled: true,
    reportDifferences: true,
    ...options
  };

  return async (req, res, next) => {
    if (!config.enabled) {
      return next();
    }

    const serviceName = process.env.SERVICE_NAME;
    const route = req.route?.path || req.path;
    const apiVersion = req.headers['x-api-version'] || 'v1';

    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        const schema = await registry.getSchema(serviceName, route, apiVersion);

        if (schema && config.reportDifferences) {
          const differences = detectSchemaDifferences(schema, body);

          if (differences.length > 0) {
            logger.warn('Schema differences detected', {
              serviceName,
              route,
              apiVersion,
              differences
            });

            // 上报差异
            await reportSchemaDifference({
              serviceName,
              route,
              apiVersion,
              differences,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        logger.error('Schema diff detection failed', { error: error.message });
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * 检测 Schema 与实际响应的差异
 */
function detectSchemaDifferences(schema, actualResponse) {
  const differences = [];

  if (!schema.properties) {
    return differences;
  }

  const schemaProps = Object.keys(schema.properties);
  const actualProps = Object.keys(actualResponse || {});

  // Schema 中定义但实际响应中缺失的字段
  const missingFields = schemaProps.filter(p => !(p in actualResponse));
  if (missingFields.length > 0) {
    differences.push({
      type: 'missing_field',
      fields: missingFields,
      message: `Fields defined in schema but missing in response: ${missingFields.join(', ')}`
    });
  }

  // 实际响应中有但 Schema 中未定义的字段
  const extraFields = actualProps.filter(p => !(p in schema.properties));
  if (extraFields.length > 0) {
    differences.push({
      type: 'extra_field',
      fields: extraFields,
      message: `Fields in response but not defined in schema: ${extraFields.join(', ')}`
    });
  }

  // 类型不匹配
  for (const prop of schemaProps) {
    if (prop in actualResponse) {
      const expectedType = schema.properties[prop].type;
      const actualType = typeof actualResponse[prop];

      if (expectedType && actualType !== expectedType) {
        // 特殊处理 integer 类型
        if (expectedType === 'integer' && actualType === 'number' && Number.isInteger(actualResponse[prop])) {
          continue;
        }

        differences.push({
          type: 'type_mismatch',
          field: prop,
          expected: expectedType,
          actual: actualType,
          message: `Field ${prop} type mismatch: expected ${expectedType}, got ${actualType}`
        });
      }
    }
  }

  return differences;
}

/**
 * 上报 Schema 差异
 */
async function reportSchemaDifference(report) {
  try {
    const { getRedis } = require('../../shared/redis');
    const redis = getRedis();
    
    const key = `schema:differences:${report.serviceName}`;
    const value = JSON.stringify(report);
    
    await redis.lpush(key, value);
    await redis.ltrim(key, 0, 49); // 保留最近 50 条
    await redis.expire(key, 86400);
  } catch (error) {
    logger.error('Failed to report schema difference', { error: error.message });
  }
}

module.exports = {
  schemaValidationMiddleware,
  autoRegisterSchemaMiddleware,
  schemaDiffDetectionMiddleware,
  reportViolation,
  generateSchemaFromResponse
};