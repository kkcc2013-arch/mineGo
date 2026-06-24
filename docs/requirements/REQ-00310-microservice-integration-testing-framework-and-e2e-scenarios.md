# REQ-00310：微服务集成测试框架与端到端场景验证系统

- **编号**：REQ-00310
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests/integration, 所有微服务, backend/shared, database/migrations, backend/mocks
- **创建时间**：2026-06-24 04:00 UTC
- **依赖需求**：REQ-00022（集成测试框架）, REQ-00272（API 契约测试）

## 1. 背景与问题

当前项目已完成 API 契约测试自动化（REQ-00272）和 E2E 测试框架（REQ-00022），但存在以下缺口：

1. **跨服务集成测试缺失**：微服务间交互场景（如捕捉流程涉及 location-service → pokemon-service → catch-service → reward-service）缺乏自动化验证
2. **测试数据隔离不足**：集成测试共享数据库导致测试间相互干扰，测试结果不稳定
3. **外部依赖 Mock 不完善**：Redis、Kafka、第三方 API 缺乏统一的 Mock 策略
4. **测试环境启动复杂**：每次运行需要手动启动多个服务，CI/CD 中测试执行时间过长
5. **场景覆盖不全**：核心业务流程（捕捉、道馆战、交易、支付）缺乏端到端集成测试

查看代码：
- `backend/tests/` 目录存在单元测试但缺乏跨服务集成测试
- `backend/services/*/tests/` 各服务独立测试，无服务间交互验证
- 数据库迁移与测试数据准备缺乏自动化

## 2. 目标

构建完整的微服务集成测试框架，实现：

1. **跨服务场景自动化验证**：覆盖核心业务流程的端到端集成测试
2. **测试数据隔离**：每个测试用例独立数据库事务，测试间零干扰
3. **依赖 Mock 统一管理**：Redis、Kafka、外部 API 的 Mock 层
4. **快速测试启动**：Docker Compose 一键启动测试环境，CI 执行时间 < 5 分钟
5. **测试覆盖率提升**：关键业务路径集成测试覆盖率达 70%+

## 3. 范围

### 包含

- 微服务集成测试框架核心（TestRunner、ServiceRegistry、MockManager）
- 核心业务场景测试用例：
  - 精灵捕捉全流程（位置验证 → 精灵生成 → 捕捉判定 → 奖励发放）
  - 道馆对战流程（队伍编组 → 战斗执行 → 结果结算 → 奖励分配）
  - 精灵交易流程（交易请求 → 欺诈检测 → 确认交易 → 数据同步）
  - 支付流程（订单创建 → 支付网关 → 幂等性验证 → 回调处理）
- 测试数据工厂（TestDataFactory）与隔离机制
- Mock 服务器（Redis Mock、Kafka Mock、外部 API Mock）
- Docker Compose 测试环境配置
- CI/CD 集成（GitHub Actions 并行测试执行）
- 测试报告生成与覆盖率统计

### 不包含

- 前端 E2E 测试（已在 REQ-00036 实现）
- 性能/负载测试（将在 REQ-00301 实现）
- 混沌测试（已在 REQ-00292 创建）
- 单元测试补充（各服务自行维护）

## 4. 详细需求

### 4.1 集成测试框架核心

```javascript
// backend/tests/integration/core/TestRunner.js
class IntegrationTestRunner {
  constructor() {
    this.serviceRegistry = new ServiceRegistry();
    this.mockManager = new MockManager();
    this.dataFactory = new TestDataFactory();
    this.dbTransactionManager = new TestDbTransactionManager();
  }

  // 启动所有服务
  async setup() {
    await this.mockManager.startAll();
    await this.serviceRegistry.startServices(['user', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment']);
    await this.dbTransactionManager.beginAll();
  }

  // 清理所有测试数据
  async teardown() {
    await this.dbTransactionManager.rollbackAll();
    await this.serviceRegistry.stopAll();
    await this.mockManager.stopAll();
  }

  // 执行单个测试场景
  async runScenario(scenarioName, testFn) {
    const tx = await this.dbTransactionManager.createTransaction();
    try {
      await testFn(this.serviceRegistry, this.dataFactory);
      await tx.rollback();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
```

### 4.2 核心业务场景测试

#### 场景 1：精灵捕捉全流程

