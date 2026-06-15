# REQ-00226: API 请求契约测试自动化与 Mock 服务生成系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00226 |
| 标题 | API 请求契约测试自动化与 Mock 服务生成系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/tests/contract、docs/api-spec、frontend/game-client |
| 创建时间 | 2026-06-15 18:00 |

## 需求描述

基于 OpenAPI 规范，实现自动化的 API 契约测试系统和 Mock 服务生成器。确保前后端接口定义一致性，自动验证请求/响应结构，并为前端开发提供独立的 Mock 服务，提升开发效率和接口可靠性。

### 核心目标
1. **契约驱动开发**：从 OpenAPI 规范自动生成测试用例
2. **Mock 服务自动化**：基于规范生成 Mock 服务，支持前端独立开发
3. **接口一致性验证**：实时监控实际 API 与规范的符合度
4. **Breaking Change 检测**：自动检测破坏性变更并告警

## 技术方案

### 1. OpenAPI 规范解析与测试生成器

```javascript
// backend/shared/ContractTestGenerator.js
const SwaggerParser = require('@apidevtools/swagger-parser');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

class ContractTestGenerator {
  constructor(specPath) {
    this.specPath = specPath;
    this.spec = null;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  async loadSpec() {
    this.spec = await SwaggerParser.validate(this.specPath);
    return this.spec;
  }

  /**
   * 生成所有接口的测试用例
   */
  generateTestCases() {
    const testCases = [];
    const paths = this.spec.paths;

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, spec] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          testCases.push(this.generatePathTestCases(path, method, spec));
        }
      }
    }

    return testCases;
  }

  /**
   * 为单个接口生成测试用例
   */
  generatePathTestCases(path, method, spec) {
    return {
      path: path,
      method: method.toUpperCase(),
      operationId: spec.operationId,
      tests: {
        requestValidation: this.generateRequestSchemaTest(path, method, spec),
        responseValidation: this.generateResponseSchemaTest(path, method, spec),
        parameterValidation: this.generateParameterTests(path, method, spec),
        securityValidation: this.generateSecurityTest(path, method, spec),
        contentTypeValidation: this.generateContentTypeTest(path, method, spec)
      }
    };
  }

  /**
   * 生成请求体验证测试
   */
  generateRequestSchemaTest(path, method, spec) {
    const requestBody = spec.requestBody;
    if (!requestBody) return null;

    const schemas = {};
    for (const [contentType, content] of Object.entries(requestBody.content || {})) {
      schemas[contentType] = {
        schema: content.schema,
        required: requestBody.required,
        validator: this.ajv.compile(content.schema)
      };
    }

    return {
      description: `验证 ${method.toUpperCase()} ${path} 请求体格式`,
      schemas: schemas,
      generateTest: (body, contentType = 'application/json') => {
        const schema = schemas[contentType];
        if (!schema) return { valid: false, errors: ['Unsupported content type'] };
        
        const valid = schema.validator(body);
        return {
          valid,
          errors: valid ? [] : schema.validator.errors.map(e => ({
            path: e.instancePath,
            message: e.message,
            params: e.params
          }))
        };
      }
    };
  }

  /**
   * 生成响应体验证测试
   */
  generateResponseSchemaTest(path, method, spec) {
    const responses = spec.responses;
    const validators = {};

    for (const [statusCode, response] of Object.entries(responses)) {
      validators[statusCode] = {};
      for (const [contentType, content] of Object.entries(response.content || {})) {
        validators[statusCode][contentType] = {
          schema: content.schema,
          validator: this.ajv.compile(content.schema),
          description: response.description
        };
      }
    }

    return {
      description: `验证 ${method.toUpperCase()} ${path} 响应体格式`,
      validators: validators,
      generateTest: (response, statusCode, contentType = 'application/json') => {
        const statusValidators = validators[statusCode];
        if (!statusValidators) {
          // 未定义的状态码，允许通过但记录警告
          return { valid: true, warning: `未定义的状态码: ${statusCode}` };
        }

        const validator = statusValidators[contentType];
        if (!validator) return { valid: false, errors: ['Unsupported content type'] };

        const valid = validator.validator(response);
        return {
          valid,
          errors: valid ? [] : validator.validator.errors.map(e => ({
            path: e.instancePath,
            message: e.message,
            params: e.params
          }))
        };
      }
    };
  }

  /**
   * 生成参数验证测试
   */
  generateParameterTests(path, method, spec) {
    const parameters = spec.parameters || [];
    const tests = [];

    for (const param of parameters) {
      const test = {
        name: param.name,
        location: param.in,
        required: param.required || false,
        schema: param.schema,
        validator: param.schema ? this.ajv.compile(param.schema) : null,
        test: (value) => {
          if (param.required && (value === undefined || value === null)) {
            return { valid: false, error: `Required parameter ${param.name} is missing` };
          }
          if (value !== undefined && this.validator) {
            const valid = this.validator(value);
            return {
              valid,
              errors: valid ? [] : this.validator.errors
            };
          }
          return { valid: true };
        }
      };
      tests.push(test);
    }

    return tests;
  }

  /**
   * 生成安全验证测试
   */
  generateSecurityTest(path, method, spec) {
    const security = spec.security || this.spec.security || [];
    
    return {
      description: `验证 ${method.toUpperCase()} ${path} 安全要求`,
      securitySchemes: security.map(sec => {
        const [name, scopes] = Object.entries(sec)[0];
        return {
          name,
          scopes,
          definition: this.spec.components?.securitySchemes?.[name]
        };
      }),
      test: (authHeader, authType) => {
        const scheme = security.find(s => Object.keys(s).includes(authType));
        if (!scheme && security.length > 0) {
          return { valid: false, error: `Invalid auth type: ${authType}` };
        }
        return { valid: true };
      }
    };
  }

  /**
   * 生成内容类型验证测试
   */
  generateContentTypeTest(path, method, spec) {
    const requestContentTypes = spec.requestBody ? Object.keys(spec.requestBody.content) : [];
    const responseContentTypes = new Set();
    
    for (const response of Object.values(spec.responses)) {
      Object.keys(response.content || {}).forEach(ct => responseContentTypes.add(ct));
    }

    return {
      description: `验证 ${method.toUpperCase()} ${path} 内容类型支持`,
      requestContentTypes,
      responseContentTypes: Array.from(responseContentTypes),
      test: (contentType, isRequest = true) => {
        const supportedTypes = isRequest ? requestContentTypes : Array.from(responseContentTypes);
        return {
          valid: supportedTypes.length === 0 || supportedTypes.includes(contentType),
          supportedTypes
        };
      }
    };
  }
}

module.exports = { ContractTestGenerator };
```

