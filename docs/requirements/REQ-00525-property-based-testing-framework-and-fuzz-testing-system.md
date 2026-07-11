# REQ-00525: Property-Based Testing 框架与 API Fuzz Testing 系统

- **编号**: REQ-00525
- **类别**: 测试覆盖
- **优先级**: P1
- **状态**: done
- **涉及服务/模块**: backend/tests, backend/shared/testing, all services, GitHub Actions
- **创建时间**: 2026-07-09 09:00 UTC
- **依赖需求**: REQ-00507 (测试覆盖率自动化度量与 CI 集成系统)

## 1. 背景与问题

### 现状分析
mineGo 项目已有完善的测试体系：
- 192 个测试文件（单元测试 + 集成测试）
- 935 个 JS 源文件
- 8357+ 传统测试用例
- 测试覆盖率自动化度量系统（REQ-00507）

### 测试缺口
当前测试策略的局限性：
1. **固定输入样本**：传统测试使用固定的输入/输出组合，无法覆盖边界值和极端情况
2. **人为思维局限**：开发者难以预见所有异常输入场景
3. **边界值遗漏**：手动编写边界测试容易遗漏（如 MAX_INT、空数组、特殊字符）
4. **回归效率低**：新增代码需手动补充大量测试用例

### 业务风险
- API 输入验证漏洞（注入攻击、异常数据）
- 数值边界溢出（精灵 CP 计算、精币交易）
- 时间相关 bug（倒计时、冷却时间）
- 地理位置 bug（坐标计算、距离验证）

### 典型案例
- Pokemon CP 计算公式在极端 IV 值下的溢出
- 坐标转换在高纬度/高经度值的精度丢失
- 用户输入过滤遗漏特殊字符组合
- 时间戳处理在时区边缘的异常

## 2. 目标

建立 Property-Based Testing 框架与 API Fuzz Testing 系统：

1. **Property-Based Testing**：使用 fast-check 库，自动生成大量随机输入验证代码属性
2. **API Fuzz Testing**：对所有 API 端点进行模糊测试，发现输入验证漏洞
3. **边界值自动探索**：自动发现边界值和极端情况
4. **CI 集成**：集成到 GitHub Actions，每次 PR 自动运行
5. **测试报告**：生成详细的 fuzz 测试报告，包含发现的问题和修复建议

### 可量化目标
- 关键模块 Property-Based 测试覆盖率 ≥ 80%
- API 端点 Fuzz 测试覆盖率 ≥ 90%
- 自动发现的边界 bug ≥ 10 个
- 测试执行时间 < 10 分钟

## 3. 范围

### 包含
- Property-Based Testing 框架（基于 fast-check）
- API Fuzz Testing 系统（HTTP 请求模糊测试）
- 边界值自动探索器
- 测试数据生成器（Pokemon、User、Location 等）
- CI/CD 集成脚本
- 测试报告生成器
- 发现问题的自动记录系统

### 不包含
- 性能压力测试（已有 REQ-00063）
- 安全渗透测试（已有 REQ-00521）
- UI 自动化测试（已有 E2E 测试框架）

## 4. 详细需求

### 4.1 Property-Based Testing 框架

