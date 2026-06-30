# REQ-00396: 精灵生态链与食物网系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00396 |
| 标题 | 精灵生态链与食物网系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、location-service、catch-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-30 19:20 UTC |

## 需求描述

精灵生态链与食物网系统旨在为 mineGo 游戏增加生态学维度的玩法深度。通过建立精灵之间的捕食、共生、竞争关系，让玩家在捕捉和培育精灵时需要考虑生态平衡，增加游戏策略性。

### 核心功能

1. **生态关系定义**
   - 捕食关系：某些精灵是其他精灵的天敌（如：猫头鹰系 → 鼠系）
   - 共生关系：精灵之间存在互利共生（如：水母系与贝壳系）
   - 竞争关系：同生态位的精灵会争夺资源
   - 食物链层级：定义精灵在食物网中的层级位置

2. **生态加成系统**
   - 在特定精灵栖息地，存在天敌时降低出现率
   - 存在共生伙伴时提升稀有度
   - 竞争关系精灵共存时触发特殊事件
   - 食物链顶端精灵需要特定条件才会出现

3. **生态系统动态平衡**
   - 过度捕捉某层级精灵会触发生态失衡事件
   - 生态失衡可能导致精灵迁移或种群下降
   - 玩家可通过放生精灵恢复生态平衡
   - 系统定期自动调整区域精灵分布

4. **生态图鉴**
   - 记录已发现的生态关系
   - 显示食物网可视化图表
   - 提供生态加成查询
   - 生态系统健康度报告

## 技术方案

### 1. 数据库模型设计

```sql
-- 生态关系表
CREATE TABLE pokemon_ecosystem_relations (
    id SERIAL PRIMARY KEY,
    source_pokemon_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    target_pokemon_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    relation_type VARCHAR(20) NOT NULL CHECK (relation_type IN ('predator', 'prey', 'symbiotic', 'competitor')),
    strength DECIMAL(3,2) DEFAULT 1.0 CHECK (strength >= 0 AND strength <= 1),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_pokemon_id, target_pokemon_id, relation_type)
);

CREATE INDEX idx_eco_source ON pokemon_ecosystem_relations(source_pokemon_id);
CREATE INDEX idx_eco_target ON pokemon_ecosystem_relations(target_pokemon_id);
CREATE INDEX idx_eco_type ON pokemon_ecosystem_relations(relation_type);

-- 食物链层级表
CREATE TABLE pokemon_trophic_levels (
    pokemon_id INTEGER PRIMARY KEY REFERENCES pokemon_species(id),
    trophic_level INTEGER NOT NULL CHECK (trophic_level BETWEEN 1 AND 5),
    ecological_niche VARCHAR(50),
    notes TEXT
);

-- 区域生态状态表
CREATE TABLE region_ecosystem_status (
    id SERIAL PRIMARY KEY,
    region_id VARCHAR(100) NOT NULL,
    pokemon_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    population_score DECIMAL(5,2) DEFAULT 50.0,
    last_spawned_at TIMESTAMP,
    capture_count INTEGER DEFAULT 0,
    release_count INTEGER DEFAULT 0,
    balance_factor DECIMAL(3,2) DEFAULT 1.0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(region_id, pokemon_species_id)
);

CREATE INDEX idx_region_eco_region ON region_ecosystem_status(region_id);
CREATE INDEX idx_region_eco_pokemon ON region_ecosystem_status(pokemon_species_id);

-- 生态事件日志表
CREATE TABLE ecosystem_event_logs (
    id SERIAL PRIMARY KEY,
    region_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    description TEXT,
    affected_pokemon_ids INTEGER[],
    severity VARCHAR(20) DEFAULT 'info',
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eco_event_region ON ecosystem_event_logs(region_id);
CREATE INDEX idx_eco_event_type ON ecosystem_event_logs(event_type);
CREATE INDEX idx_eco_event_time ON ecosystem_event_logs(created_at);
```

### 2. 生态关系服务模块