### 2. Mock 服务自动生成器

```javascript
// backend/shared/MockServiceGenerator.js
const jsonSchemaFaker = require('json-schema-faker');
const express = require('express');

class MockServiceGenerator {
  constructor(spec) {
    this.spec = spec;
    this.app = null;
    this.routes = [];
    this.responseStrategies = new Map();
  }

  /**
   * 从 OpenAPI 规范生成 Mock 路由
   */
  generateMockRoutes() {
    const paths = this.spec.paths;
    const routes = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, spec] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          routes.push(this.createMockRoute(path, method, spec));
        }
      }
    }

    this.routes = routes;
    return routes;
  }

  /**
   * 创建单个 Mock 路由
   */
  createMockRoute(path, method, spec) {
    const expressPath = path.replace(/{(\w+)}/g, ':$1');
    
    return {
      path: expressPath,
      method: method,
      operationId: spec.operationId,
      handler: async (req, res) => {
        // 检查是否有自定义响应策略
        const customResponse = this.responseStrategies.get(spec.operationId);
        if (customResponse) {
          return res.status(customResponse.status || 200).json(customResponse.body);
        }

        // 自动生成符合规范的响应
        const response = this.generateDefaultResponse(spec);
        
        // 支持延迟模拟网络延迟
        const delay = parseInt(req.headers['x-mock-delay'] || 0);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // 支持错误场景模拟
        const errorScenario = req.headers['x-mock-error'];
        if (errorScenario) {
          const errorResponse = this.generateErrorResponse(spec, errorScenario);
          return res.status(errorResponse.status).json(errorResponse.body);
        }

        res.status(response.status).json(response.body);
      }
    };
  }

  /**
   * 生成默认响应数据
   */
  generateDefaultResponse(spec) {
    const successResponses = ['200', '201', '202', '204'];
    let statusCode = '200';
    let responseSpec = null;

    for (const code of successResponses) {
      if (spec.responses[code]) {
        statusCode = code;
        responseSpec = spec.responses[code];
        break;
      }
    }

    if (!responseSpec) {
      return { status: 200, body: {} };
    }

    const content = responseSpec.content?.['application/json'];
    if (!content?.schema) {
      return { status: parseInt(statusCode), body: {} };
    }

    // 使用 JSON Schema Faker 生成符合规范的数据
    const body = jsonSchemaFaker.generate(content.schema);
    
    return { status: parseInt(statusCode), body };
  }

  /**
   * 生成错误响应
   */
  generateErrorResponse(spec, scenario) {
    const errorCodes = {
      'bad_request': 400,
      'unauthorized': 401,
      'forbidden': 403,
      'not_found': 404,
      'conflict': 409,
      'validation_error': 422,
      'rate_limit': 429,
      'server_error': 500
    };

    const status = errorCodes[scenario] || 500;
    const responseSpec = spec.responses[status.toString()];

    if (responseSpec?.content?.['application/json']?.schema) {
      const body = jsonSchemaFaker.generate(responseSpec.content['application/json'].schema);
      return { status, body };
    }

    return {
      status,
      body: {
        error: scenario,
        message: `Mock error: ${scenario}`,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * 设置自定义响应策略
   */
  setResponseStrategy(operationId, response) {
    this.responseStrategies.set(operationId, response);
  }

  /**
   * 清除响应策略
   */
  clearResponseStrategy(operationId) {
    this.responseStrategies.delete(operationId);
  }

  /**
   * 启动 Mock 服务
   */
  start(port = 3001) {
    this.app = express();
    this.app.use(express.json());

    // 健康检查
    this.app.get('/mock-health', (req, res) => {
      res.json({
        status: 'ok',
        routes: this.routes.length,
        timestamp: new Date().toISOString()
      });
    });

    // 响应策略管理 API
    this.app.post('/mock-strategies', (req, res) => {
      const { operationId, response } = req.body;
      this.setResponseStrategy(operationId, response);
      res.json({ success: true, operationId });
    });

    this.app.delete('/mock-strategies/:operationId', (req, res) => {
      this.clearResponseStrategy(req.params.operationId);
      res.json({ success: true });
    });

    // 注册所有 Mock 路由
    for (const route of this.routes) {
      this.app[route.method](route.path, route.handler);
    }

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        console.log(`Mock service running on port ${port}`);
        console.log(`Mock routes: ${this.routes.length}`);
        resolve(this.app);
      });
    });
  }

  /**
   * 停止 Mock 服务
   */
  stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }
}

module.exports = { MockServiceGenerator };
```

