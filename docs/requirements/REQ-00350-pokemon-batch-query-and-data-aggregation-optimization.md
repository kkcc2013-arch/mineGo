# REQ-00350: 精灵详情批量查询与数据聚合优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00350 |
| 标题 | 精灵详情批量查询与数据聚合优化系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gateway、backend/shared、Redis、PostgreSQL |
| 创建时间 | 2026-06-27 06:00 UTC |

## 需求描述

### 背景
当前精灵详情查询（`GET /api/pokemon/:id`）在列表页、战斗页、交换市场等多个场景被频繁调用。当用户查看背包、好友列表、排行榜等页面时，会同时发起大量独立的详情查询请求，导致：

1. **数据库连接压力**：每次独立查询占用一个连接，高并发时连接池耗尽
2. **重复查询开销**：同一精灵数据被多次查询，浪费 I/O 和 CPU 资源
3. **响应延迟累积**：客户端等待多个请求完成，首屏渲染延迟增加
4. **缓存穿透风险**：批量请求中可能包含大量不存在的 ID，绕过缓存直达数据库

### 目标
构建精灵详情批量查询与数据聚合优化系统，实现：

1. **批量查询接口**：支持一次请求获取多个精灵详情，减少网络往返
2. **智能数据聚合**：自动合并来自不同数据表的关联数据（基础属性、技能、装备、状态效果）
3. **缓存预取与预热**：预测用户可能查询的精灵 ID，提前加载到缓存
4. **请求合并中间件**：短时间窗口内的多个独立请求自动合并为批量请求
5. **降级策略**：部分数据不可用时返回部分结果，而非完全失败

## 技术方案

### 1. 批量查询 API 接口

**新增端点**：`POST /api/pokemon/batch/details`

```javascript
// backend/services/pokemon-service/src/routes/batch.js

const express = require('express');
const router = express.Router();
const { PokemonBatchService } = require('../services/PokemonBatchService');
const { validateBatchRequest } = require('../../../shared/validators/batchValidator');
const { cacheMiddleware } = require('../../../shared/middleware/cacheMiddleware');

/**
 * 批量获取精灵详情
 * @body { ids: string[], include?: string[], options?: { cacheStrategy?: 'bypass'|'prefer'|'only' } }
 * @returns { results: Map<id, PokemonDetail>, errors: Map<id, Error>, metadata: BatchMetadata }
 */
router.post('/details', 
  validateBatchRequest({ maxIds: 100, maxInclude: ['skills', 'equipment', 'effects', 'battle', 'history'] }),
  cacheMiddleware({ keyGenerator: (req) => `batch:${req.body.ids.sort().join(',')}:${req.body.include?.join(',')}` }),
  async (req, res, next) => {
    try {
      const { ids, include = [], options = {} } = req.body;
      
      const batchService = new PokemonBatchService();
      const result = await batchService.getBatchDetails(ids, {
        include,
        userId: req.user?.id,
        cacheStrategy: options.cacheStrategy || 'prefer',
        timeout: 5000 // 5秒超时
      });
      
      res.json({
        success: true,
        data: result.results,
        errors: result.errors,
        metadata: {
          requested: ids.length,
          found: Object.keys(result.results).length,
          failed: Object.keys(result.errors).length,
          cached: result.metadata.cachedCount,
          queryTime: result.metadata.queryTime
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
```

### 2. 智能数据聚合服务

