# REQ-00236：精灵变异系统与稀有形态

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00236 |
| 标题 | 精灵变异系统与稀有形态 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、catch-service、location-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-15 23:00 |
| 依赖需求 | REQ-00065 (精灵进化与成长系统) |

## 1. 背景与问题

当前 mineGo 项目已实现精灵捕捉、进化、技能、装备等核心功能，但缺少精灵变异机制：

**痛点分析：**
1. **玩法单一**：所有同种精灵外观和属性一致，缺少差异化惊喜
2. **收集动机不足**：玩家捕捉后缺乏"变异期待"，降低重复捕捉动力
3. **稀有度体系不完善**：仅有基础稀有度，缺少变异稀有度层级
4. **社交传播弱**：没有"炫耀型"变异精灵，不利于玩家分享传播

**参考对标：**
- Pokémon 闪光精灵（Shiny）系统
- 异色精灵概率约 1/4096
- 特殊活动期间概率提升

## 2. 目标

构建完整的精灵变异系统：

1. **变异类型多样化**：
   - 色彩变异（闪光/Shiny）
   - 体型变异（巨大/迷你）
   - 特殊纹路变异
   - 元素变异（属性附加）

2. **稀有度分层**：
   - 普通变异：约 1/500 概率
   - 稀有变异：约 1/2000 概率
   - 传说变异：约 1/10000 概率
   - 活动限定变异：活动期间提升概率

3. **属性加成**：
   - 变异精灵获得额外属性加成（5%-15%）
   - 特殊变异附带独特技能

4. **收集与展示**：
   - 变异图鉴系统
   - 变异精灵专属特效
   - 变异徽章系统

## 3. 范围

### 包含
- 变异概率计算引擎
- 变异精灵数据模型
- 变异精灵捕捉流程
- 变异图鉴与收集进度
- 变异精灵专属视觉效果
- 变异精灵属性加成计算
- 管理后台变异配置

### 不包含
- 变异精灵交易限制（后续需求）
- 变异精灵繁殖遗传（后续需求）
- 变异精灵专属技能设计（需单独需求）

## 4. 详细需求

### 4.1 变异类型定义

```javascript
// 变异类型枚举
const MutationType = {
  SHINY: 'shiny',           // 闪光变异 - 色彩不同
  GIGANTIC: 'gigantic',     // 巨大变异 - 体型增大 50%
  MINIATURE: 'miniature',   // 迷你变异 - 体型缩小 50%
  AURORA: 'aurora',         // 极光变异 - 特殊纹路
  SHADOW: 'shadow',         // 暗影变异 - 属性变化
  RADIANT: 'radiant',       // 光辉变异 - 发光效果
  CELESTIAL: 'celestial',   // 星辰变异 - 活动限定
};

// 变异稀有度
const MutationRarity = {
  COMMON: { name: 'common', rate: 1/500, boost: 1.05 },
  RARE: { name: 'rare', rate: 1/2000, boost: 1.10 },
  LEGENDARY: { name: 'legendary', rate: 1/10000, boost: 1.15 },
};

// 变异配置
const MutationConfig = {
  SHINY: {
    type: MutationType.SHINY,
    rarity: MutationRarity.COMMON,
    statBoost: 1.05,
    visualEffect: 'shiny_sparkle',
    exclusiveSkill: null,
  },
  GIGANTIC: {
    type: MutationType.GIGANTIC,
    rarity: MutationRarity.RARE,
    statBoost: 1.12,
    visualEffect: 'giant_aura',
    exclusiveSkill: 'tremor',
  },
  AURORA: {
    type: MutationType.AURORA,
    rarity: MutationRarity.LEGENDARY,
    statBoost: 1.15,
    visualEffect: 'aurora_trail',
    exclusiveSkill: 'aurora_beam',
  },
  // ... 其他变异配置
};
```

### 4.2 数据库设计

