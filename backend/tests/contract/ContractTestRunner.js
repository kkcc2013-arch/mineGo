'use strict';
/**
 * ContractTestRunner - 契约测试运行器
 * 执行契约测试并生成结果报告
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const ContractRegistry = require('../shared/contract/ContractRegistry');
const { ContractSchema } = require('../shared/contract/ContractSchema');

class ContractTestRunner {
  /**
   * 创建测试运行器
   * @param {Object} config - 配置选项
   */
  constructor(config = {}) {
    this.registry = new ContractRegistry();
    this.baseUrl = config.baseUrl || process.env.API_BASE_URL || 'http://localhost:8080';
    this.timeout = config.timeout || 30000;
    this.results = [];
    this.contractDir = config.contractDir || './contracts';
  }

  /**
   * 加载所有契约
   * @param {string} contractDir - 契约目录
   */
  async loadContracts(contractDir = this.contractDir) {
    try {
      const files = await fs.readdir(contractDir);

      for (const file of files) {
        if (file.endsWith('.contract.js') || file.endsWith('.contract.json')) {
          const contractPath = path.join(contractDir, file);
          try {
            const contract = require(contractPath);
            if (contract.name && contract instanceof ContractSchema) {
              this.registry.registerProvider(contract.name, contract);
            }
          } catch (error) {
            console.error(`Failed to load contract ${file}:`, error.message);
          }
        }
      }

      console.log(`[ContractTestRunner] Loaded ${this.registry.getAllProviders().length} contracts`);
    } catch (error) {
      console.warn(`[ContractTestRunner] Contract directory not found: ${contractDir}`);
    }
  }

  /**
   * 注册契约
   * @param {ContractSchema} contract - 契约对象
   */
  registerContract(contract) {
    this.registry.registerProvider(contract.name, contract);
  }

  /**
   * 运行所有契约测试
   * @returns {Object} 测试结果
   */
  async runAll() {
    console.log('\n' + '='.repeat(60));
    console.log('Starting Contract Tests');
    console.log('='.repeat(60) + '\n');

    const providers = this.registry.getAllProviders();
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      timestamp: new Date().toISOString(),
      providers: []
    };

    const startTime = Date.now();

    for (const provider of providers) {
      console.log(`\n📦 Testing Provider: ${provider}`);
      const providerResults = await this.runProviderTests(provider);
      results.providers.push(providerResults);
      results.total += providerResults.total;
      results.passed += providerResults.passed;
      results.failed += providerResults.failed;
      results.skipped += providerResults.skipped;
    }

    results.duration = Date.now() - startTime;
    this.results = results;

    this.printSummary(results);
    return results;
  }

  /**
   * 运行提供方测试
   * @param {string} providerName - 提供方名称
   * @returns {Object}
   */
  async runProviderTests(providerName) {
    const contract = this.registry.getProvider(providerName);
    if (!contract) {
      return {
        provider: providerName,
        error: 'Contract not found',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        tests: []
      };
    }

    const results = {
      provider: providerName,
      version: contract.version,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: []
    };

    const endpoints = contract.getAllEndpoints();
    results.total = endpoints.length;

    for (const endpoint of endpoints) {
      const test = await this.runEndpointTest(contract, endpoint);
      results.tests.push(test);

      if (test.status === 'passed') {
        results.passed++;
      } else if (test.status === 'failed') {
        results.failed++;
      } else {
        results.skipped++;
      }
    }

    return results;
  }

  /**
   * 运行单个端点测试
   * @param {ContractSchema} contract - 契约
   * @param {Object} endpoint - 端点配置
   * @returns {Object}
   */
  async runEndpointTest(contract, endpoint) {
    const test = {
      endpoint: endpoint.key,
      method: endpoint.method,
      path: endpoint.path,
      status: 'passed',
      errors: [],
      duration: 0,
      request: null,
      response: null
    };

    const startTime = Date.now();

    try {
      // 构建请求
      const requestConfig = {
        method: endpoint.method.toLowerCase(),
        url: `${this.baseUrl}${endpoint.path}`,
        timeout: this.timeout,
        validateStatus: () => true
      };

      // 发送请求
      const response = await axios(requestConfig);
      test.response = {
        status: response.status,
        data: response.data
      };

      // 验证状态码
      const expectedStatus = endpoint.expectedStatus || 200;
      if (response.status !== expectedStatus) {
        test.status = 'failed';
        test.errors.push({
          type: 'status_mismatch',
          expected: expectedStatus,
          actual: response.status
        });
      }

      // 验证响应 Schema
      if (endpoint.response) {
        const validation = contract.validateResponse(
          endpoint.method,
          endpoint.path,
          response.data
        );

        if (validation.error) {
          test.status = 'failed';
          test.errors.push({
            type: 'schema_violation',
            message: validation.error.message,
            details: validation.error.details?.map(d => ({
              path: d.path?.join('.'),
              message: d.message
            }))
          });
        }
      }

    } catch (error) {
      test.status = 'failed';
      test.errors.push({
        type: 'request_failed',
        message: error.message
      });
    }

    test.duration = Date.now() - startTime;
    return test;
  }

  /**
   * 运行消费者契约验证
   * @param {string} consumerName - 消费者名称
   * @param {string} providerName - 提供方名称
   * @returns {Object}
   */
  async runConsumerTest(consumerName, providerName) {
    console.log(`\n🔗 Testing Consumer: ${consumerName} -> ${providerName}`);
    
    const results = await this.registry.verifyConsumerExpectations(
      consumerName,
      providerName
    );

    return results;
  }

  /**
   * 打印测试摘要
   * @param {Object} results - 测试结果
   */
  printSummary(results) {
    console.log('\n' + '='.repeat(60));
    console.log('Contract Test Summary');
    console.log('='.repeat(60));
    console.log(`Timestamp:  ${results.timestamp}`);
    console.log(`Duration:   ${results.duration}ms`);
    console.log(`Total:      ${results.total}`);
    console.log(`Passed:     ${results.passed} ✅`);
    console.log(`Failed:     ${results.failed} ❌`);
    console.log(`Skipped:    ${results.skipped} ⏭️`);
    console.log('='.repeat(60));

    if (results.failed > 0) {
      console.log('\n❌ Failed Tests:');
      for (const provider of results.providers) {
        for (const test of provider.tests) {
          if (test.status === 'failed') {
            console.log(`\n  ${provider.provider}${test.endpoint}`);
            for (const error of test.errors) {
              console.log(`    - ${error.type}: ${error.message || JSON.stringify(error)}`);
            }
          }
        }
      }
    }

    console.log('');
  }

  /**
   * 检查是否全部通过
   * @returns {boolean}
   */
  allPassed() {
    return this.results.failed === 0 && this.results.total > 0;
  }
}

module.exports = ContractTestRunner;
