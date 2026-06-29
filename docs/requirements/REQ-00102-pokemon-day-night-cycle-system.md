# REQ-00102: 精灵昼夜循环系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00102 |
| 标题 | 精灵昼夜循环系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | location-service、catch-service、pokemon-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 04:00 |

## 需求描述

实现完整的游戏内昼夜循环系统，使不同精灵在不同时间段出现，增加游戏的策略性和真实感。该系统需要：

1. **全球同步时间系统**：基于 UTC 时间，结合玩家所在时区显示本地时间
2. **昼夜时段划分**：将一天划分为多个时段（黎明、白天、黄昏、夜晚、深夜）
3. **精灵刷新时段限制**：某些精灵只在特定时段出现（如：鬼斯通仅在夜晚出现，太阳精灵仅在白天活跃）
4. **时段属性加成**：特定属性精灵在对应时段获得能力加成（如火系白天增强，幽灵系夜晚增强）
5. **视觉效果切换**：游戏界面根据时段自动切换光照和氛围效果
6. **时段活动触发**：特定时段触发特殊事件或活动

### 业务价值
- 提升游戏真实感和沉浸感
- 增加游戏策略深度（玩家需规划不同时间段上线）
- 促进不同时段的玩家活跃度分布
- 为未来扩展（季节系统、特殊天象）打下基础

## 技术方案

### 1. 数据库设计与迁移

**文件**: `database/pending/20260611_040000__add_day_night_cycle_system.sql`

```sql
-- 时段定义表
CREATE TABLE time_periods (
    id VARCHAR(20) PRIMARY KEY,  -- dawn, day, dusk, night, late_night
    name_i18n JSONB NOT NULL,     -- {"en": "Dawn", "zh": "黎明", "ja": "夜明け"}
    start_hour SMALLINT NOT NULL, -- 0-23
    end_hour SMALLINT NOT NULL,   -- 0-23
    light_level DECIMAL(3,2) NOT NULL, -- 0.0-1.0 光照强度
    background_tint VARCHAR(7),   -- 十六进制颜色值
    atmosphere JSONB,             -- {"fog": 0.2, "stars": true}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 精灵时段刷新配置表
CREATE TABLE pokemon_time_spawn_config (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER REFERENCES pokemon(id),
    time_period_id VARCHAR(20) REFERENCES time_periods(id),
    spawn_multiplier DECIMAL(4,2) DEFAULT 1.0, -- 出现倍率
    is_exclusive BOOLEAN DEFAULT FALSE,        -- 是否仅此时段出现
    active_months BIT(12),                     -- 月份限制（可选）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_id, time_period_id)
);

-- 属性时段加成表
CREATE TABLE type_time_bonus (
    id SERIAL PRIMARY KEY,
    pokemon_type VARCHAR(20) NOT NULL, -- fire, water, ghost, etc.
    time_period_id VARCHAR(20) REFERENCES time_periods(id),
    stat_bonus JSONB NOT NULL,         -- {"attack": 1.1, "defense": 1.05}
    experience_bonus DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_type, time_period_id)
);

-- 时段特殊活动表
CREATE TABLE time_period_events (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES events(id),
    time_period_id VARCHAR(20) REFERENCES time_periods(id),
    bonus_multiplier DECIMAL(4,2) DEFAULT 1.0,
    special_pokemon_ids INTEGER[],     -- 特殊精灵ID列表
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家时段活动统计表
CREATE TABLE player_time_activity_stats (
    user_id INTEGER REFERENCES users(id) PRIMARY KEY,
    dawn_catches INTEGER DEFAULT 0,
    day_catches INTEGER DEFAULT 0,
    dusk_catches INTEGER DEFAULT 0,
    night_catches INTEGER DEFAULT 0,
    late_night_catches INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 初始时段数据
INSERT INTO time_periods (id, name_i18n, start_hour, end_hour, light_level, background_tint, atmosphere) VALUES
('dawn', '{"en": "Dawn", "zh": "黎明", "ja": "夜明け"}', 5, 7, 0.6, '#FFE4B5', '{"fog": 0.3}'),
('day', '{"en": "Day", "zh": "白天", "ja": "昼"}', 7, 17, 1.0, '#87CEEB', '{}'),
('dusk', '{"en": "Dusk", "zh": "黄昏", "ja": "夕暮れ"}', 17, 19, 0.5, '#FF8C00', '{"fog": 0.2, "sunset": true}'),
('night', '{"en": "Night", "zh": "夜晚", "ja": "夜"}', 19, 23, 0.2, '#191970', '{"stars": true, "moon": true}'),
('late_night', '{"en": "Late Night", "zh": "深夜", "ja": "深夜"}', 23, 5, 0.1, '#0C0C1E', '{"stars": true}');

-- 创建索引
CREATE INDEX idx_pokemon_time_spawn ON pokemon_time_spawn_config(pokemon_id);
CREATE INDEX idx_type_time_bonus ON type_time_bonus(pokemon_type, time_period_id);
CREATE INDEX idx_time_event ON time_period_events(time_period_id);
```