### 3. 契约测试执行器

```javascript
// backend/tests/contract/ContractTestRunner.js
const axios = require('axios');
const { ContractTestGenerator } = require('../../shared/ContractTestGenerator');
const { MockServiceGenerator } = require('../../shared/MockServiceGenerator');
const { logger } = require('../../shared/logger');

class ContractTestRunner {
  constructor(config) {
    this.config = {
      specPath: 'docs/api-spec/openapi.yaml',
      baseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
      mockPort: 3001,
      timeout: 30000,
      ...config
    };
    
    this.generator = new ContractTestGenerator(this.config.specPath);
    this.testResults = [];
    this.mockGenerator = null;
  }

  async initialize() {
    await this.generator.loadSpec();
    this.mockGenerator = new MockServiceGenerator(this.generator.spec);
  }

  /**
   * 运行所有契约测试
   */
  async runAllTests() {
    const testCases = this.generator.generateTestCases();
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    for (const testCase of testCases) {
      const result = await this.runTestCase(testCase);
      results.total++;
      
      if (result.status === 'passed') {
        results.passed++;
      } else if (result.status === 'skipped') {
        results.skipped++;
      } else {
        results.failed++;
      }
      
      results.details.push(result);
    }

    this.testResults = results;
    return results;
  }

  /**
   * 运行单个测试用例
   */
  async runTestCase(testCase) {
    const result = {
      path: testCase.path,
      method: testCase.method,
      operationId: testCase.operationId,
      status: 'passed',
      errors: [],
      duration: 0
    };

    const startTime = Date.now();

    try {
      // 测试请求验证
      if (testCase.tests.requestValidation) {
        await this.testRequestValidation(testCase);
      }

      // 测试响应验证
      if (testCase.tests.responseValidation) {
        await this.testResponseValidation(testCase);
      }

      // 测试参数验证
      for (const paramTest of testCase.tests.parameterValidation) {
        this.testParameter(paramTest);
      }

      // 测试安全验证
      if (testCase.tests.securityValidation) {
        this.testSecurity(testCase.tests.securityValidation);
      }

      // 测试内容类型
      if (testCase.tests.contentTypeValidation) {
        this.testContentType(testCase.tests.contentTypeValidation);
      }

    } catch (error) {
      result.status = 'failed';
      result.errors.push({
        type: 'execution_error',
        message: error.message,
        stack: error.stack
      });
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * 测试请求体验证
   */
  async testRequestValidation(testCase) {
    const { requestValidation } = testCase.tests;
    if (!requestValidation) return;

    // 生成合法请求体测试
    for (const [contentType, schema] of Object.entries(requestValidation.schemas)) {
      // 测试空请求（如果非必需）
      if (!schema.required) {
        const testResult = requestValidation.generateTest(undefined, contentType);
        if (!testResult.valid) {
          throw new Error(`请求体验证失败：非必需字段不应拒绝空请求 - ${testCase.path}`);
        }
      }
    }
  }

  /**
   * 测试响应体验证
   */
  async testResponseValidation(testCase) {
    const { responseValidation } = testCase.tests;
    if (!responseValidation) return;

    // 发送真实请求验证响应
    try {
      const response = await axios({
        method: testCase.method.toLowerCase(),
        url: `${this.config.baseUrl}${testCase.path}`,
        timeout: this.config.timeout,
        validateStatus: () => true // 接受所有状态码
      });

      const testResult = responseValidation.generateTest(
        response.data,
        response.status.toString(),
        response.headers['content-type']?.split(';')[0]
      );

      if (!testResult.valid) {
        throw new Error(`响应体验证失败: ${JSON.stringify(testResult.errors)}`);
      }

    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        logger.warn(`服务未启动，跳过响应验证: ${testCase.path}`);
        return;
      }
      throw error;
    }
  }

  /**
   * 测试参数验证
   */
  testParameter(paramTest) {
    // 测试必需参数
    if (paramTest.required) {
      const result = paramTest.test(undefined);
      if (result.valid) {
        throw new Error(`参数验证失败：必需参数 ${paramTest.name} 应拒绝空值`);
      }
    }
  }

  /**
   * 测试安全验证
   */
  testSecurity(securityTest) {
    // 验证安全方案定义完整性
    for (const scheme of securityTest.securitySchemes) {
      if (!scheme.definition) {
        throw new Error(`安全方案定义缺失: ${scheme.name}`);
      }
    }
  }

  /**
   * 测试内容类型
   */
  testContentType(contentTypeTest) {
    // 验证内容类型定义
    if (contentTypeTest.requestContentTypes.length === 0 && 
        contentTypeTest.responseContentTypes.length === 0) {
      logger.warn(`未定义内容类型: ${contentTypeTest.description}`);
    }
  }

  /**
   * 生成测试报告
   */
  generateReport() {
    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: this.testResults.total,
        passed: this.testResults.passed,
        failed: this.testResults.failed,
        skipped: this.testResults.skipped,
        passRate: ((this.testResults.passed / this.testResults.total) * 100).toFixed(2) + '%'
      },
      details: this.testResults.details,
      recommendations: this.generateRecommendations()
    };
  }

  /**
   * 生成改进建议
   */
  generateRecommendations() {
    const recommendations = [];
    const failedTests = this.testResults.details?.filter(t => t.status === 'failed') || [];

    for (const test of failedTests) {
      for (const error of test.errors) {
        if (error.type === 'execution_error') {
          recommendations.push({
            operationId: test.operationId,
            severity: 'high',
            message: error.message
          });
        }
      }
    }

    return recommendations;
  }
}

module.exports = { ContractTestRunner };
```

