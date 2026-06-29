/**
 * REQ-00102: 精灵昼夜循环系统
 * 
 * 昼夜时间管理与精灵生成差异化系统
 * 支持时间段检测、精灵权重计算、时间同步
 */

'use strict';

const { query } = require('../../../shared/db');
const { getRedis, setJSON, getJSON } = require('../../../shared/redis');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('day-night-service');

// ============================================================
// 时间段定义
// ============================================================
const TIME_PERIODS = {
  DAWN: { 
    name: 'DAWN', 
    hours: [5, 6], 
    displayZh: '黎明', 
    displayEn: 'Dawn',
    colorTheme: '#FFB6C1',
    spawnBonus: 1.2
  },
  MORNING: { 
    name: 'MORNING', 
    hours: [7, 8, 9, 10, 11], 
    displayZh: '上午', 
    displayEn: 'Morning',
    colorTheme: '#FFD700',
    spawnBonus: 1.0
  },
  AFTERNOON: { 
    name: 'AFTERNOON', 
    hours: [12, 13, 14, 15, 16], 
    displayZh: '下午', 
    displayEn: 'Afternoon',
    colorTheme: '#FFA500',
    spawnBonus: 1.0
  },
  EVENING: { 
    name: 'EVENING', 
    hours: [17, 18], 
    displayZh: '黄昏', 
    displayEn: 'Evening',
    colorTheme: '#FF6347',
    spawnBonus: 1.2
  },
  DUSK: { 
    name: 'DUSK', 
    hours: [19, 20], 
    displayZh: '暮色', 
    displayEn: 'Dusk',
    colorTheme: '#9370DB',
    spawnBonus: 1.3
  },
  NIGHT: { 
    name: 'NIGHT', 
    hours: [21, 22, 23], 
    displayZh: '深夜', 
    displayEn: 'Night',
    colorTheme: '#191970',
    spawnBonus: 1.5
  },
  MIDNIGHT: { 
    name: 'MIDNIGHT', 
    hours: [0, 1, 2, 3, 4], 
    displayZh: '午夜', 
    displayEn: 'Midnight',
    colorTheme: '#0D0D2B',
    spawnBonus: 1.4
  }
};

// ============================================================
// 核心功能类
// ============================================================
class DayNightCycleService {
  constructor() {
    this.cachePrefix = 'daynight:';
    this.cacheTTLSec = 300; // 5分钟缓存
  }

