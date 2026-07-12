# REQ-00544：微服务测试数据工厂模式与智能 Fixture 生成系统

- **编号**：REQ-00544
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests、backend/shared/testUtils、catch-service、gym-service、pokemon-service、user-service
- **创建时间**：2026-07-12 16:03 UTC
- **依赖需求**：REQ-00366（单元测试覆盖）

## 1. 背景与问题

当前 mineGo 项目的测试数据管理存在以下问题：

**现状痛点**：
1. **测试数据硬编码**：现有测试中数据直接写死在测试文件内，无法复用，维护困难
2. **数据一致性差**：不同测试用例使用不同的数据格式，难以保证数据模型一致性
3. **关联数据管理混乱**：精灵捕捉、道馆战斗等场景需要多表关联数据，目前手动构造效率低
4. **边界条件覆盖不足**：缺少智能生成边界值和异常数据的能力
5. **测试隔离性弱**：测试间数据相互干扰，无法并行执行

**实际代码问题**：
- `catch-service` 有 12 个路由文件，但缺少测试数据构造工具
- `pokemon-service` 精灵数据模型复杂（属性、技能、进化链），手工构造测试数据繁琐
- `gym-service` 战斗系统需要精灵、玩家、道馆三层数据关联
- 缺少统一的 Test Fixture 生成策略

## 2. 目标

建立标准化的测试数据工厂模式系统：

1. **统一数据工厂架构**：为每个核心实体创建数据工厂类，支持链式调用和灵活配置
2. **智能数据关联**：自动处理实体间依赖关系，一键生成完整的测试场景数据
3. **边界值自动生成**：根据数据模型约束自动生成边界值、异常值测试数据
4. **测试隔离保障**：每个测试用例使用独立的数据空间，支持并行测试
5. **覆盖率提升支持**：提供便捷的数据构造工具，降低编写测试的门槛

## 3. 范围

- **包含**：
  - 基础工厂类架构设计（BaseFactory、FactoryBuilder）
  - 核心实体数据工厂实现（PokemonFactory、UserFactory、GymFactory、CatchFactory）
  - 关联数据构建器（BattleScenarioBuilder、EvolutionChainBuilder）
  - 边界值生成器（BoundaryGenerator、ConstraintValidator）
  - 测试数据持久化层（TestDataRepository、CleanupManager）
  - 工具函数和断言助手（AssertionHelpers、DataMatchers）
  - 与现有测试框架集成（Jest、Mocha）

- **不包含**：
  - E2E 测试环境数据管理（由 REQ-00022 覆盖）
  - Mock 服务替身系统（已有 ApiClientMock）
  - 性能压测数据生成（由 REQ-00033 覆盖）

## 4. 详细需求

### 4.1 基础工厂类架构

```javascript
// backend/shared/testUtils/BaseFactory.js
class BaseFactory {
  constructor(model) {
    this.model = model;
    this.attributes = {};
    this.states = [];
  }
  
  // 链式属性设置
  with(attr, value) { ... }
  withAttributes(attrs) { ... }
  
  // 状态模式
  states(names) { ... }
  
  // 生成实体
  make() { ... }  // 不持久化
  create() { ... } // 持久化并返回
  
  // 批量生成
  createMany(count) { ... }
  
  // 序列化
  raw() { ... }
}
```

### 4.2 核心实体数据工厂

**PokemonFactory**：
- 支持 151 种精灵模板数据
- 自动生成属性值（HP、攻击、防御、速度等）
- 支持特殊状态：legendary、mythical、shiny
- 关联技能、进化链、栖息地

**UserFactory**：
- 支持不同用户状态：active、banned、mfa_enabled
- 关联精灵背包、物品栏、成就
- 支持玩家等级、经验值配置

**GymFactory**：
- 关联道馆位置、防守精灵
- 支持 Raid 配置、战斗规则
- 支持道馆状态：neutral、team_controlled

**CatchFactory**：
- 支持不同捕捉场景：wild、lure、raid
- 自动计算捕捉概率相关数据
- 关联天气、地形加成

### 4.3 关联数据构建器

