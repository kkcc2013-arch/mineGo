/**
 * OpenAPI 文档一致性校验器
 * 校验 OpenAPI 文档与实际实现的一致性
 * 
 * @module OpenAPIConsistencyChecker
 */

class OpenAPIConsistencyChecker {
  constructor(options = {}) {
    this.excludeRoutes = options.excludeRoutes || [
      '/health',
      '/metrics',
      '/debug',
    ];
    this.excludeMethods = options.excludeMethods || ['HEAD', 'OPTIONS'];
  }

  /**
   * 校验 OpenAPI 文档与实际实现的一致性
   * @param {Object} spec - OpenAPI 规范
   * @param {Express} app - Express 应用实例
   * @returns {Promise<Array<Inconsistency>>}
   */
  async check(spec, app) {
    const inconsistencies = [];

    // 1. 检查文档中声明的路由是否实际存在
    const documentedRoutes = this.extractDocumentedRoutes(spec);
    for (const route of documentedRoutes) {
      if (this.shouldExclude(route)) continue;

      const exists = this.routeExists(app, route.method, route.path);
      if (!exists) {
        inconsistencies.push({
          type: 'DOCUMENTED_ROUTE_NOT_IMPLEMENTED',
          severity: 'warning',
          path: route.path,
          method: route.method,
          message: `文档声明的路由 ${route.method.toUpperCase()} ${route.path} 未实现`,
          operationId: route.operationId,
        });
      }
    }

    // 2. 检查实际路由是否都在文档中声明
    const actualRoutes = this.extractRoutes(app);
    for (const route of actualRoutes) {
      if (this.shouldExclude(route)) continue;

      const documented = this.isDocumented(spec, route.method, route.path);
      if (!documented) {
        inconsistencies.push({
          type: 'IMPLEMENTED_ROUTE_NOT_DOCUMENTED',
          severity: 'warning',
          path: route.path,
          method: route.method,
          message: `实际路由 ${route.method.toUpperCase()} ${route.path} 未在文档中声明`,
        });
      }
    }

    // 3. 检查响应格式一致性（需要实际调用）
    // inconsistencies.push(...await this.checkResponseFormat(spec, app));

    // 4. 检查参数定义完整性
    for (const route of documentedRoutes) {
      const op = this.getOperation(spec, route.method, route.path);
      if (op) {
        inconsistencies.push(...this.checkParameterCompleteness(op, route));
      }
    }

    // 5. 检查响应定义完整性
    for (const route of documentedRoutes) {
      const op = this.getOperation(spec, route.method, route.path);
      if (op) {
        inconsistencies.push(...this.checkResponseCompleteness(op, route));
      }
    }

    return inconsistencies;
  }

