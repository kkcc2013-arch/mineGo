# REQ-00093: API 契约测试系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00093 |
| 标题 | API 契约测试系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/tests/contract |
| 创建时间 | 2026-06-10 16:00 |

## 需求描述

建立完整的 API 契约测试体系，确保微服务间 API 接口的一致性和向后兼容性。通过契约测试，在服务独立部署时能够验证接口变更不会破坏下游消费者，实现真正的微服务独立开发与部署。

### 核心目标
1. **契约定义**：基于 OpenAPI 规范定义 API 契约
2. **契约验证**：提供方契约测试验证实现符合规范
3. **消费者驱动**：支持消费者驱动的契约测试模式
4. **兼容性检查**：自动检测 API 变更的向后兼容性
5. **CI/CD 集成**：契约测试集成到构建流程

## 技术方案

### 1. 契约定义层

```javascript
// backend/shared/contract/ContractSchema.js
const Joi = require('joi');

class ContractSchema {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.endpoints = new Map();
    this.schemas = new Map();
  }

  // 定义请求 Schema
  defineRequest(endpoint, schema) {
    this.endpoints.set(endpoint, {
      ...this.endpoints.get(endpoint),
      request: schema
    });
    return this;
  }

  // 定义响应 Schema
  defineResponse(endpoint, schema) {
    this.endpoints.set(endpoint, {
      ...this.endpoints.get(endpoint),
      response: schema
    });
    return this;
  }

  // 定义可复用 Schema
  defineSchema(name, schema) {
    this.schemas.set(name, schema);
    return this;
  }

  // 获取端点契约
  getContract(endpoint) {
    return this.endpoints.get(endpoint);
  }

  // 验证请求
  validateRequest(endpoint, data) {
    const contract = this.getContract(endpoint);
    if (!contract?.request) {
      throw new Error(`No request contract defined for ${endpoint}`);
    }
    return contract.request.validate(data);
  }

  // 验证响应
  validateResponse(endpoint, data) {
    const contract = this.getContract(endpoint);
    if (!contract?.response) {
      throw new Error(`No response contract defined for ${endpoint}`);
    }
    return contract.response.validate(data);
  }
}

// 导出契约管理器
module.exports = { ContractSchema };
```

### 2. 契约注册中心

```javascript
// backend/shared/contract/ContractRegistry.js
const fs = require('fs').promises;
const path = require('path');

class ContractRegistry {
  constructor() {
    this.contracts = new Map();
    this.consumerContracts = new Map(); // 消费者契约
    this.providers = new Map();
    this.compatibilityChecker = new CompatibilityChecker();
  }

  // 注册提供方契约
  registerProvider(serviceName, contract) {
    this.contracts.set(serviceName, contract);
    this.providers.set(serviceName, {
      name: serviceName,
      contract,
      registeredAt: new Date(),
      version: contract.version
    });
    console.log(`Registered provider contract: ${serviceName} v${contract.version}`);
  }

  // 注册消费者契约
  registerConsumer(consumerName, providerName, expectations) {
    const key = `${consumerName}->${providerName}`;
    this.consumerContracts.set(key, {
      consumer: consumerName,
      provider: providerName,
      expectations,
      registeredAt: new Date()
    });
    console.log(`Registered consumer contract: ${key}`);
  }

  // 验证提供方契约
  async verifyProvider(providerName) {
    const contract = this.contracts.get(providerName);
    if (!contract) {
      throw new Error(`No contract found for provider: ${providerName}`);
    }

    const results = {
      provider: providerName,
      timestamp: new Date(),
      passed: true,
      tests: []
    };

    // 遍历所有端点进行验证
    for (const [endpoint, schema] of contract.endpoints) {
      const testResult = await this.runProviderTest(providerName, endpoint, schema);
      results.tests.push(testResult);
      if (!testResult.passed) {
        results.passed = false;
      }
    }

    return results;
  }

  // 验证消费者契约
  async verifyConsumerExpectations(consumerName, providerName) {
    const key = `${consumerName}->${providerName}`;
    const consumerContract = this.consumerContracts.get(key);
    const providerContract = this.contracts.get(providerName);

    if (!consumerContract || !providerContract) {
      throw new Error(`Missing contract for ${key}`);
    }

    const results = {
      consumer: consumerName,
      provider: providerName,
      timestamp: new Date(),
      passed: true,
      mismatches: []
    };

    // 检查消费者期望是否被提供方满足
    for (const expectation of consumerContract.expectations) {
      const providerEndpoint = providerContract.endpoints.get(expectation.endpoint);
      
      if (!providerEndpoint) {
        results.mismatches.push({
          type: 'missing_endpoint',
          endpoint: expectation.endpoint,
          message: `Provider missing endpoint: ${expectation.endpoint}`
        });
        results.passed = false;
        continue;
      }

      // 验证响应结构匹配
      const compatibility = this.compatibilityChecker.checkSchemaCompatibility(
        expectation.responseSchema,
        providerEndpoint.response
      );

      if (!compatibility.compatible) {
        results.mismatches.push({
          type: 'schema_mismatch',
          endpoint: expectation.endpoint,
          details: compatibility.issues
        });
        results.passed = false;
      }
    }

    return results;
  }

  // 运行提供方测试
  async runProviderTest(providerName, endpoint, schema) {
    // 实现会调用实际服务端点验证
    return {
      endpoint,
      passed: true,
      duration: 0
    };
  }
}

module.exports = { ContractRegistry };
```

