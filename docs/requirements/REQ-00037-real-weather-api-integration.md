# REQ-00037：真实天气 API 集成与天气加成系统

- **编号**：REQ-00037
- **类别**：功能增强
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：location-service、catch-service、backend/shared、game-client、frontend
- **创建时间**：2026-06-08 17:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目中的天气系统存在以下问题：

1. **简单时间模拟**：`location-service/src/index.js` 第 55-61 行的 `getWeatherBonus()` 函数仅基于当前小时返回天气状态（SUNNY/FOGGY/CLOUDY），无法反映真实天气变化
2. **缺乏地理位置关联**：天气系统未与真实地理位置关联，无法提供基于 GPS 坐标的真实天气数据
3. **用户体验单一**：玩家无法看到当前真实天气状况，天气加成机制缺乏沉浸感
4. **天气效果不可见**：前端地图界面缺少天气可视化（云层、雨滴、阳光等特效）

根据 STATUS.md 中的未覆盖高价值缺口："天气系统：天气加成只有简单模拟，缺少真实天气 API 集成"，此需求具有较高价值。

## 2. 目标

集成真实天气 API（OpenWeatherMap / WeatherAPI），实现基于玩家 GPS 坐标的实时天气查询和天气加成系统，提升游戏真实感和沉浸感。预期收益：

- 天气加成系统基于真实天气数据，提升游戏真实性
- 玩家可在地图界面查看当前天气状况和天气加成精灵类型
- 天气变化影响精灵出现率和捕捉难度，增加游戏策略性
- 提升用户留存率和游戏时长 15%+

## 3. 范围

- **包含**：
  - 集成 OpenWeatherMap API（免费层，每分钟 60 次调用）
  - 基于玩家 GPS 坐标查询实时天气数据
  - 天气数据缓存策略（Redis 缓存 15 分钟）
  - 扩展天气类型映射到精灵属性加成
  - 前端地图界面天气可视化（图标、动画）
  - 天气 API 失败时的降级策略（回退到时间模拟）
  - Prometheus 监控指标和错误日志

- **不包含**：
  - 多天气 API 提供商切换（Phase 2）
  - 天气历史数据记录和统计分析
  - 基于天气的动态事件触发（如暴风雨期间特殊精灵出现）

## 4. 详细需求

### 4.1 天气 API 服务层（backend/shared/weatherService.js）

```javascript
// 新建模块：backend/shared/weatherService.js
const axios = require('axios');
const { getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');

const logger = createLogger('weather-service');

// OpenWeatherMap API 配置
const API_KEY = process.env.OPENWEATHERMAP_API_KEY;
const BASE_URL = 'https://api.openweathermap.org/data/2.5/weather';
const CACHE_TTL = 900; // 15 分钟缓存

// OpenWeatherMap 天气代码到游戏天气映射
const WEATHER_CODE_MAP = {
  // 晴天
  800: 'SUNNY',
  // 多云
  801: 'CLOUDY', 802: 'CLOUDY',
  // 阴天
  803: 'CLOUDY', 804: 'CLOUDY',
  // 雨
  500: 'RAINY', 501: 'RAINY', 502: 'RAINY', 503: 'RAINY', 504: 'RAINY',
  511: 'RAINY', 520: 'RAINY', 521: 'RAINY', 522: 'RAINY', 531: 'RAINY',
  300: 'RAINY', 301: 'RAINY', 302: 'RAINY', 310: 'RAINY', 311: 'RAINY', 
  312: 'RAINY', 313: 'RAINY', 314: 'RAINY', 321: 'RAINY',
  // 雪
  600: 'SNOWY', 601: 'SNOWY', 602: 'SNOWY', 611: 'SNOWY', 612: 'SNOWY',
  613: 'SNOWY', 615: 'SNOWY', 616: 'SNOWY', 620: 'SNOWY', 621: 'SNOWY',
  622: 'SNOWY',
  // 大风
  952: 'WINDY', 953: 'WINDY', 954: 'WINDY', 955: 'WINDY', 956: 'WINDY',
  957: 'WINDY', 958: 'WINDY', 959: 'WINDY',
  // 雾
  701: 'FOGGY', 711: 'FOGGY', 721: 'FOGGY', 731: 'FOGGY', 741: 'FOGGY',
  751: 'FOGGY', 761: 'FOGGY', 762: 'FOGGY', 771: 'FOGGY',
  // 雷暴归为雨天
  200: 'RAINY', 201: 'RAINY', 202: 'RAINY', 210: 'RAINY', 211: 'RAINY',
  212: 'RAINY', 221: 'RAINY', 230: 'RAINY', 231: 'RAINY', 232: 'RAINY'
};

/**
 * 获取指定坐标的真实天气
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @returns {Promise<{weather: string, temperature: number, humidity: number, description: string}>}
 */
async function getWeather(lat, lng) {
  // 1. 尝试从缓存读取
  const cacheKey = `weather:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = await getJSON(cacheKey);
  if (cached) {
    logger.debug({ lat, lng, cached: true }, 'Weather cache hit');
    return cached;
  }

  // 2. 调用 OpenWeatherMap API
  try {
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
      temperature: data.main?.temp || 20,
      humidity: data.main?.humidity || 50,
      windSpeed: data.wind?.speed || 0,
      description: data.weather[0]?.description || '多云',
      icon: data.weather[0]?.icon || '02d',
      weatherCode,
      location: data.name || 'Unknown',
      updatedAt: new Date().toISOString()
    };

    // 3. 缓存结果
    await setJSON(cacheKey, result, CACHE_TTL);
    logger.info({ lat, lng, weather: gameWeather }, 'Weather fetched from API');

    return result;
  } catch (error) {
    logger.error({ lat, lng, error: error.message }, 'Weather API failed, using fallback');
    
    // 4. 降级策略：回退到时间模拟
    return getFallbackWeather(lat, lng);
  }
}