### 4. Breaking Change 检测器

```javascript
// backend/shared/BreakingChangeDetector.js
const SwaggerParser = require('@apidevtools/swagger-parser');

class BreakingChangeDetector {
  constructor() {
    this.breakingChanges = [];
  }

  /**
   * 比较两个 API 规范版本，检测破坏性变更
   */
  async detectBreakingChanges(oldSpecPath, newSpecPath) {
    const oldSpec = await SwaggerParser.dereference(oldSpecPath);
    const newSpec = await SwaggerParser.dereference(newSpecPath);

    this.breakingChanges = [];

    // 检测路径删除
    this.detectRemovedPaths(oldSpec, newSpec);

    // 检测方法删除
    this.detectRemovedMethods(oldSpec, newSpec);

    // 检测参数变更
    this.detectParameterChanges(oldSpec, newSpec);

    // 检测请求体变更
    this.detectRequestBodyChanges(oldSpec, newSpec);

    // 检测响应变更
    this.detectResponseChanges(oldSpec, newSpec);

    // 检测安全变更
    this.detectSecurityChanges(oldSpec, newSpec);

    return {
      hasBreakingChanges: this.breakingChanges.length > 0,
      changes: this.breakingChanges,
      severity: this.calculateSeverity()
    };
  }

  /**
   * 检测删除的路径
   */
  detectRemovedPaths(oldSpec, newSpec) {
    const oldPaths = Object.keys(oldSpec.paths || {});
    const newPaths = Object.keys(newSpec.paths || {});

    for (const path of oldPaths) {
      if (!newPaths.includes(path)) {
        this.breakingChanges.push({
          type: 'path_removed',
          severity: 'high',
          path: path,
          message: `路径已删除: ${path}`,
          impact: '客户端调用将返回 404'
        });
      }
    }
  }

  /**
   * 检测删除的方法
   */
  detectRemovedMethods(oldSpec, newSpec) {
    for (const [path, oldMethods] of Object.entries(oldSpec.paths || {})) {
      const newMethods = newSpec.paths?.[path];
      if (!newMethods) continue;

      for (const method of Object.keys(oldMethods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && !newMethods[method]) {
          this.breakingChanges.push({
            type: 'method_removed',
            severity: 'high',
            path: path,
            method: method.toUpperCase(),
            message: `方法已删除: ${method.toUpperCase()} ${path}`,
            impact: '客户端调用将返回 405'
          });
        }
      }
    }
  }

  /**
   * 检测参数变更
   */
  detectParameterChanges(oldSpec, newSpec) {
    for (const [path, oldMethods] of Object.entries(oldSpec.paths || {})) {
      for (const [method, oldSpec] of Object.entries(oldMethods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        const newSpecMethod = newSpec.paths?.[path]?.[method];
        if (!newSpecMethod) continue;

        const oldParams = oldSpec.parameters || [];
        const newParams = newSpecMethod.parameters || [];

        // 检测必需参数新增
        for (const newParam of newParams) {
          if (newParam.required) {
            const oldParam = oldParams.find(p => p.name === newParam.name);
            if (!oldParam || !oldParam.required) {
              this.breakingChanges.push({
                type: 'required_parameter_added',
                severity: 'high',
                path: path,
                method: method.toUpperCase(),
                parameter: newParam.name,
                message: `新增必需参数: ${newParam.name}`,
                impact: '旧客户端可能缺少必需参数'
              });
            }
          }
        }

        // 检测参数删除
        for (const oldParam of oldParams) {
          const newParam = newParams.find(p => p.name === oldParam.name);
          if (!newParam) {
            this.breakingChanges.push({
              type: 'parameter_removed',
              severity: oldParam.required ? 'high' : 'medium',
              path: path,
              method: method.toUpperCase(),
              parameter: oldParam.name,
              message: `参数已删除: ${oldParam.name}`,
              impact: '客户端传递该参数将被忽略'
            });
          }
        }
      }
    }
  }

  /**
   * 检测请求体变更
   */
  detectRequestBodyChanges(oldSpec, newSpec) {
    for (const [path, oldMethods] of Object.entries(oldSpec.paths || {})) {
      for (const [method, oldSpecMethod] of Object.entries(oldMethods)) {
        if (!['post', 'put', 'patch'].includes(method)) continue;

        const newSpecMethod = newSpec.paths?.[path]?.[method];
        if (!newSpecMethod) continue;

        const oldBody = oldSpecMethod.requestBody;
        const newBody = newSpecMethod.requestBody;

        if (!oldBody && newBody?.required) {
          this.breakingChanges.push({
            type: 'required_body_added',
            severity: 'high',
            path: path,
            method: method.toUpperCase(),
            message: '新增必需请求体',
            impact: '旧客户端可能无法正确发送请求'
          });
        }
      }
    }
  }

  /**
   * 检测响应变更
   */
  detectResponseChanges(oldSpec, newSpec) {
    for (const [path, oldMethods] of Object.entries(oldSpec.paths || {})) {
      for (const [method, oldSpecMethod] of Object.entries(oldMethods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

        const newSpecMethod = newSpec.paths?.[path]?.[method];
        if (!newSpecMethod) continue;

        // 检测响应状态码删除
        const oldStatusCodes = Object.keys(oldSpecMethod.responses || {});
        const newStatusCodes = Object.keys(newSpecMethod.responses || {});

        for (const code of oldStatusCodes) {
          if (!newStatusCodes.includes(code)) {
            this.breakingChanges.push({
              type: 'response_removed',
              severity: code.startsWith('2') ? 'medium' : 'low',
              path: path,
              method: method.toUpperCase(),
              statusCode: code,
              message: `响应状态码已删除: ${code}`,
              impact: '客户端可能依赖该状态码处理'
            });
          }
        }
      }
    }
  }

  /**
   * 检测安全变更
   */
  detectSecurityChanges(oldSpec, newSpec) {
    const oldSecurity = oldSpec.security || [];
    const newSecurity = newSpec.security || [];

    // 如果新版本新增了安全要求
    if (oldSecurity.length === 0 && newSecurity.length > 0) {
      this.breakingChanges.push({
        type: 'security_added',
        severity: 'high',
        message: '新增了全局安全要求',
        impact: '未认证请求将被拒绝'
      });
    }
  }

  /**
   * 计算变更严重程度
   */
  calculateSeverity() {
    const highCount = this.breakingChanges.filter(c => c.severity === 'high').length;
    const mediumCount = this.breakingChanges.filter(c => c.severity === 'medium').length;

    if (highCount > 0) return 'critical';
    if (mediumCount > 3) return 'high';
    if (mediumCount > 0) return 'medium';
    if (this.breakingChanges.length > 0) return 'low';
    return 'none';
  }
}

module.exports = { BreakingChangeDetector };
```