### 3. 兼容性检查器

```javascript
// backend/shared/contract/CompatibilityChecker.js
class CompatibilityChecker {
  constructor() {
    this.breakingChanges = [
      'required_field_added',
      'field_removed',
      'field_type_changed',
      'enum_value_removed',
      'endpoint_removed'
    ];
  }

  // 检查两个版本的兼容性
  checkCompatibility(oldContract, newContract) {
    const result = {
      compatible: true,
      breakingChanges: [],
      nonBreakingChanges: [],
      warnings: []
    };

    // 检查端点变更
    const endpointChanges = this.compareEndpoints(
      oldContract.endpoints,
      newContract.endpoints
    );

    result.breakingChanges.push(...endpointChanges.breaking);
    result.nonBreakingChanges.push(...endpointChanges.nonBreaking);

    // 检查 Schema 变更
    const schemaChanges = this.compareSchemas(
      oldContract.schemas,
      newContract.schemas
    );

    result.breakingChanges.push(...schemaChanges.breaking);
    result.nonBreakingChanges.push(...schemaChanges.nonBreaking);

    if (result.breakingChanges.length > 0) {
      result.compatible = false;
    }

    return result;
  }

  // 比较端点变更
  compareEndpoints(oldEndpoints, newEndpoints) {
    const changes = { breaking: [], nonBreaking: [] };

    // 检查删除的端点
    for (const [path, endpoint] of oldEndpoints) {
      if (!newEndpoints.has(path)) {
        changes.breaking.push({
          type: 'endpoint_removed',
          path,
          severity: 'critical'
        });
      }
    }

    // 检查新增端点（非破坏性）
    for (const [path, endpoint] of newEndpoints) {
      if (!oldEndpoints.has(path)) {
        changes.nonBreaking.push({
          type: 'endpoint_added',
          path
        });
      }
    }

    // 检查端点修改
    for (const [path, newEndpoint] of newEndpoints) {
      const oldEndpoint = oldEndpoints.get(path);
      if (oldEndpoint) {
        const schemaChanges = this.compareEndpointSchemas(
          oldEndpoint,
          newEndpoint
        );
        changes.breaking.push(...schemaChanges.breaking);
        changes.nonBreaking.push(...schemaChanges.nonBreaking);
      }
    }

    return changes;
  }

  // 比较 Schema 兼容性
  checkSchemaCompatibility(consumerSchema, providerSchema) {
    const result = {
      compatible: true,
      issues: []
    };

    // 检查消费者需要的字段提供方是否都有
    if (consumerSchema._flags?.presence === 'required') {
      const consumerKeys = this.extractKeys(consumerSchema);
      const providerKeys = this.extractKeys(providerSchema);

      for (const key of consumerKeys) {
        if (!providerKeys.has(key)) {
          result.issues.push({
            type: 'missing_field',
            field: key,
            message: `Provider missing required field: ${key}`
          });
          result.compatible = false;
        }
      }
    }

    return result;
  }

  // 提取 Joi Schema 的键
  extractKeys(schema) {
    const keys = new Set();
    if (schema._ids) {
      for (const id of schema._ids) {
        keys.add(id.key);
      }
    }
    return keys;
  }

  // 比较端点 Schema
  compareEndpointSchemas(oldEndpoint, newEndpoint) {
    const changes = { breaking: [], nonBreaking: [] };

    // 比较请求 Schema
    if (oldEndpoint.request && newEndpoint.request) {
      const requestChanges = this.compareJoiSchemas(
        oldEndpoint.request,
        newEndpoint.request
      );
      changes.breaking.push(...requestChanges.breaking);
      changes.nonBreaking.push(...requestChanges.nonBreaking);
    }

    // 比较响应 Schema
    if (oldEndpoint.response && newEndpoint.response) {
      const responseChanges = this.compareJoiSchemas(
        oldEndpoint.response,
        newEndpoint.response
      );
      changes.breaking.push(...responseChanges.breaking);
      changes.nonBreaking.push(...responseChanges.nonBreaking);
    }

    return changes;
  }

  // 比较 Joi Schema
  compareJoiSchemas(oldSchema, newSchema) {
    const changes = { breaking: [], nonBreaking: [] };
    
    // 简化实现，实际需要深度比较
    const oldKeys = this.extractKeys(oldSchema);
    const newKeys = this.extractKeys(newSchema);

    // 检查删除的字段（破坏性）
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        changes.breaking.push({
          type: 'field_removed',
          field: key,
          severity: 'high'
        });
      }
    }

    return changes;
  }
}

module.exports = { CompatibilityChecker };
```

