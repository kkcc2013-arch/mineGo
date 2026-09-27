# REQ-00216: 精灵经验值动态调整与智能加速系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00216 |
| 标题 | 精灵经验值动态调整与智能加速系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
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

## 实现记录（2026-09-24）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 精灵捕捉时正确计算基础经验值，考虑等级差和稀有度 | ✅ | catch-service 捕捉事务内（保存点）给新精灵发放起始经验：100 × 等级差系数（对手取训练师等级，每级 +10%，≤×3）× 稀有度系数；捕捉响应带 `rewards.pokemonExp` 与最终等级/CP |
| 连击系统正确累积并提供经验加成 | ✅ | Redis 10 分钟连击计数；<5 ×1.0、<10 ×1.1、<25 ×1.25、之后每次 +1% 至 ×1.5（原稿公式在 20 次时从 1.25 跌到 1.2，已修正为单调） |
| 经验道具（糖果/经验卡）可正常使用，效果符合预期 | ✅ | 经验糖果 S/M/L（1000/5000/20000）；幸运蛋 30 分钟 ×2、经验卡 24 小时 ×1.5、永久经验卡 ×1.1（不可叠加）；道具走 player_inventory，可在成长商店用金币购买 |
| 活动期间全局经验加成正常生效 | ✅ | reward-service 的 `double_xp` 活动（status=active 且在时间内，event_config.xpMultiplier，默认 2） |
| VIP用户经验加成正确应用 | ✅ | `users.vip_level > 0` ×1.25（迁移新增 vip_level 列；设置 VIP 的入口不在本需求） |
| 公会BUFF与个人BUFF可叠加计算 | ✅ | 公会 `experience_bonus_*` BUFF（guild_buffs）与个人加成相乘；单测验证 12.375 倍组合 |
| 经验获取日志完整记录来源和倍率 | ✅ | pokemon_exp_history 记录来源、基础值、倍率、倍率明细、前后等级/经验、位置 |
| 前端正确显示经验条、获取动画和加成信息 | ⚠️ | 精灵页等级经验条、经验加成面板（倍率明细）、使用经验糖果提示；"获取动画"仅为提示与进度条过渡，未做独立动画 |
| 经验统计API返回准确的日/周数据 | ✅ | `GET /pokemon/experience/stats?period=day|week|month`：每日序列 + 来源占比 |
| 经验转移功能正常工作，扣除和增加比例正确 | ✅ | `POST /pokemon/:id/experience/transfer`：源扣全额、目标得 80%，固定加锁顺序防死锁 |
| 单元测试覆盖率 ≥ 80% | ⚠️ | `tests/unit/growth-experience.test.js` 覆盖曲线/上限/基础经验/连击/倍率/转移/预测；覆盖率未统计 |
| API集成测试通过 | ⚠️ | `scripts/smoke-growth.js experience`（早期在 CI 栈上 17 项通过，后续改动未再运行，待验证） |

- 入口：`backend/shared/ExperienceEngine.js`（纯计算）、`backend/shared/pokemonExperience.js`（统一入账：锁行、等级上限 2×训练师等级+10、升级按每级 +2% 缩放 CP/HP、写历史/统计/里程碑）；pokemon-service `routes/growth.js`；catch-service `handleCatch`；E11 战斗结算（来源 battle，`shared/growthBattle.js`）；训练营（来源 training_camp）
- 迁移：`database/migrations/20260925_100000__pokemon_growth_core.sql`（精灵 level 列、users.vip_level）、`20260925_110000__pokemon_experience_growth_tracking.sql`（经验历史/加成/道具）
- 测试：单测 `cd backend && node --test tests/unit/growth-*.test.js`（宿主机已运行：96 项含 E11 战斗单测全部通过）；冒烟 `BASE_URL=<网关> node scripts/smoke-growth.js experience battle`（经网关的集成冒烟，本批未运行，待验证）
- 待验证：捕捉经验与连击（需真实捕捉）、活动/公会加成叠加、经验转移
- 说明：原 `POST /pokemon/:id/experience`（任意加经验的调试接口）已删除。所有接口挂在 pokemon-service `/pokemon/*` 下，经网关 `/v1/pokemon/*`（authMiddleware JWT + 用户级限流）访问；`scripts/api-lint.js` 0 error、`scripts/contract-snapshot.js --check` 未审批 0。
