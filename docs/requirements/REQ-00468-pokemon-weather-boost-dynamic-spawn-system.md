# REQ-00468：精灵天气增益与动态刷新系统

- **编号**：REQ-00468
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：location-service、pokemon-service、backend/shared/weather
- **创建时间**：2026-07-07 02:00 UTC
- **依赖需求**：REQ-00037（实时天气API集成）

## 1. 背景与问题

当前精灵刷新系统已实现基础功能，但缺少真实天气对精灵生态的影响机制：

1. **天气数据未深度利用**：REQ-00037 已集成天气API，但仅用于显示，未影响游戏玩法
2. **缺少天气增益机制**：雨天出现水系精灵概率应提升，晴天火系精灵更活跃
3. **动态刷新不够智能**：精灵刷新频率固定，未根据天气条件调整
4. **缺少天气事件系统**：特殊天气（暴风雨、浓雾）应有独特精灵出现机会

**代码现状**：
- `weatherService.js`：获取天气数据但未与精灵系统联动
- `spawnService.js`：刷新逻辑未考虑天气因素
- `location-service`：缺少天气驱动的刷新策略

## 2. 目标

构建完整的天气-精灵联动系统：

1. **天气增益矩阵**：定义天气类型与精灵属性的对应关系
2. **动态刷新调整**：根据实时天气调整精灵刷新概率和类型分布
3. **稀有天气事件**：特殊天气触发稀有精灵刷新
4. **客户端天气提示**：显示当前天气增益效果，提升玩家体验
5. **性能优化**：缓存天气数据，避免频繁API调用

## 3. 范围

### 包含
- 天气类型到精灵属性的映射配置
- 天气增益概率计算引擎
- 动态刷新策略调整
- 特殊天气事件触发器
- 天气增益前端提示API
- 单元测试与集成测试
- 管理后台天气规则配置

### 不包含
- 天气数据获取（REQ-00037 已完成）
- 精灵基础刷新系统（已实现）
- 天气预报功能（未来需求）

## 4. 详细需求

### 4.1 天气增益矩阵配置

```javascript
// backend/shared/weather/WeatherBoostMatrix.js
const WEATHER_BOOST_MATRIX = {
  clear: {        // 晴天
    boostedTypes: ['fire', 'grass', 'ground'],
    spawnMultiplier: 1.5,
    rarityBoost: 0.1
  },
  rain: {         // 雨天
    boostedTypes: ['water', 'electric', 'bug'],
    spawnMultiplier: 1.6,
    rarityBoost: 0.15
  },
  cloudy: {       // 阴天
    boostedTypes: ['fairy', 'fighting', 'poison'],
    spawnMultiplier: 1.3,
    rarityBoost: 0.05
  },
  windy: {        // 大风
    boostedTypes: ['dragon', 'flying', 'psychic'],
    spawnMultiplier: 1.4,
    rarityBoost: 0.2
  },
  fog: {          // 雾天
    boostedTypes: ['ghost', 'dark'],
    spawnMultiplier: 1.8,
    rarityBoost: 0.3
  },
  snow: {         // 雪天
    boostedTypes: ['ice', 'steel'],
    spawnMultiplier: 1.7,
    rarityBoost: 0.25
  },
  thunderstorm: { // 暴风雨
    boostedTypes: ['electric', 'water', 'dragon'],
    spawnMultiplier: 2.0,
    rarityBoost: 0.4
  }
};
```

### 4.2 天气增益计算引擎

```javascript
// backend/shared/weather/WeatherBoostEngine.js
class WeatherBoostEngine {
  /**
   * 计算天气增益后的精灵刷新概率
   * @param {string} weather - 当前天气
   * @param {string} pokemonType - 精灵属性
   * @returns {number} - 增益系数
   */
  calculateBoostFactor(weather, pokemonType) {
    const config = WEATHER_BOOST_MATRIX[weather];
    if (!config) return 1.0;
    
    return config.boostedTypes.includes(pokemonType) 
      ? config.spawnMultiplier 
      : 0.7; // 非增益属性降低概率
  }

  /**
   * 判断是否触发稀有精灵刷新
   * @param {string} weather - 当前天气
   * @returns {object} - { triggered: boolean, rarityBoost: number }
   */
  checkRareSpawnTrigger(weather) {
    const config = WEATHER_BOOST_MATRIX[weather];
    if (!config) return { triggered: false, rarityBoost: 0 };
    
    // 特殊天气有更高稀有精灵刷新概率
    const isSpecialWeather = ['fog', 'thunderstorm', 'snow'].includes(weather);
    return {
      triggered: isSpecialWeather,
      rarityBoost: config.rarityBoost
    };
  }
}
```