/**
 * 降级策略：基于时间模拟天气
 */
function getFallbackWeather(lat, lng) {
  const hour = new Date().getHours();
  let weather;
  
  if (hour < 6 || hour > 20) weather = 'FOGGY';
  else if (hour > 10 && hour < 15) weather = 'SUNNY';
  else weather = 'CLOUDY';
  
  return {
    weather,
    temperature: 20,
    humidity: 50,
    windSpeed: 0,
    description: '天气数据不可用',
    icon: '02d',
    weatherCode: 802,
    location: 'Unknown',
    updatedAt: new Date().toISOString(),
    fallback: true
  };
}

module.exports = { getWeather, WEATHER_CODE_MAP };
```

### 4.2 修改 location-service 集成天气服务

修改 `backend/services/location-service/src/index.js`：

```javascript
// 第 11 行后添加
const { getWeather } = require('../../../shared/weatherService');

// 替换第 55-61 行的 getWeatherBonus 函数
async function getWeatherBonus(lat, lng) {
  const weatherData = await getWeather(lat, lng);
  return weatherData.weather;
}

// 第 93 行附近，spawnPokemonForPoint 函数中添加天气详情
async function spawnPokemonForPoint(spawnPointId, lat, lng, biome) {
  // ... 原有代码 ...
  
  const weatherData = await getWeather(lat, lng);
  const weatherBoosted = (WEATHER_BONUS[weatherData.weather] || []).some(t => chosen.type1 === t);

  // ... 原有代码 ...
  
  // 保存时添加天气信息
  const payload = { 
    ...wild, 
    spawnPointId,
    weather: weatherData.weather,
    weatherDescription: weatherData.description,
    temperature: weatherData.temperature
  };
  
  // ... 后续代码 ...
}
```

### 4.3 新增天气查询 API

在 `backend/services/location-service/src/index.js` 添加新路由：

```javascript
// GET /map/weather — 获取当前天气
app.get('/map/weather', requireAuth, async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      throw new AppError(1001, 'lat/lng 无效', 400);
    }
    
    const weatherData = await getWeather(lat, lng);
    
    // 获取受天气加成的精灵类型
    const boostedTypes = WEATHER_BONUS[weatherData.weather] || [];
    
    res.json(successResp({
      ...weatherData,
      boostedTypes,
      boostedTypesZh: boostedTypes.map(t => getTypeNameZh(t))
    }));
  } catch (err) { next(err); }
});

// 辅助函数：类型名称映射
function getTypeNameZh(type) {
  const typeNames = {
    FIRE: '火', GRASS: '草', GROUND: '地面',
    WATER: '水', ELECTRIC: '电', BUG: '虫',
    NORMAL: '普通', POISON: '毒', FAIRY: '妖精',
    ICE: '冰', STEEL: '钢',
    DRAGON: '龙', FLYING: '飞行', PSYCHIC: '超能',
    GHOST: '幽灵', DARK: '恶'
  };
  return typeNames[type] || type;
}
```

### 4.4 前端天气可视化组件

新建 `frontend/game-client/src/components/WeatherWidget.js`：

```javascript
/**
 * 天气组件 - 显示当前天气和加成信息
 */
