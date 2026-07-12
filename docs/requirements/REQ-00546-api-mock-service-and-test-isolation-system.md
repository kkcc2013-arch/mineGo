# REQ-00546：API Mock 服务与测试隔离系统

- **编号**：REQ-00546
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests、backend/shared/mockService、所有后端服务、gateway、.github/workflows
- **创建时间**：2026-07-12 18:45
- **依赖需求**：REQ-00022（集成测试框架）、REQ-00049（API 客户端 SDK）

## 1. 背景与问题

### 现状分析
mineGo 项目已建立完善的测试体系，包括：
- 单元测试（各服务独立）
- 集成测试（服务间交互）
- 契约测试（API Schema 验证）
- E2E 测试（端到端流程）
- 性能回归测试（API 性能基准）

### 测试痛点
1. **外部依赖不稳定**：测试依赖真实数据库、Redis、Kafka，导致：
   - 测试环境不可用时阻塞开发
   - 测试结果不可重复（数据状态影响结果）
   - 测试执行慢（等待 I/O 操作）

2. **跨服务测试困难**：
   - 微服务间调用需要启动多个服务
   - 测试顺序依赖（用户服务必须先启动）
   - CI/CD 中并行测试困难

3. **测试数据管理复杂**：
   - 每次测试需要重置数据库状态
   - 测试数据与生产数据混用 Schema
   - 数据清理不彻底导致测试污染

4. **第三方服务依赖**：
   - 支付网关测试依赖真实支付服务
   - 推送通知测试依赖 FCM/APNs
   - 地图 API 测试消耗配额

### 影响范围
- **测试执行时间**：当前完整测试套件执行时间 > 15 分钟
- **CI/CD 效率**：测试失败中 30% 是环境问题而非代码问题
- **开发体验**：本地开发需要启动完整基础设施才能运行测试

## 2. 目标

建立一套完整的 **API Mock 服务与测试隔离系统**，实现：

1. **服务 Mock 化**：为所有外部依赖提供 Mock 服务，支持动态配置响应
2. **测试隔离**：每个测试用例独立运行，不依赖外部状态
3. **数据工厂**：统一的测试数据生成和管理机制
4. **智能回放**：记录真实服务响应，支持回放模式
5. **性能优化**：测试执行时间降低 60%（从 15 分钟降至 6 分钟）

### 可量化目标
- 测试隔离率 ≥ 95%（测试不依赖外部服务状态）
- Mock 服务覆盖率 ≥ 90%（覆盖所有外部依赖）
- 测试执行时间 ≤ 6 分钟（完整测试套件）
- 测试稳定性 ≥ 98%（连续 10 次执行结果一致）

## 3. 范围

### 包含
- **Mock 服务引擎**：轻量级 HTTP/WebSocket Mock 服务器
- **服务虚拟化**：为 9 个微服务提供虚拟化版本
- **测试数据工厂**：统一的测试数据生成器
- **响应录制器**：记录真实服务响应用于回放
- **CI/CD 集成**：GitHub Actions 中启用 Mock 模式
- **开发工具**：本地 Mock 服务管理 CLI

### 不包含
- 生产环境 Mock（仅用于测试）
- API 性能测试 Mock（已有性能回归测试）
- 安全测试绕过（安全测试必须使用真实服务）

## 4. 详细需求

### 4.1 Mock 服务引擎

#### 4.1.1 核心 Mock 服务器
```javascript
// backend/shared/mockService/MockServer.js

class MockServer {
  /**
   * 创建 Mock 服务
   * @param {Object} config - 服务配置
   */
  constructor(config) {
    this.port = config.port || 9000;
    this.routes = new Map();
    this.recordings = [];
    this.mode = config.mode || 'replay'; // 'replay' | 'record' | 'passthrough'
  }

  /**
   * 注册 Mock 路由
   */
  on(method, path, handler) {
    const key = `${method.toUpperCase()} ${path}`;
    this.routes.set(key, handler);
  }

  /**
   * 设置动态响应
   */
  setResponse(method, path, response, options = {}) {
    this.on(method, path, (req, res) => {
      // 支持延迟、错误注入、条件响应
      if (options.delay) {
        return setTimeout(() => res.json(response), options.delay);
      }
      if (options.errorRate && Math.random() < options.errorRate) {
        return res.status(500).json({ error: 'Mock error' });
      }
      res.json(response);
    });
  }

  /**
   * 录制模式：记录真实响应
   */
  async record(realServiceUrl, req) {
    const response = await fetch(realServiceUrl + req.path, {
      method: req.method,
      body: JSON.stringify(req.body),
      headers: req.headers
    });
    const data = await response.json();
    this.recordings.push({
      request: { method: req.method, path: req.path, body: req.body },
      response: { status: response.status, data },
      timestamp: Date.now()
    });
    return data;
  }

  /**
   * 回放模式：返回录制的响应
   */
  replay(req) {
    const match = this.recordings.find(r => 
      r.request.method === req.method &&
      r.request.path === req.path &&
      JSON.stringify(r.request.body) === JSON.stringify(req.body)
    );
    return match?.response;
  }
}
```