```javascript
// backend/services/pokemon-service/src/services/PokemonBatchService.js

const { db } = require('../../../shared/database/connection');
const { CacheManager } = require('../../../shared/cache/CacheManager');
const { QueryOptimizer } = require('../../../shared/database/QueryOptimizer');
const { logger } = require('../../../shared/logger');

class PokemonBatchService {
  constructor() {
    this.cache = new CacheManager({ prefix: 'pokemon:batch:' });
    this.queryOptimizer = new QueryOptimizer();
    this.maxBatchSize = 100;
    this.maxConcurrentQueries = 5;
  }

  /**
   * 批量获取精灵详情
   * @param {string[]} ids - 精灵 ID 数组
   * @param {Object} options - 查询选项
   * @returns {Promise<{ results: Object, errors: Object, metadata: Object }>}
   */
  async getBatchDetails(ids, options = {}) {
    const { include = [], userId, cacheStrategy = 'prefer', timeout = 5000 } = options;
    const startTime = Date.now();
    
    // 去重和验证
    const uniqueIds = [...new Set(ids)].slice(0, this.maxBatchSize);
    
    // 分组：从缓存获取 vs 从数据库获取
    let cachedResults = {};
    let idsToFetch = uniqueIds;
    
    if (cacheStrategy !== 'bypass') {
      const cacheResult = await this._getFromCache(uniqueIds, include);
      cachedResults = cacheResult.results;
      idsToFetch = cacheResult.missIds;
    }
    
    // 数据库批量查询
    let dbResults = {};
    let errors = {};
    
    if (idsToFetch.length > 0) {
      try {
        const dbResult = await this._batchQueryFromDatabase(idsToFetch, include, { timeout });
        dbResults = dbResult.results;
        errors = dbResult.errors;
        
        // 写入缓存
        if (cacheStrategy !== 'only' && Object.keys(dbResults).length > 0) {
          await this._setToCache(dbResults, include);
        }
      } catch (error) {
        logger.error('Batch query failed', { ids: idsToFetch, error: error.message });
        // 部分降级：尝试单独查询
        const fallbackResult = await this._fallbackIndividualQueries(idsToFetch, include);
        dbResults = fallbackResult.results;
        errors = fallbackResult.errors;
      }
    }
    
    // 合并结果
    const results = { ...cachedResults, ...dbResults };
    
    return {
      results,
      errors,
      metadata: {
        cachedCount: Object.keys(cachedResults).length,
        dbCount: Object.keys(dbResults).length,
        queryTime: Date.now() - startTime
      }
    };
  }

  /**
   * 从缓存批量获取
   */
  async _getFromCache(ids, include) {
    const results = {};
    const missIds = [];
    
    const cacheKeys = ids.map(id => this._generateCacheKey(id, include));
    const cachedData = await this.cache.mget(cacheKeys);
    
    ids.forEach((id, index) => {
      const data = cachedData[index];
      if (data && data !== null) {
        results[id] = data;
      } else {
        missIds.push(id);
      }
    });
    
    return { results, missIds };
  }

  /**
   * 批量数据库查询（使用 CTE 优化）
   */
  async _batchQueryFromDatabase(ids, include, options = {}) {
    const { timeout = 5000 } = options;
    const results = {};
    const errors = {};
    
    // 使用 CTE（Common Table Expression）批量查询
    const client = await db.connect();
    
    try {
      await client.query('SET statement_timeout = $1', [timeout]);
      
      // 主查询：精灵基础信息
      const baseQuery = `
        WITH target_pokemon AS (
          SELECT unnest($1::uuid[]) AS id
        )
        SELECT 
          p.id, p.species_id, p.nickname, p.level, p.experience,
          p.current_hp, p.max_hp, p.attack, p.defense, p.special_attack,
          p.special_defense, p.speed, p.nature, p.ability_id,
          p.owner_id, p.created_at, p.updated_at,
          ps.name AS species_name, ps.type_primary, ps.type_secondary
        FROM target_pokemon tp
        LEFT JOIN pokemon p ON p.id = tp.id
        LEFT JOIN pokemon_species ps ON ps.id = p.species_id
      `;
      
      const baseResult = await client.query(baseQuery, [ids]);
      
      baseResult.rows.forEach(row => {
        if (row.id) {
          results[row.id] = {
            id: row.id,
            species: {
              id: row.species_id,
              name: row.species_name,
              types: [row.type_primary, row.type_secondary].filter(Boolean)
            },
            nickname: row.nickname,
            level: row.level,
            experience: row.experience,
            stats: {
              hp: { current: row.current_hp, max: row.max_hp },
              attack: row.attack,
              defense: row.defense,
              specialAttack: row.special_attack,
              specialDefense: row.special_defense,
              speed: row.speed
            },
            nature: row.nature,
            abilityId: row.ability_id,
            ownerId: row.owner_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          };
        }
      });
      
      // 批量加载关联数据
      if (include.length > 0 && Object.keys(results).length > 0) {
        await this._loadRelatedData(client, results, include);
      }
      
      // 记录未找到的 ID
      ids.forEach(id => {
        if (!results[id] && !errors[id]) {
          errors[id] = { code: 'NOT_FOUND', message: `Pokemon ${id} not found` };
        }
      });
      
    } finally {
      client.release();
    }
    
    return { results, errors };
  }

  /**
   * 批量加载关联数据
   */
  async _loadRelatedData(client, results, include) {
    const ids = Object.keys(results);
    
    // 并行加载所有关联数据
    const loadPromises = [];
    
    if (include.includes('skills')) {
      loadPromises.push(this._loadSkills(client, ids, results));
    }
    
    if (include.includes('equipment')) {
      loadPromises.push(this._loadEquipment(client, ids, results));
    }
    
    if (include.includes('effects')) {
      loadPromises.push(this._loadStatusEffects(client, ids, results));
    }
    
    if (include.includes('battle')) {
      loadPromises.push(this._loadBattleStats(client, ids, results));
    }
    
    if (include.includes('history')) {
      loadPromises.push(this._loadHistory(client, ids, results));
    }
    
    await Promise.allSettled(loadPromises);
  }

  /**
   * 批量加载技能
   */
  async _loadSkills(client, ids, results) {
    const query = `
      SELECT ps.pokemon_id, s.id, s.name, s.type, s.category, 
             s.power, s.accuracy, s.pp, s.description
      FROM pokemon_skills ps
      JOIN skills s ON s.id = ps.skill_id
      WHERE ps.pokemon_id = ANY($1)
    `;
    
    const skillResult = await client.query(query, [ids]);
    
    skillResult.rows.forEach(row => {
      if (results[row.pokemon_id]) {
        if (!results[row.pokemon_id].skills) {
          results[row.pokemon_id].skills = [];
        }
        results[row.pokemon_id].skills.push({
          id: row.id,
          name: row.name,
          type: row.type,
          category: row.category,
          power: row.power,
          accuracy: row.accuracy,
          pp: row.pp,
          description: row.description
        });
      }
    });
  }

  /**
   * 批量加载装备
   */
  async _loadEquipment(client, ids, results) {
    const query = `
      SELECT pe.pokemon_id, e.id, e.name, e.slot, e.rarity,
             e.stats_bonus, e.enhancement_level
      FROM pokemon_equipment pe
      JOIN equipment e ON e.id = pe.equipment_id
      WHERE pe.pokemon_id = ANY($1)
    `;
    
    const equipResult = await client.query(query, [ids]);
    
    equipResult.rows.forEach(row => {
      if (results[row.pokemon_id]) {
        if (!results[row.pokemon_id].equipment) {
          results[row.pokemon_id].equipment = [];
        }
        results[row.pokemon_id].equipment.push({
          id: row.id,
          name: row.name,
          slot: row.slot,
          rarity: row.rarity,
          statsBonus: row.stats_bonus,
          enhancementLevel: row.enhancement_level
        });
      }
    });
  }

  /**
   * 批量加载状态效果
   */
  async _loadStatusEffects(client, ids, results) {
    const query = `
      SELECT se.pokemon_id, se.effect_id, se.name, se.effect_type,
             se.remaining_turns, se.strength
      FROM pokemon_status_effects se
      WHERE se.pokemon_id = ANY($1) AND se.expires_at > NOW()
    `;
    
    const effectsResult = await client.query(query, [ids]);
    
    effectsResult.rows.forEach(row => {
      if (results[row.pokemon_id]) {
        if (!results[row.pokemon_id].statusEffects) {
          results[row.pokemon_id].statusEffects = [];
        }
        results[row.pokemon_id].statusEffects.push({
          id: row.effect_id,
          name: row.name,
          type: row.effect_type,
          remainingTurns: row.remaining_turns,
          strength: row.strength
        });
      }
    });
  }

  /**
   * 批量加载战斗统计
   */
  async _loadBattleStats(client, ids, results) {
    const query = `
      SELECT pokemon_id, 
             COUNT(*) FILTER (WHERE result = 'win') AS wins,
             COUNT(*) FILTER (WHERE result = 'lose') AS losses,
             AVG(duration_seconds) AS avg_battle_duration
      FROM battle_participants
      WHERE pokemon_id = ANY($1)
      GROUP BY pokemon_id
    `;
    
    const statsResult = await client.query(query, [ids]);
    
    statsResult.rows.forEach(row => {
      if (results[row.pokemon_id]) {
        results[row.pokemon_id].battleStats = {
          wins: parseInt(row.wins) || 0,
          losses: parseInt(row.losses) || 0,
          avgDuration: parseFloat(row.avg_battle_duration) || 0
        };
      }
    });
  }

  /**
   * 批量加载历史记录（最近 10 条）
   */
  async _loadHistory(client, ids, results) {
    const query = `
      SELECT ph.pokemon_id, ph.event_type, ph.event_data, ph.created_at
      FROM pokemon_history ph
      WHERE ph.pokemon_id = ANY($1)
      ORDER BY ph.created_at DESC
      LIMIT 10
    `;
    
    const historyResult = await client.query(query, [ids]);
    
    historyResult.rows.forEach(row => {
      if (results[row.pokemon_id]) {
        if (!results[row.pokemon_id].recentHistory) {
          results[row.pokemon_id].recentHistory = [];
        }
        results[row.pokemon_id].recentHistory.push({
          type: row.event_type,
          data: row.event_data,
          timestamp: row.created_at
        });
      }
    });
  }

  /**
   * 回退：单独查询
   */
  async _fallbackIndividualQueries(ids, include) {
    const results = {};
    const errors = {};
    
    await Promise.allSettled(
      ids.map(async id => {
        try {
          const pokemon = await db('pokemon')
            .where({ id })
            .first();
          
          if (pokemon) {
            results[id] = pokemon;
          } else {
            errors[id] = { code: 'NOT_FOUND', message: `Pokemon ${id} not found` };
          }
        } catch (error) {
          errors[id] = { code: 'QUERY_ERROR', message: error.message };
        }
      })
    );
    
    return { results, errors };
  }

  /**
   * 生成缓存键
   */
  _generateCacheKey(id, include) {
    const includeKey = include.sort().join(',');
    return `detail:${id}:${includeKey}`;
  }

  /**
   * 写入缓存
   */
  async _setToCache(results, include) {
    const ttl = 300; // 5分钟
    const promises = Object.entries(results).map(([id, data]) => {
      const key = this._generateCacheKey(id, include);
      return this.cache.set(key, data, ttl);
    });
    
    await Promise.allSettled(promises);
  }
}

module.exports = { PokemonBatchService };
```

