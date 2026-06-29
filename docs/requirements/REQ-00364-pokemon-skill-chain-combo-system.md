# REQ-00364: 精灵技能连击系统与组合技效果

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00364 |
| 标题 | 精灵技能连击系统与组合技效果 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 13:00 |

## 需求描述

实现精灵技能连击系统，允许玩家在战斗中触发技能组合效果。当特定技能按顺序使用时，可触发强力的组合技效果，增加战斗策略深度和趣味性。

### 核心功能

1. **连击链定义**
   - 技能连击序列配置（技能A → 技能B → 组合技C）
   - 连击触发时间窗口（如5秒内连续使用）
   - 连击前置条件（精灵属性、状态、等级要求）

2. **组合技效果**
   - 组合技伤害加成（基础伤害 × 连击倍率）
   - 特殊状态效果（群体控制、持续伤害、增益buff）
   - 视觉特效与动画表现

3. **连击管理系统**
   - 连击熟练度与解锁进度
   - 连击冷却与使用限制
   - 连击图鉴与教程引导

4. **战斗集成**
   - 道馆战斗中的连击支持
   - PVP 对战中的连击机制
   - 连击回放与战绩展示

## 技术方案

### 1. 数据库设计

```sql
-- 连击链定义表
CREATE TABLE skill_combo_chains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_name VARCHAR(100) NOT NULL,
    chain_description TEXT,
    skill_sequence JSONB NOT NULL, -- ["skill_id_1", "skill_id_2", "skill_id_3"]
    combo_skill_id UUID REFERENCES skills(id),
    time_window_ms INTEGER DEFAULT 5000,
    damage_multiplier DECIMAL(4,2) DEFAULT 1.5,
    status_effects JSONB, -- [{effect: "stun", duration_ms: 2000}]
    required_pokemon_types JSONB, -- ["fire", "dragon"]
    required_level INTEGER DEFAULT 10,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 玩家连击熟练度表
CREATE TABLE user_combo_mastery (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    combo_chain_id UUID REFERENCES skill_combo_chains(id) NOT NULL,
    proficiency_level INTEGER DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    last_used_at TIMESTAMP,
    unlocked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, combo_chain_id)
);

-- 连击使用记录表
CREATE TABLE combo_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    battle_id UUID,
    combo_chain_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    battle_type VARCHAR(20), -- 'gym', 'pvp', 'pve'
    damage_dealt INTEGER,
    effects_applied JSONB,
    used_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_combo_mastery_user ON user_combo_mastery(user_id);
CREATE INDEX idx_combo_mastery_chain ON user_combo_mastery(combo_chain_id);
CREATE INDEX idx_combo_logs_user ON combo_usage_logs(user_id);
CREATE INDEX idx_combo_logs_time ON combo_usage_logs(used_at DESC);
```

### 2. 连击检测引擎

