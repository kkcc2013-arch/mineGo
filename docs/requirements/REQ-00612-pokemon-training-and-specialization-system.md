# REQ-00612：精灵训练特训系统与专项能力提升机制

- **编号**：REQ-00612
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、gateway、game-client、backend/shared/trainingService.js、database/migrations
- **创建时间**：2026-07-20 18:00
- **依赖需求**：REQ-00019（技能学习系统）、REQ-00067（精灵亲密度系统）

## 1. 背景与问题

当前 mineGo 项目已实现精灵捕捉、进化、培育、技能学习等核心功能，但缺少**精灵专项训练系统**，导致玩家无法针对特定战斗场景或属性弱点进行针对性提升。现有问题：

1. **属性成长单一**：精灵属性提升仅依靠升级和进化，缺乏多样化培养路径
2. **技能熟练度缺失**：技能学习后无熟练度机制，无法通过训练提升技能威力或效果
3. **战斗准备不足**：玩家在面对特定道馆或活动时，无法针对性训练精灵克制属性
4. **养成深度不够**：培育系统侧重遗传和孵化，缺少长期养成玩法
5. **资源利用率低**：糖果、道具等养成资源仅用于升级，缺少多样化用途

竞争对手游戏（如《宝可梦》系列）拥有完善的努力值（EV）训练、基础点数系统、招式强化机制，而当前项目在此领域存在明显缺口。

## 2. 目标

构建完整的精灵训练特训系统，允许玩家通过专项训练提升精灵的核心属性、技能威力和战斗表现，实现：

1. **多样化属性成长**：通过训练提升攻击、防御、速度、暴击等六大核心属性
2. **技能熟练度系统**：训练提升技能威力、命中率、暴击率，解锁技能特效
3. **针对性特训场景**：针对道馆属性、活动BOSS的克制训练
4. **资源深度利用**：引入训练道具（能量饮料、训练设备、特训场地）
5. **长期养成目标**：特训成就、里程碑奖励、训练师等级系统

预期收益：提升玩家养成深度30%，增加日活跃时长15%，降低流失率10%。

## 3. 范围

- **包含**：
  - 训练属性系统（攻击、防御、速度、暴击、闪避、能量六大属性）
  - 技能熟练度系统（威力、命中、暴击、特效四维度）
  - 训练场地与场景设计（力量训练场、敏捷训练场、智慧训练场等）
  - 训练道具系统（能量饮料、蛋白粉、训练设备）
  - 训练计划与调度系统
  - 训练成就与里程碑
  - API 接口与前端界面
  
- **不包含**：
  - 精灵进化（已有 REQ-00065）
  - 精灵培育与遗传（已有 REQ-00046）
  - 技能学习（已有 REQ-00019）
  - 亲密度系统（已有 REQ-00067）
  - 训练相关的反作弊（单独需求）

## 4. 详细需求

### 4.1 训练属性系统

#### 属性定义
```javascript
const TRAINING_ATTRIBUTES = {
  ATTACK: {
    id: 'attack',
    name: '攻击强化',
    maxLevel: 100,
    effect: '每级提升攻击力 +2%',
    trainingCost: { energyDrink: 1, candy: 100 }
  },
  DEFENSE: {
    id: 'defense',
    name: '防御强化',
    maxLevel: 100,
    effect: '每级提升防御力 +2%',
    trainingCost: { proteinPowder: 1, candy: 100 }
  },
  SPEED: {
    id: 'speed',
    name: '速度强化',
    maxLevel: 100,
    effect: '每级提升速度 +2%，可能先手攻击',
    trainingCost: { agilityPill: 1, candy: 100 }
  },
  CRITICAL: {
    id: 'critical',
    name: '暴击强化',
    maxLevel: 50,
    effect: '每级提升暴击率 +0.5%',
    trainingCost: { criticalStone: 1, candy: 200 }
  },
  DODGE: {
    id: 'dodge',
    name: '闪避强化',
    maxLevel: 50,
    effect: '每级提升闪避率 +0.3%',
    trainingCost: { swiftFeather: 1, candy: 150 }
  },
  ENERGY: {
    id: 'energy',
    name: '能量强化',
    maxLevel: 50,
    effect: '每级提升能量上限 +5，加快技能释放',
    trainingCost: { energyCore: 1, candy: 250 }
  }
};
```

#### 训练机制
- 每个属性独立训练，等级上限不同
- 训练消耗道具 + 糖果 + 时间
- 训练期间精灵无法战斗
- 可使用加速道具缩短训练时间
- 每日训练次数限制（VIP 可增加）

### 4.2 技能熟练度系统

