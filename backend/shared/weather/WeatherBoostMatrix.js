/**
 * 天气增益矩阵配置
 * 定义天气类型与精灵属性的对应关系
 * 
 * @module weather/WeatherBoostMatrix
 */

'use strict';

/**
 * 天气增益矩阵
 * 天气类型 -> 增益精灵类型、刷新倍率、稀有度提升
 */
const WEATHER_BOOST_MATRIX = {
  // 晴天 - 火系、草系、地面系
  clear: {
    id: 'clear',
    boostedTypes: ['fire', 'grass', 'ground'],
    spawnMultiplier: 1.5,      // 刷新概率提升 50%
    rarityBoost: 0.1,           // 稀有精灵概率提升 10%
    specialEvent: false,
    description: '晴天：火系、草系、地面系精灵更活跃'
  },
  
  // 雨天 - 水系、电系、虫系
  rain: {
    id: 'rain',
    boostedTypes: ['water', 'electric', 'bug'],
    spawnMultiplier: 1.6,      // 刷新概率提升 60%
    rarityBoost: 0.15,         // 稀有精灵概率提升 15%
    specialEvent: false,
    description: '雨天：水系、电系、虫系精灵更活跃'
  },
  
  // 阴天 - 妖精系、格斗系、毒系
  cloudy: {
    id: 'cloudy',
    boostedTypes: ['fairy', 'fighting', 'poison'],
    spawnMultiplier: 1.3,      // 刷新概率提升 30%
    rarityBoost: 0.05,         // 稀有精灵概率提升 5%
    specialEvent: false,
    description: '阴天：妖精系、格斗系、毒系精灵更活跃'
  },
  
  // 大风 - 龙系、飞行系、超能系
  windy: {
    id: 'windy',
    boostedTypes: ['dragon', 'flying', 'psychic'],
    spawnMultiplier: 1.4,      // 刷新概率提升 40%
    rarityBoost: 0.2,          // 稀有精灵概率提升 20%
    specialEvent: false,
    description: '大风：龙系、飞行系、超能系精灵更活跃'
  },
  
  // 雾天 - 幽灵系、恶系（特殊天气，稀有精灵概率更高）
  fog: {
    id: 'fog',
    boostedTypes: ['ghost', 'dark'],
    spawnMultiplier: 1.8,      // 刷新概率提升 80%
    rarityBoost: 0.3,          // 稀有精灵概率提升 30%
    specialEvent: true,        // 特殊天气事件
    description: '雾天：幽灵系、恶系精灵更活跃，稀有精灵概率大幅提升'
  },
  
  // 雪天 - 冰系、钢系（特殊天气）
  snow: {
    id: 'snow',
    boostedTypes: ['ice', 'steel'],
    spawnMultiplier: 1.7,      // 刷新概率提升 70%
    rarityBoost: 0.25,         // 稀有精灵概率提升 25%
    specialEvent: true,        // 特殊天气事件
    description: '雪天：冰系、钢系精灵更活跃，稀有精灵概率大幅提升'
  },
  
  // 暴风雨 - 电系、水系、龙系（极端天气，最高增益）
  thunderstorm: {
    id: 'thunderstorm',
    boostedTypes: ['electric', 'water', 'dragon'],
    spawnMultiplier: 2.0,      // 刷新概率提升 100%
    rarityBoost: 0.4,         // 稀有精灵概率提升 40%
    specialEvent: true,        // 特殊天气事件
    description: '暴风雨：电系、水系、龙系精灵极度活跃，稀有精灵概率大幅提升'
  }
};

/**
 * OpenWeatherMap 天气代码到游戏天气的映射
 */
