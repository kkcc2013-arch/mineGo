# REQ-00257: API 回归测试自动化与 Breaking Change 检测系统

- **编号**: REQ-00257
- **类别**: 测试覆盖
- **优先级**: P1
- **状态**: new
- **涉及服务/模块**: gateway、所有微服务、backend/tests/regression、backend/shared/OpenAPIComparator.js、.github/workflows、docs/api-spec
- **创建时间**: 2026-06-18 13:05
- **依赖需求**: REQ-00008（OpenAPI 文档）、REQ-00044（API 版本管理）

## 1. 背景与问题

当前 mineGo 项目已有单元测试、集成测试和 E2E 测试覆盖，但缺乏系统化的 API 回归测试机制：

1. **Breaking Change 无感知**: API 接口变更（参数删除、类型变更、响应结构修改）时，无法自动检测是否破坏了向后兼容性，导致客户端集成问题频发
2. **回归测试成本高**: 每次发布前需要手动验证核心接口，耗时且易遗漏边界场景
3. **API 契约漂移**: OpenAPI 文档与实际实现不一致，文档更新滞后，影响前端开发和第三方集成
4. **历史性能基准缺失**: 无法对比新版本与旧版本的性能差异，性能退化问题难以发现

根据最近 3 次发布统计：
- 2 次 API Breaking Change 导致前端报错（DELETE /api/pokemon/batch 的响应格式变更）
- 1 次性能退化未及时发现（/api/location/nearby 延迟从 120ms 升至 350ms）
- OpenAPI 文档与实际 API 不一致率达到 15%

## 2. 目标

构建自动化的 API 回归测试与 Breaking Change 检测系统：

1. **自动检测 Breaking Change**: 对比新旧 OpenAPI 规范，自动识别破坏性变更并阻止合并
2. **契约测试自动化**: 基于真实请求/响应生成契约测试用例，持续验证 API 行为
3. **性能基准对比**: 每次发布对比关键接口性能，自动告警性能退化
4. **文档一致性校验**: 自动检测 OpenAPI 文档与实际实现的差异，生成修复建议
5. **零人工干预**: 集成到 CI/CD 流程，PR 阶段自动运行，问题代码无法合并

## 3. 范围

### 包含
- OpenAPI Breaking Change 检测器（参数删除、类型变更、必填字段新增等）
- API 契约测试生成器（基于真实流量采样）
- 性能基准对比工具（关键接口延迟、吞吐量、错误率）
- OpenAPI 文档一致性校验器
- CI/CD 集成（GitHub Actions workflow）
- 回归测试报告生成器
- Breaking Change 审批流程（允许显式标记允许的 Breaking Change）

### 不包含
- 前端组件回归测试（由 REQ-00036 E2E 测试覆盖）
- 数据库迁移影响分析（由 REQ-00223 覆盖）
- 第三方 API 依赖的契约测试（由 REQ-00049 SDK 抽象层覆盖）

## 4. 详细需求

### 4.1 OpenAPI Breaking Change 检测器