### 2. 时段管理服务

**文件**: `backend/shared/TimePeriodManager.js`

```javascript
'use strict';

const { getJSON, setJSON } = require('./redis');
const { query } = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('time-period-manager');

/**
 * 时段管理器 - 管理游戏内昼夜循环系统
 */
class TimePeriodManager {
  constructor() {
    this.cachePrefix = 'time_period:';
    this.cacheTTL = 3600; // 1小时缓存
    this.timePeriods = null;
  }

  /**
   * 获取当前时段（基于 UTC 时间）
   * @param {string} timezone - 用户时区（可选，用于显示）
   * @returns {Object} 时段信息
   */
  async getCurrentPeriod(timezone = 'UTC') {
    const cacheKey = `${this.cachePrefix}current`;
    
    // 尝试从缓存获取
    const cached = await getJSON(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return this.addLocalTime(cached, timezone);
    }

    // 从数据库获取
    await this.loadTimePeriods();
    const now = new Date();
    const utcHour = now.getUTCHours();
    
    const period = this.findPeriodByHour(utcHour);
    const result = {
      ...period,
      utc_hour: utcHour,
      utc_time: now.toISOString(),
      next_period: this.getNextPeriod(utcHour),
      time_until_next: this.getTimeUntilNext(utcHour)
    };

    // 缓存结果
    await setJSON(cacheKey, result, this.cacheTTL);
    
    return this.addLocalTime(result, timezone);
  }

  /**
   * 根据小时查找时段
   */
  findPeriodByHour(hour) {
    if (!this.timePeriods) return null;
    
    for (const period of this.timePeriods) {
      // 处理跨午夜的情况（如 late_night: 23-5）
      if (period.start_hour > period.end_hour) {
        if (hour >= period.start_hour || hour < period.end_hour) {
          return period;
        }
      } else {
        if (hour >= period.start_hour && hour < period.end_hour) {
          return period;
        }
      }
    }
    
    // 默认返回白天
    return this.timePeriods.find(p => p.id === 'day');
  }

  /**
   * 获取下一个时段
   */
  getNextPeriod(currentHour) {
    if (!this.timePeriods) return null;
    
    const sortedPeriods = [...this.timePeriods].sort((a, b) => a.start_hour - b.start_hour);
    
    for (let i = 0; i < sortedPeriods.length; i++) {
      const nextIndex = (i + 1) % sortedPeriods.length;
      if (sortedPeriods[i].id === this.findPeriodByHour(currentHour)?.id) {
        return sortedPeriods[nextIndex];
      }
    }
    
    return sortedPeriods[0];
  }

  /**
   * 计算到下一个时段的时间
   */
  getTimeUntilNext(currentHour) {
    const nextPeriod = this.getNextPeriod(currentHour);
    if (!nextPeriod) return 0;
    
    let hoursUntil = nextPeriod.start_hour - currentHour;
    if (hoursUntil <= 0) hoursUntil += 24;
    
    const now = new Date();
    const minutesUntil = (60 - now.getUTCMinutes()) % 60;
    
    return {
      hours: hoursUntil - (minutesUntil > 0 ? 0 : 1),
      minutes: minutesUntil,
      total_minutes: hoursUntil * 60 - (60 - minutesUntil)
    };
  }

  /**
   * 加载时段配置
   */
  async loadTimePeriods() {
    if (this.timePeriods) return this.timePeriods;
    
    try {
      const result = await query(
        'SELECT * FROM time_periods ORDER BY start_hour'
      );
      this.timePeriods = result.rows;
      return this.timePeriods;
    } catch (error) {
      logger.error({ error }, 'Failed to load time periods');
      throw error;
    }
  }

  /**
   * 获取精灵在特定时段的刷新倍率
   */
  async getPokemonSpawnMultiplier(pokemonId, periodId) {
    const cacheKey = `${this.cachePrefix}spawn:${pokemonId}:${periodId}`;
    
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
    
    try {
      const result = await query(
        'SELECT spawn_multiplier, is_exclusive FROM pokemon_time_spawn_config WHERE pokemon_id = $1 AND time_period_id = $2',
        [pokemonId, periodId]
      );
      
      if (result.rows.length === 0) {
        // 默认全天出现
        const defaultConfig = { spawn_multiplier: 1.0, is_exclusive: false };
        await setJSON(cacheKey, defaultConfig, this.cacheTTL);
        return defaultConfig;
      }
      
      await setJSON(cacheKey, result.rows[0], this.cacheTTL);
      return result.rows[0];
    } catch (error) {
      logger.error({ error, pokemonId, periodId }, 'Failed to get spawn multiplier');
      return { spawn_multiplier: 1.0, is_exclusive: false };
    }
  }

  /**
   * 获取特定时段的属性加成
   */
  async getTypeBonus(pokemonType, periodId) {
    const cacheKey = `${this.cachePrefix}bonus:${pokemonType}:${periodId}`;
    
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
    
    try {
      const result = await query(
        'SELECT stat_bonus, experience_bonus FROM type_time_bonus WHERE pokemon_type = $1 AND time_period_id = $2',
        [pokemonType, periodId]
      );
      
      if (result.rows.length === 0) {
        const defaultBonus = { stat_bonus: {}, experience_bonus: 1.0 };
        await setJSON(cacheKey, defaultBonus, this.cacheTTL);
        return defaultBonus;
      }
      
      await setJSON(cacheKey, result.rows[0], this.cacheTTL);
      return result.rows[0];
    } catch (error) {
      logger.error({ error, pokemonType, periodId }, 'Failed to get type bonus');
      return { stat_bonus: {}, experience_bonus: 1.0 };
    }
  }

  /**
   * 获取时段特殊精灵列表
   */
  async getPeriodSpecialPokemon(periodId) {
    const cacheKey = `${this.cachePrefix}special:${periodId}`;
    
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
    
    try {
      const result = await query(
        `SELECT pokemon_id, spawn_multiplier 
         FROM pokemon_time_spawn_config 
         WHERE time_period_id = $1 AND (is_exclusive = true OR spawn_multiplier > 1.5)
         ORDER BY spawn_multiplier DESC`,
        [periodId]
      );
      
      await setJSON(cacheKey, result.rows, this.cacheTTL);
      return result.rows;
    } catch (error) {
      logger.error({ error, periodId }, 'Failed to get period special pokemon');
      return [];
    }
  }

  /**
   * 添加本地时间信息
   */
  addLocalTime(periodData, timezone) {
    if (!periodData) return periodData;
    
    try {
      const now = new Date();
      const localTime = now.toLocaleString('en-US', { timeZone: timezone });
      const localHour = parseInt(localTime.split(' ')[1].split(':')[0]);
      
      return {
        ...periodData,
        local_hour: localHour,
        local_time: localTime,
        timezone: timezone
      };
    } catch (error) {
      logger.warn({ error, timezone }, 'Failed to convert to local time');
      return periodData;
    }
  }

  /**
   * 验证缓存是否有效
   */
  isCacheValid(cached) {
    if (!cached || !cached.utc_time) return false;
    
    const cacheTime = new Date(cached.utc_time);
    const now = new Date();
    const diffMinutes = (now - cacheTime) / (1000 * 60);
    
    // 缓存有效期 30 分钟
    return diffMinutes < 30;
  }

  /**
   * 更新玩家时段活动统计
   */
  async updatePlayerTimeActivity(userId, periodId) {
    try {
      const columnMap = {
        'dawn': 'dawn_catches',
        'day': 'day_catches',
        'dusk': 'dusk_catches',
        'night': 'night_catches',
        'late_night': 'late_night_catches'
      };
      
      const column = columnMap[periodId];
      if (!column) return;
      
      await query(
        `INSERT INTO player_time_activity_stats (user_id, ${column}) 
         VALUES ($1, 1) 
         ON CONFLICT (user_id) 
         DO UPDATE SET ${column} = player_time_activity_stats.${column} + 1, last_updated = CURRENT_TIMESTAMP`,
        [userId]
      );
    } catch (error) {
      logger.error({ error, userId, periodId }, 'Failed to update player time activity');
    }
  }
}

// 导出单例
module.exports = new TimePeriodManager();
```

