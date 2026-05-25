// shared/redis.js
const Redis = require('ioredis');

let client = null;

function getRedis() {
  if (!client) {
    const clusterNodes = process.env.REDIS_CLUSTER_NODES;
    if (clusterNodes) {
      const nodes = clusterNodes.split(',').map(n => {
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
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });
    }

    client.on('error', (err) => console.error('[Redis] Error:', err));
    client.on('connect', () => console.log('[Redis] Connected'));
  }
  return client;
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

module.exports = { getRedis, getJSON, setJSON, geoAdd, geoRadius };
