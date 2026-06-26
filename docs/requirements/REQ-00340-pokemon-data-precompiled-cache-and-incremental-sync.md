# REQ-00340: 精灵数据预编译缓存与增量同步系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00340 |
| 标题 | 精灵数据预编译缓存与增量同步系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、gateway、backend/shared、game-client、Redis、PostgreSQL、backend/jobs |
| 创建时间 | 2026-06-26 11:00 UTC |

## 需求描述

### 背景
当前精灵数据查询频繁访问数据库，在高并发场景下数据库压力大。精灵基础数据（属性、技能、进化链等）变化频率低，但查询频率极高，存在大量重复查询。客户端每次启动需要拉取大量精灵数据，启动时间长，用户体验差。

### 目标
1. 建立精灵数据预编译缓存机制，减少数据库查询压力
2. 实现增量同步系统，仅同步变更数据，降低网络传输量
3. 支持客户端智能预加载和离线缓存
4. 提供缓存预热、失效、更新策略
5. 降低客户端启动时间 50%+

### 核心功能

#### 1. 预编译缓存层
- 精灵基础数据预编译（属性、技能、进化链、特性）
- 多级缓存策略（L1 内存缓存 + L2 Redis 缓存 + L3 数据库）
- 缓存预热机制（服务启动时自动加载热点数据）
- 缓存版本管理与一致性校验

#### 2. 增量同步引擎
- 基于 Binlog 或时间戳的增量变更检测
- 差异化数据计算与同步包生成
- 断点续传与失败重试机制
- 同步冲突检测与解决策略

#### 3. 客户端智能缓存
- 本地 SQLite 缓存层
- 智能预加载策略（基于用户行为预测）
- 离线优先策略
- 缓存命中率监控

## 技术方案

### 1. 服务端预编译缓存

#### 1.1 缓存数据结构设计

```javascript
// backend/shared/cache/PokemonCacheManager.js
const NodeCache = require('node-cache');
const Redis = require('ioredis');

class PokemonCacheManager {
  constructor() {
    // L1: 内存缓存（TTL 5分钟）
    this.memoryCache = new NodeCache({
      stdTTL: 300,
      checkperiod: 60,
      maxKeys: 10000
    });
    
    // L2: Redis 缓存（TTL 1小时）
    this.redis = new Redis(process.env.REDIS_URL);
    
    // 缓存版本
    this.cacheVersion = null;
  }
  
  /**
   * 获取精灵数据（多级缓存）
   */
  async getPokemon(pokemonId) {
    const cacheKey = `pokemon:${this.cacheVersion}:${pokemonId}`;
    
    // L1: 内存缓存
    let data = this.memoryCache.get(cacheKey);
    if (data) {
      metrics.increment('cache.hit.memory');
      return data;
    }
    
    // L2: Redis 缓存
    data = await this.redis.get(cacheKey);
    if (data) {
      data = JSON.parse(data);
      this.memoryCache.set(cacheKey, data);
      metrics.increment('cache.hit.redis');
      return data;
    }
    
    // L3: 数据库查询
    data = await this.fetchFromDatabase(pokemonId);
    await this.redis.setex(cacheKey, 3600, JSON.stringify(data));
    this.memoryCache.set(cacheKey, data);
    metrics.increment('cache.hit.database');
    
    return data;
  }
  
  /**
   * 批量获取精灵数据
   */
  async getPokemonBatch(pokemonIds) {
    const results = {};
    const missedIds = [];
    
    // 先从缓存获取
    for (const id of pokemonIds) {
      const data = await this.getPokemon(id);
      if (data) {
        results[id] = data;
      } else {
        missedIds.push(id);
      }
    }
    
    // 批量查询未命中数据
    if (missedIds.length > 0) {
      const batchData = await this.batchFetchFromDatabase(missedIds);
      for (const [id, data] of Object.entries(batchData)) {
        results[id] = data;
        await this.cachePokemon(id, data);
      }
    }
    
    return results;
  }
  
  /**
   * 缓存预热
   */
  async warmup() {
    logger.info('开始缓存预热...');
    
    // 获取热点精灵列表
    const hotPokemonIds = await this.getHotPokemonList();
    
    // 分批预热
    const batchSize = 100;
    for (let i = 0; i < hotPokemonIds.length; i += batchSize) {
      const batch = hotPokemonIds.slice(i, i + batchSize);
      await this.getPokemonBatch(batch);
    }
    
    logger.info(`缓存预热完成，预加载 ${hotPokemonIds.length} 条数据`);
  }
  
  /**
   * 更新缓存版本（触发全量刷新）
   */
  async updateCacheVersion() {
    const newVersion = Date.now().toString();
    const oldVersion = this.cacheVersion;
    
    this.cacheVersion = newVersion;
    await this.redis.set('pokemon:cache:version', newVersion);
    
    // 异步清理旧缓存
    this.cleanupOldCache(oldVersion);
    
    logger.info(`缓存版本更新: ${oldVersion} -> ${newVersion}`);
  }
  
  /**
   * 清理旧版本缓存
   */
  async cleanupOldCache(oldVersion) {
    const pattern = `pokemon:${oldVersion}:*`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
      await this.redis.del(keys);
      logger.info(`清理旧缓存: ${keys.length} 条`);
    }
  }
}

module.exports = new PokemonCacheManager();
```

