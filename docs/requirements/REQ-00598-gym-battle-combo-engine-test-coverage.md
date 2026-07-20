# REQ-00598：道馆战斗引擎与连击系统单元测试覆盖

- **编号**：REQ-00598
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service, battleEngine.js, comboEngine.js
- **创建时间**：2026-07-20 00:05
- **依赖需求**：REQ-00054（道馆战斗系统）

## 1. 背景与问题

道馆战斗系统是 mineGo 核心玩法之一，包含两个关键模块：

- **battleEngine.js**（796 行）：回合制战斗逻辑、属性克制、伤害计算、状态效果
- **comboEngine.js**（441 行）：技能序列检测、连击判定、奖励计算

当前这两个核心模块**完全没有单元测试**，存在以下风险：

1. **回归风险高**：战斗规则涉及 18 种属性克制、6 种状态效果，任何改动可能破坏平衡
2. **边界条件未验证**：伤害计算涉及暴击、STAB、属性克制的多重叠加，边界情况难以人工验证
3. **重构困难**：缺少测试保护，任何性能优化或功能扩展都可能引入隐蔽 Bug
4. **生产故障难以定位**：战斗异常时无测试用例参考，排查效率低

当前 gym-service 模块测试覆盖率约 35%，远低于项目目标 80%。

## 2. 目标

为道馆战斗核心引擎补充完整单元测试，达成：

- **battleEngine.js 测试覆盖率 ≥ 90%**
- **comboEngine.js 测试覆盖率 ≥ 90%**
- **关键战斗场景 100% 覆盖**
- 建立战斗规则测试矩阵，支撑后续迭代

## 3. 范围

### 包含
- battleEngine.js 核心逻辑测试（伤害计算、属性克制、状态效果）
- comboEngine.js 连击系统测试（序列检测、奖励计算、超时处理）
- 边界条件与异常场景测试
- 性能基准测试（单场战斗计算 < 10ms）
- 测试数据工厂（Pokemon、技能、状态模板）

### 不包含
- E2E 集成测试（已有单独需求）
- 性能压测工具（非测试范畴）
- 前端战斗渲染测试

## 4. 详细需求

### 4.1 battleEngine.js 测试用例

#### 4.1.1 伤害计算测试

```javascript
describe('BattleEngine - Damage Calculation', () => {
  test('基础伤害计算', () => {
    // 威力 50，无克制，无暴击
    const result = calculateDamage(attacker, defender, move);
    expect(result.baseDamage).toBeCloseTo(expected, 0.01);
  });
  
  test('STAB 加成（同属性招式）', () => {
    // 火系精灵使用火系招式，伤害 x1.5
    expect(result.damage).toBe(baseDamage * 1.5);
  });
  
  test('属性克制叠加', () => {
    // 水系招式攻击火系 + STAB
    // 克制 x2 + STAB x1.5 = x3
    expect(result.multiplier).toBe(3);
  });
  
  test('暴击计算', () => {
    // 暴击率 1/24，伤害 x1.5
    mockRandom(0.01); // 强制暴击
    expect(result.isCritical).toBe(true);
    expect(result.damage).toBe(baseDamage * 1.5);
  });
  
  test('伤害浮动范围', () => {
    // 伤害浮动 85% ~ 100%
    const damages = runMultiple(1000);
    const min = Math.min(...damages);
    const max = Math.max(...damages);
    expect(min).toBeGreaterThanOrEqual(baseDamage * 0.85);
    expect(max).toBeLessThanOrEqual(baseDamage);
  });
});
```

#### 4.1.2 属性克制测试矩阵

```javascript
describe('BattleEngine - Type Effectiveness', () => {
  const TEST_MATRIX = [
    // [攻击方, 防守方, 期望倍率]
    ['fire', 'grass', 2.0],
    ['fire', 'water', 0.5],
    ['fire', 'fire', 0.5],
    ['water', 'fire', 2.0],
    ['electric', 'ground', 0],   // 无效
    ['ghost', 'normal', 0],      // 无效
    ['dragon', 'fairy', 0],      // 无效
    ['fighting', 'ghost', 0],    // 无效
    // 双属性测试
    ['fire', ['water', 'dragon'], 0.25],  // 0.5 * 0.5
    ['rock', ['fire', 'flying'], 4.0],    // 2 * 2
  ];
  
  test.each(TEST_MATRIX)('属性克制: %s vs %s = %f', (atk, def, expected) => {
    const result = getTypeEffectiveness(atk, def);
    expect(result).toBe(expected);
  });
});
```

#### 4.1.3 状态效果测试

```javascript
describe('BattleEngine - Status Effects', () => {
  test('灼伤每回合伤害', () => {
    const pokemon = createPokemon({ max_hp: 100, status: 'burn' });
    const effect = STATUS_EFFECTS.burn.onTurnEnd(pokemon);
    expect(effect.damage).toBe(12); // 100/8 = 12.5 -> 12
  });
  
  test('麻痹行动概率', () => {
    mockRandom(0.74); // 75% 可行动
    expect(STATUS_EFFECTS.paralyze.canAct()).toBe(true);
    
    mockRandom(0.75);
    expect(STATUS_EFFECTS.paralyze.canAct()).toBe(false);
  });
  
  test('冰冻火焰解除', () => {
    const result = STATUS_EFFECTS.freeze.onHit({ type: 'fire' });
    expect(result).toBe('thaw');
  });
  
  test('剧毒递增伤害', () => {
    const pokemon = createPokemon({ max_hp: 100, status: 'toxic' });
    // 第 1 回合: 1/16, 第 2 回合: 2/16, ...
    expect(STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 1).damage).toBe(6);
    expect(STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 2).damage).toBe(12);
    expect(STATUS_EFFECTS.toxic.onTurnEnd(pokemon, 4).damage).toBe(25);
  });
});
```

