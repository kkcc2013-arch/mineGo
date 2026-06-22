# REQ-00291: 精灵生态链与食物网系统

- **编号**: REQ-00291
- **类别**: 功能增强
- **优先级**: P1
- **状态**: new
- **涉及服务/模块**: pokemon-service, location-service, catch-service, reward-service, game-client
- **创建时间**: 2026-06-22 11:00 UTC
- **依赖需求**: REQ-00047(精灵道具与背包管理), REQ-00243(精灵心情系统)

## 1. 背景与问题

### 1.1 当前现状

mineGo 项目已实现:
- 精灵捕捉与图鉴系统 (pokemon-service)
- 精灵刷新与分布逻辑 (location-service)
- 精灵性格与心情系统 (REQ-00278, REQ-00243)
- 精灵培育与遗传系统 (REQ-00276)

当前精灵刷新采用静态概率模型:
- 固定刷新点
- 随机物种选择
- 无生物链关系
- 缺少生态系统动态平衡

### 1.2 存在的问题

1. **生态系统缺失**:
   - 精灵刷新没有生态逻辑
   - 捕捉某一物种不影响其他物种
   - 缺少捕食者-猎物关系
   - 玩家无法体验真实生态系统

2. **游戏深度不足**:
   - 捕捉行为过于简单
   - 缺少生态保护与平衡概念
   - 无生态链研究玩法
   - 生物学知识无法融入游戏

3. **刷新机制单调**:
   - 同一地点刷新相似物种
   - 无动态生态平衡调整
   - 缺少季节性生态变化
   - 玩家行为不影响生态

4. **科研价值缺失**:
   - 无精灵栖息地研究
   - 缺少生物多样性统计
   - 无生态系统健康度指标
   - 玩家无法贡献生态研究

### 1.3 生态学理论基础

**食物链层级**:
```
顶级捕食者 (Trophic Level 4): 闪电鸟、喷火龙、班基拉斯
中级捕食者 (Trophic Level 3): 皮卡丘、伊布、小火龙
初级消费者 (Trophic Level 2): 绿毛虫、独角虫、波波
生产者/分解者 (Trophic Level 1): 植物系、虫系幼虫期
```

**生态关系**:
- 捕食关系: 大嘴雀捕食波波
- 竞争关系: 皮卡丘与伊布竞争果实
- 共生关系: 妙蛙种子与特定植物
- 寄生关系: 派拉斯与蘑菇

## 2. 目标

1. **构建精灵生态链**: 实现基于真实生态学的食物网系统
2. **动态生态平衡**: 玩家捕捉行为影响区域生态
3. **生态研究玩法**: 玩家可成为生态学家,研究生态链
4. **季节生态变化**: 实现生态系统的季节性波动
5. **生态保护机制**: 引入稀有物种保护与生态恢复

## 3. 范围

### 包含
- `backend/shared/data/pokedex/ecology.json`: 精灵生态属性数据库
- `backend/services/location-service/src/ecology/`: 生态引擎核心模块
  - `FoodWebEngine.js`: 食物网计算引擎
  - `EcosystemBalancer.js`: 生态平衡调节器
  - `SpawnEcologyCalculator.js`: 基于生态的刷新计算
  - `SeasonalCycleManager.js`: 季节性生态管理
- `pokemon-service/src/ecology/`: 精灵生态服务
  - `EcologyDataService.js`: 生态数据服务
  - `HabitatAnalyzer.js`: 栖息地分析器
- `reward-service/src/ecology/`: 生态研究奖励
  - `EcologyResearchService.js`: 生态研究任务系统
- 数据库迁移脚本
- 前端生态图鉴界面
- Prometheus 指标

### 不包含
- 精灵进化链修改 (独立系统)
- PVP 战斗生态加成 (需单独需求)
- 精灵繁殖生态 (已包含在 REQ-00276)

## 4. 详细需求

### 4.1 精灵生态属性数据库

