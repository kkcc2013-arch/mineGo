# REQ-00240: 精灵放生与资源回收系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00240 |
| 标题 | 精灵放生与资源回收系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-16 10:00 |

## 需求描述

精灵放生与资源回收系统允许玩家释放不需要的精灵，并获得相应的资源回报。该系统提供批量放生、资源回收计算、放生确认、资源返还等功能，帮助玩家优化精灵收藏管理。

### 核心功能

1. **单只精灵放生**：玩家可以选择放生单个精灵，获得对应资源
2. **批量放生**：支持批量选择并放生多个精灵，提升操作效率
3. **资源回收计算**：根据精灵稀有度、等级、IV 值等因素计算返还资源
4. **放生确认机制**：高价值精灵放生前需要二次确认
5. **放生历史记录**：记录玩家的放生历史，支持查询和统计
6. **资源类型多样化**：返还资源包括金币、进化石、技能机器碎片等

## 技术方案

### 1. 数据库设计

#### 放生记录表 (pokemon_releases)

```sql
CREATE TABLE pokemon_releases (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_instance_id INTEGER NOT NULL,
    pokemon_species_id INTEGER NOT NULL,
    level INTEGER NOT NULL,
    iv_total INTEGER NOT NULL,
    is_shiny BOOLEAN DEFAULT FALSE,
    rarity VARCHAR(20) NOT NULL,
    resources_returned JSONB NOT NULL,
    released_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    confirmation_token VARCHAR(64),
    
    INDEX idx_user_released_at (user_id, released_at),
    INDEX idx_pokemon_species (pokemon_species_id)
);

CREATE TYPE release_resource_type AS ENUM (
    'gold', 'evolution_stone', 'tm_fragment', 'candy', 
    'stardust', 'rare_candy'
);

CREATE TABLE release_resource_rules (
    id SERIAL PRIMARY KEY,
    rarity VARCHAR(20) NOT NULL,
    level_range VARCHAR(20) NOT NULL, -- '1-10', '11-20', etc.
    iv_range VARCHAR(20) NOT NULL, -- '0-10', '11-20', etc.
    resource_type release_resource_type NOT NULL,
    base_amount DECIMAL(10, 2) NOT NULL,
    multiplier DECIMAL(3, 2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. 资源回收计算服务

```javascript
// backend/shared/ReleaseCalculator.js
class ReleaseCalculator {
  constructor() {
    this.rules = null;
    this.loadRules();
  }

  async loadRules() {
    const result = await db.query('SELECT * FROM release_resource_rules');
    this.rules = result.rows;
  }

  /**
   * 计算单只精灵放生返还资源
   */
  calculateResources(pokemon) {
    const resources = {};
    const rarity = pokemon.rarity;
    const levelRange = this.getLevelRange(pokemon.level);
    const ivRange = this.getIVRange(pokemon.ivTotal);

    // 查找匹配的规则
    const matchingRules = this.rules.filter(rule =>
      rule.rarity === rarity &&
      rule.level_range === levelRange &&
      rule.iv_range === ivRange
    );

    for (const rule of matchingRules) {
      const amount = rule.base_amount * rule.multiplier;
      if (pokemon.isShiny) {
        amount *= 2; // 闪光精灵双倍奖励
      }

      if (resources[rule.resource_type]) {
        resources[rule.resource_type] += amount;
      } else {
        resources[rule.resource_type] = amount;
      }
    }

    return resources;
  }

  /**
   * 批量计算资源
   */
  calculateBatchResources(pokemonList) {
    const totalResources = {};
    const details = [];

    for (const pokemon of pokemonList) {
      const resources = this.calculateResources(pokemon);
      details.push({
        pokemonId: pokemon.id,
        speciesId: pokemon.speciesId,
        resources
      });

      // 累加总资源
      for (const [type, amount] of Object.entries(resources)) {
        if (totalResources[type]) {
          totalResources[type] += amount;
        } else {
          totalResources[type] = amount;
        }
      }
    }

    return { totalResources, details };
  }