```javascript
// backend/shared/OpenAPIComparator.js
class OpenAPIBreakingChangeDetector {
  /**
   * 对比两个 OpenAPI 规范，检测 Breaking Change
   * @param {Object} oldSpec - 旧版本 OpenAPI 规范
   * @param {Object} newSpec - 新版本 OpenAPI 规范
   * @returns {Array<BreakingChange>} 检测到的破坏性变更列表
   */
  compare(oldSpec, newSpec) {
    const breakingChanges = [];
    
    // 遍历所有路径
    for (const [path, methods] of Object.entries(oldSpec.paths || {})) {
      for (const [method, oldOp] of Object.entries(methods)) {
        const newOp = newSpec.paths?.[path]?.[method];
        
        if (!newOp) {
          // Breaking Change: 操作被删除
          breakingChanges.push({
            type: 'OPERATION_REMOVED',
            severity: 'critical',
            path,
            method,
            message: `${method.toUpperCase()} ${path} 被删除`,
          });
          continue;
        }
        
        // 检查参数变更
        breakingChanges.push(...this.checkParameterChanges(oldOp, newOp, path, method));
        
        // 检查响应变更
        breakingChanges.push(...this.checkResponseChanges(oldOp, newOp, path, method));
        
        // 检查请求体变更
        breakingChanges.push(...this.checkRequestBodyChanges(oldOp, newOp, path, method));
      }
    }
    
    return breakingChanges;
  }
  
  checkParameterChanges(oldOp, newOp, path, method) {
    const changes = [];
    const oldParams = oldOp.parameters || [];
    const newParams = newOp.parameters || [];
    
    for (const oldParam of oldParams) {
      const newParam = newParams.find(p => p.name === oldParam.name && p.in === oldParam.in);
      
      if (!newParam) {
        // Breaking Change: 参数被删除
        changes.push({
          type: 'PARAMETER_REMOVED',
          severity: oldParam.required ? 'critical' : 'warning',
          path,
          method,
          parameter: oldParam.name,
          message: `参数 ${oldParam.name} (${oldParam.in}) 被删除`,
        });
        continue;
      }
      
      // 检查类型变更
      if (oldParam.schema?.type !== newParam.schema?.type) {
        changes.push({
          type: 'PARAMETER_TYPE_CHANGED',
          severity: 'critical',
          path,
          method,
          parameter: oldParam.name,
          oldType: oldParam.schema?.type,
          newType: newParam.schema?.type,
          message: `参数 ${oldParam.name} 类型从 ${oldParam.schema?.type} 变更为 ${newParam.schema?.type}`,
        });
      }
      
      // 检查必填变更
      if (!oldParam.required && newParam.required) {
        changes.push({
          type: 'PARAMETER_BECAME_REQUIRED',
          severity: 'critical',
          path,
          method,
          parameter: oldParam.name,
          message: `参数 ${oldParam.name} 从可选变为必填`,
        });
      }
    }
    
    return changes;
  }
  
  checkResponseChanges(oldOp, newOp, path, method) {
    const changes = [];
    
    for (const [status, oldResponse] of Object.entries(oldOp.responses || {})) {
      const newResponse = newOp.responses?.[status];
      
      if (!newResponse) {
        changes.push({
          type: 'RESPONSE_REMOVED',
          severity: 'critical',
          path,
          method,
          statusCode: status,
          message: `响应状态码 ${status} 被删除`,
        });
        continue;
      }
      
      // 检查响应体字段删除
      const oldSchema = oldResponse.content?.['application/json']?.schema;
      const newSchema = newResponse.content?.['application/json']?.schema;
      
      if (oldSchema && newSchema) {
        changes.push(...this.checkSchemaChanges(oldSchema, newSchema, path, method, status));
      }
    }
    
    return changes;
  }
  
  checkSchemaChanges(oldSchema, newSchema, path, method, status) {
    const changes = [];
    
    if (oldSchema.type === 'object' && newSchema.type === 'object') {
      const oldProps = oldSchema.properties || {};
      const newProps = newSchema.properties || {};
      
      for (const [propName, oldProp] of Object.entries(oldProps)) {
        const newProp = newProps[propName];
        
        if (!newProp) {
          changes.push({
            type: 'RESPONSE_PROPERTY_REMOVED',
            severity: 'critical',
            path,
            method,
            statusCode: status,
            property: propName,
            message: `响应字段 ${propName} 被删除`,
          });
        }
      }
    }
    
    return changes;
  }
}

module.exports = OpenAPIBreakingChangeDetector;
```

### 4.2 API 契约测试生成器