```json
// backend/shared/data/pokedex/ecology.json
{
  "species": {
    "001": {
      "name": "妙蛙种子",
      "trophicLevel": 2,
      "diet": "herbivore",
      "prey": [],
      "predators": ["006", "018", "149"],
      "competitors": ["152", "252", "387"],
      "symbionts": ["043", "069", "114"],
      "habitatTypes": ["forest", "grassland", "wetland"],
      "activityPattern": "diurnal",
      "territoryRadius": 500,
      "groupSize": { "min": 1, "max": 5 },
      "migratory": false,
      "foodPreference": {
        "primary": "photosynthesis",
        "secondary": ["berries", "grass"]
      },
      "ecosystemRole": "primary_consumer",
      "keystoneSpecies": false
    },
    "025": {
      "name": "皮卡丘",
      "trophicLevel": 3,
      "diet": "omnivore",
      "prey": ["010", "013", "019", "161"],
      "predators": ["006", "018", "130", "142", "149"],
      "competitors": ["133", "035", "037"],
      "symbionts": ["043", "044"],
      "habitatTypes": ["forest", "grassland", "urban"],
      "activityPattern": "crepuscular",
      "territoryRadius": 300,
      "groupSize": { "min": 2, "max": 10 },
      "migratory": false,
      "foodPreference": {
        "primary": "berries",
        "secondary": ["insects", "small_pokemon"]
      },
      "ecosystemRole": "mesopredator",
      "keystoneSpecies": true
    },
    "149": {
      "name": "快龙",
      "trophicLevel": 4,
      "diet": "carnivore",
      "prey": ["006", "018", "130", "142", "009", "003"],
      "predators": [],
      "competitors": ["144", "145", "146", "150"],
      "symbionts": [],
      "habitatTypes": ["coastal", "mountain", "ocean"],
      "activityPattern": "diurnal",
      "territoryRadius": 5000,
      "groupSize": { "min": 1, "max": 3 },
      "migratory": true,
      "migrationPattern": "seasonal",
      "foodPreference": {
        "primary": "large_pokemon",
        "secondary": ["fish", "marine_mammals"]
      },
      "ecosystemRole": "apex_predator",
      "keystoneSpecies": true,
      "conservationStatus": "rare"
    }
  },
  
  "ecosystems": {
    "forest": {
      "carryingCapacity": {
        "trophicLevel1": 1000,
        "trophicLevel2": 100,
        "trophicLevel3": 20,
        "trophicLevel4": 2
      },
      "seasonalModifiers": {
        "spring": { "spawnBonus": 1.3, "activityBonus": 1.2 },
        "summer": { "spawnBonus": 1.0, "activityBonus": 1.0 },
        "autumn": { "spawnBonus": 0.8, "activityBonus": 0.9 },
        "winter": { "spawnBonus": 0.5, "activityBonus": 0.6 }
      },
      "dominantSpecies": ["001", "025", "043", "069"],
      "rareSpecies": ["123", "127", "214"]
    },
    "urban": {
      "carryingCapacity": {
        "trophicLevel1": 500,
        "trophicLevel2": 80,
        "trophicLevel3": 30,
        "trophicLevel4": 1
      },
      "seasonalModifiers": {
        "spring": { "spawnBonus": 1.1, "activityBonus": 1.0 },
        "summer": { "spawnBonus": 1.0, "activityBonus": 1.1 },
        "autumn": { "spawnBonus": 0.9, "activityBonus": 1.0 },
        "winter": { "spawnBonus": 0.7, "activityBonus": 0.8 }
      },
      "dominantSpecies": ["016", "019", "052", "133"],
      "rareSpecies": ["063", "100"]
    }
  },
  
  "ecologicalInteractions": {
    "predation": {
      "successRate": {
        "sameLevel": 0.3,
        "oneLevelUp": 0.6,
        "twoLevelsUp": 0.9
      },
      "impactOnPrey": -0.1,
      "impactOnPredator": 0.05
    },
    "competition": {
      "intensity": 0.7,
      "resourceOverlapThreshold": 0.5
    },
    "mutualism": {
      "bonusRate": 1.2,
      "cooccurrenceBonus": 0.3
    }
  }
}
```

### 4.2 食物网计算引擎