### 3. Catch Service 集成

**文件**: `backend/services/catch-service/src/timeSpawnFilter.js`

```javascript
'use strict';

const timePeriodManager = require('../../../shared/TimePeriodManager');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('time-spawn-filter');

/**
 * 精灵时段刷新过滤器
 */
class TimeSpawnFilter {
  /**
   * 根据当前时段过滤可用精灵
   * @param {Array} pokemonList - 候选精灵列表
   * @param {string} periodId - 时段ID
   * @returns {Array} 过滤后的精灵列表（含刷新权重）
   */
  async filterByPeriod(pokemonList, periodId) {
    if (!pokemonList || pokemonList.length === 0) return [];
    
    const filteredList = [];
    
    for (const pokemon of pokemonList) {
      const spawnConfig = await timePeriodManager.getPokemonSpawnMultiplier(
        pokemon.id, 
        periodId
      );
      
      // 如果是独占精灵，检查是否在正确时段
      if (spawnConfig.is_exclusive) {
        filteredList.push({
          ...pokemon,
          spawn_weight: pokemon.spawn_weight * spawnConfig.spawn_multiplier,
          is_period_exclusive: true
        });
      } else {
        // 非独占精灵，应用刷新倍率
        const adjustedWeight = pokemon.spawn_weight * spawnConfig.spawn_multiplier;
        
        if (adjustedWeight > 0) {
          filteredList.push({
            ...pokemon,
            spawn_weight: adjustedWeight,
            is_period_exclusive: false
          });
        }
      }
    }
    
    logger.debug({ 
      periodId, 
      input: pokemonList.length, 
      output: filteredList.length 
    }, 'Filtered pokemon by time period');
    
    return filteredList;
  }

  /**
   * 为精灵列表添加时段属性加成
   */
  async applyTimeBonuses(pokemon, periodId) {
    if (!pokemon || !pokemon.types) return pokemon;
    
    let attackBonus = 1.0;
    let defenseBonus = 1.0;
    let expBonus = 1.0;
    
    for (const type of pokemon.types) {
      const bonus = await timePeriodManager.getTypeBonus(type, periodId);
      
      if (bonus.stat_bonus) {
        if (bonus.stat_bonus.attack) {
          attackBonus = Math.max(attackBonus, bonus.stat_bonus.attack);
        }
        if (bonus.stat_bonus.defense) {
          defenseBonus = Math.max(defenseBonus, bonus.stat_bonus.defense);
        }
      }
      
      if (bonus.experience_bonus) {
        expBonus = Math.max(expBonus, bonus.experience_bonus);
      }
    }
    
    return {
      ...pokemon,
      time_bonuses: {
        attack_multiplier: attackBonus,
        defense_multiplier: defenseBonus,
        experience_multiplier: expBonus,
        period_id: periodId
      }
    };
  }
}

module.exports = new TimeSpawnFilter();
```

