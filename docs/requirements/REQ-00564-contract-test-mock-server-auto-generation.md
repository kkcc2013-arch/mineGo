# REQ-00564：API契约测试Mock服务自动生成系统

- **编号**：REQ-00564
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/testing、gateway、所有微服务、docs/openapi
- **创建时间**：2026-07-16 01:00
- **依赖需求**：REQ-00008（OpenAPI规范）、REQ-00093（API契约测试）

## 1. 背景与问题

### 当前痛点

1. **Mock服务维护成本高**：各服务集成测试时，需要手动维护依赖服务的Mock实现，每当API契约变更时需要同步更新Mock逻辑，容易遗漏导致测试假阳性

2. **契约漂移无法及时发现**：虽然已有OpenAPI文档和基本的契约测试，但缺乏从OpenAPI规范自动生成Mock服务的机制，导致文档与实际测试Mock不一致

3. **测试环境依赖复杂**：端到端集成测试需要启动多个服务，测试稳定性受依赖服务可用性影响，测试执行时间长（当前全量E2E测试约15分钟）

4. **边界场景覆盖不足**：手工Mock难以覆盖API规范中定义的所有边界情况（如超时、错误码、空值等），测试覆盖率受限

### 数据支撑

- 最近3个月发现5起API变更后集成测试未捕获的兼容性问题
- Mock服务代码占测试代码总量的约25%
- 平均每次API变更需要额外2-4小时更新Mock逻辑

## 2. 目标

建立基于OpenAPI规范的智能Mock服务自动生成系统，实现：

1. **零维护Mock**：从OpenAPI文档自动生成符合规范的Mock服务，API变更后Mock自动同步
2. **契约一致性保障**：Mock行为与API规范100%一致，自动发现契约漂移
3. **测试效率提升**：减少依赖服务启动，集成测试时间降低40%以上
4. **边界场景全覆盖**：自动生成各种边界情况测试用例（错误码、超时、空值等）

## 3. 范围

### 包含

1. OpenAPI规范解析引擎
   - 解析OpenAPI 3.0+规范文件
   - 提取API端点、请求/响应Schema、错误码定义
   - 支持引用外部Schema文件

2. Mock服务动态生成器
   - 基于Schema生成符合规范的Mock响应
   - 支持智能数据生成（符合格式、枚举值、范围约束）
   - 支持条件响应（根据请求参数返回不同响应）
   - 支持延迟模拟（测试超时场景）

3. Mock服务器运行时
   - 轻量级HTTP服务器，支持热重载
   - 支持请求验证（请求Schema校验）
   - 支持调用记录和断言查询
   - 支持状态管理（模拟有状态服务）

4. 契约漂移检测
   - 定期比对OpenAPI规范与实际服务响应
   - 发现不一致时自动告警
   - 生成差异报告和建议

5. 测试框架集成
   - Jest/Mocha集成
   - 测试前自动启动Mock服务
   - 测试后自动清理和验证

### 不包含

- 生产环境Mock服务（仅用于测试环境）
- 复杂业务逻辑Mock（仅支持声明式规则）
- 性能测试Mock（不在本需求范围）

## 4. 详细需求

### 4.1 OpenAPI规范解析模块

**文件位置**：`backend/shared/testing/mock-generator/openapi-parser.js`

```javascript
// 核心接口
class OpenAPIParser {
  /**
   * 解析OpenAPI规范文件
   * @param {string} specPath - OpenAPI YAML/JSON文件路径
   * @returns {Promise<ParsedSpec>} 解析后的规范对象
   */
  async parse(specPath);

  /**
   * 提取所有API端点定义
   * @returns {Array<EndpointDef>} 端点定义列表
   */
  extractEndpoints();

  /**
   * 获取响应Schema
   * @param {string} path - API路径
   * @param {string} method - HTTP方法
   * @param {string} statusCode - 状态码
   * @returns {Object} JSON Schema对象
   */
  getResponseSchema(path, method, statusCode);
}
```

**要求**：
- 支持YAML和JSON格式
- 支持$ref引用解析
- 支持oneOf/anyOf/allOf组合
- 解析错误时提供清晰的错误位置信息