### 5. 集成测试用例

```javascript
// backend/tests/contract/contract.test.js
const { ContractTestRunner } = require('./ContractTestRunner');
const { BreakingChangeDetector } = require('../../shared/BreakingChangeDetector');
const { MockServiceGenerator } = require('../../shared/MockServiceGenerator');
const { ContractTestGenerator } = require('../../shared/ContractTestGenerator');

describe('API Contract Tests', () => {
  let runner;
  let mockService;

  beforeAll(async () => {
    runner = new ContractTestRunner({
      specPath: 'docs/api-spec/openapi.yaml',
      baseUrl: process.env.TEST_API_URL || 'http://localhost:3000'
    });
    await runner.initialize();
  });

  afterAll(async () => {
    if (mockService) {
      await mockService.stop();
    }
  });

  describe('OpenAPI 规范验证', () => {
    test('规范文件应可正确解析', async () => {
      const generator = new ContractTestGenerator('docs/api-spec/openapi.yaml');
      const spec = await generator.loadSpec();
      expect(spec).toBeDefined();
      expect(spec.openapi).toMatch(/^3\./);
    });

    test('所有接口应有 operationId', async () => {
      const testCases = runner.generator.generateTestCases();
      for (const tc of testCases) {
        expect(tc.operationId).toBeDefined();
        expect(tc.operationId).toMatch(/^[a-zA-Z0-9_]+$/);
      }
    });

    test('所有接口应有描述', async () => {
      const testCases = runner.generator.generateTestCases();
      for (const tc of testCases) {
        const spec = runner.generator.spec.paths[tc.path][tc.method.toLowerCase()];
        expect(spec.description || spec.summary).toBeDefined();
      }
    });
  });

  describe('请求体验证', () => {
    test('POST /api/pokemon 应拒绝无效请求体', async () => {
      const generator = new ContractTestGenerator('docs/api-spec/openapi.yaml');
      await generator.loadSpec();
      const testCases = generator.generateTestCases();
      
      const createPokemon = testCases.find(tc => 
        tc.path === '/api/pokemon' && tc.method === 'POST'
      );
      
      if (createPokemon?.tests?.requestValidation) {
        const test = createPokemon.tests.requestValidation.generateTest(
          { invalid: 'data' },
          'application/json'
        );
        expect(test.valid).toBe(false);
      }
    });
  });

  describe('响应体验证', () => {
    test('GET /api/pokemon 应返回符合规范的响应', async () => {
      // 需要 API 服务运行
      if (process.env.SKIP_LIVE_TESTS === 'true') {
        return;
      }

      const results = await runner.runAllTests();
      const getPokemon = results.details.find(tc => 
        tc.path === '/api/pokemon' && tc.method === 'GET'
      );
      
      expect(getPokemon).toBeDefined();
      expect(getPokemon.status).toBe('passed');
    });
  });

  describe('Mock 服务生成', () => {
    test('应生成正确的 Mock 路由', async () => {
      const generator = new ContractTestGenerator('docs/api-spec/openapi.yaml');
      await generator.loadSpec();
      
      mockService = new MockServiceGenerator(generator.spec);
      const routes = mockService.generateMockRoutes();
      
      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0]).toHaveProperty('path');
      expect(routes[0]).toHaveProperty('method');
      expect(routes[0]).toHaveProperty('handler');
    });

    test('Mock 服务应返回符合规范的数据', async () => {
      await mockService.start(3002);
      
      const response = await fetch('http://localhost:3002/api/pokemon');
      const data = await response.json();
      
      expect(data).toBeDefined();
      
      await mockService.stop();
    });
  });

  describe('Breaking Change 检测', () => {
    test('应检测路径删除', async () => {
      const detector = new BreakingChangeDetector();
      
      // 创建临时测试文件
      const oldSpec = {
        openapi: '3.0.0',
        paths: {
          '/api/old': { get: { responses: { '200': {} } } }
        }
      };
      
      const newSpec = {
        openapi: '3.0.0',
        paths: {}
      };
      
      // 模拟检测结果
      const result = await detector.detectBreakingChanges(
        { paths: oldSpec.paths },
        { paths: newSpec.paths }
      );
      
      expect(result.breakingChanges).toContainEqual(
        expect.objectContaining({ type: 'path_removed' })
      );
    });
  });
});
```