```javascript
// backend/tests/integration/scenarios/catch-flow.test.js
describe('Pokemon Catch Flow Integration', () => {
  let runner;
  
  beforeAll(async () => {
    runner = new IntegrationTestRunner();
    await runner.setup();
  });

  afterAll(async () => {
    await runner.teardown();
  });

  test('should complete catch flow: location -> spawn -> catch -> reward', async () => {
    const { services, dataFactory } = runner;
    
    // 1. 创建测试用户
    const user = await dataFactory.createUser({ level: 10 });
    
    // 2. 模拟用户位置
    const location = { lat: 39.9042, lng: 116.4074 };
    await services.location.updateUserLocation(user.id, location);
    
    // 3. 触发精灵刷新
    const spawn = await services.location.spawnPokemon(location, {
      pokemonId: 'pikachu-001',
      rarity: 'common'
    });
    
    // 4. 执行捕捉
    const catchResult = await services.catch.attemptCatch(user.id, spawn.id, {
      ballType: 'pokeball',
      throwQuality: 'excellent'
    });
    
    // 5. 验证捕捉结果
    expect(catchResult.success).toBe(true);
    expect(catchResult.caughtPokemon.pokemonId).toBe('pikachu-001');
    
    // 6. 验证奖励发放
    const rewards = await services.reward.getUserRewards(user.id);
    expect(rewards).toContainEqual(
      expect.objectContaining({ type: 'xp', amount: expect.any(Number) })
    );
    
    // 7. 验证图鉴更新
    const pokedex = await services.pokemon.getUserPokedex(user.id);
    expect(pokedex.caughtIds).toContain('pikachu-001');
  });
});
```

#### 场景 2：道馆对战流程

```javascript
// backend/tests/integration/scenarios/gym-battle.test.js
describe('Gym Battle Flow Integration', () => {
  test('should complete gym battle: team setup -> battle -> result -> rewards', async () => {
    const { services, dataFactory } = runner;
    
    // 1. 创建攻守双方用户
    const attacker = await dataFactory.createUserWithPokemon({ 
      level: 20, 
      pokemonCount: 6 
    });
    const defender = await dataFactory.createUserWithPokemon({ 
      level: 18, 
      pokemonCount: 3 
    });
    
    // 2. 创建道馆并设置防守队伍
    const gym = await dataFactory.createGym({ 
      location: { lat: 39.9, lng: 116.4 },
      owner: defender.id 
    });
    await services.gym.setDefenderTeam(gym.id, defender.pokemon.slice(0, 3));
    
    // 3. 攻击方编组队伍
    const attackTeam = attacker.pokemon.slice(0, 6);
    await services.gym.setAttackerTeam(attacker.id, gym.id, attackTeam);
    
    // 4. 执行对战
    const battleResult = await services.gym.executeBattle(gym.id, {
      attackerId: attacker.id,
      defenderId: defender.id
    });
    
    // 5. 验证战斗结果
    expect(battleResult.winner).toBe('attacker');
    expect(battleResult.gymControl).toBe(attacker.id);
    
    // 6. 验证经验值发放
    const attackerXp = await services.user.getUserXp(attacker.id);
    expect(attackerXp.gained).toBeGreaterThan(0);
  });
});
```

### 4.3 测试数据隔离机制

```javascript
// backend/tests/integration/core/TestDbTransactionManager.js
class TestDbTransactionManager {
  constructor() {
    this.connections = new Map();
    this.transactions = new Map();
  }

  // 为每个服务创建独立事务
  async beginAll() {
    const services = ['user', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment'];
    for (const service of services) {
      const db = await getDbConnection(service);
      const tx = await db.beginTransaction();
      this.transactions.set(service, tx);
    }
  }

  // 所有事务回滚
  async rollbackAll() {
    for (const [service, tx] of this.transactions) {
      await tx.rollback();
    }
    this.transactions.clear();
  }

  // 获取服务的事务连接
  getTransaction(service) {
    return this.transactions.get(service);
  }
}
```

### 4.4 Mock 服务器统一管理

```javascript
// backend/tests/integration/mocks/MockManager.js
class MockManager {
  constructor() {
    this.redisMock = new RedisMockServer();
    this.kafkaMock = new KafkaMockServer();
    this.externalApiMock = new ExternalApiMockServer();
  }

  async startAll() {
    await Promise.all([
      this.redisMock.start(6380),
      this.kafkaMock.start(9093),
      this.externalApiMock.start(3001)
    ]);
    
    // 预设 Mock 响应
    this.externalApiMock.setResponse('/weather', { temp: 25, condition: 'sunny' });
    this.externalApiMock.setResponse('/payment/gateway', { status: 'success' });
  }

  async stopAll() {
    await Promise.all([
      this.redisMock.stop(),
      this.kafkaMock.stop(),
      this.externalApiMock.stop()
    ]);
  }

  // 验证 Kafka 事件发布
  async verifyKafkaEvent(topic, expectedEvent) {
    const events = await this.kafkaMock.getEvents(topic);
    return events.some(event => 
      event.type === expectedEvent.type &&
      event.data.id === expectedEvent.data.id
    );
  }
}
```

### 4.5 测试数据工厂