### 4.2 Mock数据生成器

**文件位置**：`backend/shared/testing/mock-generator/data-generator.js`

```javascript
class MockDataGenerator {
  /**
   * 根据JSON Schema生成Mock数据
   * @param {Object} schema - JSON Schema对象
   * @param {Object} options - 生成选项
   * @param {Object} options.factories - 自定义数据工厂
   * @param {Object} options.locale - 语言环境（用于生成文本）
   * @returns {*} 符合Schema的Mock数据
   */
  generate(schema, options = {});

  /**
   * 注册自定义数据生成器
   * @param {string} format - 格式名称（如'email', 'uuid'）
   * @param {Function} generator - 生成函数
   */
  registerFormat(format, generator);
}
```

**智能生成规则**：
- 字符串：根据format生成（email、uuid、uri、date-time等）
- 数字：遵守minimum/maximum约束
- 枚举：随机选择一个值
- 数组：根据minItems/maxItems生成合适数量的元素
- 对象：递归生成所有必需属性

**边界情况生成**：
- 空字符串、空数组、空对象
- 边界数值（最大值、最小值、负数）
- 特殊字符（Unicode、控制字符）

### 4.3 Mock服务器

**文件位置**：`backend/shared/testing/mock-server/`

```javascript
class MockServer {
  /**
   * 启动Mock服务器
   * @param {number} port - 端口号
   * @param {Object} config - 配置对象
   */
  async start(port, config = {});

  /**
   * 注册API端点Mock
   * @param {string} method - HTTP方法
   * @param {string} path - API路径
   * @param {Object} mockConfig - Mock配置
   */
  register(method, path, mockConfig);

  /**
   * 设置条件响应规则
   * @param {string} method - HTTP方法
   * @param {string} path - API路径
   * @param {Array<ConditionalResponse>} rules - 条件规则
   */
  setConditionalResponse(method, path, rules);

  /**
   * 获取调用记录
   * @param {Object} query - 查询条件
   * @returns {Array<CallRecord>} 调用记录列表
   */
  getCallHistory(query = {});

  /**
   * 验证调用情况
   * @param {Object} expectation - 期望条件
   * @returns {boolean} 是否满足期望
   */
  verifyCalls(expectation);

  /**
   * 重置状态和记录
   */
  reset();
}
```

**配置示例**：
```yaml
# mock-config.yaml
services:
  user-service:
    spec: ./docs/openapi/user-service.yaml
    port: 10001
    mocks:
      POST /api/users/login:
        default:
          statusCode: 200
          body: auto  # 自动生成
        conditions:
          - when:
              body.email: "blocked@test.com"
            then:
              statusCode: 403
              body:
                error: "ACCOUNT_BLOCKED"
          - when:
              body.password: "wrong"
            then:
              statusCode: 401
      GET /api/users/:id:
        delay: 100ms  # 模拟延迟
        body: auto
```

### 4.4 契约漂移检测

**文件位置**：`backend/shared/testing/contract-validator/`

```javascript
class ContractValidator {
  /**
   * 验证实际响应是否符合OpenAPI规范
   * @param {string} serviceName - 服务名称
   * @param {string} endpoint - API端点
   * @param {Object} actualResponse - 实际响应
   * @returns {ValidationResult} 验证结果
   */
  validateResponse(serviceName, endpoint, actualResponse);

  /**
   * 比对OpenAPI规范与实际服务响应
   * @param {string} serviceName - 服务名称
   * @param {string} serviceUrl - 服务实际地址
   * @returns {Promise<DriftReport>} 漂移报告
   */
  async detectDrift(serviceName, serviceUrl);

  /**
   * 定期契约验证（CI集成）
   * @param {Array<string>} services - 服务列表
   */
  async scheduleValidation(services);
}
```

**漂移报告格式**：
```json
{
  "service": "user-service",
  "timestamp": "2026-07-16T01:00:00Z",
  "endpoint": "GET /api/users/:id",
  "status": "DRIFT_DETECTED",
  "issues": [
    {
      "field": "response.body.phoneNumber",
      "expected": "string (format: phone)",
      "actual": "string (format: unknown)",
      "severity": "MEDIUM"
    }
  ],
  "recommendation": "Update OpenAPI spec or fix service implementation"
}
```