```javascript
// backend/services/location-service/src/ecology/FoodWebEngine.js
class FoodWebEngine {
  constructor(ecologyData) {
    this.speciesData = ecologyData.species;
    this.ecosystems = ecologyData.ecosystems;
    this.interactions = ecologyData.ecologicalInteractions;
    this.foodWebCache = new Map();
  }

  /**
   * 构建区域食物网
   * @param {string} ecosystemType - 生态系统类型
   * @param {object} currentPopulations - 当前种群数量 { speciesId: count }
   * @returns {FoodWeb} 食物网对象
   */
  buildFoodWeb(ecosystemType, currentPopulations) {
    const cacheKey = `${ecosystemType}:${JSON.stringify(currentPopulations)}`;
    if (this.foodWebCache.has(cacheKey)) {
      return this.foodWebCache.get(cacheKey);
    }

    const ecosystem = this.ecosystems[ecosystemType];
    const foodWeb = {
      ecosystemType,
      nodes: [],
      edges: [],
      populations: { ...currentPopulations },
      carryingCapacity: ecosystem.carryingCapacity,
      healthScore: 0,
      balanceMetrics: {}
    };

    // 构建节点 (物种)
    for (const [speciesId, count] of Object.entries(currentPopulations)) {
      const species = this.speciesData[speciesId];
      if (!species) continue;

      foodWeb.nodes.push({
        id: speciesId,
        name: species.name,
        trophicLevel: species.trophicLevel,
        population: count,
        diet: species.diet,
        keystoneSpecies: species.keystoneSpecies,
        conservationStatus: species.conservationStatus
      });
    }

    // 构建边 (生态关系)
    for (const node of foodWeb.nodes) {
      const species = this.speciesData[node.id];
      
      // 捕食关系
      for (const preyId of species.prey || []) {
        if (currentPopulations[preyId]) {
          foodWeb.edges.push({
            source: node.id,
            target: preyId,
            type: 'predation',
            weight: this.calculatePredationWeight(node.id, preyId)
          });
        }
      }

      // 竞争关系
      for (const competitorId of species.competitors || []) {
        if (currentPopulations[competitorId]) {
          foodWeb.edges.push({
            source: node.id,
            target: competitorId,
            type: 'competition',
            weight: this.interactions.competition.intensity
          });
        }
      }

      // 共生关系
      for (const symbiontId of species.symbionts || []) {
        if (currentPopulations[symbiontId]) {
          foodWeb.edges.push({
            source: node.id,
            target: symbiontId,
            type: 'mutualism',
            weight: this.interactions.mutualism.cooccurrenceBonus
          });
        }
      }
    }

    // 计算健康度
    foodWeb.healthScore = this.calculateEcosystemHealth(foodWeb);
    foodWeb.balanceMetrics = this.calculateBalanceMetrics(foodWeb);

    this.foodWebCache.set(cacheKey, foodWeb);
    return foodWeb;
  }

  /**
   * 计算捕食权重
   */
  calculatePredationWeight(predatorId, preyId) {
    const predator = this.speciesData[predatorId];
    const prey = this.speciesData[preyId];
    const levelDiff = predator.trophicLevel - prey.trophicLevel;
    
    return this.interactions.predation.successRate[
      levelDiff === 0 ? 'sameLevel' : 
      levelDiff === 1 ? 'oneLevelUp' : 'twoLevelsUp'
    ] || 0.5;
  }

  /**
   * 计算生态系统健康度
   * @returns {number} 0-100 健康分数
   */
  calculateEcosystemHealth(foodWeb) {
    const scores = {
      diversity: this.calculateShannonDiversity(foodWeb),
      balance: this.calculateTrophicBalance(foodWeb),
      connectivity: this.calculateConnectance(foodWeb),
      keystonePresence: this.calculateKeystonePresence(foodWeb)
    };

    // 加权平均
    return (
      scores.diversity * 0.3 +
      scores.balance * 0.3 +
      scores.connectivity * 0.2 +
      scores.keystonePresence * 0.2
    );
  }

  /**
   * Shannon 多样性指数
   */
  calculateShannonDiversity(foodWeb) {
    const totalPopulation = Object.values(foodWeb.populations)
      .reduce((sum, count) => sum + count, 0);
    
    if (totalPopulation === 0) return 0;

    let diversity = 0;
    for (const count of Object.values(foodWeb.populations)) {
      if (count > 0) {
        const proportion = count / totalPopulation;
        diversity -= proportion * Math.log(proportion);
      }
    }

    // 标准化到 0-100
    const maxDiversity = Math.log(Object.keys(foodWeb.populations).length);
    return (diversity / maxDiversity) * 100;
  }

  /**
   * 营养级平衡度
   */
  calculateTrophicBalance(foodWeb) {
    const levels = { 1: 0, 2: 0, 3: 0, 4: 0 };
    
    for (const node of foodWeb.nodes) {
      levels[node.trophicLevel] += node.population;
    }

    // 理想比例: 10:3:1:0.1 (能量金字塔)
    const idealRatio = { 1: 10, 2: 3, 3: 1, 4: 0.1 };
    const totalActual = Object.values(levels).reduce((a, b) => a + b, 0);
    
    if (totalActual === 0) return 0;

    let balanceScore = 100;
    for (let level = 1; level <= 4; level++) {
      const actualRatio = levels[level] / totalActual * 100;
      const expectedRatio = idealRatio[level] / 14.1 * 100;
      const deviation = Math.abs(actualRatio - expectedRatio) / expectedRatio;
      balanceScore -= deviation * 20;
    }

    return Math.max(0, balanceScore);
  }

  /**
   * 网络连接度
   */
  calculateConnectance(foodWeb) {
    const nodes = foodWeb.nodes.length;
    const edges = foodWeb.edges.length;
    
    if (nodes <= 1) return 0;
    
    const maxPossibleEdges = nodes * (nodes - 1);
    return (edges / maxPossibleEdges) * 100;
  }

  /**
   * 关键物种存在度
   */
  calculateKeystonePresence(foodWeb) {
    const keystoneSpecies = foodWeb.nodes.filter(n => n.keystoneSpecies);
    if (keystoneSpecies.length === 0) return 50; // 无关键物种不算差
    
    const presentKeystones = keystoneSpecies.filter(n => n.population > 0);
    return (presentKeystones.length / keystoneSpecies.length) * 100;
  }

  /**
   * 计算平衡指标
   */
  calculateBalanceMetrics(foodWeb) {
    return {
      totalPopulation: Object.values(foodWeb.populations)
        .reduce((sum, count) => sum + count, 0),
      speciesRichness: foodWeb.nodes.length,
      predationPressure: this.calculatePredationPressure(foodWeb),
      competitionIntensity: this.calculateCompetitionIntensity(foodWeb),
      mutualismBonus: this.calculateMutualismBonus(foodWeb)
    };
  }

  /**
   * 预测种群变化
   */
  predictPopulationChange(foodWeb, timeSteps = 24) {
    const predictions = [];
    let populations = { ...foodWeb.populations };

    for (let t = 0; t < timeSteps; t++) {
      const newPopulations = {};

      for (const [speciesId, population] of Object.entries(populations)) {
        const species = this.speciesData[speciesId];
        const growthRate = this.calculateGrowthRate(speciesId, populations, foodWeb);
        
        // Lotka-Volterra 方程简化版
        const dN = population * growthRate;
        newPopulations[speciesId] = Math.max(0, Math.round(population + dN));
      }

      populations = newPopulations;
      predictions.push({
        timeStep: t + 1,
        populations: { ...populations }
      });
    }

    return predictions;
  }

  /**
   * 计算物种增长率
   */
  calculateGrowthRate(speciesId, populations, foodWeb) {
    const species = this.speciesData[speciesId];
    const ecosystem = this.ecosystems[foodWeb.ecosystemType];
    
    // 基础增长率
    let rate = species.diet === 'herbivore' ? 0.1 : 
               species.diet === 'omnivore' ? 0.05 : 0.02;

    // 环境容纳量限制
    const carryingCapacity = ecosystem.carryingCapacity[`trophicLevel${species.trophicLevel}`];
    const currentLevelPopulation = Object.entries(populations)
      .filter(([id, _]) => this.speciesData[id]?.trophicLevel === species.trophicLevel)
      .reduce((sum, [_, count]) => sum + count, 0);
    
    const carryingFactor = 1 - (currentLevelPopulation / carryingCapacity);
    rate *= Math.max(-0.5, carryingFactor);

    // 捕食压力
    for (const predatorId of species.predators || []) {
      if (populations[predatorId]) {
        rate -= populations[predatorId] * 0.001;
      }
    }

    // 猎物丰富度
    for (const preyId of species.prey || []) {
      if (populations[preyId]) {
        rate += populations[preyId] * 0.0005;
      }
    }

    return rate;
  }
}

module.exports = FoodWebEngine;
```

