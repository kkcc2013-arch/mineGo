# REQ-00151: 精灵羁绊技能解锁机制

- **编号**：REQ-00151
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、backend/services/pokemon-service/src/friendshipService.js、backend/services/pokemon-service/src/routes/friendship.js、game-client、database/migrations
- **创建时间**：2026-06-12 09:00
- **依赖需求**：REQ-00067（精灵羁绊与互动养成系统）、REQ-00112（精灵技能冷却与能量系统）

## 1. 背景与问题

REQ-00067 已实现精灵羁绊与互动养成系统，包含亲密度等级、互动动作、羁绊加成等功能。REQ-00112 实现了精灵技能冷却与能量系统。但是当前系统存在以下缺口：

1. **羁绊技能缺失**：高亲密度精灵无法解锁专属技能，羁绊系统激励不足
2. **技能多样性不足**：现有技能池固定，缺少个性化培养路径
3. **羁绊价值未体现**：玩家投入大量时间提升亲密度，但收益仅限于数值加成

代码现状分析：
- `backend/services/pokemon-service/src/friendshipService.js` 已实现亲密度管理
- `backend/services/pokemon-service/src/routes/friendship.js` 暴露亲密度 API
- 缺少羁绊技能定义表和解锁逻辑
- 前端无法展示羁绊技能信息

**问题**：羁绊系统缺少核心激励机制，玩家动力不足，影响长期留存。

## 2. 目标

1. **增加羁绊价值**：高亲密度精灵解锁专属技能，提升培养动力
2. **丰富战斗策略**：羁绊技能提供独特战斗效果，增加策略深度
3. **长期留存提升**：通过技能解锁目标，延长玩家游戏周期
4. **个性化培养**：不同精灵可解锁不同羁绊技能，增加差异化

## 3. 范围

- **包含**：
  - 羁绊技能定义与配置系统
  - 基于亲密度的技能解锁机制
  - 羁绊技能学习与遗忘 API
  - 战斗系统集成（羁绊技能可用）
  - 前端羁绊技能展示 UI
  - 技能冷却与能量消耗

- **不包含**：
  - 新的互动动作开发
  - 技能机器（TM）系统修改
  - 闪光精灵专属技能

## 4. 详细需求

### 4.1 羁绊技能定义

每个精灵类型可拥有 1-3 个羁绊技能，按亲密度等级解锁：

| 亲密度等级 | 解锁技能槽位 | 技能特点 |
|-----------|-------------|---------|
| 友好（20-49） | 第1槽 | 基础羁绊技能，效果较弱 |
| 亲密（50-89） | 第2槽 | 中级羁绊技能，效果适中 |
| 牵绊（90-100） | 第3槽 | 高级羁绊技能，强力效果 |

### 4.2 羁绊技能示例

```javascript
// backend/services/pokemon-service/src/config/bondSkills.js
const BOND_SKILLS = {
  // 皮卡丘羁绊技能
  25: [
    {
      slot: 1,
      name: '羁绊电击',
      type: 'electric',
      power: 65,
      accuracy: 100,
      pp: 15,
      effect: '亲密度越高，威力越大',
      unlockLevel: 20,
      friendshipBonus: '威力 = 65 + (亲密度 × 0.5)'
    },
    {
      slot: 2,
      name: '守护闪电',
      type: 'electric',
      power: 0,
      accuracy: 100,
      pp: 10,
      effect: '为队友提供电属性护盾，吸收伤害',
      unlockLevel: 50,
      friendshipBonus: '护盾值 = 亲密度 × 10'
    },
    {
      slot: 3,
      name: '十万伏特·羁绊',
      type: 'electric',
      power: 120,
      accuracy: 90,
      pp: 5,
      effect: '无视对手电属性抗性',
      unlockLevel: 90,
      friendshipBonus: '暴击率 + (亲密度 / 100)'
    }
  ],
  // 伊布羁绊技能（可进化分支）
  133: [
    {
      slot: 1,
      name: '羁绊撞击',
      type: 'normal',
      power: 50,
      accuracy: 100,
      pp: 20,
      effect: '根据当前进化倾向提升威力',
      unlockLevel: 20,
      friendshipBonus: '进化倾向 × 亲密度 / 100'
    }
  ]
};
```

### 4.3 数据库迁移