### 4.2 comboEngine.js 测试用例

#### 4.2.1 连击序列检测测试

```javascript
describe('ComboEngine - Sequence Detection', () => {
  test('基础连击触发', async () => {
    const combo = createComboChain({
      trigger_sequence: ['tackle', 'quick_attack', 'scratch']
    });
    
    const engine = new ComboEngine();
    await engine.recordAction(userId, 'tackle');
    await engine.recordAction(userId, 'quick_attack');
    const result = await engine.recordAction(userId, 'scratch');
    
    expect(result.triggered).toBe(true);
    expect(result.comboId).toBe(combo.chain_id);
  });
  
  test('序列中断不触发', async () => {
    await engine.recordAction(userId, 'tackle');
    await engine.recordAction(userId, 'water_gun'); // 错误的技能
    const result = await engine.recordAction(userId, 'scratch');
    
    expect(result.triggered).toBe(false);
  });
  
  test('时间窗口超时', async () => {
    await engine.recordAction(userId, 'tackle');
    await sleep(6000); // 超过 5 秒窗口
    const result = await engine.recordAction(userId, 'quick_attack');
    
    expect(result.sequenceReset).toBe(true);
  });
  
  test('并发用户隔离', async () => {
    await engine.recordAction('user1', 'tackle');
    await engine.recordAction('user2', 'tackle'); // 不同用户
    
    const state1 = engine.getActiveCombo('user1');
    const state2 = engine.getActiveCombo('user2');
    
    expect(state1.sequence).toHaveLength(1);
    expect(state2.sequence).toHaveLength(1);
    expect(state1).not.toBe(state2);
  });
});
```

#### 4.2.2 连击奖励计算测试

```javascript
describe('ComboEngine - Bonus Calculation', () => {
  test('伤害加成应用', async () => {
    const combo = createComboChain({
      bonus_effects: { damage_multiplier: 1.5 }
    });
    
    const result = await triggerCombo(combo);
    expect(result.bonus.damage_multiplier).toBe(1.5);
  });
  
  test('额外奖励发放', async () => {
    const combo = createComboChain({
      bonus_effects: { 
        extra_xp: 100,
        extra_candy: 5 
      }
    });
    
    const result = await triggerCombo(combo);
    expect(result.bonus.extra_xp).toBe(100);
    expect(result.bonus.extra_candy).toBe(5);
  });
});
```

### 4.3 测试数据工厂

```javascript
// backend/tests/factories/battleFactory.js

function createPokemon(overrides = {}) {
  return {
    id: 'pokemon-001',
    species: 'Charizard',
    level: 50,
    types: ['fire', 'flying'],
    stats: { hp: 150, attack: 100, defense: 90, sp_atk: 120, sp_def: 95, speed: 110 },
    max_hp: 150,
    current_hp: 150,
    status: null,
    moves: [
      { name: 'Flamethrower', type: 'fire', power: 90, accuracy: 100, pp: 15 }
    ],
    ...overrides
  };
}

function createMove(overrides = {}) {
  return {
    name: 'Tackle',
    type: 'normal',
    power: 40,
    accuracy: 100,
    pp: 35,
    category: 'physical',
    ...overrides
  };
}
```

### 4.4 性能基准测试

```javascript
describe('BattleEngine - Performance', () => {
  test('单场战斗计算时间 < 10ms', () => {
    const attacker = createPokemon({ level: 50 });
    const defender = createPokemon({ level: 50 });
    const move = createMove({ power: 50 });
    
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      calculateDamage(attacker, defender, move);
    }
    const elapsed = performance.now() - start;
    
    expect(elapsed / 1000).toBeLessThan(10); // 平均 < 10ms
  });
});
```

## 5. 验收标准

- [ ] battleEngine.js 行覆盖率 ≥ 90%
- [ ] comboEngine.js 行覆盖率 ≥ 90%
- [ ] 属性克制矩阵测试覆盖全部 18 种属性组合
- [ ] 6 种状态效果各有独立测试用例
- [ ] 连击序列检测覆盖完整流程、中断、超时场景
- [ ] 性能基准测试通过（单次计算 < 10ms）
- [ ] 所有测试通过 `npm run test:unit`
- [ ] 测试文件位置：`backend/tests/unit/battleEngine.test.js` 和 `backend/tests/unit/comboEngine.test.js`

## 6. 工作量估算

**M（中型）**

- battleEngine.js 测试编写：1.5 天
- comboEngine.js 测试编写：1 天
- 测试数据工厂：0.5 天
- 覆盖率调优与边界用例：0.5 天

总计：约 3.5 人日

## 7. 优先级理由

P1 理由：

1. **核心功能无测试保护**：战斗系统是游戏核心，任何 Bug 都会严重影响用户体验
2. **回归风险高**：战斗规则复杂，后续优化容易引入隐蔽问题
3. **支撑后续迭代**：有测试保护后，可放心进行性能优化和功能扩展
4. **快速见效**：测试编写周期短，价值高，性价比最优

对"项目可用"的贡献：保障道馆战斗系统稳定性，为生产环境提供可靠的质量防线。