### 3. 请求合并中间件

```javascript
// backend/shared/middleware/batchRequestMerger.js

const { logger } = require('../logger');

/**
 * 请求合并中间件
 * 将短时间窗口内的多个独立请求合并为批量请求
 */
class BatchRequestMerger {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 50; // 50ms 合并窗口
    this.maxBatchSize = options.maxBatchSize || 50;
    this.batches = new Map(); // userId -> { timer, requests: [] }
    this.batchEndpoint = options.batchEndpoint || '/api/pokemon/batch/details';
  }

  /**
   * Express 中间件
   */
  middleware() {
    return (req, res, next) => {
      // 仅处理单个详情查询请求
      if (!this._shouldMerge(req)) {
        return next();
      }
      
      const userId = req.user?.id || 'anonymous';
      const pokemonId = req.params.id || req.query.id;
      
      if (!pokemonId) {
        return next();
      }
      
      // 获取或创建批次
      let batch = this.batches.get(userId);
      
      if (!batch) {
        batch = { timer: null, requests: [], resolvers: [] };
        this.batches.set(userId, batch);
      }
      
      // 添加到批次
      return new Promise((resolve, reject) => {
        batch.requests.push(pokemonId);
        batch.resolvers.push({ resolve, reject, req, res });
        
        // 达到最大批次大小，立即执行
        if (batch.requests.length >= this.maxBatchSize) {
          this._executeBatch(userId);
          return;
        }
        
        // 设置定时器
        if (!batch.timer) {
          batch.timer = setTimeout(() => {
            this._executeBatch(userId);
          }, this.windowMs);
        }
      });
    };
  }

  /**
   * 判断是否应该合并请求
   */
  _shouldMerge(req) {
    return (
      req.method === 'GET' &&
      req.path.match(/\/api\/pokemon\/[a-f0-9-]+$/) &&
      req.query.merge !== 'false'
    );
  }

  /**
   * 执行批量请求
   */
  async _executeBatch(userId) {
    const batch = this.batches.get(userId);
    if (!batch) return;
    
    // 清理
    this.batches.delete(userId);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    
    const { requests, resolvers } = batch;
    
    try {
      // 去重
      const uniqueIds = [...new Set(requests)];
      
      logger.info('Executing batch request', { userId, count: uniqueIds.length });
      
      // 调用批量 API
      const batchResponse = await fetch(this.batchEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: uniqueIds })
      });
      
      const batchData = await batchResponse.json();
      
      // 分发结果给各请求
      resolvers.forEach(({ resolve, req, res }, index) => {
        const pokemonId = requests[index];
        const pokemonData = batchData.data?.[pokemonId];
        const error = batchData.errors?.[pokemonId];
        
        if (pokemonData) {
          res.json({ success: true, data: pokemonData });
          resolve();
        } else if (error) {
          res.status(404).json({ success: false, error });
          resolve();
        } else {
          res.status(500).json({ success: false, error: 'Unknown error' });
          resolve();
        }
      });
      
    } catch (error) {
      logger.error('Batch execution failed', { userId, error: error.message });
      
      // 所有请求降级处理
      resolvers.forEach(({ resolve, res }) => {
        res.status(500).json({ success: false, error: 'Batch request failed' });
        resolve();
      });
    }
  }
}

/**
 * 创建中间件实例
 */
function createBatchMergerMiddleware(options = {}) {
  const merger = new BatchRequestMerger(options);
  return merger.middleware();
}

module.exports = { BatchRequestMerger, createBatchMergerMiddleware };
```