### 4.3 生态平衡调节器

```javascript
// backend/services/location-service/src/ecology/EcosystemBalancer.js
class EcosystemBalancer {
  constructor(foodWebEngine, redis) {
    this.foodWebEngine = foodWebEngine;
    this.redis = redis;
    this.balanceInterval = 3600000; // 1小时平衡一次
  }

  /**
   * 处理捕捉事件对生态的影响
   * @param {string} ecosystemType - 生态系统类型
   * @param {string} speciesId - 被捕捉的物种ID
   * @param {string} locationId - 地点ID
   */
  async handleCapture(ecosystemType, speciesId, locationId) {
    const cacheKey = `ecosystem:${locationId}`;
    let ecosystemState = await this.redis.get(cacheKey);
    
    if (!ecosystemState) {
      ecosystemState = await this.initializeEcosystem(ecosystemType, locationId);
    } else {
      ecosystemState = JSON.parse(ecosystemState);
    }

    // 更新种群数量
    const currentPopulation = ecosystemState.populations[speciesId] || 0;
    if (currentPopulation > 0) {
      ecosystemState.populations[speciesId] = currentPopulation - 1;
    }

    // 触发连锁反应
    await this.triggerChainReaction(ecosystemState, speciesId);

    // 重新计算食物网
    const foodWeb = this.foodWebEngine.buildFoodWeb(
      ecosystemType, 
      ecosystemState.populations
    );

    // 检查生态失衡
    if (foodWeb.healthScore < 30) {
      await this.handleEcologicalCrisis(locationId, foodWeb);
    } else if (foodWeb.healthScore < 50) {
      await this.warnEcologicalImbalance(locationId, foodWeb);
    }

    // 保存状态
    ecosystemState.lastUpdate = Date.now();
    ecosystemState.healthScore = foodWeb.healthScore;
    await this.redis.set(cacheKey, JSON.stringify(ecosystemState), 'EX', 86400);

    // 发布事件
    await this.publishEcosystemEvent(locationId, {
      type: 'capture',
      speciesId,
      healthScore: foodWeb.healthScore
    });
  }

  /**
   * 触发生态连锁反应
   */
  async triggerChainReaction(ecosystemState, capturedSpeciesId) {
    const species = this.foodWebEngine.speciesData[capturedSpeciesId];
    if (!species) return;

    // 捕食者效应: 如果被捕食者减少,捕食者可能迁徙
    for (const predatorId of species.predators || []) {
      const predatorPop = ecosystemState.populations[predatorId] || 0;
      if (predatorPop > 0) {
        // 小概率捕食者因食物不足而离开
        if (Math.random() < 0.1) {
          ecosystemState.populations[predatorId] = Math.max(0, predatorPop - 1);
          ecosystemState.events.push({
            type: 'migration',
            speciesId: predatorId,
            reason: 'prey_scarcity',
            timestamp: Date.now()
          });
        }
      }
    }

    // 猎物效应: 如果捕食者被移除,猎物可能增加
    for (const preyId of species.prey || []) {
      const preyPop = ecosystemState.populations[preyId] || 0;
      // 小概率猎物因天敌减少而繁殖
      if (Math.random() < 0.15) {
        ecosystemState.populations[preyId] = preyPop + 1;
      }
    }

    // 竞争者效应: 竞争者可能因资源竞争减少而受益
    for (const competitorId of species.competitors || []) {
      const competitorPop = ecosystemState.populations[competitorId] || 0;
      if (Math.random() < 0.08) {
        ecosystemState.populations[competitorId] = competitorPop + 1;
      }
    }
  }

  /**
   * 处理生态危机
   */
  async handleEcologicalCrisis(locationId, foodWeb) {
    // 发送告警
    await this.sendEcologicalAlert(locationId, foodWeb, 'critical');

    // 触发生态恢复机制
    await this.triggerEcologicalRecovery(locationId, foodWeb);

    // 记录事件
    await this.logEcologicalEvent(locationId, 'crisis', foodWeb);
  }

  /**
   * 触发生态恢复
   */
  async triggerEcologicalRecovery(locationId, foodWeb) {
    const ecosystem = this.foodWebEngine.ecosystems[foodWeb.ecosystemType];
    
    // 重新引入关键物种
    for (const node of foodWeb.nodes) {
      if (node.keystoneSpecies && node.population < 2) {
        // 增加关键物种刷新概率
        await this.boostSpawnRate(locationId, node.id, 5.0);
      }
    }

    // 补充底层物种
    for (const [speciesId, count] of Object.entries(foodWeb.populations)) {
      const species = this.foodWebEngine.speciesData[speciesId];
      if (species?.trophicLevel === 1 && count < 10) {
        await this.boostSpawnRate(locationId, speciesId, 3.0);
      }
    }
  }

  /**
   * 提升刷新概率
   */
  async boostSpawnRate(locationId, speciesId, multiplier) {
    const key = `spawn_boost:${locationId}:${speciesId}`;
    await this.redis.set(key, multiplier, 'EX', 86400 * 7); // 7天有效期
  }

  /**
   * 定期生态平衡
   */
  async performPeriodicBalance() {
    // 获取所有活跃生态系统
    const keys = await this.redis.keys('ecosystem:*');
    
    for (const key of keys) {
      const locationId = key.replace('ecosystem:', '');
      const state = JSON.parse(await this.redis.get(key));

      // 自然增长
      for (const [speciesId, population] of Object.entries(state.populations)) {
        if (population < 50) {
          const species = this.foodWebEngine.speciesData[speciesId];
          const growthChance = species?.diet === 'herbivore' ? 0.2 : 
                              species?.diet === 'omnivore' ? 0.1 : 0.05;
          
          if (Math.random() < growthChance) {
            state.populations[speciesId] = population + 1;
          }
        }
      }

      // 更新状态
      await this.redis.set(key, JSON.stringify(state), 'EX', 86400);
    }
  }

  /**
   * 初始化生态系统
   */
  async initializeEcosystem(ecosystemType, locationId) {
    const ecosystem = this.foodWebEngine.ecosystems[ecosystemType];
    const populations = {};

    // 根据优势物种初始化
    for (const speciesId of ecosystem.dominantSpecies) {
      const species = this.foodWebEngine.speciesData[speciesId];
      if (species) {
        const basePopulation = Math.floor(
          ecosystem.carryingCapacity[`trophicLevel${species.trophicLevel}`] / 5
        );
        populations[speciesId] = basePopulation;
      }
    }

    return {
      ecosystemType,
      locationId,
      populations,
      healthScore: 80,
      lastUpdate: Date.now(),
      events: []
    };
  }
}

module.exports = EcosystemBalancer;
```