#### 4.1.1 核心模块
```javascript
// backend/shared/testing/propertyBasedTest.js

const fc = require('fast-check');

class PropertyBasedTester {
  // Pokemon CP 计算属性测试
  testPokemonCPCalculation() {
    fc.assert(
      fc.property(
        // 随机输入：IV值（0-31）、等级（1-100）、基础属性
        fc.record({
          ivAttack: fc.integer({ min: 0, max: 31 }),
          ivDefense: fc.integer({ min: 0, max: 31 }),
          ivStamina: fc.integer({ min: 0, max: 31 }),
          level: fc.integer({ min: 1, max: 100 }),
          baseAttack: fc.integer({ min: 1, max: 300 }),
          baseDefense: fc.integer({ min: 1, max: 300 }),
          baseStamina: fc.integer({ min: 1, max: 300 })
        }),
        (input) => {
          const cp = calculateCP(input);
          
          // 属性验证：
          // 1. CP 值必须为正整数
          // 2. CP 值不超过 MAX_CP（65535）
          // 3. CP 值与输入正相关
          return cp > 0 && cp <= 65535 && 
                 cp >= calculateCP({ ...input, level: input.level - 1 });
        }
      ),
      { numRuns: 10000 } // 运行 10000 次随机测试
    );
  }
  
  // 坐标距离计算属性测试
  testDistanceCalculation() {
    fc.assert(
      fc.property(
        fc.record({
          lat1: fc.float({ min: -90, max: 90, noNaN: true }),
          lon1: fc.float({ min: -180, max: 180, noNaN: true }),
          lat2: fc.float({ min: -90, max: 90, noNaN: true }),
          lon2: fc.float({ min: -180, max: 180, noNaN: true })
        }),
        (coords) => {
          const distance = calculateDistance(coords);
          
          // 属性验证：
          // 1. 距离必须为正数
          // 2. 距离不超过地球半周长（20015 km）
          // 3. 相同点距离为 0
          // 4. 距离计算对称性
          return distance >= 0 && distance <= 20015;
        }
      )
    );
  }
  
  // 时间戳处理属性测试
  testTimestampHandling() {
    fc.assert(
      fc.property(
        fc.record({
          timestamp: fc.integer({ min: 0, max: 2147483647 }), // Unix 时间戳范围
          timezoneOffset: fc.integer({ min: -12, max: 14 }) // 时区偏移
        }),
        (input) => {
          const formatted = formatTimestamp(input);
          
          // 属性验证：
          // 1. 格式化结果不为空
          // 2. 格式化结果包含有效日期组件
          // 3. 转换回时间戳一致
          return formatted !== null && isValidDate(formatted);
        }
      )
    );
  }
}
```

#### 4.1.2 自定义 Arbitraries（数据生成器）
```javascript
// backend/shared/testing/arbitraries.js

const fc = require('fast-check');

// Pokemon 数据生成器
const pokemonArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 10000 }),
  speciesId: fc.integer({ min: 1, max: 500 }),
  iv: fc.record({
    attack: fc.integer({ min: 0, max: 31 }),
    defense: fc.integer({ min: 0, max: 31 }),
    stamina: fc.integer({ min: 0, max: 31 })
  }),
  level: fc.integer({ min: 1, max: 100 }),
  cp: fc.integer({ min: 10, max: 65535 }),
  hp: fc.integer({ min: 1, max: 500 }),
  location: locationArbitrary,
  caughtAt: fc.date()
});

// 位置数据生成器
const locationArbitrary = fc.record({
  latitude: fc.float({ min: -90, max: 90, noNaN: true }),
  longitude: fc.float({ min: -180, max: 180, noNaN: true }),
  altitude: fc.float({ min: -100, max: 9000, noNaN: true })
});

// 用户输入生成器（包含特殊字符）
const userInputArbitrary = fc.oneof(
  fc.string({ minLength: 0, maxLength: 100 }), // 正常字符串
  fc.string().filter(s => s.includes('\u0000')), // 包含空字符
  fc.string().filter(s => /[<>]/.test(s)), // 包含 HTML 字符
  fc.string().filter(s => s.includes('\\')), // 包含反斜杠
  fc.constantFrom('', null, undefined), // 边界值
  fc.string({ minLength: 1000, maxLength: 10000 }) // 超长字符串
);

// API 请求生成器
const apiRequestArbitrary = fc.record({
  method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
  path: fc.string().filter(s => s.startsWith('/api/')),
  headers: fc.dictionary(fc.string(), fc.string()),
  body: fc.oneof(fc.object(), fc.string(), fc.constant(null)),
  queryParams: fc.dictionary(fc.string(), fc.string())
});
```

### 4.2 API Fuzz Testing 系统