#### 1.2 缓存预热服务

```javascript
// backend/jobs/cacheWarmup.js
const cron = require('node-cron');
const cacheManager = require('../shared/cache/PokemonCacheManager');
const { HotPokemonAnalyzer } = require('../shared/analytics');

class CacheWarmupJob {
  constructor() {
    this.analyzer = new HotPokemonAnalyzer();
  }
  
  /**
   * 定时预热任务（每小时执行）
   */
  start() {
    // 服务启动时立即预热
    this.warmupHotData();
    
    // 定时预热
    cron.schedule('0 * * * *', () => {
      this.warmupHotData();
    });
    
    // 每日凌晨更新热点数据模型
    cron.schedule('0 2 * * *', () => {
      this.updateHotDataModel();
    });
  }
  
  /**
   * 预热热点数据
   */
  async warmupHotData() {
    try {
      // 获取热点精灵列表
      const hotPokemonIds = await this.analyzer.getHotPokemonList({
        limit: 500,
        timeWindow: '24h'
      });
      
      // 预热缓存
      await cacheManager.warmup(hotPokemonIds);
      
      logger.info('缓存预热完成', {
        count: hotPokemonIds.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('缓存预热失败', { error: error.message });
    }
  }
  
  /**
   * 更新热点数据模型
   */
  async updateHotDataModel() {
    await this.analyzer.retrain();
    logger.info('热点数据模型更新完成');
  }
}

module.exports = new CacheWarmupJob();
```

### 2. 增量同步引擎

#### 2.1 变更检测与同步