### 4. 契约测试运行器

```javascript
// backend/tests/contract/ContractTestRunner.js
const axios = require('axios');
const { ContractRegistry } = require('../../shared/contract/ContractRegistry');
const { ContractSchema } = require('../../shared/contract/ContractSchema');

class ContractTestRunner {
  constructor(config = {}) {
    this.registry = new ContractRegistry();
    this.baseUrl = config.baseUrl || 'http://localhost:3000';
    this.timeout = config.timeout || 30000;
    this.results = [];
  }

  // 加载所有契约
  async loadContracts(contractDir) {
    const files = await fs.readdir(contractDir);
    
    for (const file of files) {
      if (file.endsWith('.contract.js')) {
        const contractPath = path.join(contractDir, file);
        const contract = require(contractPath);
        this.registry.registerProvider(contract.name, contract);
      }
    }
  }

  // 运行所有契约测试
  async runAll() {
    console.log('Starting contract tests...\n');
    
    const providers = Array.from(this.registry.contracts.keys());
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      duration: 0,
      tests: []
    };

    const startTime = Date.now();

    for (const provider of providers) {
      console.log(`Testing provider: ${provider}`);
      const providerResults = await this.runProviderTests(provider);
      results.tests.push(providerResults);
      results.total += providerResults.total;
      results.passed += providerResults.passed;
      results.failed += providerResults.failed;
    }

    results.duration = Date.now() - startTime;

    this.printSummary(results);
    return results;
  }

  // 运行提供方测试
  async runProviderTests(providerName) {
    const contract = this.registry.contracts.get(providerName);
    const results = {
      provider: providerName,
      total: 0,
      passed: 0,
      failed: 0,
      tests: []
    };

    for (const [endpoint, schema] of contract.endpoints) {
      const test = await this.runEndpointTest(
        providerName,
        endpoint,
        schema
      );
      results.tests.push(test);
      results.total++;
      if (test.passed) {
        results.passed++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  // 运行单个端点测试
  async runEndpointTest(provider, endpoint, schema) {
    const test = {
      endpoint,
      provider,
      passed: true,
      errors: [],
      duration: 0
    };

    const startTime = Date.now();

    try {
      // 发送请求
      const response = await axios({
        method: schema.method || 'GET',
        url: `${this.baseUrl}${endpoint}`,
        timeout: this.timeout,
        validateStatus: () => true // 接受所有状态码
      });

      // 验证响应状态码
      if (schema.expectedStatus && response.status !== schema.expectedStatus) {
        test.passed = false;
        test.errors.push({
          type: 'status_mismatch',
          expected: schema.expectedStatus,
          actual: response.status
        });
      }

      // 验证响应 Schema
      if (schema.response) {
        const validation = schema.response.validate(response.data);
        if (validation.error) {
          test.passed = false;
          test.errors.push({
            type: 'schema_violation',
            message: validation.error.message,
            details: validation.error.details
          });
        }
      }

    } catch (error) {
      test.passed = false;
      test.errors.push({
        type: 'request_failed',
        message: error.message
      });
    }

    test.duration = Date.now() - startTime;
    return test;
  }

  // 打印测试摘要
  printSummary(results) {
    console.log('\n' + '='.repeat(60));
    console.log('Contract Test Summary');
    console.log('='.repeat(60));
    console.log(`Total Tests:  ${results.total}`);
    console.log(`Passed:       ${results.passed} ✓`);
    console.log(`Failed:       ${results.failed} ✗`);
    console.log(`Duration:     ${results.duration}ms`);
    console.log('='.repeat(60));

    if (results.failed > 0) {
      console.log('\nFailed Tests:');
      for (const providerResult of results.tests) {
        for (const test of providerResult.tests) {
          if (!test.passed) {
            console.log(`  ✗ ${providerResult.provider}${test.endpoint}`);
            for (const error of test.errors) {
              console.log(`    - ${error.type}: ${error.message || JSON.stringify(error)}`);
            }
          }
        }
      }
    }
  }
}

module.exports = { ContractTestRunner };
```