```javascript
// backend/shared/testUtils/scenarioBuilders/BattleScenarioBuilder.js
class BattleScenarioBuilder {
  // 一键生成完整战斗场景
  async build() {
    const gym = await GymFactory.create();
    const attacker = await UserFactory.create()
      .withPokemon(await PokemonFactory.createMany(6))
      .create();
    const defender = await UserFactory.create()
      .withPokemon(await PokemonFactory.create().states('legendary').create())
      .create();
    
    return { gym, attacker, defender };
  }
}
```

### 4.4 边界值生成器

```javascript
// backend/shared/testUtils/BoundaryGenerator.js
class BoundaryGenerator {
  // 根据模型约束生成边界值
  generateForModel(modelSchema) {
    return {
      min: this.generateMinValues(modelSchema),
      max: this.generateMaxValues(modelSchema),
      invalid: this.generateInvalidValues(modelSchema),
      edge: this.generateEdgeCases(modelSchema)
    };
  }
}
```

### 4.5 测试数据隔离

```javascript
// backend/shared/testUtils/TestDataContext.js
class TestDataContext {
  constructor() {
    this.dataRegistry = new Set();
  }
  
  // 注册测试数据，测试结束后自动清理
  async register(entity) { ... }
  
  // 清理所有测试数据
  async cleanup() { ... }
}
```

### 4.6 文件结构

```
backend/shared/testUtils/
├── BaseFactory.js
├── FactoryBuilder.js
├── BoundaryGenerator.js
├── ConstraintValidator.js
├── TestDataContext.js
├── CleanupManager.js
├── factories/
│   ├── PokemonFactory.js
│   ├── UserFactory.js
│   ├── GymFactory.js
│   ├── CatchFactory.js
│   ├── ItemFactory.js
│   └── BattleFactory.js
├── scenarioBuilders/
│   ├── BattleScenarioBuilder.js
│   ├── EvolutionScenarioBuilder.js
│   ├── RaidScenarioBuilder.js
│   └── TradeScenarioBuilder.js
├── templates/
│   ├── pokemonData.json  # 151种精灵模板
│   ├── moveData.json     # 技能模板
│   └── itemData.json     # 道具模板
├── AssertionHelpers.js
└── DataMatchers.js
```

## 5. 验收标准（可测试）

- [ ] PokemonFactory 能生成所有 151 种精灵的基础数据，属性值符合游戏规则
- [ ] UserFactory 支持生成关联精灵背包、物品栏的用户实例，数据完整性校验通过
- [ ] BattleScenarioBuilder 能一键生成完整的道馆战斗场景数据（含道馆、攻守双方、6只精灵）
- [ ] BoundaryGenerator 能为任意模型生成边界值测试数据集（min、max、invalid、edge）
- [ ] TestDataContext 支持测试数据自动清理，10 个并发测试运行后数据无残留
- [ ] 使用数据工厂重构现有测试文件至少 3 个，代码量减少 40%+
- [ ] 新增工具库单元测试覆盖率 ≥ 90%
- [ ] 集成到现有测试框架，Jest 配置文件正确引用工具库

## 6. 工作量估算

**M (3-5 天)**

- 理由：需要设计架构（1天）+ 实现核心工厂类（2天）+ 实现场景构建器（1天）+ 集成测试和文档（1天）

## 7. 优先级理由

**P1 理由**：
1. **提升测试效率**：标准化的数据构造工具能显著降低编写测试的门槛，加速 REQ-00366 的落地
2. **测试质量保障**：边界值生成器能自动发现潜在的数据校验漏洞，提升代码质量
3. **基础设施优先**：数据工厂是测试体系的基石，应尽早完成以支持后续测试覆盖工作
4. **技术债清偿**：解决硬编码测试数据问题，提升代码可维护性

## 8. 相关需求

- REQ-00366：微服务核心业务逻辑单元测试覆盖率提升
- REQ-00022：集成测试框架（已有 ApiClientMock）
- REQ-00525：Property-Based Testing 框架（边界值生成器可复用）

## 9. 参考资料

- Factory Girl Pattern: https://thoughtbot.com/blog/waiting-for-a-factory-girl
- Test Data Management Best Practices
- Jest Testing Patterns