#### 4.1.2 服务 Mock 配置
```javascript
// backend/shared/mockService/mocks/userServiceMock.js

const userServiceMock = new MockServer({ port: 9081 });

// 用户登录 Mock
userServiceMock.setResponse('POST', '/auth/login', {
  success: true,
  data: {
    userId: 12345,
    token: 'mock-jwt-token-xxxx',
    expiresIn: 3600
  }
}, { delay: 50 }); // 模拟 50ms 延迟

// 用户信息 Mock
userServiceMock.setResponse('GET', '/users/:id', (req, res) => {
  res.json({
    id: req.params.id,
    username: `mock_user_${req.params.id}`,
    email: `user${req.params.id}@test.com`,
    level: 25,
    coins: 1000
  });
});

// 错误场景 Mock
userServiceMock.setResponse('POST', '/auth/login', {
  error: 'INVALID_CREDENTIALS',
  message: '用户名或密码错误'
}, { errorRate: 0.1 }); // 10% 错误率

export default userServiceMock;
```

### 4.2 测试数据工厂

#### 4.2.1 数据生成器
```javascript
// backend/shared/mockService/DataFactory.js

class DataFactory {
  /**
   * 生成测试用户
   */
  static createUser(overrides = {}) {
    return {
      id: this.generateId(),
      username: `test_user_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
      phone: '13800138000',
      level: 1,
      exp: 0,
      coins: 100,
      ...overrides
    };
  }

  /**
   * 生成测试精灵
   */
  static createPokemon(overrides = {}) {
    const species = ['皮卡丘', '杰尼龟', '小火龙', '妙蛙种子', '超梦'];
    return {
      id: this.generateId(),
      species: species[Math.floor(Math.random() * species.length)],
      cp: Math.floor(Math.random() * 2000) + 100,
      iv: {
        attack: Math.floor(Math.random() * 15),
        defense: Math.floor(Math.random() * 15),
        stamina: Math.floor(Math.random() * 15)
      },
      level: Math.floor(Math.random() * 40) + 1,
      ownerId: 12345,
      ...overrides
    };
  }

  /**
   * 生成测试道馆
   */
  static createGym(overrides = {}) {
    return {
      id: this.generateId(),
      name: `Test Gym ${Date.now()}`,
      location: {
        type: 'Point',
        coordinates: [121.4737 + Math.random() * 0.01, 31.2304 + Math.random() * 0.01]
      },
      team: ['红队', '蓝队', '黄队'][Math.floor(Math.random() * 3)],
      prestige: 50000,
      defenders: [],
      ...overrides
    };
  }

  /**
   * 批量生成
   */
  static createBatch(factory, count) {
    return Array.from({ length: count }, () => factory());
  }

  static generateId() {
    return Math.floor(Math.random() * 1000000) + 1;
  }
}

export default DataFactory;
```

#### 4.2.2 测试夹具（Fixtures）
```javascript
// backend/tests/fixtures/index.js

export const fixtures = {
  users: {
    normal: DataFactory.createUser({ level: 10 }),
    admin: DataFactory.createUser({ level: 50, role: 'admin' }),
    newPlayer: DataFactory.createUser({ level: 1, tutorialCompleted: false })
  },
  
  pokemons: {
    common: DataFactory.createPokemon({ rarity: 'common' }),
    rare: DataFactory.createPokemon({ rarity: 'rare', cp: 2500 }),
    legendary: DataFactory.createPokemon({ species: '超梦', cp: 4000, rarity: 'legendary' })
  },
  
  gyms: {
    friendly: DataFactory.createGym({ team: '红队', prestige: 50000 }),
    enemy: DataFactory.createGym({ team: '蓝队', prestige: 30000 })
  }
};
```

### 4.3 服务虚拟化

#### 4.3.1 虚拟服务管理器
```javascript
// backend/shared/mockService/VirtualServiceManager.js

class VirtualServiceManager {
  constructor() {
    this.services = new Map();
  }

  /**
   * 启动虚拟服务
   */
  async startService(serviceName, mockConfig) {
    const mock = new MockServer(mockConfig);
    await mock.start();
    this.services.set(serviceName, mock);
    return mock;
  }