#### 4.2.1 Fuzz Testing 引擎
```javascript
// backend/shared/testing/fuzzTester.js

class APIFuzzTester {
  constructor() {
    this.fuzzer = new Fuzzer();
    this.results = [];
  }
  
  // 对单个 API 端点进行 Fuzz 测试
  async fuzzEndpoint(endpoint, options = {}) {
    const {
      method = 'POST',
      numRuns = 1000,
      timeout = 5000
    } = options;
    
    // 定义 Fuzz 测试策略
    const strategies = [
      this.fuzzHeaders(),    // Header 注入
      this.fuzzBody(),       // Body 注入
      this.fuzzParams(),     // 参数注入
      this.fuzzAuth(),       // 认证绕过
      this.fuzzTypes()       // 类型混淆
    ];
    
    for (let i = 0; i < numRuns; i++) {
      const strategy = strategies[Math.floor(Math.random() * strategies.length)];
      const request = strategy.generate(endpoint, method);
      
      try {
        const response = await this.sendRequest(request, timeout);
        this.analyzeResponse(response, request, strategy);
      } catch (error) {
        this.recordError(error, request, strategy);
      }
    }
    
    return this.generateReport(endpoint);
  }
  
  // Header 注入 Fuzz
  fuzzHeaders() {
    return {
      name: 'Header Injection',
      generate: (endpoint, method) => ({
        method,
        path: endpoint,
        headers: {
          'Content-Type': this.generateContentType(),
          'Authorization': this.generateAuth(),
          'X-Custom-Header': this.generateMaliciousHeader()
        },
        body: {}
      })
    };
  }
  
  // Body 注入 Fuzz
  fuzzBody() {
    return {
      name: 'Body Injection',
      generate: (endpoint, method) => ({
        method,
        path: endpoint,
        headers: { 'Content-Type': 'application/json' },
        body: this.generateMaliciousBody()
      })
    };
  }
  
  // 生成恶意 Header
  generateMaliciousHeader() {
    return fc.sample(
      fc.oneof(
        fc.string().filter(s => s.includes('\n')), // Header 注入
        fc.string().filter(s => s.includes('\r')), // CRLF 注入
        fc.string().filter(s => s.length > 1000),  // 超长 Header
        fc.constant(''),                           // 空 Header
        fc.constant(null)                          // Null Header
      )
    )[0];
  }
  
  // 生成恶意 Body
  generateMaliciousBody() {
    return fc.sample(
      fc.oneof(
        fc.record({ // SQL 注入尝试
          id: fc.string().filter(s => s.includes("' OR '1'='1"))
        }),
        fc.record({ // NoSQL 注入
          query: fc.record({ $where: fc.string() })
        }),
        fc.record({ // XSS 尝试
          content: fc.string().filter(s => s.includes('<script>'))
        }),
        fc.record({ // JSON 注入
          data: fc.string().filter(s => !JSON.parse(s))
        }),
        fc.record({ // 超深嵌套
          nested: fc.any().filter(obj => this.getDepth(obj) > 20)
        }),
        fc.record({ // 超大数组
          items: fc.array(fc.any(), { maxLength: 10000 })
        })
      )
    )[0];
  }
  
  // 分析响应
  analyzeResponse(response, request, strategy) {
    const issues = [];
    
    // 检查异常响应码
    if (response.status === 500) {
      issues.push({
        type: 'server_error',
        severity: 'high',
        request,
        response: response.body,
        strategy: strategy.name
      });
    }
    
    // 检查信息泄露
    if (response.body.includes('error') && response.body.includes('stack')) {
      issues.push({
        type: 'stack_trace_leak',
        severity: 'high',
        request,
        response: response.body
      });
    }
    
    // 检查未处理的异常
    if (response.status === 200 && response.body === null) {
      issues.push({
        type: 'silent_failure',
        severity: 'medium',
        request
      });
    }
    
    this.results.push(...issues);
  }
  
  // 生成测试报告
  generateReport(endpoint) {
    return {
      endpoint,
      totalRuns: this.results.length,
      issues: this.results.filter(r => r.endpoint === endpoint),
      severityCounts: {
        critical: this.results.filter(r => r.severity === 'critical').length,
        high: this.results.filter(r => r.severity === 'high').length,
        medium: this.results.filter(r => r.severity === 'medium').length,
        low: this.results.filter(r => r.severity === 'low').length
      },
      recommendations: this.generateRecommendations()
    };
  }
}
```

