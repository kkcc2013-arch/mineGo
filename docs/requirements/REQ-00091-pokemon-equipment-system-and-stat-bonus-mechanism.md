# REQ-00091：精灵装备系统与属性加成机制

- **编号**：REQ-00091
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、user-service、reward-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-10 14:00
- **依赖需求**：REQ-00047（精灵道具与背包管理系统）

## 1. 背景与问题

当前精灵系统已具备完整的捕捉、培育、进化、技能学习、状态效果等功能，但缺少装备系统。在传统 RPG 游戏中，装备系统是提升角色战斗力的重要途径，能够：

1. **增加策略深度**：玩家需要根据精灵属性、技能搭配选择合适的装备
2. **提供长期目标**：稀有装备的收集和强化为玩家提供长期追求
3. **丰富奖励系统**：Raid、活动、任务可以掉落装备，增加奖励多样性
4. **平衡对战环境**：装备系统可以为弱势精灵提供额外加成，改善对战平衡

当前问题：
- 精灵属性提升途径有限（仅通过培育、进化），缺少装备加成维度
- 奖励系统缺少装备掉落，奖励类型单一
- 对战中缺少装备策略要素，战斗策略深度不足

## 2. 目标

设计并实现完整的精灵装备系统，包括：

1. **装备类型体系**：定义 6 种装备类型（武器、护甲、饰品、技能盘、进化石、携带道具）
2. **装备属性加成**：每种装备提供不同的属性加成（攻击、防御、速度、暴击等）
3. **装备获取途径**：Raid 掉落、任务奖励、商店购买、活动奖励
4. **装备强化系统**：装备可通过消耗资源强化，提升加成效果
5. **装备套装效果**：集齐套装装备可激活额外套装效果
6. **装备限制规则**：不同精灵类型对装备有不同限制（如水系精灵只能装备水系装备）

## 3. 范围

- **包含**：
  - 装备数据库表设计与迁移
  - 装备类型、属性、稀有度定义
  - 精灵装备管理 API（装备、卸下、查看）
  - 装备强化 API（消耗资源强化装备）
  - 装备获取逻辑（Raid 掉落、任务奖励、商店购买）
  - 装备套装效果系统
  - 装备对战斗属性的影响计算
  - 前端装备界面（装备栏、装备详情、强化界面）
  - Prometheus 监控指标

- **不包含**：
  - 装备交易系统（后续需求）
  - 装备合成系统（后续需求）
  - 装备外观系统（后续需求）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 装备定义表
CREATE TABLE equipment_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- weapon, armor, accessory, skill_disc, evolution_stone, held_item
  rarity VARCHAR(20) NOT NULL, -- common, uncommon, rare, epic, legendary
  base_stats JSONB NOT NULL, -- {"attack": 10, "defense": 5, "speed": 3}
  set_id INTEGER, -- 套装 ID（可选）
  element_affinity VARCHAR(20), -- 元素亲和（水、火、草等，null 表示通用）
  max_level INTEGER DEFAULT 10,
  description TEXT,
  icon_url VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 装备套装表
CREATE TABLE equipment_sets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  pieces_required INTEGER DEFAULT 2, -- 激活套装效果所需件数
  set_bonus JSONB NOT NULL, -- {"attack": 20, "special_effect": "water_boost"}
  description TEXT
);

-- 玩家装备实例表
CREATE TABLE player_equipment (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  template_id INTEGER NOT NULL REFERENCES equipment_templates(id),
  current_level INTEGER DEFAULT 1,
  current_stats JSONB, -- 当前属性（基础 × 等级系数）
  is_equipped BOOLEAN DEFAULT FALSE,
  equipped_to_pokemon_id INTEGER REFERENCES player_pokemon(id),
  acquired_at TIMESTAMP DEFAULT NOW(),
  acquired_from VARCHAR(50) -- raid, quest, shop, event
);