### 4. Gateway API 路由

**文件**: `backend/gateway/src/routes/timePeriod.js`

```javascript
'use strict';

const express = require('express');
const router = express.Router();
const timePeriodManager = require('../../../shared/TimePeriodManager');
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('time-period-routes');

/**
 * GET /api/time/current
 * 获取当前时段信息
 */
router.get('/current', async (req, res, next) => {
  try {
    const timezone = req.query.timezone || req.headers['x-timezone'] || 'UTC';
    const period = await timePeriodManager.getCurrentPeriod(timezone);
    
    metrics.incrementCounter('time_period_requests_total', { period: period.id });
    
    successResp(res, period);
  } catch (error) {
    logger.error({ error }, 'Failed to get current time period');
    next(new AppError('Failed to get time period', 500));
  }
});

/**
 * GET /api/time/periods
 * 获取所有时段配置
 */
router.get('/periods', async (req, res, next) => {
  try {
    const periods = await timePeriodManager.loadTimePeriods();
    successResp(res, { periods });
  } catch (error) {
    logger.error({ error }, 'Failed to get time periods');
    next(new AppError('Failed to get time periods', 500));
  }
});

/**
 * GET /api/time/special-pokemon
 * 获取当前时段特殊精灵列表
 */
router.get('/special-pokemon', async (req, res, next) => {
  try {
    const timezone = req.query.timezone || 'UTC';
    const currentPeriod = await timePeriodManager.getCurrentPeriod(timezone);
    const specialPokemon = await timePeriodManager.getPeriodSpecialPokemon(currentPeriod.id);
    
    successResp(res, {
      period: currentPeriod,
      special_pokemon: specialPokemon,
      count: specialPokemon.length
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get special pokemon');
    next(new AppError('Failed to get special pokemon', 500));
  }
});

/**
 * GET /api/time/type-bonus/:type
 * 获取特定属性在当前时段的加成
 */
router.get('/type-bonus/:type', async (req, res, next) => {
  try {
    const { type } = req.params;
    const currentPeriod = await timePeriodManager.getCurrentPeriod();
    const bonus = await timePeriodManager.getTypeBonus(type, currentPeriod.id);
    
    successResp(res, {
      pokemon_type: type,
      period: currentPeriod.id,
      bonus
    });
  } catch (error) {
    logger.error({ error, type: req.params.type }, 'Failed to get type bonus');
    next(new AppError('Failed to get type bonus', 500));
  }
});

/**
 * GET /api/time/activity-stats
 * 获取玩家时段活动统计（需认证）
 */
router.get('/activity-stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { query } = require('../../../shared/db');
    
    const result = await query(
      'SELECT * FROM player_time_activity_stats WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return successResp(res, {
        dawn_catches: 0,
        day_catches: 0,
        dusk_catches: 0,
        night_catches: 0,
        late_night_catches: 0
      });
    }
    
    successResp(res, result.rows[0]);
  } catch (error) {
    logger.error({ error }, 'Failed to get activity stats');
    next(new AppError('Failed to get activity stats', 500));
  }
});

/**
 * GET /api/time/preview/:hour
 * 预览指定小时的时段信息
 */
router.get('/preview/:hour', async (req, res, next) => {
  try {
    const hour = parseInt(req.params.hour);
    
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return next(new AppError('Invalid hour. Must be 0-23', 400));
    }
    
    await timePeriodManager.loadTimePeriods();
    const period = timePeriodManager.findPeriodByHour(hour);
    const nextPeriod = timePeriodManager.getNextPeriod(hour);
    
    successResp(res, {
      hour,
      period,
      next_period: nextPeriod
    });
  } catch (error) {
    logger.error({ error, hour: req.params.hour }, 'Failed to preview time period');
    next(new AppError('Failed to preview time period', 500));
  }
});

module.exports = router;
```