class WeatherWidget {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.weatherData = null;
  }

  async fetchWeather(lat, lng) {
    try {
      const response = await fetch(
        `${API_BASE_URL}/map/weather?lat=${lat}&lng=${lng}`,
        { headers: { 'Authorization': `Bearer ${getToken()}` } }
      );
      const data = await response.json();
      this.weatherData = data.data;
      this.render();
    } catch (error) {
      console.error('Failed to fetch weather:', error);
    }
  }

  render() {
    if (!this.weatherData || !this.container) return;

    const { weather, description, temperature, boostedTypes, boostedTypesZh } = this.weatherData;
    const iconUrl = this.getWeatherIcon(weather);

    this.container.innerHTML = `
      <div class="weather-widget" role="region" aria-label="当前天气">
        <div class="weather-icon" aria-hidden="true">${this.getWeatherEmoji(weather)}</div>
        <div class="weather-info">
          <div class="weather-status">${description} ${Math.round(temperature)}°C</div>
          ${boostedTypes.length > 0 ? `
            <div class="weather-bonus">
              <span class="bonus-label">天气加成：</span>
              <span class="bonus-types">${boostedTypesZh.join(' / ')}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    this.applyWeatherEffects(weather);
  }

  getWeatherEmoji(weather) {
    const emojis = {
      SUNNY: '☀️',
      CLOUDY: '☁️',
      RAINY: '🌧️',
      SNOWY: '❄️',
      WINDY: '💨',
      FOGGY: '🌫️'
    };
    return emojis[weather] || '🌤️';
  }

  getWeatherIcon(weather) {
    return `https://openweathermap.org/img/wn/${this.weatherData.icon}@2x.png`;
  }

  applyWeatherEffects(weather) {
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) return;

    // 移除旧天气效果
    mapContainer.classList.remove('weather-sunny', 'weather-cloudy', 'weather-rainy', 
                                   'weather-snowy', 'weather-windy', 'weather-foggy');
    
    // 添加新天气效果
    mapContainer.classList.add(`weather-${weather.toLowerCase()}`);
  }
}

module.exports = WeatherWidget;
```

### 4.5 天气效果样式

新建 `frontend/game-client/src/styles/weather.css`：

```css
/* 天气效果样式 */
.weather-sunny {
  filter: brightness(1.1) saturate(1.1);
}

.weather-cloudy {
  filter: brightness(0.95) saturate(0.95);
}

.weather-rainy::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(transparent 0%, rgba(100, 150, 200, 0.1) 100%);
  pointer-events: none;
  animation: rain 0.5s linear infinite;
}

@keyframes rain {
  0% { background-position: 0 0; }
  100% { background-position: 20px 40px; }
}

.weather-snowy::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: radial-gradient(circle, rgba(255,255,255,0.3) 1px, transparent 1px);
  background-size: 50px 50px;
  pointer-events: none;
  animation: snow 3s linear infinite;
}

@keyframes snow {
  0% { background-position: 0 0; }
  100% { background-position: 50px 50px; }
}

.weather-widget {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.weather-icon {
  font-size: 32px;
}

.weather-status {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.weather-bonus {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
}

.bonus-types {
  color: #4CAF50;
  font-weight: 600;
}
```

### 4.6 环境变量配置

在 `.env.example` 和 Kubernetes ConfigMap 中添加：

```bash
# OpenWeatherMap API 配置
OPENWEATHERMAP_API_KEY=your_api_key_here
OPENWEATHERMAP_CACHE_TTL=900
```

## 5. 验收标准（可测试）

- [ ] 集成 OpenWeatherMap API，支持基于 GPS 坐标的实时天气查询
- [ ] 天气数据缓存 15 分钟，缓存命中率 > 90%
- [ ] API 失败时自动降级到时间模拟策略，不影响游戏正常运行
- [ ] 前端地图界面显示当前天气图标、温度和加成精灵类型
- [ ] 天气加成系统正确映射到 7 种游戏天气（SUNNY/RAINY/CLOUDY/SNOWY/WINDY/FOGGY）
- [ ] 天气变化影响精灵生成，天气加成精灵出现率提升 20%+
- [ ] 新增 Prometheus 监控指标：weather_api_requests_total, weather_api_errors_total, weather_cache_hits, weather_cache_misses
- [ ] 单元测试覆盖率 > 85%，包括 API 调用、缓存策略、降级逻辑
- [ ] 在地图界面添加天气组件，支持 i18n 多语言显示
- [ ] 天气 API 调用失败时记录错误日志，包含请求参数和错误详情

## 6. 工作量估算

**L** - 大型需求

理由：
- 涉及后端服务改造、新模块开发、前端组件开发、样式设计
- 需要集成第三方 API，处理失败降级和缓存策略
- 需要修改精灵生成逻辑，增加天气影响因子
- 前端需要新增组件和天气效果动画
- 预计开发时间：2-3 天

## 7. 优先级理由

**P1** - 高优先级

理由：
- 天气系统是游戏核心机制之一，直接影响游戏真实感和沉浸感
- 当前简单模拟方案影响用户体验，属于高价值缺口
- 实现后可显著提升用户留存率和游戏时长
- 技术难度适中，风险可控
- 不依赖其他未完成需求，可独立开发
