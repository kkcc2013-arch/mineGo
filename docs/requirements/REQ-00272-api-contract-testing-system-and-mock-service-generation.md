# REQ-00272: API 契约测试系统与自动化 Mock 服务生成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00272 |
| 标题 | API 契约测试系统与自动化 Mock 服务生成 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/tests/contract、docs/api-spec |
| 创建时间 | 2026-06-18 23:00 |

## 需求描述

### 背景
当前项目已有 50+ 个单元测试文件，但缺乏系统化的 API 契约测试机制。随着微服务数量增长和 API 版本迭代，需要确保：
1. API 实现与 OpenAPI 规范的一致性
2. 前后端接口契约的自动验证
3. Breaking Change 的早期检测
4. Mock 服务自动化生成，加速前端开发

### 目标
- 实现 API 契约测试框架，自动验证所有 API 端点
- 生成 Mock 服务，支持前端独立开发和测试
- 集成到 CI/CD 流水线，每次 PR 自动检测 Breaking Change
- 提供契约测试覆盖率报告

## 技术方案

### 1. 契约测试框架架构

#### 1.1 OpenAPI 规范目录结构
```
docs/api-spec/
├── openapi/
│   ├── base.yaml                  # 基础配置
│   ├── components/                # 可复用组件
│   │   ├── schemas/              # 数据模型定义
│   │   │   ├── Pokemon.yaml
│   │   │   ├── User.yaml
│   │   │   ├── Trade.yaml
│   │   │   ├── Battle.yaml
│   │   │   └── Error.yaml
│   │   ├── parameters/           # 公共参数
│   │   │   ├── Pagination.yaml
│   │   │   ├── UserId.yaml
│   │   │   └── PokemonId.yaml
│   │   └── responses/            # 公共响应
│   │       ├── Success.yaml
│   │       ├── Error.yaml
│   │       └── ValidationError.yaml
│   └── paths/                    # API 路径定义
│       ├── pokemon/
│       │   ├── list.yaml
│       │   ├── detail.yaml
│       │   ├── catch.yaml
│       │   └── release.yaml
│       ├── user/
│       │   ├── profile.yaml
│       │   ├── friends.yaml
│       │   └── settings.yaml
│       ├── trade/
│       │   ├── request.yaml
│       │   ├── confirm.yaml
│       │   └── history.yaml
│       └── battle/
│           ├── gym.yaml
│           └── pvp.yaml
├── generated/
│   └── openapi.yaml              # 合并后的完整规范
└── contracts/                    # 契约测试用例
    ├── pokemon.contracts.yaml
    ├── user.contracts.yaml
    └── trade.contracts.yaml
```

