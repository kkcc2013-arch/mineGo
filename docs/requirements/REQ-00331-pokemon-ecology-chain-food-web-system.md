# REQ-00331: 精灵生态链与食物网系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00331 |
| 标题 | 精灵生态链与食物网系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、location-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-26 06:00 |

## 需求描述

### 背景
当前游戏中的精灵生态系统相对独立，缺乏生态链和食物网概念。不同精灵之间应该存在自然的捕食关系、共生关系、竞争关系，形成一个动态平衡的生态系统。这将极大提升游戏的真实感和策略深度。

### 目标
构建完整的精灵生态链与食物网系统，实现：
1. **捕食关系**：精灵之间的捕食者-被捕食者关系
2. **共生关系**：精灵之间的互利共生、偏利共生关系
3. **竞争关系**：同生态位精灵的资源竞争
4. **生态系统动态平衡**：基于种群数量、环境因素的动态调节
5. **生态链可视化**：向玩家展示精灵在生态链中的位置
6. **生态事件触发**：基于生态平衡的随机事件

### 业务价值
- 提升游戏真实感和沉浸感
- 增加游戏策略深度（捕捉特定精灵可能影响生态平衡）
- 为玩家提供新的探索维度
- 为未来生态保护主题活动提供基础

## 技术方案

### 1. 数据库设计

#### 1.1 生态关系表（pokemon_ecology_relations）
```sql
CREATE TABLE pokemon_ecology_relations (
    id SERIAL PRIMARY KEY,
    predator_pokemon_id INTEGER NOT NULL,
    prey_pokemon_id INTEGER NOT NULL,
    relation_type VARCHAR(20) NOT NULL CHECK (relation_type IN ('predation', 'mutualism', 'commensalism', 'competition')),
    interaction_probability DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    encounter_boost_factor DECIMAL(4,2) DEFAULT 1.0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_ecology_relation UNIQUE (predator_pokemon_id, prey_pokemon_id, relation_type),
    CONSTRAINT valid_probability CHECK (interaction_probability BETWEEN 0 AND 1),
    CONSTRAINT valid_boost CHECK (encounter_boost_factor >= 0),
    
    FOREIGN KEY (predator_pokemon_id) REFERENCES pokemon_species(id),
    FOREIGN KEY (prey_pokemon_id) REFERENCES pokemon_species(id)
);

CREATE INDEX idx_ecology_predator ON pokemon_ecology_relations(predator_pokemon_id);
CREATE INDEX idx_ecology_prey ON pokemon_ecology_relations(prey_pokemon_id);
CREATE INDEX idx_ecology_type ON pokemon_ecology_relations(relation_type);
```

#### 1.2 生态种群统计表（pokemon_population_stats）
```sql
CREATE TABLE pokemon_population_stats (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    region VARCHAR(50) NOT NULL,
    population_count INTEGER NOT NULL DEFAULT 0,
    carrying_capacity INTEGER NOT NULL,
    birth_rate DECIMAL(5,4) DEFAULT 0.1,
    death_rate DECIMAL(5,4) DEFAULT 0.05,
    migration_rate DECIMAL(5,4) DEFAULT 0.02,
    ecological_fitness DECIMAL(5,4) DEFAULT 0.5,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_population_region UNIQUE (pokemon_id, region),
    CONSTRAINT valid_rates CHECK (
        birth_rate BETWEEN 0 AND 1 AND
        death_rate BETWEEN 0 AND 1 AND
        migration_rate BETWEEN 0 AND 1
    ),
    
    FOREIGN KEY (pokemon_id) REFERENCES pokemon_species(id)
);

CREATE INDEX idx_population_pokemon ON pokemon_population_stats(pokemon_id);
CREATE INDEX idx_population_region ON pokemon_population_stats(region);
```

#### 1.3 生态事件表（ecology_events）
```sql
CREATE TABLE ecology_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    affected_pokemon_ids INTEGER[] NOT NULL,
    region VARCHAR(50),
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('minor', 'moderate', 'severe')),
    description TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_ecology_events_type ON ecology_events(event_type);
CREATE INDEX idx_ecology_events_active ON ecology_events(is_active, region);
```

### 2. 后端服务实现

