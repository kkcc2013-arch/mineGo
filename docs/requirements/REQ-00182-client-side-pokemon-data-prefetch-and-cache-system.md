# REQ-00182: 客户端精灵数据预取与智能缓存系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00182 |
| 标题 | 客户端精灵数据预取与智能缓存系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、pokemon-service、backend/shared |
| 创建时间 | 2026-06-14 04:00 |
| 依赖需求 | REQ-00052 |

## 1. 背景与问题

当前游戏客户端在精灵详情页加载、图鉴浏览、捕捉成功展示等场景下存在明显的数据加载延迟：

1. **重复请求浪费**：每次查看同一精灵详情都需发起完整 API 请求，未利用客户端缓存
2. **冷启动体验差**：玩家首次进入图鉴或精灵列表页，需等待大量串行请求完成
3. **网络抖动影响**：弱网环境下精灵图片、属性数据加载失败率高，影响核心体验
4. **带宽浪费**：高频访问的精灵基础数据（名称、属性、技能）未在客户端持久化

当前 SpawnManager 每 10 秒拉取附近精灵，但精灵的静态数据（图片、属性、技能描述）每次都重新请求，未实现有效的缓存策略。

## 2. 目标

1. **首屏加载提速**：关键精灵数据预取，减少首屏等待时间 50%+
2. **离线可用**：常用精灵数据本地缓存，弱网/断网时可正常浏览图鉴
3. **带宽节省**：减少重复请求，降低 API 压力和流量消耗 40%+
4. **体验优化**：无缝的精灵数据展示，无感知的缓存更新

## 3. 范围

### 包含
- 精灵基础数据缓存系统（名称、属性、技能、进化链）
- 精灵图片资源缓存与渐进式加载
- 智能预取策略（基于玩家位置、历史行为）
- 缓存失效与增量更新机制
- 存储配额管理与清理策略

### 不包含
- 精灵战斗数值计算（属 gym-service）
- 精灵交易数据同步（属 social-service）
- 服务器端缓存（已由 REQ-00039 实现）

## 4. 详细需求

### 4.1 精灵数据缓存层