### 4.3 动态刷新策略

修改 `location-service/src/SpawnService.js`：

```javascript
async generateSpawnPoint(latitude, longitude, weather) {
  const boostEngine = new WeatherBoostEngine();
  const baseSpawn = await this.getBaseSpawnConfig();
  
  // 应用天气增益
  const boostedSpawn = baseSpawn.pokemons.map(pokemon => {
    const boostFactor = boostEngine.calculateBoostFactor(weather, pokemon.type);
    return {
      ...pokemon,
      spawnProbability: pokemon.baseProbability * boostFactor
    };
  });
  
  // 检查稀有精灵触发
  const rareTrigger = boostEngine.checkRareSpawnTrigger(weather);
  if (rareTrigger.triggered) {
    const rarePokemon = await this.selectRarePokemon(rareTrigger.rarityBoost);
    boostedSpawn.push(rarePokemon);
  }
  
  return boostedSpawn;
}
```

### 4.4 API 设计

#### GET /api/v1/location/spawns/nearby?lat={lat}&lng={lng}
```json
{
  "spawns": [
    {
      "pokemon_id": 25,
      "name": "Pikachu",
      "type": "electric",
      "lat": 31.2304,
      "lng": 121.4737,
      "weather_boosted": true,
      "boost_type": "rain",
      "spawn_multiplier": 1.6,
      "expires_at": "2026-07-07T03:00:00Z"
    }
  ],
  "weather": {
    "condition": "rain",
    "boosted_types": ["water", "electric", "bug"],
    "special_event": false
  }
}
```

#### GET /api/v1/weather/boosts
```json
{
  "current_weather": "rain",
  "boosted_pokemon_types": ["water", "electric", "bug"],
  "spawn_multiplier": 1.6,
  "rare_spawn_chance": 0.15,
  "active_weather_events": [],
  "next_weather_change": "2026-07-07T06:00:00Z"
}
```

### 4.5 数据库设计

```sql
-- 天气增益历史记录
CREATE TABLE weather_boost_history (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL,
  weather_condition VARCHAR(50) NOT NULL,
  boosted_types TEXT[] NOT NULL,
  spawn_multiplier DECIMAL(3,2) NOT NULL,
  rare_spawn_triggered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_weather_history_location ON weather_boost_history(location_id);
CREATE INDEX idx_weather_history_time ON weather_boost_history(created_at);
```

### 4.6 性能优化

1. **天气数据缓存**：Redis 缓存 10 分钟，减少 API 调用
2. **增益矩阵预计算**：启动时加载配置到内存
3. **批量刷新优化**：使用地理位置聚合，减少数据库查询

## 5. 验收标准（可测试）

- [ ] 晴天时火系精灵刷新概率提升 50%
- [ ] 雨天时水系精灵刷新概率提升 60%
- [ ] 雾天触发稀有精灵刷新概率提升 30%
- [ ] 暴风雨时龙系精灵刷新概率提升 100%
- [ ] API `/weather/boosts` 返回正确增益信息
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整刷新流程
- [ ] 性能测试：1000 次刷新请求响应时间 < 500ms
- [ ] 天气数据缓存命中率 ≥ 90%

## 6. 工作量估算

**M（中等）**
- 天气增益引擎开发：2 天
- 刷新策略修改：1 天
- API 开发与测试：1 天
- 前端提示集成：0.5 天
- 单元测试与集成测试：1 天
- 文档编写：0.5 天
- **总计：6 天**

## 7. 优先级理由

**P1（高优先级）**

1. **核心玩法增强**：天气系统是 Pokemon Go 的核心特色，显著提升游戏体验
2. **已有基础**：REQ-00037 已完成天气API集成，可直接利用
3. **影响范围大**：影响所有玩家的日常捕捉体验
4. **技术可行**：实现难度适中，风险可控
5. **用户期待**：玩家普遍期待天气影响玩法，提升游戏真实感