#### 2.1 生态关系管理器（backend/pokemon-service/src/ecology/EcologyManager.js）
```javascript
const { Pool } = require('pg');
const Redis = require('ioredis');
const EventEmitter = require('events');

class EcologyManager extends EventEmitter {
  constructor(config) {
    super();
    this.db = new Pool(config.database);
    this.redis = new Redis(config.redis);
    this.cache = new Map();
    this.updateInterval = null;
  }

  /**
   * 初始化生态系统
   */
  async initialize() {
    await this.loadEcologyRelations();
    await this.loadPopulationStats();
    this.startPopulationUpdate();
    this.startEcologySimulation();
    
    console.log('[EcologyManager] Ecosystem initialized');
  }

  /**
   * 加载生态关系数据到缓存
   */
  async loadEcologyRelations() {
    const query = `
      SELECT 
        per.*,
        ps1.name as predator_name,
        ps2.name as prey_name
      FROM pokemon_ecology_relations per
      JOIN pokemon_species ps1 ON per.predator_pokemon_id = ps1.id
      JOIN pokemon_species ps2 ON per.prey_pokemon_id = ps2.id
      WHERE per.is_active = true
    `;
    
    const result = await this.db.query(query);
    
    // 按精灵 ID 索引
    this.ecologyRelations = {
      predators: new Map(),  // key: prey_id, value: [predator_ids]
      prey: new Map(),       // key: predator_id, value: [prey_ids]
      mutualism: new Map(),  // key: pokemon_id, value: [partner_ids]
      competition: new Map() // key: pokemon_id, value: [competitor_ids]
    };
    
    for (const row of result.rows) {
      const { predator_pokemon_id, prey_pokemon_id, relation_type } = row;
      
      switch (relation_type) {
        case 'predation':
          this.ecologyRelations.predators.set(
            prey_pokemon_id,
            [...(this.ecologyRelations.predators.get(prey_pokemon_id) || []), predator_pokemon_id]
          );
          this.ecologyRelations.prey.set(
            predator_pokemon_id,
            [...(this.ecologyRelations.prey.get(predator_pokemon_id) || []), prey_pokemon_id]
          );
          break;
          
        case 'mutualism':
          this.ecologyRelations.mutualism.set(
            predator_pokemon_id,
            [...(this.ecologyRelations.mutualism.get(predator_pokemon_id) || []), prey_pokemon_id]
          );
          this.ecologyRelations.mutualism.set(
            prey_pokemon_id,
            [...(this.ecologyRelations.mutualism.get(prey_pokemon_id) || []), predator_pokemon_id]
          );
          break;
          
        case 'competition':
          this.ecologyRelations.competition.set(
            predator_pokemon_id,
            [...(this.ecologyRelations.competition.get(predator_pokemon_id) || []), prey_pokemon_id]
          );
          this.ecologyRelations.competition.set(
            prey_pokemon_id,
            [...(this.ecologyRelations.competition.get(prey_pokemon_id) || []), predator_pokemon_id]
          );
          break;
      }
    }
    
    // 缓存到 Redis
    await this.redis.setex(
      'ecology:relations',
      3600,
      JSON.stringify(this.ecologyRelations)
    );
  }

  /**
   * 加载种群统计数据
   */
  async loadPopulationStats() {
    const query = `
      SELECT * FROM pokemon_population_stats
      ORDER BY pokemon_id, region
    `;
    
    const result = await this.db.query(query);
    
    this.populationStats = new Map();
    
    for (const row of result.rows) {
      const key = `${row.pokemon_id}:${row.region}`;
      this.populationStats.set(key, {
        population: row.population_count,
        capacity: row.carrying_capacity,
        birthRate: row.birth_rate,
        deathRate: row.death_rate,
        fitness: row.ecological_fitness
      });
    }
  }

  /**
   * 获取精灵的生态信息
   */
  async getPokemonEcologyInfo(pokemonId, region = null) {
    const cacheKey = `ecology:info:${pokemonId}:${region || 'global'}`;
    
    // 尝试从 Redis 缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    const info = {
      pokemonId,
      predators: this.ecologyRelations.predators.get(pokemonId) || [],
      prey: this.ecologyRelations.prey.get(pokemonId) || [],
      mutualPartners: this.ecologyRelations.mutualism.get(pokemonId) || [],
      competitors: this.ecologyRelations.competition.get(pokemonId) || [],
      population: null,
      ecologicalRole: this.determineEcologicalRole(pokemonId)
    };
    
    // 获取种群信息
    if (region) {
      const popKey = `${pokemonId}:${region}`;
      const pop = this.populationStats.get(popKey);
      if (pop) {
        info.population = pop;
        info.conservationStatus = this.calculateConservationStatus(pop);
      }
    }
    
    // 缓存结果
    await this.redis.setex(cacheKey, 600, JSON.stringify(info));
    
    return info;
  }

  /**
   * 确定精灵的生态角色
   */
  determineEcologicalRole(pokemonId) {
    const preyCount = this.ecologyRelations.prey.get(pokemonId)?.length || 0;
    const predatorCount = this.ecologyRelations.predators.get(pokemonId)?.length || 0;
    const mutualCount = this.ecologyRelations.mutualism.get(pokemonId)?.length || 0;
    
    if (predatorCount === 0 && preyCount > 0) {
      return 'apex_predator';
    } else if (preyCount === 0 && predatorCount > 0) {
      return 'primary_producer';
    } else if (mutualCount > 2) {
      return 'keystone_species';
    } else if (preyCount > 0 && predatorCount > 0) {
      return 'mesopredator';
    } else {
      return 'generalist';
    }
  }

  /**
   * 计算保护状态
   */
  calculateConservationStatus(population) {
    const ratio = population.population / population.capacity;
    
    if (ratio < 0.1) return 'critically_endangered';
    if (ratio < 0.3) return 'endangered';
    if (ratio < 0.5) return 'vulnerable';
    if (ratio < 0.8) return 'near_threatened';
    return 'least_concern';
  }

  /**
   * 捕捉精灵对生态系统的影响
   */
  async handlePokemonCapture(pokemonId, region, userId) {
    const popKey = `${pokemonId}:${region}`;
    const pop = this.populationStats.get(popKey);
    
    if (!pop) return { impact: 'none' };
    
    // 减少种群数量
    pop.population = Math.max(0, pop.population - 1);
    this.populationStats.set(popKey, pop);
    
    // 计算生态影响
    const impact = await this.calculateEcologicalImpact(pokemonId, region);
    
    // 如果影响显著，触发事件
    if (impact.severity !== 'none') {
      await this.triggerEcologyEvent({
        type: 'population_decline',
        pokemonId,
        region,
        severity: impact.severity,
        causedBy: userId
      });
    }
    
    // 更新数据库
    await this.db.query(
      `UPDATE pokemon_population_stats 
       SET population_count = $1, last_updated = CURRENT_TIMESTAMP
       WHERE pokemon_id = $2 AND region = $3`,
      [pop.population, pokemonId, region]
    );
    
    return impact;
  }

  /**
   * 计算生态影响
   */
  async calculateEcologicalImpact(pokemonId, region) {
    const predators = this.ecologyRelations.predators.get(pokemonId) || [];
    const prey = this.ecologyRelations.prey.get(pokemonId) || [];
    
    const impact = {
      severity: 'none',
      affectedSpecies: [],
      description: ''
    };
    
    const popKey = `${pokemonId}:${region}`;
    const pop = this.populationStats.get(popKey);
    
    if (!pop) return impact;
    
    const ratio = pop.population / pop.capacity;
    
    // 检查对捕食者的影响
    if (ratio < 0.3 && predators.length > 0) {
      impact.affectedSpecies.push(...predators);
      impact.severity = ratio < 0.1 ? 'severe' : 'moderate';
      impact.description = `Prey species decline affecting ${predators.length} predator species`;
    }
    
    // 检查对被捕食者的影响
    if (ratio < 0.3 && prey.length > 0) {
      // 捕食者减少可能导致被捕食者数量激增
      impact.affectedSpecies.push(...prey);
      impact.description += ` Predator removal may cause ${prey.length} prey species to overpopulate`;
    }
    
    return impact;
  }

  /**
   * 触发生态事件
   */
  async triggerEcologyEvent(eventData) {
    const event = {
      event_type: eventData.type,
      affected_pokemon_ids: eventData.affectedSpecies || [eventData.pokemonId],
      region: eventData.region,
      severity: eventData.severity,
      description: eventData.description || `Ecological event: ${eventData.type}`,
      metadata: {
        causedBy: eventData.causedBy,
        timestamp: new Date().toISOString()
      }
    };
    
    const query = `
      INSERT INTO ecology_events 
      (event_type, affected_pokemon_ids, region, severity, description, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    
    const result = await this.db.query(query, [
      event.event_type,
      event.affected_pokemon_ids,
      event.region,
      event.severity,
      event.description,
      event.metadata
    ]);
    
    const eventId = result.rows[0].id;
    
    // 发送事件通知
    this.emit('ecologyEvent', { id: eventId, ...event });
    
    // 发布到 Redis 供其他服务订阅
    await this.redis.publish('ecology:events', JSON.stringify({
      id: eventId,
      ...event
    }));
    
    console.log(`[EcologyManager] Event triggered: ${event.event_type} (${event.severity})`);
    
    return eventId;
  }

  /**
   * 启动种群更新定时任务
   */
  startPopulationUpdate() {
    // 每小时更新一次种群
    this.updateInterval = setInterval(async () => {
      await this.updateAllPopulations();
    }, 60 * 60 * 1000);
  }

  /**
   * 更新所有种群数量（基于 Lotka-Volterra 模型）
   */
  async updateAllPopulations() {
    for (const [key, pop] of this.populationStats) {
      const [pokemonId, region] = key.split(':');
      
      // 获取被捕食者和捕食者
      const prey = this.ecologyRelations.prey.get(parseInt(pokemonId)) || [];
      const predators = this.ecologyRelations.predators.get(parseInt(pokemonId)) || [];
      
      // 计算食物可用性
      let foodAvailability = 1.0;
      for (const preyId of prey) {
        const preyPop = this.populationStats.get(`${preyId}:${region}`);
        if (preyPop) {
          foodAvailability *= preyPop.population / preyPop.capacity;
        }
      }
      
      // 计算捕食压力
      let predatorPressure = 0;
      for (const predId of predators) {
        const predPop = this.populationStats.get(`${predId}:${region}`);
        if (predPop) {
          predatorPressure += predPop.population / predPop.capacity;
        }
      }
      predatorPressure = Math.min(1, predatorPressure);
      
      // 更新种群（简化版 Lotka-Volterra）
      const growthRate = pop.birthRate * foodAvailability - pop.deathRate * (1 + predatorPressure);
      const carryingCapacityEffect = 1 - (pop.population / pop.capacity);
      
      const newPopulation = Math.floor(
        pop.population * (1 + growthRate * carryingCapacityEffect)
      );
      
      pop.population = Math.max(0, Math.min(pop.capacity, newPopulation));
      this.populationStats.set(key, pop);
      
      // 更新数据库
      await this.db.query(
        `UPDATE pokemon_population_stats 
         SET population_count = $1, last_updated = CURRENT_TIMESTAMP
         WHERE pokemon_id = $2 AND region = $3`,
        [pop.population, pokemonId, region]
      );
    }
    
    console.log('[EcologyManager] Population update completed');
  }

  /**
   * 启动生态模拟
   */
  startEcologySimulation() {
    // 每 6 小时检查一次生态平衡
    setInterval(async () => {
      await this.checkEcologicalBalance();
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * 检查生态平衡
   */
  async checkEcologicalBalance() {
    const imbalances = [];
    
    for (const [key, pop] of this.populationStats) {
      const ratio = pop.population / pop.capacity;
      
      if (ratio < 0.2 || ratio > 1.5) {
        imbalances.push({
          key,
          pokemonId: key.split(':')[0],
          region: key.split(':')[1],
          ratio,
          status: ratio < 0.2 ? 'underpopulated' : 'overpopulated'
        });
      }
    }
    
    if (imbalances.length > 0) {
      await this.triggerEcologyEvent({
        type: 'ecological_imbalance',
        affectedSpecies: imbalances.map(i => parseInt(i.pokemonId)),
        severity: 'moderate',
        description: `${imbalances.length} species showing population imbalance`,
        metadata: { imbalances }
      });
    }
    
    return imbalances;
  }

  /**
   * 获取生态链可视化数据
   */
  async getEcologyVisualization(region, depth = 3) {
    const nodes = new Map();
    const links = [];
    
    // 遍历所有种群
    for (const [key, pop] of this.populationStats) {
      const [pokemonId, popRegion] = key.split(':');
      
      if (region && popRegion !== region) continue;
      
      const pokemonIdNum = parseInt(pokemonId);
      
      // 添加节点
      if (!nodes.has(pokemonIdNum)) {
        nodes.set(pokemonIdNum, {
          id: pokemonIdNum,
          population: pop.population,
          capacity: pop.capacity,
          role: this.determineEcologicalRole(pokemonIdNum)
        });
      }
      
      // 添加捕食关系
      const prey = this.ecologyRelations.prey.get(pokemonIdNum) || [];
      for (const preyId of prey) {
        links.push({
          source: pokemonIdNum,
          target: preyId,
          type: 'predation'
        });
      }
      
      // 添加共生关系
      const mutual = this.ecologyRelations.mutualism.get(pokemonIdNum) || [];
      for (const partnerId of mutual) {
        if (partnerId > pokemonIdNum) { // 避免重复
          links.push({
            source: pokemonIdNum,
            target: partnerId,
            type: 'mutualism'
          });
        }
      }
    }
    
    return {
      nodes: Array.from(nodes.values()),
      links,
      metadata: {
        region,
        totalSpecies: nodes.size,
        totalRelations: links.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  /**
   * 关闭资源
   */
  async shutdown() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    await this.db.end();
    await this.redis.quit();
  }
}

module.exports = EcologyManager;
```

#### 2.2 生态事件处理器（backend/pokemon-service/src/ecology/EcologyEventHandler.js）
```javascript
const EventEmitter = require('events');

class EcologyEventHandler extends EventEmitter {
  constructor(ecologyManager, notificationService, rewardService) {
    super();
    this.ecologyManager = ecologyManager;
    this.notificationService = notificationService;
    this.rewardService = rewardService;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.ecologyManager.on('ecologyEvent', async (event) => {
      await this.handleEcologyEvent(event);
    });
  }

  async handleEcologyEvent(event) {
    console.log(`[EcologyEventHandler] Processing event: ${event.event_type}`);
    
    switch (event.event_type) {
      case 'population_decline':
        await this.handlePopulationDecline(event);
        break;
        
      case 'ecological_imbalance':
        await this.handleEcologicalImbalance(event);
        break;
        
      case 'species_resurgence':
        await this.handleSpeciesResurgence(event);
        break;
        
      default:
        console.log(`Unknown event type: ${event.event_type}`);
    }
  }

  async handlePopulationDecline(event) {
    // 通知附近的玩家
    await this.notificationService.notifyRegion(event.region, {
      type: 'ecology_alert',
      title: '生态系统预警',
      message: event.description,
      severity: event.severity,
      affectedSpecies: event.affected_pokemon_ids
    });
    
    // 触发保护任务
    if (event.severity === 'severe') {
      await this.rewardService.createEcologyProtectionTask({
        pokemonIds: event.affected_pokemon_ids,
        region: event.region,
        bonusReward: {
          type: 'conservation_points',
          amount: 100
        }
      });
    }
  }

  async handleEcologicalImbalance(event) {
    // 记录到监控系统
    console.log(`[EcologyEventHandler] Ecological imbalance detected: ${event.description}`);
    
    // 发送管理员通知
    await this.notificationService.notifyAdmins({
      type: 'ecology_imbalance',
      event,
      requiresAction: true
    });
  }

  async handleSpeciesResurgence(event) {
    // 庆祝事件
    await this.notificationService.notifyRegion(event.region, {
      type: 'ecology_celebration',
      title: '物种复苏！',
      message: `稀有物种数量正在恢复`,
      bonusSpawnRate: 1.5 // 临时提高出现率
    });
  }
}

module.exports = EcologyEventHandler;
```

#### 2.3 API 路由（backend/pokemon-service/src/routes/ecology.js）
```javascript
const express = require('express');
const router = express.Router();
const EcologyManager = require('../ecology/EcologyManager');

// GET /api/pokemon/ecology/:pokemonId - 获取精灵生态信息
router.get('/ecology/:pokemonId', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { region } = req.query;
    
    const ecologyManager = req.app.locals.ecologyManager;
    const info = await ecologyManager.getPokemonEcologyInfo(parseInt(pokemonId), region);
    
    res.json({
      success: true,
      data: info
    });
  } catch (error) {
    console.error('Error fetching ecology info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ecology information'
    });
  }
});

// GET /api/pokemon/ecology/visualization - 获取生态链可视化数据
router.get('/ecology/visualization', async (req, res) => {
  try {
    const { region, depth } = req.query;
    
    const ecologyManager = req.app.locals.ecologyManager;
    const visualization = await ecologyManager.getEcologyVisualization(region, parseInt(depth) || 3);
    
    res.json({
      success: true,
      data: visualization
    });
  } catch (error) {
    console.error('Error generating visualization:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate ecology visualization'
    });
  }
});