### 4.4 基于生态的刷新计算

```javascript
// backend/services/location-service/src/ecology/SpawnEcologyCalculator.js
class SpawnEcologyCalculator {
  constructor(foodWebEngine, ecosystemBalancer) {
    this.foodWebEngine = foodWebEngine;
    this.balancer = ecosystemBalancer;
  }

  /**
   * 计算刷新概率
   * @param {string} locationId - 地点ID
   * @param {string} ecosystemType - 生态系统类型
   * @param {object} options - 计算选项
   */
  async calculateSpawnProbabilities(locationId, ecosystemType, options = {}) {
    const {
      timeOfDay,
      weather,
      season,
      userLevel,
      nearbyPlayers
    } = options;

    // 获取当前生态状态
    const ecosystemState = await this.balancer.getEcosystemState(locationId);
    const foodWeb = this.foodWebEngine.buildFoodWeb(
      ecosystemType, 
      ecosystemState?.populations || {}
    );

    const probabilities = {};

    for (const [speciesId, species] of Object.entries(this.foodWebEngine.speciesData)) {
      // 检查栖息地匹配
      if (!species.habitatTypes.includes(ecosystemType)) {
        continue;
      }

      // 基础概率
      let probability = this.getBaseProbability(species, ecosystemType);

      // 生态因素调整
      probability *= this.applyEcologicalFactors(speciesId, foodWeb, ecosystemState);

      // 时间因素
      probability *= this.applyTimeFactors(species, timeOfDay, season);

      // 天气因素
      probability *= this.applyWeatherFactors(species, weather);

      // 稀有度调整
      if (species.conservationStatus === 'rare') {
        probability *= 0.1;
      } else if (species.conservationStatus === 'endangered') {
        probability *= 0.05;
      }

      // 关键物种保护
      if (species.keystoneSpecies && foodWeb.healthScore < 50) {
        probability *= 2.0; // 提升关键物种刷新
      }

      probabilities[speciesId] = Math.max(0, Math.min(1, probability));
    }

    return this.normalizeProbabilities(probabilities);
  }

  /**
   * 应用生态因素
   */
  applyEcologicalFactors(speciesId, foodWeb, ecosystemState) {
    let multiplier = 1.0;
    const currentPop = ecosystemState?.populations[speciesId] || 0;

    // 种群密度调整
    if (currentPop < 3) {
      multiplier *= 1.5; // 稀有物种更容易刷新
    } else if (currentPop > 30) {
      multiplier *= 0.5; // 过多物种减少刷新
    }

    // 食物链平衡调整
    const species = this.foodWebEngine.speciesData[speciesId];
    
    // 如果猎物稀少,捕食者刷新降低
    if (species.diet === 'carnivore' || species.diet === 'omnivore') {
      let preyAbundance = 0;
      for (const preyId of species.prey || []) {
        preyAbundance += ecosystemState?.populations[preyId] || 0;
      }
      if (preyAbundance < 5) {
        multiplier *= 0.3;
      }
    }

    // 生态系统健康度影响
    multiplier *= (foodWeb.healthScore / 100);

    return multiplier;
  }

  /**
   * 应用时间因素
   */
  applyTimeFactors(species, timeOfDay, season) {
    let multiplier = 1.0;

    // 活动时间
    if (species.activityPattern === 'diurnal' && 
        (timeOfDay < 6 || timeOfDay > 18)) {
      multiplier *= 0.3;
    } else if (species.activityPattern === 'nocturnal' && 
               (timeOfDay >= 6 && timeOfDay <= 18)) {
      multiplier *= 0.3;
    }

    // 季节
    if (species.migratory) {
      const migrationMultiplier = this.getMigrationMultiplier(species, season);
      multiplier *= migrationMultiplier;
    }

    return multiplier;
  }

  /**
   * 获取迁徙系数
   */
  getMigrationMultiplier(species, season) {
    const migrationPatterns = {
      'spring': { northward: 1.2, southward: 0.5 },
      'autumn': { northward: 0.5, southward: 1.2 }
    };

    // 简化实现,实际应考虑物种迁徙路线
    if (species.migrationPattern === 'seasonal') {
      return migrationPatterns[season]?.northward || 1.0;
    }

    return 1.0;
  }

  /**
   * 应用天气因素
   */
  applyWeatherFactors(species, weather) {
    const weatherMultipliers = {
      'rain': {
        'water': 1.5,
        'electric': 1.2,
        'fire': 0.7,
        'ground': 0.8
      },
      'sunny': {
        'fire': 1.3,
        'grass': 1.2,
        'water': 0.8,
        'ice': 0.6
      },
      'cloudy': {
        'normal': 1.1,
        'fairy': 1.2,
        'psychic': 1.1
      }
    };

    // 根据精灵属性应用天气加成
    // 简化实现,实际应查询精灵属性
    return 1.0;
  }

  /**
   * 归一化概率
   */
  normalizeProbabilities(probabilities) {
    const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
    
    if (total === 0) return probabilities;

    const normalized = {};
    for (const [speciesId, probability] of Object.entries(probabilities)) {
      normalized[speciesId] = probability / total;
    }

    return normalized;
  }
}

module.exports = SpawnEcologyCalculator;
```