```sql
-- 羁绊技能定义表
CREATE TABLE bond_skill_definitions (
  id SERIAL PRIMARY KEY,
  pokemon_species_id INTEGER NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  skill_name VARCHAR(50) NOT NULL,
  skill_name_en VARCHAR(50),
  type VARCHAR(20) NOT NULL,
  power INTEGER,
  accuracy INTEGER CHECK (accuracy BETWEEN 0 AND 100),
  pp INTEGER NOT NULL,
  effect_description TEXT,
  unlock_friendship_level INTEGER NOT NULL,
  friendship_bonus_formula TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pokemon_species_id, slot)
);

-- 精灵羁绊技能学习表
CREATE TABLE pokemon_bond_skills (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id UUID REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  bond_skill_id INTEGER REFERENCES bond_skill_definitions(id),
  learned_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  current_pp INTEGER,
  UNIQUE(pokemon_instance_id, bond_skill_id)
);

CREATE INDEX idx_pokemon_bond_skills_instance ON pokemon_bond_skills(pokemon_instance_id);

-- 插入示例数据
INSERT INTO bond_skill_definitions (pokemon_species_id, slot, skill_name, skill_name_en, type, power, accuracy, pp, effect_description, unlock_friendship_level, friendship_bonus_formula) VALUES
(25, 1, '羁绊电击', 'Bond Thunderbolt', 'electric', 65, 100, 15, '亲密度越高，威力越大', 20, '65 + (friendship * 0.5)'),
(25, 2, '守护闪电', 'Guardian Spark', 'electric', 0, 100, 10, '为队友提供电属性护盾', 50, 'friendship * 10'),
(25, 3, '十万伏特·羁绊', 'Thunder Bond', 'electric', 120, 90, 5, '无视对手电属性抗性', 90, 'crit_rate + (friendship / 100)');
```

### 4.4 API 端点

```
GET /api/pokemon/:id/bond-skills
  - 查询精灵可学习和已学习的羁绊技能
  - 返回：技能列表、解锁状态、亲密度等级

POST /api/pokemon/:id/bond-skills/:skillId/learn
  - 学习羁绊技能
  - 条件：亲密度达标、技能槽位空闲
  - 返回：学习成功、技能详情

DELETE /api/pokemon/:id/bond-skills/:skillId
  - 遗忘羁绊技能
  - 可重新学习

POST /api/pokemon/:id/bond-skills/:skillId/activate
  - 激活羁绊技能（用于战斗）
  - 限制：最多激活 1 个羁绊技能

GET /api/pokemon-species/:speciesId/bond-skills/available
  - 查询特定精灵种类可用的羁绊技能列表
  - 公开 API，无需认证
```

### 4.5 战斗系统集成

```javascript
// backend/services/gym-service/src/battleEngine.js (增强)

// 计算羁绊技能威力
function calculateBondSkillDamage(attacker, skill, defender) {
  const bondSkill = await getBondSkill(attacker.id, skill.id);
  if (!bondSkill) return null;
  
  const friendship = await getFriendshipLevel(attacker.id);
  const definition = bondSkill.definition;
  
  // 应用羁绊加成公式
  let power = definition.power;
  if (definition.friendship_bonus_formula) {
    const bonusValue = evalFormula(definition.friendship_bonus_formula, { friendship });
    power = bonusValue;
  }
  
  // 标准伤害计算
  return calculateStandardDamage(attacker, { ...skill, power }, defender);
}
```

### 4.6 前端展示

```javascript
// frontend/game-client/src/components/PokemonBondSkills.js

class PokemonBondSkills {
  // 展示羁绊技能卡片
  renderSkillCard(skill, isUnlocked, isLearned) {
    // 技能图标、名称、属性、威力、效果
    // 解锁状态指示器（亲密度不足/已解锁/已学习）
    // 学习/遗忘按钮
  }
  
  // 亲密度进度条
  renderFriendshipProgress(current, target) {
    // 进度条动画
    // 距离解锁还需亲密度
  }
  
  // 战斗中羁绊技能高亮
  highlightBondSkillInBattle(skill) {
    // 特殊边框效果
    // 羁绊图标徽章
  }
}
```

## 5. 验收标准（可测试）

- [ ] `node --check backend/services/pokemon-service/src/friendshipService.js` 通过
- [ ] `curl -sf http://localhost:8083/pokemon/:id/bond-skills` 返回 200
- [ ] `curl -sf http://localhost:8083/pokemon-species/25/bond-skills/available` 返回皮卡丘羁绊技能列表
- [ ] 亲密度 20 的精灵可学习第 1 槽羁绊技能
- [ ] 亲密度 50 的精灵可学习第 2 槽羁绊技能
- [ ] 亲密度 90 的精灵可学习第 3 槽羁绊技能
- [ ] 学习羁绊技能后可在战斗中使用
- [ ] 羁绊技能威力根据亲密度正确计算
- [ ] 可遗忘并重新学习羁绊技能
- [ ] 前端正确展示羁绊技能列表和解锁状态
- [ ] 单元测试覆盖率 ≥ 75%

## 6. 工作量估算

**M（Medium）**

理由：
- 数据库迁移简单（2 个表 + 种子数据）
- 后端逻辑清晰（解锁判断 + 技能学习）
- 需要修改战斗引擎集成羁绊技能
- 前端 UI 组件中等复杂度
- 预计 3-5 天完成

## 7. 优先级理由

**P1** 理由：
1. **核心循环增强**：羁绊系统是精灵培养的重要组成，技能解锁是核心激励
2. **已有基础**：REQ-00067 已实现亲密度系统，可复用
3. **战斗策略深度**：羁绊技能提供新的战斗选项，增加策略性
4. **长期留存**：技能解锁目标明确，延长玩家游戏周期
5. **商业化潜力**：可通过道具加速羁绊提升，增加变现点
