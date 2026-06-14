'use strict';

const { getJSON, setJSON } = require('./redis');
const { query } = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('time-period-manager');

/**
 * 时段管理器 - 管理游戏内昼夜循环系统
 * REQ-00102: 精灵昼夜循环系统
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
    if (!this.timePeriods || this.timePeriods.length === 0) {
      // 默认返回
      return {
        id: 'day',
        name_i18n: { en: 'Day', zh: '白天', ja: '昼' },
        start_hour: 7,
        end_hour: 17,
        light_level: 1.0,
        background_tint: '#87CEEB',
        atmosphere: {}
      };
    }
    
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
    return this.timePeriods.find(p => p.id === 'day') || this.timePeriods[0];
  }

  /**
   * 获取下一个时段
   */
  getNextPeriod(currentHour) {
    if (!this.timePeriods || this.timePeriods.length === 0) return null;
    
    const sortedPeriods = [...this.timePeriods].sort((a, b) => a.start_hour - b.start_hour);
    const currentPeriod = this.findPeriodByHour(currentHour);
    
    for (let i = 0; i < sortedPeriods.length; i++) {
      if (sortedPeriods[i].id === currentPeriod?.id) {
        const nextIndex = (i + 1) % sortedPeriods.length;
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
    if (!nextPeriod) return { hours: 0, minutes: 0, total_minutes: 0 };
    
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
      // 返回默认配置
      this.timePeriods = [
        { id: 'dawn', name_i18n: { en: 'Dawn', zh: '黎明' }, start_hour: 5, end_hour: 7, light_level: 0.6, background_tint: '#FFE4B5', atmosphere: { fog: 0.3 } },
        { id: 'day', name_i18n: { en: 'Day', zh: '白天' }, start_hour: 7, end_hour: 17, light_level: 1.0, background_tint: '#87CEEB', atmosphere: {} },
        { id: 'dusk', name_i18n: { en: 'Dusk', zh: '黄昏' }, start_hour: 17, end_hour: 19, light_level: 0.5, background_tint: '#FF8C00', atmosphere: { fog: 0.2, sunset: true } },
        { id: 'night', name_i18n: { en: 'Night', zh: '夜晚' }, start_hour: 19, end_hour: 23, light_level: 0.2, background_tint: '#191970', atmosphere: { stars: true, moon: true } },
        { id: 'late_night', name_i18n: { en: 'Late Night', zh: '深夜' }, start_hour: 23, end_hour: 5, light_level: 0.1, background_tint: '#0C0C1E', atmosphere: { stars: true } }
      ];
      return this.timePeriods;
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
   * 获取所有时段的属性加成
   */
  async getAllTypeBonuses(periodId) {
    const cacheKey = `${this.cachePrefix}all_bonuses:${periodId}`;
    
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
    
    try {
      const result = await query(
        'SELECT pokemon_type, stat_bonus, experience_bonus FROM type_time_bonus WHERE time_period_id = $1',
        [periodId]
      );
      
      await setJSON(cacheKey, result.rows, this.cacheTTL);
      return result.rows;
    } catch (error) {
      logger.error({ error, periodId }, 'Failed to get all type bonuses');
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
      const localTime = now.toLocaleString('en-US', { 
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      
      const localHour = parseInt(now.toLocaleString('en-US', { 
        timeZone: timezone, 
        hour: '2-digit', 
        hour12: false 
      }));
      
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

  /**
   * 批量获取多个精灵的刷新倍率
   */
  async getBatchSpawnMultipliers(pokemonIds, periodId) {
    if (!pokemonIds || pokemonIds.length === 0) return new Map();
    
    try {
      const placeholders = pokemonIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await query(
        `SELECT pokemon_id, spawn_multiplier, is_exclusive 
         FROM pokemon_time_spawn_config 
         WHERE pokemon_id IN (${placeholders}) AND time_period_id = $${pokemonIds.length + 1}`,
        [...pokemonIds, periodId]
      );
      
      const multipliers = new Map();
      for (const row of result.rows) {
        multipliers.set(row.pokemon_id, {
          spawn_multiplier: row.spawn_multiplier,
          is_exclusive: row.is_exclusive
        });
      }
      
      // 填充默认值
      for (const id of pokemonIds) {
        if (!multipliers.has(id)) {
          multipliers.set(id, { spawn_multiplier: 1.0, is_exclusive: false });
        }
      }
      
      return multipliers;
    } catch (error) {
      logger.error({ error, periodId }, 'Failed to get batch spawn multipliers');
      return new Map(pokemonIds.map(id => [id, { spawn_multiplier: 1.0, is_exclusive: false }]));
    }
  }
}

// 导出单例
module.exports = new TimePeriodManager();