### 4.5 季节性生态管理

```javascript
// backend/services/location-service/src/ecology/SeasonalCycleManager.js
class SeasonalCycleManager {
  constructor(redis, foodWebEngine) {
    this.redis = redis;
    this.foodWebEngine = foodWebEngine;
    
    // 定义季节周期
    this.seasons = ['spring', 'summer', 'autumn', 'winter'];
    this.seasonDuration = 30 * 24 * 3600 * 1000; // 30天一个季节
  }

  /**
   * 获取当前季节
   */
  getCurrentSeason() {
    const now = Date.now();
    const seasonIndex = Math.floor((now / this.seasonDuration) % 4);
    return this.seasons[seasonIndex];
  }

  /**
   * 应用季节性生态变化
   */
  async applySeasonalChanges(ecosystemType, locationId) {
    const season = this.getCurrentSeason();
    const ecosystem = this.foodWebEngine.ecosystems[ecosystemType];
    const seasonModifiers = ecosystem.seasonalModifiers[season];

    const cacheKey = `ecosystem:${locationId}`;
    let state = JSON.parse(await this.redis.get(cacheKey) || '{}');

    // 应用季节性种群调整
    for (const [speciesId, population] of Object.entries(state.populations || {})) {
      const species = this.foodWebEngine.speciesData[speciesId];
      if (!species) continue;

      // 季节性繁殖
      if (season === 'spring' && species.diet === 'herbivore') {
        state.populations[speciesId] = Math.round(population * 1.2);
      }

      // 冬季减少
      if (season === 'winter' && !species.habitatTypes.includes('snow')) {
        state.populations[speciesId] = Math.round(population * 0.7);
      }

      // 迁徙物种
      if (species.migratory) {
        if (season === 'winter' && species.migrationPattern === 'seasonal') {
          state.populations[speciesId] = Math.round(population * 0.3);
        } else if (season === 'spring') {
          state.populations[speciesId] = Math.round(population * 1.5);
        }
      }
    }

    // 记录季节变化事件
    state.lastSeason = season;
    state.events.push({
      type: 'seasonal_change',
      season,
      timestamp: Date.now()
    });

    await this.redis.set(cacheKey, JSON.stringify(state), 'EX', 86400);
    return state;
  }

  /**
   * 获取季节性刷新加成
   */
  getSeasonalSpawnBonus(ecosystemType, season) {
    const ecosystem = this.foodWebEngine.ecosystems[ecosystemType];
    return ecosystem?.seasonalModifiers[season]?.spawnBonus || 1.0;
  }

  /**
   * 获取季节性活动加成
   */
  getSeasonalActivityBonus(ecosystemType, season) {
    const ecosystem = this.foodWebEngine.ecosystems[ecosystemType];
    return ecosystem?.seasonalModifiers[season]?.activityBonus || 1.0;
  }
}

module.exports = SeasonalCycleManager;
```