#### 1.2 契约测试运行器
```javascript
// backend/tests/contract/ContractTestRunner.js
const SwaggerParser = require('@apidevtools/swagger-parser');
const { PactV3, PactV3Options, SpecificationVersion } = require('@pact-foundation/pact');
const axios = require('axios');
const chalk = require('chalk');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('contract-test-runner');

class ContractTestRunner {
  constructor(config = {}) {
    this.config = {
      openapiPath: config.openapiPath || 'docs/api-spec/generated/openapi.yaml',
      baseUrl: config.baseUrl || process.env.API_BASE_URL || 'http://localhost:3000',
      timeout: config.timeout || 30000,
      ...config
    };
    
    this.openapiSpec = null;
    this.results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
  }

  /**
   * 加载并验证 OpenAPI 规范
   */
  async loadOpenAPISpec() {
    try {
      logger.info({ path: this.config.openapiPath }, 'Loading OpenAPI specification');
      
      this.openapiSpec = await SwaggerParser.validate(this.config.openapiPath);
      
      logger.info({
        title: this.openapiSpec.info.title,
        version: this.openapiSpec.info.version,
        pathCount: Object.keys(this.openapiSpec.paths).length
      }, 'OpenAPI spec loaded and validated');
      
      return this.openapiSpec;
    } catch (err) {
      logger.error({ err }, 'Failed to load OpenAPI spec');
      throw new Error(`OpenAPI 规范加载失败: ${err.message}`);
    }
  }

  /**
   * 生成契约测试用例
   */
  generateContractTests() {
    const tests = [];
    const paths = this.openapiSpec.paths;
    
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          const test = {
            path,
            method: method.toUpperCase(),
            operationId: operation.operationId || `${method}-${path}`,
            summary: operation.summary || '',
            parameters: operation.parameters || [],
            requestBody: operation.requestBody,
            responses: operation.responses,
            security: operation.security || this.openapiSpec.security,
            tags: operation.tags || []
          };
          
          // 为每个成功响应生成测试
          for (const [statusCode, response] of Object.entries(operation.responses)) {
            if (statusCode.startsWith('2')) {
              tests.push({
                ...test,
                expectedStatus: parseInt(statusCode),
                expectedResponse: response,
                testType: 'success'
              });
            }
          }
          
          // 为错误响应生成测试
          for (const [statusCode, response] of Object.entries(operation.responses)) {
            if (statusCode.startsWith('4') || statusCode.startsWith('5')) {
              tests.push({
                ...test,
                expectedStatus: parseInt(statusCode),
                expectedResponse: response,
                testType: 'error'
              });
            }
          }
        }
      }
    }
    
    logger.info({ testCount: tests.length }, 'Generated contract tests');
    return tests;
  }

  /**
   * 验证请求参数契约
   */
  validateRequestContract(test, actualRequest) {
    const errors = [];
    
    for (const param of test.parameters) {
      const { name, required, schema } = param;
      const value = actualRequest[name];
      
      // 检查必填参数
      if (required && (value === undefined || value === null)) {
        errors.push({
          field: name,
          error: 'REQUIRED_FIELD_MISSING',
          message: `必填字段 '${name}' 缺失`
        });
        continue;
      }
      
      if (value !== undefined && schema) {
        // 类型检查
        const typeError = this.validateSchema(name, value, schema);
        if (typeError) {
          errors.push(typeError);
        }
      }
    }
    
    return errors;
  }

  /**
   * 验证响应契约
   */
  validateResponseContract(test, actualResponse) {
    const errors = [];
    
    // 状态码验证
    if (actualResponse.status !== test.expectedStatus) {
      errors.push({
        field: 'status',
        error: 'STATUS_MISMATCH',
        expected: test.expectedStatus,
        actual: actualResponse.status,
        message: `状态码不匹配: 期望 ${test.expectedStatus}, 实际 ${actualResponse.status}`
      });
    }
    
    // 响应体 Schema 验证
    if (test.expectedResponse.content) {
      const contentType = Object.keys(test.expectedResponse.content)[0];
      const responseSchema = test.expectedResponse.content[contentType].schema;
      
      if (responseSchema && actualResponse.data) {
        const schemaErrors = this.validateSchemaDeep('response', actualResponse.data, responseSchema);
        errors.push(...schemaErrors);
      }
    }
    
    return errors;
  }

  /**
   * Schema 深度验证
   */
  validateSchemaDeep(path, value, schema) {
    const errors = [];
    
    if (!schema) return errors;
    
    // 类型检查
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== schema.type) {
        errors.push({
          path,
          error: 'TYPE_MISMATCH',
          expected: schema.type,
          actual: actualType,
          message: `类型不匹配: 期望 ${schema.type}, 实际 ${actualType}`
        });
        return errors; // 类型错误时不再继续验证
      }
    }
    
    // 枚举值检查
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        path,
        error: 'ENUM_MISMATCH',
        expected: schema.enum,
        actual: value,
        message: `值不在枚举范围内: ${value}`
      });
    }
    
    // 必填字段检查
    if (schema.required && schema.type === 'object') {
      for (const requiredField of schema.required) {
        if (value[requiredField] === undefined) {
          errors.push({
            path: `${path}.${requiredField}`,
            error: 'REQUIRED_FIELD_MISSING',
            message: `必填字段 '${requiredField}' 缺失`
          });
        }
      }
    }
    
    // 属性检查
    if (schema.properties && schema.type === 'object') {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (value[propName] !== undefined) {
          const propErrors = this.validateSchemaDeep(`${path}.${propName}`, value[propName], propSchema);
          errors.push(...propErrors);
        }
      }
    }
    
    // 数组元素检查
    if (schema.items && schema.type === 'array') {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = this.validateSchemaDeep(`${path}[${i}]`, value[i], schema.items);
        errors.push(...itemErrors);
      }
      
      // 数组长度限制
      if (schema.minItems && value.length < schema.minItems) {
        errors.push({
          path,
          error: 'MIN_ITEMS_VIOLATION',
          expected: schema.minItems,
          actual: value.length
        });
      }
      
      if (schema.maxItems && value.length > schema.maxItems) {
        errors.push({
          path,
          error: 'MAX_ITEMS_VIOLATION',
          expected: schema.maxItems,
          actual: value.length
        });
      }
    }
    
    return errors;
  }

  /**
   * 执行单个契约测试
   */
  async runTest(test) {
    this.results.total++;
    
    const testResult = {
      operationId: test.operationId,
      path: test.path,
      method: test.method,
      expectedStatus: test.expectedStatus,
      testType: test.testType,
      duration: 0,
      status: 'pending',
      errors: []
    };
    
    const startTime = Date.now();
    
    try {
      // 构建请求
      const request = this.buildRequest(test);
      
      // 发送请求
      const response = await this.sendRequest(request);
      
      // 验证契约
      testResult.errors = this.validateResponseContract(test, response);
      
      if (testResult.errors.length === 0) {
        testResult.status = 'passed';
        this.results.passed++;
      } else {
        testResult.status = 'failed';
        this.results.failed++;
        this.results.errors.push(testResult);
      }
    } catch (err) {
      testResult.status = 'error';
      testResult.errors.push({
        error: 'TEST_EXECUTION_ERROR',
        message: err.message
      });
      this.results.failed++;
      this.results.errors.push(testResult);
    } finally {
      testResult.duration = Date.now() - startTime;
    }
    
    return testResult;
  }

  /**
   * 构建测试请求
   */
  buildRequest(test) {
    const request = {
      method: test.method,
      url: `${this.config.baseUrl}${test.path}`,
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true // 接受所有状态码
    };
    
    // 添加认证头
    if (test.security && test.testType === 'success') {
      request.headers['Authorization'] = `Bearer ${process.env.TEST_AUTH_TOKEN || 'test-token'}`;
    }
    
    // 添加请求体
    if (test.requestBody && test.testType === 'success') {
      const content = test.requestBody.content;
      if (content && content['application/json']) {
        request.data = this.generateMockData(content['application/json'].schema);
      }
    }
    
    // 路径参数替换
    if (test.path.includes('{')) {
      request.url = request.url.replace(/\{([^}]+)\}/g, (match, paramName) => {
        return process.env[`TEST_${paramName.toUpperCase()}`] || 'test-value';
      });
    }
    
    return request;
  }

  /**
   * 发送请求
   */
  async sendRequest(request) {
    return axios(request);
  }

  /**
   * 生成 Mock 数据
   */
  generateMockData(schema) {
    if (!schema) return null;
    
    if (schema.example) return schema.example;
    
    if (schema.default !== undefined) return schema.default;
    
    switch (schema.type) {
      case 'object':
        const obj = {};
        if (schema.properties) {
          for (const [prop, propSchema] of Object.entries(schema.properties)) {
            obj[prop] = this.generateMockData(propSchema);
          }
        }
        return obj;
        
      case 'array':
        if (schema.items) {
          const count = schema.minItems || 1;
          const arr = [];
          for (let i = 0; i < count; i++) {
            arr.push(this.generateMockData(schema.items));
          }
          return arr;
        }
        return [];
        
      case 'string':
        if (schema.enum) return schema.enum[0];
        if (schema.format === 'date') return '2026-06-18';
        if (schema.format === 'date-time') return '2026-06-18T23:00:00Z';
        if (schema.format === 'email') return 'test@example.com';
        if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000001';
        return 'test-string';
        
      case 'number':
      case 'integer':
        return schema.minimum || 1;
        
      case 'boolean':
        return false;
        
      default:
        return null;
    }
  }

  /**
   * 运行所有契约测试
   */
  async runAll() {
    console.log(chalk.blue('\n📋 API Contract Testing System\n'));
    
    // 加载规范
    await this.loadOpenAPISpec();
    
    // 生成测试
    const tests = this.generateContractTests();
    
    // 运行测试
    console.log(chalk.gray(`Running ${tests.length} contract tests...\n`));
    
    for (const test of tests) {
      const result = await this.runTest(test);
      
      // 实时输出
      const icon = result.status === 'passed' ? '✓' : '✗';
      const color = result.status === 'passed' ? 'green' : 'red';
      console.log(chalk[color](`${icon} ${result.operationId} (${result.duration}ms)`));
    }
    
    // 输出结果摘要
    this.printSummary();
    
    return this.results;
  }

  /**
   * 打印测试摘要
   */
  printSummary() {
    console.log(chalk.blue('\n' + '='.repeat(60)));
    console.log(chalk.blue.bold('Contract Test Summary'));
    console.log(chalk.blue('='.repeat(60)));
    
    console.log(`\nTotal Tests:  ${this.results.total}`);
    console.log(chalk.green(`Passed:       ${this.results.passed}`));
    console.log(chalk.red(`Failed:       ${this.results.failed}`));
    console.log(chalk.yellow(`Skipped:      ${this.results.skipped}`));
    
    const passRate = this.results.total > 0 
      ? ((this.results.passed / this.results.total) * 100).toFixed(1) 
      : 0;
    console.log(`\nPass Rate: ${passRate}%`);
    
    if (this.results.errors.length > 0) {
      console.log(chalk.red('\nFailed Tests:\n'));
      for (const error of this.results.errors) {
        console.log(chalk.red(`  ✗ ${error.operationId}`));
        for (const err of error.errors) {
          console.log(chalk.red(`    - ${err.message || err.error}`));
        }
      }
    }
    
    console.log(chalk.blue('\n' + '='.repeat(60) + '\n'));
  }
}

module.exports = ContractTestRunner;
```