// POST /api/pokemon/ecology/impact - 模拟生态影响
router.post('/ecology/impact', async (req, res) => {
  try {
    const { pokemonId, region, action } = req.body;
    
    const ecologyManager = req.app.locals.ecologyManager;
    
    // 模拟不同行动的影响
    let impact;
    switch (action) {
      case 'capture':
        impact = await ecologyManager.calculateEcologicalImpact(pokemonId, region);
        break;
        
      case 'release':
        impact = await ecologyManager.simulateRelease(pokemonId, region);
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid action'
        });
    }
    
    res.json({
      success: true,
      data: impact
    });
  } catch (error) {
    console.error('Error calculating impact:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate ecological impact'
    });
  }
});

// GET /api/pokemon/ecology/events - 获取当前生态事件
router.get('/ecology/events', async (req, res) => {
  try {
    const { region, active } = req.query;
    
    const query = `
      SELECT * FROM ecology_events
      WHERE ($1::text IS NULL OR region = $1)
        AND ($2::boolean IS NULL OR is_active = $2)
      ORDER BY started_at DESC
      LIMIT 20
    `;
    
    const result = await req.app.locals.db.query(query, [region, active === 'true']);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching ecology events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ecology events'
    });
  }
});

// GET /api/pokemon/ecology/conservation - 获取保护状态报告
router.get('/ecology/conservation', async (req, res) => {
  try {
    const { region } = req.query;
    
    const ecologyManager = req.app.locals.ecologyManager;
    const stats = [];
    
    for (const [key, pop] of ecologyManager.populationStats) {
      if (region && !key.includes(region)) continue;
      
      const [pokemonId, popRegion] = key.split(':');
      const status = ecologyManager.calculateConservationStatus(pop);
      
      if (status !== 'least_concern') {
        stats.push({
          pokemonId: parseInt(pokemonId),
          region: popRegion,
          population: pop.population,
          capacity: pop.capacity,
          status,
          ratio: pop.population / pop.capacity
        });
      }
    }
    
    // 按危险程度排序
    stats.sort((a, b) => a.ratio - b.ratio);
    
    res.json({
      success: true,
      data: {
        threatenedSpecies: stats,
        summary: {
          criticallyEndangered: stats.filter(s => s.status === 'critically_endangered').length,
          endangered: stats.filter(s => s.status === 'endangered').length,
          vulnerable: stats.filter(s => s.status === 'vulnerable').length,
          nearThreatened: stats.filter(s => s.status === 'near_threatened').length
        }
      }
    });
  } catch (error) {
    console.error('Error generating conservation report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate conservation report'
    });
  }
});

