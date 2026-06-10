'use strict';
/**
 * CompatibilityChecker - 契约兼容性检查器
 * 检测 API 变更的破坏性变更
 */

class CompatibilityChecker {
  constructor() {
    // 破坏性变更类型
    this.breakingChangeTypes = [
      'required_field_added',
      'field_removed',
      'field_type_changed',
      'enum_value_removed',
      'endpoint_removed',
      'response_field_removed'
    ];
  }

  /**
   * 检查两个契约的兼容性
   * @param {ContractSchema} oldContract - 旧契约
   * @param {ContractSchema} newContract - 新契约
   * @returns {Object} 兼容性检查结果
   */
  checkCompatibility(oldContract, newContract) {
    const result = {
      compatible: true,
      breakingChanges: [],
      nonBreakingChanges: [],
      warnings: [],
      details: {}
    };

    // 检查端点变更
    const endpointChanges = this.compareEndpoints(
      oldContract.endpoints,
      newContract.endpoints
    );

    result.breakingChanges.push(...endpointChanges.breaking);
    result.nonBreakingChanges.push(...endpointChanges.nonBreaking);
    result.details.endpoints = endpointChanges.details;

    // 检查 Schema 变更
    const schemaChanges = this.compareSchemas(
      oldContract.schemas,
      newContract.schemas
    );

    result.breakingChanges.push(...schemaChanges.breaking);
    result.nonBreakingChanges.push(...schemaChanges.nonBreaking);
    result.details.schemas = schemaChanges.details;

    // 最终判定
    if (result.breakingChanges.length > 0) {
      result.compatible = false;
    }

    return result;
  }

  /**
   * 比较端点变更
   * @param {Map} oldEndpoints - 旧端点
   * @param {Map} newEndpoints - 新端点
   * @returns {Object}
   */
  compareEndpoints(oldEndpoints, newEndpoints) {
    const changes = { breaking: [], nonBreaking: [], details: {} };
    const oldKeys = new Set(oldEndpoints.keys());
    const newKeys = new Set(newEndpoints.keys());

    // 检查删除的端点
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        changes.breaking.push({
          type: 'endpoint_removed',
          endpoint: key,
          severity: 'critical',
          message: `Endpoint removed: ${key}`
        });
      }
    }

    // 检查新增端点（非破坏性）
    for (const key of newKeys) {
      if (!oldKeys.has(key)) {
        changes.nonBreaking.push({
          type: 'endpoint_added',
          endpoint: key,
          message: `Endpoint added: ${key}`
        });
      }
    }

    // 检查端点修改
    for (const key of newKeys) {
      if (oldKeys.has(key)) {
        const oldEndpoint = oldEndpoints.get(key);
        const newEndpoint = newEndpoints.get(key);
        
        const endpointChanges = this.compareEndpointSchemas(
          oldEndpoint,
          newEndpoint,
          key
        );

        changes.breaking.push(...endpointChanges.breaking);
        changes.nonBreaking.push(...endpointChanges.nonBreaking);
        changes.details[key] = endpointChanges;
      }
    }

    return changes;
  }

  /**
   * 比较端点 Schema 变更
   * @param {Object} oldEndpoint - 旧端点
   * @param {Object} newEndpoint - 新端点
   * @param {string} endpointKey - 端点键
   * @returns {Object}
   */
  compareEndpointSchemas(oldEndpoint, newEndpoint, endpointKey) {
    const changes = { breaking: [], nonBreaking: [] };

    // 比较请求 Schema
    if (oldEndpoint.request && newEndpoint.request) {
      const requestChanges = this.compareJoiSchemas(
        oldEndpoint.request,
        newEndpoint.request,
        'request'
      );
      changes.breaking.push(...requestChanges.breaking);
      changes.nonBreaking.push(...requestChanges.nonBreaking);
    }

    // 比较响应 Schema（响应字段删除是破坏性的）
    if (oldEndpoint.response && newEndpoint.response) {
      const responseChanges = this.compareJoiSchemas(
        oldEndpoint.response,
        newEndpoint.response,
        'response'
      );
      changes.breaking.push(...responseChanges.breaking);
      changes.nonBreaking.push(...responseChanges.nonBreaking);
    }

    return changes;
  }

  /**
   * 比较 Joi Schema
   * @param {Joi.Schema} oldSchema - 旧 Schema
   * @param {Joi.Schema} newSchema - 新 Schema
   * @param {string} context - 上下文（request/response）
   * @returns {Object}
   */
  compareJoiSchemas(oldSchema, newSchema, context) {
    const changes = { breaking: [], nonBreaking: [] };

    const oldKeys = this.extractKeys(oldSchema);
    const newKeys = this.extractKeys(newSchema);

    // 检查删除的字段
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        // 响应字段删除是破坏性的
        const severity = context === 'response' ? 'critical' : 'high';
        changes.breaking.push({
          type: 'field_removed',
          field: key,
          context,
          severity,
          message: `Field removed from ${context}: ${key}`
        });
      }
    }

    // 检查新增字段
    for (const key of newKeys) {
      if (!oldKeys.has(key)) {
        changes.nonBreaking.push({
          type: 'field_added',
          field: key,
          context,
          message: `Field added to ${context}: ${key}`
        });
      }
    }

    return changes;
  }

  /**
   * 比较 Schema 定义变更
   * @param {Map} oldSchemas - 旧 Schemas
   * @param {Map} newSchemas - 新 Schemas
   * @returns {Object}
   */
  compareSchemas(oldSchemas, newSchemas) {
    const changes = { breaking: [], nonBreaking: [], details: {} };

    const oldNames = new Set(oldSchemas.keys());
    const newNames = new Set(newSchemas.keys());

    // 删除的 Schema
    for (const name of oldNames) {
      if (!newNames.has(name)) {
        changes.breaking.push({
          type: 'schema_removed',
          schema: name,
          severity: 'high',
          message: `Schema removed: ${name}`
        });
      }
    }

    // 新增的 Schema
    for (const name of newNames) {
      if (!oldNames.has(name)) {
        changes.nonBreaking.push({
          type: 'schema_added',
          schema: name,
          message: `Schema added: ${name}`
        });
      }
    }

    return changes;
  }

  /**
   * 检查消费者 Schema 与提供方 Schema 兼容性
   * @param {Joi.Schema} consumerSchema - 消费者期望 Schema
   * @param {Joi.Schema} providerSchema - 提供方实际 Schema
   * @returns {Object}
   */
  checkSchemaCompatibility(consumerSchema, providerSchema) {
    const result = {
      compatible: true,
      issues: []
    };

    const consumerKeys = this.extractKeys(consumerSchema);
    const providerKeys = this.extractKeys(providerSchema);

    // 检查消费者需要的字段提供方是否都有
    for (const key of consumerKeys) {
      if (!providerKeys.has(key)) {
        result.issues.push({
          type: 'missing_field',
          field: key,
          message: `Provider missing field: ${key}`
        });
        result.compatible = false;
      }
    }

    return result;
  }

  /**
   * 从 Joi Schema 提取键名
   * @param {Joi.Schema} schema - Joi Schema
   * @returns {Set}
   */
  extractKeys(schema) {
    const keys = new Set();

    if (!schema) {
      return keys;
    }

    // Joi 对象类型的键
    if (schema._ids && schema._ids._byKey) {
      for (const [key] of schema._ids._byKey) {
        keys.add(key);
      }
    }

    // 另一种形式的键提取
    if (schema.$_terms && schema.$_terms.keys) {
      for (const key of schema.$_terms.keys) {
        keys.add(key.key);
      }
    }

    return keys;
  }
}

module.exports = CompatibilityChecker;
