# REQ-00172: 精灵体力系统与疲劳度管理

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00172 |
| 标题 | 精灵体力系统与疲劳度管理 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gym-service、catch-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-13 22:30 |

## 需求描述

为精灵引入体力系统（Stamina/Fatigue），每只精灵拥有独立的体力值。战斗、捕捉、训练等活动会消耗体力，体力耗尽后精灵性能下降。玩家需要通过休息、道具或特殊设施恢复体力，增加游戏策略深度和资源管理维度。

### 核心功能
1. **体力属性系统**：每只精灵有最大体力值和当前体力值
2. **体力消耗机制**：不同活动消耗不同体力
3. **体力恢复机制**：自然恢复、道具恢复、设施恢复
4. **疲劳状态效果**：体力低时影响精灵性能
5. **体力可见性**：UI 显示体力条和状态

## 技术方案

### 1. 数据库设计

```sql
-- migrations/20260613_add_stamina_system.sql

-- 为 pokemon 表添加体力字段
ALTER TABLE pokemon 
ADD COLUMN max_stamina INTEGER DEFAULT 100,
ADD COLUMN current_stamina INTEGER DEFAULT 100,
ADD COLUMN last_stamina_update TIMESTAMP DEFAULT NOW(),
ADD COLUMN fatigue_level VARCHAR(20) DEFAULT 'fresh';

-- 创建体力恢复配置表
CREATE TABLE stamina_config (
  id SERIAL PRIMARY KEY,
  activity_type VARCHAR(50) NOT NULL,
  stamina_cost INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认配置
INSERT INTO stamina_config (activity_type, stamina_cost, description) VALUES
('battle_turn', 5, '每次战斗回合消耗'),
('gym_battle', 20, '道馆战斗消耗'),
('catch_attempt', 10, '捕捉尝试消耗'),
('training', 15, '训练消耗'),
('exploration', 2, '探索消耗');

-- 创建体力恢复道具配置
CREATE TABLE stamina_recovery_items (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES inventory_items(id),
  stamina_amount INTEGER NOT NULL,
  cooldown_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建精灵休息站表
CREATE TABLE rest_stations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  location_geohash VARCHAR(12),
  recovery_rate INTEGER DEFAULT 5, -- 每分钟恢复点数
  capacity INTEGER DEFAULT 10,
  current_users INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建休息记录表
CREATE TABLE rest_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  pokemon_id INTEGER REFERENCES pokemon(id),
  station_id INTEGER REFERENCES rest_stations(id),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  stamina_recovered INTEGER DEFAULT 0
);

-- 创建索引
CREATE INDEX idx_pokemon_stamina ON pokemon(user_id, current_stamina);
CREATE INDEX idx_stamina_update ON pokemon(last_stamina_update);
CREATE INDEX idx_rest_stations_location ON rest_stations(location_geohash);
```

### 2. 体力服务实现

