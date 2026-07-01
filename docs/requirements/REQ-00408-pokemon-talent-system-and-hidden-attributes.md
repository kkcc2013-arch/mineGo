# REQ-00408：精灵天赋系统与隐藏属性解锁机制

- **编号**：REQ-00408
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、catch-service、gym-service、gateway、game-client、database/migrations
- **创建时间**：2026-07-01 11:00 UTC
- **依赖需求**：REQ-00086（精灵特性系统与隐藏能力激活机制）

## 1. 背景与问题

当前精灵系统已有特性（REQ-00086）和技能冷却/能量系统（REQ-00112），但精灵的个性化养成维度仍不够丰富：

**当前缺口**：
1. **缺乏天赋概念**：精灵缺乏类似 RPG 游戏的天赋树/天赋点系统
2. **隐藏属性未解锁**：精灵除了基础属性（HP/攻/防/速）外，缺乏隐藏属性（暴击率/暴击伤害/命中率/闪避率）
3. **成长路线单一**：精灵养成主要依赖进化，缺乏多样性养成路径
4. **战斗策略受限**：缺乏天赋带来的技能增强/属性加成，战斗策略单一

**精灵天赋系统的价值**：
- 增加精灵个性化养成深度
- 提供多样化成长路线（攻击型/防御型/辅助型）
- 增加战斗策略多样性
- 提升玩家长期养成兴趣

## 2. 目标

实现完整的精灵天赋系统：
1. **天赋树设计**：每个精灵类型有独特天赋树（3-5 个天赋分支）
2. **天赋点获取**：精灵升级/进化获得天赋点
3. **隐藏属性解锁**：天赋解锁隐藏属性（暴击率/暴击伤害/命中率/闪避率/抗性）
4. **技能增强**：天赋可增强特定技能效果
5. **天赋重置**：支持天赋重置（消耗道具）
6. **天赋推荐**：根据精灵定位推荐天赋配置

## 3. 范围

### 包含
- 天赋树数据结构与天赋定义
- 天赋点获取与分配逻辑
- 隐藏属性计算与战斗集成
- 天赋 API（分配/重置/推荐）
- 前端天赋界面
- 数据库迁移

### 不包含
- 天赋继承（遗传机制）—— 属于 REQ-00046 精灵培育系统
- 天赋合成—— 需单独需求
- 天赋交易—— 需单独需求

## 4. 详细需求

### 4.1 天赋树数据结构

```javascript
// 天赋节点定义
const TalentNode = {
  id: 'talent_fire_boost_1',
  name: '火焰强化 I',
  description: '火属性技能伤害提升 10%',
  category: 'attack', // attack/defense/support/utility
  maxLevel: 3,
  cost: 1, // 每级消耗天赋点
  effects: [
    { type: 'skill_damage_boost', skillType: 'fire', value: 0.10 }
  ],
  prerequisites: [], // 前置天赋
  unlockCondition: { level: 10 } // 解锁条件
};

// 精灵天赋树（每个精灵类型有独特天赋树）
const PokemonTalentTree = {
  pokemonType: 'fire_dragon',
  branches: [
    {
      name: '攻击分支',
      nodes: [
        'talent_fire_boost_1', 'talent_fire_boost_2', 'talent_critical_boost',
        'talent_attack_power', 'talent_skill_penetration'
      ]
    },
    {
      name: '防御分支',
      nodes: [
        'talent_defense_boost', 'talent_fire_resist', 'talent_dodge_chance',
        'talent_hp_boost'
      ]
    },
    {
      name: '辅助分支',
      nodes: [
        'talent_energy_regen', 'talent_skill_cooldown', 'talent_accuracy',
        'talent_healing_boost'
      ]
    }
  ],
  totalTalentPoints: 15 // 最大天赋点数
};
```

### 4.2 隐藏属性定义

