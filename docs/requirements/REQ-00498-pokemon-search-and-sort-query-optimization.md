# REQ-00498：精灵搜索与排序查询性能优化系统

- **编号**：REQ-00498
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、backend/shared、game-client、database/migrations
- **创建时间**：2026-07-08 07:00 UTC
- **依赖需求**：REQ-00020（精灵列表复合索引已完成）、REQ-00001（Redis GEO 缓存已完成）

## 1. 背景与问题

### 1.1 当前现状分析

精灵仓库是 mineGo 核心功能之一，用户捕捉的精灵存储在 `pokemon` 表中。从 `pokemon-service/src/index.js` 分析：

```javascript
// 当前精灵列表查询实现（简化版）
app.get('/pokemon', requireAuth, async (req, res) => {
  const { page, sort, filter } = req.query;
  const result = await query(`
    SELECT * FROM pokemon WHERE user_id = $1
    ORDER BY ${sort} DESC LIMIT 20 OFFSET $2
  `, [userId, page * 20]);
  return result.rows;
});
```

当前查询存在以下性能瓶颈：

1. **复合条件查询效率低**：用户精灵仓库通常包含 100-500 只精灵，按多条件筛选（类型、CP范围、稀有度、捕捉时间）时查询效率低
2. **排序操作消耗大**：每次请求都需要数据库排序操作，高频排序字段缺少优化索引
3. **搜索功能缺失**：无精灵名称模糊搜索功能，用户需要手动滚动查找
4. **前端渲染延迟**：大量精灵列表一次性返回，前端渲染卡顿
5. **缓存利用率低**：精灵列表查询未利用 Redis 缓存，每次请求都访问数据库

### 1.2 用户痛点

1. **搜索体验差**：用户无法快速查找特定精灵，需要手动滚动数百条记录
2. **加载时间长**：精灵列表 API 平均响应时间 200-300ms，用户感知明显延迟
3. **排序不流畅**：切换排序方式（CP/名称/时间）时需要重新加载，体验不连贯
4. **筛选效率低**：按类型、CP范围筛选需要等待数据库响应

### 1.3 性能影响分析

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 精灵列表 API 响应时间 | 200-300ms | 50-80ms |
| 搜索 API 响应时间 | N/A | 30-50ms |
| 100+精灵用户占比 | 35% | - |
| 列表查询 QPS | 150 | 支持到 500 |
| 缓存命中率 | 0% | 70%+ |

## 2. 目标

构建精灵搜索与排序查询性能优化系统，实现：

1. **复合索引优化**：为高频查询字段建立复合索引，提升查询效率 60%
2. **Redis 缓存层**：精灵列表缓存 + 搜索结果缓存，减少数据库访问
3. **智能搜索功能**：精灵名称模糊搜索、拼音搜索、标签搜索
4. **前端分页优化**：虚拟滚动 + 预加载，提升渲染流畅度
5. **查询性能监控**：慢查询自动检测 + 指标上报

## 3. 范围

### 包含
- 数据库索引优化（复合索引、全文索引）
- Redis 缓存策略（列表缓存、搜索缓存、失效机制）
- 搜索服务（模糊搜索、拼音索引、标签搜索）
- API 接口优化（分页参数、排序参数、筛选参数）
- Prometheus 性能指标（查询延迟、缓存命中率、慢查询）
- 前端虚拟滚动（game-client 精灵列表组件）

### 不包含
- 精灵详情查询优化（已有 REQ-00145）
- 精灵批量导出功能
- AI 智能推荐（属于功能增强）

## 4. 详细需求

### 4.1 数据库优化