```javascript
// backend/shared/ComboChainEngine.js
class ComboChainEngine {
  constructor() {
    this.activeChains = new Map(); // userId -> { pendingChain, lastSkillTime, sequence }
    this.COMBO_TIME_WINDOW = 5000; // 5秒
  }

  /**
   * 检测连击触发
   * @param {string} userId - 用户ID
   * @param {string} skillId - 使用的技能ID
   * @param {object} pokemon - 当前精灵
   * @returns {object|null} - 触发的组合技或null
   */
  async detectCombo(userId, skillId, pokemon) {
    const now = Date.now();
    const userChain = this.activeChains.get(userId) || {
      sequence: [],
      lastSkillTime: 0,
      pendingChain: null
    };

    // 检查时间窗口
    if (now - userChain.lastSkillTime > this.COMBO_TIME_WINDOW) {
      userChain.sequence = [];
    }

    // 添加到序列
    userChain.sequence.push(skillId);
    userChain.lastSkillTime = now;

    // 查找匹配的连击链
    const matchingChain = await this.findMatchingChain(
      userChain.sequence,
      pokemon
    );

    if (matchingChain) {
      // 触发组合技
      this.activeChains.delete(userId);
      return {
        comboTriggered: true,
        comboChain: matchingChain,
        comboSkill: matchingChain.combo_skill_id
      };
    }

    // 更新活跃状态
    this.activeChains.set(userId, userChain);
    return null;
  }

  /**
   * 查找匹配的连击链
   */
  async findMatchingChain(sequence, pokemon) {
    // 从缓存或数据库查询
    const possibleCombos = await this.getPotentialCombos(sequence);
    
    for (const combo of possibleCombos) {
      if (this.matchesCombo(sequence, combo, pokemon)) {
        return combo;
      }
    }
    return null;
  }

  /**
   * 检查是否匹配连击条件
   */
  matchesCombo(sequence, combo, pokemon) {
    const skillSequence = combo.skill_sequence;
    
    // 序列长度必须匹配
    if (sequence.length !== skillSequence.length) {
      return false;
    }

    // 技能序列必须精确匹配
    for (let i = 0; i < skillSequence.length; i++) {
      if (sequence[i] !== skillSequence[i]) {
        return false;
      }
    }

    // 检查精灵类型要求
    if (combo.required_pokemon_types?.length > 0) {
      const hasType = pokemon.types.some(t => 
        combo.required_pokemon_types.includes(t)
      );
      if (!hasType) return false;
    }

    // 检查等级要求
    if (combo.required_level && pokemon.level < combo.required_level) {
      return false;
    }

    return true;
  }
}

module.exports = ComboChainEngine;
```

### 3. 战斗系统集成

```javascript
// backend/services/gym-service/src/ComboBattleHandler.js
class ComboBattleHandler {
  constructor(comboEngine, masteryService) {
    this.comboEngine = comboEngine;
    this.masteryService = masteryService;
  }

  /**
   * 处理战斗中的技能使用
   */
  async handleSkillUse(battleContext, skillId) {
    const { userId, pokemon, battleId } = battleContext;

    // 检测连击
    const comboResult = await this.comboEngine.detectCombo(
      userId,
      skillId,
      pokemon
    );

    if (comboResult?.comboTriggered) {
      // 获取组合技详情
      const comboChain = comboResult.comboChain;
      const comboSkill = await this.getComboSkill(comboChain.combo_skill_id);

      // 计算组合技伤害
      const damage = await this.calculateComboDamage(
        pokemon,
        comboSkill,
        comboChain.damage_multiplier
      );

      // 应用状态效果
      const effects = await this.applyComboEffects(
        battleContext,
        comboChain.status_effects
      );

      // 更新熟练度
      await this.masteryService.updateMastery(userId, comboChain.id);

      // 记录日志
      await this.logComboUsage(userId, battleId, comboChain, pokemon, damage);

      return {
        type: 'combo_skill',
        skill: comboSkill,
        damage,
        effects,
        animation: comboSkill.animation_id
      };
    }

    return null;
  }

  /**
   * 计算组合技伤害
   */
  async calculateComboDamage(pokemon, comboSkill, multiplier) {
    const baseDamage = pokemon.attack * comboSkill.power / 100;
    const comboDamage = Math.floor(baseDamage * multiplier);
    
    // 熟练度加成
    const masteryBonus = await this.getMasteryBonus(pokemon.user_id, comboSkill);
    
    return Math.floor(comboDamage * (1 + masteryBonus));
  }
}

module.exports = ComboBattleHandler;
```

### 4. 前端连击提示系统