```sql
-- 精灵变异表
CREATE TABLE pokemon_mutations (
  id SERIAL PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  mutation_type VARCHAR(20) NOT NULL,
  rarity VARCHAR(20) NOT NULL,
  stat_boost JSONB NOT NULL, -- { hp: 1.05, attack: 1.05, ... }
  visual_config JSONB,       -- 变异视觉效果配置
  exclusive_skill VARCHAR(50),
  discovered_at TIMESTAMP DEFAULT NOW(),
  discovered_by INTEGER REFERENCES users(id),
  discovery_location GEOGRAPHY(POINT, 4326),
  
  UNIQUE(pokemon_id, mutation_type)
);

CREATE INDEX idx_mutations_type ON pokemon_mutations(mutation_type);
CREATE INDEX idx_mutations_rarity ON pokemon_mutations(rarity);

-- 变异图鉴表
CREATE TABLE mutation_pokedex (
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_species_id INTEGER NOT NULL,
  mutation_type VARCHAR(20) NOT NULL,
  discovered_at TIMESTAMP DEFAULT NOW(),
  count INTEGER DEFAULT 1,
  
  PRIMARY KEY (user_id, pokemon_species_id, mutation_type)
);

-- 变异活动配置表
CREATE TABLE mutation_events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  mutation_type VARCHAR(20) NOT NULL,
  boost_multiplier DECIMAL(4,2) DEFAULT 1.0, -- 概率提升倍率
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_mutation_events_active ON mutation_events(is_active, start_time, end_time);
```

### 4.3 变异概率计算服务

```javascript
// backend/shared/MutationEngine.js
class MutationEngine {
  constructor(config = {}) {
    this.baseRates = {
      common: 1/500,
      rare: 1/2000,
      legendary: 1/10000,
    };
    this.activeEvents = new Map();
  }

  /**
   * 计算精灵是否发生变异
   * @param {number} pokemonSpeciesId - 精灵种类ID
   * @param {object} context - 捕捉上下文
   * @returns {object|null} 变异信息或 null
   */
  calculateMutation(pokemonSpeciesId, context = {}) {
    const { userId, location, weather, eventId } = context;
    
    // 获取当前活动加成
    const eventBoost = this._getEventBoost(mutationType, eventId);
    
    // 遍历所有变异类型
    for (const [type, config] of Object.entries(MutationConfig)) {
      const baseRate = config.rarity.rate;
      const adjustedRate = baseRate * eventBoost;
      
      // 应用上下文加成
      const finalRate = this._applyContextBoosts(adjustedRate, context);
      
      // 概率判定
      if (Math.random() < finalRate) {
        return {
          type,
          rarity: config.rarity.name,
          statBoost: config.statBoost,
          visualEffect: config.visualEffect,
          exclusiveSkill: config.exclusiveSkill,
        };
      }
    }
    
    return null; // 无变异
  }

  /**
   * 应用上下文加成
   */
  _applyContextBoosts(baseRate, context) {
    let rate = baseRate;
    
    // 天气加成
    if (context.weather?.boostedType) {
      rate *= 1.5;
    }
    
    // 时间加成（夜晚概率略高）
    if (context.timeOfDay === 'night') {
      rate *= 1.2;
    }
    
    // 特殊地点加成
    if (context.location?.isSpecial) {
      rate *= 2.0;
    }
    
    // 玩家幸运值加成（未来功能）
    if (context.luckyBonus) {
      rate *= context.luckyBonus;
    }
    
    return Math.min(rate, 0.01); // 最高 1% 概率
  }

  /**
   * 获取活动加成倍率
   */
  _getEventBoost(mutationType, eventId) {
    if (!eventId) return 1.0;
    
    const event = this.activeEvents.get(eventId);
    if (event && event.mutationType === mutationType) {
      return event.boostMultiplier;
    }
    
    return 1.0;
  }
}
```

### 4.4 捕捉服务集成

```javascript
// backend/services/catch-service/src/handlers/mutationHandler.js
async function processCatchResult(userId, pokemonSpecies, context) {
  const mutationEngine = getMutationEngine();
  
  // 计算变异
  const mutation = mutationEngine.calculateMutation(pokemonSpecies.id, {
    userId,
    location: context.location,
    weather: context.weather,
    eventId: context.activeEventId,
  });
  
  if (mutation) {
    // 创建变异精灵
    const mutatedPokemon = await createMutatedPokemon(
      userId,
      pokemonSpecies,
      mutation
    );
    
    // 记录变异图鉴
    await recordMutationDiscovery(userId, pokemonSpecies.id, mutation.type);
    
    // 发送变异通知
    await sendMutationNotification(userId, mutatedPokemon, mutation);
    
    // 发送 Kafka 事件
    await publishEvent('pokemon.mutation.discovered', {
      userId,
      pokemonId: mutatedPokemon.id,
      mutationType: mutation.type,
      rarity: mutation.rarity,
      location: context.location,
    });
    
    return { mutated: true, pokemon: mutatedPokemon, mutation };
  }
  
  return { mutated: false, pokemon: normalPokemon };
}
```