### 2. Mock 服务生成器

#### 2.1 Mock 服务自动生成
```javascript
// backend/tests/contract/MockServiceGenerator.js
const SwaggerParser = require('@apidevtools/swagger-parser');
const express = require('express');
const cors = require('cors');
const { createLogger } = require('../../shared/logger');
const path = require('path');
const fs = require('fs').promises;

const logger = createLogger('mock-service-generator');

class MockServiceGenerator {
  constructor(config = {}) {
    this.config = {
      openapiPath: config.openapiPath || 'docs/api-spec/generated/openapi.yaml',
      port: config.port || 4000,
      enablePersistence: config.enablePersistence || false,
      dataDir: config.dataDir || 'backend/tests/contract/mock-data',
      ...config
    };
    
    this.openapiSpec = null;
    this.app = null;
    this.server = null;
    this.dataStore = {};
  }

  /**
   * 加载 OpenAPI 规范
   */
  async loadSpec() {
    this.openapiSpec = await SwaggerParser.validate(this.config.openapiPath);
    logger.info({ 
      title: this.openapiSpec.info.title,
      version: this.openapiSpec.info.version 
    }, 'OpenAPI spec loaded');
    return this.openapiSpec;
  }

  /**
   * 生成 Mock 数据
   */
  generateMockValue(schema) {
    if (!schema) return null;
    
    // 优先使用示例值
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    
    // 根据类型生成
    switch (schema.type) {
      case 'object':
        const obj = {};
        if (schema.properties) {
          for (const [key, propSchema] of Object.entries(schema.properties)) {
            obj[key] = this.generateMockValue(propSchema);
          }
        }
        return obj;
        
      case 'array':
        const count = schema.minItems || 2;
        const arr = [];
        for (let i = 0; i < count; i++) {
          arr.push(this.generateMockValue(schema.items));
        }
        return arr;
        
      case 'string':
        if (schema.enum) {
          return schema.enum[Math.floor(Math.random() * schema.enum.length)];
        }
        if (schema.format === 'date') return '2026-06-18';
        if (schema.format === 'date-time') return new Date().toISOString();
        if (schema.format === 'email') return 'mock@example.com';
        if (schema.format === 'uuid') return this.generateUUID();
        if (schema.pattern) return this.generateFromPattern(schema.pattern);
        const minLength = schema.minLength || 5;
        const maxLength = schema.maxLength || 20;
        return this.generateRandomString(minLength, maxLength);
        
      case 'number':
      case 'integer':
        const min = schema.minimum || 0;
        const max = schema.maximum || 100;
        const value = Math.floor(Math.random() * (max - min + 1)) + min;
        return schema.type === 'integer' ? value : value + Math.random();
        
      case 'boolean':
        return Math.random() > 0.5;
        
      default:
        return null;
    }
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  generateRandomString(min, max) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
    const length = Math.floor(Math.random() * (max - min + 1)) + min;
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  generateFromPattern(pattern) {
    // 简化实现，实际可使用库如 randexp
    return pattern.replace(/\[\w+\]/g, 'X').replace(/\{[0-9,]+\}/g, (match) => {
      const [min, max] = match.replace(/[{}]/g, '').split(',').map(Number);
      const len = max ? Math.floor(Math.random() * (max - min + 1)) + min : min;
      return 'X'.repeat(len);
    });
  }

  /**
   * 生成路由处理器
   */
  generateHandler(operation, path, method) {
    return (req, res, next) => {
      logger.debug({ path, method, operationId: operation.operationId }, 'Mock request received');
      
      // 获取响应定义
      const responses = operation.responses;
      
      // 默认使用 200 响应
      const statusCode = this.selectResponseCode(responses, req);
      const response = responses[statusCode];
      
      if (!response) {
        return res.status(500).json({ error: 'Mock response not defined' });
      }
      
      // 生成 Mock 数据
      let mockData = null;
      if (response.content && response.content['application/json']) {
        const schema = response.content['application/json'].schema;
        mockData = this.generateMockValue(schema);
        
        // 应用请求参数/路径参数到响应
        mockData = this.applyParameters(mockData, req, operation);
      }
      
      // 添加延迟模拟网络延迟
      const delay = parseInt(req.headers['x-mock-delay'] || 0);
      
      setTimeout(() => {
        res.status(parseInt(statusCode)).json(mockData);
      }, delay);
    };
  }

  /**
   * 选择响应状态码
   */
  selectResponseCode(responses, req) {
    const codes = Object.keys(responses);
    
    // 检查是否有特定错误模拟请求头
    const simulateError = req.headers['x-mock-error'];
    if (simulateError && codes.includes(simulateError)) {
      return simulateError;
    }
    
    // 优先返回 2xx 响应
    const successCodes = codes.filter(c => c.startsWith('2'));
    if (successCodes.length > 0) {
      return successCodes[Math.floor(Math.random() * successCodes.length)];
    }
    
    // 返回第一个定义的响应
    return codes[0];
  }

  /**
   * 应用请求参数到响应
   */
  applyParameters(data, req, operation) {
    if (typeof data !== 'object' || data === null) return data;
    
    // 替换路径参数
    if (req.params) {
      for (const [key, value] of Object.entries(req.params)) {
        data = this.replaceInObject(data, `{${key}}`, value);
      }
    }
    
    // 合并请求体
    if (req.body && operation.requestBody) {
      data = { ...data, ...req.body };
    }
    
    return data;
  }

  replaceInObject(obj, placeholder, value) {
    if (typeof obj === 'string') {
      return obj === placeholder ? value : obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceInObject(item, placeholder, value));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = this.replaceInObject(val, placeholder, value);
      }
      return result;
    }
    
    return obj;
  }

  /**
   * 生成 Express 应用
   */
  generateApp() {
    this.app = express();
    
    // 中间件
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // 日志中间件
    this.app.use((req, res, next) => {
      logger.info({ method: req.method, path: req.path }, 'Request');
      next();
    });
    
    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'mock-api', timestamp: new Date().toISOString() });
    });
    
    // 从 OpenAPI 规范生成路由
    const paths = this.openapiSpec.paths;
    
    for (const [path, pathItem] of Object.entries(paths)) {
      // 转换路径参数格式 {id} -> :id
      const expressPath = path.replace(/\{([^}]+)\}/g, ':$1');
      
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          const handler = this.generateHandler(operation, path, method);
          
          // 注册路由
          this.app[method](expressPath, handler);
          
          logger.debug({ method: method.toUpperCase(), path: expressPath }, 'Route registered');
        }
      }
    }
    
    // 错误处理
    this.app.use((err, req, res, next) => {
      logger.error({ err }, 'Mock server error');
      res.status(500).json({ error: err.message });
    });
    
    return this.app;
  }

  /**
   * 启动 Mock 服务
   */
  async start() {
    await this.loadSpec();
    this.generateApp();
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, () => {
        logger.info({ port: this.config.port }, 'Mock service started');
        console.log(`Mock API service running on http://localhost:${this.config.port}`);
        resolve(this.app);
      });
      
      this.server.on('error', reject);
    });
  }

  /**
   * 停止 Mock 服务
   */
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Mock service stopped');
          resolve();
        });
      });
    }
  }
}

