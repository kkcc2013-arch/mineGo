/**
const { createLogger } = require('./logger');
const logger = createLogger('spawnMetrics');
 * 精灵刷新 Prometheus 指标
 *
 * @module spawnMetrics
 */

const client = require('prom-client');

const spawnMetrics = {
  // 当前活跃刷新数量
  activeSpawns: new client.Gauge({
    name: 'spawn_active_total',
    help: 'Current number of active spawns',
    labelNames: ['rarity', 'biome']
  }),

  // 刷新计数器
  spawnCounter: new client.Counter({
    name: 'spawn_created_total',
    help: 'Total number of spawns created',
    labelNames: ['rarity', 'biome', 'geohash_prefix']
  }),

  // 消失计数器
  despawnCounter: new client.Counter({
    name: 'spawn_despawn_total',
    help: 'Total number of spawns despawned',
    labelNames: ['reason'] // timeout, captured
  }),

  // 捕捉成功率
  captureRate: new client.Gauge({
    name: 'spawn_capture_rate',
    help: 'Capture success rate',
    labelNames: ['pokemon_rarity']
  }),

  // 区域热度
  cellHeat: new client.Gauge({
    name: 'spawn_cell_active_players',
    help: 'Active players in spawn cell',
    labelNames: ['geohash_prefix']
  }),

  // 刷新计算延迟
  spawnCalculationDuration: new client.Histogram({
    name: 'spawn_calculation_duration_seconds',
    help: 'Time spent calculating spawns',
    labelNames: ['operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),

  // 热力图更新延迟
  heatmapUpdateDuration: new client.Histogram({
    name: 'spawn_heatmap_update_duration_seconds',
    help: 'Time spent updating heatmap',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1]
  }),

  // 刷新引擎健康状态
  spawnEngineHealth: new client.Gauge({
    name: 'spawn_engine_health',
    help: 'Spawn engine health status (1=healthy, 0=unhealthy)',
    labelNames: ['component']
  }),

  // 手动刷新计数
  manualSpawnCounter: new client.Counter({
    name: 'spawn_manual_total',
    help: 'Total number of manual spawns by admins',
    labelNames: ['admin_id', 'pokemon_id']
  }),

  // 配置缓存命中率
  configCacheHits: new client.Counter({
    name: 'spawn_config_cache_hits_total',
    help: 'Config cache hit count',
    labelNames: ['type'] // cell_config, spawn_pool
  }),

  // 配置缓存未命中
  configCacheMisses: new client.Counter({
    name: 'spawn_config_cache_misses_total',
    help: 'Config cache miss count',
    labelNames: ['type']
  }),

  // Redis 操作延迟
  redisOperationDuration: new client.Histogram({
    name: 'spawn_redis_operation_duration_seconds',
    help: 'Redis operation duration',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
  }),

  // 数据库查询延迟
  dbQueryDuration: new client.Histogram({
    name: 'spawn_db_query_duration_seconds',
    help: 'Database query duration',
    labelNames: ['query_type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2]
  })
};

/**
 * 记录刷新操作
 */
spawnMetrics.recordSpawn = function(spawn) {
  this.spawnCounter.inc({
    rarity: spawn.rarity,
    biome: spawn.biome || 'unknown',
    geohash_prefix: spawn.geohash.substring(0, 4)
  });
};

/**
 * 记录消失操作
 */
spawnMetrics.recordDespawn = function(reason) {
  this.despawnCounter.inc({ reason });
};

/**
 * 记录缓存命中
 */
spawnMetrics.recordCacheHit = function(type) {
  this.configCacheHits.inc({ type });
};

/**
 * 记录缓存未命中
 */
spawnMetrics.recordCacheMiss = function(type) {
  this.configCacheMisses.inc({ type });
};

/**
 * 更新活跃刷新数量
 */
spawnMetrics.updateActiveSpawns = async function(redis) {
  try {
    const keys = await redis.keys('spawns:active:*');

    // 按稀有度和生物群系分组
    const grouped = {
      common: { total: 0 },
      rare: { total: 0 },
      legendary: { total: 0 }
    };

    for (const key of keys) {
      const data = await redis.hget(key, 'data');
      if (data) {
        try {
          const spawn = JSON.parse(data);
          const rarity = spawn.rarity || 'common';
          const biome = spawn.biome || 'unknown';

          if (!grouped[rarity]) {
            grouped[rarity] = { total: 0 };
          }
          grouped[rarity].total++;

          if (!grouped[rarity][biome]) {
            grouped[rarity][biome] = 0;
          }
          grouped[rarity][biome]++;
        } catch (error) {
          // 忽略解析错误
        }
      }
    }

    // 更新指标
    for (const [rarity, data] of Object.entries(grouped)) {
      for (const [biome, count] of Object.entries(data)) {
        if (biome === 'total') {
          this.activeSpawns.set({ rarity, biome: 'all' }, count);
        } else {
          this.activeSpawns.set({ rarity, biome }, count);
        }
      }
    }
  } catch (error) {
    logger.error({ module: 'Error updating active spawns metric', error: error.message }, 'Error updating active spawns metric error');;
  }
};

/**
 * 计时器辅助函数
 */
spawnMetrics.timeOperation = function(operation, fn) {
  const end = this.spawnCalculationDuration.startTimer({ operation });
  const promise = fn();
  promise.then(() => end()).catch(() => end());
  return promise;
};

module.exports = spawnMetrics;