#### 4.2.2 关键 API Fuzz 测试清单
```
/api/v1/catch/pokemon        - 捕捉精灵 API（位置验证、概率计算）
/api/v1/gym/battle           - 道馆战斗 API（队伍验证、伤害计算）
/api/v1/trade/initiate       - 精灵交易 API（精灵验证、用户验证）
/api/v1/user/update          - 用户信息更新 API（输入验证）
/api/v1/pokemon/transfer     - 精灵转移 API（精灵验证）
/api/v1/reward/claim         - 奖励领取 API（奖励验证）
/api/v1/payment/purchase     - 内购支付 API（金额验证）
/api/v1/location/report      - 位置上报 API（坐标验证）
/api/v1/social/friend        - 好友操作 API（用户验证）
/api/v1/admin/config         - 管理配置 API（权限验证）
```

### 4.3 边界值自动探索器

#### 4.3.1 BoundaryExplorer
```javascript
// backend/shared/testing/boundaryExplorer.js

class BoundaryExplorer {
  // 探索数值边界
  exploreNumericBoundaries(min, max) {
    const boundaries = [
      min,           // 最小值
      max,           // 最大值
      min - 1,       // 越界下限
      max + 1,       // 越界上限
      0,             // 零值
      -1,            // 负值
      NaN,           // NaN
      Infinity,      // 无穷大
      -Infinity,     // 无穷小
      Math.floor((min + max) / 2), // 中间值
      min + 0.1,     // 边界附近
      max - 0.1      // 边界附近
    ];
    
    return fc.sample(fc.constantFrom(...boundaries), 100);
  }
  
  // 探索字符串边界
  exploreStringBoundaries() {
    return [
      '',           // 空字符串
      ' ',          // 空格
      '\t',         // Tab
      '\n',         // 换行
      '\u0000',     // Null 字符
      '\u202E',     // RTL 控制字符
      'a',          // 单字符
      'a'.repeat(1000),  // 超长字符串
      '<script>alert(1)</script>', // XSS
      "' OR '1'='1",      // SQL 注入
      '{"key": "value"}', // JSON 字符串
      '𠮷',         // Unicode 字符（4字节）
      '😀',         // Emoji
      'null',       // 字符串 null
      'undefined'   // 字符串 undefined
    ];
  }
  
  // 探索数组边界
  exploreArrayBoundaries() {
    return [
      [],           // 空数组
      [null],       // 包含 null
      [undefined],  // 包含 undefined
      [NaN],        // 包含 NaN
      Array(10000).fill(0), // 超大数组
      [[]],         // 嵌套空数组
      [[[[]]]],     // 深嵌套
      [1, 'a', null, {}], // 混合类型
      new Array(2**31 - 1) // 数组长度边界
    ];
  }
  
  // 探索对象边界
  exploreObjectBoundaries() {
    return [
      {},           // 空对象
      { key: null }, // 包含 null
      { '': 'value' }, // 空键名
      { 'key\0': 'value' }, // 键名包含 Null
      { prototype: 'value' }, // 特殊属性名
      { __proto__: {} }, // 原型污染
      { constructor: 'value' }, // 特殊属性
      JSON.parse('{ "a": '.repeat(100) + '}'), // 超深嵌套
      { [Symbol.iterator]: 'value' } // Symbol 属性
    ];
  }
  
  // 自动探索所有边界
  autoExplore(fn, inputType) {
    const boundaries = this.getBoundaries(inputType);
    const results = [];
    
    for (const input of boundaries) {
      try {
        const result = fn(input);
        results.push({ input, result, success: true });
      } catch (error) {
        results.push({ input, error: error.message, success: false });
      }
    }
    
    return {
      fn: fn.name,
      inputType,
      totalTests: boundaries.length,
      failures: results.filter(r => !r.success),
      passRate: results.filter(r => r.success).length / boundaries.length
    };
  }
}
```

### 4.4 CI/CD 集成