```javascript
// backend/tests/regression/contractTestGenerator.js
const fs = require('fs').promises;
const path = require('path');

class ContractTestGenerator {
  /**
   * 基于真实请求/响应生成契约测试用例
   * @param {Array<APICall>} samples - 从日志采样的真实 API 调用
   */
  async generateTests(samples) {
    const testCases = [];
    
    for (const sample of samples) {
      const testCase = await this.generateTestCase(sample);
      testCases.push(testCase);
    }
    
    // 写入测试文件
    const testFile = this.generateTestFile(testCases);
    await fs.writeFile(
      path.join(__dirname, 'generated', `${testCases[0].endpoint.replace(/\//g, '_')}.test.js`),
      testFile
    );
  }
  
  async generateTestCase(sample) {
    const { method, path, request, response, statusCode } = sample;
    
    return {
      name: `${method.toUpperCase()} ${path} - 契约测试`,
      endpoint: path,
      method,
      request: {
        headers: this.sanitizeHeaders(request.headers),
        query: request.query,
        body: this.sanitizeBody(request.body),
      },
      expect: {
        statusCode,
        bodySchema: this.inferSchema(response),
        responseTime: { max: 500 }, // 性能契约
      },
    };
  }
  
  inferSchema(obj) {
    if (obj === null) return { type: 'null' };
    if (typeof obj === 'boolean') return { type: 'boolean' };
    if (typeof obj === 'number') return { type: 'number' };
    if (typeof obj === 'string') return { type: 'string' };
    
    if (Array.isArray(obj)) {
      return {
        type: 'array',
        items: obj.length > 0 ? this.inferSchema(obj[0]) : {},
      };
    }
    
    if (typeof obj === 'object') {
      const properties = {};
      for (const [key, value] of Object.entries(obj)) {
        properties[key] = this.inferSchema(value);
      }
      return { type: 'object', properties };
    }
    
    return {};
  }
  
  generateTestFile(testCases) {
    return `// 自动生成的契约测试 - ${new Date().toISOString()}
const request = require('supertest');
const app = require('../../../gateway/src/app');

describe('API 契约测试', () => {
${testCases.map(tc => `
  it('${tc.name}', async () => {
    const res = await request(app)
      .${tc.method}('${tc.endpoint}')
      ${tc.request.query ? `.query(${JSON.stringify(tc.request.query)})` : ''}
      ${tc.request.body ? `.send(${JSON.stringify(tc.request.body)})` : ''}
      .set('Authorization', 'Bearer test-token');
    
    expect(res.status).toBe(${tc.expect.statusCode});
    expect(res.body).toMatchObject(${JSON.stringify(tc.expect.bodySchema)});
    expect(res.headers['x-response-time']).toBeLessThan(${tc.expect.responseTime.max});
  });
`).join('\n')}
});
`;
  }
}

module.exports = ContractTestGenerator;
```

### 4.3 性能基准对比工具

```javascript
// backend/tests/regression/performanceBenchmark.js
class PerformanceBenchmark {
  constructor() {
    this.baselineDir = path.join(__dirname, 'baselines');
    this.endpoints = [
      { method: 'GET', path: '/api/location/nearby', maxLatency: 200 },
      { method: 'GET', path: '/api/pokemon/list', maxLatency: 150 },
      { method: 'POST', path: '/api/catch/attempt', maxLatency: 300 },
      { method: 'GET', path: '/api/gym/battle', maxLatency: 250 },
      { method: 'GET', path: '/api/social/leaderboard', maxLatency: 180 },
    ];
  }
  
  /**
   * 运行性能基准测试
   * @returns {Promise<PerformanceReport>}
   */
  async runBenchmark() {
    const results = [];
    
    for (const endpoint of this.endpoints) {
      const metrics = await this.measureEndpoint(endpoint);
      results.push({
        ...endpoint,
        ...metrics,
        regression: metrics.p95Latency > endpoint.maxLatency,
      });
    }
    
    // 对比历史基准
    const baseline = await this.loadBaseline();
    const comparison = this.compareWithBaseline(results, baseline);
    
    return {
      timestamp: new Date().toISOString(),
      results,
      comparison,
      passed: results.every(r => !r.regression),
    };
  }
  
  async measureEndpoint(endpoint) {
    const samples = [];
    const iterations = 100;
    
    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      await this.makeRequest(endpoint);
      const end = process.hrtime.bigint();
      
      samples.push(Number(end - start) / 1e6); // 转换为毫秒
    }
    
    return {
      avgLatency: this.average(samples),
      p50Latency: this.percentile(samples, 50),
      p95Latency: this.percentile(samples, 95),
      p99Latency: this.percentile(samples, 99),
      throughput: iterations / (this.sum(samples) / 1000), // req/s
    };
  }
  
  compareWithBaseline(current, baseline) {
    if (!baseline) return null;
    
    return current.map((curr, i) => {
      const base = baseline[i];
      if (!base) return null;
      
      const latencyChange = ((curr.p95Latency - base.p95Latency) / base.p95Latency) * 100;
      
      return {
        endpoint: curr.path,
        baselineP95: base.p95Latency,
        currentP95: curr.p95Latency,
        latencyChange: latencyChange.toFixed(2) + '%',
        degraded: latencyChange > 20, // 性能退化超过 20%
      };
    });
  }
  
  async saveBaseline(results) {
    await fs.writeFile(
      path.join(this.baselineDir, `baseline-${Date.now()}.json`),
      JSON.stringify(results, null, 2)
    );
  }
  
  percentile(arr, p) {
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index];
  }
  
  average(arr) {
    return this.sum(arr) / arr.length;
  }
  
  sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  }
}