  /**
   * 批量启动所有服务
   */
  async startAll(configs) {
    const results = await Promise.all(
      Object.entries(configs).map(([name, config]) => 
        this.startService(name, config)
      )
    );
    return Object.fromEntries(
      Object.keys(configs).map((name, i) => [name, results[i]])
    );
  }

  /**
   * 停止所有虚拟服务
   */
  async stopAll() {
    for (const [name, mock] of this.services) {
      await mock.stop();
      console.log(`Stopped virtual service: ${name}`);
    }
    this.services.clear();
  }

  /**
   * 重置所有服务状态
   */
  resetAll() {
    for (const mock of this.services.values()) {
      mock.recordings = [];
    }
  }
}
```

#### 4.3.2 测试环境配置
```javascript
// backend/tests/setup/env.js

const virtualManager = new VirtualServiceManager();

// 测试前启动所有 Mock 服务
beforeAll(async () => {
  await virtualManager.startAll({
    'user-service': { port: 9081 },
    'location-service': { port: 9082 },
    'pokemon-service': { port: 9083 },
    'catch-service': { port: 9084 },
    'gym-service': { port: 9085 },
    'social-service': { port: 9086 },
    'reward-service': { port: 9087 },
    'payment-service': { port: 9088 },
    'gateway': { port: 9000 }
  });
});

// 每个测试后重置状态
afterEach(() => {
  virtualManager.resetAll();
});

// 所有测试后停止服务
afterAll(async () => {
  await virtualManager.stopAll();
});
```

### 4.4 响应录制器

#### 4.4.1 录制配置
```javascript
// backend/shared/mockService/Recorder.js

class Recorder {
  constructor(config) {
    this.targetServices = config.targetServices; // 真实服务 URL
    this.storagePath = config.storagePath || './test-recordings';
    this.mode = config.mode || 'passthrough'; // 'record' | 'replay' | 'passthrough'
  }

  /**
   * 创建录制代理
   */
  createProxy(serviceName) {
    return async (req, res, next) => {
      const cacheKey = this.getCacheKey(req);
      
      // 回放模式：直接返回录制数据
      if (this.mode === 'replay') {
        const cached = await this.loadRecording(cacheKey);
        if (cached) {
          return res.json(cached.response);
        }
      }
      
      // 录制/透传模式：调用真实服务
      const realUrl = this.targetServices[serviceName];
      const response = await fetch(realUrl + req.path, {
        method: req.method,
        body: JSON.stringify(req.body),
        headers: req.headers
      });
      
      const data = await response.json();
      
      // 录制模式：保存响应
      if (this.mode === 'record') {
        await this.saveRecording(cacheKey, {
          request: { method: req.method, path: req.path, body: req.body },
          response: { status: response.status, data },
          timestamp: Date.now()
        });
      }
      
      res.json(data);
    };
  }
}
```

#### 4.4.2 录制数据格式
```json
{
  "id": "rec_20260712_001",
  "service": "payment-service",
  "requests": [
    {
      "request": {
        "method": "POST",
        "path": "/payments/create",
        "body": { "userId": 12345, "amount": 100, "currency": "CNY" }
      },
      "response": {
        "status": 200,
        "data": {
          "paymentId": "pay_mock_001",
          "status": "success",
          "transactionId": "tx_123456789"
        }
      },
      "timestamp": 1720783200000
    }
  ]
}
```

### 4.5 CI/CD 集成

#### 4.5.1 GitHub Actions 配置
```yaml
# .github/workflows/test-mock.yml
name: Mock Service Tests

on: [push, pull_request]

jobs:
  mock-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        working-directory: backend
        run: npm install
      
      - name: Run tests with Mock services
        working-directory: backend
        run: npm run test:mock
        env:
          TEST_MODE: mock
          MOCK_SERVICES_ENABLED: true
      
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: backend/coverage/
```

### 4.6 本地开发工具

#### 4.6.1 Mock CLI
```bash
# 启动所有 Mock 服务
npm run mock:start

# 录制真实服务响应
npm run mock:record -- --service payment-service

# 回放录制的响应
npm run mock:replay

# 查看 Mock 服务状态
npm run mock:status