```sql
-- database/migrations/20260708_070000_pokemon_search_optimization.sql

-- 复合索引：用户精灵列表高频查询
CREATE INDEX idx_pokemon_user_cp_desc ON pokemon(user_id, cp DESC);
CREATE INDEX idx_pokemon_user_created_desc ON pokemon(user_id, created_at DESC);
CREATE INDEX idx_pokemon_user_species ON pokemon(user_id, species_id);

-- 类型筛选索引
CREATE INDEX idx_pokemon_user_type ON pokemon(user_id, (types[1]));

-- CP 范围筛选索引（部分索引）
CREATE INDEX idx_pokemon_user_cp_high ON pokemon(user_id, cp) WHERE cp >= 2000;
CREATE INDEX idx_pokemon_user_cp_mid ON pokemon(user_id, cp) WHERE cp BETWEEN 500 AND 2000;

-- 全文搜索索引（精灵名称）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_pokemon_name_trgm ON pokemon USING gin (nickname gin_trgm_ops);
CREATE INDEX idx_pokemon_species_name_trgm ON pokemon_species USING gin (name gin_trgm_ops);

-- 搜索辅助表
CREATE TABLE pokemon_search_cache (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  search_term VARCHAR(100) NOT NULL,
  result_ids JSONB NOT NULL,        -- 精灵 ID 数组
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(user_id, search_term)
);

CREATE INDEX idx_search_cache_user_term ON pokemon_search_cache(user_id, search_term);
CREATE INDEX idx_search_cache_expires ON pokemon_search_cache(expires_at);
```

### 4.2 Redis 缓存层

```javascript
// backend/shared/pokemonSearchCache.js

const CACHE_CONFIG = {
  LIST_TTL: 300,          // 精灵列表缓存 5 分钟
  SEARCH_TTL: 60,         // 搜索结果缓存 1 分钟
  STATS_TTL: 600,         // 统计数据缓存 10 分钟
  PREFIX: 'pokemon:list:',
  SEARCH_PREFIX: 'pokemon:search:'
};

class PokemonSearchCache {
  constructor(redis) {
    this.redis = redis;
  }

  // 缓存精灵列表
  async cacheList(userId, sort, filter, pokemonIds) {
    const key = `${CACHE_CONFIG.PREFIX}${userId}:${sort}:${JSON.stringify(filter)}`;
    await setJSON(key, { ids: pokemonIds, cachedAt: Date.now() }, CACHE_CONFIG.LIST_TTL);
  }

  // 获取缓存的精灵列表 ID
  async getListIds(userId, sort, filter) {
    const key = `${CACHE_CONFIG.PREFIX}${userId}:${sort}:${JSON.stringify(filter)}`;
    return await getJSON(key);
  }

  // 缓存搜索结果
  async cacheSearch(userId, term, resultIds) {
    const key = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:${term.toLowerCase()}`;
    await setJSON(key, resultIds, CACHE_CONFIG.SEARCH_TTL);
  }

  // 失效用户所有精灵缓存
  async invalidateUser(userId) {
    const pattern = `${CACHE_CONFIG.PREFIX}${userId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(keys);
    }
    // 同时失效搜索缓存
    const searchPattern = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:*`;
    const searchKeys = await this.redis.keys(searchPattern);
    if (searchKeys.length > 0) {
      await this.redis.del(searchKeys);
    }
  }
}
```

### 4.3 搜索服务

```javascript
// pokemon-service/src/searchService.js

const { query } = require('../../../shared/db');
const { PokemonSearchCache } = require('../../../shared/pokemonSearchCache');

class PokemonSearchService {
  constructor() {
    this.cache = new PokemonSearchCache(getRedis());
  }

