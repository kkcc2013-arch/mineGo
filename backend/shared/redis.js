// shared/redis.js - Redis 客户端封装（兼容旧接口，内部使用连接池）
'use strict';
const { createLogger } = require('./logger');
const logger = createLogger('redis');

const Redis = require('ioredis');
const { getPoolManager, initPool } = require('./RedisPoolManager');

let client = null;
let poolManager = null;
let poolInitialized = false;

/**
 * 初始化连接池（推荐）
 */
async function initRedisPool(poolName = 'default', config = {}) {
  if (!poolInitialized) {
    poolManager = getPoolManager({
      serviceName: process.env.SERVICE_NAME || 'default',
      ...config,
    });
    await initPool(poolName, config);
    poolInitialized = true;
  }
  return poolManager;
}

/**
 * 获取 Redis 客户端（向后兼容）
 */
function getRedis() {
  if (!client) {
    const clusterNodes = process.env.REDIS_CLUSTER_NODES;
    if (clusterNodes) {
      const nodes = clusterNodes.split(',').map((n) => {
        const [host, port] = n.split(':');
        return { host, port: parseInt(port || '6379') };
      });
      client = new Redis.Cluster(nodes, {
        redisOptions: { password: process.env.REDIS_PASSWORD },
        enableReadyCheck: true,
      });
    } else {
      client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 10) return null;
          const delay = Math.min(times * 100, 3000);
          const jitter = Math.random() * 100;
          return delay + jitter;
        },
      });
    }

    client.on('error', (err) => logger.error({ module: 'Redis] Error', error: err.message }, 'Redis] Error error'););
    client.on('connect', () => logger.info({ module: 'Redis] Connected' }, 'Redis] Connected message'););
  }
  return client;
}

/**
 * 使用连接池执行命令（推荐）
 */
async function withPool(poolName, fn) {
  const manager = poolManager || getPoolManager();

  if (!manager.pools.has(poolName)) {
    await initPool(poolName);
  }

  const connection = await manager.acquire(poolName);
  try {
    return await fn(connection.client);
  } finally {
    await manager.release(connection, poolName);
  }
}

// Helper: get JSON
async function getJSON(key) {
  const val = await getRedis().get(key);
  return val ? JSON.parse(val) : null;
}

// Helper: set JSON with optional TTL
async function setJSON(key, value, ttlSec) {
  const str = JSON.stringify(value);
  if (ttlSec) return getRedis().setex(key, ttlSec, str);
  return getRedis().set(key, str);
}

// Geo: add location
async function geoAdd(key, lng, lat, member) {
  return getRedis().geoadd(key, lng, lat, member);
}

// Geo: radius search — returns members within distance
async function geoRadius(key, lng, lat, radiusM) {
  return getRedis().georadius(key, lng, lat, radiusM, 'm', 'WITHCOORD', 'WITHDIST', 'ASC');
}

/**
 * 获取连接池管理器
 */
function getPool() {
  return poolManager;
}

/**
 * 关闭所有连接
 */
async function closeRedis() {
  if (poolManager) {
    await poolManager.close();
    poolManager = null;
    poolInitialized = false;
  }
  if (client) {
    await client.quit();
    client = null;
  }
}

/**
 * 健康检查
 */
async function healthCheck(poolName = 'default') {
  if (poolManager) {
    return poolManager.healthCheck(poolName);
  }

  // 简单 PING 检查
  const start = Date.now();
  await getRedis().ping();
  return {
    status: 'healthy',
    latency: Date.now() - start,
    lastCheck: new Date(),
  };
}

/**
 * 获取连接统计信息
 */
function getPoolStats(poolName = 'default') {
  if (poolManager) {
    return poolManager.getPoolStats(poolName);
  }
  return null;
}
module.exports = {
  getRedis,
  getRedisClient,
  getJSON,
  setJSON,
  geoAdd,
  geoRadius,

  // 新接口（推荐使用）
  initRedisPool,
  withPool,
  getPool,
  closeRedis,
  healthCheck,
  getPoolStats,
};

function getRedisClient() {
  return getRedis();
}