```javascript
// 隐藏属性类型
const HiddenAttributes = {
  // 基础隐藏属性
  criticalRate: { base: 0.05, max: 0.30 }, // 暴击率 5%-30%
  criticalDamage: { base: 1.5, max: 2.5 }, // 暴击伤害 150%-250%
  accuracy: { base: 0.95, max: 1.0 }, // 命中率 95%-100%
  dodgeRate: { base: 0.05, max: 0.20 }, // 闪避率 5%-20%
  
  // 抗性隐藏属性
  fireResist: { base: 0, max: 0.5 },
  waterResist: { base: 0, max: 0.5 },
  electricResist: { base: 0, max: 0.5 },
  
  // 特殊隐藏属性
  penetration: { base: 0, max: 0.3 }, // 穿透率
  healingBoost: { base: 1.0, max: 1.5 }, // 治疗加成
  energyRegen: { base: 1.0, max: 1.5 }, // 能量恢复加成
};
```

### 4.3 天赋点获取规则

```javascript
// 天赋点获取来源
const TalentPointSources = {
  // 等级提升
  levelUp: {
    intervals: [10, 20, 30, 40, 50],
    points: [1, 1, 2, 2, 3] // 每个等级段获得天赋点
  },
  
  // 进化奖励
  evolution: {
    points: 3 // 每次进化获得 3 天赋点
  },
  
  // 成就奖励
  achievement: {
    condition: 'talent_unlock_all', // 解锁全部天赋
    points: 5
  }
};
```

### 4.4 天赋分配 API

#### backend/pokemon-service/src/routes/talent.js

```javascript
/**
 * POST /api/pokemon/:pokemonId/talent/allocate
 * 分配天赋点
 */
router.post('/:pokemonId/talent/allocate', async (req, res) => {
  const { pokemonId } = req.params;
  const { talentId, points = 1 } = req.body;
  const userId = req.user.id;
  
  // 验证精灵归属
  const pokemon = await db.query(`
    SELECT * FROM pokemon WHERE id = $1 AND owner_id = $2
  `, [pokemonId, userId]);
  
  if (!pokemon.rows.length) {
    return res.status(404).json({ error: 'Pokemon not found' });
  }
  
  // 验证天赋是否可解锁
  const validation = await talentManager.validateTalentAllocation(
    pokemonId, talentId, points
  );
  
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }
  
  // 分配天赋点
  const result = await talentManager.allocateTalentPoint(
    pokemonId, talentId, points
  );
  
  res.json({ success: true, talent: result });
});

/**
 * POST /api/pokemon/:pokemonId/talent/reset
 * 重置天赋（消耗道具）
 */
router.post('/:pokemonId/talent/reset', async (req, res) => {
  const { pokemonId } = req.params;
  const userId = req.user.id;
  
  // 检查是否有重置道具
  const itemCheck = await db.query(`
    SELECT * FROM inventory 
    WHERE user_id = $1 AND item_id = 'talent_reset_token' AND quantity > 0
  `, [userId]);
  
  if (!itemCheck.rows.length) {
    return res.status(400).json({ error: 'No talent reset token available' });
  }
  
  // 重置天赋
  const result = await talentManager.resetTalents(pokemonId);
  
  // 消耗道具
  await db.query(`
    UPDATE inventory SET quantity = quantity - 1 
    WHERE user_id = $1 AND item_id = 'talent_reset_token'
  `, [userId]);
  
  res.json({ success: true, refundedPoints: result.refundedPoints });
});

/**
 * GET /api/pokemon/:pokemonId/talent/recommend
 * 获取天赋推荐配置
 */
router.get('/:pokemonId/talent/recommend', async (req, res) => {
  const { pokemonId } = req.params;
  const { style } = req.query; // attack/defense/balance
  
  const recommendation = await talentManager.getRecommendation(
    pokemonId, style || 'balance'
  );
  
  res.json({ success: true, recommendation });
});
```

### 4.5 数据库迁移

