# REQ-00166：API 集成测试覆盖率提升与自动化回归测试系统

- **编号**：REQ-00166
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests/integration、所有微服务、GitHub Actions、docs/api-spec
- **创建时间**：2026-06-13 19:35
- **依赖需求**：REQ-00004（支付服务单元测试与集成测试覆盖）、REQ-00036（前端 Playwright E2E 测试系统）

## 1. 背景与问题

当前 mineGo 项目测试覆盖存在以下问题：

1. **集成测试覆盖不足**：现有测试主要集中在单元测试和 E2E 测试，缺乏系统的 API 集成测试
2. **服务间交互验证缺失**：微服务间的调用链路没有自动化测试覆盖
3. **回归测试成本高**：每次发布前需要人工验证核心流程，耗时且容易遗漏
4. **测试数据管理困难**：缺乏统一的测试数据工厂和清理机制
5. **测试报告不完整**：无法快速定位失败原因和影响范围

当前测试状态：
- 单元测试覆盖率：约 60%
- 集成测试覆盖率：约 30%
- E2E 测试：核心流程已覆盖
- 服务间调用测试：几乎为 0%

## 2. 目标

建立完整的 API 集成测试体系和自动化回归测试系统：

1. **集成测试覆盖率提升**：核心 API 集成测试覆盖率达到 80%+
2. **服务间调用验证**：关键服务调用链路自动化测试
3. **自动化回归测试**：CI/CD 流水线自动执行回归测试
4. **测试数据管理**：统一的测试数据工厂和隔离机制
5. **测试报告可视化**：详细的测试报告和覆盖率追踪

预期收益：
- 回归测试时间从 4 小时降至 30 分钟
- 发布前人工验证工作量降低 80%
- 线上 Bug 减少 50%

## 3. 范围

### 包含

- API 集成测试框架搭建
- 核心 API 集成测试编写（用户、精灵、捕捉、道馆、社交、支付）
- 服务间调用测试（gRPC/HTTP）
- 测试数据工厂和清理机制
- CI/CD 集成（自动化回归测试）
- 测试报告生成和覆盖率追踪
- Mock 服务和测试环境隔离

### 不包含

- 单元测试优化（已在 REQ-00004 覆盖）
- E2E 测试扩展（已在 REQ-00036 覆盖）
- 性能测试（已在 REQ-00033 覆盖）
- 安全测试（单独需求）

## 4. 详细需求

### 4.1 集成测试框架

```javascript
// backend/tests/integration/setup/TestServer.js
class TestServer {
  constructor() {
    this.servers = {};
    this.db = null;
    this.redis = null;
    this.kafka = null;
  }
  
  async start() {
    // 启动测试数据库
    this.db = await this.startTestDatabase();
    
    // 启动测试 Redis
    this.redis = await this.startTestRedis();
    
    // 启动测试 Kafka
    this.kafka = await this.startTestKafka();
    
    // 启动所有微服务
    for (const service of SERVICES) {
      this.servers[service] = await this.startService(service);
    }
  }
  
  async stop() {
    // 停止所有服务
    for (const service of Object.keys(this.servers)) {
      await this.stopService(service);
    }
    
    // 清理测试数据
    await this.cleanupTestData();
  }
}
```

### 4.2 测试数据工厂

```javascript
// backend/tests/integration/factories/index.js
class TestDataFactory {
  // 创建测试用户
  static async createUser(overrides = {}) {
    return await User.create({
      phone: `13800${Math.floor(Math.random() * 100000)}`,
      nickname: `test_user_${Date.now()}`,
      level: 10,
      ...overrides
    });
  }
  
  // 创建测试精灵
  static async createPokemon(overrides = {}) {
    return await Pokemon.create({
      speciesId: 25, // Pikachu
      cp: 500,
      iv: { attack: 15, defense: 15, stamina: 15 },
      ...overrides
    });
  }
  
  // 创建测试道馆
  static async createGym(overrides = {}) {
    return await Gym.create({
      lat: 39.9042,
      lng: 116.4074,
      team: 'YELLOW',
      ...overrides
    });
  }
  
  // 批量创建
  static async createBatch(factory, count, overrides = {}) {
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push(await factory({ ...overrides, index: i }));
    }
    return items;
  }
}
```

### 4.3 API 集成测试示例

```javascript
// backend/tests/integration/api/pokemon.test.js
describe('Pokemon API Integration Tests', () => {
  let testServer;
  let authToken;
  let testUser;
  
  beforeAll(async () => {
    testServer = new TestServer();
    await testServer.start();
    
    testUser = await TestDataFactory.createUser();
    authToken = await AuthService.generateToken(testUser);
  });
  
  afterAll(async () => {
    await testServer.stop();
  });
  
  describe('POST /api/pokemon/catch', () => {
    it('should catch a nearby pokemon successfully', async () => {
      // 创建附近精灵
      const pokemon = await TestDataFactory.createWildPokemon({
        lat: 39.9042,
        lng: 116.4074
      });
      
      const response = await request(testServer.gateway)
        .post('/api/pokemon/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemonId: pokemon.id,
          ballType: 'POKEBALL',
          lat: 39.9042,
          lng: 116.4074
        })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data.caught).toBe(true);
    });
    
    it('should fail to catch pokemon that is too far', async () => {
      const pokemon = await TestDataFactory.createWildPokemon({
        lat: 40.0000,
        lng: 117.0000
      });
      
      const response = await request(testServer.gateway)
        .post('/api/pokemon/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemonId: pokemon.id,
          ballType: 'POKEBALL',
          lat: 39.9042,
          lng: 116.4074
        })
        .expect(400);
      
      expect(response.body.code).toBe('CATCH-003');
    });
  });
});
```