module.exports = PerformanceBenchmark;
```

### 4.4 OpenAPI 文档一致性校验器

```javascript
// backend/tests/regression/openapiConsistencyChecker.js
class OpenAPIConsistencyChecker {
  /**
   * 校验 OpenAPI 文档与实际实现的一致性
   * @param {Object} spec - OpenAPI 规范
   * @param {Express} app - Express 应用实例
   * @returns {Promise<Array<Inconsistency>>}
   */
  async check(spec, app) {
    const inconsistencies = [];
    
    // 检查文档中声明的路由是否实际存在
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const method of Object.keys(methods)) {
        const exists = await this.routeExists(app, method, path);
        if (!exists) {
          inconsistencies.push({
            type: 'DOCUMENTED_ROUTE_NOT_IMPLEMENTED',
            severity: 'warning',
            path,
            method,
            message: `文档声明的路由 ${method.toUpperCase()} ${path} 未实现`,
          });
        }
      }
    }
    
    // 检查实际路由是否都在文档中声明
    const actualRoutes = this.extractRoutes(app);
    for (const route of actualRoutes) {
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
    
    // 检查响应格式一致性
    inconsistencies.push(...await this.checkResponseFormat(spec, app));
    
    return inconsistencies;
  }
  
  extractRoutes(app) {
    const routes = [];
    
    function walk(stack, basePath = '') {
      for (const layer of stack) {
        if (layer.route) {
          for (const method of Object.keys(layer.route.methods)) {
            routes.push({
              method,
              path: basePath + layer.route.path,
            });
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(layer.handle.stack, basePath + (layer.regexp?.source?.replace(/\\/g, '') || ''));
        }
      }
    }
    
    walk(app._router.stack);
    return routes;
  }
  
  isDocumented(spec, method, path) {
    // 将 Express 路径参数 :id 转换为 OpenAPI 格式 {id}
    const openapiPath = path.replace(/:(\w+)/g, '{$1}');
    return spec.paths?.[openapiPath]?.[method.toLowerCase()] !== undefined;
  }
  
  async routeExists(app, method, path) {
    // 将 OpenAPI 路径参数 {id} 转换为 Express 格式 :id
    const expressPath = path.replace(/\{(\w+)\}/g, ':$1');
    
    // 检查路由是否存在
    const routes = this.extractRoutes(app);
    return routes.some(r => r.method === method.toLowerCase() && r.path === expressPath);
  }
  
  async checkResponseFormat(spec, app) {
    const inconsistencies = [];
    
    // 对关键接口发送测试请求，验证响应格式
    const testCases = [
      { method: 'get', path: '/api/pokemon/list', statusCode: 200 },
      { method: 'get', path: '/api/location/nearby', statusCode: 200 },
    ];
    
    for (const tc of testCases) {
      const res = await request(app)[tc.method](tc.path);
      const schema = spec.paths?.[tc.path]?.[tc.method]?.responses?.[tc.statusCode]
        ?.content?.['application/json']?.schema;
      
      if (schema) {
        const valid = this.validateSchema(res.body, schema);
        if (!valid) {
          inconsistencies.push({
            type: 'RESPONSE_SCHEMA_MISMATCH',
            severity: 'error',
            path: tc.path,
            method: tc.method,
            statusCode: tc.statusCode,
            message: `响应格式与 OpenAPI schema 不一致`,
          });
        }
      }
    }
    
    return inconsistencies;
  }
}