#### 熟练度维度
```javascript
const SKILL_MASTERY_DIMENSIONS = {
  POWER: {
    id: 'power',
    name: '威力强化',
    maxLevel: 10,
    effect: '每级提升技能基础威力 +5%',
    trainingCost: { moveCandy: 10 }
  },
  ACCURACY: {
    id: 'accuracy',
    name: '命中强化',
    maxLevel: 10,
    effect: '每级提升命中率 +2%',
    trainingCost: { focusLens: 1 }
  },
  CRITICAL_CHANCE: {
    id: 'critical_chance',
    name: '暴击强化',
    maxLevel: 5,
    effect: '每级提升技能暴击率 +3%',
    trainingCost: { criticalStone: 2 }
  },
  SPECIAL_EFFECT: {
    id: 'special_effect',
    name: '特效解锁',
    levels: [10, 25, 50, 75, 100],
    effects: [
      '概率追加状态异常',
      '提升异常触发概率',
      '追加属性下降效果',
      '追加生命回复效果',
      '无视部分防御'
    ]
  }
};
```

#### 熟练度获取
- 战斗中使用技能获得熟练度经验
- 技能训练场专项训练
- 使用技能熟练度道具
- 熟练度等级影响技能表现

### 4.3 训练场地系统

#### 场地类型
```javascript
const TRAINING_FACILITIES = {
  STRENGTH_GYM: {
    id: 'strength_gym',
    name: '力量训练场',
    boostAttribute: 'attack',
    boostMultiplier: 1.5,
    unlockRequirement: { trainerLevel: 5 },
    costPerHour: { coins: 500 }
  },
  AGILITY_TRACK: {
    id: 'agility_track',
    name: '敏捷训练场',
    boostAttribute: 'speed',
    boostMultiplier: 1.5,
    unlockRequirement: { trainerLevel: 10 },
    costPerHour: { coins: 800 }
  },
  WISDOM_ACADEMY: {
    id: 'wisdom_academy',
    name: '智慧学院',
    boostAttribute: 'energy',
    boostMultiplier: 1.3,
    unlockRequirement: { trainerLevel: 15 },
    costPerHour: { coins: 1000 }
  },
  CRITICAL_DOJO: {
    id: 'critical_dojo',
    name: '暴击道场',
    boostAttribute: 'critical',
    boostMultiplier: 2.0,
    unlockRequirement: { trainerLevel: 20 },
    costPerHour: { coins: 1500 }
  },
  ALL_PURPOSE_CENTER: {
    id: 'all_purpose_center',
    name: '综合训练中心',
    boostAttribute: 'all',
    boostMultiplier: 1.2,
    unlockRequirement: { trainerLevel: 25 },
    costPerHour: { coins: 2000 }
  }
};
```

#### 场地特性
- 特定属性训练效率提升
- 解锁条件（训练师等级、前置成就）
- 使用成本（金币/钻石）
- 场地等级可升级
- VIP 专属场地

### 4.4 训练道具系统

#### 道具类型
```javascript
const TRAINING_ITEMS = {
  // 基础道具
  ENERGY_DRINK: { id: 'energy_drink', name: '能量饮料', effect: '攻击训练必需', rarity: 'common' },
  PROTEIN_POWDER: { id: 'protein_powder', name: '蛋白粉', effect: '防御训练必需', rarity: 'common' },
  AGILITY_PILL: { id: 'agility_pill', name: '敏捷药剂', effect: '速度训练必需', rarity: 'common' },
  
  // 稀有道具
  CRITICAL_STONE: { id: 'critical_stone', name: '暴击石', effect: '暴击训练必需', rarity: 'rare' },
  SWIFT_FEATHER: { id: 'swift_feather', name: '疾风羽毛', effect: '闪避训练必需', rarity: 'rare' },
  ENERGY_CORE: { id: 'energy_core', name: '能量核心', effect: '能量训练必需', rarity: 'rare' },
  
  // 加速道具
  TRAINING_ACCELERATOR_1H: { id: 'training_accelerator_1h', name: '训练加速器(1小时)', effect: '缩短训练时间1小时', rarity: 'uncommon' },
  TRAINING_ACCELERATOR_8H: { id: 'training_accelerator_8h', name: '训练加速器(8小时)', effect: '缩短训练时间8小时', rarity: 'rare' },
  
  // 特殊道具
  MASTERY_MANUAL: { id: 'mastery_manual', name: '熟练度手册', effect: '直接提升技能熟练度', rarity: 'epic' },
  GOLDEN_APPLE: { id: 'golden_apple', name: '金苹果', effect: '训练成功率+20%', rarity: 'legendary' }
};
```

#### 道具获取
- 商店购买
- 活动奖励
- 任务奖励
- 道馆掉落
- 好友赠送