```javascript
// backend/shared/ecosystem/EcosystemEngine.js
class EcosystemEngine {
  constructor({ db, redis, logger }) {
    this.db = db;
    this.redis = redis;
    this.logger = logger;
    this.relationCache = new Map();
    this.trophicCache = new Map();
  }

  /**
   * 获取精灵的所有生态关系
   */
  async getRelations(pokemonId) {
    const cacheKey = `eco:relations:${pokemonId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = await this.db.query(`
      SELECT 
        er.*,
        ps.name as target_name,
        ps.type as target_type,
        tl.trophic_level as target_trophic_level
      FROM pokemon_ecosystem_relations er
      JOIN pokemon_species ps ON er.target_pokemon_id = ps.id
      LEFT JOIN pokemon_trophic_levels tl ON er.target_pokemon_id = tl.pokemon_id
      WHERE er.source_pokemon_id = $1
    `, [pokemonId]);

    const relations = {
      predators: result.rows.filter(r => r.relation_type === 'predator'),
      prey: result.rows.filter(r => r.relation_type === 'prey'),
      symbiotic: result.rows.filter(r => r.relation_type === 'symbiotic'),
      competitors: result.rows.filter(r => r.relation_type === 'competitor')
    };

    await this.redis.setex(cacheKey, 3600, JSON.stringify(relations));
    return relations;
  }

  /**
   * 计算生态加成
   */
  async calculateEcosystemBonuses(regionId, pokemonId) {
    const relations = await this.getRelations(pokemonId);
    const regionStatus = await this.getRegionEcosystemStatus(regionId);
    
    const bonuses = {
      spawnRateMultiplier: 1.0,
      rarityBonus: 0,
      specialEventChance: 0,
      balanceWarning: null
    };

    // 天敌存在时降低出现率
    for (const predator of relations.predators) {
      const predatorStatus = regionStatus.find(s => s.pokemon_species_id === predator.target_pokemon_id);
      if (predatorStatus && predatorStatus.population_score > 30) {
        bonuses.spawnRateMultiplier *= (1 - predator.strength * 0.3);
      }
    }

    // 共生伙伴存在时提升稀有度
    for (const symbiont of relations.symbiotic) {
      const symbiontStatus = regionStatus.find(s => s.pokemon_species_id === symbiont.target_pokemon_id);
      if (symbiontStatus && symbiontStatus.population_score > 40) {
        bonuses.rarityBonus += symbiont.strength * 10;
      }
    }

    // 竞争者共存时增加特殊事件几率
    for (const competitor of relations.competitors) {
      const competitorStatus = regionStatus.find(s => s.pokemon_species_id === competitor.target_pokemon_id);
      if (competitorStatus && competitorStatus.population_score > 50) {
        bonuses.specialEventChance += competitor.strength * 5;
      }
    }

    // 检查生态失衡
    const currentStatus = regionStatus.find(s => s.pokemon_species_id === pokemonId);
    if (currentStatus && currentStatus.population_score < 20) {
      bonuses.balanceWarning = 'population_critical';
    } else if (currentStatus && currentStatus.population_score > 80) {
      bonuses.balanceWarning = 'population_excessive';
    }

    return bonuses;
  }

  /**
   * 获取区域生态状态
   */
  async getRegionEcosystemStatus(regionId) {
    const result = await this.db.query(`
      SELECT res.*, ps.name, ps.type, tl.trophic_level
      FROM region_ecosystem_status res
      JOIN pokemon_species ps ON res.pokemon_species_id = ps.id
      LEFT JOIN pokemon_trophic_levels tl ON res.pokemon_species_id = tl.pokemon_id
      WHERE res.region_id = $1
      ORDER BY res.population_score DESC
    `, [regionId]);
    
    return result.rows;
  }

  /**
   * 记录捕捉对生态的影响
   */
  async recordCapture(regionId, pokemonId) {
    await this.db.query(`
      INSERT INTO region_ecosystem_status (region_id, pokemon_species_id, capture_count, population_score)
      VALUES ($1, $2, 1, 48)
      ON CONFLICT (region_id, pokemon_species_id) 
      DO UPDATE SET 
        capture_count = region_ecosystem_status.capture_count + 1,
        population_score = GREATEST(5, region_ecosystem_status.population_score - 0.5),
        updated_at = CURRENT_TIMESTAMP
    `, [regionId, pokemonId]);

    // 检查是否触发生态事件
    await this.checkEcosystemBalance(regionId);
  }

  /**
   * 记录放生对生态的影响
   */
  async recordRelease(regionId, pokemonId) {
    await this.db.query(`
      INSERT INTO region_ecosystem_status (region_id, pokemon_species_id, release_count, population_score)
      VALUES ($1, $2, 1, 52)
      ON CONFLICT (region_id, pokemon_species_id) 
      DO UPDATE SET 
        release_count = region_ecosystem_status.release_count + 1,
        population_score = LEAST(95, region_ecosystem_status.population_score + 1),
        updated_at = CURRENT_TIMESTAMP
    `, [regionId, pokemonId]);
  }

  /**
   * 检查生态平衡状态
   */
  async checkEcosystemBalance(regionId) {
    const status = await this.getRegionEcosystemStatus(regionId);
    const critical = status.filter(s => s.population_score < 15);
    const excessive = status.filter(s => s.population_score > 85);

    for (const species of critical) {
      await this.logEcosystemEvent(regionId, 'population_critical', 
        `${species.name} 种群数量过低`, [species.pokemon_species_id], 'warning');
    }

    for (const species of excessive) {
      await this.logEcosystemEvent(regionId, 'population_excessive',
        `${species.name} 种群数量过高`, [species.pokemon_species_id], 'info');
    }

    // 检查食物链失衡
    await this.checkFoodChainBalance(regionId, status);
  }

  /**
   * 检查食物链平衡
   */
  async checkFoodChainBalance(regionId, status) {
    const trophicLevels = {};
    for (const species of status) {
      const level = species.trophic_level || 3;
      if (!trophicLevels[level]) trophicLevels[level] = [];
      trophicLevels[level].push(species);
    }

    // 如果某层级过度减少
    for (const [level, species] of Object.entries(trophicLevels)) {
      const avgPopulation = species.reduce((sum, s) => sum + s.population_score, 0) / species.length;
      if (avgPopulation < 25) {
        await this.logEcosystemEvent(regionId, 'trophic_level_imbalance',
          `第 ${level} 层级种群过低`, species.map(s => s.pokemon_species_id), 'warning');
      }
    }
  }

  /**
   * 记录生态事件
   */
  async logEcosystemEvent(regionId, eventType, description, affectedPokemonIds, severity) {
    await this.db.query(`
      INSERT INTO ecosystem_event_logs (region_id, event_type, description, affected_pokemon_ids, severity)
      VALUES ($1, $2, $3, $4, $5)
    `, [regionId, eventType, description, affectedPokemonIds, severity]);
  }
}