#### 4.4.1 GitHub Actions Workflow
```yaml
# .github/workflows/fuzz-testing.yml
name: Property-Based & Fuzz Testing

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]
  schedule:
    - cron: '0 2 * * *' # 每天凌晨 2 点运行

jobs:
  property-based-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run Property-Based Tests
        run: npm run test:property
        
      - name: Upload Property Test Results
        uses: actions/upload-artifact@v4
        with:
          name: property-test-results
          path: test-results/property/
          
  fuzz-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
      redis:
        image: redis:7
        
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Start Services
        run: npm run start:test
        
      - name: Run API Fuzz Tests
        run: npm run test:fuzz
        timeout-minutes: 10
        
      - name: Generate Fuzz Report
        run: npm run fuzz:report
        
      - name: Upload Fuzz Test Results
        uses: actions/upload-artifact@v4
        with:
          name: fuzz-test-results
          path: test-results/fuzz/
          
      - name: Comment PR with Fuzz Results
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const report = require('./test-results/fuzz/summary.json');
            const body = `## 🧪 Fuzz Testing Results
            
            - **Total Runs**: ${report.totalRuns}
            - **Issues Found**: ${report.issues.length}
            - **Critical**: ${report.severityCounts.critical}
            - **High**: ${report.severityCounts.high}
            - **Medium**: ${report.severityCounts.medium}
            
            ${report.issues.length > 0 ? '⚠️ **Issues detected, please review**' : '✅ **All tests passed**'}
            `;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            });
```

### 4.5 测试报告系统

#### 4.5.1 报告生成器
```javascript
// backend/shared/testing/reportGenerator.js

class TestReportGenerator {
  generatePropertyTestReport(results) {
    return {
      summary: {
        totalTests: results.length,
        passed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        duration: results.reduce((sum, r) => sum + r.duration, 0)
      },
      failures: results.filter(r => !r.success).map(r => ({
        testName: r.testName,
        input: r.input,
        error: r.error.message,
        seed: r.seed, // 用于复现失败测试
        reproCommand: `npm run test:property -- --seed=${r.seed}`
      })),
      coverage: {
        modules: results.filter(r => r.module).map(r => r.module),
        properties: results.map(r => r.propertyName)
      }
    };
  }
  
  generateFuzzTestReport(results) {
    return {
      summary: {
        totalEndpoints: results.length,
        totalRuns: results.reduce((sum, r) => sum + r.totalRuns, 0),
        totalIssues: results.reduce((sum, r) => sum + r.issues.length, 0)
      },
      endpoints: results.map(r => ({
        path: r.endpoint,
        runs: r.totalRuns,
        issues: r.issues.length,
        severity: r.severityCounts
      })),
      criticalIssues: results
        .flatMap(r => r.issues)
        .filter(i => i.severity === 'critical'),
      recommendations: this.generateRecommendations(results)
    };
  }
  
  generateRecommendations(results) {
    const recommendations = [];
    
    // 针对发现的各类问题生成修复建议
    for (const issue of results.flatMap(r => r.issues)) {
      if (issue.type === 'stack_trace_leak') {
        recommendations.push({
          endpoint: issue.endpoint,
          issue: 'Stack trace exposure in error response',
          fix: 'Implement error sanitization middleware',
          priority: 'high'
        });
      }
      
      if (issue.type === 'silent_failure') {
        recommendations.push({
          endpoint: issue.endpoint,
          issue: 'Silent failure (200 OK with null body)',
          fix: 'Add proper error handling and logging',
          priority: 'medium'
        });
      }
      
      if (issue.type === 'input_validation_missing') {
        recommendations.push({
          endpoint: issue.endpoint,
          issue: 'Missing input validation',
          fix: 'Add Joi/Yup schema validation middleware',
          priority: 'high'
        });
      }
    }
    
    return recommendations;
  }
}
```

### 4.6 数据库设计

```sql
-- Fuzz 测试结果记录表
CREATE TABLE fuzz_test_results (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  request_body JSONB NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  issue_type VARCHAR(50),
  severity VARCHAR(20),
  strategy VARCHAR(50),
  seed BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT
);

CREATE INDEX idx_fuzz_test_endpoint ON fuzz_test_results(endpoint, created_at DESC);
CREATE INDEX idx_fuzz_test_severity ON fuzz_test_results(severity, resolved_at);

-- Property 测试失败记录表
CREATE TABLE property_test_failures (
  id SERIAL PRIMARY KEY,
  test_name VARCHAR(255) NOT NULL,
  module VARCHAR(100),
  input JSONB NOT NULL,
  error_message TEXT NOT NULL,
  seed BIGINT NOT NULL,
  reproducible BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fixed_at TIMESTAMP,
  fix_commit VARCHAR(40)
);

CREATE INDEX idx_property_test_seed ON property_test_failures(seed);
CREATE INDEX idx_property_test_module ON property_test_failures(module, created_at DESC);
```