-- 装备强化记录表
CREATE TABLE equipment_upgrades (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES player_equipment(id),
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  cost_resources JSONB NOT NULL, -- {"stardust": 1000, "coins": 500}
  success BOOLEAN NOT NULL,
  upgraded_at TIMESTAMP DEFAULT NOW()
);
```

### 4.2 装备类型定义

| 类型 | 中文名 | 属性加成 | 槽位 | 说明 |
|------|--------|----------|------|------|
| weapon | 武器 | 攻击、暴击率、暴击伤害 | 1 | 提升精灵攻击能力 |
| armor | 护甲 | 防御、生命、抗性 | 1 | 提升精灵防御能力 |
| accessory | 饰品 | 速度、闪避、特殊属性 | 1 | 提升精灵速度和特殊属性 |
| skill_disc | 技能盘 | 技能伤害、技能冷却 | 1 | 提升技能效果 |
| evolution_stone | 进化石 | 进化加速、经验加成 | 1 | 辅助精灵成长 |
| held_item | 携带道具 | 特殊效果、被动能力 | 1 | 提供特殊被动效果 |

### 4.3 装备稀有度

| 稀有度 | 基础属性系数 | 强化上限 | 掉落概率 | 颜色 |
|--------|--------------|----------|----------|------|
| common | 1.0 | 5 | 50% | 灰色 |
| uncommon | 1.2 | 7 | 30% | 绿色 |
| rare | 1.5 | 10 | 15% | 蓝色 |
| epic | 2.0 | 12 | 4% | 紫色 |
| legendary | 3.0 | 15 | 1% | 橙色 |

### 4.4 API 端点设计

```
GET    /api/v1/equipment/templates         # 获取装备模板列表
GET    /api/v1/equipment/templates/:id     # 获取装备模板详情
GET    /api/v1/equipment/inventory         # 获取玩家装备背包
POST   /api/v1/equipment/equip             # 装备到精灵
POST   /api/v1/equipment/unequip           # 从精灵卸下装备
POST   /api/v1/equipment/upgrade           # 强化装备
GET    /api/v1/equipment/sets              # 获取套装列表
GET    /api/v1/equipment/sets/:id          # 获取套装详情
GET    /api/v1/equipment/pokemon/:id       # 获取精灵已装备列表
POST   /api/v1/equipment/sell              # 出售装备
```

### 4.5 装备强化公式

```javascript
// 强化消耗计算
function calculateUpgradeCost(currentLevel, rarity) {
  const baseCost = {
    stardust: 100 * Math.pow(2, currentLevel),
    coins: 50 * Math.pow(1.5, currentLevel)
  };
  
  const rarityMultiplier = {
    common: 1.0,
    uncommon: 1.2,
    rare: 1.5,
    epic: 2.0,
    legendary: 3.0
  };
  
  return {
    stardust: Math.floor(baseCost.stardust * rarityMultiplier[rarity]),
    coins: Math.floor(baseCost.coins * rarityMultiplier[rarity])
  };
}

// 强化成功率
function calculateUpgradeSuccessRate(currentLevel, rarity) {
  const baseRate = 1.0 - (currentLevel * 0.05);
  const rarityBonus = {
    common: 0,
    uncommon: 0.05,
    rare: 0.10,
    epic: 0.15,
    legendary: 0.20
  };
  return Math.max(0.3, Math.min(1.0, baseRate + rarityBonus[rarity]));
}

