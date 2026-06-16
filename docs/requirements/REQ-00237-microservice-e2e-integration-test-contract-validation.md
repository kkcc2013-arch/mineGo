# REQ-00237：微服务端到端集成测试与契约验证自动化系统

- **编号**：REQ-00237
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests/integration、backend/tests/contract、所有微服务、gateway、.github/workflows、docs/api-spec
- **创建时间**：2026-06-16 00:00
- **依赖需求**：REQ-00093（API 契约测试系统）、REQ-00166（API 集成测试覆盖率提升）

## 1. 背景与问题

当前 mineGo 项目已有 116 个测试文件，但存在以下问题：

1. **集成测试覆盖不均衡**：9 个微服务中，仅有 catch、payment、auth 等少数服务有集成测试，gym-service、social-service、reward-service、location-service 等核心服务缺少端到端集成测试
2. **契约测试与服务发现脱节**：现有契约测试未与实际服务路由动态绑定，无法验证服务间调用的真实行为
3. **测试数据隔离不足**：集成测试之间共享数据库状态，导致测试顺序依赖和偶发性失败
4. **CI/CD 集成不完整**：集成测试未纳入 GitHub Actions 的 PR 检查流程，问题代码可能被合并

## 2. 目标

建立完整的微服务端到端集成测试体系，确保：
- 所有 9 个微服务核心 API 都有集成测试覆盖
- 契约测试自动验证服务间通信一致性
- 测试数据隔离，支持并行执行
- CI/CD 自动运行，PR 必须通过测试才能合并

## 3. 范围

- **包含**：
  - 为 gym-service、social-service、reward-service、location-service、pokemon-service 补充集成测试
  - 实现测试数据库隔离机制（每个测试套件独立 schema）
  - 契约测试与服务路由动态绑定
  - GitHub Actions 集成测试工作流
  - 测试覆盖率报告与阈值检查

- **不包含**：
  - E2E 前端测试（已有 REQ-00036）
  - 性能压力测试（已有 REQ-00033）
  - 混沌工程测试（已有 REQ-00087）

## 4. 详细需求

### 4.1 集成测试框架扩展

```javascript
// backend/tests/integration/base-integration.test.js
class IntegrationTestBase {
  constructor(serviceName) {
    this.serviceName = serviceName;
    this.testSchema = `test_${serviceName}_${Date.now()}`;
    this.app = null;
    this.db = null;
  }

  async setup() {
    // 创建独立测试 schema
    await this.db.query(`CREATE SCHEMA ${this.testSchema}`);
    await this.runMigrations();
    await this.seedTestData();
  }

  async teardown() {
    await this.db.query(`DROP SCHEMA ${this.testSchema} CASCADE`);
  }
}
```

### 4.2 微服务集成测试覆盖

每个微服务需覆盖以下场景：

| 服务 | 核心测试场景 |
|------|-------------|
| gym-service | 道馆创建、挑战流程、战斗结算、防守轮换 |
| social-service | 好友添加、PVP 匹配、排行榜更新、公会操作 |
| reward-service | 任务领取、奖励发放、成就触发、活动参与 |
| location-service | 精灵生成、位置更新、区域查询、天气影响 |
| pokemon-service | 精灵捕捉、进化、交易、背包管理 |

### 4.3 契约验证自动化

```javascript
// backend/tests/contract/service-contract.test.js
describe('Service Contract Validation', () => {
  for (const service of services) {
    it(`should match OpenAPI spec for ${service}`, async () => {
      const spec = await loadOpenAPISpec(service);
      const routes = await discoverServiceRoutes(service);
      
      for (const route of routes) {
        const response = await testRoute(route);
        validateAgainstSchema(response, spec, route);
      }
    });
  }
});
```

### 4.4 CI/CD 集成

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests
on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: test_minego
          POSTGRES_PASSWORD: test
      redis:
        image: redis:7
      kafka:
        image: confluentinc/cp-kafka:latest
    
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: postgres://postgres:test@localhost:5432/test_minego
          REDIS_URL: redis://localhost:6379
      
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
      
      - name: Check coverage threshold
        run: |
          COVERAGE=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
          if (( $(echo "$COVERAGE < 70" | bc -l) )); then
            echo "Coverage $COVERAGE% is below 70% threshold"
            exit 1
          fi
```

### 4.5 测试数据隔离策略

- 每个测试套件使用独立的数据库 schema
- Redis 使用带前缀的 key 隔离
- Kafka 使用独立的 topic 前缀
- 测试完成后自动清理所有资源

## 5. 验收标准（可测试）

- [ ] gym-service、social-service、reward-service、location-service、pokemon-service 各有至少 5 个集成测试用例
- [ ] 所有集成测试可并行执行，无顺序依赖
- [ ] 契约测试覆盖所有微服务的公开 API
- [ ] GitHub Actions PR 检查包含集成测试步骤
- [ ] 集成测试覆盖率 ≥ 70%
- [ ] 测试执行时间 < 5 分钟（含 setup/teardown）

## 6. 工作量估算

**L（Large）**：需要为 5 个微服务编写集成测试，实现测试隔离机制，配置 CI/CD 流程，预计 3-5 个工作日。

## 7. 优先级理由

P1 优先级理由：
- 测试覆盖是项目质量保障的基础，当前集成测试覆盖不足可能导致生产问题
- 与 REQ-00093（契约测试）、REQ-00166（集成测试覆盖率提升）形成完整的测试体系
- 直接影响 CI/CD 流程的可靠性和代码合并的安全性
