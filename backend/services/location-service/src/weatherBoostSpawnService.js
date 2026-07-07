/**
 * 天气增益刷新服务
 * 集成天气增益引擎到精灵刷新系统
 * 
 * @module services/WeatherBoostSpawnService
 */

'use strict';

const { createLogger } = require('../shared/logger');
const { weatherBoostEngine } = require('../shared/weather/WeatherBoostEngine');
const { mapWeatherCodeToGameWeather } = require('../shared/weather/WeatherBoostMatrix');
const { query } = require('../shared/db');
const { getJSON, setJSON } = require('../shared/redis');

const logger = createLogger('weather-boost-spawn-service');

/**
 * 天气增益刷新服务类
 */
class WeatherBoostSpawnService {
  constructor(config = {}) {
    this.config = {
      // Redis 缓存 TTL（秒）
      cacheTTL: config.cacheTTL || 600, // 10 分钟
      // 天气数据缓存 TTL
      weatherCacheTTL: config.weatherCacheTTL || 900, // 15 分钟
      ...config
    };
  }

  /**
   * 生成天气增益的精灵刷新点
   * @param {number} latitude - 纬度
   * @param {number} longitude - 经度
   * @param {string|number} weather - 天气类型或 OpenWeatherMap 代码
   * @returns {Promise<Object>} - 刷新结果
   */
  async generateWeatherBoostedSpawns(latitude, longitude, weather) {
    logger.info({ latitude, longitude, weather }, 'Generating weather-boosted spawns');
    
    // 转换天气代码（如果是数字）
    const gameWeather = typeof weather === 'number' 
      ? mapWeatherCodeToGameWeather(weather)
      : weather;
    
    // 获取基础刷新配置
    const baseSpawns = await this.getBaseSpawnConfig(latitude, longitude);
    
    // 应用天气增益
    const boostedSpawns = weatherBoostEngine.applyWeatherBoost(gameWeather, baseSpawns);
    
    // 过滤掉概率过低的精灵
    const filteredSpawns = boostedSpawns.filter(pokemon => 
      pokemon.spawnProbability >= 0.01 // 至少 1% 概率
    );
    
    // 获取天气增益摘要
    const boostSummary = weatherBoostEngine.getWeatherBoostSummary(gameWeather);
    
    logger.info({ 
      latitude, 
      longitude, 
      weather: gameWeather,
      totalSpawns: filteredSpawns.length,
      boostedTypes: boostSummary.boostedTypes.map(t => t.type)
    }, 'Weather-boosted spawns generated');
    
    return {
      spawns: filteredSpawns,
      weather: {
        condition: gameWeather,
        boostedTypes: boostSummary.boostedTypes,
        spawnMultiplier: boostSummary.spawnMultiplier,
        rareSpawnChance: boostSummary.rarityBoost,
        specialEvent: boostSummary.specialEvent
      },
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 获取基础刷新配置
   * @param {number} latitude - 纬度
   * @param {number} longitude - 经度
   * @returns {Promise<Array>} - 基础刷新列表
   */
  async getBaseSpawnConfig(latitude, longitude) {
    // 从缓存获取
    const cacheKey = `spawn:base:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
    const cached = await getJSON(cacheKey);
    
    if (cached) {
      logger.debug({ latitude, longitude }, 'Base spawn config from cache');
      return cached;
    }
    
    // 从数据库查询该区域的精灵刷新配置
    const result = await query(`
      SELECT 
        p.id,
        p.name,
        p.type,
        p.rarity,
        p.base_spawn_probability as "baseProbability",
        p.min_level as "minLevel",
        p.max_level as "maxLevel"
      FROM pokemon_species p
      WHERE p.is_active = true
      ORDER BY p.base_spawn_probability DESC
      LIMIT 50
    `);
    
    const baseSpawns = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type.toLowerCase(),
      rarity: row.rarity,
      baseProbability: parseFloat(row.baseProbability),
      minLevel: row.minLevel,
      maxLevel: row.maxLevel
    }));
    
    // 缓存结果
    await setJSON(cacheKey, baseSpawns, this.config.cacheTTL);
    
    logger.info({ 
      latitude, 
      longitude, 
      count: baseSpawns.length 
    }, 'Base spawn config loaded');
    
    return baseSpawns;
  }

  /**
   * 选择稀有精灵
   * @param {string} weather - 天气类型
   * @param {number} rarityBoost - 稀有度提升
   * @returns {Promise<Object|null>} - 稀有精灵信息
   */
  async selectRarePokemonForWeather(weather, rarityBoost) {
    const rareTrigger = weatherBoostEngine.checkRareSpawnTrigger(weather);
    
    if (!rareTrigger.triggered) {
      return null;
    }
    
    // 从数据库查询该天气增益类型的稀有精灵
    const boostedTypes = weatherBoostEngine.getBoostedTypes(weather);
    
    const result = await query(`
      SELECT 
        p.id,
        p.name,
        p.type,
        p.rarity,
        p.base_spawn_probability as "baseProbability"
      FROM pokemon_species p
      WHERE p.is_active = true
        AND p.rarity IN ('rare', 'ultra_rare', 'legendary')
        AND p.type = ANY($1)
      ORDER BY RANDOM()
      LIMIT 1
    `, [boostedTypes.map(t => t.toUpperCase())]);
    
    if (result.rows.length === 0) {
      logger.warn({ weather, boostedTypes }, 'No rare pokemon found for weather');
      return null;
    }
    
    const pokemon = result.rows[0];
    
    logger.info({ 
      weather, 
      pokemonId: pokemon.id,
      pokemonName: pokemon.name,
      rarity: pokemon.rarity
    }, 'Rare pokemon selected for weather');
    
    return {
      id: pokemon.id,
      name: pokemon.name,
      type: pokemon.type.toLowerCase(),
      rarity: pokemon.rarity,
      spawnProbability: parseFloat(pokemon.baseProbability) * (1 + rarityBoost)
    };
  }

  /**
   * 获取附近天气增益刷新点
   * @param {number} latitude - 用户纬度
   * @param {number} longitude - 用户经度
   * @param {number} radius - 搜索半径（米）
   * @param {string} weather - 天气类型
   * @returns {Promise<Object>} - 刷新点列表
   */
  async getNearbyWeatherBoostedSpawns(latitude, longitude, radius, weather) {
    logger.info({ latitude, longitude, radius, weather }, 'Getting nearby weather-boosted spawns');
    
    // 生成当前天气的刷新点
    const spawnResult = await this.generateWeatherBoostedSpawns(latitude, longitude, weather);
    
    // 添加位置信息（模拟）
    const spawnPoints = spawnResult.spawns.map((pokemon, index) => {
      // 在用户周围随机分布
      const angle = (index / spawnResult.spawns.length) * 2 * Math.PI;
      const distance = Math.random() * radius;
      const latOffset = (distance * Math.cos(angle)) / 111000;
      const lngOffset = (distance * Math.sin(angle)) / (111000 * Math.cos(latitude * Math.PI / 180));
      
      return {
        ...pokemon,
        lat: latitude + latOffset,
        lng: longitude + lngOffset,
        distance: distance,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 分钟后过期
      };
    });
    
    return {
      spawns: spawnPoints,
      weather: spawnResult.weather,
      location: {
        latitude,
        longitude,
        radius
      },
      generatedAt: spawnResult.generatedAt
    };
  }

  /**
   * 创建天气增益历史记录
   * @param {number} locationId - 位置 ID
   * @param {string} weather - 天气类型
   * @param {Array<string>} boostedTypes - 增益类型
   * @param {number} spawnMultiplier - 刷新倍率
   * @param {boolean} rareSpawnTriggered - 是否触发稀有精灵
   * @returns {Promise<void>}
   */
  async recordWeatherBoostHistory(locationId, weather, boostedTypes, spawnMultiplier, rareSpawnTriggered) {
    try {
      await query(`
        INSERT INTO weather_boost_history (
          location_id,
          weather_condition,
          boosted_types,
          spawn_multiplier,
          rare_spawn_triggered
        ) VALUES ($1, $2, $3, $4, $5)
      `, [locationId, weather, boostedTypes, spawnMultiplier, rareSpawnTriggered]);
      
      logger.info({ locationId, weather }, 'Weather boost history recorded');
    } catch (error) {
      logger.error({ error: error.message, locationId, weather }, 'Failed to record weather boost history');
    }
  }
}

// 导出单例
const weatherBoostSpawnService = new WeatherBoostSpawnService();

module.exports = {
  WeatherBoostSpawnService,
  weatherBoostSpawnService
};