module.exports = OpenAPIConsistencyChecker;
```

### 4.5 CI/CD 集成（GitHub Actions）

```yaml
# .github/workflows/api-regression-test.yml
name: API Regression Test

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  breaking-change-detection:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 获取完整历史用于对比
      
      - name: 安装依赖
        run: npm ci
      
      - name: 检测 OpenAPI Breaking Change
        run: |
          node backend/tests/regression/detectBreakingChanges.js \
            --old docs/api-spec/openapi-base.yaml \
            --new docs/api-spec/openapi.yaml \
            --output breaking-changes.json
      
      - name: 检查 Breaking Change
        id: check-breaking
        run: |
          BREAKING=$(cat breaking-changes.json | jq 'map(select(.severity == "critical")) | length')
          echo "breaking_count=$BREAKING" >> $GITHUB_OUTPUT
          if [ "$BREAKING" -gt 0 ]; then
            echo "::error::检测到 $BREAKING 个 Breaking Change"
            cat breaking-changes.json | jq '.[] | select(.severity == "critical")'
          fi
      
      - name: 上传 Breaking Change 报告
        if: steps.check-breaking.outputs.breaking_count > 0
        uses: actions/upload-artifact@v4
        with:
          name: breaking-changes-report
          path: breaking-changes.json
      
      - name: 阻止合并（如果有 Breaking Change）
        if: steps.check-breaking.outputs.breaking_count > 0
        run: exit 1

  performance-benchmark:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
    
    steps:
      - uses: actions/checkout@v4
      
      - name: 安装依赖
        run: npm ci
      
      - name: 运行性能基准测试
        run: |
          node backend/tests/regression/runPerformanceBenchmark.js \
            --output performance-report.json
      
      - name: 对比性能基准
        run: |
          node backend/tests/regression/comparePerformance.js \
            --current performance-report.json \
            --baseline baselines/latest.json \
            --threshold 20
      
      - name: 上传性能报告
        uses: actions/upload-artifact@v4
        with:
          name: performance-report
          path: performance-report.json

  openapi-consistency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: 安装依赖
        run: npm ci
      
      - name: 校验 OpenAPI 一致性
        run: |
          node backend/tests/regression/checkOpenAPIConsistency.js \
            --spec docs/api-spec/openapi.yaml \
            --output consistency-report.json
      
      - name: 检查一致性
        run: |
          ERRORS=$(cat consistency-report.json | jq 'map(select(.severity == "error")) | length')
          if [ "$ERRORS" -gt 0 ]; then
            echo "::error::OpenAPI 文档与实现不一致"
            cat consistency-report.json | jq '.[] | select(.severity == "error")'
            exit 1
          fi
```

### 4.6 Breaking Change 审批流程

```javascript
// backend/tests/regression/breakingChangeApproval.js
class BreakingChangeApproval {
  /**
   * 处理 Breaking Change 审批
   * 允许通过配置文件显式允许特定的 Breaking Change
   */
  constructor() {
    this.approvalFile = path.join(__dirname, 'approved-breaking-changes.json');
  }
  
  /**
   * 检查 Breaking Change 是否已被批准
   * @param {BreakingChange} change 
   * @returns {Promise<boolean>}
   */
  async isApproved(change) {
    const approvals = await this.loadApprovals();
    
    return approvals.some(approval => 
      approval.type === change.type &&
      approval.path === change.path &&
      approval.method === change.method &&
      approval.approvedBy &&
      approval.approvedAt &&
      new Date(approval.expiresAt) > new Date()
    );
  }
  
  /**
   * 添加 Breaking Change 审批
   * @param {BreakingChange} change 
   * @param {string} approvedBy - 审批人
   * @param {string} reason - 审批理由
   */
  async approve(change, approvedBy, reason) {
    const approvals = await this.loadApprovals();
    
    approvals.push({
      ...change,
      approvedBy,
      reason,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 天有效期
    });
    
    await this.saveApprovals(approvals);
  }
  
  async loadApprovals() {
    try {
      const content = await fs.readFile(this.approvalFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }
  
  async saveApprovals(approvals) {
    await fs.writeFile(this.approvalFile, JSON.stringify(approvals, null, 2));
  }
}

module.exports = BreakingChangeApproval;
```

### 4.7 回归测试报告生成器

```javascript
// backend/tests/regression/reportGenerator.js
class RegressionReportGenerator {
  async generateReport(results) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalChecks: results.breakingChanges.length + results.consistencyIssues.length,
        criticalIssues: results.breakingChanges.filter(c => c.severity === 'critical').length,
        warnings: results.breakingChanges.filter(c => c.severity === 'warning').length,
        performanceRegressions: results.performance.comparison?.filter(c => c.degraded).length || 0,
      },
      breakingChanges: results.breakingChanges,
      consistencyIssues: results.consistencyIssues,
      performance: results.performance,
      recommendations: this.generateRecommendations(results),
    };
    
    // 生成 Markdown 报告
    const markdown = this.generateMarkdown(report);
    await fs.writeFile(path.join(__dirname, 'reports', `regression-${Date.now()}.md`), markdown);
    