### 5. 前端时段显示组件

**文件**: `frontend/game-client/src/components/TimePeriodDisplay.js`

```javascript
'use strict';

/**
 * 时段显示组件 - 显示当前游戏时间、时段、倒计时
 */
class TimePeriodDisplay {
  constructor(options = {}) {
    this.container = options.container || document.getElementById('time-period-display');
    this.updateInterval = options.updateInterval || 60000; // 1分钟更新一次
    this.onPeriodChange = options.onPeriodChange || (() => {});
    
    this.currentPeriod = null;
    this.timerId = null;
    
    this.init();
  }

  async init() {
    await this.updatePeriod();
    this.startAutoUpdate();
  }

  /**
   * 更新时段信息
   */
  async updatePeriod() {
    try {
      const response = await fetch('/api/time/current?timezone=' + this.getUserTimezone());
      const data = await response.json();
      
      const previousPeriod = this.currentPeriod;
      this.currentPeriod = data.data;
      
      if (previousPeriod && previousPeriod.id !== this.currentPeriod.id) {
        this.onPeriodChange(this.currentPeriod, previousPeriod);
      }
      
      this.render();
    } catch (error) {
      console.error('Failed to update time period:', error);
    }
  }

  /**
   * 渲染时段显示
   */
  render() {
    if (!this.currentPeriod || !this.container) return;
    
    const period = this.currentPeriod;
    const timeUntilNext = period.time_until_next;
    
    const html = `
      <div class="time-period-container" style="background: linear-gradient(135deg, ${period.background_tint}22, ${period.background_tint}11);">
        <div class="period-icon">
          ${this.getPeriodIcon(period.id)}
        </div>
        <div class="period-info">
          <div class="period-name">${this.getPeriodName(period.id)}</div>
          <div class="period-time">${period.local_time || period.utc_time}</div>
          <div class="next-period">
            下一时段: ${this.getPeriodName(period.next_period?.id)} 
            (${timeUntilNext.hours}小时${timeUntilNext.minutes}分)
          </div>
        </div>
        <div class="period-effects">
          ${this.renderPeriodEffects(period)}
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.applyAtmosphereEffects(period);
  }

  /**
   * 获取时段图标
   */
  getPeriodIcon(periodId) {
    const icons = {
      'dawn': '🌅',
      'day': '☀️',
      'dusk': '🌆',
      'night': '🌙',
      'late_night': '🌃'
    };
    return icons[periodId] || '⏰';
  }

  /**
   * 获取时段名称
   */
  getPeriodName(periodId) {
    const names = {
      'dawn': '黎明',
      'day': '白天',
      'dusk': '黄昏',
      'night': '夜晚',
      'late_night': '深夜'
    };
    return names[periodId] || periodId;
  }

  /**
   * 渲染时段效果
   */
  renderPeriodEffects(period) {
    const effects = [];
    
    if (period.atmosphere) {
      if (period.atmosphere.stars) effects.push('⭐ 星空可见');
      if (period.atmosphere.moon) effects.push('🌙 月亮可见');
      if (period.atmosphere.sunset) effects.push('🌅 日落特效');
      if (period.atmosphere.fog) effects.push(`🌫️ 雾气(${Math.round(period.atmosphere.fog * 100)}%)`);
    }
    
    return effects.map(e => `<span class="effect-badge">${e}</span>`).join('');
  }

  /**
   * 应用大气效果到游戏界面
   */
  applyAtmosphereEffects(period) {
    const gameContainer = document.getElementById('game-container');
    if (!gameContainer) return;
    
    // 移除旧的效果类
    gameContainer.classList.remove('period-dawn', 'period-day', 'period-dusk', 'period-night', 'period-late-night');
    
    // 添加新的效果类
    gameContainer.classList.add(`period-${period.id}`);
    
    // 应用光照强度
    gameContainer.style.setProperty('--light-level', period.light_level);
    gameContainer.style.setProperty('--background-tint', period.background_tint);
    
    // 应用大气效果
    if (period.atmosphere) {
      if (period.atmosphere.fog) {
        gameContainer.style.setProperty('--fog-opacity', period.atmosphere.fog);
      }
    }
  }

  /**
   * 获取用户时区
   */
  getUserTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  /**
   * 启动自动更新
   */
  startAutoUpdate() {
    if (this.timerId) {
      clearInterval(this.timerId);
    }
    
    this.timerId = setInterval(() => {
      this.updatePeriod();
    }, this.updateInterval);
  }

  /**
   * 停止自动更新
   */
  stopAutoUpdate() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * 销毁组件
   */
  destroy() {
    this.stopAutoUpdate();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TimePeriodDisplay;
} else if (typeof window !== 'undefined') {
  window.TimePeriodDisplay = TimePeriodDisplay;
}
```

### 6. 前端样式

**文件**: `frontend/game-client/src/styles/time-period.css`

```css
/* 时段显示样式 */
.time-period-container {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-radius: 12px;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: all 0.5s ease;
}