const WEATHER_CODE_TO_GAME_WEATHER = {
  // 晴天 (Clear)
  800: 'clear',
  
  // 多云 (Clouds) - 根据云量区分
  801: 'clear',   // 少云
  802: 'cloudy',  // 碎云
  803: 'cloudy',  // 碎云
  804: 'cloudy',  // 阴天
  
  // 雨 (Rain)
  500: 'rain',    // 小雨
  501: 'rain',    // 中雨
  502: 'rain',    // 大雨
  503: 'rain',    // 暴雨
  504: 'rain',    // 极端暴雨
  511: 'rain',    // 冻雨
  520: 'rain',    // 小阵雨
  521: 'rain',    // 阵雨
  522: 'rain',    // 大阵雨
  531: 'rain',    // 不规则阵雨
  
  // 细雨 (Drizzle)
  300: 'rain',    // 细雨
  301: 'rain',
  302: 'rain',
  310: 'rain',
  311: 'rain',
  312: 'rain',
  313: 'rain',
  314: 'rain',
  321: 'rain',
  
  // 雪 (Snow)
  600: 'snow',    // 小雪
  601: 'snow',    // 中雪
  602: 'snow',    // 大雪
  611: 'snow',    // 雨夹雪
  612: 'snow',    // 阵雪
  613: 'snow',
  615: 'snow',    // 小雨雪
  616: 'snow',    // 雨雪
  620: 'snow',    // 小阵雪
  621: 'snow',    // 阵雪
  622: 'snow',    // 大阵雪
  
  // 大风 (Wind) - 风速等级
  952: 'windy',   // 轻风
  953: 'windy',   // 微风
  954: 'windy',   // 和风
  955: 'windy',   // 清风
  956: 'windy',   // 强风
  957: 'windy',   // 疾风
  958: 'windy',   // 大风
  959: 'windy',   // 烈风
  
  // 雾 (Atmosphere)
  701: 'fog',     // 雾
  711: 'fog',     // 烟雾
  721: 'fog',     // 霾
  731: 'fog',     // 沙尘
  741: 'fog',     // 雾
  751: 'fog',     // 沙暴
  761: 'fog',     // 尘暴
  762: 'fog',     // 火山灰
  771: 'windy',   // 阵风
  
  // 雷暴 (Thunderstorm)
  200: 'thunderstorm',  // 雷暴伴小雨
  201: 'thunderstorm',  // 雷暴伴雨
  202: 'thunderstorm',  // 雷暴伴大雨
  210: 'thunderstorm',  // 轻雷暴
  211: 'thunderstorm',  // 雷暴
  212: 'thunderstorm',  // 强雷暴
  221: 'thunderstorm',  // 不规则雷暴
  230: 'thunderstorm',  // 雷暴伴细雨
  231: 'thunderstorm',
  232: 'thunderstorm'   // 雷暴伴大细雨
};

/**
 * 精灵类型到中文名称的映射
 */
const POKEMON_TYPE_NAMES = {
  fire: '火',
  water: '水',
  grass: '草',
  electric: '电',
  bug: '虫',
  normal: '普通',
  poison: '毒',
  fairy: '妖精',
  fighting: '格斗',
  ice: '冰',
  steel: '钢',
  dragon: '龙',
  flying: '飞行',
  psychic: '超能',
  ghost: '幽灵',
  dark: '恶',
  ground: '地面',
  rock: '岩石'
};

/**
 * 获取天气配置
 * @param {string} weather - 天气类型
 * @returns {Object|null} 天气配置
 */
function getWeatherConfig(weather) {
  return WEATHER_BOOST_MATRIX[weather] || null;
}

/**
 * 根据天气代码获取游戏天气
 * @param {number} weatherCode - OpenWeatherMap 天气代码
 * @returns {string} 游戏天气类型
 */
function mapWeatherCodeToGameWeather(weatherCode) {
  return WEATHER_CODE_TO_GAME_WEATHER[weatherCode] || 'clear';
}

/**
 * 获取所有特殊天气事件
 * @returns {Array<string>} 特殊天气类型列表
 */
function getSpecialWeatherEvents() {
  return Object.entries(WEATHER_BOOST_MATRIX)
    .filter(([_, config]) => config.specialEvent)
    .map(([weather, _]) => weather);
}

/**
 * 检查天气是否为特殊天气
 * @param {string} weather - 天气类型
 * @returns {boolean} 是否为特殊天气
 */
function isSpecialWeather(weather) {
  const config = WEATHER_BOOST_MATRIX[weather];
  return config ? config.specialEvent : false;
}

/**
 * 获取天气增益的精灵类型列表
 * @param {string} weather - 天气类型
 * @returns {Array<string>} 增益精灵类型列表
 */
function getBoostedTypes(weather) {
  const config = WEATHER_BOOST_MATRIX[weather];
  return config ? config.boostedTypes : [];
}

/**
 * 获取精灵类型的中文名称
 * @param {string} type - 精灵类型
 * @returns {string} 中文名称
 */
function getTypeName(type) {
  return POKEMON_TYPE_NAMES[type] || type;
}

module.exports = {
  WEATHER_BOOST_MATRIX,
  WEATHER_CODE_TO_GAME_WEATHER,
  POKEMON_TYPE_NAMES,
  getWeatherConfig,
  mapWeatherCodeToGameWeather,
  getSpecialWeatherEvents,
  isSpecialWeather,
  getBoostedTypes,
  getTypeName
};
