# REQ-00361：精灵栖息地偏好与环境加成系统

- **编号**：REQ-00361
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：location-service、pokemon-service、gym-service、catch-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-29 09:00 UTC
- **依赖需求**：REQ-00037（真实天气 API 集成与天气加成系统）

## 1. 背景与问题

当前 mineGo 的精灵系统主要依赖天气加成（REQ-00037）提供环境相关的增益效果，但缺少对精灵栖息地偏好的系统化支持。在原版游戏中，精灵具有栖息地偏好特性——某些精灵在特定地理环境中表现更强、捕捉概率更高、或更容易在该环境中出现。

**当前痛点**：
1. 精灵与环境地理位置的关联仅通过 spawn 点位定义，缺少"偏好匹配"机制
2. 战斗系统中精灵的战斗能力不受当前地理环境类型影响
3. 捕捉概率计算仅考虑天气和精灵稀有度，未考虑精灵与环境的匹配度
4. 玩家无法知道精灵的最佳栖息地类型，缺少策略深度

## 2. 目标

实现精灵栖息地偏好与环境加成系统，为精灵定义栖息地偏好类型（森林、水域、山地、沙漠、草原、城市、海岸等），在匹配环境中提供战斗加成、捕捉加成和刷新概率提升。预期收益：
- 增加游戏策略深度，玩家可以选择在特定环境中使用匹配精灵
- 提升精灵生态真实感，不同精灵在不同环境中表现不同
- 为精灵刷新算法增加新的权重因子
- 与天气系统联动，形成多维环境加成

## 3. 范围

- **包含**：
  - 栖息地类型定义（森林、水域、山地、沙漠、草原、城市、海岸、洞穴、湿地、火山）
  - 精灵栖息地偏好数据配置（每只精灵可有多偏好，带优先级）
  - 环境识别系统（基于地理位置和地形数据判断当前环境类型）
  - 战斗加成计算（栖息地匹配精灵获得属性提升）
  - 捕捉加成计算（在匹配栖息地捕捉同偏好精灵概率提升）
  - 刷新概率调整（匹配栖息地的精灵刷新权重增加）
  - 前端 UI 展示精灵栖息地偏好信息

- **不包含**：
  - 天气系统重构（仅集成现有 REQ-00037 天气加成）
  - 精灵特性系统（REQ-00086）的具体实现
  - 精灵生态链系统（REQ-00331）的食物网逻辑

## 4. 详细需求

### 4.1 栖息地类型定义

定义 10 种核心栖息地类型，每种类型有独特的地形特征：

| 样息地类型 | 英文 ID | 地形特征 | 典型精灵类型加成 |
|-----------|---------|---------|-----------------|
| 森林 | forest | 树木覆盖率 >40% | 草系、虫系 +15% |
| 水域 | water | 水面/河流/湖泊 | 水系 +15% |
| 山地 | mountain |海拔 >500m | 石系、飞行系 +15% |
| 沙漠 | desert | 干旱/沙地 | 地面系、火系 +15% |
| 草原 | grassland | 开阔草地 | 草系、地面系 +10% |
| 城市 | urban | 建筑密集区 | 电系、毒系 +10% |
| 海岸 | coastal | 海岸线 <500m | 水系、飞行系 +15% |
| 洞穴 | cave | 地下空间 | 石系、幽灵系 +15% |
| 湿地 | wetland | 沼泽/湿地 | 水系、草系 +10% |
| 火山 | volcanic | 火山区域 | 火系 +20% |

### 4.2 精灵栖息地偏好数据结构

每个精灵物种定义栖息地偏好列表：

```javascript
{
  species_id: "pikachu",
  habitat_preferences: [
    { habitat_type: "forest", priority: 1, bonus_multiplier: 1.2 },
    { habitat_type: "grassland", priority: 2, bonus_multiplier: 1.1 }
  ],
  spawn_boost_in_habitat: {
    forest: 1.5, // 在森林中刷新概率 x1.5
    grassland: 1.2
  },
  catch_boost_in_habitat: {
    forest: 1.15 // 在森林中捕捉同偏好精灵概率 +15%
  }
}
```

### 4.3 环境识别系统

基于玩家 GPS 坐标判断当前环境类型：

