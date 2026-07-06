/**
 * OpenAPI Breaking Change 检测器
 * 用于对比两个 OpenAPI 规范，检测破坏性变更
 * 
 * @module OpenAPIComparator
 */

class OpenAPIBreakingChangeDetector {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false;
    this.breakingChangeTypes = {
      // 严重级别 Breaking Changes
      OPERATION_REMOVED: 'critical',
      PARAMETER_REMOVED: 'critical',
      PARAMETER_BECAME_REQUIRED: 'critical',
      PARAMETER_TYPE_CHANGED: 'critical',
      RESPONSE_REMOVED: 'critical',
      RESPONSE_PROPERTY_REMOVED: 'critical',
      RESPONSE_PROPERTY_TYPE_CHANGED: 'critical',
      REQUEST_BODY_REQUIRED_ADDED: 'critical',
      
      // 警告级别
      OPERATION_DEPRECATED: 'warning',
      PARAMETER_DEPRECATED: 'warning',
      RESPONSE_PROPERTY_DEPRECATED: 'warning',
      NEW_REQUIRED_PARAMETER: 'warning',
      ENUM_VALUE_REMOVED: 'warning',
      
      // 信息级别（非 Breaking Changes）
      DESCRIPTION_CHANGED: 'info',
      OPERATION_ADDED: 'info',
      PARAMETER_ADDED: 'info',
      RESPONSE_ADDED: 'info',
      RESPONSE_PROPERTY_ADDED: 'info'
    };
  }

  /**
   * 对比两个 OpenAPI 规范，检测 Breaking Changes
   * @param {Object} oldSpec - 旧版本 OpenAPI 规范
   * @param {Object} newSpec - 新版本 OpenAPI 规范
   * @returns {Array<BreakingChange>} 检测到的变更列表
   */
  compare(oldSpec, newSpec) {
    const changes = [];
    
    if (!oldSpec || !newSpec) {
      return changes;
    }

    // 规范化路径参数格式
    const oldPaths = this.normalizePaths(oldSpec.paths || {});
    const newPaths = this.normalizePaths(newSpec.paths || {});

    // 遍历旧规范的所有路径
    for (const [path, methods] of Object.entries(oldPaths)) {
      for (const [method, oldOp] of Object.entries(methods)) {
        const newOp = newPaths[path]?.[method];

        if (!newOp) {
          // Breaking Change: 操作被删除
          changes.push({
            type: 'OPERATION_REMOVED',
            severity: this.breakingChangeTypes.OPERATION_REMOVED,
            path,
            method: method.toUpperCase(),
            message: `${method.toUpperCase()} ${path} 已被删除`,
            oldOperationId: oldOp.operationId,
          });
          continue;
        }

        // 检查参数变更
        changes.push(
          ...this.checkParameterChanges(oldOp, newOp, path, method)
        );

        // 检查响应变更
        changes.push(
          ...this.checkResponseChanges(oldOp, newOp, path, method)
        );

        // 检查请求体变更
        changes.push(
          ...this.checkRequestBodyChanges(oldOp, newOp, path, method)
        );

        // 检查安全配置变更
        changes.push(
          ...this.checkSecurityChanges(oldOp, newOp, path, method)
        );
      }
    }

    // 检查新增的操作（信息级别）
    for (const [path, methods] of Object.entries(newPaths)) {
      for (const [method, newOp] of Object.entries(methods)) {
        const oldOp = oldPaths[path]?.[method];
        if (!oldOp) {
          changes.push({
            type: 'OPERATION_ADDED',
            severity: 'info',
            path,
            method: method.toUpperCase(),
            message: `${method.toUpperCase()} ${path} 是新增操作`,
            operationId: newOp.operationId,
          });
        }
      }
    }

    return changes;
  }

  /**
   * 检查参数变更
   */
  checkParameterChanges(oldOp, newOp, path, method) {
    const changes = [];
    const oldParams = oldOp.parameters || [];
    const newParams = newOp.parameters || [];

    // 将参数映射到对象以便查找
    const oldParamsMap = this.buildParamsMap(oldParams);
    const newParamsMap = this.buildParamsMap(newParams);

    // 检查旧参数是否被修改或删除
    for (const [paramKey, oldParam] of Object.entries(oldParamsMap)) {
      const newParam = newParamsMap.get(paramKey);

      if (!newParam) {
        // 参数被删除
        const severity = oldParam.required ? 'critical' : 'warning';
        changes.push({
          type: 'PARAMETER_REMOVED',
          severity: this.strictMode ? 'critical' : severity,
          path,
          method: method.toUpperCase(),
          parameter: oldParam.name,
          location: oldParam.in,
          message: `参数 ${oldParam.name} (${oldParam.in}) 已被删除`,
          wasRequired: oldParam.required,
        });
        continue;
      }

      // 检查类型变更
      const oldType = oldParam.schema?.type || oldParam.type;
      const newType = newParam.schema?.type || newParam.type;
      if (oldType && newType && oldType !== newType) {
        changes.push({
          type: 'PARAMETER_TYPE_CHANGED',
          severity: 'critical',
          path,
          method: method.toUpperCase(),
          parameter: oldParam.name,
          location: oldParam.in,
          oldType,
          newType,
          message: `参数 ${oldParam.name} 类型从 ${oldType} 变更为 ${newType}`,
        });
      }

      // 检查必填变更：可选变必填
      if (!oldParam.required && newParam.required) {
        changes.push({
          type: 'PARAMETER_BECAME_REQUIRED',
          severity: 'critical',
          path,
          method: method.toUpperCase(),
          parameter: oldParam.name,
          location: oldParam.in,
          message: `参数 ${oldParam.name} (${oldParam.in}) 从可选变为必填`,
        });
      }

      // 检查枚举值变更
      const oldEnum = oldParam.schema?.enum || oldParam.enum || [];
      const newEnum = newParam.schema?.enum || newParam.enum || [];
      if (oldEnum.length > 0) {
        const removedValues = oldEnum.filter(v => !newEnum.includes(v));
        if (removedValues.length > 0) {
          changes.push({
            type: 'ENUM_VALUE_REMOVED',
            severity: 'warning',
            path,
            method: method.toUpperCase(),
            parameter: oldParam.name,
            location: oldParam.in,
            removedValues,
            message: `参数 ${oldParam.name} 枚举值 ${removedValues.join(', ')} 已被删除`,
          });
        }
      }
    }

    // 检查新增的必填参数（警告）
    for (const [paramKey, newParam] of Object.entries(newParamsMap)) {
      const oldParam = oldParamsMap.get(paramKey);
      if (!oldParam && newParam.required) {
        changes.push({
          type: 'NEW_REQUIRED_PARAMETER',
          severity: 'warning',
          path,
          method: method.toUpperCase(),
          parameter: newParam.name,
          location: newParam.in,
          message: `新增必填参数 ${newParam.name} (${newParam.in})`,
        });
      }
    }

    return changes;
  }

  /**
   * 检查响应变更
   */
  checkResponseChanges(oldOp, newOp, path, method) {
    const changes = [];
    const oldResponses = oldOp.responses || {};
    const newResponses = newOp.responses || {};

    for (const [status, oldResponse] of Object.entries(oldResponses)) {
      const newResponse = newResponses[status];

      if (!newResponse) {
        // 响应状态码被删除
        changes.push({
          type: 'RESPONSE_REMOVED',
          severity: 'critical',
          path,
          method: method.toUpperCase(),
          statusCode: status,
          message: `响应状态码 ${status} 已被删除`,
        });
        continue;
      }

      // 检查响应体变更
      const oldSchema = oldResponse.content?.['application/json']?.schema;
      const newSchema = newResponse.content?.['application/json']?.schema;

      if (oldSchema && newSchema) {
        changes.push(
          ...this.checkSchemaChanges(oldSchema, newSchema, path, method, status)
        );
      }
    }

    return changes;
  }

  /**
   * 检查 Schema 变更
   */
  checkSchemaChanges(oldSchema, newSchema, path, method, status) {
    const changes = [];

    // 检查类型变更
    if (oldSchema.type !== newSchema.type) {
      changes.push({
        type: 'RESPONSE_PROPERTY_TYPE_CHANGED',
        severity: 'critical',
        path,
        method: method.toUpperCase(),
        statusCode: status,
        oldType: oldSchema.type,
        newType: newSchema.type,
        message: `响应类型从 ${oldSchema.type} 变更为 ${newSchema.type}`,
      });
      return changes;
    }

    // 检查对象属性变更
    if (oldSchema.type === 'object' || oldSchema.properties) {
      const oldProps = oldSchema.properties || {};
      const newProps = newSchema.properties || {};

      for (const [propName, oldProp] of Object.entries(oldProps)) {
        const newProp = newProps[propName];

        if (!newProp) {
          changes.push({
            type: 'RESPONSE_PROPERTY_REMOVED',
            severity: 'critical',
            path,
            method: method.toUpperCase(),
            statusCode: status,
            property: propName,
            message: `响应字段 ${propName} 已被删除`,
          });
          continue;
        }

        // 递归检查嵌套属性
        if (oldProp.type === 'object' && newProp.type === 'object') {
          changes.push(
            ...this.checkSchemaChanges(oldProp, newProp, path, method, status)
              .map(c => ({ ...c, property: `${propName}.${c.property}` }))
          );
        }

        // 检查属性类型变更
        if (oldProp.type && newProp.type && oldProp.type !== newProp.type) {
          changes.push({
            type: 'RESPONSE_PROPERTY_TYPE_CHANGED',
            severity: 'critical',
            path,
            method: method.toUpperCase(),
            statusCode: status,
            property: propName,
            oldType: oldProp.type,
            newType: newProp.type,
            message: `响应字段 ${propName} 类型从 ${oldProp.type} 变更为 ${newProp.type}`,
          });
        }
      }
    }

    // 检查数组项变更
    if (oldSchema.type === 'array' && oldSchema.items && newSchema.items) {
      changes.push(
        ...this.checkSchemaChanges(oldSchema.items, newSchema.items, path, method, status)
      );
    }

    return changes;
  }

  /**
   * 检查请求体变更
   */
  checkRequestBodyChanges(oldOp, newOp, path, method) {
    const changes = [];
    const oldBody = oldOp.requestBody;
    const newBody = newOp.requestBody;

    if (!oldBody && !newBody) return changes;

    if (oldBody && !newBody) {
      changes.push({
        type: 'REQUEST_BODY_REMOVED',
        severity: 'warning',
        path,
        method: method.toUpperCase(),
        message: `请求体已被删除`,
      });
      return changes;
    }

    if (!oldBody && newBody) {
      if (newBody.required) {
        changes.push({
          type: 'REQUEST_BODY_REQUIRED_ADDED',
          severity: 'critical',
          path,
          method: method.toUpperCase(),
          message: `新增必填请求体`,
        });
      }
      return changes;
    }

    // 检查必填变更
    if (!oldBody.required && newBody.required) {
      changes.push({
        type: 'REQUEST_BODY_REQUIRED_CHANGED',
        severity: 'critical',
        path,
        method: method.toUpperCase(),
        message: `请求体从可选变为必填`,
      });
    }

    return changes;
  }

  /**
   * 检查安全配置变更
   */
  checkSecurityChanges(oldOp, newOp, path, method) {
    const changes = [];
    const oldSecurity = oldOp.security || [];
    const newSecurity = newOp.security || [];

    // 如果安全配置被删除
    if (oldSecurity.length > 0 && newSecurity.length === 0) {
      changes.push({
        type: 'SECURITY_REMOVED',
        severity: 'warning',
        path,
        method: method.toUpperCase(),
        message: `安全配置已被删除`,
      });
    }

    return changes;
  }

  /**
   * 构建参数映射
   */
  buildParamsMap(params) {
    const map = new Map();
    for (const param of params) {
      const key = `${param.in}:${param.name}`;
      map.set(key, param);
    }
    return map;
  }

  /**
   * 规范化路径格式（统一参数命名）
   */
  normalizePaths(paths) {
    const normalized = {};
    for (const [path, methods] of Object.entries(paths)) {
      // 将 {param} 和 :param 统一为 {param}
      const normalizedPath = path.replace(/:(\w+)/g, '{$1}');
      normalized[normalizedPath] = methods;
    }
    return normalized;
  }

  /**
   * 获取所有 Breaking Changes（严重级别）
   */
  getBreakingChanges(changes) {
    return changes.filter(c => c.severity === 'critical');
  }

  /**
   * 生成变更报告
   */
  generateReport(changes) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total: changes.length,
        critical: changes.filter(c => c.severity === 'critical').length,
        warning: changes.filter(c => c.severity === 'warning').length,
        info: changes.filter(c => c.severity === 'info').length,
      },
      breakingChanges: this.getBreakingChanges(changes),
      allChanges: changes,
    };

    return report;
  }
}

module.exports = OpenAPIBreakingChangeDetector;