### 4.4 服务间调用测试

```javascript
// backend/tests/integration/services/gym-battle.test.js
describe('Gym Battle Service Integration', () => {
  it('should complete a full gym battle flow', async () => {
    // 1. 创建攻击方用户和精灵
    const attacker = await TestDataFactory.createUser({ team: 'YELLOW' });
    const attackerPokemon = await TestDataFactory.createPokemon({
      userId: attacker.id,
      cp: 2000
    });
    
    // 2. 创建防御方道馆和精灵
    const gym = await TestDataFactory.createGym({ team: 'BLUE' });
    const defender = await TestDataFactory.createUser({ team: 'BLUE' });
    const defenderPokemon = await TestDataFactory.createPokemon({
      userId: defender.id,
      gymId: gym.id,
      cp: 1500
    });
    
    // 3. 发起战斗
    const battleResponse = await request(testServer.gateway)
      .post(`/api/gym/${gym.id}/battle`)
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({
        pokemonIds: [attackerPokemon.id]
      })
      .expect(200);
    
    const battleId = battleResponse.body.data.battleId;
    
    // 4. 执行战斗动作
    const actionResponse = await request(testServer.gateway)
      .post(`/api/gym/battle/${battleId}/action`)
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({
        action: 'fastAttack',
        targetId: defenderPokemon.id
      })
      .expect(200);
    
    // 5. 验证战斗结果
    expect(actionResponse.body.data.damage).toBeGreaterThan(0);
  });
});
```

### 4.5 CI/CD 集成

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'  # 每天凌晨 2 点执行

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: minego_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      
      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run integration tests
        run: npm run test:integration
        env:
          NODE_ENV: test
          DATABASE_URL: postgresql://test:test@localhost:5432/minego_test
          REDIS_URL: redis://localhost:6379
      
      - name: Upload coverage report
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
          flags: integration
      
      - name: Generate test report
        uses: dorny/test-reporter@v1
        with:
          name: Integration Tests
          path: reports/integration-*.json
          reporter: jest-junit
```

### 4.6 测试报告

```javascript
// backend/tests/integration/reporter/TestReporter.js
class TestReporter {
  generateReport(results) {
    return {
      summary: {
        total: results.total,
        passed: results.passed,
        failed: results.failed,
        skipped: results.skipped,
        duration: results.duration,
        coverage: {
          lines: results.coverage.lines,
          branches: results.coverage.branches,
          functions: results.coverage.functions,
          statements: results.coverage.statements
        }
      },
      
      services: this.groupByService(results.tests),
      
      failures: results.tests
        .filter(t => t.status === 'failed')
        .map(t => ({
          name: t.name,
          service: t.service,
          error: t.error,
          stack: t.stack
        })),
      
      slowTests: results.tests
        .filter(t => t.duration > 1000)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 10),
      
      recommendations: this.generateRecommendations(results)
    };
  }
}
```

## 5. 验收标准（可测试）

- [ ] API 集成测试框架搭建完成，支持测试数据隔离
- [ ] 核心 API 集成测试覆盖率 ≥ 80%
- [ ] 服务间调用测试覆盖主要链路（用户认证 → 精灵捕捉 → 道馆战斗）
- [ ] CI/CD 流水线自动执行集成测试，失败时阻止合并
- [ ] 测试数据工厂支持所有主要数据类型创建
- [ ] 测试报告包含覆盖率、失败原因、慢测试列表
- [ ] 集成测试执行时间 < 10 分钟
- [ ] 所有测试可并行执行，无依赖冲突
- [ ] 测试数据自动清理，不影响下次执行

## 6. 工作量估算

**L (Large)** - 需要编写大量集成测试，涉及多个服务协调

**估算理由**：
- 框架搭建：1 天
- 核心 API 测试编写：3 天
- 服务间调用测试：2 天
- CI/CD 集成：1 天
- 测试报告和文档：1 天
- **总计：约 8 个工作日**

## 7. 优先级理由

**P1 理由**：

1. **质量保障**：集成测试是发现服务间交互问题的关键手段
2. **自动化回归**：降低人工验证成本，提高发布效率
3. **线上稳定性**：自动化测试覆盖可显著减少线上 Bug
4. **开发效率**：良好的测试覆盖让开发者更有信心重构
5. **持续交付基础**：是实现持续交付的前提条件