    return report;
  }
  
  generateRecommendations(results) {
    const recommendations = [];
    
    // Breaking Change 建议
    const criticalBreaking = results.breakingChanges.filter(c => c.severity === 'critical');
    if (criticalBreaking.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'breaking-change',
        message: `检测到 ${criticalBreaking.length} 个 Breaking Change，建议：\n` +
          '1. 评估影响范围并更新客户端代码\n' +
          '2. 如确需变更，在 approved-breaking-changes.json 中添加审批记录\n' +
          '3. 更新 API 版本号并发布迁移指南',
      });
    }
    
    // 性能退化建议
    const degraded = results.performance.comparison?.filter(c => c.degraded) || [];
    if (degraded.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'performance',
        message: `${degraded.length} 个接口性能退化超过 20%，建议：\n` +
          '1. 检查最近的代码变更\n' +
          '2. 分析数据库查询计划\n' +
          '3. 考虑添加缓存或优化索引',
      });
    }
    
    // 文档一致性建议
    const undocumented = results.consistencyIssues.filter(i => i.type === 'IMPLEMENTED_ROUTE_NOT_DOCUMENTED');
    if (undocumented.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'documentation',
        message: `${undocumented.length} 个路由未在 OpenAPI 文档中声明，建议补充文档`,
      });
    }
    
    return recommendations;
  }
  
  generateMarkdown(report) {
    return `# API 回归测试报告

**生成时间**: ${report.timestamp}

## 摘要

| 指标 | 数量 |
|------|------|
| 总检查项 | ${report.summary.totalChecks} |
| 严重问题 | ${report.summary.criticalIssues} |
| 警告 | ${report.summary.warnings} |
| 性能退化 | ${report.summary.performanceRegressions} |

## Breaking Change

${report.breakingChanges.length > 0 
  ? report.breakingChanges.map(c => 
      `- **${c.severity.toUpperCase()}**: ${c.message}\n  - 路径: ${c.method.toUpperCase()} ${c.path}`
    ).join('\n')
  : '✅ 未检测到 Breaking Change'}

## 性能基准

| 接口 | P95 延迟 | 基准 | 变化 | 状态 |
|------|---------|------|------|------|
${report.performance.results.map(r => 
  `| ${r.method.toUpperCase()} ${r.path} | ${r.p95Latency.toFixed(2)}ms | ${r.maxLatency}ms | - | ${r.regression ? '❌' : '✅'} |`
).join('\n')}

## 建议

${report.recommendations.map(r => 
  `### ${r.category} (${r.priority})\n${r.message}`
).join('\n\n')}
`;
  }
}

module.exports = RegressionReportGenerator;
```

## 5. 验收标准（可测试）

- [ ] Breaking Change 检测：删除 GET /api/pokemon/:id 的 id 参数时，检测器报告 `PARAMETER_REMOVED` 严重级别为 `critical`
- [ ] Breaking Change 检测：将响应字段 name 类型从 string 改为 number 时，检测器报告 `RESPONSE_PROPERTY_TYPE_CHANGED`
- [ ] Breaking Change 检测：将可选参数改为必填时，检测器报告 `PARAMETER_BECAME_REQUIRED`
- [ ] 契约测试生成：基于真实请求生成 Jest 测试文件，测试通过率 100%
- [ ] 性能基准对比：/api/location/nearby P95 延迟从 120ms 升至 250ms 时，报告性能退化 108%
- [ ] 文档一致性校验：新增路由但未更新 OpenAPI 文档时，报告 `IMPLEMENTED_ROUTE_NOT_DOCUMENTED`
- [ ] CI/CD 集成：PR 包含 Breaking Change 时，GitHub Actions 检查失败并阻止合并
- [ ] Breaking Change 审批：在 approved-breaking-changes.json 中添加审批后，CI 检查通过
- [ ] 报告生成：生成 Markdown 格式的回归测试报告，包含摘要、详情和建议
- [ ] 零误报：正常 API 变更（添加可选参数、添加响应字段）不触发 Breaking Change 告警

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现 4 个核心组件（Breaking Change 检测器、契约测试生成器、性能基准对比、文档一致性校验）
- 需要深度解析 OpenAPI 规范，实现完整的语义对比逻辑
- 需要集成到 CI/CD 流程，涉及 GitHub Actions workflow 编写
- 需要实现 Breaking Change 审批流程和报告生成器
- 需要编写全面的测试用例覆盖各种变更场景

预计工时：3-4 天

## 7. 优先级理由

**P1 理由**：

1. **质量保障基础**：API 回归测试是持续交付的核心质量门禁，防止破坏性变更影响生产环境
2. **历史问题驱动**：最近 3 次发布中有 2 次 Breaking Change 导致前端报错，急需自动化检测
3. **生产就绪要求**：项目已进入 P1 阶段，API 稳定性是生产部署的前提条件
4. **依赖已就绪**：REQ-00008（OpenAPI 文档）和 REQ-00044（API 版本管理）已完成
5. **影响范围广**：涉及所有 API 端点，对整体 API 质量和开发效率有重大提升
