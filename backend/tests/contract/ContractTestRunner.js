'use strict';
/**
 * Contract Test Runner - API 合约测试框架
 * REQ-00547: API 响应 Schema 强制执行与合约测试自动化系统
 */

const axios = require('axios');
const { getSchemaRegistry } = require('../../shared/schemaRegistry/SchemaRegistry');
const logger = require('../../shared/logger');

/**
 * 合约测试配置
 */
const DEFAULT_CONFIG = {
  baseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  timeout: 10000,
  parallel: true,
  maxConcurrent: 5,
  generateReport: true,
  reportPath: 'reports/contract-test-report.json'
};

/**
 * 合约测试运行器
 */
class ContractTestRunner {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = getSchemaRegistry();
    this.results = {
      passed: [],
      failed: [],
      skipped: [],
      startTime: null,
      endTime: null
    };
  }

  /**
   * 加载所有合约 Schema
   */
  async loadContractSchemas() {
    const services = await this.listAllServices();

    const schemas = [];

    for (const serviceName of services) {
      const serviceSchemas = await this.registry.listSchemas(serviceName);

      for (const schemaInfo of serviceSchemas) {
        const schema = await this.registry.getSchema(
          serviceName,
          schemaInfo.route,
          schemaInfo.version
        );

        if (schema) {
          schemas.push({
            serviceName,
            route: schemaInfo.route,
            version: schemaInfo.version,
            schema
          });
        }
      }
    }

    logger.info('Loaded contract schemas', { count: schemas.length });
    return schemas;
  }

  /**
   * 列出所有服务
   */
  async listAllServices() {
    // 从环境变量或配置中获取服务列表
    return [
      'user-service',
      'pokemon-service',
      'location-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];
  }

  /**
   * 从 Schema 自动生成测试用例
   */
  async generateTestCases(schemaInfo) {
    const { serviceName, route, version, schema } = schemaInfo;
    const testCases = [];

    // 生成正向测试用例
    testCases.push({
      name: `${serviceName} - ${route} - Valid Response`,
      serviceName,
      route,
      version,
      type: 'positive',
      method: 'GET',
      expectedStatus: 200,
      headers: {},
      body: null
    });

    // 根据 Schema 生成边界测试用例
    if (schema.properties) {
      // 测试必需字段缺失
      for (const requiredField of schema.required || []) {
        testCases.push({
          name: `${serviceName} - ${route} - Missing Required Field: ${requiredField}`,
          serviceName,
          route,
          version,
          type: 'negative',
          method: 'POST',
          expectedStatus: 400,
          headers: {},
          body: this.generateMissingFieldBody(schema, requiredField)
        });
      }
    }

    return testCases;
  }

  /**
   * 生成缺失字段的请求体
   */
  generateMissingFieldBody(schema, missingField) {
    const body = {};

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (key !== missingField) {
          body[key] = this.generateDefaultValue(prop);
        }
      }
    }

    return body;
  }

  /**
   * 生成默认值
   */
  generateDefaultValue(property) {
    switch (property.type) {
      case 'string':
        return 'test-string';
      case 'integer':
        return 1;
      case 'number':
        return 1.0;
      case 'boolean':
        return true;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  }

  /**
   * 执行单个合约测试
   */
  async runContractTest(testCase) {
    const startTime = Date.now();

    try {
      const response = await axios({
        method: testCase.method,
        url: `${this.config.baseUrl}${testCase.route}`,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Version': testCase.version,
          ...testCase.headers
        },
        data: testCase.body,
        timeout: this.config.timeout,
        validateStatus: () => true // 不抛出非 200 状态码
      });

      const duration = Date.now() - startTime;

      // 获取 Schema
      const schema = await this.registry.getSchema(
        testCase.serviceName,
        testCase.route,
        testCase.version
      );

      // 校验响应
      const validationResult = schema
        ? await this.registry.validateAgainstSchema(response.data, schema)
        : { valid: false, errors: [{ message: 'Schema not found' }] };

      const passed = response.status === testCase.expectedStatus && validationResult.valid;

      return {
        testCase,
        passed,
        duration,
        statusCode: response.status,
        validationResult,
        response: response.data,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        testCase,
        passed: false,
        duration: Date.now() - startTime,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 执行所有合约测试
   */
  async runAllContractTests() {
    this.results.startTime = new Date().toISOString();

    const schemas = await this.loadContractSchemas();
    const allTestCases = [];

    // 生成所有测试用例
    for (const schemaInfo of schemas) {
      const testCases = await this.generateTestCases(schemaInfo);
      allTestCases.push(...testCases);
    }

    logger.info('Generated test cases', { count: allTestCases.length });

    // 执行测试
    if (this.config.parallel) {
      const batches = this.chunkArray(allTestCases, this.config.maxConcurrent);

      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(tc => this.runContractTest(tc))
        );

        this.processResults(batchResults);
      }
    } else {
      for (const testCase of allTestCases) {
        const result = await this.runContractTest(testCase);
        this.processResults([result]);
      }
    }

    this.results.endTime = new Date().toISOString();

    // 生成报告
    if (this.config.generateReport) {
      await this.generateReport();
    }

    return this.results;
  }

  /**
   * 处理测试结果
   */
  processResults(results) {
    for (const result of results) {
      if (result.passed) {
        this.results.passed.push(result);
      } else {
        this.results.failed.push(result);
      }
    }
  }

  /**
   * 数组分块
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * 生成测试报告
   */
  async generateReport() {
    const report = {
      summary: {
        total: this.results.passed.length + this.results.failed.length,
        passed: this.results.passed.length,
        failed: this.results.failed.length,
        skipped: this.results.skipped.length,
        passRate: this.calculatePassRate(),
        duration: this.calculateDuration()
      },
      results: {
        passed: this.results.passed.map(this.formatResult),
        failed: this.results.failed.map(this.formatResult)
      },
      timestamp: new Date().toISOString(),
      config: {
        baseUrl: this.config.baseUrl,
        timeout: this.config.timeout
      }
    };

    // 写入文件
    const fs = require('fs').promises;
    await fs.mkdir('reports', { recursive: true });
    await fs.writeFile(
      this.config.reportPath,
      JSON.stringify(report, null, 2)
    );

    logger.info('Contract test report generated', {
      path: this.config.reportPath,
      summary: report.summary
    });

    return report;
  }

  /**
   * 计算通过率
   */
  calculatePassRate() {
    const total = this.results.passed.length + this.results.failed.length;
    if (total === 0) return 0;
    return ((this.results.passed.length / total) * 100).toFixed(2);
  }

  /**
   * 计算持续时间
   */
  calculateDuration() {
    if (!this.results.startTime || !this.results.endTime) return 0;
    const start = new Date(this.results.startTime).getTime();
    const end = new Date(this.results.endTime).getTime();
    return (end - start) / 1000; // 秒
  }

  /**
   * 格式化测试结果
   */
  formatResult(result) {
    return {
      name: result.testCase.name,
      serviceName: result.testCase.serviceName,
      route: result.testCase.route,
      version: result.testCase.version,
      passed: result.passed,
      duration: result.duration,
      statusCode: result.statusCode,
      error: result.error || null,
      validationErrors: result.validationResult?.errors || []
    };
  }

  /**
   * 运行单个服务的合约测试
   */
  async runServiceContractTests(serviceName) {
    const schemas = await this.registry.listSchemas(serviceName);
    const results = [];

    for (const schemaInfo of schemas) {
      const schema = await this.registry.getSchema(
        serviceName,
        schemaInfo.route,
        schemaInfo.version
      );

      if (schema) {
        const testCases = await this.generateTestCases({
          serviceName,
          route: schemaInfo.route,
          version: schemaInfo.version,
          schema
        });

        for (const testCase of testCases) {
          const result = await this.runContractTest(testCase);
          results.push(result);
        }
      }
    }

    return results;
  }

  /**
   * 验证合约是否被破坏
   */
  async detectBreakingChanges(serviceName, route, newSchema) {
    const oldSchema = await this.registry.getSchema(serviceName, route, 'latest');

    if (!oldSchema) {
      return { breakingChanges: [] };
    }

    const differences = this.registry.compareSchemas(oldSchema, newSchema);
    const breakingChanges = differences.filter(d => d.breaking);

    return {
      serviceName,
      route,
      breakingChanges,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = ContractTestRunner;