module.exports = EcosystemEngine;
```

### 3. Location Service 集成

```javascript
// backend/services/location/src/routes/spawn.js
router.get('/api/location/:regionId/spawn', auth, async (req, res) => {
  try {
    const { regionId } = req.params;
    const ecosystemEngine = req.app.locals.ecosystemEngine;
    
    // 获取区域内可能的精灵
    const possibleSpawns = await getRegionSpawns(regionId);
    
    // 为每个可能的精灵计算生态加成
    const weightedSpawns = await Promise.all(
      possibleSpawns.map(async (spawn) => {
        const bonuses = await ecosystemEngine.calculateEcosystemBonuses(regionId, spawn.pokemon_id);
        return {
          ...spawn,
          weight: spawn.base_weight * bonuses.spawnRateMultiplier,
          rarityBonus: bonuses.rarityBonus,
          specialEvent: Math.random() * 100 < bonuses.specialEventChance,
          balanceWarning: bonuses.balanceWarning
        };
      })
    );

    // 按权重选择精灵
    const selectedSpawn = selectWeightedRandom(weightedSpawns);
    
    res.json({
      success: true,
      spawn: selectedSpawn,
      ecosystemStatus: await ecosystemEngine.getRegionEcosystemStatus(regionId)
    });
  } catch (err) {
    logger.error('Spawn generation failed', { error: err.message });
    res.status(500).json({ error: 'Spawn generation failed' });
  }
});
```

### 4. 生态图鉴 API

```javascript
// backend/services/pokemon/src/routes/ecosystem.js
router.get('/api/pokemon/:id/ecosystem', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const ecosystemEngine = req.app.locals.ecosystemEngine;
    
    const relations = await ecosystemEngine.getRelations(id);
    const trophicLevel = await ecosystemEngine.getTrophicLevel(id);
    
    res.json({
      success: true,
      data: {
        pokemon_id: id,
        trophic_level: trophicLevel,
        relations,
        food_web_position: calculateFoodWebPosition(relations, trophicLevel)
      }
    });
  } catch (err) {
    logger.error('Failed to get ecosystem data', { error: err.message });
    res.status(500).json({ error: 'Failed to get ecosystem data' });
  }
});