```javascript
// backend/services/pokemon-service/src/staminaService.js

const { db } = require('../db/connection');
const { logger } = require('../../../shared/logger');
const { cache } = require('../../../shared/cache');

class StaminaService {
  constructor() {
    // 疲劳等级阈值
    this.fatigueLevels = {
      fresh: { min: 80, battleBonus: 1.0, catchBonus: 1.0 },
      normal: { min: 50, battleBonus: 1.0, catchBonus: 1.0 },
      tired: { min: 20, battleBonus: 0.85, catchBonus: 0.9 },
      exhausted: { min: 0, battleBonus: 0.6, catchBonus: 0.7 }
    };
    
    // 自然恢复速率（每分钟）
    this.naturalRecoveryRate = 1;
  }

  /**
   * 获取精灵当前体力状态
   */
  async getStaminaStatus(pokemonId, userId) {
    const cacheKey = `stamina:${pokemonId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const pokemon = await db('pokemon')
      .where({ id: pokemonId, user_id: userId })
      .first();

    if (!pokemon) {
      throw new Error('Pokemon not found');
    }

    // 计算自然恢复
    const now = new Date();
    const lastUpdate = new Date(pokemon.last_stamina_update);
    const minutesPassed = Math.floor((now - lastUpdate) / 60000);
    
    let recoveredStamina = 0;
    if (minutesPassed > 0 && pokemon.current_stamina < pokemon.max_stamina) {
      recoveredStamina = Math.min(
        minutesPassed * this.naturalRecoveryRate,
        pokemon.max_stamina - pokemon.current_stamina
      );
      
      // 更新数据库
      await this.updateStamina(pokemonId, recoveredStamina, true);
    }

    const status = {
      maxStamina: pokemon.max_stamina,
      currentStamina: pokemon.current_stamina + recoveredStamina,
      fatigueLevel: this.calculateFatigueLevel(pokemon.current_stamina + recoveredStamina, pokemon.max_stamina),
      lastUpdate: now.toISOString(),
      recoveryRate: this.naturalRecoveryRate
    };

    // 缓存 30 秒
    await cache.set(cacheKey, status, 30);
    return status;
  }

  /**
   * 消耗体力
   */
  async consumeStamina(pokemonId, activityType, userId) {
    // 获取活动消耗配置
    const config = await db('stamina_config')
      .where({ activity_type: activityType })
      .first();

    if (!config) {
      logger.warn(`Unknown activity type: ${activityType}`);
      return { success: true, staminaConsumed: 0 };
    }

    const status = await this.getStaminaStatus(pokemonId, userId);
    
    if (status.currentStamina < config.stamina_cost) {
      throw new Error('Insufficient stamina');
    }

    const newStamina = status.currentStamina - config.stamina_cost;
    const newFatigueLevel = this.calculateFatigueLevel(newStamina, status.maxStamina);

    await db('pokemon')
      .where({ id: pokemonId })
      .update({
        current_stamina: newStamina,
        fatigue_level: newFatigueLevel,
        last_stamina_update: new Date()
      });

    // 清除缓存
    await cache.del(`stamina:${pokemonId}`);

    logger.info('Stamina consumed', {
      pokemonId,
      activityType,
      staminaConsumed: config.stamina_cost,
      remainingStamina: newStamina,
      fatigueLevel: newFatigueLevel
    });

    return {
      success: true,
      staminaConsumed: config.stamina_cost,
      remainingStamina: newStamina,
      fatigueLevel: newFatigueLevel
    };
  }

  /**
   * 恢复体力（道具/设施）
   */
  async recoverStamina(pokemonId, amount, source, userId) {
    const pokemon = await db('pokemon')
      .where({ id: pokemonId, user_id: userId })
      .first();

    if (!pokemon) {
      throw new Error('Pokemon not found');
    }

    const newStamina = Math.min(pokemon.current_stamina + amount, pokemon.max_stamina);
    const newFatigueLevel = this.calculateFatigueLevel(newStamina, pokemon.max_stamina);

    await db('pokemon')
      .where({ id: pokemonId })
      .update({
        current_stamina: newStamina,
        fatigue_level: newFatigueLevel,
        last_stamina_update: new Date()
      });

    // 清除缓存
    await cache.del(`stamina:${pokemonId}`);

    logger.info('Stamina recovered', {
      pokemonId,
      amount,
      source,
      newStamina,
      fatigueLevel: newFatigueLevel
    });

    return {
      success: true,
      staminaRecovered: amount,
      currentStamina: newStamina,
      fatigueLevel: newFatigueLevel
    };
  }

  /**
   * 在休息站休息
   */
  async restAtStation(pokemonId, stationId, userId) {
    const station = await db('rest_stations')
      .where({ id: stationId, is_active: true })
      .first();

    if (!station) {
      throw new Error('Rest station not found or inactive');
    }

    if (station.current_users >= station.capacity) {
      throw new Error('Rest station is at full capacity');
    }

    // 增加当前使用人数
    await db('rest_stations')
      .where({ id: stationId })
      .increment('current_users', 1);

    // 创建休息记录
    const [record] = await db('rest_records')
      .insert({
        user_id: userId,
        pokemon_id: pokemonId,
        station_id: stationId,
        started_at: new Date()
      })
      .returning('*');

    return {
      success: true,
      recordId: record.id,
      recoveryRate: station.recovery_rate,
      message: 'Pokemon started resting at station'
    };
  }

  /**
   * 结束休息
   */
  async endRest(recordId, userId) {
    const record = await db('rest_records')
      .where({ id: recordId, user_id: userId })
      .first();

    if (!record || record.ended_at) {
      throw new Error('Invalid rest record');
    }

    const now = new Date();
    const minutesRested = Math.floor((now - new Date(record.started_at)) / 60000);
    
    const station = await db('rest_stations')
      .where({ id: record.station_id })
      .first();

    const staminaRecovered = minutesRested * station.recovery_rate;

    // 更新记录
    await db('rest_records')
      .where({ id: recordId })
      .update({
        ended_at: now,
        stamina_recovered: staminaRecovered
      });

    // 恢复体力
    await this.recoverStamina(record.pokemon_id, staminaRecovered, 'rest_station', userId);

    // 减少当前使用人数
    await db('rest_stations')
      .where({ id: record.station_id })
      .decrement('current_users', 1);

    return {
      success: true,
      minutesRested,
      staminaRecovered
    };
  }

  /**
   * 计算疲劳等级
   */
  calculateFatigueLevel(currentStamina, maxStamina) {
    const percentage = (currentStamina / maxStamina) * 100;
    
    if (percentage >= 80) return 'fresh';
    if (percentage >= 50) return 'normal';
    if (percentage >= 20) return 'tired';
    return 'exhausted';
  }

  /**
   * 获取疲劳状态效果
   */
  getFatigueEffects(fatigueLevel) {
    return this.fatigueLevels[fatigueLevel] || this.fatigueLevels.normal;
  }

  /**
   * 更新体力（内部方法）
   */
  async updateStamina(pokemonId, amount, isNaturalRecovery = false) {
    const pokemon = await db('pokemon').where({ id: pokemonId }).first();
    
    const newStamina = Math.min(
      pokemon.current_stamina + amount,
      pokemon.max_stamina
    );

    await db('pokemon')
      .where({ id: pokemonId })
      .update({
        current_stamina: newStamina,
        fatigue_level: this.calculateFatigueLevel(newStamina, pokemon.max_stamina),
        last_stamina_update: new Date()
      });
  }
}

