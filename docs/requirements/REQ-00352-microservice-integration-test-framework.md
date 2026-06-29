# REQ-00352: 微服务集成测试框架与端到端场景验证系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00352 |
| 标题 | 微服务集成测试框架与端到端场景验证系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/tests/integration、所有微服务、backend/shared、database/migrations、backend/mocks |
| 创建时间 | 2026-06-29 01:00 UTC |

## 需求描述

构建完整的微服务集成测试框架，实现服务间通信、数据流、业务场景的端到端自动化验证。支持测试环境隔离、Mock 服务管理、测试数据工厂、断言库扩展，确保跨服务业务流程的正确性和稳定性。

### 核心目标

1. **服务编排测试**：验证多服务协作的业务流程
2. **环境隔离**：每个测试套件独立数据库和缓存实例
3. **Mock 服务**：外部依赖的可配置 Mock
4. **测试数据工厂**：标准化测试数据生成
5. **场景验证**：覆盖关键业务端到端流程

## 技术方案

### 1. 测试框架架构

```javascript
// backend/tests/integration/framework/TestRunner.js
const { Docker } = require('dockerode');
const { Pool } = require('pg');
const Redis = require('ioredis');
const Kafka = require('kafkajs').Kafka;

class IntegrationTestRunner {
  constructor(config = {}) {
    this.services = config.services || [];
    this.containers = new Map();
    this.dbPool = null;
    this.redisClient = null;
    this.kafkaProducer = null;
    this.testContext = null;
  }

  async setup() {
    // 1. 启动测试数据库容器
    await this.startDatabase();
    
    // 2. 启动 Redis 测试实例
    await this.startRedis();
    
    // 3. 启动 Kafka 测试实例
    await this.startKafka();
    
    // 4. 运行数据库迁移
    await this.runMigrations();
    
    // 5. 启动微服务（按依赖顺序）
    await this.startServices();
    
    // 6. 等待服务就绪
    await this.waitForServices();
  }

  async startDatabase() {
    const docker = new Docker();
    const container = await docker.createContainer({
      Image: 'postgres:15',
      Env: [
        'POSTGRES_USER=test',
        'POSTGRES_PASSWORD=test',
        'POSTGRES_DB=minego_test'
      ],
      HostConfig: {
        PortBindings: { '5432/tcp': [{ HostPort: '0' }] }
      }
    });
    
    await container.start();
    this.containers.set('postgres', container);
    
    // 获取动态端口
    const inspect = await container.inspect();
    const port = inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort;
    
    this.dbPool = new Pool({
      host: 'localhost',
      port: parseInt(port),
      user: 'test',
      password: 'test',
      database: 'minego_test'
    });
  }

  async startRedis() {
    const docker = new Docker();
    const container = await docker.createContainer({
      Image: 'redis:7-alpine',
      HostConfig: {
        PortBindings: { '6379/tcp': [{ HostPort: '0' }] }
      }
    });
    
    await container.start();
    this.containers.set('redis', container);
    
    const inspect = await container.inspect();
    const port = inspect.NetworkSettings.Ports['6379/tcp'][0].HostPort;
    
    this.redisClient = new Redis({
      host: 'localhost',
      port: parseInt(port)
    });
  }

  async teardown() {
    // 停止所有服务
    for (const [name, container] of this.containers) {
      await container.stop();
      await container.remove();
    }
    
    // 关闭连接池
    if (this.dbPool) await this.dbPool.end();
    if (this.redisClient) await this.redisClient.quit();
  }
}

module.exports = IntegrationTestRunner;
```

### 2. 测试数据工厂