// 属性计算
function calculateCurrentStats(template, level) {
  const levelMultiplier = 1 + (level - 1) * 0.1;
  const stats = {};
  for (const [key, value] of Object.entries(template.base_stats)) {
    stats[key] = Math.floor(value * levelMultiplier);
  }
  return stats;
}
```

### 4.6 套装效果示例

```javascript
const equipmentSets = [
  {
    id: 1,
    name: "水之守护者",
    pieces_required: 2,
    set_bonus: {
      water_damage_boost: 0.15, // 水系技能伤害 +15%
      water_resistance: 0.10    // 水系抗性 +10%
    }
  },
  {
    id: 2,
    name: "烈焰战神",
    pieces_required: 3,
    set_bonus: {
      fire_damage_boost: 0.20,
      burn_chance: 0.10,
      critical_rate: 0.05
    }
  }
];
```

### 4.7 战斗属性计算

```javascript
// 计算精灵战斗属性（包含装备加成）
function calculateBattleStats(pokemon, equippedItems) {
  const baseStats = pokemon.stats;
  const equipmentBonus = {
    attack: 0,
    defense: 0,
    speed: 0,
    hp: 0,
    critical_rate: 0,
    critical_damage: 0
  };
  
  // 累加装备属性
  for (const item of equippedItems) {
    for (const [stat, value] of Object.entries(item.current_stats)) {
      equipmentBonus[stat] = (equipmentBonus[stat] || 0) + value;
    }
  }
  
  // 计算套装效果
  const setEffects = calculateSetBonuses(equippedItems);
  
  // 合并属性
  return {
    attack: baseStats.attack + equipmentBonus.attack,
    defense: baseStats.defense + equipmentBonus.defense,
    speed: baseStats.speed + equipmentBonus.speed,
    max_hp: baseStats.hp + equipmentBonus.hp,
    critical_rate: baseStats.critical_rate + equipmentBonus.critical_rate,
    critical_damage: baseStats.critical_damage + equipmentBonus.critical_damage,
    set_effects: setEffects
  };
}
```

### 4.8 Prometheus 指标

```javascript
// 装备相关指标
equipmentAcquiredTotal: new Counter({
  name: 'minego_equipment_acquired_total',
  help: 'Total equipment acquired',
  labelNames: ['rarity', 'source']
});

equipmentUpgradedTotal: new Counter({
  name: 'minego_equipment_upgraded_total',
  help: 'Total equipment upgrade attempts',
  labelNames: ['rarity', 'success']
});

equipmentEquippedTotal: new Counter({
  name: 'minego_equipment_equipped_total',
  help: 'Total equipment equipped to pokemon',
  labelNames: ['type', 'rarity']
});

activeEquipmentGauge: new Gauge({
  name: 'minego_active_equipment_count',
  help: 'Current number of equipment in player inventories',
  labelNames: ['rarity']
});
```

## 5. 验收标准（可测试）

- [ ] 数据库迁移成功执行，创建 4 个装备相关表
- [ ] 装备模板数据成功导入，至少包含 50 种装备模板
- [ ] 玩家可以通过 API 查看装备背包和装备详情
- [ ] 玩家可以将装备装备到精灵身上，精灵属性正确更新
- [ ] 玩家可以从精灵身上卸下装备，装备返回背包
- [ ] 装备强化功能正常，消耗资源正确扣除，属性正确提升
- [ ] 强化失败时，资源扣除但装备等级不变
- [ ] 套装效果正确激活，当装备 2 件以上同套装装备时触发套装效果
- [ ] Raid 掉落装备功能正常，掉落概率符合稀有度分布
- [ ] 任务奖励装备功能正常
- [ ] 商店购买装备功能正常
- [ ] 装备对战斗属性的影响正确计算（攻击、防御、速度等）
- [ ] 装备限制规则正确执行（水系精灵只能装备水系装备或通用装备）
- [ ] 前端装备界面正常显示，包括装备栏、装备详情、强化界面
- [ ] Prometheus 指标正确记录装备获取、强化、装备等事件
- [ ] 单元测试覆盖率 ≥ 80%，至少 40 个测试用例

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计 4 个数据库表并编写迁移
- 需要实现 8 个 API 端点
- 需要实现装备强化、套装效果、属性计算等复杂逻辑
- 需要集成到 Raid 掉落、任务奖励、商店系统
- 需要修改战斗系统以支持装备属性加成
- 需要实现前端装备界面（装备栏、详情、强化）
- 需要编写大量单元测试（40+ 个测试用例）

预计工作量：3-4 天

## 7. 优先级理由

**P1 理由**：

1. **功能重要性**：装备系统是 RPG 游戏的核心系统之一，对游戏深度和可玩性有重大影响
2. **依赖关系**：后续装备交易、装备合成、装备外观等需求都依赖本需求
3. **玩家价值**：提供新的精灵培养途径，增加游戏策略深度和长期追求
4. **奖励丰富性**：为 Raid、任务、活动提供新的奖励类型，增加奖励多样性
5. **对战平衡**：装备系统可以为弱势精灵提供额外加成，改善对战环境平衡

虽然不是 P0 级别的核心功能，但对游戏体验和长期留存有重要影响，因此定为 P1。