```javascript
// frontend/game-client/src/game/ComboHintSystem.js
class ComboHintSystem {
  constructor() {
    this.skillSequence = [];
    this.hintTimeout = null;
    this.possibleCombos = [];
  }

  /**
   * 显示连击提示
   */
  showComboHint(skillId, pokemon) {
    this.skillSequence.push(skillId);
    
    // 获取可能的连击组合
    this.possibleCombos = this.findPossibleCombos(this.skillSequence, pokemon);
    
    if (this.possibleCombos.length > 0) {
      this.renderComboHintUI();
    }
    
    // 设置超时清除
    this.resetHintTimeout();
  }

  /**
   * 渲染连击提示UI
   */
  renderComboHintUI() {
    const hintContainer = document.getElementById('combo-hint');
    
    if (this.possibleCombos.length === 1) {
      // 只有一个可能的组合，显示下一步
      const combo = this.possibleCombos[0];
      const nextSkill = this.getNextSkill(combo);
      
      hintContainer.innerHTML = `
        <div class="combo-hint-active">
          <span class="combo-label">连击准备!</span>
          <span class="next-skill">下一个技能: ${nextSkill.name}</span>
          <div class="skill-icon">${nextSkill.icon}</div>
        </div>
      `;
      hintContainer.className = 'combo-hint show';
    } else {
      // 多个可能的组合
      hintContainer.innerHTML = `
        <div class="combo-hint-multiple">
          <span class="combo-label">可能触发 ${this.possibleCombos.length} 种连击</span>
        </div>
      `;
      hintContainer.className = 'combo-hint show';
    }
  }

  /**
   * 组合技触发动画
   */
  playComboAnimation(comboChain) {
    const animationLayer = document.getElementById('battle-animation-layer');
    
    animationLayer.innerHTML = `
      <div class="combo-animation">
        <div class="combo-name">${comboChain.chain_name}</div>
        <div class="combo-flash"></div>
        <video src="/assets/combo-animations/${comboChain.combo_skill_id}.mp4" 
               autoplay 
               onended="this.parentElement.remove()">
        </video>
      </div>
    `;
    
    // 震动反馈
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }
  }
}

module.exports = ComboHintSystem;
```

### 5. API 端点设计

```yaml
# 连击管理 API
GET /api/v1/combos
  - 获取所有可用连击链列表
  - 权限：已登录用户
  - 响应：连击链列表（含解锁状态）

GET /api/v1/combos/:id
  - 获取单个连击链详情
  - 权限：已登录用户
  - 响应：连击链完整信息

GET /api/v1/users/me/combos/mastery
  - 获取用户连击熟练度
  - 权限：已登录用户
  - 响应：熟练度列表

POST /api/v1/combos/:id/practice
  - 练习连击（教程模式）
  - 权限：已登录用户
  - 响应：练习结果

# 战斗中的连击
POST /api/v1/battles/:battleId/skill
  - 请求体：{ skillId, pokemonId }
  - 响应可能包含：comboTriggered、comboSkill 等
```

## 验收标准

- [ ] 连击链配置表已创建，支持至少20种连击组合
- [ ] 连击检测引擎实现完成，5秒时间窗口内可正确检测连击
- [ ] 组合技伤害计算正确，包含熟练度加成
- [ ] 状态效果应用正确，支持眩晕、持续伤害、增益buff等
- [ ] 前端连击提示系统显示正确，引导玩家完成连击
- [ ] 组合技动画效果播放流畅，支持震动反馈
- [ ] 道馆战斗中连击机制工作正常
- [ ] PVP 对战中连击机制工作正常，包含冷却限制
- [ ] 连击熟练度系统工作正常，使用次数统计准确
- [ ] 连击使用日志记录完整，支持数据分析
- [ ] 性能测试：单次连击检测延迟 < 50ms
- [ ] 单元测试覆盖率 > 80%

## 影响范围

- **pokemon-service**：技能数据模型、连击链配置管理
- **gym-service**：道馆战斗连击处理
- **social-service**：PVP 对战连击支持
- **gateway**：连击 API 路由
- **game-client**：连击提示UI、组合技动画
- **database/migrations**：连击相关表结构

## 参考

- [Pokemon Battle Mechanics Wiki](https://bulbapedia.bulbagarden.net/wiki/Battle)
- [Fighting Game Combo System Design](https://www.gamedeveloper.com/design/designing-fighting-game-combos)
- 相关需求：REQ-00019 精灵技能学习系统、REQ-00090 精灵状态效果系统