```javascript
// backend/shared/sync/IncrementalSyncEngine.js
const { EventEmitter } = require('events');
const murmurhash = require('murmurhash');

class IncrementalSyncEngine extends EventEmitter {
  constructor() {
    super();
    this.syncState = new Map(); // 用户同步状态
  }
  
  /**
   * 计算数据指纹
   */
  computeDataFingerprint(data) {
    const jsonStr = JSON.stringify(data, Object.keys(data).sort());
    return murmurhash.v3(jsonStr).toString(16);
  }
  
  /**
   * 检测增量变更
   */
  async detectChanges(lastSyncTime) {
    const changes = {
      created: [],
      updated: [],
      deleted: []
    };
    
    // 查询新增记录
    changes.created = await db.query(`
      SELECT * FROM pokemon_species
      WHERE created_at > $1
    `, [lastSyncTime]);
    
    // 查询更新记录
    changes.updated = await db.query(`
      SELECT * FROM pokemon_species
      WHERE updated_at > $1 AND created_at <= $1
    `, [lastSyncTime]);
    
    // 查询删除记录
    changes.deleted = await db.query(`
      SELECT id FROM pokemon_species_deletions
      WHERE deleted_at > $1
    `, [lastSyncTime]);
    
    return changes;
  }
  
  /**
   * 生成同步包
   */
  async generateSyncPackage(userId, lastSyncTime, options = {}) {
    const changes = await this.detectChanges(lastSyncTime);
    
    const syncPackage = {
      version: Date.now(),
      baseTime: lastSyncTime,
      changes: {
        created: changes.created.map(p => ({
          id: p.id,
          data: p,
          fingerprint: this.computeDataFingerprint(p)
        })),
        updated: changes.updated.map(p => ({
          id: p.id,
          patches: this.computePatch(p.old, p.new),
          fingerprint: this.computeDataFingerprint(p)
        })),
        deleted: changes.deleted.map(id => ({ id }))
      },
      checksum: null
    };
    
    // 计算校验和
    syncPackage.checksum = this.computeSyncPackageChecksum(syncPackage);
    
    // 压缩同步包
    if (options.compress) {
      syncPackage.compressed = true;
      syncPackage.data = await this.compress(syncPackage.changes);
    }
    
    // 更新用户同步状态
    this.syncState.set(userId, {
      lastSyncTime: syncPackage.version,
      checksum: syncPackage.checksum
    });
    
    logger.info('生成同步包', {
      userId,
      created: changes.created.length,
      updated: changes.updated.length,
      deleted: changes.deleted.length
    });
    
    return syncPackage;
  }
  
  /**
   * 计算数据差异补丁
   */
  computePatch(oldData, newData) {
    const patch = {};
    
    for (const key of Object.keys(newData)) {
      if (oldData[key] !== newData[key]) {
        patch[key] = {
          oldValue: oldData[key],
          newValue: newData[key]
        };
      }
    }
    
    return patch;
  }
  
  /**
   * 计算同步包校验和
   */
  computeSyncPackageChecksum(syncPackage) {
    const data = JSON.stringify(syncPackage.changes);
    return require('crypto')
      .createHash('sha256')
      .update(data)
      .digest('hex');
  }
  
  /**
   * 压缩数据
   */
  async compress(data) {
    const zlib = require('zlib');
    const jsonStr = JSON.stringify(data);
    
    return new Promise((resolve, reject) => {
      zlib.gzip(jsonStr, (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed.toString('base64'));
      });
    });
  }
  
  /**
   * 解压数据
   */
  async decompress(compressedData) {
    const zlib = require('zlib');
    const buffer = Buffer.from(compressedData, 'base64');
    
    return new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, decompressed) => {
        if (err) reject(err);
        else resolve(JSON.parse(decompressed.toString()));
      });
    });
  }
}

module.exports = new IncrementalSyncEngine();
```

#### 2.2 同步 API 端点

```javascript
// backend/services/pokemon-service/routes/sync.js
const express = require('express');
const router = express.Router();
const syncEngine = require('../../shared/sync/IncrementalSyncEngine');
const auth = require('../../shared/middleware/auth');

/**
 * 获取增量同步数据
 * GET /api/pokemon/sync/incremental
 */
router.get('/incremental', auth.required, async (req, res) => {
  try {
    const { lastSyncTime = 0 } = req.query;
    const userId = req.user.id;
    
    const syncPackage = await syncEngine.generateSyncPackage(
      userId,
      new Date(parseInt(lastSyncTime)),
      { compress: true }
    );
    
    res.json({
      success: true,
      data: syncPackage
    });
  } catch (error) {
    logger.error('增量同步失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'SYNC_FAILED'
    });
  }
});

/**
 * 获取全量同步数据
 * GET /api/pokemon/sync/full
 */
router.get('/full', auth.required, async (req, res) => {
  try {
    const userId = req.user.id;
    const { compress = true } = req.query;
    
    // 获取所有精灵数据
    const allPokemon = await db.query(`
      SELECT * FROM pokemon_species
    `);
    
    const syncPackage = {
      version: Date.now(),
      type: 'full',
      count: allPokemon.length,
      data: compress ? await syncEngine.compress(allPokemon) : allPokemon,
      compressed: compress
    };
    
    res.json({
      success: true,
      data: syncPackage
    });
  } catch (error) {
    logger.error('全量同步失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'SYNC_FAILED'
    });
  }
});

/**
 * 验证同步完整性
 * POST /api/pokemon/sync/verify
 */
router.post('/verify', auth.required, async (req, res) => {
  try {
    const { checksums } = req.body;
    
    const results = {};
    for (const [id, checksum] of Object.entries(checksums)) {
      const pokemon = await db.queryOne(
        'SELECT * FROM pokemon_species WHERE id = $1',
        [id]
      );
      
      if (pokemon) {
        const serverChecksum = syncEngine.computeDataFingerprint(pokemon);
        results[id] = {
          match: checksum === serverChecksum,
          serverChecksum
        };
      }
    }
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('同步验证失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'VERIFY_FAILED'
    });
  }
});

module.exports = router;
```