### 4.6 数据库迁移

```sql
-- 生态系统状态表
CREATE TABLE ecosystem_states (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(100) NOT NULL,
  ecosystem_type VARCHAR(50) NOT NULL,
  populations JSONB NOT NULL DEFAULT '{}',
  health_score INTEGER DEFAULT 80,
  last_update TIMESTAMP DEFAULT NOW(),
  last_season VARCHAR(20),
  events JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(location_id)
);

CREATE INDEX idx_ecosystem_location ON ecosystem_states(location_id);
CREATE INDEX idx_ecosystem_health ON ecosystem_states(health_score);
CREATE INDEX idx_ecosystem_update ON ecosystem_states(last_update);

-- 生态事件日志
CREATE TABLE ecosystem_events (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(100) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  species_id VARCHAR(10),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_eco_events_location ON ecosystem_events(location_id);
CREATE INDEX idx_eco_events_type ON ecosystem_events(event_type);
CREATE INDEX idx_eco_events_time ON ecosystem_events(created_at);

-- 生态研究记录
CREATE TABLE ecology_research (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  location_id VARCHAR(100),
  species_id VARCHAR(10),
  observation_type VARCHAR(50),
  observation_data JSONB,
  contribution_score INTEGER DEFAULT 0,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_eco_research_user ON ecology_research(user_id);
CREATE INDEX idx_eco_research_location ON ecology_research(location_id);
```

### 4.7 API 端点

```javascript
// 新增生态相关API

// GET /api/ecology/:locationId
// 获取生态系统状态
router.get('/ecology/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const state = await ecosystemBalancer.getEcosystemState(locationId);
  const foodWeb = foodWebEngine.buildFoodWeb(state.ecosystemType, state.populations);
  
  res.json({
    ecosystem: state,
    foodWeb: {
      nodes: foodWeb.nodes,
      edges: foodWeb.edges,
      healthScore: foodWeb.healthScore,
      balanceMetrics: foodWeb.balanceMetrics
    }
  });
});

// GET /api/ecology/:locationId/predictions
// 获取生态系统预测
router.get('/ecology/:locationId/predictions', async (req, res) => {
  const { locationId } = req.params;
  const { steps = 24 } = req.query;
  
  const state = await ecosystemBalancer.getEcosystemState(locationId);
  const foodWeb = foodWebEngine.buildFoodWeb(state.ecosystemType, state.populations);
  const predictions = foodWebEngine.predictPopulationChange(foodWeb, steps);
  
  res.json({ predictions });
});

// POST /api/ecology/:locationId/research
// 提交生态观察
router.post('/ecology/:locationId/research', auth, async (req, res) => {
  const { locationId } = req.params;
  const { speciesId, observationType, observationData } = req.body;
  
  const research = await ecologyResearchService.submitObservation({
    userId: req.user.id,
    locationId,
    speciesId,
    observationType,
    observationData
  });
  
  res.json(research);
});

// GET /api/pokedex/:speciesId/ecology
// 获取精灵生态信息
router.get('/pokedex/:speciesId/ecology', async (req, res) => {
  const { speciesId } = req.params;
  const ecology = foodWebEngine.speciesData[speciesId];
  
  res.json({
    speciesId,
    ecology: ecology ? {
      trophicLevel: ecology.trophicLevel,
      diet: ecology.diet,
      prey: ecology.prey,
      predators: ecology.predators,
      competitors: ecology.competitors,
      symbionts: ecology.symbionts,
      habitatTypes: ecology.habitatTypes,
      activityPattern: ecology.activityPattern,
      keystoneSpecies: ecology.keystoneSpecies,
      conservationStatus: ecology.conservationStatus
    } : null
  });
});
```