### 4. 智能预取与预热

```javascript
// backend/shared/cache/PokemonPrefetcher.js

const { logger } = require('../logger');
const { CacheManager } = require('./CacheManager');

/**
 * 精灵数据智能预取器
 * 基于用户行为预测可能查询的精灵，提前加载到缓存
 */
class PokemonPrefetcher {
  constructor(options = {}) {
    this.cache = new CacheManager({ prefix: 'pokemon:prefetch:' });
    this.prefetchThreshold = options.prefetchThreshold || 0.7; // 70% 概率阈值
    this.maxPrefetchCount = options.maxPrefetchCount || 20;
    this.userPatterns = new Map(); // userId -> { patterns: [], lastUpdate }
  }

  /**
   * 记录用户查询模式
   */
  recordQueryPattern(userId, pokemonIds, context = {}) {
    if (!this.userPatterns.has(userId)) {
      this.userPatterns.set(userId, { patterns: [], lastUpdate: Date.now() });
    }
    
    const userPattern = this.userPatterns.get(userId);
    
    // 添加查询模式
    userPattern.patterns.push({
      ids: pokemonIds,
      context: context.page || context.action,
      timestamp: Date.now()
    });
    
    // 保留最近 100 条模式
    if (userPattern.patterns.length > 100) {
      userPattern.patterns = userPattern.patterns.slice(-100);
    }
    
    userPattern.lastUpdate = Date.now();
    
    // 触发预取
    this._maybePrefetch(userId, pokemonIds, context);
  }

  /**
   * 条件性预取
   */
  async _maybePrefetch(userId, currentIds, context) {
    const predictedIds = this._predictNextQueries(userId, currentIds, context);
    
    if (predictedIds.length === 0) return;
    
    // 检查缓存中是否已存在
    const cachedIds = await this._checkCached(predictedIds);
    const toPrefetch = predictedIds.filter(id => !cachedIds.includes(id));
    
    if (toPrefetch.length === 0) return;
    
    logger.info('Prefetching pokemon data', { userId, count: toPrefetch.length });
    
    // 异步预取
    this._prefetchInBackground(toPrefetch);
  }

  /**
   * 预测下一批可能查询的精灵
   */
  _predictNextQueries(userId, currentIds, context) {
    const userPattern = this.userPatterns.get(userId);
    if (!userPattern) return [];
    
    const predictions = new Map(); // id -> score
    
    // 分析历史模式
    userPattern.patterns.forEach((pattern, index) => {
      const recency = 1 - (Date.now() - pattern.timestamp) / (24 * 60 * 60 * 1000); // 时间衰减
      const weight = recency * (index + 1) / userPattern.patterns.length;
      
      // 相同上下文的模式权重更高
      const contextMatch = pattern.context === context.page ? 1.5 : 1;
      
      pattern.ids.forEach(id => {
        if (!currentIds.includes(id)) {
          const currentScore = predictions.get(id) || 0;
          predictions.set(id, currentScore + weight * contextMatch);
        }
      });
    });
    
    // 排序并返回高分预测
    return Array.from(predictions.entries())
      .filter(([_, score]) => score >= this.prefetchThreshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxPrefetchCount)
      .map(([id]) => id);
  }

  /**
   * 检查缓存中已存在的数据
   */
  async _checkCached(ids) {
    const cached = [];
    
    await Promise.all(
      ids.map(async id => {
        const exists = await this.cache.exists(`detail:${id}:base`);
        if (exists) cached.push(id);
      })
    );
    
    return cached;
  }

  /**
   * 后台预取
   */
  async _prefetchInBackground(ids) {
    try {
      // 调用批量查询接口进行预热
      const response = await fetch('/api/pokemon/batch/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          include: ['skills', 'equipment'],
          options: { cacheStrategy: 'prefer' }
        })
      });
      
      logger.info('Prefetch completed', { count: ids.length });
    } catch (error) {
      logger.warn('Prefetch failed', { error: error.message, count: ids.length });
    }
  }
}

module.exports = { PokemonPrefetcher };
```

