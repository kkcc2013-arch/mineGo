'use strict';
const axios = require('axios');

// Executes the Joi provider contracts defined by REQ-00093. The registry-based
// runner for REQ-00547 remains a separate entry point.
class ProviderContractTestRunner {
  constructor({ baseUrl, timeout = 10000, fixtures = {} } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('A test API URL without embedded credentials is required');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = timeout;
    this.fixtures = fixtures;
    this.contracts = new Map();
  }

  registerContract(contract) {
    if (!contract?.name || typeof contract.getAllEndpoints !== 'function') {
      throw new Error('A provider ContractSchema is required');
    }
    this.contracts.set(contract.name, contract);
  }

  async runEndpoint(contract, endpoint) {
    const start = Date.now();
    const errors = [];
    const fixture = this.fixtures[contract.name]?.[`${endpoint.method} ${endpoint.path}`];
    const result = {endpoint: endpoint.key, method: endpoint.method, path: endpoint.path};
    try {
      if (!endpoint.response) throw new Error('Response schema is missing');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method) && !fixture) {
        throw new Error('An explicit test fixture is required for a mutating request');
      }
      const resolvedPath = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
        const value = fixture?.params?.[name];
        if (value === undefined) throw new Error(`Path fixture is missing: ${name}`);
        return encodeURIComponent(String(value));
      });
      if (!resolvedPath.startsWith('/') || resolvedPath.startsWith('//')) {
        throw new Error('Contract route must be an absolute API path');
      }
      if (endpoint.request) {
        const validation = contract.validateRequest(endpoint.method, endpoint.path, fixture?.body);
        if (validation.error) throw new Error(`Invalid request fixture: ${validation.error.message}`);
      }
      const response = await axios({
        url: `${this.baseUrl}${resolvedPath}`,
        method: endpoint.method,
        headers: fixture?.headers || {},
        params: fixture?.query,
        data: fixture?.body,
        timeout: this.timeout,
        maxRedirects: 0,
        validateStatus: () => true
      });
      if (response.status !== endpoint.expectedStatus) {
        errors.push({type: 'status_mismatch', expected: endpoint.expectedStatus, actual: response.status});
      }
      const validation = contract.validateResponse(endpoint.method, endpoint.path, response.data);
      if (validation.error) errors.push({type: 'schema_violation', message: validation.error.message});
    } catch (error) {
      errors.push({type: 'test_error', message: error.message});
    }
    return {...result, status: errors.length ? 'failed' : 'passed', passed: errors.length === 0, duration: Date.now() - start, errors};
  }

  async runAll() {
    const start = Date.now();
    if (this.contracts.size === 0) throw new Error('No provider contracts registered');
    const providers = [];
    for (const contract of this.contracts.values()) {
      const endpoints = contract.getAllEndpoints();
      if (endpoints.length === 0) throw new Error(`No endpoints registered for ${contract.name}`);
      const tests = [];
      for (const endpoint of endpoints) tests.push(await this.runEndpoint(contract, endpoint));
      const passed = tests.filter(test => test.passed).length;
      providers.push({provider: contract.name, version: contract.version, tests, total: tests.length, passed, failed: tests.length - passed});
    }
    return {
      timestamp: new Date().toISOString(), duration: Date.now() - start, providers,
      total: providers.reduce((sum, provider) => sum + provider.total, 0),
      passed: providers.reduce((sum, provider) => sum + provider.passed, 0),
      failed: providers.reduce((sum, provider) => sum + provider.failed, 0)
    };
  }
}
module.exports = ProviderContractTestRunner;
