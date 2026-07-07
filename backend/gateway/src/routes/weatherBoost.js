/**
 * 天气增益 API 路由
 * 提供天气增益信息查询和刷新点生成接口
 * 
 * @module routes/weatherBoost
 */

'use strict';

const express = require('express');
const router = express.Router();
const { weatherBoostSpawnService } = require('../weatherBoostSpawnService');
const { weatherBoostEngine } = require('../../shared/weather/WeatherBoostEngine');
const { mapWeatherCodeToGameWeather, getWeatherConfig } = require('../../shared/weather/WeatherBoostMatrix');
const { createLogger } = require('../../shared/logger');
const { requireAuth } = require('../../gateway/src/middleware/auth');

const logger = createLogger('weather-boost-routes');

/**
 * GET /api/v1/location/spawns/nearby
 * 获取附近天气增益刷新点
 * 
 * Query Parameters:
 * - lat: 纬度
 * - lng: 经度
 * - radius: 搜索半径（米，默认 500）
 * - weather: 天气类型或代码（可选，不提供则查询实时天气）
 */
router.get('/spawns/nearby', requireAuth, async (req, res) => {
  try {
    const { lat, lng, radius = 500, weather } = req.query;
    
    // 参数验证
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_PARAMETERS',
        message: 'Latitude (lat) and longitude (lng) are required'
      });
    }
    
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const searchRadius = parseInt(radius);
    
    // 验证坐标范围
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_COORDINATES',
        message: 'Latitude must be between -90 and 90, longitude between -180 and 180'
      });
    }
    
    // 获取天气（如果没有提供，使用默认晴天）
    const gameWeather = weather 
      ? (typeof weather === 'string' && isNaN(parseInt(weather)) 
        ? weather 
        : mapWeatherCodeToGameWeather(parseInt(weather)))
      : 'clear'; // 默认晴天
    
    logger.info({ 
      userId: req.user.id,
      latitude, 
      longitude, 
      radius: searchRadius, 
      weather: gameWeather 
    }, 'Getting nearby weather-boosted spawns');
    
    // 获取附近天气增益刷新点
    const result = await weatherBoostSpawnService.getNearbyWeatherBoostedSpawns(
      latitude,
      longitude,
      searchRadius,
      gameWeather
    );
    
    // 记录天气增益历史
    await weatherBoostSpawnService.recordWeatherBoostHistory(
      req.user.id,
      gameWeather,
      result.weather.boostedTypes.map(t => t.type),
      result.weather.spawnMultiplier,
      result.weather.specialEvent
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to get nearby spawns');
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/weather/boosts
 * 获取当前天气增益信息
 * 
 * Query Parameters:
 * - weather: 天气类型或代码
 * - lat: 纬度（可选）
 * - lng: 经度（可选）
 */
router.get('/boosts', async (req, res) => {
  try {
    const { weather, lat, lng } = req.query;
    
    // 如果没有提供天气，使用默认晴天
    const gameWeather = weather 
      ? (typeof weather === 'string' && isNaN(parseInt(weather))
        ? weather
        : mapWeatherCodeToGameWeather(parseInt(weather)))
      : 'clear';
    
    // 获取天气增益摘要
    const boostSummary = weatherBoostEngine.getWeatherBoostSummary(gameWeather);
    
    // 计算下次天气变化时间（模拟）
    const nextWeatherChange = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 小时后
    
    logger.info({ 
      weather: gameWeather,
      latitude: lat,
      longitude: lng
    }, 'Weather boost info requested');
    
    res.json({
      success: true,
      data: {
        current_weather: gameWeather,
        boosted_pokemon_types: boostSummary.boostedTypes,
        spawn_multiplier: boostSummary.spawnMultiplier,
        rare_spawn_chance: boostSummary.rarityBoost,
        active_weather_events: boostSummary.specialEvent ? [gameWeather] : [],
        next_weather_change: nextWeatherChange.toISOString(),
        description: boostSummary.description
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get weather boosts');
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/weather/config/:weather
 * 获取特定天气的详细配置
 */
router.get('/config/:weather', async (req, res) => {
  try {
    const { weather } = req.params;
    
    const weatherConfig = getWeatherConfig(weather);
    
    if (!weatherConfig) {
      return res.status(404).json({
        success: false,
        error: 'WEATHER_NOT_FOUND',
        message: `Weather type '${weather}' not found`
      });
    }
    
    res.json({
      success: true,
      data: weatherConfig
    });
  } catch (error) {
    logger.error({ error: error.message, weather: req.params.weather }, 'Failed to get weather config');
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/weather/all
 * 获取所有天气类型及其增益配置
 */
router.get('/all', async (req, res) => {
  try {
    const { WEATHER_BOOST_MATRIX } = require('../../shared/weather/WeatherBoostMatrix');
    
    const allWeathers = Object.entries(WEATHER_BOOST_MATRIX).map(([key, config]) => ({
      weather: key,
      boostedTypes: config.boostedTypes,
      spawnMultiplier: config.spawnMultiplier,
      rarityBoost: config.rarityBoost,
      specialEvent: config.specialEvent,
      description: config.description
    }));
    
    res.json({
      success: true,
      data: {
        total: allWeathers.length,
        weathers: allWeathers
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get all weather types');
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/weather/simulate
 * 模拟天气增益效果（用于测试）
 * 
 * Body:
 * - weather: 天气类型
 * - pokemonTypes: 精灵类型列表
 */
router.post('/simulate', async (req, res) => {
  try {
    const { weather, pokemonTypes } = req.body;
    
    if (!weather || !pokemonTypes || !Array.isArray(pokemonTypes)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT',
        message: 'weather and pokemonTypes (array) are required'
      });
    }
    
    // 计算每个类型的增益系数
    const boostFactors = weatherBoostEngine.calculateBatchBoostFactors(weather, pokemonTypes);
    
    // 获取稀有精灵触发信息
    const rareTrigger = weatherBoostEngine.checkRareSpawnTrigger(weather);
    
    res.json({
      success: true,
      data: {
        weather,
        boostFactors,
        rareSpawnTrigger: rareTrigger,
        weatherSummary: weatherBoostEngine.getWeatherBoostSummary(weather)
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Weather simulation failed');
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

module.exports = router;