### 5. 监控与指标

```javascript
// backend/shared/metrics/batchMetrics.js

const { Counter, Histogram, Gauge } = require('prom-client');

const batchQueryCounter = new Counter({
  name: 'pokemon_batch_query_total',
  help: 'Total number of batch queries',
  labelNames: ['cache_strategy', 'result']
});

const batchSizeHistogram = new Histogram({
  name: 'pokemon_batch_size',
  help: 'Distribution of batch sizes',
  buckets: [1, 5, 10, 20, 50, 100]
});

const batchLatencyHistogram = new Histogram({
  name: 'pokemon_batch_query_duration_seconds',
  help: 'Batch query latency distribution',
  labelNames: ['cache_strategy'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

const cacheHitGauge = new Gauge({
  name: 'pokemon_batch_cache_hit_rate',
  help: 'Cache hit rate for batch queries',
  labelNames: ['user_segment']
});

const mergedRequestsCounter = new Counter({
  name: 'pokemon_merged_requests_total',
  help: 'Number of requests merged into batches'
});

module.exports = {
  batchQueryCounter,
  batchSizeHistogram,
  batchLatencyHistogram,
  cacheHitGauge,
  mergedRequestsCounter
};
```

## 验收标准

- [ ] 实现 `POST /api/pokemon/batch/details` 批量查询接口，支持一次请求最多 100 个精灵
- [ ] 实现智能数据聚合，支持 include 参数动态加载技能、装备、状态效果、战斗统计、历史记录
- [ ] 实现请求合并中间件，50ms 窗口内的独立请求自动合并
- [ ] 实现缓存预取与预热机制，预测准确率 ≥ 70%
- [ ] 批量查询性能：100 个精灵详情查询延迟 < 500ms（P95）
- [ ] 缓存命中率：批量查询缓存命中率 ≥ 60%
- [ ] 数据库连接优化：批量查询减少 80% 的独立数据库连接
- [ ] 降级策略：部分数据查询失败不影响整体响应
- [ ] 监控指标：暴露批量查询计数、延迟、缓存命中率等 Prometheus 指标
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试：验证端到端批量查询流程

