/**
 * 天气服务模块 - 集成 OpenWeatherMap API
 * 提供基于 GPS 坐标的实时天气查询和天气加成系统
 * 
 * @module weatherService
 * @requires axios
 * @requires ../redis
 * @requires ../logger
 */

const axios = require('axios');
const { getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('weather-service');

// OpenWeatherMap API 配置
const API_KEY = process.env.OPENWEATHERMAP_API_KEY;
const BASE_URL = 'https://api.openweathermap.org/data/2.5/weather';
const CACHE_TTL = parseInt(process.env.OPENWEATHERMAP_CACHE_TTL || '900', 10); // 默认 15 分钟

// OpenWeatherMap 天气代码到游戏天气映射
const WEATHER_CODE_MAP = {
  // 晴天 (Clear)
  800: 'SUNNY',
  
  // 多云 (Clouds)
  801: 'CLOUDY', 802: 'CLOUDY', 803: 'CLOUDY', 804: 'CLOUDY',
  
  // 雨 (Rain, Drizzle)
  500: 'RAINY', 501: 'RAINY', 502: 'RAINY', 503: 'RAINY', 504: 'RAINY',
  511: 'RAINY', 520: 'RAINY', 521: 'RAINY', 522: 'RAINY', 531: 'RAINY',
  300: 'RAINY', 301: 'RAINY', 302: 'RAINY', 310: 'RAINY', 311: 'RAINY', 
  312: 'RAINY', 313: 'RAINY', 314: 'RAINY', 321: 'RAINY',
  
  // 雪 (Snow)
  600: 'SNOWY', 601: 'SNOWY', 602: 'SNOWY', 611: 'SNOWY', 612: 'SNOWY',
  613: 'SNOWY', 615: 'SNOWY', 616: 'SNOWY', 620: 'SNOWY', 621: 'SNOWY',
  622: 'SNOWY',
  
  // 大风 (Wind)
  952: 'WINDY', 953: 'WINDY', 954: 'WINDY', 955: 'WINDY', 956: 'WINDY',
  957: 'WINDY', 958: 'WINDY', 959: 'WINDY',
  
  // 雾 (Atmosphere: Mist, Fog, Haze, etc.)
  701: 'FOGGY', 711: 'FOGGY', 721: 'FOGGY', 731: 'FOGGY', 741: 'FOGGY',
  751: 'FOGGY', 761: 'FOGGY', 762: 'FOGGY', 771: 'FOGGY',
  
  // 雷暴 (Thunderstorm) 归为雨天
  200: 'RAINY', 201: 'RAINY', 202: 'RAINY', 210: 'RAINY', 211: 'RAINY',
  212: 'RAINY', 221: 'RAINY', 230: 'RAINY', 231: 'RAINY', 232: 'RAINY'
};

// 游戏天气对应的精灵属性加成
const WEATHER_BONUS = {
  SUNNY:  ['FIRE', 'GRASS', 'GROUND'],
  RAINY:  ['WATER', 'ELECTRIC', 'BUG'],
  CLOUDY: ['NORMAL', 'POISON', 'FAIRY'],
  SNOWY:  ['ICE', 'STEEL'],
  WINDY:  ['DRAGON', 'FLYING', 'PSYCHIC'],
  FOGGY:  ['GHOST', 'DARK']
};

// 类型名称映射（中文）
const TYPE_NAMES_ZH = {
  FIRE: '火', GRASS: '草', GROUND: '地面',
  WATER: '水', ELECTRIC: '电', BUG: '虫',
  NORMAL: '普通', POISON: '毒', FAIRY: '妖精',
  ICE: '冰', STEEL: '钢',
  DRAGON: '龙', FLYING: '飞行', PSYCHIC: '超能',
  GHOST: '幽灵', DARK: '恶'
};

// Prometheus 指标
let weatherApiRequestsTotal = null;
let weatherApiErrorsTotal = null;
let weatherCacheHits = null;
let weatherCacheMisses = null;

/**
 * 初始化 Prometheus 指标
 */
function initMetrics() {
  try {
    weatherApiRequestsTotal = metrics.register.getSingleMetric('weather_api_requests_total') ||
      new metrics.client.Counter({
        name: 'weather_api_requests_total',
        help: 'Total number of weather API requests',
        registers: [metrics.register]
      });

    weatherApiErrorsTotal = metrics.register.getSingleMetric('weather_api_errors_total') ||
      new metrics.client.Counter({
        name: 'weather_api_errors_total',
        help: 'Total number of weather API errors',
        registers: [metrics.register]
      });

    weatherCacheHits = metrics.register.getSingleMetric('weather_cache_hits') ||
      new metrics.client.Counter({
        name: 'weather_cache_hits',
        help: 'Total number of weather cache hits',
        registers: [metrics.register]
      });

    weatherCacheMisses = metrics.register.getSingleMetric('weather_cache_misses') ||
      new metrics.client.Counter({
        name: 'weather_cache_misses',
        help: 'Total number of weather cache misses',
        registers: [metrics.register]
      });
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize weather metrics');
  }
}

// 立即初始化指标
initMetrics();

/**
 * 获取指定坐标的真实天气
 * 
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @returns {Promise<{weather: string, temperature: number, humidity: number, description: string, ...}>}
 */
async function getWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('Invalid lat/lng parameters');
  }

  // 精度缓存键（保留 2 位小数，约 1km 精度）
  const cacheKey = `weather:${lat.toFixed(2)}:${lng.toFixed(2)}`;

  // 1. 尝试从缓存读取
  try {
    const cached = await getJSON(cacheKey);
    if (cached && cached.weather) {
      if (weatherCacheHits) weatherCacheHits.inc();
      logger.debug({ lat, lng, cached: true, weather: cached.weather }, 'Weather cache hit');
      return cached;
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, 'Failed to read weather cache');
  }

  if (weatherCacheMisses) weatherCacheMisses.inc();

  // 2. 检查 API Key 是否配置
  if (!API_KEY) {
    logger.warn('OpenWeatherMap API key not configured, using fallback');
    return getFallbackWeather(lat, lng);
  }

  // 3. 调用 OpenWeatherMap API
  try {
    if (weatherApiRequestsTotal) weatherApiRequestsTotal.inc();

    const response = await axios.get(BASE_URL, {
      params: {
        lat,
        lon: lng,
        appid: API_KEY,
        units: 'metric',
        lang: 'zh_cn'
      },
      timeout: 5000
    });

    const data = response.data;
    const weatherCode = data.weather[0]?.id || 800;
    const gameWeather = WEATHER_CODE_MAP[weatherCode] || 'CLOUDY';

    const result = {
      weather: gameWeather,
      temperature: Math.round(data.main?.temp || 20),
      humidity: data.main?.humidity || 50,
      windSpeed: Math.round((data.wind?.speed || 0) * 3.6), // m/s to km/h
      description: data.weather[0]?.description || '多云',
      icon: data.weather[0]?.icon || '02d',
      weatherCode,
      location: data.name || 'Unknown',
      updatedAt: new Date().toISOString(),
      fallback: false
    };

    // 4. 缓存结果
    try {
      await setJSON(cacheKey, result, CACHE_TTL);
    } catch (cacheErr) {
      logger.warn({ cacheErr, cacheKey }, 'Failed to cache weather data');
    }

    logger.info({ 
      lat, lng, 
      weather: gameWeather, 
      temperature: result.temperature,
      location: result.location 
    }, 'Weather fetched from API');

    return result;
  } catch (error) {
    if (weatherApiErrorsTotal) weatherApiErrorsTotal.inc();
    
    logger.error({ 
      lat, lng, 
      error: error.message,
      status: error.response?.status 
    }, 'Weather API failed, using fallback');

    // 5. 降级策略：回退到时间模拟
    return getFallbackWeather(lat, lng);
  }
}

