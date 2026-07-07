/**
 * 天气增益计算引擎
 * 根据天气条件计算精灵刷新概率和稀有度增益
 * 
 * @module weather/WeatherBoostEngine
 */

'use strict';

const { createLogger } = require('../logger');
const { 
  WEATHER_BOOST_MATRIX, 
  getWeatherConfig,
  isSpecialWeather,
  getBoostedTypes,
  getTypeName
} = require('./WeatherBoostMatrix');

const logger = createLogger('weather-boost-engine');

/**
 * 天气增益引擎类
 */
class WeatherBoostEngine {
  constructor(config = {}) {
    this.config = {
      // 非增益属性的概率降低系数（默认降低 30%）
      nonBoostedPenalty: config.nonBoostedPenalty || 0.7,
      // 特殊天气稀有精灵基础概率
      specialWeatherRarityBase: config.specialWeatherRarityBase || 0.05,
      ...config
    };
  }

  /**
   * 计算天气增益后的精灵刷新概率系数
   * @param {string} weather - 当前天气（游戏天气类型）
   * @param {string} pokemonType - 精灵属性
   * @returns {number} - 增益系数（1.0 为无变化）
   */
  calculateBoostFactor(weather, pokemonType) {
    const weatherConfig = getWeatherConfig(weather);
    
    // 未知天气，无增益
    if (!weatherConfig) {
      logger.debug({ weather, pokemonType }, 'Unknown weather, no boost');
      return 1.0;
    }
    
    const normalizedType = pokemonType.toLowerCase();
    
    // 检查是否为增益属性
    const isBoosted = weatherConfig.boostedTypes.includes(normalizedType);
    
    if (isBoosted) {
      logger.debug({ 
        weather, 
        pokemonType, 
        multiplier: weatherConfig.spawnMultiplier 
      }, 'Pokemon type boosted by weather');
      return weatherConfig.spawnMultiplier;
    }
    
    // 非增益属性，降低概率
    const penalty = this.config.nonBoostedPenalty;
    logger.debug({ 
      weather, 
      pokemonType, 
      penalty 
    }, 'Pokemon type penalized by weather');
    return penalty;
  }

  /**
   * 批量计算多个精灵类型的增益系数
   * @param {string} weather - 当前天气
   * @param {Array<string>} pokemonTypes - 精灵属性数组
   * @returns {Object} - 类型 -> 增益系数的映射
   */
  calculateBatchBoostFactors(weather, pokemonTypes) {
    const factors = {};
    for (const type of pokemonTypes) {
      factors[type] = this.calculateBoostFactor(weather, type);
    }
    return factors;
  }

  /**
   * 判断是否触发稀有精灵刷新
   * @param {string} weather - 当前天气
   * @returns {Object} - { triggered: boolean, rarityBoost: number, specialEvent: boolean }
   */
  checkRareSpawnTrigger(weather) {
    const weatherConfig = getWeatherConfig(weather);
    
    if (!weatherConfig) {
      return { 
        triggered: false, 
        rarityBoost: 0, 
        specialEvent: false 
      };
    }
    
    // 特殊天气（雾、雪、暴风雨）有更高概率触发稀有精灵
    const isSpecial = isSpecialWeather(weather);
    
    return {
      triggered: true,
      rarityBoost: weatherConfig.rarityBoost,
      specialEvent: isSpecial
    };
  }