module.exports = router;
```

### 3. 前端实现

#### 3.1 生态链可视化组件（frontend/game-client/src/components/EcologyVisualization.vue）
```vue
<template>
  <div class="ecology-visualization">
    <div class="visualization-header">
      <h2>生态链图谱</h2>
      <div class="controls">
        <select v-model="selectedRegion" @change="loadVisualization">
          <option value="">全部区域</option>
          <option v-for="region in regions" :key="region" :value="region">
            {{ region }}
          </option>
        </select>
        
        <div class="legend">
          <div class="legend-item">
            <span class="node apex"></span> 顶级捕食者
          </div>
          <div class="legend-item">
            <span class="node mesopredator"></span> 中级捕食者
          </div>
          <div class="legend-item">
            <span class="node producer"></span> 初级生产者
          </div>
          <div class="legend-item">
            <span class="node keystone"></span> 关键物种
          </div>
        </div>
      </div>
    </div>
    
    <div ref="canvas" class="canvas-container">
      <canvas ref="ecologyCanvas" @click="handleNodeClick"></canvas>
    </div>
    
    <div v-if="selectedPokemon" class="pokemon-detail">
      <PokemonCard :pokemon="selectedPokemon" />
      <div class="ecology-info">
        <h3>生态角色</h3>
        <p>{{ selectedPokemon.ecologicalRole }}</p>
        
        <h3>保护状态</h3>
        <div class="conservation-status" :class="selectedPokemon.conservationStatus">
          {{ formatConservationStatus(selectedPokemon.conservationStatus) }}
        </div>
        
        <div class="population-chart">
          <PopulationTrend :pokemonId="selectedPokemon.id" :region="selectedRegion" />
        </div>
        
        <div class="relations">
          <div v-if="selectedPokemon.predators.length > 0">
            <h4>天敌 ({{ selectedPokemon.predators.length }})</h4>
            <PokemonList :pokemonIds="selectedPokemon.predators" />
          </div>
          
          <div v-if="selectedPokemon.prey.length > 0">
            <h4>猎物 ({{ selectedPokemon.prey.length }})</h4>
            <PokemonList :pokemonIds="selectedPokemon.prey" />
          </div>
          
          <div v-if="selectedPokemon.mutualPartners.length > 0">
            <h4>共生伙伴 ({{ selectedPokemon.mutualPartners.length }})</h4>
            <PokemonList :pokemonIds="selectedPokemon.mutualPartners" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, computed } from 'vue';