```javascript
// frontend/game-client/src/cache/PokemonDataCache.js

class PokemonDataCache {
  constructor() {
    this.dbName = 'PokemonDataDB';
    this.dbVersion = 1;
    this.db = null;
    
    // 内存缓存层（热数据）
    this.memoryCache = new Map();
    this.memoryCacheMaxSize = 100;
    
    // 缓存配置
    this.config = {
      staticDataTTL: 7 * 24 * 60 * 60 * 1000,    // 静态数据 7 天
      imageDataTTL: 3 * 24 * 60 * 60 * 1000,      // 图片 3 天
      dynamicDataTTL: 30 * 60 * 1000,             // 动态数据 30 分钟
      maxStorageSize: 100 * 1024 * 1024,          // 100MB 上限
    };
    
    // 统计
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  /**
   * 初始化 IndexedDB
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this._startCleanupTimer();
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 静态数据存储（精灵属性、技能等）
        if (!db.objectStoreNames.contains('staticData')) {
          const staticStore = db.createObjectStore('staticData', { keyPath: 'id' });
          staticStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
          staticStore.createIndex('accessCount', 'accessCount', { unique: false });
        }
        
        // 图片资源存储
        if (!db.objectStoreNames.contains('imageData')) {
          const imageStore = db.createObjectStore('imageData', { keyPath: 'id' });
          imageStore.createIndex('size', 'size', { unique: false });
        }
        
        // 动态数据存储（捕捉计数、最后位置等）
        if (!db.objectStoreNames.contains('dynamicData')) {
          const dynamicStore = db.createObjectStore('dynamicData', { keyPath: 'id' });
          dynamicStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        
        // 元数据存储
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * 获取精灵静态数据
   * @param {number} pokemonId - 精灵 ID
   * @param {object} options - 选项
   */
  async getStaticData(pokemonId, options = {}) {
    // 1. 检查内存缓存
    const memKey = `static_${pokemonId}`;
    if (this.memoryCache.has(memKey)) {
      this.stats.hits++;
      return this.memoryCache.get(memKey);
    }
    
    // 2. 检查 IndexedDB
    const cached = await this._getFromStore('staticData', pokemonId);
    
    if (cached && this._isCacheValid(cached, this.config.staticDataTTL)) {
      // 更新访问统计
      cached.lastAccessed = Date.now();
      cached.accessCount = (cached.accessCount || 0) + 1;
      await this._putToStore('staticData', cached);
      
      // 提升到内存缓存
      this._promoteToMemory(memKey, cached);
      
      this.stats.hits++;
      return cached.data;
    }
    
    // 3. 从服务器获取
    this.stats.misses++;
    
    if (options.skipFetch) return null;
    
    const freshData = await this._fetchFromServer(pokemonId);
    if (freshData) {
      await this.cacheStaticData(pokemonId, freshData);
      return freshData;
    }
    
    return null;
  }

  /**
   * 缓存精灵静态数据
   */
  async cacheStaticData(pokemonId, data) {
    const entry = {
      id: pokemonId,
      data: data,
      cachedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
      version: data.version || 1
    };
    
    await this._putToStore('staticData', entry);
    this._promoteToMemory(`static_${pokemonId}`, data);
  }

  /**
   * 批量预取精灵数据
   * @param {number[]} pokemonIds - 精灵 ID 列表
   * @param {object} options - 预取选项
   */
  async prefetch(pokemonIds, options = {}) {
    const { priority = 'normal', includeImages = true, batchSize = 10 } = options;
    
    // 筛选未缓存的精灵
    const uncached = [];
    for (const id of pokemonIds) {
      const cached = await this._getFromStore('staticData', id);
      if (!cached || !this._isCacheValid(cached, this.config.staticDataTTL)) {
        uncached.push(id);
      }
    }
    
    if (uncached.length === 0) {
      console.log('[PokemonDataCache] All requested data already cached');
      return { fetched: 0, skipped: pokemonIds.length };
    }
    
    // 分批请求
    const results = { fetched: 0, errors: [] };
    
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      
      try {
        const response = await fetch('/api/pokemon/batch-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            pokemonIds: batch,
            includeImages,
            priority
          })
        });
        
        if (!response.ok) {
          results.errors.push({ batch, error: `HTTP ${response.status}` });
          continue;
        }
        
        const data = await response.json();
        
        // 缓存结果
        for (const pokemon of data.pokemon || []) {
          await this.cacheStaticData(pokemon.id, pokemon);
          
          // 缓存图片
          if (includeImages && pokemon.imageUrl) {
            await this._prefetchImage(pokemon.id, pokemon.imageUrl);
          }
          
          results.fetched++;
        }
        
        // 批次间延迟，避免过载
        if (i + batchSize < uncached.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (error) {
        results.errors.push({ batch, error: error.message });
      }
    }
    
    console.log(`[PokemonDataCache] Prefetched ${results.fetched}/${uncached.length} pokemon`);
    return results;
  }

  /**
   * 预取图片资源
   */
  async _prefetchImage(pokemonId, imageUrl) {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      const entry = {
        id: pokemonId,
        blob: blob,
        url: imageUrl,
        size: blob.size,
        cachedAt: Date.now()
      };
      
      await this._putToStore('imageData', entry);
      
      // 创建本地 URL 用于显示
      const localUrl = URL.createObjectURL(blob);
      this._promoteToMemory(`image_${pokemonId}`, localUrl);
      
      return localUrl;
    } catch (error) {
      console.warn(`[PokemonDataCache] Failed to prefetch image for ${pokemonId}:`, error);
      return null;
    }
  }

  /**
   * 获取缓存的图片 URL
   */
  async getImageUrl(pokemonId, fallbackUrl) {
    const memKey = `image_${pokemonId}`;
    
    // 检查内存缓存
    if (this.memoryCache.has(memKey)) {
      return this.memoryCache.get(memKey);
    }
    
    // 检查 IndexedDB
    const cached = await this._getFromStore('imageData', pokemonId);
    
    if (cached && this._isCacheValid(cached, this.config.imageDataTTL)) {
      const localUrl = URL.createObjectURL(cached.blob);
      this._promoteToMemory(memKey, localUrl);
      return localUrl;
    }
    
    // 异步预取（不阻塞返回）
    this._prefetchImage(pokemonId, fallbackUrl).catch(() => {});
    
    return fallbackUrl;
  }

  /**
   * 智能预取建议
   * 基于玩家位置、历史行为预测可能需要的精灵数据
   */
  async predictAndPrefetch(playerLat, playerLng, context = {}) {
    const predictions = [];
    
    // 1. 基于位置的预测：获取附近可能出现的精灵
    if (playerLat && playerLng) {
      const nearby = await this._fetchNearbySpawnPrediction(playerLat, playerLng);
      predictions.push(...nearby);
    }
    
    // 2. 基于历史的预测：玩家最近捕捉的精灵的进化链
    if (context.recentCatches) {
      for (const catch_ of context.recentCatches.slice(0, 5)) {
        const evolution = await this._getEvolutionChain(catch_.pokemonId);
        predictions.push(...evolution);
      }
    }
    
    // 3. 基于时间的预测：当前时段高概率出现的精灵
    const timeBased = this._getTimeBasedPredictions();
    predictions.push(...timeBased);
    
    // 去重并限制数量
    const unique = [...new Set(predictions)].slice(0, 30);
    
    // 低优先级后台预取
    if (unique.length > 0) {
      this.prefetch(unique, { priority: 'low', batchSize: 5 })
        .catch(err => console.warn('[PokemonDataCache] Predictive prefetch failed:', err));
    }
    
    return unique;
  }

  /**
   * 清理过期缓存
   */
  async cleanup() {
    const now = Date.now();
    let evicted = 0;
    
    // 清理过期静态数据
    const staticData = await this._getAllFromStore('staticData');
    for (const entry of staticData) {
      if (!this._isCacheValid(entry, this.config.staticDataTTL)) {
        await this._deleteFromStore('staticData', entry.id);
        evicted++;
      }
    }
    
    // 清理过期图片数据
    const imageData = await this._getAllFromStore('imageData');
    for (const entry of imageData) {
      if (!this._isCacheValid(entry, this.config.imageDataTTL)) {
        await this._deleteFromStore('imageData', entry.id);
        evicted++;
      }
    }
    
    // 存储配额管理
    const totalSize = await this._estimateStorageSize();
    if (totalSize > this.config.maxStorageSize) {
      await this._evictLRU(totalSize - this.config.maxStorageSize);
    }
    
    this.stats.evictions += evicted;
    console.log(`[PokemonDataCache] Cleanup complete: evicted ${evicted} entries`);
    
    return { evicted, totalSize };
  }

  /**
   * LRU 淘汰策略
   */
  async _evictLRU(bytesToFree) {
    const staticData = await this._getAllFromStore('staticData');
    
    // 按访问时间和访问次数排序
    staticData.sort((a, b) => {
      const scoreA = a.accessCount / (Date.now() - a.lastAccessed);
      const scoreB = b.accessCount / (Date.now() - b.lastAccessed);
      return scoreA - scoreB;
    });
    
    let freed = 0;
    for (const entry of staticData) {
      if (freed >= bytesToFree) break;
      
      await this._deleteFromStore('staticData', entry.id);
      this.memoryCache.delete(`static_${entry.id}`);
      freed += this._estimateEntrySize(entry);
      this.stats.evictions++;
    }
    
    console.log(`[PokemonDataCache] LRU eviction freed ${freed} bytes`);
    return freed;
  }

  // === 辅助方法 ===

  _getFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _putToStore(storeName, data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _deleteFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  _getAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  _isCacheValid(entry, ttl) {
    return entry && (Date.now() - entry.cachedAt) < ttl;
  }

  _promoteToMemory(key, value) {
    if (this.memoryCache.size >= this.memoryCacheMaxSize) {
      // 删除最旧的条目
      const oldest = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldest);
    }
    this.memoryCache.set(key, value);
  }

  _estimateEntrySize(entry) {
    return JSON.stringify(entry.data || {}).length * 2;
  }

  async _estimateStorageSize() {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return estimate.usage || 0;
    }
    return 0;
  }

  async _fetchFromServer(pokemonId) {
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/details`);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async _fetchNearbySpawnPrediction(lat, lng) {
    try {
      const response = await fetch(`/api/location/spawn-prediction?lat=${lat}&lng=${lng}`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.pokemonIds || [];
    } catch {
      return [];
    }
  }

  async _getEvolutionChain(pokemonId) {
    const data = await this.getStaticData(pokemonId, { skipFetch: true });
    return data?.evolutionChain || [];
  }

  _getTimeBasedPredictions() {
    const hour = new Date().getHours();
    // 夜间精灵
    if (hour >= 20 || hour < 6) {
      return [94, 95, 198, 200, 215, 228, 355, 358]; // 示例 ID
    }
    // 日间精灵
    return [];
  }

  _startCleanupTimer() {
    // 每小时清理一次
    setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  /**
   * 获取缓存统计
   */
  getStats() {
    return {
      ...this.stats,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
      memoryCacheSize: this.memoryCache.size
    };
  }
}

// 单例导出
export const pokemonDataCache = new PokemonDataCache();
```

### 4.2 服务端批量查询接口

```javascript
// backend/services/pokemon-service/src/routes/batchDetails.js

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { getJSON, setJSON } = require('../../../shared/redis');
const { requireAuth, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('pokemon-batch');

/**
 * POST /pokemon/batch-details
 * 批量获取精灵详情，支持缓存和优先级
 */
router.post('/batch-details', requireAuth, async (req, res, next) => {
  try {
    const { pokemonIds, includeImages = true, priority = 'normal' } = req.body;
    
    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ error: 'pokemonIds 必须是非空数组' });
    }
    
    // 限制批次大小
    const limit = priority === 'high' ? 50 : 20;
    const ids = pokemonIds.slice(0, limit);
    
    // 尝试从 Redis 缓存批量获取
    const cacheKeys = ids.map(id => `pokemon:details:${id}`);
    const cachedResults = await Promise.all(
      cacheKeys.map(key => getJSON(key))
    );
    
    // 筛选未命中的 ID
    const results = [];
    const missIds = [];
    
    ids.forEach((id, index) => {
      if (cachedResults[index]) {
        results.push(cachedResults[index]);
      } else {
        missIds.push(id);
      }
    });
    
    // 查询数据库获取未缓存的精灵
    if (missIds.length > 0) {
      const { rows } = await query(`
        SELECT 
          p.id, p.name_zh, p.name_en, p.name_ja,
          p.type_primary, p.type_secondary,
          p.base_attack, p.base_defense, p.base_stamina,
          p.base_catch_rate, p.base_flee_rate, p.rarity,
          p.evolution_chain_id, p.buddy_distance,
          array_agg(DISTINCT m.move_id) as moves
        FROM pokemon_species p
        LEFT JOIN pokemon_moves m ON m.species_id = p.id
        WHERE p.id = ANY($1)
        GROUP BY p.id
      `, [missIds]);
      
      // 缓存并添加到结果
      for (const row of rows) {
        const data = {
          id: row.id,
          name: { zh: row.name_zh, en: row.name_en, ja: row.name_ja },
          types: [row.type_primary, row.type_secondary].filter(Boolean),
          stats: {
            attack: row.base_attack,
            defense: row.base_defense,
            stamina: row.base_stamina
          },
          catchRate: row.base_catch_rate,
          fleeRate: row.base_flee_rate,
          rarity: row.rarity,
          moves: row.moves || [],
          evolutionChainId: row.evolution_chain_id,
          buddyDistance: row.buddy_distance,
          imageUrl: includeImages ? 
            `https://cdn.minego.app/pokemon/${row.id}.png` : null,
          version: 1
        };
        
        // 异步缓存
        setJSON(`pokemon:details:${row.id}`, data, 3600).catch(() => {});
        
        results.push(data);
      }
    }
    
    logger.info({ 
      total: ids.length, 
      cached: ids.length - missIds.length,
      fetched: missIds.length 
    }, 'Batch details served');
    
    successResp(res, { 
      pokemon: results,
      requested: ids.length,
      returned: results.length 
    });
    
  } catch (error) {
    logger.error({ error }, 'Batch details failed');
    next(error);
  }
});