  /**
   * 选择稀有精灵
   * @param {string} weather - 当前天气
   * @param {number} baseRarity - 基础稀有度概率（0-1）
   * @returns {Object|null} 稀有精灵信息，或 null（未触发）
   */
  selectRarePokemon(weather, baseRarity = 0.05) {
    const trigger = this.checkRareSpawnTrigger(weather);
    
    if (!trigger.triggered) {
      return null;
    }
    
    // 计算稀有精灵出现概率
    const adjustedRarity = Math.min(
      baseRarity + trigger.rarityBoost,
      0.5  // 最大 50% 概率
    );
    
    // 随机判断是否出现
    const random = Math.random();
    if (random > adjustedRarity) {
      logger.debug({ 
        weather, 
        adjustedRarity, 
        random 
      }, 'Rare spawn check failed');
      return null;
    }
    
    // 获取该天气增益的属性
    const boostedTypes = getBoostedTypes(weather);
    
    // 随机选择一个增益属性
    const selectedType = boostedTypes[Math.floor(Math.random() * boostedTypes.length)];
    
    logger.info({ 
      weather, 
      selectedType, 
      adjustedRarity,
      specialEvent: trigger.specialEvent
    }, 'Rare spawn triggered');
    
    return {
      type: selectedType,
      typeName: getTypeName(selectedType),
      rarity: adjustedRarity,
      specialEvent: trigger.specialEvent
    };
  }

  /**
   * 应用天气增益到精灵刷新列表
   * @param {string} weather - 当前天气
   * @param {Array<Object>} baseSpawns - 基础刷新列表
   * @returns {Array<Object>} - 调整后的刷新列表
   */
  applyWeatherBoost(weather, baseSpawns) {
    const weatherConfig = getWeatherConfig(weather);
    
    if (!weatherConfig) {
      logger.warn({ weather }, 'Unknown weather, returning base spawns');
      return baseSpawns;
    }
    
    // 应用增益系数到每个精灵
    const boostedSpawns = baseSpawns.map(pokemon => {
      const boostFactor = this.calculateBoostFactor(weather, pokemon.type);
      return {
        ...pokemon,
        spawnProbability: pokemon.baseProbability * boostFactor,
        weatherBoosted: boostFactor > 1.0,
        boostWeather: boostFactor > 1.0 ? weather : null,
        boostMultiplier: boostFactor
      };
    });
    
    // 检查是否添加稀有精灵
    const rareSpawn = this.selectRarePokemon(weather);
    if (rareSpawn) {
      boostedSpawns.push({
        id: null, // 需要后续查询数据库确定具体精灵
        type: rareSpawn.type,
        typeName: rareSpawn.typeName,
        spawnProbability: 0.1 * rareSpawn.rarity, // 基于稀有度调整
        weatherBoosted: true,
        boostWeather: weather,
        boostMultiplier: 2.0,
        rareEvent: rareSpawn.specialEvent
      });
    }
    
    return boostedSpawns;
  }

  /**
   * 获取天气增益摘要信息
   * @param {string} weather - 当前天气
   * @returns {Object} - 增益摘要
   */
  getWeatherBoostSummary(weather) {
    const weatherConfig = getWeatherConfig(weather);
    
    if (!weatherConfig) {
      return {
        weather: weather,
        boostedTypes: [],
        spawnMultiplier: 1.0,
        rarityBoost: 0,
        specialEvent: false,
        description: '未知天气'
      };
    }
    
    return {
      weather: weather,
      boostedTypes: weatherConfig.boostedTypes.map(type => ({
        type: type,
        typeName: getTypeName(type)
      })),
      spawnMultiplier: weatherConfig.spawnMultiplier,
      rarityBoost: weatherConfig.rarityBoost,
      specialEvent: weatherConfig.specialEvent,
      description: weatherConfig.description
    };
  }

  /**
   * 获取天气增益的历史记录（用于审计）
   * @param {string} location - 位置标识
   * @param {string} weather - 天气类型
   * @returns {Object} - 历史记录对象
   */
  createBoostHistoryRecord(location, weather) {
    const summary = this.getWeatherBoostSummary(weather);
    return {
      location,
      weather,
      boostedTypes: summary.boostedTypes.map(t => t.type),
      spawnMultiplier: summary.spawnMultiplier,
      rarityBoost: summary.rarityBoost,
      specialEvent: summary.specialEvent,
      timestamp: new Date().toISOString()
    };
  }
}

// 导出单例
const weatherBoostEngine = new WeatherBoostEngine();

module.exports = {
  WeatherBoostEngine,
  weatherBoostEngine
};