import * as d3 from 'd3';
import PokemonCard from './PokemonCard.vue';
import PokemonList from './PokemonList.vue';
import PopulationTrend from './PopulationTrend.vue';

export default {
  name: 'EcologyVisualization',
  components: {
    PokemonCard,
    PokemonList,
    PopulationTrend
  },
  setup() {
    const ecologyCanvas = ref(null);
    const selectedRegion = ref('');
    const regions = ref(['forest', 'desert', 'ocean', 'mountain', 'grassland']);
    const selectedPokemon = ref(null);
    const ecologyData = ref({ nodes: [], links: [] });
    
    const roleStyles = {
      apex_predator: { color: '#e74c3c', size: 30 },
      mesopredator: { color: '#f39c12', size: 20 },
      primary_producer: { color: '#2ecc71', size: 15 },
      keystone_species: { color: '#9b59b6', size: 25 },
      generalist: { color: '#3498db', size: 18 }
    };
    
    const loadVisualization = async () => {
      const params = new URLSearchParams();
      if (selectedRegion.value) {
        params.append('region', selectedRegion.value);
      }
      
      const response = await fetch(`/api/pokemon/ecology/visualization?${params}`);
      const data = await response.json();
      
      if (data.success) {
        ecologyData.value = data.data;
        renderVisualization();
      }
    };
    
    const renderVisualization = () => {
      const canvas = ecologyCanvas.value;
      const width = canvas.width;
      const height = canvas.height;
      const ctx = canvas.getContext('2d');
      
      // 清空画布
      ctx.clearRect(0, 0, width, height);
      
      // 创建力导向图
      const simulation = d3.forceSimulation(ecologyData.value.nodes)
        .force('link', d3.forceLink(ecologyData.value.links).id(d => d.id))
        .force('charge', d3.forceManyBody().strength(-100))
        .force('center', d3.forceCenter(width / 2, height / 2));
      
      // 渲染链接
      ecologyData.value.links.forEach(link => {
        ctx.beginPath();
        ctx.moveTo(link.source.x, link.source.y);
        ctx.lineTo(link.target.x, link.target.y);
        ctx.strokeStyle = link.type === 'predation' ? '#e74c3c' : '#2ecc71';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      
      // 渲染节点
      ecologyData.value.nodes.forEach(node => {
        const style = roleStyles[node.role] || roleStyles.generalist;
        
        ctx.beginPath();
        ctx.arc(node.x, node.y, style.size, 0, 2 * Math.PI);
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // 种群比例
        const ratio = node.population / node.capacity;
        ctx.beginPath();
        ctx.arc(node.x, node.y, style.size * ratio, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fill();
      });
    };
    
    const handleNodeClick = (event) => {
      const rect = ecologyCanvas.value.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      // 查找点击的节点
      const clickedNode = ecologyData.value.nodes.find(node => {
        const distance = Math.sqrt((node.x - x) ** 2 + (node.y - y) ** 2);
        return distance < roleStyles[node.role]?.size || 20;
      });
      
      if (clickedNode) {
        loadPokemonDetail(clickedNode.id);
      }
    };
    
    const loadPokemonDetail = async (pokemonId) => {
      const params = selectedRegion.value ? `?region=${selectedRegion.value}` : '';
      const response = await fetch(`/api/pokemon/ecology/${pokemonId}${params}`);
      const data = await response.json();
      
      if (data.success) {
        selectedPokemon.value = data.data;
      }
    };
    
    const formatConservationStatus = (status) => {
      const statusMap = {
        critically_endangered: '极度濒危',
        endangered: '濒危',
        vulnerable: '易危',
        near_threatened: '近危',
        least_concern: '无危'
      };
      return statusMap[status] || status;
    };
    
    onMounted(() => {
      loadVisualization();
    });
    
    return {
      ecologyCanvas,
      selectedRegion,
      regions,
      selectedPokemon,
      loadVisualization,
      handleNodeClick,
      formatConservationStatus
    };
  }
};
</script>

<style scoped>
.ecology-visualization {
  display: flex;
  height: 100%;
}

.canvas-container {
  flex: 1;
  position: relative;
}

.ecology-canvas {
  width: 100%;
  height: 100%;
}

.pokemon-detail {
  width: 400px;
  padding: 20px;
  background: #f5f5f5;
  overflow-y: auto;
}

.conservation-status {
  padding: 10px;
  border-radius: 4px;
  font-weight: bold;
  text-align: center;
}

.conservation-status.critically_endangered {
  background: #e74c3c;
  color: white;
}

.conservation-status.endangered {
  background: #f39c12;
  color: white;
}

.conservation-status.vulnerable {
  background: #f1c40f;
  color: black;
}

.conservation-status.near_threatened {
  background: #3498db;
  color: white;
}

.legend {
  display: flex;
  gap: 15px;
  margin-left: 20px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.node {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}

.node.apex { background: #e74c3c; }
.node.mesopredator { background: #f39c12; }
.node.producer { background: #2ecc71; }
.node.keystone { background: #9b59b6; }
</style>
```

### 4. 初始化数据脚本

#### 4.1 生态关系初始化（database/migrations/20260626_ecology_init.sql）
```sql
-- 初始化常见精灵的生态关系

-- 捕食关系
INSERT INTO pokemon_ecology_relations (predator_pokemon_id, prey_pokemon_id, relation_type, interaction_probability) VALUES
-- 皮卡丘的食物链
(25, 10, 'predation', 0.3),  -- 皮卡丘捕食 Caterpie
(25, 13, 'predation', 0.25), -- 皮卡丘捕食 Weedle

-- 喷火龙的食物链
(6, 19, 'predation', 0.4),   -- 喷火龙捕食 Rattata
(6, 21, 'predation', 0.35),  -- 喷火龙捕食 Spearow

-- 水箭龟的食物链
(9, 54, 'predation', 0.5),   -- 水箭龟捕食 Psyduck
(9, 72, 'predation', 0.45),  -- 水箭龟捕食 Tentacool

-- 妙蛙花的食物链
(3, 69, 'predation', 0.3),   -- 妙蛙花捕食 Bellsprout
(3, 43, 'predation', 0.25),  -- 妙蛙花捕食 Oddish

-- 共生关系
(25, 35, 'mutualism', 0.6),  -- 皮卡丘与 Clefairy 共生
(143, 143, 'mutualism', 0.4), -- Snorlax 自我调节

-- 竞争关系
(6, 9, 'competition', 0.7),  -- 喷火龙与水箭龟竞争
(3, 6, 'competition', 0.6);  -- 妙蛙花与喷火龙竞争

-- 初始化种群统计
INSERT INTO pokemon_population_stats (pokemon_id, region, population_count, carrying_capacity, birth_rate, death_rate) VALUES
(25, 'forest', 150, 200, 0.12, 0.05),
(25, 'grassland', 80, 120, 0.10, 0.04),
(6, 'mountain', 20, 30, 0.05, 0.02),
(9, 'ocean', 50, 80, 0.08, 0.03),
(3, 'forest', 60, 100, 0.09, 0.04);

-- 创建生态事件索引视图
CREATE VIEW active_ecology_events AS
SELECT 
  ee.*,
  array_agg(ps.name) as affected_pokemon_names
FROM ecology_events ee
LEFT JOIN unnest(ee.affected_pokemon_ids) AS pokemon_id ON true
LEFT JOIN pokemon_species ps ON ps.id = pokemon_id
WHERE ee.is_active = true
GROUP BY ee.id;
```

## 验收标准

- [ ] 数据库表结构创建完成，包含生态关系表、种群统计表、生态事件表
- [ ] EcologyManager 实现完整，支持生态关系加载、种群更新、生态模拟
- [ ] 捕捉精灵能触发生态影响计算，影响种群数量
- [ ] 生态链可视化功能可用，支持按区域过滤
- [ ] 生态事件能正确触发并发送通知
- [ ] 保护状态报告准确反映濒危物种情况
- [ ] 前端可视化组件渲染正确，节点可交互
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整的生态流程
- [ ] 性能测试：生态计算不影响主游戏流程响应时间（< 100ms）

## 影响范围

- **新增文件**：
  - `backend/pokemon-service/src/ecology/EcologyManager.js`
  - `backend/pokemon-service/src/ecology/EcologyEventHandler.js`
  - `backend/pokemon-service/src/routes/ecology.js`
  - `frontend/game-client/src/components/EcologyVisualization.vue`
  - `frontend/game-client/src/components/PopulationTrend.vue`
  
- **修改文件**：
  - `backend/pokemon-service/src/index.js` - 挂载生态路由
  - `backend/pokemon-service/src/index.js` - 初始化 EcologyManager
  - `backend/catch-service/src/handlers/catchHandler.js` - 集成生态影响计算
  
- **数据库迁移**：
  - `database/migrations/20260626_ecology_init.sql`

## 参考

- [Lotka-Volterra 捕食模型](https://en.wikipedia.org/wiki/Lotka%E2%80%93Volterra_equations)
- [生态系统食物网理论](https://www.nature.com/scitable/knowledge/library/food-webs-11584296/)
- [D3.js 力导向图文档](https://github.com/d3/d3-force)
- 相关需求：REQ-00065（精灵进化系统）、REQ-00067（精灵羁绊系统）