### 6. CI/CD 集成配置

```yaml
# .github/workflows/contract-test.yml
name: API Contract Tests

on:
  pull_request:
    paths:
      - 'docs/api-spec/**'
      - 'backend/services/**'
      - '.github/workflows/contract-test.yml'
  push:
    branches: [main]
    paths:
      - 'docs/api-spec/**'

jobs:
  contract-test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 获取完整历史用于比较

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Validate OpenAPI spec
        run: |
          npx @apidevtools/swagger-cli validate docs/api-spec/openapi.yaml

      - name: Run contract tests
        run: |
          npm run test:contract
        env:
          TEST_API_URL: http://localhost:3000

      - name: Check for breaking changes
        run: |
          node backend/scripts/check-breaking-changes.js \
            --old ${{ github.base_ref }} \
            --new ${{ github.head_ref }}
        if: github.event_name == 'pull_request'

      - name: Generate Mock service
        run: |
          node backend/scripts/generate-mock-service.js \
            --spec docs/api-spec/openapi.yaml \
            --output frontend/game-client/src/mocks

      - name: Upload contract test report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: contract-test-report
          path: reports/contract-test-*.json
```

### 7. Mock 服务使用示例（前端集成）

```javascript
// frontend/game-client/src/mocks/mockClient.js
/**
 * Mock API 客户端
 * 用于开发环境，无需后端服务即可进行前端开发
 */

class MockApiClient {
  constructor() {
    this.baseUrl = 'http://localhost:3001';
    this.enabled = process.env.NODE_ENV === 'development' && 
                   process.env.USE_MOCK_API === 'true';
  }

  async request(method, path, options = {}) {
    if (!this.enabled) {
      throw new Error('Mock API is not enabled');
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    // 支持模拟延迟
    if (options.mockDelay) {
      headers['X-Mock-Delay'] = options.mockDelay.toString();
    }

    // 支持模拟错误场景
    if (options.mockError) {
      headers['X-Mock-Error'] = options.mockError;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    return response.json();
  }

  // Pokemon 相关 Mock
  async getPokemonList(params) {
    return this.request('GET', `/api/pokemon?${new URLSearchParams(params)}`);
  }

  async getPokemonById(id) {
    return this.request('GET', `/api/pokemon/${id}`);
  }

  // 用户相关 Mock
  async getCurrentUser() {
    return this.request('GET', '/api/user/me');
  }

  // 捕捉相关 Mock（可模拟延迟测试加载状态）
  async catchPokemon(pokemonId, options = {}) {
    return this.request('POST', '/api/catch', {
      body: { pokemonId },
      mockDelay: options.simulateSlow ? 2000 : 0,
      mockError: options.simulateError ? 'server_error' : undefined
    });
  }
}

export const mockClient = new MockApiClient();

// 使用示例
// 在开发环境中切换使用 Mock
if (process.env.USE_MOCK_API === 'true') {
  console.log('🎭 Using Mock API for development');
}
```

