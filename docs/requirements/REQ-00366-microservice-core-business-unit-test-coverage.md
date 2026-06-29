# REQ-00366：微服务核心业务逻辑单元测试覆盖率提升与自动化测试守卫系统

- **编号**：REQ-00366
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：catch-service、gym-service、pokemon-service、user-service、backend/tests/unit、backend/shared/testUtils、.github/workflows
- **创建时间**：2026-06-29 14:00 UTC
- **依赖需求**：REQ-00004（支付服务测试）、REQ-00022（集成测试框架）

## 1. 背景与问题

当前 mineGo 项目虽然已建立测试框架基础，但核心微服务的单元测试覆盖率严重不足：

**现状痛点**：
1. **覆盖率极低**：仅有 1 个单元测试文件（`abilityService.test.js`），3 个路由文件，核心业务逻辑缺乏测试保障
2. **关键服务无测试**：`catch-service`（捕捉系统）、`gym-service`（道馆战斗）、`pokemon-service`（精灵管理）的核心业务逻辑缺乏单元测试
3. **测试守卫缺失**：没有自动化机制确保新代码提交时携带足够的测试覆盖
4. **测试报告不完善**：缺少分服务的覆盖率报告和阈值控制机制

**风险影响**：
- 代码变更可能导致回归缺陷难以及时发现
- 生产环境故障排查困难，缺乏测试定位能力
- 新开发者无法通过测试理解业务逻辑

## 2. 目标

建立完善的微服务核心业务逻辑单元测试体系，实现：

1. **核心服务测试覆盖率达 80%+**：catch-service、gym-service、pokemon-service、user-service 的关键业务逻辑
2. **自动化测试守卫**：PR 提交时自动检查新增代码的测试覆盖率，低于阈值则阻止合并
3. **分服务覆盖率报告**：每个微服务独立的覆盖率统计和趋势追踪
4. **测试工具标准化**：统一的测试工具库、Mock 策略、断言规范

## 3. 范围

- **包含**：
  - catch-service 核心逻辑单元测试（捕捉概率计算、奖励结算、精灵球物理模拟）
  - gym-service 核心逻辑单元测试（道馆占领、战斗结算、Raid 匹配）
  - pokemon-service 核心逻辑单元测试（精灵生成、属性计算、进化逻辑）
  - user-service 核心逻辑单元测试（用户认证、会话管理、权限验证）
  - 测试工具库开发（统一 Mock、Test Fixtures、断言助手）
  - GitHub Actions 测试守卫 Workflow 配置
  - 覆盖率报告生成与阈值控制

- **不包含**：
  - 前端 game-client 测试（已由 REQ-00036 覆盖）
  - E2E 集成测试（已由 REQ-00022 覆盖）
  - API 契约测试（已由 REQ-00093 完成）
  - 性能压测（已由 REQ-00033 覆盖）

## 4. 详细需求

### 4.1 核心业务单元测试实现

#### Catch-Service 测试模块
```javascript
// backend/tests/unit/catch-service/
├── catchProbability.test.js      // 捕捉概率计算测试
├── rewardCalculation.test.js     // 奖励结算测试
├── ballPhysics.test.js           // 精灵球物理模拟测试
├── catchAnomaly.test.js          // 捕捉异常检测测试
└── catchBonus.test.js            // 捕捉加成（天气、道具）测试
```

**测试覆盖要点**：
- 不同精灵类型、CP 值、稀有度的捕捉概率边界值测试
- 精灵球类型（普通球、高级球、大师球）效果计算
- 奖励 XP、糖果、星尘的计算规则
- 曲线球、精准投掷的加成计算
- 天气加成、道具效果叠加逻辑

#### Gym-Service 测试模块
```javascript
// backend/tests/unit/gym-service/
├── gymOccupation.test.js         // 遵馆占领逻辑测试
├── battleCalculation.test.js     // 战斗结算计算测试
├── raidMatching.test.js          // Raid 匹配测试
├── gymDefense.test.js            // 遵馆防守配置测试
└── gymRewards.test.js            // 遵馆奖励测试
```

**测试覆盖要点**：
- 遵馆占领时间窗口、团队归属计算
- 战斗伤害公式、属性克制计算
- Raid Boss 等级、时间限制、奖励池
- 多人 Raid 匹配逻辑、团队协作奖励
- 遵馆防守配置优化建议

#### Pokemon-Service 测试模块
```javascript
// backend/tests/unit/pokemon-service/
├── pokemonGeneration.test.js     // 精灵生成逻辑测试
├── attributeCalculation.test.js  // 属性计算测试
├── evolutionLogic.test.js        // 进化逻辑测试
├── skillSystem.test.js           // 技能系统测试（已有 abilityService.test.js 扩展）
└── pokemonValidation.test.js     // 精灵数据验证测试
```

**测试覆盖要点**：
- 精灵基础属性（HP、攻击、防御、速度）计算公式
- IV（个体值）随机生成与遗传
- 进化条件（等级、道具、友情）判定
- 技能学习、技能冷却、技能效果
- 精灵数据合法性验证（防止作弊数据）