```javascript
// backend/tests/integration/factories/PokemonFactory.js
const { v4: uuidv4 } = require('uuid');
const faker = require('faker');

class PokemonFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
  }

  async create(overrides = {}) {
    const pokemon = {
      id: uuidv4(),
      userId: overrides.userId || uuidv4(),
      speciesId: overrides.speciesId || Math.floor(Math.random() * 151) + 1,
      nickname: overrides.nickname || faker.name.firstName(),
      level: overrides.level || Math.floor(Math.random() * 100) + 1,
      experience: overrides.experience || 0,
      hp: overrides.hp || 100,
      maxHp: overrides.maxHp || 100,
      attack: overrides.attack || 50,
      defense: overrides.defense || 50,
      specialAttack: overrides.specialAttack || 50,
      specialDefense: overrides.specialDefense || 50,
      speed: overrides.speed || 50,
      nature: overrides.nature || 'hardy',
      ability: overrides.ability || 'overgrow',
      heldItemId: overrides.heldItemId || null,
      metLocation: overrides.metLocation || 'Pallet Town',
      metDate: overrides.metDate || new Date(),
      isShiny: overrides.isShiny || false,
      friendship: overrides.friendship || 70,
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO pokemon (
        id, user_id, species_id, nickname, level, experience,
        hp, max_hp, attack, defense, special_attack, special_defense, speed,
        nature, ability, held_item_id, met_location, met_date, is_shiny, friendship
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        pokemon.id, pokemon.userId, pokemon.speciesId, pokemon.nickname,
        pokemon.level, pokemon.experience, pokemon.hp, pokemon.maxHp,
        pokemon.attack, pokemon.defense, pokemon.specialAttack, pokemon.specialDefense,
        pokemon.speed, pokemon.nature, pokemon.ability, pokemon.heldItemId,
        pokemon.metLocation, pokemon.metDate, pokemon.isShiny, pokemon.friendship
      ]
    );

    return pokemon;
  }

  async createBatch(count, overrides = {}) {
    const pokemons = [];
    for (let i = 0; i < count; i++) {
      pokemons.push(await this.create(overrides));
    }
    return pokemons;
  }
}

// backend/tests/integration/factories/UserFactory.js
class UserFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
  }

  async create(overrides = {}) {
    const user = {
      id: uuidv4(),
      email: overrides.email || faker.internet.email(),
      username: overrides.username || faker.internet.userName(),
      passwordHash: overrides.passwordHash || '$2b$10$dummy',
      level: overrides.level || 1,
      experience: overrides.experience || 0,
      coins: overrides.coins || 1000,
      stardust: overrides.stardust || 10000,
      createdAt: overrides.createdAt || new Date(),
      lastLoginAt: overrides.lastLoginAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO users (
        id, email, username, password_hash, level, experience, coins, stardust, created_at, last_login_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        user.id, user.email, user.username, user.passwordHash,
        user.level, user.experience, user.coins, user.stardust,
        user.createdAt, user.lastLoginAt
      ]
    );

    return user;
  }
}

module.exports = { PokemonFactory, UserFactory };
```

### 3. Mock 服务管理器

```javascript
// backend/tests/integration/mocks/MockServiceManager.js
const express = require('express');

class MockServiceManager {
  constructor() {
    this.mocks = new Map();
    this.servers = new Map();
  }

  createMock(serviceName, port) {
    const app = express();
    app.use(express.json());
    
    const mock = {
      app,
      routes: new Map(),
      callHistory: []
    };
    
    this.mocks.set(serviceName, mock);
    return mock;
  }

  setupRoute(serviceName, method, path, handler) {
    const mock = this.mocks.get(serviceName);
    if (!mock) throw new Error(`Mock ${serviceName} not found`);
    
    const routeKey = `${method.toUpperCase()} ${path}`;
    mock.routes.set(routeKey, handler);
    
    mock.app[method.toLowerCase()](path, (req, res) => {
      mock.callHistory.push({
        method: req.method,
        path: req.path,
        body: req.body,
        query: req.query,
        timestamp: new Date()
      });
      
      handler(req, res);
    });
  }

  async startMock(serviceName, port) {
    const mock = this.mocks.get(serviceName);
    if (!mock) throw new Error(`Mock ${serviceName} not found`);
    
    return new Promise((resolve) => {
      const server = mock.app.listen(port, () => {
        this.servers.set(serviceName, server);
        resolve();
      });
    });
  }

  async stopMock(serviceName) {
    const server = this.servers.get(serviceName);
    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          this.servers.delete(serviceName);
          resolve();
        });
      });
    }
  }

  getCallHistory(serviceName) {
    const mock = this.mocks.get(serviceName);
    return mock ? mock.callHistory : [];
  }

  resetHistory(serviceName) {
    const mock = this.mocks.get(serviceName);
    if (mock) mock.callHistory = [];
  }

  async stopAll() {
    const stops = [];
    for (const [name, server] of this.servers) {
      stops.push(this.stopMock(name));
    }
    await Promise.all(stops);
  }
}

// 使用示例
async function setupPaymentMock(mockManager) {
  const mock = mockManager.createMock('payment-service', 3009);
  
  // Mock 支付创建
  mockManager.setupRoute('payment-service', 'POST', '/api/v1/payments', (req, res) => {
    res.json({
      success: true,
      paymentId: uuidv4(),
      status: 'pending',
      amount: req.body.amount
    });
  });
  
  // Mock 支付验证
  mockManager.setupRoute('payment-service', 'GET', '/api/v1/payments/:id', (req, res) => {
    res.json({
      success: true,
      payment: {
        id: req.params.id,
        status: 'completed',
        amount: 1000
      }
    });
  });
  
  await mockManager.startMock('payment-service', 3009);
}
```