### 3. 客户端智能缓存

#### 3.1 客户端缓存管理器

```javascript
// frontend/game-client/src/cache/PokemonLocalCache.js
import SQLite from 'react-native-sqlite-storage';

class PokemonLocalCache {
  constructor() {
    this.db = null;
    this.cacheHitRate = { hit: 0, miss: 0 };
  }
  
  /**
   * 初始化本地数据库
   */
  async initialize() {
    this.db = await SQLite.openDatabase({
      name: 'pokemon_cache.db',
      location: 'default'
    });
    
    // 创建表结构
    await this.createTables();
    
    // 加载缓存版本
    await this.loadCacheVersion();
  }
  
  /**
   * 创建缓存表
   */
  async createTables() {
    await this.db.executeSql(`
      CREATE TABLE IF NOT EXISTS pokemon_cache (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        fingerprint TEXT,
        cached_at INTEGER,
        access_count INTEGER DEFAULT 0,
        last_access INTEGER
      )
    `);
    
    await this.db.executeSql(`
      CREATE INDEX IF NOT EXISTS idx_fingerprint 
      ON pokemon_cache(fingerprint)
    `);
    
    await this.db.executeSql(`
      CREATE INDEX IF NOT EXISTS idx_access 
      ON pokemon_cache(last_access DESC)
    `);
  }
  
  /**
   * 获取缓存的精灵数据
   */
  async get(pokemonId) {
    const results = await this.db.executeSql(
      'SELECT data, fingerprint FROM pokemon_cache WHERE id = ?',
      [pokemonId]
    );
    
    if (results.length > 0 && results[0].rows.length > 0) {
      this.cacheHitRate.hit++;
      
      // 更新访问统计
      await this.db.executeSql(
        'UPDATE pokemon_cache SET access_count = access_count + 1, last_access = ? WHERE id = ?',
        [Date.now(), pokemonId]
      );
      
      return {
        data: JSON.parse(results[0].rows.item(0).data),
        fingerprint: results[0].rows.item(0).fingerprint
      };
    }
    
    this.cacheHitRate.miss++;
    return null;
  }
  
  /**
   * 批量获取缓存数据
   */
  async getBatch(pokemonIds) {
    const placeholders = pokemonIds.map(() => '?').join(',');
    const results = await this.db.executeSql(
      `SELECT id, data FROM pokemon_cache WHERE id IN (${placeholders})`,
      pokemonIds
    );
    
    const cached = {};
    if (results.length > 0) {
      for (let i = 0; i < results[0].rows.length; i++) {
        const row = results[0].rows.item(i);
        cached[row.id] = JSON.parse(row.data);
      }
    }
    
    return cached;
  }
  
  /**
   * 保存精灵数据到缓存
   */
  async set(pokemonId, data, fingerprint) {
    await this.db.executeSql(
      `INSERT OR REPLACE INTO pokemon_cache 
       (id, data, fingerprint, cached_at, access_count, last_access)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [pokemonId, JSON.stringify(data), fingerprint, Date.now(), Date.now()]
    );
  }
  
  /**
   * 批量保存数据
   */
  async setBatch(pokemonList) {
    await this.db.transaction(async (tx) => {
      for (const { id, data, fingerprint } of pokemonList) {
        tx.executeSql(
          `INSERT OR REPLACE INTO pokemon_cache 
           (id, data, fingerprint, cached_at, access_count, last_access)
           VALUES (?, ?, ?, ?, 0, ?)`,
          [id, JSON.stringify(data), fingerprint, Date.now(), Date.now()]
        );
      }
    });
  }
  
  /**
   * 应用增量更新
   */
  async applyIncrementalUpdate(syncPackage) {
    await this.db.transaction(async (tx) => {
      // 应用新增
      for (const { id, data, fingerprint } of syncPackage.changes.created) {
        tx.executeSql(
          'INSERT OR REPLACE INTO pokemon_cache (id, data, fingerprint, cached_at, last_access) VALUES (?, ?, ?, ?, ?)',
          [id, JSON.stringify(data), fingerprint, Date.now(), Date.now()]
        );
      }
      
      // 应用更新
      for (const { id, patches, fingerprint } of syncPackage.changes.updated) {
        const existing = await this.get(id);
        if (existing) {
          const updated = this.applyPatches(existing.data, patches);
          tx.executeSql(
            'UPDATE pokemon_cache SET data = ?, fingerprint = ?, cached_at = ? WHERE id = ?',
            [JSON.stringify(updated), fingerprint, Date.now(), id]
          );
        }
      }
      
      // 应用删除
      for (const { id } of syncPackage.changes.deleted) {
        tx.executeSql('DELETE FROM pokemon_cache WHERE id = ?', [id]);
      }
    });
    
    // 更新缓存版本
    await this.updateCacheVersion(syncPackage.version);
  }
  
  /**
   * 应用补丁
   */
  applyPatches(data, patches) {
    const result = { ...data };
    for (const [key, patch] of Object.entries(patches)) {
      result[key] = patch.newValue;
    }
    return result;
  }
  
  /**
   * 清理过期缓存
   */
  async cleanupExpired(ttl = 7 * 24 * 3600 * 1000) {
    const threshold = Date.now() - ttl;
    await this.db.executeSql(
      'DELETE FROM pokemon_cache WHERE last_access < ?',
      [threshold]
    );
  }
  
  /**
   * 获取缓存命中率
   */
  getCacheHitRate() {
    const total = this.cacheHitRate.hit + this.cacheHitRate.miss;
    return total > 0 ? (this.cacheHitRate.hit / total * 100).toFixed(2) : 0;
  }
}

