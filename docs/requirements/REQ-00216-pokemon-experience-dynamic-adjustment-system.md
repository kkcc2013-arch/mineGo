# REQ-00216: 精灵经验值动态调整与智能加速系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00216 |
| 标题 | 精灵经验值动态调整与智能加速系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-15 00:00 |

## 需求描述

实现精灵经验值获取的动态调整与智能加速系统，根据玩家等级差距、精灵稀有度、战斗表现等因素动态调整经验值获取倍率，同时提供经验加成道具和活动期间的经验加速功能。

### 核心功能

1. **动态经验倍率计算**
   - 玩家等级与精灵等级差距系数
   - 稀有精灵额外经验奖励
   - 连续捕捉加成（连击奖励）
   - 首次捕捉新精灵经验翻倍

2. **经验加成系统**
   - 幸运蛋道具经验加成
   - 活动期间全局经验倍率
   - VIP 用户经验加成特权
   - 公会经验加成BUFF

3. **经验加速道具**
   - 经验糖果分级（S/M/L）
   - 经验卡（限时/永久）
   - 经验转移功能（精灵间经验共享）

4. **经验获取统计分析**
   - 经验获取来源追踪
   - 每日/每周经验报告
   - 升级预测与时间估算

## 技术方案

### 1. 经验值计算引擎（backend/shared/ExperienceEngine.js）

```javascript
const ExperienceEngine = {
  // 基础经验获取计算
  calculateBaseExperience: (pokemon, battleResult) => {
    const baseExp = pokemon.baseExperience || 100;
    const levelDiff = Math.max(0, battleResult.opponentLevel - pokemon.level);
    const levelBonus = 1 + (levelDiff * 0.1); // 等级差加成
    
    // 稀有度加成
    const rarityMultiplier = {
      'common': 1.0,
      'uncommon': 1.2,
      'rare': 1.5,
      'epic': 2.0,
      'legendary': 3.0
    };
    
    return Math.floor(baseExp * levelBonus * rarityMultiplier[pokemon.rarity]);
  },

  // 连击加成计算
  calculateComboBonus: (comboCount) => {
    if (comboCount < 5) return 1.0;
    if (comboCount < 10) return 1.1;
    if (comboCount < 20) return 1.25;
    return Math.min(1.5, 1 + (comboCount * 0.01));
  },

  // 最终经验计算
  calculateFinalExperience: (baseExp, context) => {
    let multiplier = 1.0;
    
    // 活动加成
    if (context.eventActive) {
      multiplier *= context.eventMultiplier || 1.5;
    }
    
    // 道具加成
    if (context.hasLuckyEgg) {
      multiplier *= 2.0;
    }
    
    // VIP加成
    if (context.isVIP) {
      multiplier *= 1.25;
    }
    
    // 公会BUFF
    if (context.guildBuff) {
      multiplier *= context.guildBuffMultiplier || 1.1;
    }
    
    return Math.floor(baseExp * multiplier);
  }
};
```

### 2. 数据库迁移（database/migrations/xxx_add_experience_system.sql）

```sql
-- 经验加成道具表
CREATE TABLE experience_items (
  id SERIAL PRIMARY KEY,
  item_id VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL, -- 'candy', 'card', 'transfer'
  experience_value INTEGER DEFAULT 0,
  multiplier DECIMAL(3,2) DEFAULT 1.0,
  duration_hours INTEGER DEFAULT 0,
  rarity VARCHAR(20) DEFAULT 'common',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户经验道具使用记录
CREATE TABLE user_experience_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id VARCHAR(50) NOT NULL,
  quantity INTEGER DEFAULT 1,
  expires_at TIMESTAMP,
  used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 经验获取日志
CREATE TABLE experience_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_id INTEGER REFERENCES pokemon(id),
  source VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'item', 'event'
  base_experience INTEGER NOT NULL,
  final_experience INTEGER NOT NULL,
  multiplier DECIMAL(5,2) DEFAULT 1.0,
  combo_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_experience_logs_user ON experience_logs(user_id, created_at);
CREATE INDEX idx_experience_logs_pokemon ON experience_logs(pokemon_id);
CREATE INDEX idx_user_exp_items_user ON user_experience_items(user_id);
```

### 3. 经验加速服务（pokemon-service/src/services/experienceService.js）

```javascript
const ExperienceService = {
  // 应用经验加成道具
  applyExperienceItem: async (userId, itemId, pokemonId = null) => {
    const item = await db.getItem(itemId);
    const user = await db.getUser(userId);
    
    if (item.type === 'candy') {
      // 直接经验值
      await db.addExperienceToPokemon(pokemonId, item.experience_value);
      return { success: true, experience: item.experience_value };
    }
    
    if (item.type === 'card') {
      // 时间限制加成
      const expiresAt = new Date(Date.now() + item.duration_hours * 3600000);
      await db.createUserExperienceItem(userId, itemId, expiresAt);
      return { success: true, expiresAt };
    }
    
    return { success: false, error: 'Unknown item type' };
  },

  // 获取用户当前经验加成
  getActiveBuffs: async (userId) => {
    const buffs = [];
    
    // 检查道具BUFF
    const activeItems = await db.getActiveExperienceItems(userId);
    for (const item of activeItems) {
      buffs.push({
        type: 'item',
        source: item.name,
        multiplier: item.multiplier,
        expiresAt: item.expires_at
      });
    }
    
    // 检查活动BUFF
    const activeEvent = await db.getActiveExperienceEvent();
    if (activeEvent) {
      buffs.push({
        type: 'event',
        source: activeEvent.name,
        multiplier: activeEvent.multiplier,
        endsAt: activeEvent.ends_at
      });
    }
    
    // 检查VIP
    const user = await db.getUser(userId);
    if (user.isVIP) {
      buffs.push({
        type: 'vip',
        source: 'VIP Status',
        multiplier: 1.25,
        permanent: true
      });
    }
    
    return buffs;
  },

  // 经验获取日志记录
  logExperienceGain: async (userId, pokemonId, source, baseExp, finalExp, multiplier, comboCount) => {
    await db.insertExperienceLog({
      user_id: userId,
      pokemon_id: pokemonId,
      source,
      base_experience: baseExp,
      final_experience: finalExp,
      multiplier,
      combo_count: comboCount
    });
  }
};
```