module.exports = router;
```

### 4.3 与 SpawnManager 集成

```javascript
// 修改 SpawnManager，集成预取逻辑

import { pokemonDataCache } from '../cache/PokemonDataCache.js';

class SpawnManager {
  // ... 现有代码 ...
  
  /**
   * 更新精灵标记，同时预取详情数据
   */
  async updateSpawnMarkers(spawns) {
    // 提取精灵 ID 用于预取
    const pokemonIds = spawns.map(s => s.pokemonId).filter(Boolean);
    
    // 后台预取精灵详情（不阻塞 UI）
    if (pokemonIds.length > 0) {
      pokemonDataCache.prefetch(pokemonIds, { 
        priority: 'low', 
        batchSize: 5 
      }).catch(err => {
        console.warn('[SpawnManager] Prefetch failed:', err);
      });
    }
    
    // 现有逻辑：更新标记
    for (const [id, marker] of this.spawnMarkers) {
      if (!spawns.find(s => s.id === id)) {
        marker.remove();
        this.spawnMarkers.delete(id);
        this.activeSpawns.delete(id);
      }
    }
    
    for (const spawn of spawns) {
      if (!this.spawnMarkers.has(spawn.id)) {
        await this.createSpawnMarker(spawn);
      }
    }
  }
  
  /**
   * 创建精灵标记，使用缓存的图片
   */
  async createSpawnMarker(spawn) {
    // 使用缓存的图片 URL
    const fallbackUrl = `${this.options.iconBaseUrl}/${spawn.pokemonId}.png`;
    const imageUrl = await pokemonDataCache.getImageUrl(spawn.pokemonId, fallbackUrl);
    
    // 创建标记...
  }
}
```

## 5. 验收标准

- [ ] 客户端 IndexedDB 存储结构正确创建，包含 staticData/imageData/dynamicData 三张表
- [ ] 首次访问精灵详情页时缓存未命中，数据从服务器获取并缓存
- [ ] 再次访问同一精灵详情页时缓存命中，无需网络请求，加载时间 < 100ms
- [ ] 批量预取接口 `/api/pokemon/batch-details` 正常工作，单次最多返回 50 个精灵
- [ ] 离线状态下可浏览已缓存的精灵图鉴（至少 20 个精灵）
- [ ] 缓存命中率统计可查询，首日预期命中率 > 30%，一周后 > 70%
- [ ] 存储配额管理生效，总缓存不超过 100MB
- [ ] LRU 淘汰策略正确执行，过期数据自动清理

## 6. 工作量估算

**M（中等）**
- 客户端缓存层实现：1-2 天
- 服务端批量接口：0.5 天
- SpawnManager 集成：0.5 天
- 测试与调优：1 天
- 总计：约 3-4 天

## 7. 优先级理由

P1 理由：
1. **用户体验关键路径**：精灵详情、图鉴浏览是高频操作，直接影响玩家体验
2. **降低服务器压力**：减少重复请求可显著降低 API 负载
3. **离线支持基础**：为后续离线模式提供数据基础
4. **ROI 高**：实现成本中等，但收益覆盖所有玩家