```javascript
// backend/tests/integration/data/TestDataFactory.js
class TestDataFactory {
  constructor(dbTransactionManager) {
    this.tx = dbTransactionManager;
  }

  async createUser(options = {}) {
    const tx = this.tx.getTransaction('user');
    const userId = uuid();
    await tx.query(`
      INSERT INTO users (id, username, level, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [userId, options.username || `user_${userId}`, options.level || 1]);
    return { id: userId, ...options };
  }

  async createUserWithPokemon(options = {}) {
    const user = await this.createUser(options);
    const pokemon = [];
    
    for (let i = 0; i < (options.pokemonCount || 1); i++) {
      const pkmn = await this.createPokemon({
        ownerId: user.id,
        level: options.level || 10
      });
      pokemon.push(pkmn);
    }
    
    return { ...user, pokemon };
  }

  async createPokemon(options = {}) {
    const tx = this.tx.getTransaction('pokemon');
    const pokemonId = uuid();
    await tx.query(`
      INSERT INTO pokemon (id, species_id, owner_id, level, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [pokemonId, options.speciesId || 'pikachu', options.ownerId, options.level || 1]);
    return { id: pokemonId, ...options };
  }

  async createGym(options = {}) {
    const tx = this.tx.getTransaction('gym');
    const gymId = uuid();
    await tx.query(`
      INSERT INTO gyms (id, location, owner_id, created_at)
      VALUES ($1, ST_Point($2, $3), $4, NOW())
    `, [gymId, options.location.lat, options.location.lng, options.owner]);
    return { id: gymId, ...options };
  }
}
```

### 4.6 Docker Compose 测试环境

```yaml
# docker-compose.test.yml
version: '3.8'

services:
  test-db:
    image: postgis/postgis:15-3.3
    environment:
      POSTGRES_DB: minego_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    tmpfs:
      - /var/lib/postgresql/data
    command: postgres -c max_connections=200

  test-redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb

  test-kafka:
    image: bitnami/kafka:3.5
    environment:
      KAFKA_CFG_NODE_ID: 1
      KAFKA_CFG_PROCESS_ROLES: broker,controller
      KAFKA_CFG_LISTENERS: PLAINTEXT://:9092
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: 1@test-kafka:9093

  test-runner:
    build:
      context: .
      dockerfile: Dockerfile.test
    depends_on:
      - test-db
      - test-redis
      - test-kafka
    environment:
      NODE_ENV: test
      DATABASE_URL: postgresql://test:test@test-db:5432/minego_test
      REDIS_URL: redis://test-redis:6379
      KAFKA_BROKERS: test-kafka:9092
    volumes:
      - ./backend:/app/backend
      - ./coverage:/app/coverage
    command: npm run test:integration
```

### 4.7 CI/CD 集成

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Start test environment
        run: docker-compose -f docker-compose.test.yml up -d
        
      - name: Wait for services
        run: sleep 10
        
      - name: Run integration tests
        run: |
          docker-compose -f docker-compose.test.yml exec test-runner \
            npm run test:integration -- --coverage --reporters=json
            
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
          
      - name: Stop test environment
        if: always()
        run: docker-compose -f docker-compose.test.yml down -v
```

## 5. 验收标准（可测试）

- [ ] 集成测试框架核心代码完成，支持服务注册、Mock 管理、事务隔离
- [ ] 至少 4 个核心业务场景的端到端集成测试用例通过（捕捉、道馆、交易、支付）
- [ ] 测试数据隔离机制实现，每个测试用例独立事务，测试间零干扰
- [ ] Mock 服务器统一管理，Redis/Kafka/外部 API Mock 正常工作
- [ ] Docker Compose 测试环境一键启动，所有服务健康检查通过
- [ ] CI/CD 集成测试流程配置完成，GitHub Actions 执行时间 < 5 分钟
- [ ] 核心业务路径集成测试覆盖率 ≥ 70%
- [ ] 测试报告生成，包含覆盖率统计和失败详情
- [ ] 文档完整：README 包含测试环境启动、测试执行、Mock 使用说明

## 6. 工作量估算

**L（Large）**

理由：
- 框架核心开发：2 天
- 4 个核心场景测试用例：2 天
- Mock 服务器实现：1 天
- Docker Compose 配置与 CI 集成：1 天
- 测试数据工厂与隔离机制：1 天
- 文档与调试：1 天
- **总计：约 8 人天**

## 7. 优先级理由

**P1 理由**：

1. **质量保障关键**：微服务架构下，服务间交互是故障高发区，集成测试是发现跨服务问题的最后一道防线
2. **CI/CD 基础设施**：集成测试是自动化部署的前提，缺乏会导致生产环境风险
3. **测试覆盖率目标**：STATUS.md 目标"测试覆盖率至 80%+"，当前仅 8/10，集成测试是主要缺口
4. **项目成熟度提升**：完善测试覆盖是项目从"功能可用"到"生产可用"的关键一步
5. **依赖关系**：REQ-00022 和 REQ-00272 已完成基础设施，现在是补齐集成测试的最佳时机