### 4. API 路由（pokemon-service/src/routes/experience.js）

```javascript
const express = require('express');
const router = express.Router();
const ExperienceService = require('../services/experienceService');
const authMiddleware = require('../../../shared/middleware/auth');

// 获取当前经验加成状态
router.get('/buffs', authMiddleware, async (req, res) => {
  const buffs = await ExperienceService.getActiveBuffs(req.user.id);
  res.json({ success: true, data: buffs });
});

// 使用经验道具
router.post('/use-item', authMiddleware, async (req, res) => {
  const { itemId, pokemonId } = req.body;
  const result = await ExperienceService.applyExperienceItem(req.user.id, itemId, pokemonId);
  res.json(result);
});

// 获取经验统计
router.get('/stats', authMiddleware, async (req, res) => {
  const stats = await ExperienceService.getExperienceStats(req.user.id);
  res.json({ success: true, data: stats });
});

// 经验转移
router.post('/transfer', authMiddleware, async (req, res) => {
  const { fromPokemonId, toPokemonId, percentage } = req.body;
  const result = await ExperienceService.transferExperience(
    req.user.id, 
    fromPokemonId, 
    toPokemonId, 
    percentage
  );
  res.json(result);
});

module.exports = router;
```

### 5. 前端经验显示组件（game-client/src/components/ExperienceDisplay.js）

```javascript
import React, { useState, useEffect } from 'react';

const ExperienceDisplay = ({ pokemon, experienceGain, buffs }) => {
  const [animation, setAnimation] = useState(false);
  
  useEffect(() => {
    if (experienceGain > 0) {
      setAnimation(true);
      const timer = setTimeout(() => setAnimation(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [experienceGain]);

  return (
    <div className="experience-display">
      <div className="current-exp">
        <span className="level">Lv.{pokemon.level}</span>
        <div className="exp-bar">
          <div 
            className="exp-fill" 
            style={{ width: `${(pokemon.currentExp / pokemon.nextLevelExp) * 100}%` }}
          />
        </div>
        <span className="exp-text">
          {pokemon.currentExp.toLocaleString()} / {pokemon.nextLevelExp.toLocaleString()}
        </span>
      </div>
      
      {animation && experienceGain > 0 && (
        <div className="experience-gain-animation">
          <span className="exp-number">+{experienceGain.toLocaleString()} EXP</span>
          {buffs.length > 0 && (
            <div className="active-buffs">
              {buffs.map((buff, idx) => (
                <span key={idx} className="buff-badge">
                  {buff.source} x{buff.multiplier}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ExperienceDisplay;
```

## 验收标准

- [ ] 精灵捕捉时正确计算基础经验值，考虑等级差和稀有度
- [ ] 连击系统正确累积并提供经验加成
- [ ] 经验道具（糖果/经验卡）可正常使用，效果符合预期
- [ ] 活动期间全局经验加成正常生效
- [ ] VIP用户经验加成正确应用
- [ ] 公会BUFF与个人BUFF可叠加计算
- [ ] 经验获取日志完整记录来源和倍率
- [ ] 前端正确显示经验条、获取动画和加成信息
- [ ] 经验统计API返回准确的日/周数据
- [ ] 经验转移功能正常工作，扣除和增加比例正确
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API集成测试通过

## 影响范围

- **新增文件**:
  - `backend/shared/ExperienceEngine.js`
  - `pokemon-service/src/services/experienceService.js`
  - `pokemon-service/src/routes/experience.js`
  - `game-client/src/components/ExperienceDisplay.js`
  
- **修改文件**:
  - `pokemon-service/src/index.js` - 挂载经验路由
  - `catch-service/src/controllers/catchController.js` - 集成经验计算
  - `gym-service/src/controllers/battleController.js` - 战斗经验计算
  - `reward-service/src/services/rewardService.js` - 经验道具发放
  - `game-client/src/game/CatchEngine.js` - 捕捉经验动画

- **数据库**:
  - 新增 `experience_items` 表
  - 新增 `user_experience_items` 表
  - 新增 `experience_logs` 表

## 参考

- [Pokemon GO 经验系统](https://pokemongohub.net/post/guide/experience/)
- [游戏经验值平衡设计](https://www.gamedeveloper.com/design/balancing-experience-systems)
- REQ-00019: 精灵技能学习与技能机器系统
- REQ-00065: 精灵进化与成长系统
- REQ-00079: 精灵好感度系统与亲密度进化机制