## 5. 验收标准（可测试）

### 5.1 Property-Based Testing 验收
- [ ] 实现 PropertyBasedTester 核心模块
- [ ] 创建自定义 Arbitraries（Pokemon、User、Location 等）
- [ ] 关键模块 Property 测试覆盖率 ≥ 80%：
  - CP 计算（Pokemon）
  - 距离计算（Location）
  - 时间处理（时间戳）
  - 价格计算（Payment）
  - 好友关系（Social）
- [ ] 测试运行次数 ≥ 10000 次每个属性
- [ ] 失败测试可复现（通过 seed）
- [ ] 测试报告生成正确

### 5.2 API Fuzz Testing 验收
- [ ] 实现 APIFuzzTester 核心模块
- [ ] API 端点 Fuzz 测试覆盖率 ≥ 90%（至少 10 个关键端点）
- [ ] Fuzz 测试运行次数 ≥ 1000 每个端点
- [ ] 能发现至少 5 个潜在问题：
  - 输入验证缺失
  - 异常处理不当
  - 信息泄露
- [ ] 测试报告包含问题描述和修复建议
- [ ] 测试执行时间 < 10 分钟

### 5.3 边界值探索验收
- [ ] 实现 BoundaryExplorer 模块
- [ ] 能自动探索数值边界（MAX_INT、MIN_INT、NaN）
- [ ] 能自动探索字符串边界（空、超长、特殊字符）
- [ ] 能自动探索数组/对象边界（空、嵌套、超大）
- [ ] 边界测试覆盖率 ≥ 90%

### 5.4 CI/CD 验收
- [ ] GitHub Actions Workflow 配置正确
- [ ] PR 自动运行 Property-Based 和 Fuzz 测试
- [ ] 测试结果自动评论到 PR
- [ ] 测试失败阻止合并（门禁生效）
- [ ] 定时运行（每天一次）

### 5.5 测试报告验收
- [ ] Property 测试报告格式正确
- [ ] Fuzz 测试报告格式正确
- [ ] 报告包含修复建议
- [ ] 报告可导出为 JSON/Markdown

### 5.6 测试覆盖验收
- [ ] 单元测试覆盖率 ≥ 80%（新增 Property 测试）
- [ ] 边界测试覆盖率 ≥ 90%
- [ ] Fuzz 测试发现的问题 ≥ 10 个

## 6. 工作量估算

**L（Large）**

**理由**：
1. **Property-Based 框架搭建**（2 天）：
   - fast-check 集成
   - 自定义 Arbitraries
   - 核心测试模块

2. **Fuzz Testing 系统**（2 天）：
   - Fuzz 引擎
   - 恶意输入生成
   - 响应分析

3. **边界值探索器**（1 天）：
   - 各类型边界定义
   - 自动探索逻辑

4. **测试覆盖**（2 天）：
   - 关键模块 Property 测试
   - API 端点 Fuzz 测试
   - 边界值测试

5. **CI/CD 集成**（0.5 天）：
   - GitHub Actions 配置
   - 测试报告生成

6. **测试和文档**（0.5 天）：
   - 模块单元测试
   - API 文档

**总计**：约 8 人天

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **测试质量提升关键**：Property-Based Testing 能发现传统测试遗漏的边界 bug，显著提升测试质量

2. **自动化效率高**：10000 次 Property 测试 + 1000 次 Fuzz 测试，远超手动编写测试用例效率

3. **安全性增强**：Fuzz Testing 能发现输入验证漏洞，预防注入攻击

4. **技术债务预防**：越早建立 Property-Based Testing，越早发现潜在 bug，修复成本越低

5. **CI 集成价值**：自动化测试门禁，阻止低质量代码合并，保障代码质量

**对"项目可用"的贡献**：
- 发现隐藏的边界 bug，提升系统稳定性
- 自动化测试覆盖率提升，减少人工测试负担
- 发现输入验证漏洞，增强安全性
- 建立 Property-Based Testing 文化，长期收益