module.exports = MockServiceGenerator;
```

### 3. Breaking Change 检测器

#### 3.1 API 版本对比工具
```javascript
// backend/tests/contract/BreakingChangeDetector.js
const SwaggerParser = require('@apidevtools/swagger-parser');
const diff = require('deep-diff');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('breaking-change-detector');

class BreakingChangeDetector {
  constructor() {
    this.breakingChanges = [];
    this.nonBreakingChanges = [];
    this.warnings = [];
  }

  /**
   * 对比两个 OpenAPI 规范
   */
  async compare(oldSpecPath, newSpecPath) {
    const oldSpec = await SwaggerParser.validate(oldSpecPath);
    const newSpec = await SwaggerParser.validate(newSpecPath);
    
    logger.info({ oldVersion: oldSpec.info.version, newVersion: newSpec.info.version }, 
      'Comparing API specifications');
    
    // 重置结果
    this.breakingChanges = [];
    this.nonBreakingChanges = [];
    this.warnings = [];
    
    // 对比路径
    this.comparePaths(oldSpec.paths, newSpec.paths);
    
    // 对比组件
    this.compareComponents(oldSpec.components, newSpec.components);
    
    // 对比安全定义
    this.compareSecurity(oldSpec.securityDefinitions, newSpec.securityDefinitions);
    
    return this.generateReport();
  }

