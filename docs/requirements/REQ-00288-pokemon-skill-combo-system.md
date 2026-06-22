# REQ-00288：精灵技能连击系统与组合技效果

- **编号**：REQ-00288
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：catch-service, gym-service, pokemon-service, game-client
- **创建时间**：2026-06-22 09:00 UTC
- **依赖需求**：REQ-00019（精灵技能学习系统）

## 1. 背景与问题

当前 mineGo 战斗系统仅支持单技能释放，缺乏技能组合和连击机制，导致：

1. **战斗策略单一**：玩家只需点击最强技能，缺乏策略深度
2. **技能协同价值低**：某些技能组合（如"麻痹+高伤害"）无法体现协同效果
3. **PvP 竞技性不足**：缺乏技能连击带来的操作上限和观赏性
4. **战斗节奏平淡**：没有连击奖励和视觉效果，战斗过程缺乏高潮

对比主流 ARPG 手游（如原神、崩坏3），技能连击系统是提升战斗深度的核心机制。

## 2. 目标

实现精灵技能连击系统，带来：
- 技能组合触发条件判定（顺序、时间窗口、元素类型）
- 连击效果加成（伤害倍率、额外效果、冷却缩减）
- 连击计数与奖励机制（连击点数、完美连击判定）
- 战斗节奏可视化（连击提示、特效、音效）
- 预计提升玩家留存率 15%，战斗时长增加 20%

## 3. 范围

- **包含**：
  - 连击链定义系统（技能组合配置）
  - 连击触发条件判定引擎
  - 连击效果计算与应用
  - 连击计数器与奖励系统
  - 连击 UI 提示与特效触发
  - 连击数据统计与分析
  - PvP 连击排行榜

- **不包含**：
  - 技能基础数据（REQ-00019 已实现）
  - 战斗匹配逻辑（已有实现）
  - 动画资源制作

## 4. 详细需求

### 4.1 连击链定义

```javascript
// 数据库表设计
CREATE TABLE combo_chains (
    id SERIAL PRIMARY KEY,
    chain_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    
    // 触发条件
    trigger_sequence JSONB NOT NULL,  // ["THUNDER_SHOCK", "THUNDER_WAVE", "THUNDERBOLT"]
    time_window_ms INTEGER DEFAULT 3000,  // 3秒内完成连击
    element_requirement VARCHAR(50),      // 可选：需要特定元素类型
    
    // 连击效果
    damage_multiplier DECIMAL(3,2) DEFAULT 1.0,
    bonus_effects JSONB,  // {"status": "paralyzed", "duration": 5}
    cooldown_reduction INTEGER DEFAULT 0,  // 冷却缩减百分比
    
    // 奖励
    combo_points INTEGER DEFAULT 1,
    xp_bonus INTEGER DEFAULT 0,
    
    // 解锁条件
    min_trainer_level INTEGER DEFAULT 1,
    required_badges INTEGER DEFAULT 0,
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_combo_stats (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chain_id VARCHAR(50) NOT NULL REFERENCES combo_chains(chain_id),
    times_executed INTEGER DEFAULT 0,
    perfect_executions INTEGER DEFAULT 0,
    last_executed_at TIMESTAMP,
    highest_damage_dealt INTEGER DEFAULT 0,
    
    UNIQUE(user_id, chain_id)
);

CREATE INDEX idx_user_combo_stats_user ON user_combo_stats(user_id);
CREATE INDEX idx_user_combo_stats_chain ON user_combo_stats(chain_id);
```

### 4.2 连击判定引擎

```javascript
// backend/services/gym-service/src/comboEngine.js

class ComboEngine {
  constructor() {
    this.activeCombos = new Map(); // userId -> active combo state
    this.comboChains = new Map();  // chainId -> chain config
  }

  /**
   * 记录技能释放并检查连击
   */
  async recordSkillUsage(userId, pokemonId, skillId, context) {
    const state = this.getActiveState(userId, pokemonId);
    
    // 更新技能序列
    state.sequence.push({
      skillId,
      timestamp: Date.now(),
      pokemonId
    });
    
    // 检查可能的连击
    const matchedCombos = await this.checkComboMatch(state);
    
    if (matchedCombos.length > 0) {
      // 取最高优先级连击
      const bestCombo = this.selectBestCombo(matchedCombos);
      
      // 判定连击质量（完美/普通）
      const quality = this.evaluateComboQuality(state, bestCombo);
      
      // 应用连击效果
      const effect = await this.applyComboEffect(userId, pokemonId, bestCombo, quality);
      
      // 重置状态
      this.resetState(userId, pokemonId);
      
      return {
        comboTriggered: true,
        combo: bestCombo,
        quality,
        effect
      };
    }
    
    // 检查是否超时
    if (this.isTimeout(state)) {
      this.resetState(userId, pokemonId);
    }
    
    return { comboTriggered: false };
  }

  /**
   * 检查连击匹配
   */
  async checkComboMatch(state) {
    const matches = [];
    const currentSequence = state.sequence.map(s => s.skillId);
    
    for (const [chainId, chain] of this.comboChains) {
      const triggerSeq = chain.trigger_sequence;
      
      // 检查序列匹配
      if (this.matchesSequence(currentSequence, triggerSeq)) {
        // 检查时间窗口
        if (this.checkTimeWindow(state, chain.time_window_ms)) {
          matches.push(chain);
        }
      }
    }
    
    return matches;
  }

  /**
   * 评估连击质量
   */
  evaluateComboQuality(state, chain) {
    const expectedWindow = chain.time_window_ms;
    const actualTime = state.sequence[state.sequence.length - 1].timestamp - 
                       state.sequence[0].timestamp;
    
    const ratio = actualTime / expectedWindow;
    
    if (ratio < 0.5) return 'perfect';   // 半时间内完成
    if (ratio < 0.8) return 'excellent'; // 80% 时间内完成
    return 'normal';
  }

  /**
   * 应用连击效果
   */
  async applyComboEffect(userId, pokemonId, chain, quality) {
    const qualityMultiplier = {
      perfect: 1.5,
      excellent: 1.25,
      normal: 1.0
    };
    
    return {
      damageMultiplier: chain.damage_multiplier * qualityMultiplier[quality],
      bonusEffects: chain.bonus_effects,
      cooldownReduction: chain.cooldown_reduction,
      comboPoints: Math.floor(chain.combo_points * qualityMultiplier[quality]),
      quality
    };
  }
}

module.exports = { ComboEngine };
```