export default new PokemonLocalCache();
```

#### 3.2 智能预加载策略

```javascript
// frontend/game-client/src/cache/SmartPreloader.js
import cache from './PokemonLocalCache';
import analytics from '../analytics';

class SmartPreloader {
  constructor() {
    this.preloadQueue = [];
    this.userBehaviorModel = null;
  }
  
  /**
   * 初始化预加载策略
   */
  async initialize() {
    // 加载用户行为模型
    this.userBehaviorModel = await this.loadUserBehaviorModel();
    
    // 注册行为监听
    this.setupBehaviorTracking();
  }
  
  /**
   * 基于用户行为预测需要预加载的数据
   */
  async predictAndPreload(context) {
    const predictions = this.userBehaviorModel.predict(context);
    
    // 按优先级排序
    predictions.sort((a, b) => b.probability - a.probability);
    
    // 预加载前 20 个预测
    const topPredictions = predictions.slice(0, 20);
    
    for (const prediction of topPredictions) {
      if (prediction.probability > 0.7) {
        await this.preloadPokemon(prediction.pokemonId);
      }
    }
  }
  
  /**
   * 预加载单个精灵数据
   */
  async preloadPokemon(pokemonId) {
    // 检查是否已缓存
    const cached = await cache.get(pokemonId);
    if (cached) return;
    
    // 从服务器获取
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}`);
      const data = await response.json();
      
      // 保存到缓存
      await cache.set(pokemonId, data.data, data.fingerprint);
      
      logger.debug(`预加载精灵: ${pokemonId}`);
    } catch (error) {
      logger.error(`预加载失败: ${pokemonId}`, error);
    }
  }
  
  /**
   * 启动时智能预加载
   */
  async startupPreload() {
    // 获取用户历史行为
    const recentPokemon = await analytics.getRecentlyViewedPokemon(20);
    
    // 预加载最近查看的精灵
    for (const pokemonId of recentPokemon) {
      await this.preloadPokemon(pokemonId);
    }
    
    // 预加载热点精灵
    const hotPokemon = await this.getHotPokemonList(50);
    for (const pokemonId of hotPokemon) {
      await this.preloadPokemon(pokemonId);
    }
  }
  
  /**
   * 设置行为追踪
   */
  setupBehaviorTracking() {
    // 追踪精灵查看
    eventBus.on('pokemon:view', (pokemonId) => {
      this.recordBehavior('view', pokemonId);
    });
    
    // 追踪精灵捕捉
    eventBus.on('pokemon:catch', (pokemonId) => {
      this.recordBehavior('catch', pokemonId);
    });
    
    // 追踪地图移动
    eventBus.on('map:move', (location) => {
      this.predictAndPreload({ location });
    });
  }
  
  /**
   * 记录用户行为
   */
  recordBehavior(type, pokemonId) {
    analytics.track('user_behavior', {
      type,
      pokemonId,
      timestamp: Date.now()
    });
  }
}

export default new SmartPreloader();
```

### 4. 监控与指标

#### 4.1 缓存性能监控

```javascript
// backend/shared/monitoring/CacheMonitor.js
const prometheus = require('prom-client');

class CacheMonitor {
  constructor() {
    // 缓存命中率
    this.cacheHitRate = new prometheus.Gauge({
      name: 'pokemon_cache_hit_rate',
      help: 'Cache hit rate percentage',
      labelNames: ['cache_level']
    });
    
    // 缓存大小
    this.cacheSize = new prometheus.Gauge({
      name: 'pokemon_cache_size_bytes',
      help: 'Cache size in bytes',
      labelNames: ['cache_level']
    });
    
    // 查询延迟
    this.queryLatency = new prometheus.Histogram({
      name: 'pokemon_query_latency_seconds',
      help: 'Query latency in seconds',
      labelNames: ['source'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
    });
    
    // 同步统计
    this.syncStats = new prometheus.Counter({
      name: 'pokemon_sync_total',
      help: 'Total sync operations',
      labelNames: ['type', 'status']
    });
  }
  
  /**
   * 记录缓存命中
   */
  recordHit(level) {
    this.cacheHitRate.labels(level).inc();
    this.syncStats.labels('incremental', 'hit').inc();
  }
  
  /**
   * 记录缓存未命中
   */
  recordMiss(level) {
    this.syncStats.labels('incremental', 'miss').inc();
  }
  
  /**
   * 记录查询延迟
   */
  recordLatency(source, duration) {
    this.queryLatency.labels(source).observe(duration);
  }
  
  /**
   * 生成监控报告
   */
  generateReport() {
    return {
      hitRate: {
        memory: this.cacheHitRate.labels('memory').get(),
        redis: this.cacheHitRate.labels('redis').get()
      },
      averageLatency: {
        memory: this.queryLatency.labels('memory').avg,
        redis: this.queryLatency.labels('redis').avg,
        database: this.queryLatency.labels('database').avg
      },
      syncOperations: this.syncStats.get()
    };
  }
}

module.exports = new CacheMonitor();
```

## 验收标准

- [ ] 实现三级缓存机制（L1 内存 + L2 Redis + L3 数据库）
- [ ] 缓存命中率 >= 95%（内存 + Redis 合计）
- [ ] 数据库查询压力降低 80%+
- [ ] 增量同步包大小 < 全量同步的 10%
- [ ] 客户端启动时间减少 50%+
- [ ] 支持断点续传和失败重试
- [ ] 缓存预热完成时间 < 30 秒
- [ ] 本地缓存命中率 >= 90%
- [ ] 同步失败自动降级到全量同步
- [ ] 监控指标接入 Prometheus/Grafana
- [ ] 单元测试覆盖率 >= 80%
- [ ] 压力测试通过（10000 QPS）

## 影响范围

### 新增文件
- `backend/shared/cache/PokemonCacheManager.js` - 缓存管理器
- `backend/shared/sync/IncrementalSyncEngine.js` - 增量同步引擎
- `backend/jobs/cacheWarmup.js` - 缓存预热任务
- `backend/shared/monitoring/CacheMonitor.js` - 缓存监控
- `frontend/game-client/src/cache/PokemonLocalCache.js` - 客户端缓存
- `frontend/game-client/src/cache/SmartPreloader.js` - 智能预加载

### 修改文件
- `backend/services/pokemon-service/routes/sync.js` - 新增同步 API
- `backend/services/pokemon-service/routes/index.js` - 注册同步路由
- `gateway/src/routes/pokemon.js` - 网关路由配置
- `infrastructure/k8s/monitoring/prometheus.yml` - 监控配置
- `database/migrations/` - 新增同步状态表

### 依赖项
- `node-cache` - 内存缓存
- `react-native-sqlite-storage` - 客户端 SQLite
- `murmurhash` - 数据指纹计算

## 参考

- [Redis Caching Best Practices](https://redis.com/redis-enterprise/technology/redis-caching/)
- [SQLite for Mobile Apps](https://www.sqlite.org/whentouse.html)
- [Incremental Sync Patterns](https://martinfowler.com/articles/patterns-of-distributed-systems/single-socket-channel.html)
- [Cache Warming Strategies](https://aws.amazon.com/blogs/database/best-practices-for-amazon-elasticache-for-redis/)
- [Data Synchronization in Mobile Apps](https://developers.google.com/instance-id)