  /**
   * 对比路径
   */
  comparePaths(oldPaths, newPaths) {
    if (!oldPaths || !newPaths) return;
    
    // 检查删除的路径
    for (const [path, pathItem] of Object.entries(oldPaths)) {
      if (!newPaths[path]) {
        this.breakingChanges.push({
          type: 'PATH_REMOVED',
          path,
          severity: 'high',
          message: `API 路径已删除: ${path}`
        });
        continue;
      }
      
      // 对比方法
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        
        if (!newPaths[path][method]) {
          this.breakingChanges.push({
            type: 'OPERATION_REMOVED',
            path,
            method: method.toUpperCase(),
            severity: 'high',
            message: `API 操作已删除: ${method.toUpperCase()} ${path}`
          });
          continue;
        }
        
        // 对比操作详情
        this.compareOperation(
          { path, method },
          operation,
          newPaths[path][method]
        );
      }
    }
    
    // 检查新增的路径（非破坏性）
    for (const path of Object.keys(newPaths)) {
      if (!oldPaths[path]) {
        this.nonBreakingChanges.push({
          type: 'PATH_ADDED',
          path,
          severity: 'info',
          message: `新增 API 路径: ${path}`
        });
      }
    }
  }

  /**
   * 对比操作
   */
  compareOperation(context, oldOp, newOp) {
    // 检查删除的操作 ID
    if (oldOp.operationId && !newOp.operationId) {
      this.breakingChanges.push({
        type: 'OPERATION_ID_REMOVED',
        ...context,
        severity: 'medium',
        message: `操作 ID 已删除: ${oldOp.operationId}`
      });
    }
    
    // 对比参数
    this.compareParameters(context, oldOp.parameters, newOp.parameters);
    
    // 对比请求体
    this.compareRequestBody(context, oldOp.requestBody, newOp.requestBody);
    
    // 对比响应
    this.compareResponses(context, oldOp.responses, newOp.responses);
  }

  /**
   * 对比参数
   */
  compareParameters(context, oldParams = [], newParams = []) {
    const oldParamMap = new Map(oldParams.map(p => [p.name, p]));
    const newParamMap = new Map(newParams.map(p => [p.name, p]));
    
    // 检查删除的参数
    for (const [name, param] of oldParamMap) {
      if (!newParamMap.has(name)) {
        this.breakingChanges.push({
          type: 'PARAMETER_REMOVED',
          ...context,
          parameter: name,
          severity: param.required ? 'high' : 'low',
          message: `参数已删除: ${name} ${param.required ? '(必填)' : '(可选)'}`
        });
        continue;
      }
      
      const newParam = newParamMap.get(name);
      
      // 检查参数必填性变化
      if (!param.required && newParam.required) {
        this.breakingChanges.push({
          type: 'PARAMETER_NOW_REQUIRED',
          ...context,
          parameter: name,
          severity: 'medium',
          message: `参数从可选变为必填: ${name}`
        });
      }
      
      // 检查类型变化
      if (param.schema && newParam.schema) {
        if (param.schema.type !== newParam.schema.type) {
          this.breakingChanges.push({
            type: 'PARAMETER_TYPE_CHANGED',
            ...context,
            parameter: name,
            oldType: param.schema.type,
            newType: newParam.schema.type,
            severity: 'high',
            message: `参数类型已改变: ${name} (${param.schema.type} -> ${newParam.schema.type})`
          });
        }
      }
    }
    
    // 检查新增参数
    for (const [name, param] of newParamMap) {
      if (!oldParamMap.has(name) && param.required) {
        this.breakingChanges.push({
          type: 'REQUIRED_PARAMETER_ADDED',
          ...context,
          parameter: name,
          severity: 'medium',
          message: `新增必填参数: ${name}`
        });
      }
    }
  }

  /**
   * 对比请求体
   */
  compareRequestBody(context, oldBody, newBody) {
    if (!oldBody && newBody) {
      if (newBody.required) {
        this.breakingChanges.push({
          type: 'REQUEST_BODY_ADDED_REQUIRED',
          ...context,
          severity: 'high',
          message: '新增必填请求体'
        });
      }
      return;
    }
    
    if (oldBody && !newBody) {
      this.breakingChanges.push({
        type: 'REQUEST_BODY_REMOVED',
        ...context,
        severity: 'medium',
        message: '请求体已删除'
      });
      return;
    }
    
    if (oldBody && newBody) {
      // 对比内容类型
      const oldContent = oldBody.content || {};
      const newContent = newBody.content || {};
      
      for (const [contentType, content] of Object.entries(oldContent)) {
        if (!newContent[contentType]) {
          this.breakingChanges.push({
            type: 'CONTENT_TYPE_REMOVED',
            ...context,
            contentType,
            severity: 'medium',
            message: `内容类型已删除: ${contentType}`
          });
        } else {
          // 对比 Schema
          this.compareSchemas(
            { ...context, contentType },
            content.schema,
            newContent[contentType].schema
          );
        }
      }
    }
  }

  /**
   * 对比响应
   */
  compareResponses(context, oldResponses = {}, newResponses = {}) {
    // 检查删除的响应码
    for (const [statusCode, response] of Object.entries(oldResponses)) {
      if (!newResponses[statusCode]) {
        this.breakingChanges.push({
          type: 'RESPONSE_REMOVED',
          ...context,
          statusCode,
          severity: statusCode.startsWith('2') ? 'high' : 'low',
          message: `响应码已删除: ${statusCode}`
        });
        continue;
      }
      
      // 对比响应内容
      const oldContent = response.content || {};
      const newContent = newResponses[statusCode].content || {};
      
      for (const [contentType, content] of Object.entries(oldContent)) {
        if (!newContent[contentType]) {
          this.breakingChanges.push({
            type: 'RESPONSE_CONTENT_TYPE_REMOVED',
            ...context,
            statusCode,
            contentType,
            severity: 'medium',
            message: `响应内容类型已删除: ${statusCode} ${contentType}`
          });
        } else {
          this.compareSchemas(
            { ...context, statusCode, contentType },
            content.schema,
            newContent[contentType].schema
          );
        }
      }
    }
  }

  /**
   * 对比 Schema
   */
  compareSchemas(context, oldSchema, newSchema) {
    if (!oldSchema || !newSchema) return;
    
    // 类型变化
    if (oldSchema.type !== newSchema.type) {
      this.breakingChanges.push({
        type: 'SCHEMA_TYPE_CHANGED',
        ...context,
        oldType: oldSchema.type,
        newType: newSchema.type,
        severity: 'high',
        message: `Schema 类型已改变: ${oldSchema.type} -> ${newSchema.type}`
      });
      return;
    }
    
    // 必填字段变化
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);
    
    // 新增必填字段
    for (const field of newRequired) {
      if (!oldRequired.has(field)) {
        this.breakingChanges.push({
          type: 'REQUIRED_FIELD_ADDED',
          ...context,
          field,
          severity: 'medium',
          message: `新增必填字段: ${field}`
        });
      }
    }
    
    // 删除字段
    if (oldSchema.properties) {
      for (const field of Object.keys(oldSchema.properties)) {
        if (!newSchema.properties || !newSchema.properties[field]) {
          this.breakingChanges.push({
            type: 'FIELD_REMOVED',
            ...context,
            field,
            severity: 'low',
            message: `字段已删除: ${field}`
          });
        }
      }
    }
  }

  /**
   * 对比组件
   */
  compareComponents(oldComponents = {}, newComponents = {}) {
    // 对比 Schemas
    if (oldComponents.schemas && newComponents.schemas) {
      for (const [name, schema] of Object.entries(oldComponents.schemas)) {
        if (!newComponents.schemas[name]) {
          this.breakingChanges.push({
            type: 'SCHEMA_COMPONENT_REMOVED',
            component: name,
            severity: 'high',
            message: `Schema 组件已删除: ${name}`
          });
        } else {
          this.compareSchemas(
            { component: name },
            schema,
            newComponents.schemas[name]
          );
        }
      }
    }
  }

  /**
   * 对比安全定义
   */
  compareSecurity(oldSec, newSec) {
    if (!oldSec || !newSec) return;
    
    for (const [name, definition] of Object.entries(oldSec)) {
      if (!newSec[name]) {
        this.breakingChanges.push({
          type: 'SECURITY_DEFINITION_REMOVED',
          name,
          severity: 'high',
          message: `安全定义已删除: ${name}`
        });
      }
    }
  }

  /**
   * 生成报告
   */
  generateReport() {
    const summary = {
      hasBreakingChanges: this.breakingChanges.length > 0,
      breakingChangeCount: this.breakingChanges.length,
      nonBreakingChangeCount: this.nonBreakingChanges.length,
      warningCount: this.warnings.length,
      severity: {
        high: this.breakingChanges.filter(c => c.severity === 'high').length,
        medium: this.breakingChanges.filter(c => c.severity === 'medium').length,
        low: this.breakingChanges.filter(c => c.severity === 'low').length
      }
    };
    
    logger.info(summary, 'Comparison complete');
    
    return {
      summary,
      breakingChanges: this.breakingChanges,
      nonBreakingChanges: this.nonBreakingChanges,
      warnings: this.warnings
    };
  }
}