# 清除录制数据
npm run mock:clear
```

#### 4.6.2 package.json 脚本
```json
{
  "scripts": {
    "test:mock": "NODE_ENV=test MOCK_MODE=true jest",
    "mock:start": "node scripts/start-mock-services.js",
    "mock:record": "node scripts/record-service-responses.js",
    "mock:replay": "node scripts/replay-recordings.js",
    "mock:status": "node scripts/mock-service-status.js"
  }
}
```

## 5. 验收标准（可测试）

### 5.1 Mock 服务验收
- [ ] 所有 9 个微服务都有对应的 Mock 实现
- [ ] Mock 服务支持动态响应配置（延迟、错误率、条件响应）
- [ ] Mock 服务启动时间 < 2 秒
- [ ] Mock 服务支持 WebSocket 协议

### 5.2 测试隔离验收
- [ ] 测试套件可独立运行（无需启动真实数据库/Redis/Kafka）
- [ ] 测试结果不依赖执行顺序
- [ ] 并行测试执行无冲突
- [ ] 测试清理后无残留数据

### 5.3 性能验收
- [ ] 完整测试套件执行时间 ≤ 6 分钟（当前 ~15 分钟）
- [ ] 单个测试用例执行时间 < 1 秒
- [ ] Mock 服务响应延迟 < 10ms

### 5.4 录制回放验收
- [ ] 支持录制真实服务响应
- [ ] 录制数据可序列化为 JSON
- [ ] 回放响应与真实响应一致性 ≥ 99%
- [ ] 支持录制数据版本管理

### 5.5 开发体验验收
- [ ] 本地启动 Mock 服务 < 5 秒
- [ ] CLI 命令清晰易用
- [ ] Mock 服务状态可视化
- [ ] 支持 Mock 服务调试（日志、断点）

### 5.6 测试覆盖
- [ ] MockServer 单元测试覆盖率 ≥ 85%
- [ ] DataFactory 单元测试覆盖率 ≥ 90%
- [ ] VirtualServiceManager 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖主要 Mock 场景

## 6. 工作量估算

**估算：L（Large）**

**工作量分解：**
1. **Mock 服务引擎**：2 天
   - MockServer 核心实现（1 天）
   - 路由匹配和响应处理（0.5 天）
   - WebSocket Mock 支持（0.5 天）

2. **测试数据工厂**：1.5 天
   - DataFactory 核心实现（0.5 天）
   - 各类实体生成器（0.5 天）
   - 测试夹具（0.5 天）

3. **服务虚拟化**：2 天
   - VirtualServiceManager 实现（1 天）
   - 9 个服务的 Mock 配置（1 天）

4. **响应录制器**：1 天
   - Recorder 实现（0.5 天）
   - 录制数据存储和管理（0.5 天）

5. **CI/CD 集成**：0.5 天
   - GitHub Actions 配置（0.5 天）

6. **本地开发工具**：1 天
   - CLI 命令实现（0.5 天）
   - 状态可视化和调试（0.5 天）

7. **测试和文档**：2 天
   - 单元测试（1 天）
   - 集成测试（0.5 天）
   - 文档和示例（0.5 天）

**总计**：10 人天

## 7. 优先级理由

**P1（高优先级）**

**理由：**
1. **测试效率瓶颈**：当前测试执行时间长（>15 分钟），严重影响开发效率和 CI/CD 效率

2. **测试稳定性问题**：30% 测试失败是环境问题，浪费大量调试时间

3. **支撑持续集成**：Mock 服务是高效 CI/CD 的基础设施，影响所有后续需求

4. **降低测试成本**：减少对真实服务的依赖，降低测试环境成本

5. **提升开发体验**：本地开发无需启动完整基础设施，提升开发效率

**对"项目可用"的贡献：**
- 提升测试效率 60%（15 分钟 → 6 分钟）
- 提升测试稳定性到 98% 以上
- 支持 CI/CD 并行测试
- 降低测试环境维护成本

## 8. 技术方案选择

### 8.1 Mock 框架选型
| 方案 | 优点 | 缺点 | 推荐 |
|------|------|------|------|
| 自研 MockServer | 完全可控、轻量级 | 开发成本高 | ✅ |
| Mock Service Worker | 成熟方案、浏览器支持 | Node 环境支持有限 | ⚠️ |
| Nock | 简单易用 | 仅 HTTP、不支持 WebSocket | ⚠️ |
| MirageJS | 功能丰富 | 学习曲线陡 | ⚠️ |

**推荐**：自研 MockServer，因为需要 WebSocket 支持和完全可控性

### 8.2 数据工厂模式
采用 **Factory Girl Pattern**，参考：
- factory-bot (Ruby)
- factory-boy (Python)
- rosie (JavaScript)

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Mock 响应与真实服务不一致 | 测试通过但生产失败 | 定期录制真实响应验证 |
| Mock 服务维护成本 | 新 API 需要更新 Mock | 自动化生成 Mock 配置 |
| 录制数据过时 | 回放测试失效 | 版本管理和定期更新 |
| 并发测试冲突 | 测试结果不一致 | 每个测试用例独立 Mock 实例 |

## 10. 后续优化

**Phase 2（可选）：**
- 智能录制：自动识别和录制新 API
- Mock DSL：声明式 Mock 配置语言
- 可视化编辑器：图形化 Mock 配置
- 性能测试 Mock：支持压力测试场景
