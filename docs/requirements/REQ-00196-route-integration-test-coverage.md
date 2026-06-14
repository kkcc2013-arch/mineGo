# REQ-00196：微服务路由层集成测试覆盖率提升计划

- **编号**：REQ-00196
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：所有微服务、backend/tests/integration、backend/tests/unit
- **创建时间**：2026-06-14 13:00
- **依赖需求**：REQ-00036（前端 Playwright E2E 测试系统）、REQ-00093（API 契约测试系统）

## 1. 背景与问题

当前 mineGo 项目测试体系存在以下缺口：

1. **路由层测试覆盖不完整**：项目共有 41 个路由模块，但单元测试仅覆盖 104 个文件，存在以下路由缺少专门测试：
   - `abilities`（精灵能力路由）
   - `battle`（战斗路由）
   - `bondSkills`（羁绊技能路由）
   - `equipment`（装备路由）
   - `friend/friends`（好友路由）
   - `ipAppeal`（IP申诉路由）
   - `privacy`（隐私路由）
   - `sessions`（会话路由）
   - `share`（分享路由）
   - `showcase`（展示路由）
   - `spawnConfig`（刷新配置路由）
   - `statusEffects`（状态效果路由）

2. **集成测试覆盖不均衡**：integration 测试目录存在，但部分关键服务缺少端到端的集成测试覆盖

3. **测试隔离性不足**：部分测试共享状态，可能产生依赖问题

## 2. 目标

- 补充缺失的路由层单元测试
- 提升微服务集成测试覆盖率至 80%+
- 建立测试覆盖率持续监控机制
- 确保测试隔离性和可重复性

## 3. 范围

- **包含**：
  - 为缺失测试的路由模块创建单元测试
  - 为关键业务流程创建集成测试
  - 添加测试覆盖率报告生成
  - 创建测试辅助工具和 mock 工具

- **不包含**：
  - E2E 测试（已有 REQ-00036）
  - 性能测试（已有 REQ-00033）
  - 混沌测试（已有 REQ-00087）

## 4. 详细需求

### 4.1 路由层单元测试模板

```javascript
// backend/tests/unit/{route-name}.test.js
const { describe, it, before, after, beforeEach, expect } = require('node:test');
const request = require('supertest');
const express = require('express');

// 测试标准结构
describe('{RouteName} Routes', () => {
  let app;
  let mockDb;
  let mockRedis;

  before(async () => {
    // 初始化测试环境
    app = express();
    mockDb = createMockDb();
    mockRedis = createMockRedis();
    // 挂载路由
    app.use('/api/{route}', require('{route-path}'));
  });

  after(async () => {
    // 清理测试资源
  });

  describe('GET /api/{route}', () => {
    it('should return list with pagination', async () => {
      // 测试逻辑
    });

    it('should handle empty results', async () => {
      // 测试逻辑
    });
  });

  describe('POST /api/{route}', () => {
    it('should create new resource', async () => {
      // 测试逻辑
    });

    it('should validate input', async () => {
      // 测试逻辑
    });

    it('should handle conflicts', async () => {
      // 测试逻辑
    });
  });
});
```

### 4.2 需要补充测试的路由清单

| 路由名 | 服务 | 测试文件 | 状态 |
|--------|------|----------|------|
| abilities | pokemon-service | abilities.test.js | 待创建 |
| battle | gym-service | battle-routes.test.js | 待创建 |
| bondSkills | pokemon-service | bondSkills.test.js | 待创建 |
| equipment | pokemon-service | equipment-routes.test.js | 待创建 |
| friend | social-service | friend-routes.test.js | 待创建 |
| ipAppeal | user-service | ipAppeal.test.js | 待创建 |
| privacy | user-service | privacy-routes.test.js | 待创建 |
| sessions | user-service | sessions.test.js | 待创建 |
| share | social-service | share.test.js | 待创建 |
| showcase | pokemon-service | showcase-routes.test.js | 待创建 |
| spawnConfig | location-service | spawnConfig.test.js | 待创建 |
| statusEffects | pokemon-service | statusEffects.test.js | 待创建 |

### 4.3 集成测试关键场景

```javascript
// backend/tests/integration/user-journey.test.js

describe('User Journey Integration Tests', () => {
  describe('Complete Catch Flow', () => {
    it('should handle user registration -> location update -> pokemon spawn -> catch -> reward', async () => {
      // 完整捕捉流程测试
    });
  });

  describe('Gym Battle Flow', () => {
    it('should handle gym discovery -> battle initiation -> result calculation -> rewards', async () => {
      // 道馆战斗流程测试
    });
  });

  describe('Payment Flow', () => {
    it('should handle order creation -> payment processing -> inventory update', async () => {
      // 支付流程测试
    });
  });
});
```

### 4.4 测试覆盖率报告配置

```json
// package.json
{
  "scripts": {
    "test:coverage": "node --test --experimental-test-coverage backend/tests/**/*.test.js",
    "test:coverage:report": "c8 --reporter=html --reporter=text node --test backend/tests/**/*.test.js"
  }
}
```

### 4.5 测试辅助工具

```javascript
// backend/tests/helpers/mock-factory.js
class MockFactory {
  static createUser(overrides = {}) {
    return {
      id: 1,
      username: 'testuser',
      email: 'test@example.com',
      region: 'US',
      ...overrides
    };
  }

  static createPokemon(overrides = {}) {
    return {
      id: 1,
      species_id: 25,
      level: 10,
      hp: 100,
      attack: 50,
      defense: 40,
      ...overrides
    };
  }

  static createGym(overrides = {}) {
    return {
      id: 1,
      name: 'Test Gym',
      latitude: 37.7749,
      longitude: -122.4194,
      team_id: 1,
      ...overrides
    };
  }
}

// backend/tests/helpers/test-db.js
class TestDatabase {
  static async setup() {
    // 创建测试数据库连接
  }

  static async seed(data) {
    // 填充测试数据
  }

  static async cleanup() {
    // 清理测试数据
  }

  static async teardown() {
    // 销毁测试数据库
  }
}
```

## 5. 验收标准（可测试）

- [ ] 12 个缺失测试的路由模块全部创建对应的测试文件
- [ ] 每个路由测试文件包含至少 5 个测试用例（正常流程 + 边界条件 + 错误处理）
- [ ] 新增集成测试覆盖至少 3 个关键用户流程
- [ ] `npm run test:coverage` 命令可生成覆盖率报告
- [ ] 测试覆盖率达到 80%+（关键服务）
- [ ] 所有测试可独立运行，无状态依赖问题
- [ ] CI 流水线集成覆盖率检查

## 6. 工作量估算

**M** - 需要为 12 个路由模块创建测试文件，补充 3 个集成测试场景，配置覆盖率报告，预计 1-2 天工作量。

## 7. 优先级理由

P1 级别：测试覆盖率直接影响代码质量和维护成本。完整的路由层测试可以在重构和功能迭代时快速发现问题，避免回归 bug。当前测试覆盖缺口较大，补充测试是保障系统稳定性的重要措施。