### 5. 服务契约示例

```javascript
// backend/services/user-service/contracts/user.contract.js
const Joi = require('joi');
const { ContractSchema } = require('../../shared/contract/ContractSchema');

const userContract = new ContractSchema('user-service', '1.0.0');

// 定义通用 Schema
userContract.defineSchema('UserId', Joi.string().uuid());
userContract.defineSchema('Email', Joi.string().email());
userContract.defineSchema('Username', Joi.string().min(3).max(30).alphanum());

// 定义用户 Schema
userContract.defineSchema('User', Joi.object({
  id: Joi.string().uuid().required(),
  username: Joi.string().min(3).max(30).alphanum().required(),
  email: Joi.string().email().required(),
  level: Joi.number().integer().min(1).max(100).required(),
  experience: Joi.number().integer().min(0).required(),
  createdAt: Joi.date().iso().required(),
  updatedAt: Joi.date().iso().required()
}));

// 定义端点契约
userContract
  .defineRequest('/api/users/:id', Joi.object({
    id: Joi.string().uuid().required()
  }).unknown(true))
  .defineResponse('/api/users/:id', userContract.schemas.get('User'));

userContract
  .defineRequest('/api/users', Joi.object({
    username: Joi.string().min(3).max(30).alphanum().required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required()
  }))
  .defineResponse('/api/users', Joi.object({
    user: userContract.schemas.get('User'),
    token: Joi.string().required()
  }));

userContract
  .defineRequest('/api/users/me', Joi.object({}))
  .defineResponse('/api/users/me', userContract.schemas.get('User'));

module.exports = userContract;
```

### 6. 消费者契约示例

```javascript
// backend/services/social-service/contracts/user-consumer.contract.js
const Joi = require('joi');

const consumerExpectations = {
  consumer: 'social-service',
  provider: 'user-service',
  expectations: [
    {
      endpoint: '/api/users/:id',
      method: 'GET',
      responseSchema: Joi.object({
        id: Joi.string().uuid().required(),
        username: Joi.string().required(),
        level: Joi.number().required()
      }).unknown(true), // 允许额外字段
      required: true
    },
    {
      endpoint: '/api/users/me',
      method: 'GET',
      responseSchema: Joi.object({
        id: Joi.string().uuid().required(),
        username: Joi.string().required()
      }).unknown(true),
      required: true
    }
  ]
};

module.exports = consumerExpectations;
```

### 7. CI/CD 集成

```yaml
# .github/workflows/contract-tests.yml
name: Contract Tests

on:
  pull_request:
    paths:
      - 'backend/services/**'
      - 'backend/shared/**'
      - 'docs/api-spec/**'
  push:
    branches: [main]

jobs:
  contract-tests:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: minego_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run contract tests
        run: |
          npm run test:contract
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/minego_test
          REDIS_URL: redis://localhost:6379

      - name: Check API compatibility
        run: |
          npm run contract:check-compatibility
        if: github.event_name == 'pull_request'

      - name: Upload contract test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: contract-test-results
          path: |
            test-results/contract/
            contract-reports/
          retention-days: 30

      - name: Comment PR with results
        uses: actions/github-script@v7
        if: github.event_name == 'pull_request' && always()
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('contract-reports/summary.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## 📋 Contract Test Results\n\n${report}`
            });
```

### 8. 契约报告生成器

```javascript
// backend/tests/contract/ContractReportGenerator.js
const fs = require('fs').promises;
const path = require('path');

class ContractReportGenerator {
  constructor() {
    this.reports = [];
  }