  /**
   * 检查是否需要二次确认
   */
  requiresConfirmation(pokemon) {
    // 高 IV 值精灵
    if (pokemon.ivTotal >= 80) return true;
    
    // 稀有精灵
    if (['legendary', 'mythical', 'ultra_beast'].includes(pokemon.rarity)) {
      return true;
    }
    
    // 闪光精灵
    if (pokemon.isShiny) return true;
    
    // 高等级精灵
    if (pokemon.level >= 50) return true;

    return false;
  }

  getLevelRange(level) {
    if (level <= 10) return '1-10';
    if (level <= 20) return '11-20';
    if (level <= 30) return '21-30';
    if (level <= 40) return '31-40';
    return '41-50';
  }

  getIVRange(ivTotal) {
    if (ivTotal <= 20) return '0-20';
    if (ivTotal <= 40) return '21-40';
    if (ivTotal <= 60) return '41-60';
    if (ivTotal <= 80) return '61-80';
    return '81-100';
  }
}

module.exports = new ReleaseCalculator();
```

### 3. 放生服务 API

```javascript
// backend/services/pokemon-service/src/routes/release.js
const express = require('express');
const router = express.Router();
const ReleaseCalculator = require('../../../shared/ReleaseCalculator');
const { authenticate } = require('../../../shared/authMiddleware');
const { sendKafkaEvent } = require('../../../shared/kafkaProducer');

/**
 * 预览放生资源
 * POST /api/pokemon/release/preview
 */