module.exports = new StaminaService();
```

### 3. API 路由

```javascript
// backend/services/pokemon-service/src/routes/stamina.js

const express = require('express');
const router = express.Router();
const staminaService = require('../staminaService');
const { auth } = require('../../../shared/auth');

/**
 * GET /pokemon/:id/stamina
 * 获取精灵体力状态
 */
router.get('/:id/stamina', auth.requireAuth, async (req, res) => {
  try {
    const status = await staminaService.getStaminaStatus(
      req.params.id,
      req.user.id
    );
    res.json(status);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/consume
 * 消耗体力
 */
router.post('/:id/stamina/consume', auth.requireAuth, async (req, res) => {
  try {
    const { activityType } = req.body;
    const result = await staminaService.consumeStamina(
      req.params.id,
      activityType,
      req.user.id
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/recover
 * 恢复体力
 */
router.post('/:id/stamina/recover', auth.requireAuth, async (req, res) => {
  try {
    const { amount, source } = req.body;
    const result = await staminaService.recoverStamina(
      req.params.id,
      amount,
      source,
      req.user.id
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /stamina/rest-station/:stationId/rest
 * 在休息站休息
 */
router.post('/rest-station/:stationId/rest', auth.requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.body;
    const result = await staminaService.restAtStation(
      pokemonId,
      req.params.stationId,
      req.user.id
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /stamina/rest/:recordId/end
 * 结束休息
 */
router.post('/rest/:recordId/end', auth.requireAuth, async (req, res) => {
  try {
    const result = await staminaService.endRest(req.params.recordId, req.user.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /stamina/rest-stations
 * 获取附近的休息站
 */
router.get('/rest-stations', auth.requireAuth, async (req, res) => {
  try {
    const { geohash, radius = 1000 } = req.query;
    const stations = await db('rest_stations')
      .whereRaw('ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?)', [
        /* lat, lng from geohash */, radius
      ])
      .where({ is_active: true });
    res.json(stations);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
```

### 4. 战斗系统集成

```javascript
// 在 battleEngine.js 中集成体力系统

const staminaService = require('./staminaService');

class BattleEngine {
  async executeTurn(battleId, attackerPokemonId, moveId, userId) {
    // 获取疲劳效果
    const staminaStatus = await staminaService.getStaminaStatus(attackerPokemonId, userId);
    const fatigueEffects = staminaService.getFatigueEffects(staminaStatus.fatigueLevel);
    
    // 消耗体力
    await staminaService.consumeStamina(attackerPokemonId, 'battle_turn', userId);
    
    // 应用疲劳效果到伤害计算
    const baseDamage = await this.calculateDamage(moveId, attackerPokemonId);
    const adjustedDamage = Math.floor(baseDamage * fatigueEffects.battleBonus);
    
    return {
      damage: adjustedDamage,
      fatigueApplied: staminaStatus.fatigueLevel !== 'fresh' && staminaStatus.fatigueLevel !== 'normal',
      fatigueLevel: staminaStatus.fatigueLevel
    };
  }
}
```

### 5. 前端 UI 组件

```javascript
// game-client/src/components/StaminaBar.js

import React from 'react';

const StaminaBar = ({ current, max, fatigueLevel }) => {
  const percentage = (current / max) * 100;
  
  const getBarColor = () => {
    switch (fatigueLevel) {
      case 'fresh': return '#4CAF50';
      case 'normal': return '#8BC34A';
      case 'tired': return '#FF9800';
      case 'exhausted': return '#F44336';
      default: return '#2196F3';
    }
  };

  return (
    <div className="stamina-bar-container">
      <div className="stamina-label">
        <span className="stamina-icon">⚡</span>
        <span className="stamina-text">{current}/{max}</span>
      </div>
      <div className="stamina-bar">
        <div 
          className="stamina-fill"
          style={{ 
            width: `${percentage}%`,
            backgroundColor: getBarColor()
          }}
        />
      </div>
      <div className={`fatigue-status ${fatigueLevel}`}>
        {getFatigueLabel(fatigueLevel)}
      </div>
    </div>
  );
};

function getFatigueLabel(level) {
  const labels = {
    fresh: '精力充沛',
    normal: '状态正常',
    tired: '有些疲惫',
    exhausted: '精疲力竭'
  };
  return labels[level] || '未知';
}

export default StaminaBar;
```

### 6. 定时任务 - 自然恢复处理

```javascript
// backend/jobs/staminaRecoveryJob.js

const { db } = require('../db/connection');
const { logger } = require('../../shared/logger');

class StaminaRecoveryJob {
  /**
   * 每分钟执行一次，处理自然恢复
   */
  async run() {
    logger.info('Running stamina recovery job');
    
    // 批量更新所有未满体力的精灵
    const result = await db.raw(`
      UPDATE pokemon 
      SET 
        current_stamina = LEAST(current_stamina + 1, max_stamina),
        fatigue_level = CASE
          WHEN (current_stamina + 1.0) / max_stamina >= 0.8 THEN 'fresh'
          WHEN (current_stamina + 1.0) / max_stamina >= 0.5 THEN 'normal'
          WHEN (current_stamina + 1.0) / max_stamina >= 0.2 THEN 'tired'
          ELSE 'exhausted'
        END,
        last_stamina_update = NOW()
      WHERE current_stamina < max_stamina
    `);
    
    logger.info(`Stamina recovery completed`, { rowsAffected: result.rowCount });
    
    // 处理休息站恢复
    await this.processRestStationRecovery();
  }

  async processRestStationRecovery() {
    const activeRests = await db('rest_records')
      .whereNull('ended_at')
      .join('rest_stations', 'rest_records.station_id', 'rest_stations.id');

    for (const rest of activeRests) {
      const minutesSinceStart = Math.floor(
        (Date.now() - new Date(rest.started_at)) / 60000
      );
      
      const staminaToRecover = minutesSinceStart * rest.recovery_rate;
      
      await db('pokemon')
        .where({ id: rest.pokemon_id })
        .update({
          current_stamina: db.raw(`LEAST(current_stamina + ?, max_stamina)`, [staminaToRecover])
        });
    }
  }
}

module.exports = new StaminaRecoveryJob();
```

## 验收标准

- [ ] 数据库迁移成功，包含所有体力相关表和字段
- [ ] 体力服务核心功能：查询、消耗、恢复、休息站功能正常
- [ ] 疲劳等级正确计算（fresh/normal/tired/exhausted）
- [ ] 战斗系统集成体力消耗，疲劳状态影响战斗性能
- [ ] 自然恢复定时任务正常执行
- [ ] 前端 UI 正确显示体力条和疲劳状态
- [ ] API 接口有适当的权限验证
- [ ] 单元测试覆盖核心业务逻辑
- [ ] 性能：批量查询精灵体力时响应时间 < 100ms

## 影响范围

- **数据库**：新增 stamina_config、stamina_recovery_items、rest_stations、rest_records 表
- **pokemon-service**：新增 staminaService.js 和 routes/stamina.js
- **gym-service**：battleEngine.js 集成体力消耗逻辑
- **catch-service**：捕捉尝试消耗体力
- **game-client**：新增 StaminaBar 组件和相关 UI
- **定时任务**：新增 staminaRecoveryJob.js

## 参考

- 类似游戏：Pokemon GO 的 CP 系统、精灵宝可梦原作中的 PP 系统
- 设计模式：状态机模式处理疲劳状态转换