## 影响范围

### 新增文件
- `backend/services/pokemon-service/src/routes/batch.js` - 批量查询路由
- `backend/services/pokemon-service/src/services/PokemonBatchService.js` - 批量查询服务
- `backend/shared/middleware/batchRequestMerger.js` - 请求合并中间件
- `backend/shared/cache/PokemonPrefetcher.js` - 智能预取器
- `backend/shared/metrics/batchMetrics.js` - 批量查询指标
- `backend/tests/unit/pokemon/PokemonBatchService.test.js` - 单元测试
- `backend/tests/integration/pokemon/batch-query.test.js` - 集成测试

### 修改文件
- `backend/services/pokemon-service/src/index.js` - 注册批量查询路由
- `gateway/src/middleware/index.js` - 添加请求合并中间件
- `backend/shared/validators/batchValidator.js` - 批量请求验证器
- `docs/api-spec/openapi.yaml` - 添加批量查询 API 文档

### 数据库优化
- 为 `pokemon_skills.pokemon_id` 添加索引
- 为 `pokemon_equipment.pokemon_id` 添加索引
- 为 `pokemon_status_effects.pokemon_id` 添加索引
- 为 `pokemon_history.pokemon_id` 添加索引

## 参考

- [PostgreSQL CTE 优化](https://www.postgresql.org/docs/current/queries-with.html)
- [Redis Pipeline 批量操作](https://redis.io/docs/manual/pipelining/)
- [Facebook DataLoader 批量查询模式](https://github.com/graphql/dataloader)
- [Twitter 异步预取策略](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2012/caching-with-twemproxy)