router.post('/preview', authenticate, async (req, res) => {
  try {
    const { pokemonIds } = req.body;
    const userId = req.user.id;

    // 验证所有权
    const pokemon = await db.query(`
      SELECT pi.*, ps.rarity, ps.name, ps.species_id
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = ANY($1) AND pi.owner_id = $2
    `, [pokemonIds, userId]);

    if (pokemon.rows.length !== pokemonIds.length) {
      return res.status(400).json({
        error: 'INVALID_POKEMON',
        message: '部分精灵不存在或不属于该用户'
      });
    }

    // 计算资源
    const result = ReleaseCalculator.calculateBatchResources(pokemon.rows);

    // 检查需要确认的精灵
    const requiresConfirmation = pokemon.rows
      .filter(p => ReleaseCalculator.requiresConfirmation(p))
      .map(p => p.id);

    res.json({
      success: true,
      totalResources: result.totalResources,
      pokemonCount: pokemonIds.length,
      details: result.details,
      requiresConfirmation
    });
  } catch (error) {
    logger.error('放生预览失败', { error: error.message });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 执行放生
 * POST /api/pokemon/release/execute
 */
router.post('/execute', authenticate, async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    const { pokemonIds, confirmationToken } = req.body;
    const userId = req.user.id;

    // 获取精灵信息并锁定
    const pokemon = await client.query(`
      SELECT pi.*, ps.rarity, ps.name
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = ANY($1) AND pi.owner_id = $2
      FOR UPDATE
    `, [pokemonIds, userId]);

    if (pokemon.rows.length !== pokemonIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'INVALID_POKEMON',
        message: '部分精灵不存在或不属于该用户'
      });
    }

    // 检查需要确认的精灵
    const needsConfirm = pokemon.rows.filter(p => 
      ReleaseCalculator.requiresConfirmation(p)
    );

    if (needsConfirm.length > 0 && !confirmationToken) {
      const token = crypto.randomBytes(32).toString('hex');
      
      // 存储确认令牌
      await client.query(`
        INSERT INTO pending_releases (user_id, pokemon_ids, token, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
      `, [userId, JSON.stringify(pokemonIds), token]);

      await client.query('ROLLBACK');
      
      return res.status(403).json({
        error: 'CONFIRMATION_REQUIRED',
        message: '包含高价值精灵，需要二次确认',
        confirmationToken: token,
        pokemonRequiringConfirmation: needsConfirm.map(p => ({
          id: p.id,
          name: p.name,
          rarity: p.rarity,
          ivTotal: p.iv_total,
          isShiny: p.is_shiny
        }))
      });
    }

    // 验证确认令牌
    if (confirmationToken) {
      const pending = await client.query(`
        SELECT * FROM pending_releases
        WHERE user_id = $1 AND token = $2 AND expires_at > NOW()
      `, [userId, confirmationToken]);

      if (pending.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'INVALID_TOKEN',
          message: '确认令牌无效或已过期'
        });
      }
    }

    // 计算资源
    const result = ReleaseCalculator.calculateBatchResources(pokemon.rows);

    // 创建放生记录
    for (const p of pokemon.rows) {
      const resources = ReleaseCalculator.calculateResources(p);
      await client.query(`
        INSERT INTO pokemon_releases 
        (user_id, pokemon_instance_id, pokemon_species_id, level, 
         iv_total, is_shiny, rarity, resources_returned, confirmed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [
        userId, p.id, p.species_id, p.level,
        p.iv_total, p.is_shiny, p.rarity, JSON.stringify(resources)
      ]);
    }

    // 删除精灵
    await client.query(`
      DELETE FROM pokemon_instances
      WHERE id = ANY($1) AND owner_id = $2
    `, [pokemonIds, userId]);

    // 发放资源
    await client.query(`
      UPDATE users SET
        gold = gold + $1,
        stardust = stardust + $2
      WHERE id = $3
    `, [
      result.totalResources.gold || 0,
      result.totalResources.stardust || 0,
      userId
    ]);

    // 发送事件
    await sendKafkaEvent('pokemon.released', {
      userId,
      pokemonCount: pokemonIds.length,
      resources: result.totalResources,
      timestamp: new Date().toISOString()
    });

    await client.query('COMMIT');

    // 清理确认令牌
    if (confirmationToken) {
      await client.query(`
        DELETE FROM pending_releases WHERE token = $1
      `, [confirmationToken]);
    }

    res.json({
      success: true,
      message: '放生成功',
      resources: result.totalResources,
      pokemonCount: pokemonIds.length
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('放生执行失败', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * 查询放生历史
 * GET /api/pokemon/release/history
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const result = await db.query(`
      SELECT pr.*, ps.name as pokemon_name
      FROM pokemon_releases pr
      JOIN pokemon_species ps ON pr.pokemon_species_id = ps.id
      WHERE pr.user_id = $1
      ORDER BY pr.released_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const countResult = await db.query(`
      SELECT COUNT(*) as total FROM pokemon_releases WHERE user_id = $1
    `, [userId]);

    res.json({
      success: true,
      releases: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.rows[0].total
      }
    });
  } catch (error) {
    logger.error('查询放生历史失败', { error: error.message });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 放生统计
 * GET /api/pokemon/release/stats
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_releases,
        COUNT(DISTINCT pokemon_species_id) as unique_species,
        SUM((resources_returned->>'gold')::numeric) as total_gold,
        SUM((resources_returned->>'stardust')::numeric) as total_stardust,
        COUNT(*) FILTER (WHERE is_shiny) as shiny_releases
      FROM pokemon_releases
      WHERE user_id = $1
        AND ($2::timestamp IS NULL OR released_at >= $2)
        AND ($3::timestamp IS NULL OR released_at <= $3)
    `, [userId, startDate || null, endDate || null]);

    res.json({
      success: true,
      stats: stats.rows[0]
    });
  } catch (error) {
    logger.error('查询放生统计失败', { error: error.message });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
```

### 4. 游戏客户端组件

```javascript
// frontend/game-client/src/components/PokemonRelease.js
import React, { useState, useEffect } from 'react';
import { PokemonCard } from './PokemonCard';
import { ResourceDisplay } from './ResourceDisplay';
import { ConfirmationModal } from './ConfirmationModal';

export function PokemonRelease({ onClose }) {
  const [selectedPokemon, setSelectedPokemon] = useState([]);
  const [previewResult, setPreviewResult] = useState(null);
  const [confirmationToken, setConfirmationToken] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [loading, setLoading] = useState(false);

  const handlePreview = async () => {
    if (selectedPokemon.length === 0) return;

    setLoading(true);
    try {
      const response = await fetch('/api/pokemon/release/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pokemonIds: selectedPokemon })
      });

      const data = await response.json();
      setPreviewResult(data);
    } catch (error) {
      console.error('预览失败', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/pokemon/release/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          pokemonIds: selectedPokemon,
          confirmationToken 
        })
      });

      const data = await response.json();

      if (data.error === 'CONFIRMATION_REQUIRED') {
        setConfirmationToken(data.confirmationToken);
        setShowConfirmModal(true);
      } else if (data.success) {
        alert(`放生成功！获得资源：${JSON.stringify(data.resources)}`);
        onClose();
      }
    } catch (error) {
      console.error('放生失败', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pokemon-release-container">
      <h2>精灵放生</h2>
      
      <div className="pokemon-selector">
        {/* 精灵选择界面 */}
        <PokemonSelector 
          selected={selectedPokemon}
          onChange={setSelectedPokemon}
        />
      </div>

      <div className="action-buttons">
        <button 
          onClick={handlePreview}
          disabled={selectedPokemon.length === 0 || loading}
        >
          预览资源
        </button>
        
        {previewResult && (
          <>
            <ResourceDisplay resources={previewResult.totalResources} />
            <button 
              onClick={handleExecute}
              disabled={loading}
              className="danger"
            >
              确认放生 ({selectedPokemon.length} 只)
            </button>
          </>
        )}
      </div>

      {showConfirmModal && (
        <ConfirmationModal
          title="确认放生高价值精灵"
          message="您选择的精灵包含稀有或高 IV 值个体，确认要放生吗？"
          onConfirm={handleExecute}
          onCancel={() => setShowConfirmModal(false)}
        />
      )}
    </div>
  );
}
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js
const promClient = require('prom-client');

const releaseMetrics = {
  totalReleases: new promClient.Counter({
    name: 'pokemon_release_total',
    help: 'Total number of pokemon released',
    labelNames: ['user_tier', 'rarity']
  }),

  resourcesReturned: new promClient.Counter({
    name: 'pokemon_release_resources_returned_total',
    help: 'Total resources returned from releases',
    labelNames: ['resource_type']
  }),

  highValueConfirmations: new promClient.Counter({
    name: 'pokemon_release_high_value_confirmations_total',
    help: 'High value pokemon release confirmations',
    labelNames: ['rarity', 'iv_tier']
  }),

  batchReleaseSize: new promClient.Histogram({
    name: 'pokemon_release_batch_size',
    help: 'Distribution of batch release sizes',
    buckets: [1, 5, 10, 20, 50, 100]
  })
};

module.exports = releaseMetrics;
```

## 验收标准

- [ ] 单只精灵放生功能正常，资源正确返还
- [ ] 批量放生支持选择多个精灵并正确计算资源
- [ ] 资源回收计算符合规则（稀有度、等级、IV、闪光）
- [ ] 高价值精灵放生需要二次确认
- [ ] 确认令牌 5 分钟过期机制正常工作
- [ ] 放生历史记录可查询，分页正常
- [ ] 放生统计数据准确
- [ ] 闪光精灵获得双倍资源
- [ ] 事务完整性保证：精灵删除和资源发放原子性
- [ ] Prometheus 指标正确收集
- [ ] Kafka 事件正确发送
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖主要场景

## 影响范围

### 新增文件
- `backend/services/pokemon-service/src/routes/release.js`
- `backend/shared/ReleaseCalculator.js`
- `frontend/game-client/src/components/PokemonRelease.js`
- `frontend/game-client/src/components/PokemonSelector.js`
- `backend/tests/unit/releaseCalculator.test.js`
- `backend/tests/integration/release.test.js`

### 修改文件
- `database/migrations/xxx_create_release_tables.sql`
- `backend/services/pokemon-service/src/index.js` (路由挂载)
- `backend/shared/metrics.js` (新增指标)

### 数据库变更
- 新增 `pokemon_releases` 表
- 新增 `release_resource_rules` 表
- 新增 `pending_releases` 表
- 新增 `release_resource_type` 枚举类型

## 参考

- [宝可梦放生机制设计参考](https://bulbapedia.bulbagarden.net/wiki/Releasing_Pok%C3%A9mon)
- [游戏资源回收系统最佳实践](https://www.gamasutra.com/blogs/GameDesign/2019/)
- PostgreSQL JSONB 文档: https://www.postgresql.org/docs/current/datatype-json.html
- Kafka 事件设计模式: https://kafka.apache.org/documentation/#design