### 4. 端到端场景测试

```javascript
// backend/tests/integration/scenarios/CatchFlow.test.js
const { describe, it, before, after, beforeEach } = require('mocha');
const { expect } = require('chai');
const IntegrationTestRunner = require('../framework/TestRunner');
const { PokemonFactory, UserFactory } = require('../factories');
const MockServiceManager = require('../mocks/MockServiceManager');

describe('捕捉流程端到端测试', function() {
  this.timeout(60000); // 集成测试需要更长时间
  
  let runner;
  let userFactory;
  let pokemonFactory;
  let mockManager;
  let userId;
  let accessToken;

  before(async () => {
    runner = new IntegrationTestRunner({
      services: ['user-service', 'location-service', 'catch-service', 'pokemon-service']
    });
    
    await runner.setup();
    
    userFactory = new UserFactory(runner.dbPool);
    pokemonFactory = new PokemonFactory(runner.dbPool);
    mockManager = new MockServiceManager();
    
    // 设置 Mock 服务
    await setupLocationMock(mockManager);
  });

  after(async () => {
    await mockManager.stopAll();
    await runner.teardown();
  });

  beforeEach(async () => {
    // 清理测试数据
    await runner.dbPool.query('TRUNCATE pokemon, users CASCADE');
    mockManager.resetHistory('location-service');
  });

  describe('完整捕捉流程', () => {
    it('应该成功捕捉野生精灵', async () => {
      // 1. 创建测试用户
      const user = await userFactory.create({
        coins: 1000,
        stardust: 10000
      });
      userId = user.id;

      // 2. 获取访问令牌
      const loginRes = await request(runner.gatewayUrl)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'testpass' });
      
      accessToken = loginRes.body.accessToken;

      // 3. 查询附近精灵
      const nearbyRes = await request(runner.gatewayUrl)
        .get('/api/v1/location/nearby')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ lat: 35.6762, lng: 139.6503, radius: 1000 });
      
      expect(nearbyRes.status).to.equal(200);
      expect(nearbyRes.body.pokemon).to.be.an('array');
      expect(nearbyRes.body.pokemon.length).to.be.greaterThan(0);

      const wildPokemon = nearbyRes.body.pokemon[0];

      // 4. 发起捕捉
      const catchRes = await request(runner.gatewayUrl)
        .post('/api/v1/catch/attempt')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          spawnId: wildPokemon.spawnId,
          ballType: 'pokeball',
          throwQuality: 'great'
        });
      
      expect(catchRes.status).to.equal(200);
      expect(catchRes.body.success).to.be.true;
      expect(catchRes.body.pokemon).to.exist;
      expect(catchRes.body.pokemon.speciesId).to.equal(wildPokemon.speciesId);

      // 5. 验证数据库状态
      const dbPokemon = await runner.dbPool.query(
        'SELECT * FROM pokemon WHERE user_id = $1 AND species_id = $2',
        [userId, wildPokemon.speciesId]
      );
      
      expect(dbPokemon.rows.length).to.equal(1);
      expect(dbPokemon.rows[0].hp).to.be.greaterThan(0);

      // 6. 验证用户资源消耗
      const updatedUser = await runner.dbPool.query(
        'SELECT coins, stardust FROM users WHERE id = $1',
        [userId]
      );
      
      expect(updatedUser.rows[0].coins).to.be.lessThan(user.coins);
    });

    it('应该在捕捉失败后正确处理状态', async () => {
      const user = await userFactory.create({ coins: 100 });
      userId = user.id;

      const loginRes = await request(runner.gatewayUrl)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'testpass' });
      
      accessToken = loginRes.body.accessToken;

      // 使用低级球捕捉高级精灵（预期失败）
      const catchRes = await request(runner.gatewayUrl)
        .post('/api/v1/catch/attempt')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          spawnId: 'high-level-spawn-id',
          ballType: 'pokeball',
          throwQuality: 'normal'
        });
      
      expect(catchRes.body.success).to.be.false;
      expect(catchRes.body.reason).to.equal('escaped');
    });
  });

  describe('并发捕捉测试', () => {
    it('应该正确处理多个玩家同时捕捉同一只精灵', async () => {
      // 创建两个用户
      const user1 = await userFactory.create();
      const user2 = await userFactory.create();

      // 获取令牌
      const token1 = await getAccessToken(user1.email);
      const token2 = await getAccessToken(user2.email);

      // 同一 spawn ID
      const spawnId = 'shared-spawn-123';

      // 并发捕捉
      const [res1, res2] = await Promise.all([
        request(runner.gatewayUrl)
          .post('/api/v1/catch/attempt')
          .set('Authorization', `Bearer ${token1}`)
          .send({ spawnId, ballType: 'pokeball' }),
        request(runner.gatewayUrl)
          .post('/api/v1/catch/attempt')
          .set('Authorization', `Bearer ${token2}`)
          .send({ spawnId, ballType: 'pokeball' })
      ]);

      // 只有一个用户应该成功
      const successCount = [res1.body.success, res2.body.success].filter(Boolean).length;
      expect(successCount).to.equal(1);
    });
  });
});

// backend/tests/integration/scenarios/BattleFlow.test.js
describe('战斗流程端到端测试', function() {
  this.timeout(60000);
  
  let runner;
  let userFactory;
  let pokemonFactory;
  let player1, player2;
  let pokemon1, pokemon2;

  before(async () => {
    runner = new IntegrationTestRunner({
      services: ['user-service', 'pokemon-service', 'gym-service']
    });
    
    await runner.setup();
    
    userFactory = new UserFactory(runner.dbPool);
    pokemonFactory = new PokemonFactory(runner.dbPool);
  });

  after(async () => {
    await runner.teardown();
  });

  describe('PVP 对战流程', () => {
    it('应该完成完整的对战流程', async () => {
      // 1. 创建玩家和精灵
      player1 = await userFactory.create();
      player2 = await userFactory.create();

      pokemon1 = await pokemonFactory.create({
        userId: player1.id,
        speciesId: 25, // Pikachu
        level: 50,
        attack: 80,
        defense: 60
      });

      pokemon2 = await pokemonFactory.create({
        userId: player2.id,
        speciesId: 6, // Charizard
        level: 50,
        attack: 90,
        defense: 70
      });

      // 2. 发起对战请求
      const token1 = await getAccessToken(player1.email);
      const token2 = await getAccessToken(player2.email);

      const battleReq = await request(runner.gatewayUrl)
        .post('/api/v1/gym/battle/request')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          opponentId: player2.id,
          pokemonIds: [pokemon1.id]
        });

      expect(battleReq.status).to.equal(200);
      const battleId = battleReq.body.battleId;

      // 3. 对手接受对战
      const acceptRes = await request(runner.gatewayUrl)
        .post(`/api/v1/gym/battle/${battleId}/accept`)
        .set('Authorization', `Bearer ${token2}`)
        .send({
          pokemonIds: [pokemon2.id]
        });

      expect(acceptRes.status).to.equal(200);

      // 4. 执行战斗回合
      const turn1 = await request(runner.gatewayUrl)
        .post(`/api/v1/gym/battle/${battleId}/turn`)
        .set('Authorization', `Bearer ${token1}`)
        .send({
          action: 'attack',
          moveId: 'thunder-shock'
        });

      expect(turn1.status).to.equal(200);
      expect(turn1.body.damage).to.be.greaterThan(0);

      // 5. 验证战斗结果
      const result = await request(runner.gatewayUrl)
        .get(`/api/v1/gym/battle/${battleId}/result`)
        .set('Authorization', `Bearer ${token1}`);

      expect(result.body.winner).to.exist;
      expect(result.body.experience).to.be.greaterThan(0);
    });
  });
});
```