### 4.5 训练计划系统

#### 功能设计
- 创建训练计划（目标属性、时间安排、资源分配）
- 批量训练（多只精灵同时训练）
- 训练队列管理
- 自动训练（VIP 功能）
- 训练完成通知

#### 训练队列
```javascript
const TRAINING_QUEUE_CONFIG = {
  maxSlots: 3, // 默认训练队列
  vipBonusSlots: {
    vip1: 2,
    vip2: 3,
    vip3: 5
  },
  cooldownAfterTraining: 3600 // 训练后冷却时间（秒）
};
```

### 4.6 训练成就系统

#### 成就类型
```javascript
const TRAINING_ACHIEVEMENTS = {
  FIRST_TRAINING: { id: 'first_training', name: '初出茅庐', requirement: '完成首次训练', reward: { candy: 1000 } },
  ATTACK_MASTER: { id: 'attack_master', name: '攻击大师', requirement: '攻击属性训练至50级', reward: { criticalStone: 10 } },
  ALL_ROUNDER: { id: 'all_rounder', name: '全能战士', requirement: '所有属性训练至30级', reward: { goldenApple: 1 } },
  SKILL_EXPERT: { id: 'skill_expert', name: '技能专家', requirement: '任意技能熟练度达到100', reward: { masteryManual: 5 } },
  TRAINING_ADDICT: { id: 'training_addict', name: '训练狂人', requirement: '累计训练1000小时', reward: { coins: 100000 } }
};
```

### 4.7 数据库设计

#### 精灵训练属性表
```sql
CREATE TABLE pokemon_training_attributes (
  id SERIAL PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  
  -- 六大属性
  attack_level INTEGER DEFAULT 0 CHECK (attack_level >= 0 AND attack_level <= 100),
  defense_level INTEGER DEFAULT 0 CHECK (defense_level >= 0 AND defense_level <= 100),
  speed_level INTEGER DEFAULT 0 CHECK (speed_level >= 0 AND speed_level <= 100),
  critical_level INTEGER DEFAULT 0 CHECK (critical_level >= 0 AND critical_level <= 50),
  dodge_level INTEGER DEFAULT 0 CHECK (dodge_level >= 0 AND dodge_level <= 50),
  energy_level INTEGER DEFAULT 0 CHECK (energy_level >= 0 AND energy_level <= 50),
  
  -- 训练统计
  total_training_hours REAL DEFAULT 0,
  total_training_sessions INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(pokemon_id, user_id)
);

CREATE INDEX idx_training_pokemon ON pokemon_training_attributes(pokemon_id);
CREATE INDEX idx_training_user ON pokemon_training_attributes(user_id);
```

#### 技能熟练度表
```sql
CREATE TABLE skill_mastery (
  id SERIAL PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  skill_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  
  -- 四维度熟练度
  power_level INTEGER DEFAULT 0 CHECK (power_level >= 0 AND power_level <= 10),
  accuracy_level INTEGER DEFAULT 0 CHECK (accuracy_level >= 0 AND accuracy_level <= 10),
  critical_level INTEGER DEFAULT 0 CHECK (critical_level >= 0 AND critical_level <= 5),
  special_effect_level INTEGER DEFAULT 0 CHECK (special_effect_level IN (0, 1, 2, 3, 4, 5)),
  
  -- 熟练度经验
  mastery_experience INTEGER DEFAULT 0,
  
  -- 战斗统计
  times_used INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(pokemon_id, skill_id, user_id)
);

CREATE INDEX idx_mastery_pokemon ON skill_mastery(pokemon_id);
CREATE INDEX idx_mastery_skill ON skill_mastery(skill_id);
```

#### 训练队列表
```sql
CREATE TABLE training_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  
  training_type VARCHAR(50) NOT NULL, -- 'attack', 'defense', 'speed', 'critical', 'dodge', 'energy', 'skill'
  target_skill_id INTEGER, -- 仅当 training_type = 'skill' 时有效
  
  facility_id VARCHAR(50), -- 训练场地 ID
  
  started_at TIMESTAMP NOT NULL,
  estimated_end_at TIMESTAMP NOT NULL,
  actual_end_at TIMESTAMP,
  
  status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  
  -- 资源消耗
  items_consumed JSONB,
  candy_cost INTEGER,
  coins_cost INTEGER,
  
  -- 训练结果
  attribute_gain JSONB, -- { attack: 1, defense: 0.5 }
  mastery_gain JSONB, -- { power: 5, accuracy: 3 }
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_queue_user ON training_queue(user_id);
CREATE INDEX idx_queue_status ON training_queue(status);
CREATE INDEX idx_queue_pokemon ON training_queue(pokemon_id);
```