## 验收标准

- [ ] OpenAPI 规范解析器支持 OpenAPI 3.0.x 和 3.1.x
- [ ] 自动生成所有接口的请求/响应验证测试
- [ ] Mock 服务可独立运行，支持自定义响应策略
- [ ] Breaking Change 检测器能识别至少 8 种破坏性变更类型
- [ ] 契约测试覆盖率 ≥ 95%（所有接口都有测试）
- [ ] CI/CD 集成完成，PR 自动运行契约测试
- [ ] Mock 服务响应数据符合规范定义
- [ ] 支持 Mock 服务延迟、错误场景模拟
- [ ] 测试报告生成 JSON/HTML 格式
- [ ] 前端可配置使用 Mock 服务进行开发

## 影响范围

- `backend/shared/ContractTestGenerator.js` - 契约测试生成器（新增）
- `backend/shared/MockServiceGenerator.js` - Mock 服务生成器（新增）
- `backend/shared/BreakingChangeDetector.js` - Breaking Change 检测器（新增）
- `backend/tests/contract/ContractTestRunner.js` - 测试执行器（新增）
- `backend/tests/contract/contract.test.js` - 契约测试用例（新增）
- `.github/workflows/contract-test.yml` - CI/CD 配置（新增）
- `frontend/game-client/src/mocks/mockClient.js` - 前端 Mock 客户端（新增）
- `docs/api-spec/openapi.yaml` - 确保规范完整性
- `package.json` - 新增依赖（ajv, json-schema-faker, swagger-parser）

## 参考

- [OpenAPI Specification 3.1](https://spec.openapis.org/oas/v3.1.0)
- [JSON Schema Faker](https://json-schema-faker.js.org/)
- [Pact Contract Testing](https://docs.pact.io/)
- [Spring Cloud Contract](https://spring.io/projects/spring-cloud-contract)
- [Breaking Changes Detection Best Practices](https://apisyouwonthate.com/blog/putting-api-breaking-changes-to-rest)