```sql
-- 精灵天赋配置表
CREATE TABLE pokemon_talent_config (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    
    -- 已分配天赋
    allocated_talents JSONB DEFAULT '{}', -- { "talent_id": level }
    
    -- 天赋点
    total_points INTEGER DEFAULT 0,
    used_points INTEGER DEFAULT 0,
    
    -- 隐藏属性（计算后缓存）
    hidden_attributes JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_pokemon_talent UNIQUE (pokemon_id)
);

-- 天赋定义表（系统配置）
CREATE TABLE talent_definitions (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(20) NOT NULL, -- attack/defense/support/utility
    max_level INTEGER DEFAULT 3,
    cost_per_level INTEGER DEFAULT 1,
    effects JSONB DEFAULT '{}',
    prerequisites JSONB DEFAULT '[]',
    unlock_condition JSONB DEFAULT '{}',
    pokemon_types JSONB DEFAULT '[]', -- 适用精灵类型
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋树定义表
CREATE TABLE talent_tree_definitions (
    pokemon_type VARCHAR(100) PRIMARY KEY,
    branches JSONB NOT NULL,
    total_talent_points INTEGER DEFAULT 15,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_talent_config_pokemon ON pokemon_talent_config(pokemon_id);
CREATE INDEX idx_talent_def_category ON talent_definitions(category);
CREATE INDEX idx_talent_tree_type ON talent_tree_definitions(pokemon_type);
```

### 4.6 战斗系统集成

```javascript
// 在战斗伤害计算中应用天赋效果
class BattleDamageCalculator {
  calculateDamage(attacker, defender, skill) {
    let baseDamage = skill.baseDamage * attacker.attackPower;
    
    // 应用天赋加成
    const attackerTalents = attacker.talentConfig.allocatedTalents;
    
    // 技能伤害天赋加成
    if (attackerTalents[`${skill.type}_boost`]) {
      const boostLevel = attackerTalents[`${skill.type}_boost`];
      baseDamage *= (1 + boostLevel * 0.1);
    }
    
    // 暴击天赋
    const criticalRate = attacker.hiddenAttributes.criticalRate || 0.05;
    const criticalDamage = attacker.hiddenAttributes.criticalDamage || 1.5;
    
    if (Math.random() < criticalRate) {
      baseDamage *= criticalDamage;
      attacker.isCriticalHit = true;
    }
    
    // 穿透天赋
    const penetration = attacker.hiddenAttributes.penetration || 0;
    const effectiveDefense = defender.defensePower * (1 - penetration);
    
    // 最终伤害
    const finalDamage = baseDamage - effectiveDefense;
    
    return Math.max(0, Math.floor(finalDamage));
  }
}
```

## 5. 验收标准（可测试）

- [ ] **天赋树定义**：至少 10 种精灵类型有独特天赋树配置
- [ ] **天赋点获取**：精灵升级/进化正确获得天赋点
- [ ] **天赋分配**：可正确分配天赋点，消耗正确
- [ ] **前置验证**：前置天赋未解锁时无法分配后续天赋
- [ ] **隐藏属性**：天赋正确计算并缓存隐藏属性
- [ ] **战斗集成**：天赋效果正确应用于战斗伤害计算
- [ ] **天赋重置**：重置后天赋点返还，消耗道具
- [ ] **天赋推荐**：根据精灵定位提供 3 种推荐配置
- [ ] **前端界面**：天赋树可视化，支持点击分配
- [ ] **API 完整**：分配/重置/查询/推荐 API 全部可用

## 6. 工作量估算

**工作量**：L（大型）

**理由**：
- 需设计 10+ 种精灵天赋树（每种 15-20 天赋）
- 需实现天赋点系统、隐藏属性计算
- 需集成到战斗系统、前端界面
- 数据库迁移 + API + 前端工作量较大

## 7. 优先级理由

**P1 优先级**：
- 核心功能增强：精灵养成是游戏核心玩法
- 提升玩家长期留存：天赋养成增加长期目标
- 战斗策略丰富：天赋影响战斗胜负，提升竞技性
- 已有基础：REQ-00086 特性系统提供了部分基础