### 5. 测试配置与运行脚本

```javascript
// backend/tests/integration/jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.integration.test.js'],
  testTimeout: 60000,
  setupFilesAfterEnv: ['./setup.js'],
  globalSetup: './globalSetup.js',
  globalTeardown: './globalTeardown.js',
  coverageDirectory: 'coverage/integration',
  collectCoverageFrom: [
    '../../services/**/*.js',
    '!../../services/**/node_modules/**'
  ]
};

// backend/tests/integration/setup.js
const IntegrationTestRunner = require('./framework/TestRunner');

let runner;

before(async function() {
  this.timeout(120000);
  runner = new IntegrationTestRunner();
  global.testRunner = runner;
  await runner.setup();
});

after(async function() {
  this.timeout(60000);
  await runner.teardown();
});

// backend/tests/integration/run.sh
#!/bin/bash
set -e

echo "Starting integration tests..."

# 检查 Docker 是否运行
if ! docker info > /dev/null 2>&1; then
  echo "Error: Docker is not running"
  exit 1
fi

# 运行集成测试
npm run test:integration -- \
  --coverage \
  --coverageReporters=lcov \
  --coverageReporters=text \
  --verbose

echo "Integration tests completed!"
```

### 6. CI/CD 集成

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: minego_test
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
      
      - name: Run database migrations
        run: npm run db:migrate:test
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/minego_test
      
      - name: Run integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/minego_test
          REDIS_URL: redis://localhost:6379
          NODE_ENV: test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/integration/lcov.info
          flags: integration
