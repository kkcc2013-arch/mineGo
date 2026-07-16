'use strict';
/**
 * Schema Diff Detector - Schema 差异检测与修复建议
 * REQ-00547: API 响应 Schema 强制执行与合约测试自动化系统
 */

const logger = require('../logger');
const { getRedis } = require('../redis');

/**
 * Schema 差异检测器
 */
class SchemaDiffDetector {
  constructor() {
    this.redisClient = getRedis();
  }

  /**
   * 比较 Schema 与实际响应
   */
  async compareWithActualResponse(serviceName, route, actualResponse) {
    const { getSchemaRegistry } = require('./SchemaRegistry');
    const registry = getSchemaRegistry();

    const schema = await registry.getSchema(serviceName, route, 'latest');

    if (!schema) {
      return {
        hasSchema: false,
        differences: [],
        message: 'No schema defined for this endpoint'
      };
    }

    const differences = this.detectDifferences(schema, actualResponse);

    return {
      hasSchema: true,
      serviceName,
      route,
      differences,
      breakingChanges: differences.filter(d => d.breaking),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 检测差异
   */
  detectDifferences(schema, actualResponse) {
    const differences = [];

    if (!schema.properties) {
      return differences;
    }

    // 检查类型不匹配
    this.checkTypeMismatches(schema, actualResponse, '', differences);

    // 检查缺失的必需字段
    this.checkMissingRequiredFields(schema, actualResponse, differences);

    // 检查额外字段
    this.checkExtraFields(schema, actualResponse, differences);

    // 检查枚举值不匹配
    this.checkEnumMismatches(schema, actualResponse, '', differences);

    // 检查数组项类型不匹配
    this.checkArrayItemMismatches(schema, actualResponse, '', differences);

    return differences;
  }

  /**
   * 检查类型不匹配
   */
  checkTypeMismatches(schema, data, path, differences) {
    if (!schema.properties || !data) return;

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in data)) continue;

      const value = data[key];
      const fullPath = path ? `${path}.${key}` : key;
      const expectedType = propSchema.type;

      if (!expectedType) continue;

      const actualType = this.getValueType(value);

      // 类型不匹配（允许 integer 作为 number）
      if (actualType !== expectedType && 
          !(expectedType === 'number' && actualType === 'integer')) {
        differences.push({
          type: 'type_mismatch',
          breaking: true,
          path: fullPath,
          expected: expectedType,
          actual: actualType,
          message: `Type mismatch at ${fullPath}: expected ${expectedType}, got ${actualType}`
        });
      }

      // 递归检查嵌套对象
      if (propSchema.type === 'object' && propSchema.properties) {
        this.checkTypeMismatches(propSchema, value, fullPath, differences);
      }
    }
  }

  /**
   * 检查缺失的必需字段
   */
  checkMissingRequiredFields(schema, data, differences) {
    if (!schema.required || !data) return;

    const missingFields = schema.required.filter(field => !(field in data));

    if (missingFields.length > 0) {
      differences.push({
        type: 'missing_required_field',
        breaking: true,
        fields: missingFields,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
  }

  /**
   * 检查额外字段
   */
  checkExtraFields(schema, data, differences) {
    if (!schema.properties || !data) return;

    const extraFields = Object.keys(data).filter(key => !(key in schema.properties));

    if (extraFields.length > 0) {
      differences.push({
        type: 'extra_field',
        breaking: false,
        fields: extraFields,
        message: `Extra fields not defined in schema: ${extraFields.join(', ')}`
      });
    }
  }

  /**
   * 检查枚举值不匹配
   */
  checkEnumMismatches(schema, data, path, differences) {
    if (!schema.properties || !data) return;

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in data) || !propSchema.enum) continue;

      const value = data[key];
      const fullPath = path ? `${path}.${key}` : key;

      if (!propSchema.enum.includes(value)) {
        differences.push({
          type: 'enum_mismatch',
          breaking: true,
          path: fullPath,
          value,
          allowed: propSchema.enum,
          message: `Value at ${fullPath} not in allowed enum values: ${propSchema.enum.join(', ')}`
        });
      }
    }
  }

  /**
   * 检查数组项类型不匹配
   */
  checkArrayItemMismatches(schema, data, path, differences) {
    if (!schema.properties || !data) return;

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in data) || propSchema.type !== 'array') continue;

      const value = data[key];
      const fullPath = path ? `${path}.${key}` : key;

      if (!Array.isArray(value)) continue;

      // 检查数组项类型
      if (propSchema.items && propSchema.items.type) {
        const itemType = propSchema.items.type;

        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          const actualItemType = this.getValueType(item);

          if (actualItemType !== itemType &&
              !(itemType === 'number' && actualItemType === 'integer')) {
            differences.push({
              type: 'array_item_type_mismatch',
              breaking: true,
              path: `${fullPath}[${i}]`,
              expected: itemType,
              actual: actualItemType,
              message: `Array item type mismatch at ${fullPath}[${i}]: expected ${itemType}, got ${actualItemType}`
            });
          }
        }
      }
    }
  }

  /**
   * 获取值的类型
   */
  getValueType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'null';

    const type = typeof value;

    if (type === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    }

    return type;
  }

  /**
   * 生成差异报告
   */
  async generateDiffReport(serviceName) {
    const reports = [];

    try {
      const key = `schema:differences:${serviceName}`;
      const items = await this.redisClient.lrange(key, 0, 49);

      for (const item of items) {
        try {
          const report = JSON.parse(item);
          reports.push(report);
        } catch (e) {
          // 跳过解析错误
        }
      }

      return {
        serviceName,
        totalDifferences: reports.length,
        reports,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to generate diff report', {
        serviceName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 建议修复方案
   */
  suggestFixes(differences) {
    const fixes = [];

    for (const diff of differences) {
      switch (diff.type) {
        case 'type_mismatch':
          fixes.push({
            type: 'fix_type',
            path: diff.path,
            suggestion: `Convert value to ${diff.expected} type`,
            breaking: diff.breaking
          });
          break;

        case 'missing_required_field':
          fixes.push({
            type: 'add_field',
            fields: diff.fields,
            suggestion: `Add missing required fields: ${diff.fields.join(', ')}`,
            breaking: diff.breaking
          });
          break;

        case 'extra_field':
          fixes.push({
            type: 'update_schema',
            fields: diff.fields,
            suggestion: `Either remove extra fields or update schema to include them`,
            breaking: diff.breaking
          });
          break;

        case 'enum_mismatch':
          fixes.push({
            type: 'fix_enum',
            path: diff.path,
            suggestion: `Use one of allowed values: ${diff.allowed.join(', ')}`,
            breaking: diff.breaking
          });
          break;
      }
    }

    return fixes;
  }

  /**
   * 自动生成修复后的 Schema
   */
  generateFixedSchema(originalSchema, differences) {
    const fixedSchema = JSON.parse(JSON.stringify(originalSchema));

    for (const diff of differences) {
      if (diff.type === 'extra_field' && diff.fields) {
        // 添加额外字段到 Schema
        if (!fixedSchema.properties) {
          fixedSchema.properties = {};
        }

        for (const field of diff.fields) {
          fixedSchema.properties[field] = {
            type: 'string',
            description: 'Auto-added field'
          };
        }
      }
    }

    return fixedSchema;
  }
}

module.exports = SchemaDiffDetector;