### 4.8 Prometheus 指标

```javascript
const ecologyMetrics = {
  // 生态系统健康度
  ecosystem_health_score: new Gauge({
    name: 'ecosystem_health_score',
    help: 'Ecosystem health score by location',
    labelNames: ['location_id', 'ecosystem_type']
  }),

  // 物种数量
  ecosystem_species_count: new Gauge({
    name: 'ecosystem_species_count',
    help: 'Number of species in ecosystem',
    labelNames: ['location_id', 'trophic_level']
  }),

  // 总种群数量
  ecosystem_total_population: new Gauge({
    name: 'ecosystem_total_population',
    help: 'Total population in ecosystem',
    labelNames: ['location_id']
  }),

  // 捕捉事件影响
  ecology_capture_events: new Counter({
    name: 'ecology_capture_events_total',
    help: 'Total capture events processed by ecology system',
    labelNames: ['species_id', 'ecosystem_type']
  }),

  // 生态危机事件
  ecology_crisis_events: new Counter({
    name: 'ecology_crisis_events_total',
    help: 'Total ecological crisis events',
    labelNames: ['location_id', 'severity']
  }),

  // 季节变化
  ecology_season_changes: new Counter({
    name: 'ecology_season_changes_total',
    help: 'Total seasonal ecology changes',
    labelNames: ['season']
  }),

  // 食物网复杂度
  food_web_complexity: new Gauge({
    name: 'food_web_complexity',
    help: 'Food web complexity metrics',
    labelNames: ['location_id', 'metric']
  }),

  // 生态研究贡献
  ecology_research_contributions: new Counter({
    name: 'ecology_research_contributions_total',
    help: 'Total ecology research contributions',
    labelNames: ['user_id', 'observation_type']
  })
};
```

## 5. 验收标准（可测试）

- [ ] 实现完整的精灵生态属性数据库,覆盖 ≥ 150 种精灵
- [ ] 实现食物网计算引擎,支持 4 层营养级、3 种生态关系
- [ ] 实现生态平衡调节器,支持捕捉连锁反应计算
- [ ] 实现基于生态的刷新计算,刷新概率考虑 ≥ 10 种生态因素
- [ ] 实现季节性生态管理,支持 4 季循环和迁徙模拟
- [ ] 玩家捕捉行为对生态系统产生可观测影响
- [ ] 生态系统健康度计算准确,与理论模型偏差 < 10%
- [ ] 生态危机检测与自动恢复机制可用
- [ ] 新增 10+ API 端点,支持生态状态查询与研究
- [ ] 新增 8+ Prometheus 指标,覆盖生态健康、种群、事件
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试:模拟 100 次捕捉事件,验证生态连锁反应
- [ ] 前端生态图鉴界面可用,展示食物网可视化

## 6. 工作量估算

**XL (Extra Large)**

**理由**:
- 需要实现 5 个核心模块
- 需要构建完整的生态数据库
- 涉及 4 个微服务改造
- 需要前端可视化开发
- 预计工作量: 10-15 人天

## 7. 优先级理由

**P1 理由**:
1. **核心玩法增强**: 生态链系统显著提升游戏深度和真实性
2. **差异化竞争优势**: 市场上同类游戏缺少真实生态系统模拟
3. **教育价值**: 融入生态学知识,提升游戏社会价值
4. **长期留存**: 生态系统动态变化增加探索乐趣
5. **数据驱动**: 为后续 AI 推荐和个性化提供基础

---

## 附录：生态学研究参考

### A. 营养级模型
```
Level 1 (生产者): 光合作用精灵、植物系
Level 2 (初级消费者): 草食性精灵
Level 3 (次级消费者): 杂食性精灵
Level 4 (顶级捕食者): 肉食性精灵
```

### B. Lotka-Volterra 方程
```
dN/dt = rN(1 - N/K)
N: 种群大小
r: 内在增长率
K: 环境容纳量
```

### C. Shannon 多样性指数
```
H' = -Σ(pi * ln(pi))
pi: 物种 i 的相对丰度
```

### D. 实施计划

**Phase 1: 数据层 (3-4 天)**
1. 构建生态属性数据库
2. 数据库迁移脚本
3. Redis 生态状态存储

**Phase 2: 核心引擎 (4-5 天)**
1. 食物网计算引擎
2. 生态平衡调节器
3. 刷新概率计算器
4. 季节管理器

**Phase 3: 服务集成 (2-3 天)**
1. location-service 集成
2. pokemon-service 集成
3. reward-service 生态研究
4. API 端点开发

**Phase 4: 前端与测试 (2-3 天)**
1. 生态图鉴界面
2. 食物网可视化
3. 单元测试
4. 集成测试