#### User-Service 测试模块
```javascript
// backend/tests/unit/user-service/
├── userAuthentication.test.js    // 用户认证测试
├── sessionManagement.test.js     // 会话管理测试
├── permissionValidation.test.js  // 权限验证测试
├── userProfile.test.js           // 用户档案测试
└── deviceBinding.test.js         // 设备绑定测试
```

**测试覆盖要点**：
- JWT Token 生成、验证、刷新逻辑
- 会话过期、并发登录限制
- 用户角色、权限矩阵验证
- 设备绑定、信任设备管理
- 用户数据加密、隐私保护

### 4.2 测试工具库标准化

```javascript
// backend/shared/testUtils/
├── mockFactories.js              // 统一 Mock 数据工厂
├── testFixtures.js               // 测试数据 Fixtures
├── assertionHelpers.js           // 断言助手函数
├── dbTestHelper.js               // 数据库测试助手
├── redisTestHelper.js            // Redis 测试助手
└── kafkaTestHelper.js            // Kafka 测试助手
```

**Mock 数据工厂**：
```javascript
// 创建测试精灵数据
const mockPokemon = TestFixtures.createPokemon({
  id: 'pokemon-001',
  species: 'pikachu',
  cp: 500,
  iv: { attack: 15, defense: 14, stamina: 13 }
});

// 创建测试用户数据
const mockUser = TestFixtures.createUser({
  id: 'user-001',
  level: 25,
  team: 'valor'
});
```

**断言助手**：
```javascript
// 业务逻辑断言
expect(catchResult).toBeValidCatch();
expect(battleResult).toHaveDamageWithin(expectedRange);
expect(evolutionResult).toEvolveTo(targetSpecies);
```

### 4.3 自动化测试守卫

GitHub Actions Workflow：
```yaml
# .github/workflows/test-coverage-guard.yml
name: Test Coverage Guard

on:
  pull_request:
    branches: [main, develop]

jobs:
  coverage-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run tests with coverage
        run: npm run test:coverage
        
      - name: Check coverage threshold
        uses: actions/coverage-threshold@v1
        with:
          threshold: 80
          fail-on-under-coverage: true
          
      - name: Generate coverage report
        run: npm run test:coverage-report
        
      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: ./backend/coverage/lcov.info
```

### 4.4 分服务覆盖率报告

```javascript
// backend/scripts/coverage-report.js
const services = ['catch-service', 'gym-service', 'pokemon-service', 'user-service'];

services.forEach(service => {
  console.log(`${service}: ${getCoverage(service)}%`);
});

// 输出格式：
// catch-service: 82%
// gym-service: 78%
// pokemon-service: 85%
// user-service: 81%
// Total: 81.5%
```

### 4.5 测试配置标准化

```javascript
// backend/jest.config.js (统一配置)
module.exports = {
  testEnvironment: 'node',
  coverageDirectory: './coverage',
  collectCoverageFrom: [
    'services/*/src/**/*.js',
    'shared/**/*.js',
    '!**/node_modules/**',
    '!**/tests/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  setupFilesAfterEnv: ['./shared/testUtils/jestSetup.js']
};
```

## 5. 验收标准（可测试）

- [ ] catch-service 核心业务逻辑单元测试覆盖率 ≥ 80%
- [ ] gym-service 核心业务逻辑单元测试覆盖率 ≥ 80%
- [ ] pokemon-service 核心业务逻辑单元测试覆盖率 ≥ 80%
- [ ] user-service 核心业务逻辑单元测试覆盖率 ≥ 80%
- [ ] 测试工具库 `backend/shared/testUtils/` 完整实现（Mock 工厂、Fixtures、断言助手）
- [ ] GitHub Actions 测试守卫 Workflow 正常运行，低于 80% 覆盖率阻止 PR 合并
- [ ] 分服务覆盖率报告生成脚本正常运行，输出各服务独立覆盖率
- [ ] 所有新增测试通过执行 `npm test` 无报错
- [ ] 测试执行时间控制在 60 秒内（性能约束）
- [ ] 测试文档 `backend/tests/README.md` 完整，包含测试编写指南

## 6. 工作量估算

**L（Large）** - 涉及 4 个核心微服务的单元测试编写、测试工具库开发、CI/CD 配置

**理由**：
- 需为 4 个服务编写约 20+ 个测试文件，每个文件约 10-15 个测试用例
- 测试工具库开发需要设计统一的 Mock 策略和断言规范
- GitHub Actions 配置需要调试和验证
- 预计耗时 2-3 天

## 7. 优先级理由

**P1 优先级**：
- 测试覆盖率是项目质量保障的基础，当前评分仅 8/10
- 核心业务逻辑缺乏测试保障，生产环境风险高
- 提升测试覆盖率至 80%+ 是 STATUS.md 明确的下一阶段目标
- 测试守卫机制能防止后续代码质量下降