module.exports = BreakingChangeDetector;
```

### 4. CI/CD 集成

#### 4.1 GitHub Actions 工作流
```yaml
# .github/workflows/contract-tests.yml
name: API Contract Tests

on:
  pull_request:
    branches: [main, develop]
    paths:
      - 'docs/api-spec/**'
      - 'backend/services/**'
      - 'backend/gateway/**'
  push:
    branches: [main]

jobs:
  contract-tests:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 获取完整历史用于对比
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Generate OpenAPI spec
        run: npm run api:spec:generate
      
      - name: Validate OpenAPI spec
        run: npm run api:spec:validate
      
      - name: Check for Breaking Changes
        run: |
          if [ "${{ github.event_name }}" == "pull_request" ]; then
            git fetch origin ${{ github.base_ref }}
            npm run api:check-breaking -- \
              --old-spec <(git show origin/${{ github.base_ref }}:docs/api-spec/generated/openapi.yaml) \
              --new-spec docs/api-spec/generated/openapi.yaml \
              --output reports/breaking-changes.json
            
            # 如果有高严重性 Breaking Change，失败
            if grep -q '"high"' reports/breaking-changes.json; then
              echo "::error::Breaking changes detected! Please review breaking-changes.json"
              exit 1
            fi
          fi
      
      - name: Run Contract Tests
        run: npm run test:contract
        env:
          API_BASE_URL: http://localhost:3000
          TEST_AUTH_TOKEN: ${{ secrets.TEST_AUTH_TOKEN }}
      
      - name: Generate Contract Test Report
        run: npm run test:contract:report
      
      - name: Upload Contract Test Results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: contract-test-results
          path: |
            reports/contract-tests.json
            reports/breaking-changes.json
            reports/coverage/
      
      - name: Comment PR with Results
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('reports/contract-tests.json', 'utf8'));
            
            const body = `## 📋 API Contract Test Results
            
            | Metric | Value |
            |--------|-------|
            | Total Tests | ${results.total} |
            | ✅ Passed | ${results.passed} |
            | ❌ Failed | ${results.failed} |
            | ⏭️ Skipped | ${results.skipped} |
            | Pass Rate | ${((results.passed / results.total) * 100).toFixed(1)}% |
            
            ${results.errors.length > 0 ? '### ❌ Failed Tests\n\n' + results.errors.map(e => `- ${e.operationId}: ${e.errors[0]?.message}`).join('\n') : ''}
            `;
            
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });

  mock-service:
    runs-on: ubuntu-latest
    needs: contract-tests
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Generate Mock Service
        run: npm run mock:generate
      
      - name: Start Mock Service
        run: npm run mock:start &
        
      - name: Verify Mock Service
        run: |
          sleep 5
          curl -f http://localhost:4000/health || exit 1
      
      - name: Run Frontend Tests with Mock
        run: npm run test:frontend:e2e
        env:
          API_BASE_URL: http://localhost:4000
