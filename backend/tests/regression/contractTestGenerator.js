/**
 * API 契约测试生成器
 * 基于真实请求/响应生成契约测试用例
 * 
 * @module ContractTestGenerator
 */

const fs = require('fs').promises;
const path = require('path');

class ContractTestGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, 'generated');
    this.maxSamples = options.maxSamples || 100;
    this.excludeHeaders = ['authorization', 'cookie', 'x-api-key'];
  }

  /**
   * 基于真实请求/响应生成契约测试用例
   * @param {Array<APICall>} samples - 从日志采样的真实 API 调用
   * @returns {Promise<Array<TestFile>>}
   */
  async generateTests(samples) {
    // 确保输出目录存在
    await fs.mkdir(this.outputDir, { recursive: true });

    // 按端点分组
    const groupedSamples = this.groupByEndpoint(samples);

    const testFiles = [];

    for (const [endpoint, endpointSamples] of Object.entries(groupedSamples)) {
      // 限制每个端点的测试数量
      const limitedSamples = endpointSamples.slice(0, this.maxSamples);

      const testFile = await this.generateTestFile(endpoint, limitedSamples);
      testFiles.push(testFile);
    }

    return testFiles;
  }

  /**
   * 按端点分组采样
   */
  groupByEndpoint(samples) {
    const groups = {};
    
    for (const sample of samples) {
      const key = `${sample.method.toUpperCase()} ${this.normalizePath(sample.path)}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(sample);
    }

    return groups;
  }

  /**
   * 规范化路径（将路径参数替换为占位符）
   */
  normalizePath(path) {
    return path.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
      .replace(/\/\d+/g, '/{id}');
  }

  /**
   * 生成单个测试文件
   */
  async generateTestFile(endpoint, samples) {
    const testCases = samples.map(sample => this.generateTestCase(sample));
    const fileName = `${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}.contract.test.js`;
    const filePath = path.join(this.outputDir, fileName);

    const content = this.renderTestFile(endpoint, testCases);

    await fs.writeFile(filePath, content);

    return {
      endpoint,
      fileName,
      filePath,
      testCaseCount: testCases.length,
    };
  }

  /**
   * 生成单个测试用例
   */
  generateTestCase(sample) {
    const { method, path, request, response, statusCode, timestamp } = sample;

    return {
      name: `${method.toUpperCase()} ${path} - 契约测试 (${timestamp})`,
      endpoint: path,
      method: method.toLowerCase(),
      request: {
        headers: this.sanitizeHeaders(request.headers),
        query: request.query || {},
        body: this.sanitizeBody(request.body),
      },
      expect: {
        statusCode,
        bodySchema: this.inferSchema(response),
        responseTime: { max: 1000 },
      },
    };
  }

  /**
   * 清理敏感 header
   */
  sanitizeHeaders(headers) {
    const sanitized = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (!this.excludeHeaders.includes(key.toLowerCase())) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * 清理敏感 body 数据
   */
  sanitizeBody(body) {
    if (!body) return undefined;

    const sanitized = { ...body };
    const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'creditCard'];

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '<REDACTED>';
      }
    }

    return sanitized;
  }

  /**
   * 从响应推断 JSON Schema
   */
  inferSchema(obj) {
    if (obj === null) return { type: 'null' };
    if (obj === undefined) return {};
    if (typeof obj === 'boolean') return { type: 'boolean' };
    if (typeof obj === 'number') return { type: 'number', minimum: 0 };
    if (typeof obj === 'string') {
      // 尝试推断格式
      if (/^\d{4}-\d{2}-\d{2}/.test(obj)) return { type: 'string', format: 'date-time' };
      if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(obj)) return { type: 'string', format: 'email' };
      if (/^https?:\/\//.test(obj)) return { type: 'string', format: 'uri' };
      return { type: 'string' };
    }

    if (Array.isArray(obj)) {
      return {
        type: 'array',
        items: obj.length > 0 ? this.inferSchema(obj[0]) : {},
      };
    }

    if (typeof obj === 'object') {
      const properties = {};
      const required = [];

      for (const [key, value] of Object.entries(obj)) {
        properties[key] = this.inferSchema(value);
        // 基于采样推断必填字段
        if (value !== null && value !== undefined) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    return {};
  }

  /**
   * 渲染测试文件内容
   */
  renderTestFile(endpoint, testCases) {
    const testFileHeader = `/**
 * 自动生成的 API 契约测试
 * 端点: ${endpoint}
 * 生成时间: ${new Date().toISOString()}
 * 
 * 此文件由 ContractTestGenerator 自动生成，请勿手动修改
 */

const request = require('supertest');
const { expect } = require('chai');
const app = require('../../../gateway/src/app');
const schemaValidator = require('../../../shared/schemaValidator');

describe('API 契约测试 - ${endpoint}', function() {
  this.timeout(10000);
`;

    const testCasesCode = testCases.map(tc => this.renderTestCase(tc)).join('\n\n');

    const testFileFooter = `
});
`;

    return testFileHeader + testCasesCode + testFileFooter;
  }

  /**
   * 渲染单个测试用例
   */
  renderTestCase(tc) {
    const hasQuery = Object.keys(tc.request.query).length > 0;
    const hasBody = tc.request.body !== undefined;
    const hasHeaders = Object.keys(tc.request.headers).length > 0;

    let requestChain = `request(app)\n      .${tc.method}('${tc.endpoint}')`;

    if (hasQuery) {
      requestChain += `\n      .query(${JSON.stringify(tc.request.query)})`;
    }

    if (hasBody) {
      requestChain += `\n      .send(${JSON.stringify(tc.request.body, null, 2)})`;
    }

    if (hasHeaders) {
      for (const [key, value] of Object.entries(tc.request.headers)) {
        requestChain += `\n      .set('${key}', '${value}')`;
      }
    }

    // 添加通用 headers
    requestChain += `\n      .set('Accept', 'application/json')`;

    const assertions = this.renderAssertions(tc);

    return `
  it('${tc.name}', async () => {
    const res = await ${requestChain};

    // 状态码验证
    expect(res.status).to.equal(${tc.expect.statusCode});

    // 响应体结构验证
    expect(res.body).to.be.an('object');
    
${assertions}
  });`;
  }

  /**
   * 渲染断言代码
   */
  renderAssertions(tc) {
    const schema = tc.expect.bodySchema;
    if (!schema.properties) return '';

    const assertions = [];

    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const typeCheck = this.getTypeCheck(propSchema.type);
      assertions.push(`    expect(res.body).to.have.property('${propName}');`);
      if (typeCheck) {
        assertions.push(`    expect(res.body.${propName}).to.${typeCheck};`);
      }
    }

    return assertions.join('\n');
  }

  /**
   * 获取类型检查方法
   */
  getTypeCheck(type) {
    const typeMap = {
      'string': 'be.a(\'string\')',
      'number': 'be.a(\'number\')',
      'boolean': 'be.a(\'boolean\')',
      'array': 'be.an(\'array\')',
      'object': 'be.an(\'object\')',
    };
    return typeMap[type] || '';
  }

  /**
   * 从日志文件采样 API 调用
   */
  async sampleFromLogFile(logPath, options = {}) {
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const samples = [];

    for (const line of lines) {
      try {
        const logEntry = JSON.parse(line);
        if (logEntry.type === 'api_call' || logEntry.request) {
          samples.push({
            method: logEntry.method || logEntry.request.method,
            path: logEntry.path || logEntry.request.path,
            request: {
              headers: logEntry.headers || logEntry.request.headers,
              query: logEntry.query || logEntry.request.query,
              body: logEntry.body || logEntry.request.body,
            },
            response: logEntry.response,
            statusCode: logEntry.statusCode || logEntry.response?.statusCode,
            timestamp: logEntry.timestamp || logEntry.time,
          });
        }
      } catch (e) {
        // 忽略解析失败的行
      }
    }

    return samples;
  }

  /**
   * 运行所有生成的契约测试
   */
  async runGeneratedTests() {
    const files = await fs.readdir(this.outputDir);
    const results = [];

    for (const file of files) {
      if (!file.endsWith('.contract.test.js')) continue;

      try {
        // 使用 mocha 运行测试
        const result = await this.runTestFile(path.join(this.outputDir, file));
        results.push(result);
      } catch (error) {
        results.push({
          file,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * 运行单个测试文件
   */
  async runTestFile(filePath) {
    // 简化实现：使用 require 加载测试并执行
    // 实际应该使用 mocha 命令行
    const Mocha = require('mocha');
    const mocha = new Mocha({ timeout: 10000 });

    mocha.addFile(filePath);

    return new Promise((resolve, reject) => {
      mocha.run(failures => {
        resolve({
          file: path.basename(filePath),
          success: failures === 0,
          failures,
        });
      });
    });
  }
}

module.exports = ContractTestGenerator;