  // 生成测试报告
  generateReport(results) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total: results.total,
        passed: results.passed,
        failed: results.failed,
        duration: results.duration,
        successRate: ((results.passed / results.total) * 100).toFixed(2)
      },
      providers: results.tests.map(provider => ({
        name: provider.provider,
        total: provider.total,
        passed: provider.passed,
        failed: provider.failed,
        tests: provider.tests.map(test => ({
          endpoint: test.endpoint,
          passed: test.passed,
          duration: test.duration,
          errors: test.errors
        }))
      }))
    };

    this.reports.push(report);
    return report;
  }

  // 生成 Markdown 报告
  async generateMarkdownReport(results, outputPath) {
    const lines = [];

    lines.push(`# API Contract Test Report`);
    lines.push(``);
    lines.push(`**Generated**: ${new Date().toISOString()}`);
    lines.push(``);

    // 摘要
    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Tests | ${results.total} |`);
    lines.push(`| Passed | ${results.passed} ✅ |`);
    lines.push(`| Failed | ${results.failed} ❌ |`);
    lines.push(`| Success Rate | ${((results.passed / results.total) * 100).toFixed(2)}% |`);
    lines.push(`| Duration | ${results.duration}ms |`);
    lines.push(``);

    // 各服务详情
    for (const provider of results.tests) {
      const status = provider.failed === 0 ? '✅' : '❌';
      lines.push(`## ${status} ${provider.provider}`);
      lines.push(``);
      lines.push(`| Endpoint | Status | Duration | Errors |`);
      lines.push(`|----------|--------|----------|--------|`);

      for (const test of provider.tests) {
        const testStatus = test.passed ? '✅' : '❌';
        const errors = test.errors.length > 0 
          ? test.errors.map(e => e.type).join(', ')
          : '-';
        lines.push(`| ${test.endpoint} | ${testStatus} | ${test.duration}ms | ${errors} |`);
      }
      lines.push(``);
    }

    await fs.writeFile(outputPath, lines.join('\n'));
  }

  // 生成 HTML 报告
  async generateHtmlReport(results, outputPath) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Contract Test Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; }
    .summary { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
    .provider { margin-bottom: 30px; }
    .provider h2 { display: flex; align-items: center; gap: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; }
    .pass { color: #22c55e; }
    .fail { color: #ef4444; }
    .error-list { font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <h1>API Contract Test Report</h1>
  <div class="summary">
    <strong>Total:</strong> ${results.total} |
    <strong class="pass">Passed:</strong> ${results.passed} |
    <strong class="fail">Failed:</strong> ${results.failed} |
    <strong>Duration:</strong> ${results.duration}ms
  </div>
  ${results.tests.map(provider => `
    <div class="provider">
      <h2>${provider.failed === 0 ? '✅' : '❌'} ${provider.provider}</h2>
      <table>
        <tr><th>Endpoint</th><th>Status</th><th>Duration</th><th>Errors</th></tr>
        ${provider.tests.map(test => `
          <tr>
            <td><code>${test.endpoint}</code></td>
            <td class="${test.passed ? 'pass' : 'fail'}">${test.passed ? '✅ Pass' : '❌ Fail'}</td>
            <td>${test.duration}ms</td>
            <td class="error-list">${test.errors.map(e => e.type).join(', ') || '-'}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `).join('')}
</body>
</html>`;

    await fs.writeFile(outputPath, html);
  }
}

module.exports = { ContractReportGenerator };
```

## 验收标准

- [ ] 契约 Schema 定义机制实现完成，支持 Joi Schema
- [ ] 提供方契约测试执行器实现完成
- [ ] 消费者驱动契约测试支持实现完成
- [ ] API 兼容性检查器实现完成，能检测破坏性变更
- [ ] 所有微服务契约定义完成（user、pokemon、social、catch、gym、reward）
- [ ] CI/CD 流水线集成契约测试
- [ ] 契约测试报告生成器实现（Markdown 和 HTML 格式）
- [ ] PR 检查时自动运行兼容性检查并评论结果
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 契约测试执行时间 < 60 秒

## 影响范围

- **新增文件**:
  - `backend/shared/contract/ContractSchema.js` - 契约 Schema 定义
  - `backend/shared/contract/ContractRegistry.js` - 契约注册中心
  - `backend/shared/contract/CompatibilityChecker.js` - 兼容性检查器
  - `backend/tests/contract/ContractTestRunner.js` - 测试运行器
  - `backend/tests/contract/ContractReportGenerator.js` - 报告生成器
  - `backend/services/*/contracts/*.contract.js` - 各服务契约定义

- **修改文件**:
  - `.github/workflows/contract-tests.yml` - CI 工作流
  - `backend/package.json` - 添加测试脚本

- **依赖服务**: gateway、所有微服务

## 参考

- [Pact - Consumer Driven Contracts](https://docs.pact.io/)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Spring Cloud Contract](https://spring.io/projects/spring-cloud-contract)