```

#### 4.2 package.json 脚本
```json
{
  "scripts": {
    "api:spec:generate": "node scripts/generate-openapi-spec.js",
    "api:spec:validate": "swagger-cli validate docs/api-spec/generated/openapi.yaml",
    "api:check-breaking": "node scripts/check-breaking-changes.js",
    "test:contract": "mocha backend/tests/contract/*.test.js",
    "test:contract:report": "node scripts/generate-contract-report.js",
    "mock:generate": "node scripts/generate-mock-service.js",
    "mock:start": "node backend/tests/contract/mock-server.js",
    "test:frontend:e2e": "playwright test --config=frontend/tests/e2e/playwright.config.js"
  }
}
```

### 5. 契约测试示例

#### 5.1 Pokemon API 契约测试
```javascript
// backend/tests/contract/pokemon.contracts.test.js
const { expect } = require('chai');
const ContractTestRunner = require('./ContractTestRunner');

describe('Pokemon API Contract Tests', function() {
  this.timeout(30000);
  
  let runner;
  
  before(async () => {
    runner = new ContractTestRunner({
      openapiPath: 'docs/api-spec/generated/openapi.yaml',
      baseUrl: process.env.API_BASE_URL || 'http://localhost:3000'
    });
    
    await runner.loadOpenAPISpec();
  });
  
  describe('GET /api/pokemon', () => {
    it('should return paginated pokemon list', async () => {
      const test = {
        path: '/api/pokemon',
        method: 'GET',
        operationId: 'getPokemonList',
        expectedStatus: 200,
        expectedResponse: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pokemon', 'total', 'limit', 'offset'],
                properties: {
                  pokemon: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Pokemon' }
                  },
                  total: { type: 'integer' },
                  limit: { type: 'integer' },
                  offset: { type: 'integer' }
                }
              }
            }
          }
        }
      };
      
      const result = await runner.runTest(test);
      expect(result.status).to.equal('passed');
    });
    
    it('should validate query parameters', async () => {
      const test = {
        path: '/api/pokemon',
        method: 'GET',
        operationId: 'getPokemonList',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }
        ],
        expectedStatus: 200
      };
      
      const result = await runner.runTest(test);
      expect(result.status).to.equal('passed');
    });
  });
  
  describe('POST /api/pokemon/catch', () => {
    it('should validate catch request body', async () => {
      const test = {
        path: '/api/pokemon/catch',
        method: 'POST',
        operationId: 'catchPokemon',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['speciesId', 'latitude', 'longitude'],
                properties: {
                  speciesId: { type: 'string' },
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                  throwType: { type: 'string', enum: ['normal', 'curve', 'excellent'] }
                }
              }
            }
          }
        },
        expectedStatus: 201,
        security: [{ bearerAuth: [] }]
      };
      
      const result = await runner.runTest(test);
      expect(result.status).to.equal('passed');
    });
  });
});
```

### 6. 监控与报告

#### 6.1 契约测试覆盖率报告
```javascript
// backend/tests/contract/ContractCoverageReporter.js
class ContractCoverageReporter {
  constructor() {
    this.coverage = {
      totalEndpoints: 0,
      testedEndpoints: 0,
      untestedEndpoints: [],
      coverageByService: {},
      coverageByTag: {}
    };
  }
  