#### 训练道具库存表
```sql
CREATE TABLE training_items_inventory (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id VARCHAR(50) NOT NULL,
  quantity INTEGER DEFAULT 0 CHECK (quantity >= 0),
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id, item_id)
);

CREATE INDEX idx_items_user ON training_items_inventory(user_id);
```

#### 训练场地用户解锁表
```sql
CREATE TABLE training_facilities_unlocked (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  facility_id VARCHAR(50) NOT NULL,
  
  unlocked_at TIMESTAMP DEFAULT NOW(),
  usage_count INTEGER DEFAULT 0,
  total_hours REAL DEFAULT 0,
  
  UNIQUE(user_id, facility_id)
);
```

### 4.8 API 接口设计

#### 核心接口

**1. 查询精灵训练状态**
```
GET /api/pokemon/:id/training
Response: {
  attributes: { attack: { level: 25, maxLevel: 100, effect: '+50% attack' }, ... },
  skillMastery: [ { skillId: 1, power: 5, accuracy: 3, ... } ],
  currentTraining: null,
  trainingHistory: [...]
}
```

**2. 开始训练**
```
POST /api/pokemon/:id/training/start
Body: {
  trainingType: 'attack',
  facilityId: 'strength_gym',
  useAccelerator: true
}
Response: {
  trainingId: 123,
  estimatedEndAt: '2026-07-20T20:00:00Z',
  cost: { energyDrink: 1, candy: 100, coins: 500 }
}
```

**3. 完成训练**
```
POST /api/pokemon/:id/training/:trainingId/complete
Response: {
  success: true,
  attributeGain: { attack: 1 },
  newLevel: 26,
  achievement: { id: 'attack_novice', name: '攻击新手' }
}
```

**4. 技能熟练度训练**
```
POST /api/pokemon/:id/skill/:skillId/train
Body: {
  dimension: 'power',
  useManual: true
}
Response: {
  success: true,
  masteryGain: { power: 5 },
  newPowerLevel: 6,
  unlockedEffect: null
}
```

**5. 查询训练队列**
```
GET /api/training/queue
Response: {
  slots: { used: 2, max: 5 },
  queue: [
    { trainingId: 123, pokemonId: 456, type: 'attack', remaining: 3600 }
  ]
}
```

**6. 管理训练道具**
```
GET /api/training/items
POST /api/training/items/use
Body: { itemId: 'training_accelerator_1h', trainingId: 123 }
```

## 5. 验收标准（可测试）

- [ ] 玩家可以为精灵选择任意一种属性进行训练（攻击/防御/速度/暴击/闪避/能量）
- [ ] 训练消耗正确的道具、糖果和金币，训练期间精灵显示"训练中"状态
- [ ] 训练完成后精灵属性正确提升，对应等级和效果符合设计
- [ ] 技能熟练度系统支持威力、命中、暴击、特效四个维度的训练
- [ ] 技能在战斗中使用后获得熟练度经验，熟练度等级影响技能表现
- [ ] 训练场地系统提供特定属性训练效率加成，需要解锁条件
- [ ] 训练队列支持同时训练多只精灵，队列满时无法新增训练
- [ ] 训练道具系统正常工作，商店可购买道具，道具正确消耗
- [ ] 训练成就系统记录玩家训练里程碑，达成条件后发放奖励
- [ ] 前端界面显示精灵训练状态、训练进度、训练队列、道具库存
- [ ] 单元测试覆盖训练逻辑、属性计算、熟练度计算的 80% 以上
- [ ] 性能测试：训练队列查询 < 100ms，训练开始/完成 < 200ms

## 6. 工作量估算

**L (Large)** - 预计 40-60 小时

理由：
- 涉及 6 个核心模块（属性系统、熟练度系统、场地系统、道具系统、队列系统、成就系统）
- 数据库设计复杂（5 张新表）
- 前端界面开发量大（训练中心、精灵训练详情、道具管理）
- 需要平衡性调整和数值验证
- 需要与现有战斗系统集成

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **核心玩法缺口**：训练系统是精灵养成游戏的核心玩法，当前项目缺少此功能影响游戏完整性
2. **玩家需求强烈**：社区反馈中"精灵培养深度不足"是高频需求
3. **收益显著**：预期提升日活时长 15%，降低流失率 10%，对项目可用性贡献大
4. **系统基础**：训练系统为后续活动、竞技、道馆挑战提供精灵养成基础
5. **资源消耗出口**：提供糖果、道具的多样化使用途径，提升经济系统深度

对"项目可用"的贡献：训练系统补全了精灵养成的核心玩法闭环，使玩家可以长期投入精灵培养，显著提升游戏粘性和生命周期，是项目达到生产可用标准的必要功能。