  /**
   * 提取文档中声明的路由
   */
  extractDocumentedRoutes(spec) {
    const routes = [];

    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const [method, operation] of Object.entries(methods)) {
        if (this.excludeMethods.includes(method.toUpperCase())) continue;

        routes.push({
          path: this.openapiPathToExpress(path),
          method: method.toLowerCase(),
          operationId: operation.operationId,
          operation,
        });
      }
    }

    return routes;
  }

  /**
   * 提取 Express 应用中的路由
   */
  extractRoutes(app) {
    const routes = [];

    function walk(stack, basePath = '') {
      for (const layer of stack) {
        if (layer.route) {
          for (const method of Object.keys(layer.route.methods)) {
            if (this.excludeMethods.includes(method.toUpperCase())) continue;

            routes.push({
              method,
              path: basePath + layer.route.path,
            });
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(layer.handle.stack, basePath + (layer.regexp?.source?.replace(/\\/g, '').replace(/\?.*$/, '') || ''));
        }
      }
    }

    walk(app._router?.stack || [], '');
    return routes;
  }

  /**
   * OpenAPI 路径格式转换为 Express 格式
   */
  openapiPathToExpress(path) {
    return path.replace(/\{(\w+)\}/g, ':$1');
  }

  /**
   * Express 路径格式转换为 OpenAPI 格式
   */
  expressPathToOpenAPI(path) {
    return path.replace(/:(\w+)/g, '{$1}');
  }

  /**
   * 检查路由是否存在
   */
  routeExists(app, method, path) {
    const routes = this.extractRoutes(app);
    return routes.some(r => 
      r.method === method.toLowerCase() && 
      this.normalizePath(r.path) === this.normalizePath(path)
    );
  }

  /**
   * 检查路由是否已文档化
   */
  isDocumented(spec, method, path) {
    const openapiPath = this.expressPathToOpenAPI(path);
    return spec.paths?.[openapiPath]?.[method.toLowerCase()] !== undefined;
  }

  /**
   * 获取操作定义
   */
  getOperation(spec, method, path) {
    const openapiPath = this.expressPathToOpenAPI(path);
    return spec.paths?.[openapiPath]?.[method.toLowerCase()];
  }

  /**
   * 规范化路径用于比较
   */
  normalizePath(path) {
    return path.replace(/:(\w+)/g, ':param')
      .replace(/\{(\w+)\}/g, ':param')
      .replace(/\/$/, '');
  }

  /**
   * 检查参数定义完整性
   */
  checkParameterCompleteness(operation, route) {
    const issues = [];
    const params = operation.parameters || [];

    // 检查是否有响应体但没有参数定义
    if (operation.requestBody) {
      const bodyParams = params.filter(p => p.in === 'body');
      if (bodyParams.length === 0 && !operation.requestBody.content) {
        // OpenAPI 3.x 使用 requestBody，不需要检查
      }
    }

    // 检查是否有路径参数未定义
    const pathParams = route.path.match(/:(\w+)/g) || [];
    for (const pathParam of pathParams) {
      const paramName = pathParam.replace(':', '');
      const defined = params.some(
        p => p.name === paramName && p.in === 'path'
      );
      if (!defined) {
        issues.push({
          type: 'PATH_PARAM_NOT_DEFINED',
          severity: 'error',
          path: route.path,
          method: route.method,
          parameter: paramName,
          message: `路径参数 ${paramName} 未在 OpenAPI 文档中定义`,
        });
      }
    }

    return issues;
  }

  /**
   * 检查响应定义完整性
   */
  checkResponseCompleteness(operation, route) {
    const issues = [];
    const responses = operation.responses || {};

    // 检查是否有成功响应定义
    const successCodes = ['200', '201', '204'];
    const hasSuccessResponse = successCodes.some(code => responses[code]);

    if (!hasSuccessResponse) {
      issues.push({
        type: 'SUCCESS_RESPONSE_NOT_DEFINED',
        severity: 'warning',
        path: route.path,
        method: route.method,
        message: `缺少成功响应定义（200/201/204）`,
      });
    }

    // 检查是否有错误响应定义
    const errorCodes = ['400', '401', '403', '404', '500'];
    const hasErrorResponse = errorCodes.some(code => responses[code]);

    if (!hasErrorResponse && route.method !== 'get') {
      issues.push({
        type: 'ERROR_RESPONSE_NOT_DEFINED',
        severity: 'info',
        path: route.path,
        method: route.method,
        message: `建议添加常见错误响应定义（400/401/403/404/500）`,
      });
    }

    return issues;
  }

  /**
   * 检查是否应排除
   */
  shouldExclude(route) {
    for (const exclude of this.excludeRoutes) {
      if (route.path.startsWith(exclude) || route.path === exclude) {
        return true;
      }
    }
    return false;
  }

  /**
   * 校验响应格式（需要实际调用 API）
   */
  async checkResponseFormat(spec, app) {
    const request = require('supertest');
    const inconsistencies = [];

    const testCases = [
      { method: 'get', path: '/api/pokemon/list', statusCode: 200 },
      { method: 'get', path: '/api/location/nearby', statusCode: 200 },
    ];

    for (const tc of testCases) {
      try {
        const res = await request(app)[tc.method](tc.path);
        const schema = this.getResponseSchema(spec, tc.path, tc.method, tc.statusCode);

        if (schema) {
          const valid = this.validateAgainstSchema(res.body, schema);
          if (!valid.valid) {
            inconsistencies.push({
              type: 'RESPONSE_SCHEMA_MISMATCH',
              severity: 'error',
              path: tc.path,
              method: tc.method,
              statusCode: tc.statusCode,
              message: `响应格式与 OpenAPI schema 不一致`,
              details: valid.errors,
            });
          }
        }
      } catch (error) {
        inconsistencies.push({
          type: 'API_CALL_FAILED',
          severity: 'warning',
          path: tc.path,
          method: tc.method,
          message: `API 调用失败: ${error.message}`,
        });
      }
    }

    return inconsistencies;
  }

  /**
   * 获取响应 Schema
   */
  getResponseSchema(spec, path, method, statusCode) {
    const openapiPath = this.expressPathToOpenAPI(path);
    return spec.paths?.[openapiPath]?.[method]?.responses?.[statusCode]
      ?.content?.['application/json']?.schema;
  }

  /**
   * 验证数据是否符合 Schema
   */
  validateAgainstSchema(data, schema) {
    const errors = [];

    if (!schema) return { valid: true, errors: [] };

    if (schema.type === 'object') {
      if (typeof data !== 'object' || data === null) {
        errors.push({ message: 'Expected object', actual: typeof data });
        return { valid: false, errors };
      }

      for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
        if (schema.required?.includes(propName) && !data[propName]) {
          errors.push({
            message: `Required property ${propName} missing`,
          });
        }

        if (data[propName] !== undefined) {
          const propResult = this.validateAgainstSchema(data[propName], propSchema);
          errors.push(...propResult.errors.map(e => ({
            ...e,
            property: propName,
          })));
        }
      }
    }

    if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        errors.push({ message: 'Expected array', actual: typeof data });
        return { valid: false, errors };
      }

      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          const itemResult = this.validateAgainstSchema(data[i], schema.items);
          errors.push(...itemResult.errors.map(e => ({
            ...e,
            index: i,
          })));
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 生成一致性报告
   */
  generateReport(inconsistencies) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total: inconsistencies.length,
        errors: inconsistencies.filter(i => i.severity === 'error').length,
        warnings: inconsistencies.filter(i => i.severity === 'warning').length,
        info: inconsistencies.filter(i => i.severity === 'info').length,
      },
      issues: inconsistencies,
    };

    return report;
  }
}

module.exports = OpenAPIConsistencyChecker;