/**
 * 降级策略：基于时间模拟天气
 * 
 * @param {number} lat 纬度（未使用，保留参数用于未来扩展）
 * @param {number} lng 经度（未使用，保留参数用于未来扩展）
 * @returns {Object} 模拟的天气数据
 */
function getFallbackWeather(lat, lng) {
  const hour = new Date().getHours();
  const month = new Date().getMonth();
  
  let weather;
  let temperature = 20;
  let description;
  
  // 基于时间模拟天气
  if (hour < 6 || hour > 20) {
    weather = 'FOGGY';
    description = '夜晚有雾';
    temperature = 15;
  } else if (hour > 10 && hour < 15) {
    // 夏季更热
    if (month >= 5 && month <= 8) {
      weather = 'SUNNY';
      description = '晴朗炎热';
      temperature = 32;
    } else {
      weather = 'SUNNY';
      description = '晴朗';
      temperature = 25;
    }
  } else {
    weather = 'CLOUDY';
    description = '多云';
    temperature = 22;
  }
  
  // 冬季降温
  if (month >= 11 || month <= 1) {
    temperature = Math.max(temperature - 15, -5);
    if (weather === 'SUNNY') {
      weather = 'SNOWY';
      description = '雪天';
    }
  }
  
  return {
    weather,
    temperature,
    humidity: 50,
    windSpeed: 5,
    description: `${description} (模拟数据)`,
    icon: getWeatherIcon(weather),
    weatherCode: 0,
    location: 'Unknown',
    updatedAt: new Date().toISOString(),
    fallback: true
  };
}

/**
 * 获取天气图标代码
 * 
 * @param {string} weather 游戏天气类型
 * @returns {string} OpenWeatherMap 图标代码
 */
function getWeatherIcon(weather) {
  const iconMap = {
    SUNNY: '01d',
    CLOUDY: '03d',
    RAINY: '10d',
    SNOWY: '13d',
    WINDY: '50d',
    FOGGY: '50d'
  };
  return iconMap[weather] || '02d';
}

/**
 * 获取天气加成的精灵类型列表
 * 
 * @param {string} weather 游戏天气类型
 * @returns {Array<string>} 受加成的精灵类型数组
 */
function getBoostedTypes(weather) {
  return WEATHER_BONUS[weather] || [];
}

/**
 * 获取精灵类型的中文名称
 * 
 * @param {string} type 精灵类型（英文）
 * @returns {string} 中文名称
 */
function getTypeNameZh(type) {
  return TYPE_NAMES_ZH[type] || type;
}

/**
 * 检查指定精灵类型是否受当前天气加成
 * 
 * @param {string} pokemonType 精灵类型
 * @param {string} weather 当前天气
 * @returns {boolean} 是否受加成
 */
function isWeatherBoosted(pokemonType, weather) {
  const boostedTypes = WEATHER_BONUS[weather] || [];
  return boostedTypes.includes(pokemonType);
}

module.exports = {
  getWeather,
  getFallbackWeather,
  getBoostedTypes,
  getTypeNameZh,
  isWeatherBoosted,
  WEATHER_CODE_MAP,
  WEATHER_BONUS,
  TYPE_NAMES_ZH
};