### 4.5 测试框架集成

**Jest配置示例**：

```javascript
// jest.config.js
module.exports = {
  setupFilesAfterEnv: ['./tests/mocks/setup-mocks.js'],
  globalSetup: './tests/mocks/global-setup.js',
  globalTeardown: './tests/mocks/global-teardown.js'
};

// tests/mocks/setup-mocks.js
const { MockManager } = require('@shared/testing');

beforeAll(async () => {
  await MockManager.startAll({
    services: ['user-service', 'pokemon-service', 'gym-service']
  });
});

afterAll(async () => {
  await MockManager.stopAll();
  await MockManager.verifyAllCalls();
});

afterEach(() => {
  MockManager.resetAll();
});
```

**测试示例**：
```javascript
describe('Catch Service - Integration Tests', () => {
  test('should catch pokemon successfully', async () => {
    // 设置Pokemon服务Mock
    MockManager.getService('pokemon-service')
      .mock('GET /api/pokemon/:id')
      .respond({ id: 'pk001', name: 'Pikachu', type: 'electric' });

    // 测试捕捉逻辑
    const result = await catchService.attemptCatch(userId, pokemonId);

    // 验证调用
    expect(MockManager.getService('pokemon-service')
      .verifyCalled('GET /api/pokemon/pk001')).toBe(true);
  });
});
```

### 4.6 CI/CD集成

**GitHub Actions配置**：

```yaml
# .github/workflows/contract-test.yml
name: Contract Tests

on:
  pull_request:
    paths:
      - 'docs/openapi/**'
      - 'backend/services/**'

jobs:
  contract-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 20
          
      - name: Install dependencies
        run: npm ci
        
      - name: Validate OpenAPI specs
        run: npm run validate:openapi
        
      - name: Run contract tests with mocks
        run: npm run test:contract
        env:
          MOCK_MODE: auto
          
      - name: Upload drift report
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: drift-report
          path: reports/drift-*.json
```

## 5. 验收标准（可测试）

- [ ] **解析能力**：能够成功解析项目中所有OpenAPI规范文件（当前约20个），解析时间<2秒
- [ ] **Mock生成准确性**：自动生成的Mock数据100%符合Schema定义，通过JSON Schema验证
- [ ] **零维护验证**：修改OpenAPI规范后，运行`npm run test:contract`，Mock服务自动同步，无手动修改代码
- [ ] **测试时间缩短**：集成测试套件执行时间从当前约15分钟降低到9分钟以内（目标降低40%）
- [ ] **边界覆盖**：自动生成至少5种边界情况测试用例（超时、空值、错误码、边界数值、特殊字符）
- [ ] **漂移检测准确率**：契约漂移检测准确率≥95%，无超过5%的误报率
- [ ] **向后兼容**：与现有测试框架（Jest）100%兼容，无需修改现有测试用例

## 6. 工作量估算

**规模**：L（Large）

**理由**：
- 涉及多个模块开发（解析器、生成器、服务器、验证器）
- 需要与现有测试框架深度集成
- 需要支持复杂的OpenAPI特性
- 需要考虑性能和稳定性

**估算明细**：
- OpenAPI解析模块：2天
- Mock数据生成器：2天
- Mock服务器开发：3天
- 契约验证器：2天
- 测试框架集成：2天
- 文档和示例：1天
- 测试和修复：2天

**总计**：约14个工作日

## 7. 优先级理由

**P1理由**：

1. **测试效率影响大**：当前测试维护成本高，影响开发迭代速度，每次API变更需要额外2-4小时维护Mock

2. **质量问题频发**：近3个月发生5起契约漂移导致的线上问题，需要从工具层面根本解决

3. **项目成熟度提升关键**：当前测试覆盖维度得分仅7/10，自动化Mock系统可显著提升测试可靠性和覆盖率

4. **依赖基础完善**：已有REQ-00008（OpenAPI规范）和REQ-00093（契约测试）作为基础，时机成熟

5. **杠杆效应强**：一次投入，长期收益，每次API变更可节省2-4小时维护时间，项目生命周期内ROI显著
