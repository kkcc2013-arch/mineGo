'use strict';
/**
 * ContractRegistry - 契约注册中心
 * 管理所有微服务的 API 契约
 */

const CompatibilityChecker = require('./CompatibilityChecker');

class ContractRegistry {
  constructor() {
    this.contracts = new Map();
    this.consumerContracts = new Map();
    this.providers = new Map();
    this.compatibilityChecker = new CompatibilityChecker();
    this.contractHistory = new Map();
  }

  /**
   * 注册提供方契约
   * @param {string} serviceName - 服务名称
   * @param {ContractSchema} contract - 契约对象
   */
  registerProvider(serviceName, contract) {
    // 保存历史版本
    if (this.contracts.has(serviceName)) {
      const oldContract = this.contracts.get(serviceName);
      if (!this.contractHistory.has(serviceName)) {
        this.contractHistory.set(serviceName, []);
      }
      this.contractHistory.get(serviceName).push({
        version: oldContract.version,
        contract: oldContract,
        archivedAt: new Date().toISOString()
      });
    }

    this.contracts.set(serviceName, contract);
    this.providers.set(serviceName, {
      name: serviceName,
      contract,
      registeredAt: new Date(),
      version: contract.version
    });

    console.log(`[ContractRegistry] Registered provider: ${serviceName} v${contract.version}`);
    return this;
  }

  /**
   * 获取提供方契约
   * @param {string} serviceName - 服务名称
   * @returns {ContractSchema|null}
   */
  getProvider(serviceName) {
    return this.contracts.get(serviceName) || null;
  }

  /**
   * 注册消费者契约
   * @param {string} consumerName - 消费者名称
   * @param {string} providerName - 提供方名称
   * @param {Array} expectations - 期望列表
   */
  registerConsumer(consumerName, providerName, expectations) {
    const key = `${consumerName}->${providerName}`;
    this.consumerContracts.set(key, {
      consumer: consumerName,
      provider: providerName,
      expectations,
      registeredAt: new Date()
    });

    console.log(`[ContractRegistry] Registered consumer contract: ${key}`);
    return this;
  }

  /**
   * 获取消费者契约
   * @param {string} consumerName - 消费者名称
   * @param {string} providerName - 提供方名称
   * @returns {Object|null}
   */
  getConsumerContract(consumerName, providerName) {
    const key = `${consumerName}->${providerName}`;
    return this.consumerContracts.get(key) || null;
  }

  /**
   * 验证提供方契约
   * @param {string} providerName - 提供方名称
   * @param {Function} testRunner - 测试运行函数
   * @returns {Object} 验证结果
   */
  async verifyProvider(providerName, testRunner = null) {
    const contract = this.contracts.get(providerName);
    if (!contract) {
      throw new Error(`No contract found for provider: ${providerName}`);
    }

    const results = {
      provider: providerName,
      version: contract.version,
      timestamp: new Date().toISOString(),
      passed: true,
      total: 0,
      passedCount: 0,
      failedCount: 0,
      tests: []
    };

    const endpoints = contract.getAllEndpoints();
    results.total = endpoints.length;

    for (const endpoint of endpoints) {
      const testResult = {
        endpoint: endpoint.key,
        method: endpoint.method,
        path: endpoint.path,
        passed: true,
        errors: [],
        duration: 0
      };

      const startTime = Date.now();

      try {
        if (testRunner) {
          const runResult = await testRunner(endpoint);
          if (!runResult.passed) {
            testResult.passed = false;
            testResult.errors = runResult.errors || [];
          }
        }
      } catch (error) {
        testResult.passed = false;
        testResult.errors.push({
          type: 'test_error',
          message: error.message
        });
      }

      testResult.duration = Date.now() - startTime;
      results.tests.push(testResult);

      if (testResult.passed) {
        results.passedCount++;
      } else {
        results.failedCount++;
        results.passed = false;
      }
    }

    return results;
  }

  /**
   * 验证消费者期望
   * @param {string} consumerName - 消费者名称
   * @param {string} providerName - 提供方名称
   * @returns {Object} 验证结果
   */
  async verifyConsumerExpectations(consumerName, providerName) {
    const key = `${consumerName}->${providerName}`;
    const consumerContract = this.consumerContracts.get(key);
    const providerContract = this.contracts.get(providerName);

    const results = {
      consumer: consumerName,
      provider: providerName,
      timestamp: new Date().toISOString(),
      passed: true,
      total: 0,
      matched: 0,
      mismatches: []
    };

    if (!consumerContract) {
      results.passed = false;
      results.mismatches.push({
        type: 'missing_consumer_contract',
        message: `No consumer contract found: ${key}`
      });
      return results;
    }

    if (!providerContract) {
      results.passed = false;
      results.mismatches.push({
        type: 'missing_provider_contract',
        message: `No provider contract found: ${providerName}`
      });
      return results;
    }

    results.total = consumerContract.expectations.length;

    for (const expectation of consumerContract.expectations) {
      const providerEndpoint = providerContract.getEndpoint(
        expectation.method || 'GET',
        expectation.path
      );

      if (!providerEndpoint) {
        results.mismatches.push({
          type: 'missing_endpoint',
          endpoint: expectation.path,
          method: expectation.method || 'GET',
          message: `Provider missing endpoint: ${expectation.method || 'GET'} ${expectation.path}`
        });
        results.passed = false;
        continue;
      }

      // 验证响应结构匹配
      if (expectation.responseSchema && providerEndpoint.response) {
        const compatibility = this.compatibilityChecker.checkSchemaCompatibility(
          expectation.responseSchema,
          providerEndpoint.response
        );

        if (!compatibility.compatible) {
          results.mismatches.push({
            type: 'schema_mismatch',
            endpoint: expectation.path,
            details: compatibility.issues
          });
          results.passed = false;
          continue;
        }
      }

      results.matched++;
    }

    return results;
  }

  /**
   * 检查契约兼容性
   * @param {string} providerName - 提供方名称
   * @param {ContractSchema} newContract - 新契约
   * @returns {Object} 兼容性检查结果
   */
  checkCompatibility(providerName, newContract) {
    const oldContract = this.contracts.get(providerName);
    if (!oldContract) {
      return { compatible: true, isNew: true };
    }

    return this.compatibilityChecker.checkCompatibility(oldContract, newContract);
  }

  /**
   * 获取所有提供方名称
   * @returns {Array}
   */
  getAllProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * 获取契约历史版本
   * @param {string} serviceName - 服务名称
   * @returns {Array}
   */
  getContractHistory(serviceName) {
    return this.contractHistory.get(serviceName) || [];
  }

  /**
   * 清除所有契约（用于测试）
   */
  clear() {
    this.contracts.clear();
    this.consumerContracts.clear();
    this.providers.clear();
    this.contractHistory.clear();
  }
}

module.exports = ContractRegistry;