```javascript
// 环境识别服务
async identifyHabitat(latitude, longitude) {
  // 方法 1：基于地形数据 API（如 OpenStreetMap）
  const terrainData = await fetchTerrainData(lat, lon);
  
  // 方法 2：基于预定义区域配置（城市公园=森林，商业区=城市）
  const predefinedAreas = await getPredefinedAreas(lat, lon);
  
  // 方法 3：基于卫星图像分类（可选高级功能）
  
  return {
    primary_habitat: "forest",
    secondary_habitat: "grassland",
    confidence: 0.85
  };
}
```

### 4.4 战斗加成计算

在道馆战斗中，栖息地匹配的精灵获得属性加成：

```javascript
function calculateHabitatBattleBonus(pokemon, currentHabitat) {
  const preference = pokemon.habitat_preferences.find(
    p => p.habitat_type === currentHabitat.primary_habitat
  );
  
  if (!preference) return { multiplier: 1.0 };
  
  // 与天气加成叠加（乘法叠加）
  const weatherBonus = getWeatherBonus(pokemon);
  const totalBonus = preference.bonus_multiplier * weatherBonus;
  
  return {
    habitat_match: true,
    base_multiplier: preference.bonus_multiplier,
    weather_multiplier: weatherBonus,
    total_multiplier: Math.min(totalBonus, 2.0) // 上限 2x
  };
}
```

### 4.5 捕捉加成计算

在捕捉流程中，栖息地匹配增加捕捉概率：

```javascript
function calculateCatchProbability(baseRate, pokemon, habitat) {
  const habitatBoost = pokemon.catch_boost_in_habitat?.[habitat.primary_habitat] || 1.0;
  const weatherBoost = getWeatherCatchBoost(pokemon);
  
  const finalRate = baseRate * habitatBoost * weatherBoost;
  return Math.min(finalRate, 0.95); // 上限 95%
}
```

### 4.6 刷新概率调整

精灵刷新算法中增加栖息地权重：

```javascript
function adjustSpawnProbability(speciesId, habitat) {
  const species = getPokemonSpecies(speciesId);
  const habitatBoost = species.spawn_boost_in_habitat?.[habitat.primary_habitat] || 1.0;
  
  // 叠加稀有度、天气等因素
  return baseSpawnRate * habitatBoost;
}
```

### 4.7 API 接口设计

```
GET /api/habitat/current?lat={lat}&lon={lon}
返回：当前环境类型和置信度

GET /api/pokemon/:id/habitat-preferences
返回：精灵栖息地偏好信息

GET /api/habitat/recommended-pokemon?lat={lat}&lon={lon}
返回：当前环境适合使用的精灵列表

POST /api/habitat/define-area (admin)
定义自定义栖息地区域
```

## 5. 验收标准（可测试）

- [ ] 数据库表创建完成：`habitats`、`pokemon_habitat_preferences`、`habitat_areas`
- [ ] 10 种栖息地类型定义完成，每种类型有地形特征描述
- [ ] 100+ 精灵物种配置栖息地偏好数据
- [ ] 环境识别服务可用，基于 GPS 返回栖息地类型
- [ ] 战斗系统集成栖息地加成，属性提升正确计算
- [ ] 捕捉系统集成栖息地加成，概率提升正确计算
- [ ] 刷新算法集成栖息地权重，刷新概率调整生效
- [ ] 与天气系统（REQ-00037）正确叠加，上限控制生效
- [ ] 前端精灵详情页显示栖息地偏好信息
- [ ] 前端地图界面显示当前环境类型提示
- [ ] API 接口返回正确的栖息地数据
- [ ] 单元测试覆盖率达到 80% 以上

## 6. 工作量估算

**L（大型）**

理由：
- 需要新增 3 张数据库表
- 涉及 4 个微服务的集成（location、pokemon、gym、catch）
- 需要配置大量精灵栖息地数据（100+）
- 需要实现环境识别算法
- 前端 UI 改动较多

预估开发时间：3-4 个工作日

## 7. 优先级理由

**P1**（高优先级）

1. 增加游戏策略深度，提升玩家体验
2. 与现有天气系统联动，形成完整的环境加成体系
3. 为精灵生态提供更真实的支撑
4. 不影响核心功能，但有显著体验提升
5. 实现后可为后续精灵生态链系统（REQ-00331）提供基础