```

## 验收标准

- [ ] 集成测试框架支持服务编排（至少 4 个服务同时运行）
- [ ] 测试数据工厂覆盖核心实体（User、Pokemon、Item 等）
- [ ] Mock 服务管理器支持动态路由配置
- [ ] 端到端场景测试覆盖捕捉、战斗、交易流程
- [ ] 测试环境隔离（每个测试套件独立数据库实例）
- [ ] CI/CD 集成自动运行集成测试
- [ ] 测试报告生成（覆盖率、执行时间、失败详情）
- [ ] 并发测试支持（多用户同时操作场景）
- [ ] 测试数据库迁移自动化
- [ ] 测试结果可追溯（日志、截图、数据库快照）

## 影响范围

### 新增文件

- `backend/tests/integration/framework/TestRunner.js` - 测试运行器核心
- `backend/tests/integration/factories/*.js` - 测试数据工厂
- `backend/tests/integration/mocks/MockServiceManager.js` - Mock 服务管理
- `backend/tests/integration/scenarios/*.test.js` - 场景测试用例
- `backend/tests/integration/setup.js` - 测试环境配置
- `backend/tests/integration/jest.config.js` - Jest 配置
- `.github/workflows/integration-tests.yml` - CI 工作流

### 修改文件

- `package.json` - 添加测试脚本和依赖
- `backend/shared/testUtils.js` - 共享测试工具函数

## 参考

- [Jest Integration Testing Best Practices](https://jestjs.io/docs/testing-frameworks)
- [Testcontainers - Docker for Tests](https://www.testcontainers.org/)
- [Microservices Testing Patterns](https://martinfowler.com/articles/microservice-testing/)