  async generateCoverageReport(openapiSpec, testResults) {
    // 计算覆盖率
    const paths = openapiSpec.paths;
    
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        
        this.coverage.totalEndpoints++;
        
        const operationId = operation.operationId || `${method}-${path}`;
        const tested = testResults.some(r => r.operationId === operationId);
        
        if (tested) {
          this.coverage.testedEndpoints++;
        } else {
          this.coverage.untestedEndpoints.push({
            path,
            method: method.toUpperCase(),
            operationId
          });
        }
        
        // 按服务统计
        const service = this.extractService(path);
        if (!this.coverage.coverageByService[service]) {
          this.coverage.coverageByService[service] = {
            total: 0,
            tested: 0
          };
        }
        this.coverage.coverageByService[service].total++;
        if (tested) {
          this.coverage.coverageByService[service].tested++;
        }
        
        // 按标签统计
        if (operation.tags) {
          for (const tag of operation.tags) {
            if (!this.coverage.coverageByTag[tag]) {
              this.coverage.coverageByTag[tag] = { total: 0, tested: 0 };
            }
            this.coverage.coverageByTag[tag].total++;
            if (tested) {
              this.coverage.coverageByTag[tag].tested++;
            }
          }
        }
      }
    }
    
    return this.generateReport();
  }
  
  extractService(path) {
    const match = path.match(/^\/api\/([^/]+)/);
    return match ? match[1] : 'unknown';
  }
  
  generateReport() {
    const coveragePercent = (this.coverage.testedEndpoints / this.coverage.totalEndpoints * 100).toFixed(1);
    
    const report = {
      summary: {
        totalEndpoints: this.coverage.totalEndpoints,
        testedEndpoints: this.coverage.testedEndpoints,
        coverage: `${coveragePercent}%`,
        untestedCount: this.coverage.untestedEndpoints.length
      },
      byService: {},
      byTag: {},
      untestedEndpoints: this.coverage.untestedEndpoints
    };
    
    // 计算每个服务的覆盖率
    for (const [service, data] of Object.entries(this.coverage.coverageByService)) {
      report.byService[service] = {
        total: data.total,
        tested: data.tested,
        coverage: `${(data.tested / data.total * 100).toFixed(1)}%`
      };
    }
    
    // 计算每个标签的覆盖率
    for (const [tag, data] of Object.entries(this.coverage.coverageByTag)) {
      report.byTag[tag] = {
        total: data.total,
        tested: data.tested,
        coverage: `${(data.tested / data.total * 100).toFixed(1)}%`
      };
    }
    
    return report;
  }
}

module.exports = ContractCoverageReporter;
```

## 验收标准

- [ ] OpenAPI 规范完整覆盖所有 API 端点
- [ ] 契约测试框架实现并可通过 npm test:contract 运行
- [ ] 契约测试覆盖率 ≥ 90%
- [ ] Mock 服务生成器实现并可通过 npm mock:start 启动
- [ ] Breaking Change 检测器集成到 CI/CD
- [ ] PR 中有高严重性 Breaking Change 时自动失败
- [ ] 契约测试报告自动生成并上传到 GitHub Artifacts
- [ ] PR 中自动评论测试结果摘要
- [ ] 所有契约测试通过率 100%
- [ ] 文档完善：契约测试编写指南、Mock 服务使用说明

## 影响范围

### 新增文件
- `backend/tests/contract/ContractTestRunner.js` - 契约测试运行器
- `backend/tests/contract/MockServiceGenerator.js` - Mock 服务生成器
- `backend/tests/contract/BreakingChangeDetector.js` - Breaking Change 检测器
- `backend/tests/contract/ContractCoverageReporter.js` - 覆盖率报告器
- `backend/tests/contract/pokemon.contracts.test.js` - Pokemon API 契约测试
- `backend/tests/contract/user.contracts.test.js` - User API 契约测试
- `backend/tests/contract/trade.contracts.test.js` - Trade API 契约测试
- `docs/api-spec/openapi/base.yaml` - OpenAPI 基础配置
- `docs/api-spec/openapi/components/` - 可复用组件
- `docs/api-spec/openapi/paths/` - API 路径定义
- `.github/workflows/contract-tests.yml` - CI/CD 工作流

### 修改文件
- `package.json` - 添加契约测试相关脚本
- `docs/api-spec/generated/openapi.yaml` - 生成的完整 OpenAPI 规范

## 参考

- [OpenAPI Specification 3.0](https://swagger.io/specification/)
- [Pact Contract Testing](https://docs.pact.io/)
- [Breaking Changes in APIs](https://apisyouwonthate.com/blog/putting-api-breaking-changes-to-bed/)
- [Spring Cloud Contract](https://spring.io/projects/spring-cloud-contract)
- [Dredd API Testing](https://dredd.org/)