### 4.5 变异精灵属性计算

```javascript
// backend/shared/pokemonStats.js
function calculateMutatedStats(baseStats, mutation) {
  const boost = mutation.statBoost;
  
  return {
    hp: Math.floor(baseStats.hp * boost),
    attack: Math.floor(baseStats.attack * boost),
    defense: Math.floor(baseStats.defense * boost),
    spAttack: Math.floor(baseStats.spAttack * boost),
    spDefense: Math.floor(baseStats.spDefense * boost),
    speed: Math.floor(baseStats.speed * boost),
    _mutationBonus: {
      type: mutation.type,
      rarity: mutation.rarity,
      multiplier: boost,
    },
  };
}
```

### 4.6 API 设计

```
GET  /api/pokemon/mutations                 # 获取变异精灵列表
GET  /api/pokemon/mutations/:id             # 获取变异精灵详情
GET  /api/pokemon/mutation-pokedex          # 获取变异图鉴
GET  /api/pokemon/mutation-events           # 获取当前变异活动
POST /api/admin/mutation-events             # 创建变异活动（管理员）
PUT  /api/admin/mutation-events/:id         # 更新变异活动（管理员）
```

### 4.7 前端视觉效果

```javascript
// game-client/src/effects/mutationEffects.js
const MutationEffects = {
  shiny: {
    particles: 'shiny_sparkle',
    color: 'golden',
    animation: 'sparkle_loop',
    sound: 'shiny_appear',
  },
  gigantic: {
    scale: 1.5,
    particles: 'giant_aura',
    animation: 'ground_shake',
    sound: 'giant_roar',
  },
  aurora: {
    particles: 'aurora_trail',
    color: 'rainbow_gradient',
    animation: 'aurora_flow',
    sound: 'aurora_hum',
  },
  // ...
};

function applyMutationEffect(pokemonSprite, mutation) {
  const effect = MutationEffects[mutation.type];
  pokemonSprite.addParticles(effect.particles);
  pokemonSprite.setAnimation(effect.animation);
  playSound(effect.sound);
}
```

## 5. 验收标准（可测试）

- [ ] 变异引擎实现，支持 7 种变异类型
- [ ] 变异概率计算正确，普通 1/500、稀有 1/2000、传说 1/10000
- [ ] 捕捉流程集成变异判定
- [ ] 变异精灵属性加成正确（5%-15%）
- [ ] 变异图鉴功能实现，记录玩家发现的所有变异
- [ ] 变异活动系统实现，可配置概率提升
- [ ] 管理后台支持创建和管理变异活动
- [ ] 前端变异精灵专属视觉效果
- [ ] Prometheus 指标：变异发现计数、变异类型分布
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 数据库迁移脚本可重复执行

## 6. 工作量估算

**L（Large）** - 约 3-5 天

- 变异引擎核心逻辑：1 天
- 数据库设计与迁移：0.5 天
- 捕捉服务集成：0.5 天
- 变异图鉴与活动系统：1 天
- 前端视觉效果：1 天
- 测试与文档：0.5 天

## 7. 优先级理由

**P1 理由：**

1. **核心玩法增强**：变异系统是收集类游戏的核心差异化玩法，显著提升用户留存
2. **社交传播价值**：稀有变异精灵是天然社交货币，有利于口碑传播
3. **商业化潜力**：变异活动可配合付费道具（变异雷达、概率提升卡）
4. **技术可行**：基于现有捕捉系统扩展，无需大规模重构
5. **竞品对标**：Pokémon GO 的闪光系统是成功案例，验证过市场接受度

## 8. 相关需求

- REQ-00065: 精灵进化与成长系统（依赖）
- REQ-00056: 精灵图鉴完成度奖励系统（关联）
- REQ-00102: 精灵昼夜循环系统（上下文加成）
- REQ-00037: 真实天气 API 集成（上下文加成）