.period-icon {
  font-size: 32px;
  margin-right: 12px;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

.period-info {
  flex: 1;
}

.period-name {
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 4px;
}

.period-time {
  font-size: 14px;
  opacity: 0.8;
  margin-bottom: 2px;
}

.next-period {
  font-size: 12px;
  opacity: 0.6;
}

.period-effects {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.effect-badge {
  background: rgba(255, 255, 255, 0.1);
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 11px;
}

/* 游戏界面时段效果 */
#game-container {
  transition: all 1s ease;
}

#game-container.period-dawn {
  filter: brightness(0.9) saturate(1.1);
}

#game-container.period-day {
  filter: brightness(1.0) saturate(1.0);
}

#game-container.period-dusk {
  filter: brightness(0.85) saturate(1.2) sepia(0.2);
}

#game-container.period-night {
  filter: brightness(0.6) saturate(0.9) hue-rotate(-10deg);
}

#game-container.period-late-night {
  filter: brightness(0.4) saturate(0.7) hue-rotate(-20deg);
}

/* 星空效果（夜晚和深夜） */
#game-container.period-night::before,
#game-container.period-late-night::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    radial-gradient(1px 1px at 20px 30px, white, transparent),
    radial-gradient(1px 1px at 40px 70px, rgba(255,255,255,0.8), transparent),
    radial-gradient(1px 1px at 50px 160px, white, transparent),
    radial-gradient(1px 1px at 90px 40px, rgba(255,255,255,0.6), transparent);
  background-size: 200px 200px;
  animation: twinkle 5s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}