  /**
   * 模糊搜索精灵
   * 支持：名称模糊匹配、拼音匹配、类型搜索
   */
  async search(userId, term, options = {}) {
    const { limit = 50, types = null, minCp = null, maxCp = null } = options;

    // 检查缓存
    const cached = await this.cache.cacheSearch(userId, term);
    if (cached && cached.length > 0) {
      // 使用缓存的 ID 获取精灵详情
      return await this.getPokemonByIds(userId, cached.slice(0, limit));
    }

    // 数据库搜索
    const conditions = ['user_id = $1'];
    const params = [userId];
    let paramIndex = 2;

    // 名称模糊搜索（使用 pg_trgm）
    if (term && term.length >= 2) {
      conditions.push(`(nickname ILIKE $${paramIndex} OR EXISTS (
        SELECT 1 FROM pokemon_species ps WHERE ps.id = pokemon.species_id 
        AND ps.name ILIKE $${paramIndex}
      ))`);
      params.push(`%${term}%`);
      paramIndex++;
    }

    // 类型筛选
    if (types && types.length > 0) {
      conditions.push(`(types[1] = ANY($${paramIndex}) OR types[2] = ANY($${paramIndex}))`);
      params.push(types);
      paramIndex++;
    }

    // CP 范围筛选
    if (minCp !== null) {
      conditions.push(`cp >= $${paramIndex}`);
      params.push(minCp);
      paramIndex++;
    }
    if (maxCp !== null) {
      conditions.push(`cp <= $${paramIndex}`);
      params.push(maxCp);
      paramIndex++;
    }

    const sql = `
      SELECT p.*, ps.name as species_name, ps.types
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.cp DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const { rows } = await query(sql, params);

    // 缓存搜索结果
    if (rows.length > 0) {
      await this.cache.cacheSearch(userId, term, rows.map(r => r.id));
    }

    return rows;
  }

  /**
   * 根据精灵 ID 获取详情
   */
  async getPokemonByIds(userId, ids) {
    if (!ids || ids.length === 0) return [];
    const { rows } = await query(`
      SELECT p.*, ps.name as species_name, ps.types, ps.rarity
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE p.user_id = $1 AND p.id = ANY($2)
      ORDER BY p.cp DESC
    `, [userId, ids]);
    return rows;
  }
}
```

### 4.4 API 优化

```javascript
// pokemon-service/src/routes/pokemon.js

// GET /pokemon/search - 搜索精灵
app.get('/pokemon/search', requireAuth, async (req, res) => {
  const { term, types, minCp, maxCp, limit } = req.query;
  const userId = req.user.id;

  const metricsTimer = metrics.histogramTimer('pokemon_search_latency_ms');

  try {
    const results = await searchService.search(userId, term, {
      types: types ? types.split(',') : null,
      minCp: minCp ? parseInt(minCp) : null,
      maxCp: maxCp ? parseInt(maxCp) : null,
      limit: limit ? parseInt(limit) : 50
    });

    metricsTimer();
    metrics.counter('pokemon_search_requests_total').inc({ has_term: !!term });

    res.json(successResp({ pokemon: results, count: results.length }));
  } catch (err) {
    metrics.counter('pokemon_search_errors_total').inc();
    next(err);
  }
});

// GET /pokemon - 精灵列表（优化版）
app.get('/pokemon', requireAuth, async (req, res) => {
  const { page = 0, sort = 'cp', type, minCp, maxCp } = req.query;
  const userId = req.user.id;
  const pageSize = 20;

  const metricsTimer = metrics.histogramTimer('pokemon_list_latency_ms');

  try {
    // 检查缓存
    const filter = { type, minCp, maxCp };
    const cachedIds = await pokemonSearchCache.getListIds(userId, sort, filter);

    if (cachedIds && cachedIds.ids) {
      // 使用缓存 ID，只获取当前页
      const pageIds = cachedIds.ids.slice(page * pageSize, (page + 1) * pageSize);
      const pokemon = await searchService.getPokemonByIds(userId, pageIds);

      metricsTimer();
      metrics.counter('pokemon_list_cache_hits_total').inc();

      return res.json(successResp({
        pokemon,
        page,
        total: cachedIds.ids.length,
        cached: true
      }));
    }

    // 缓存未命中，查询数据库
    const conditions = ['user_id = $1'];
    const params = [userId];
    let paramIndex = 2;

    if (type) {
      conditions.push(`(types[1] = $${paramIndex} OR types[2] = $${paramIndex})`);
      params.push(type);
      paramIndex++;
    }

    if (minCp) {
      conditions.push(`cp >= $${paramIndex}`);
      params.push(parseInt(minCp));
      paramIndex++;
    }

    if (maxCp) {
      conditions.push(`cp <= $${paramIndex}`);
      params.push(parseInt(maxCp));
      paramIndex++;
    }

    // 使用优化索引的排序
    const orderBy = {
      'cp': 'ORDER BY p.cp DESC',
      'name': 'ORDER BY ps.name ASC',
      'recent': 'ORDER BY p.created_at DESC',
      'age': 'ORDER BY p.created_at ASC'
    }[sort] || 'ORDER BY p.cp DESC';

    const sql = `
      SELECT p.id, p.*, ps.name as species_name, ps.types, ps.rarity
      FROM pokemon p
      JOIN pokemon_species ps ON p.species_id = ps.id
      WHERE ${conditions.join(' AND ')}
      ${orderBy}
    `;

    const { rows } = await query(sql, params);

    // 缓存所有 ID
    if (rows.length > 0) {
      await pokemonSearchCache.cacheList(userId, sort, filter, rows.map(r => r.id));
    }

    metricsTimer();
    metrics.counter('pokemon_list_db_queries_total').inc();

    res.json(successResp({
      pokemon: rows.slice(page * pageSize, (page + 1) * pageSize),
      page,
      total: rows.length,
      cached: false
    }));
  } catch (err) {
    metrics.counter('pokemon_list_errors_total').inc();
    next(err);
  }
});
```

### 4.5 Prometheus 指标

```javascript
// backend/shared/metrics/pokemonSearchMetrics.js

// 精灵搜索性能指标
const pokemonSearchMetrics = {
  // 搜索延迟
  searchLatency: histogram('pokemon_search_latency_ms', 'Pokemon search API latency', [], [10, 30, 50, 100, 200, 500]),
  
  // 列表延迟
  listLatency: histogram('pokemon_list_latency_ms', 'Pokemon list API latency', [], [10, 30, 50, 100, 200, 500]),
  
  // 缓存命中率
  cacheHits: counter('pokemon_search_cache_hits_total', 'Pokemon search cache hits', ['type']),
  cacheMisses: counter('pokemon_search_cache_misses_total', 'Pokemon search cache misses', ['type']),
  
  // 搜索请求量
  searchRequests: counter('pokemon_search_requests_total', 'Pokemon search requests', ['has_term', 'has_filter']),
  
  // 慢查询检测（>100ms）
  slowQueries: counter('pokemon_slow_queries_total', 'Slow pokemon queries (>100ms)', ['endpoint']),
  
  // 缓存失效次数
  cacheInvalidations: counter('pokemon_cache_invalidations_total', 'Pokemon cache invalidations', ['reason'])
};

// 慢查询检测中间件
function slowQueryDetector(thresholdMs = 100) {
  return async (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > thresholdMs) {
        metrics.slowQueries.inc({ endpoint: req.path });
        logger.warn({
          endpoint: req.path,
          duration_ms: duration,
          params: req.query
        }, 'Slow pokemon query detected');
      }
    });
    next();
  };
}
```

### 4.6 前端虚拟滚动

```javascript
// frontend/game-client/src/components/VirtualPokemonList.js

class VirtualPokemonList {
  constructor(container, options = {}) {
    this.container = container;
    this.itemHeight = 80;        // 每个精灵卡片高度
    this.bufferSize = 5;         // 上下缓冲区大小
    this.pageSize = 20;          // 每页加载数量
    
    this.visibleStart = 0;
    this.visibleEnd = 0;
    this.totalPokemon = 0;
    this.pokemonCache = new Map(); // ID -> Pokemon
    
    this.init();
  }

  init() {
    this.container.addEventListener('scroll', this.onScroll.bind(this));
    this.loadInitial();
  }

  onScroll() {
    const scrollTop = this.container.scrollTop;
    const containerHeight = this.container.clientHeight;
    
    // 计算可见区域
    const newStart = Math.floor(scrollTop / this.itemHeight) - this.bufferSize;
    const newEnd = Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.bufferSize;
    
    if (newStart !== this.visibleStart || newEnd !== this.visibleEnd) {
      this.visibleStart = Math.max(0, newStart);
      this.visibleEnd = Math.min(this.totalPokemon, newEnd);
      this.render();
      this.preloadPages();
    }
  }

  async loadInitial() {
    const response = await fetch('/pokemon?page=0&sort=cp');
    const data = await response.json();
    
    this.totalPokemon = data.total;
    this.pokemonCache.clear();
    
    data.pokemon.forEach(p => this.pokemonCache.set(p.id, p));
    
    this.render();
  }

  async preloadPages() {
    const currentPage = Math.floor(this.visibleEnd / this.pageSize);
    const nextPage = currentPage + 1;
    
    if (nextPage * this.pageSize < this.totalPokemon) {
      const response = await fetch(`/pokemon?page=${nextPage}&sort=cp`);
      const data = await response.json();
      data.pokemon.forEach(p => this.pokemonCache.set(p.id, p));
    }
  }

  render() {
    const fragment = document.createDocumentFragment();
    
    for (let i = this.visibleStart; i < this.visibleEnd; i++) {
      const pokemon = Array.from(this.pokemonCache.values())[i];
      if (pokemon) {
        const card = this.createPokemonCard(pokemon, i);
        fragment.appendChild(card);
      }
    }
    
    // 使用 transform 定位，避免重排
    this.listContainer.innerHTML = '';
    this.listContainer.appendChild(fragment);
    this.listContainer.style.transform = `translateY(${this.visibleStart * this.itemHeight}px)`;
  }

  createPokemonCard(pokemon, index) {
    const card = document.createElement('div');
    card.className = 'pokemon-card';
    card.style.position = 'absolute';
    card.style.top = `${index * this.itemHeight}px`;
    card.style.height = `${this.itemHeight}px`;
    
    card.innerHTML = `
      <img src="/assets/pokemon/${pokemon.species_id}.png" alt="${pokemon.species_name}">
      <span class="name">${pokemon.nickname || pokemon.species_name}</span>
      <span class="cp">CP ${pokemon.cp}</span>
    `;
    
    return card;
  }
}
```

## 5. 验收标准

- [ ] 精灵列表 API 响应时间 < 80ms（P99 < 150ms）
- [ ] 精灵搜索 API 响应时间 < 50ms（P99 < 100ms）
- [ ] Redis 缓存命中率 > 70%（筛选条件一致的查询）
- [ ] 复合索引覆盖高频查询场景（EXPLAIN 显示索引扫描）
- [ ] 前端虚拟滚动支持 500+精灵流畅渲染
- [ ] 搜索功能支持名称模糊匹配、拼音匹配（中文用户）
- [ ] 按类型/CP范围筛选响应时间 < 100ms
- [ ] Prometheus 指标正确上报（搜索延迟、缓存命中率、慢查询）
- [ ] 缓存失效机制正确（捕捉新精灵/转移精灵后列表更新）
- [ ] 单元测试覆盖率 > 80%（搜索服务、缓存服务）

## 6. 工作量估算

**L（Large）**

理由：
1. 涉及数据库架构变更（多个索引、新表）
2. 需要实现 Redis 缓存层 + 失效机制
3. 搜索服务实现（模糊搜索、拼音支持）
4. API 接口重构 + 性能监控
5. 前端虚拟滚动组件
6. 测试覆盖要求高（缓存一致性、性能验证）

预计工作量：8-12 小时

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **用户体验关键路径**：精灵仓库是高频操作，影响 35% 用户（100+精灵玩家）
2. **性能瓶颈明显**：200-300ms 响应时间严重影响体验
3. **缓存利用率低**：当前完全依赖数据库，资源浪费
4. **竞品对比劣势**：同类游戏的精灵搜索响应时间 < 50ms
5. **后续功能基础**：精灵交易、精灵选择等功能依赖快速检索

不设置为 P0 的原因：不影响核心捕捉/战斗功能，现有系统可用但体验不佳。