### 4.3 连击奖励系统

```javascript
// 连击点数转换奖励
const COMBO_REWARDS = {
  pointsThresholds: [
    { points: 5, reward: { xp: 100, stardust: 50 } },
    { points: 10, reward: { xp: 250, stardust: 100, item: 'RARE_CANDY' } },
    { points: 20, reward: { xp: 500, stardust: 200, item: 'GOLDEN_RAZZ_BERRY' } },
    { points: 50, reward: { xp: 1500, stardust: 500, pokemon_encounter: 'rare' } }
  ],
  
  streakBonus: {
    3: 1.1,   // 3连击 +10% 奖励
    5: 1.2,   // 5连击 +20% 奖励
    10: 1.5   // 10连击 +50% 奖励
  }
};

// 完美连击额外奖励
const PERFECT_COMBO_BONUS = {
  xp: 50,
  stardust: 25,
  achievementProgress: true
};
```

### 4.4 API 端点

```
GET  /api/v1/combos                    - 获取所有可用连击链
GET  /api/v1/combos/:chainId           - 获取连击详情
GET  /api/v1/combos/my/stats           - 获取玩家连击统计
POST /api/v1/battle/skill              - 释放技能（自动检测连击）
GET  /api/v1/combos/leaderboard        - 连击排行榜
POST /api/v1/combos/:chainId/practice  - 练习连击模式
```

### 4.5 预设连击链示例

```javascript
// 元素连击
const PRESET_COMBOS = [
  {
    chainId: 'THUNDER_TRINITY',
    name: '雷电三连',
    trigger_sequence: ['THUNDER_SHOCK', 'THUNDER_WAVE', 'THUNDERBOLT'],
    time_window_ms: 5000,
    damage_multiplier: 2.0,
    bonus_effects: { status: 'paralyzed', duration: 3 },
    combo_points: 3
  },
  {
    chainId: 'FIRE_STORM',
    name: '火焰风暴',
    trigger_sequence: ['FIRE_SPIN', 'FLAMETHROWER', 'FIRE_BLAST'],
    time_window_ms: 6000,
    damage_multiplier: 2.5,
    bonus_effects: { burn: true, damage_over_time: 10 },
    combo_points: 4
  },
  {
    chainId: 'STATUS_LOCK',
    name: '状态封锁',
    trigger_sequence: ['THUNDER_WAVE', 'TOXIC', 'CONFUSE_RAY'],
    time_window_ms: 8000,
    damage_multiplier: 1.5,
    bonus_effects: { 
      all_status_immunity: true,  // 免疫所有状态
      duration: 5 
    },
    combo_points: 5
  },
  {
    chainId: 'HEALING_CHAIN',
    name: '治愈连锁',
    trigger_sequence: ['RECOVER', 'REST', 'HEAL_BELL'],
    time_window_ms: 10000,
    damage_multiplier: 1.0,
    bonus_effects: { 
      full_heal: true, 
      status_clear: true,
      revive_fainted: 0.5 // 复活倒下精灵 50% HP
    },
    combo_points: 4
  }
];
```

## 5. 验收标准（可测试）

- [ ] 连击链配置可从数据库正确加载
- [ ] 技能序列按正确顺序释放可触发连击
- [ ] 时间窗口内完成连击判定正确
- [ ] 完美/优秀/普通连击质量评估正确
- [ ] 连击伤害倍率正确应用于战斗伤害计算
- [ ] 连击奖励（连击点数、经验、道具）正确发放
- [ ] 连击 UI 提示在客户端正确显示
- [ ] 连击特效触发时机正确
- [ ] 玩家连击统计数据正确记录
- [ ] 连击排行榜数据正确排序
- [ ] PvP 战斗中连击效果正常生效
- [ ] 连击冷却时间正确应用
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 集成测试覆盖连击完整流程

## 6. 工作量估算

**L（Large）**

理由：
- 需要新增 2 个数据库表和预置数据
- 连击引擎逻辑复杂（状态机、时间判定、效果应用）
- 需要与现有战斗系统集成（gym-service, catch-service）
- 客户端需要新增连击 UI 和特效
- 预计工作量：3-4 人日

## 7. 优先级理由

**P1 理由：**

1. **核心玩法增强**：战斗系统是游戏核心，连击机制直接提升战斗深度
2. **用户留存提升**：技能连击增加操作乐趣，预计提升留存率 15%
3. **竞技性增强**：PvP 场景中连击技巧提供操作上限，增强竞技体验
4. **差异化竞争力**：相比同类产品，连击系统是显著的差异化特性
5. **可扩展性强**：连击链系统支持后续持续更新新组合

当前项目成熟度 84 分，战斗深度是核心功能的明显短板，本需求直接补强这一领域。