@keyframes twinkle {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}

/* 雾气效果 */
#game-container[style*="--fog-opacity"]::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(200, 200, 200, var(--fog-opacity)) 50%,
    transparent 100%
  );
  pointer-events: none;
  z-index: 0;
}

/* 响应式调整 */
@media (max-width: 768px) {
  .time-period-container {
    flex-direction: column;
    text-align: center;
  }
  
  .period-icon {
    margin-right: 0;
    margin-bottom: 8px;
  }
  
  .period-effects {
    justify-content: center;
  }
}
```

### 7. 单元测试

**文件**: `backend/tests/unit/time-period.test.js`

```javascript
'use strict';

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const timePeriodManager = require('../../shared/TimePeriodManager');

describe('Time Period Manager', () => {
  let queryStub, getJSONStub, setJSONStub;

  beforeEach(() => {
    // Stub dependencies
    queryStub = sinon.stub(require('../../shared/db'), 'query');
    getJSONStub = sinon.stub(require('../../shared/redis'), 'getJSON');
    setJSONStub = sinon.stub(require('../../shared/redis'), 'setJSON');
    
    // Reset timePeriods
    timePeriodManager.timePeriods = null;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getCurrentPeriod', () => {
    it('should return current period based on UTC hour', async () => {
      // Mock time periods
      timePeriodManager.timePeriods = [
        { id: 'day', start_hour: 7, end_hour: 17, light_level: 1.0 },
        { id: 'night', start_hour: 19, end_hour: 23, light_level: 0.2 }
      ];
      
      getJSONStub.resolves(null);
      
      const period = await timePeriodManager.getCurrentPeriod('UTC');
      
      expect(period).to.have.property('id');
      expect(period).to.have.property('utc_hour');
      expect(period).to.have.property('utc_time');
      expect(period).to.have.property('next_period');
    });

    it('should handle late_night period crossing midnight', async () => {
      timePeriodManager.timePeriods = [
        { id: 'late_night', start_hour: 23, end_hour: 5, light_level: 0.1 }
      ];
      
      // Hour is 2 AM
      const period = timePeriodManager.findPeriodByHour(2);
      
      expect(period.id).to.equal('late_night');
    });

    it('should use cache when valid', async () => {
      const cachedPeriod = {
        id: 'day',
        utc_time: new Date().toISOString(),
        light_level: 1.0
      };
      
      getJSONStub.resolves(cachedPeriod);
      
      const period = await timePeriodManager.getCurrentPeriod('UTC');
      
      expect(period.id).to.equal('day');
      expect(queryStub.called).to.be.false;
    });
  });

  describe('findPeriodByHour', () => {
    beforeEach(() => {
      timePeriodManager.timePeriods = [
        { id: 'dawn', start_hour: 5, end_hour: 7 },
        { id: 'day', start_hour: 7, end_hour: 17 },
        { id: 'dusk', start_hour: 17, end_hour: 19 },
        { id: 'night', start_hour: 19, end_hour: 23 },
        { id: 'late_night', start_hour: 23, end_hour: 5 }
      ];
    });

    it('should find day period at noon', () => {
      const period = timePeriodManager.findPeriodByHour(12);
      expect(period.id).to.equal('day');
    });

    it('should find night period at 20:00', () => {
      const period = timePeriodManager.findPeriodByHour(20);
      expect(period.id).to.equal('night');
    });

    it('should find late_night at midnight', () => {
      const period = timePeriodManager.findPeriodByHour(0);
      expect(period.id).to.equal('late_night');
    });

    it('should find late_night at 3 AM', () => {
      const period = timePeriodManager.findPeriodByHour(3);
      expect(period.id).to.equal('late_night');
    });
  });

  describe('getPokemonSpawnMultiplier', () => {
    it('should return spawn multiplier for pokemon in period', async () => {
      queryStub.resolves({
        rows: [{ spawn_multiplier: 2.5, is_exclusive: false }]
      });
      
      const config = await timePeriodManager.getPokemonSpawnMultiplier(25, 'night');
      
      expect(config.spawn_multiplier).to.equal(2.5);
      expect(config.is_exclusive).to.be.false;
    });

    it('should return default config when no config found', async () => {
      queryStub.resolves({ rows: [] });
      
      const config = await timePeriodManager.getPokemonSpawnMultiplier(999, 'day');
      
      expect(config.spawn_multiplier).to.equal(1.0);
      expect(config.is_exclusive).to.be.false;
    });
  });

  describe('getTypeBonus', () => {
    it('should return stat bonus for type in period', async () => {
      queryStub.resolves({
        rows: [{
          stat_bonus: { attack: 1.2, defense: 1.1 },
          experience_bonus: 1.5
        }]
      });
      
      const bonus = await timePeriodManager.getTypeBonus('fire', 'day');
      
      expect(bonus.stat_bonus.attack).to.equal(1.2);
      expect(bonus.stat_bonus.defense).to.equal(1.1);
      expect(bonus.experience_bonus).to.equal(1.5);
    });

    it('should return default bonus when no config found', async () => {
      queryStub.resolves({ rows: [] });
      
      const bonus = await timePeriodManager.getTypeBonus('unknown', 'night');
      
      expect(bonus.stat_bonus).to.deep.equal({});
      expect(bonus.experience_bonus).to.equal(1.0);
    });
  });

  describe('getNextPeriod', () => {
    beforeEach(() => {
      timePeriodManager.timePeriods = [
        { id: 'dawn', start_hour: 5 },
        { id: 'day', start_hour: 7 },
        { id: 'dusk', start_hour: 17 },
        { id: 'night', start_hour: 19 },
        { id: 'late_night', start_hour: 23 }
      ];
    });

    it('should return next period in sequence', () => {
      const nextPeriod = timePeriodManager.getNextPeriod(12); // During day
      expect(nextPeriod.id).to.equal('dusk');
    });

    it('should wrap around from late_night to dawn', () => {
      const nextPeriod = timePeriodManager.getNextPeriod(23); // Late night start
      expect(nextPeriod.id).to.equal('dawn');
    });
  });

  describe('getTimeUntilNext', () => {
    beforeEach(() => {
      timePeriodManager.timePeriods = [
        { id: 'day', start_hour: 7 },
        { id: 'dusk', start_hour: 17 }
      ];
    });

    it('should calculate time until next period', () => {
      const timeUntil = timePeriodManager.getTimeUntilNext(10); // 10 AM
      
      expect(timeUntil).to.have.property('hours');
      expect(timeUntil).to.have.property('minutes');
      expect(timeUntil).to.have.property('total_minutes');
      expect(timeUntil.hours).to.be.at.least(0);
    });
  });
});
```

## 验收标准

- [ ] 数据库表创建成功，包含所有必需字段和索引
- [ ] 时段管理服务可正确识别当前时段
- [ ] 精灵刷新倍率根据时段正确应用
- [ ] 属性加成系统在对应时段生效
- [ ] 前端正确显示当前时段和倒计时
- [ ] 游戏界面根据时段切换视觉效果
- [ ] API 端点 `/api/time/current` 返回正确时段信息
- [ ] API 端点 `/api/time/special-pokemon` 返回时段特殊精灵
- [ ] API 端点 `/api/time/type-bonus/:type` 返回属性加成
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 性能测试：时段查询响应时间 < 50ms
- [ ] 缓存机制正常工作，减少数据库查询
- [ ] 玩家活动统计正确更新

## 影响范围

### 新增文件
- `database/pending/20260611_040000__add_day_night_cycle_system.sql`
- `backend/shared/TimePeriodManager.js`
- `backend/services/catch-service/src/timeSpawnFilter.js`
- `backend/gateway/src/routes/timePeriod.js`
- `frontend/game-client/src/components/TimePeriodDisplay.js`
- `frontend/game-client/src/styles/time-period.css`
- `backend/tests/unit/time-period.test.js`

### 修改文件
- `backend/gateway/src/index.js` - 添加时段路由
- `backend/services/catch-service/src/index.js` - 集成时段过滤器
- `backend/services/location-service/src/spawnEngine.js` - 应用时段刷新逻辑
- `frontend/game-client/index.html` - 添加时段显示容器

## 参考

- [Pokémon GO 昼夜系统](https://pokemongohub.net/guide/pokemon-go-day-night-cycle/)
- [时区处理最佳实践](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)
- [游戏氛围设计](https://www.gamasutra.com/blogs/HermanTulleken/20160824/277814/Game_Atmospheric_Effects.php)