// 食物网可视化数据
router.get('/api/pokemon/ecosystem/food-web', auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        er.source_pokemon_id,
        ps1.name as source_name,
        er.target_pokemon_id,
        ps2.name as target_name,
        er.relation_type,
        er.strength
      FROM pokemon_ecosystem_relations er
      JOIN pokemon_species ps1 ON er.source_pokemon_id = ps1.id
      JOIN pokemon_species ps2 ON er.target_pokemon_id = ps2.id
      ORDER BY er.strength DESC
    `);

    // 构建图数据结构
    const nodes = new Map();
    const edges = [];

    for (const row of result.rows) {
      nodes.set(row.source_pokemon_id, { id: row.source_pokemon_id, name: row.source_name });
      nodes.set(row.target_pokemon_id, { id: row.target_pokemon_id, name: row.target_name });
      edges.push({
        source: row.source_pokemon_id,
        target: row.target_pokemon_id,
        type: row.relation_type,
        strength: row.strength
      });
    }

    res.json({
      success: true,
      data: {
        nodes: Array.from(nodes.values()),
        edges
      }
    });
  } catch (err) {
    logger.error('Failed to get food web', { error: err.message });
    res.status(500).json({ error: 'Failed to get food web' });
  }
});
```

### 5. 前端生态图鉴组件

```javascript
// frontend/game-client/src/components/EcosystemPokedex.jsx
import React, { useState, useEffect } from 'react';
import { forceSimulation, forceLink, forceNode } from 'd3-force';
import { SVG } from './SVG';

export function EcosystemPokedex({ pokemonId }) {
  const [ecoData, setEcoData] = useState(null);
  const [foodWeb, setFoodWeb] = useState(null);
  const [selectedTab, setSelectedTab] = useState('relations');

  useEffect(() => {
    fetch(`/api/pokemon/${pokemonId}/ecosystem`)
      .then(res => res.json())
      .then(data => setEcoData(data.data));
  }, [pokemonId]);

  useEffect(() => {
    fetch('/api/pokemon/ecosystem/food-web')
      .then(res => res.json())
      .then(data => setFoodWeb(data.data));
  }, []);

  const renderRelations = () => {
    if (!ecoData) return <div className="loading">Loading...</div>;
    
    return (
      <div className="relations-container">
        <div className="trophic-level">
          <h4>食物链层级</h4>
          <div className="level-indicator">
            {[1, 2, 3, 4, 5].map(level => (
              <span 
                key={level} 
                className={level === ecoData.trophic_level ? 'active' : ''}
              >
                {level}
              </span>
            ))}
          </div>
        </div>

        <div className="relation-group">
          <h4>🦁 天敌</h4>
          <ul>
            {ecoData.relations.predators.map(p => (
              <li key={p.target_pokemon_id}>
                <img src={`/sprites/${p.target_pokemon_id}.png`} alt={p.target_name} />
                <span>{p.target_name}</span>
                <span className="strength">{Math.round(p.strength * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relation-group">
          <h4>🐟 猎物</h4>
          <ul>
            {ecoData.relations.prey.map(p => (
              <li key={p.target_pokemon_id}>
                <img src={`/sprites/${p.target_pokemon_id}.png`} alt={p.target_name} />
                <span>{p.target_name}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relation-group">
          <h4>🤝 共生伙伴</h4>
          <ul>
            {ecoData.relations.symbiotic.map(p => (
              <li key={p.target_pokemon_id}>
                <img src={`/sprites/${p.target_pokemon_id}.png`} alt={p.target_name} />
                <span>{p.target_name}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relation-group">
          <h4>⚔️ 竞争者</h4>
          <ul>
            {ecoData.relations.competitors.map(p => (
              <li key={p.target_pokemon_id}>
                <img src={`/sprites/${p.target_pokemon_id}.png`} alt={p.target_name} />
                <span>{p.target_name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  };

  const renderFoodWeb = () => {
    if (!foodWeb) return <div className="loading">Loading...</div>;
    
    return <FoodWebVisualization nodes={foodWeb.nodes} edges={foodWeb.edges} />;
  };

  return (
    <div className="ecosystem-pokedex">
      <div className="tabs">
        <button 
          className={selectedTab === 'relations' ? 'active' : ''}
          onClick={() => setSelectedTab('relations')}
        >
          生态关系
        </button>
        <button 
          className={selectedTab === 'food-web' ? 'active' : ''}
          onClick={() => setSelectedTab('food-web')}
        >
          食物网
        </button>
      </div>

      <div className="content">
        {selectedTab === 'relations' && renderRelations()}
        {selectedTab === 'food-web' && renderFoodWeb()}
      </div>
    </div>
  );
}
```

### 6. 生态平衡定时任务

```javascript
// backend/jobs/ecosystemBalanceJob.js
const cron = require('node-cron');
const logger = require('../shared/logger');
const EcosystemEngine = require('../shared/ecosystem/EcosystemEngine');

class EcosystemBalanceJob {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.engine = new EcosystemEngine({ db, redis, logger });
  }

  start() {
    // 每小时检查一次所有区域的生态平衡
    cron.schedule('0 * * * *', async () => {
      await this.runBalanceCheck();
    });

    // 每天凌晨 3 点进行生态恢复
    cron.schedule('0 3 * * *', async () => {
      await this.runEcologicalRecovery();
    });
  }

  async runBalanceCheck() {
    logger.info('Starting ecosystem balance check');

    const regions = await this.db.query(`
      SELECT DISTINCT region_id FROM region_ecosystem_status
    `);

    for (const region of regions.rows) {
      await this.engine.checkEcosystemBalance(region.region_id);
    }

    logger.info('Ecosystem balance check completed', { 
      regionsChecked: regions.rows.length 
    });
  }

  async runEcologicalRecovery() {
    logger.info('Starting ecological recovery');

    // 种群数量过低的精灵逐渐恢复
    await this.db.query(`
      UPDATE region_ecosystem_status
      SET population_score = LEAST(50, population_score + 1),
          balance_factor = 1.0,
          updated_at = CURRENT_TIMESTAMP
      WHERE population_score < 30
    `);

    // 种群数量过高的精灵逐渐降低
    await this.db.query(`
      UPDATE region_ecosystem_status
      SET population_score = GREATEST(50, population_score - 0.5),
          updated_at = CURRENT_TIMESTAMP
      WHERE population_score > 70
    `);

    logger.info('Ecological recovery completed');
  }
}

module.exports = EcosystemBalanceJob;
```

## 验收标准

- [ ] 数据库表结构正确创建，索引完整
- [ ] 至少定义 100 组精灵生态关系（覆盖主要精灵种类）
- [ ] 捕捉精灵时正确计算生态加成并影响出现率
- [ ] 放生精灵能正确恢复区域生态平衡
- [ ] 生态图鉴正确显示食物网可视化
- [ ] 生态失衡事件正确触发和记录
- [ ] 定时任务正确运行生态恢复逻辑
- [ ] 前端组件 UI/UX 符合设计规范
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 文档更新完整

## 影响范围

### 新增文件
- `backend/shared/ecosystem/EcosystemEngine.js`
- `backend/shared/ecosystem/EcosystemCalculator.js`
- `backend/jobs/ecosystemBalanceJob.js`
- `frontend/game-client/src/components/EcosystemPokedex.jsx`
- `frontend/game-client/src/components/FoodWebVisualization.jsx`
- `database/migrations/20260630_create_ecosystem_tables.sql`
- `database/seeds/20260630_seed_ecosystem_relations.sql`

### 修改文件
- `backend/services/location/src/routes/spawn.js` - 集成生态加成
- `backend/services/catch/src/routes/catch.js` - 记录捕捉影响
- `backend/services/pokemon/src/routes/index.js` - 挂载生态图鉴路由
- `frontend/game-client/src/pages/PokemonDetail.jsx` - 添加生态标签页
- `gateway/src/config/routes.js` - 添加生态相关路由

## 参考

- Pokemon 游戏生态设定资料
- 生态学基础理论 - 食物网与营养级
- D3.js 力导向图文档
- [相关需求：REQ-00331 精灵生态链系统]

---

*此需求为 mineGo 游戏增加生态学维度的策略深度，让玩家在捕捉精灵时需要考虑生态平衡，提升游戏的沉浸感和真实感。*