  /**
   * 获取当前时间段
   * @param {number} timezoneOffsetMinutes - 时区偏移（分钟）
   * @returns {Promise<Object>} 时间段信息
   */
  async getCurrentPeriod(timezoneOffsetMinutes = 0) {
    try {
      // 尝试从数据库获取配置
      const { rows } = await query(`
        SELECT * FROM get_current_game_time($1)
      `, [timezoneOffsetMinutes]);
      
      if (rows.length > 0) {
        return {
          currentHour: rows[0].current_hour,
          period: rows[0].current_period,
          displayNameZh: rows[0].period_display_zh,
          displayNameEn: rows[0].period_display_en,
          spawnBonusMultiplier: parseFloat(rows[0].spawn_bonus_multiplier),
          colorTheme: rows[0].color_theme,
          nextChangeHours: rows[0].next_change_hours
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Database query failed, using fallback');
    }
    
    // 回退到本地计算
    return this.calculateCurrentPeriod(timezoneOffsetMinutes);
  }

  /**
   * 本地计算当前时间段
   */
  calculateCurrentPeriod(timezoneOffsetMinutes = 0) {
    const now = new Date();
    const adjustedTime = new Date(now.getTime() + timezoneOffsetMinutes * 60 * 1000);
    const currentHour = adjustedTime.getHours();
    
    // 根据小时匹配时间段
    for (const [key, period] of Object.entries(TIME_PERIODS)) {
      if (period.hours.includes(currentHour)) {
        // 计算下一个变化时间
        const sortedHours = period.hours.sort((a, b) => a - b);
        const nextHour = sortedHours[sortedHours.indexOf(currentHour) + 1] || sortedHours[0];
        const nextChangeHours = nextHour > currentHour 
          ? nextHour - currentHour 
          : 24 - currentHour + nextHour;
        
        return {
          currentHour,
          period: period.name,
          displayNameZh: period.displayZh,
          displayNameEn: period.displayEn,
          spawnBonusMultiplier: period.spawnBonus,
          colorTheme: period.colorTheme,
          nextChangeHours
        };
      }
    }
    
    // 默认返回
    return {
      currentHour,
      period: 'DAY',
      displayNameZh: '白天',
      displayNameEn: 'Day',
      spawnBonusMultiplier: 1.0,
      colorTheme: '#87CEEB',
      nextChangeHours: 1
    };
  }

  /**
   * 获取指定时间段可生成的精灵列表
   * @param {string} timePeriod - 时间段名称
   * @param {Object} options - 过滤选项
   */
  async getPokemonForPeriod(timePeriod, options = {}) {
    const { biome, rarity, limit = 50 } = options;
    
    try {
      const conditions = ['pdns.time_period = $1'];
      const params = [timePeriod];
      let paramIndex = 2;
      
      if (biome) {
        params.push(biome);
        conditions.push(`($${paramIndex} = 'ANY' OR $${paramIndex} = ANY(ps.biomes))`);
        paramIndex++;
      }
      
      if (rarity) {
        params.push(rarity);
        conditions.push(`ps.rarity = $${paramIndex}`);
        paramIndex++;
      }
      
      params.push(limit);
      
      const { rows } = await query(`
        SELECT 
          pdns.pokemon_id,
          ps.name_zh,
          ps.name_en,
          ps.type1,
          ps.type2,
          ps.rarity,
          pdns.spawn_weight_multiplier,
          pdns.is_exclusive,
          pdns.special_iv_bonus,
          ps.time_preference,
          ps.is_nocturnal,
          ps.is_diurnal
        FROM pokemon_day_night_spawn pdns
        JOIN pokemon_species ps ON ps.id = pdns.pokemon_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY pdns.spawn_weight_multiplier DESC, ps.rarity DESC
        LIMIT $${paramIndex}
      `, params);
      
      return rows;
    } catch (err) {
      logger.error({ err, timePeriod }, 'Failed to get pokemon for period');
      return [];
    }
  }

  /**
   * 计算精灵在当前时间的生成权重
   * @param {number} pokemonId - 精灵ID
   * @param {string} timePeriod - 时间段
   */
  async getPokemonSpawnWeight(pokemonId, timePeriod) {
    try {
      const { rows } = await query(`
        SELECT get_pokemon_spawn_weight_for_time($1, $2) as weight
      `, [pokemonId, timePeriod]);
      
      return parseFloat(rows[0]?.weight || 1.0);
    } catch (err) {
      logger.debug({ err, pokemonId, timePeriod }, 'Weight lookup failed, using default');
      return 1.0;
    }
  }

  /**
   * 批量获取精灵生成权重
   * @param {number[]} pokemonIds - 精灵ID列表
   * @param {string} timePeriod - 时间段
   */
  async getBatchSpawnWeights(pokemonIds, timePeriod) {
    try {
      const { rows } = await query(`
        SELECT 
          pdns.pokemon_id,
          COALESCE(pdns.spawn_weight_multiplier, 1.0) as weight,
          pdns.special_iv_bonus
        FROM UNNEST($1::INTEGER[]) as pokemon_id
        LEFT JOIN pokemon_day_night_spawn pdns 
          ON pdns.pokemon_id = pokemon_id 
          AND pdns.time_period = $2
      `, [pokemonIds, timePeriod]);
      
      const weightMap = {};
      for (const row of rows) {
        weightMap[row.pokemon_id] = {
          weight: parseFloat(row.weight),
          ivBonus: parseFloat(row.special_iv_bonus || 0)
        };
      }
      
      return weightMap;
    } catch (err) {
      logger.error({ err }, 'Batch weight lookup failed');
      return {};
    }
  }

  /**
   * 应用昼夜权重到精灵生成
   * @param {Array} speciesList - 候选精灵列表
   * @param {string} timePeriod - 当前时间段
   * @param {number} periodBonus - 时间段加成
   */
  async applyDayNightWeights(speciesList, timePeriod, periodBonus = 1.0) {
    if (!speciesList || speciesList.length === 0) {
      return speciesList;
    }
    
    const pokemonIds = speciesList.map(s => s.id);
    const weightMap = await this.getBatchSpawnWeights(pokemonIds, timePeriod);
    
    return speciesList.map(species => {
      const weightInfo = weightMap[species.id] || { weight: 1.0, ivBonus: 0 };
      const baseWeight = species.baseWeight || 1.0;
      
      return {
        ...species,
        dayNightWeight: weightInfo.weight,
        finalWeight: baseWeight * weightInfo.weight * periodBonus,
        ivBonus: weightInfo.ivBonus
      };
    });
  }

  /**
   * 更新生成统计
   * @param {string} timePeriod - 时间段
   * @param {Object} spawnData - 生成数据
   */
  async updateSpawnStatistics(timePeriod, spawnData) {
    const { totalSpawns, uniqueSpecies, rareSpawns, shinySpawns, avgIv } = spawnData;
    const today = new Date().toISOString().split('T')[0];
    
    try {
      await query(`
        INSERT INTO day_night_spawn_statistics 
          (date, time_period, total_spawns, unique_species, rare_spawns, shiny_spawns, average_iv)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (date, time_period) DO UPDATE SET
          total_spawns = day_night_spawn_statistics.total_spawns + $3,
          unique_species = GREATEST(day_night_spawn_statistics.unique_species, $4),
          rare_spawns = day_night_spawn_statistics.rare_spawns + $5,
          shiny_spawns = day_night_spawn_statistics.shiny_spawns + $6,
          average_iv = (day_night_spawn_statistics.average_iv + $7) / 2,
          updated_at = NOW()
      `, [today, timePeriod, totalSpawns, uniqueSpecies, rareSpawns, shinySpawns, avgIv]);
    } catch (err) {
      logger.error({ err, timePeriod }, 'Failed to update spawn statistics');
    }
  }

  /**
   * 获取时间段转换预告
   * @param {string} currentPeriod - 当前时间段
   * @param {number} nextChangeHours - 距离下次变化的小时数
   */
  async getTransitionAnnouncement(currentPeriod, nextChangeHours) {
    const periods = Object.values(TIME_PERIODS);
    const currentIndex = periods.findIndex(p => p.name === currentPeriod);
    const nextPeriod = periods[(currentIndex + 1) % periods.length];
    
    return {
      current: {
        name: currentPeriod,
        displayNameZh: TIME_PERIODS[currentPeriod]?.displayZh || currentPeriod,
        displayNameEn: TIME_PERIODS[currentPeriod]?.displayEn || currentPeriod
      },
      next: {
        name: nextPeriod.name,
        displayNameZh: nextPeriod.displayZh,
        displayNameEn: nextPeriod.displayEn,
        hoursUntil: nextChangeHours
      },
      message: nextChangeHours <= 1 
        ? `${nextPeriod.displayZh}即将到来，${nextPeriod.displayEn}精灵开始活跃！`
        : `距离${nextPeriod.displayZh}还有${nextChangeHours}小时`
    };
  }

  /**
   * 获取时间段精灵提示
   */
  async getPeriodTips(timePeriod) {
    const tips = {
      DAWN: {
        tipZh: '黎明时分，仙子系精灵开始活跃，是捕捉皮皮和胖丁的最佳时机！',
        tipEn: 'Dawn brings fairy-type Pokemon. Best time to catch Clefairy and Jigglypuff!',
        recommendedTypes: ['FAIRY', 'NORMAL'],
        rareSpawns: ['CLEFAIRY', 'JIGGLYPUFF']
      },
      MORNING: {
        tipZh: '清晨阳光明媚，虫系精灵活跃，蝴蝶和蜜蜂类精灵出现率提升！',
        tipEn: 'Sunny morning activates bug-types. Butterflies and bees are more common!',
        recommendedTypes: ['BUG', 'FLYING', 'GRASS'],
        rareSpawns: ['BUTTERFREE', 'BEEDRILL']
      },
      AFTERNOON: {
        tipZh: '午后温暖，火系和地面系精灵在阳光下更加活跃！',
        tipEn: 'Warm afternoon boosts fire and ground types!',
        recommendedTypes: ['FIRE', 'GROUND', 'ROCK'],
        rareSpawns: []
      },
      EVENING: {
        tipZh: '黄昏时分，光线变化，水系精灵开始在水面活跃！',
        tipEn: 'Evening light change activates water Pokemon near water surfaces!',
        recommendedTypes: ['WATER', 'BUG'],
        rareSpawns: ['MARILL', 'SURSKIT']
      },
      DUSK: {
        tipZh: '暮色降临，夜行精灵开始苏醒，幽灵系精灵出现率提升！',
        tipEn: 'Dusk awakens nocturnal Pokemon. Ghost types become more active!',
        recommendedTypes: ['GHOST', 'DARK', 'PSYCHIC'],
        rareSpawns: ['GASTLY', 'MURKROW']
      },
      NIGHT: {
        tipZh: '深夜是幽灵系和恶系精灵的活跃高峰！稀有夜行精灵出没！',
        tipEn: 'Night is peak time for ghost and dark types! Rare nocturnal Pokemon spawn!',
        recommendedTypes: ['GHOST', 'DARK', 'POISON'],
        rareSpawns: ['GENGAR', 'MISDREAVUS']
      },
      MIDNIGHT: {
        tipZh: '午夜时分，最稀有的夜行精灵可能出现，准备好捕捉吧！',
        tipEn: 'Midnight brings the rarest nocturnal Pokemon. Be ready to catch!',
        recommendedTypes: ['GHOST', 'DARK', 'FAIRY'],
        rareSpawns: ['GENGAR', 'HONCHKROW', 'MISDREAVUS']
      }
    };
    
    return tips[timePeriod] || tips.AFTERNOON;
  }
}

// ============================================================
// 导出单例和工具函数
// ============================================================
const dayNightService = new DayNightCycleService();

/**
 * 快速获取当前时间段（用于中间件/路由）
 */
async function getCurrentTimePeriod(timezoneOffsetMinutes = 0) {
  return dayNightService.getCurrentPeriod(timezoneOffsetMinutes);
}

/**
 * 快速应用昼夜权重（用于生成引擎）
 */
async function applyDayNightWeights(speciesList, timePeriod, periodBonus) {
  return dayNightService.applyDayNightWeights(speciesList, timePeriod, periodBonus);
}

module.exports = {
  DayNightCycleService,
  dayNightService,
  getCurrentTimePeriod,
  applyDayNightWeights,
  TIME_PERIODS
};