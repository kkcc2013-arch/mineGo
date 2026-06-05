// backend/services/social-service/src/trade/distance.js
// 精灵交易距离验证模块

'use strict';

const { createLogger } = require('../../../shared/logger');
const redis = require('redis');

const logger = createLogger('trade-distance');

// Redis 客户端
let redisClient = null;

/**
 * 初始化 Redis 客户端
 */
async function initRedisClient() {
  if (!redisClient) {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    await redisClient.connect();
    logger.info('Redis client connected for distance validation');
  }
  return redisClient;
}

/**
 * 最大交易距离（米）
 */
const MAX_TRADE_DISTANCE = 100;

/**
 * 验证两个用户之间的距离
 * @param {string} userId1 - 用户1 ID
 * @param {string} userId2 - 用户2 ID
 * @returns {Object} { valid: boolean, distance: number, error?: string }
 */
async function validateTradeDistance(userId1, userId2) {
  try {
    const client = await initRedisClient();

    // 从 Redis GEO 获取用户位置
    const GEO_KEY = 'user:locations';
    
    const [pos1, pos2] = await Promise.all([
      client.geoPos(GEO_KEY, userId1),
      client.geoPos(GEO_KEY, userId2)
    ]);

    // 检查位置是否存在
    if (!pos1 || pos1.length === 0 || !pos1[0]) {
      return {
        valid: false,
        distance: null,
        error: '发起方位置信息缺失'
      };
    }

    if (!pos2 || pos2.length === 0 || !pos2[0]) {
      return {
        valid: false,
        distance: null,
        error: '接收方位置信息缺失'
      };
    }

    // 计算距离（使用 Redis GEODIST）
    const distance = await client.geoDist(GEO_KEY, userId1, userId2, 'm');

    if (distance === null) {
      return {
        valid: false,
        distance: null,
        error: '无法计算距离'
      };
    }

    // 验证距离是否在限制内
    const valid = distance <= MAX_TRADE_DISTANCE;

    return {
      valid,
      distance: Math.round(distance * 100) / 100,
      maxDistance: MAX_TRADE_DISTANCE
    };
  } catch (error) {
    logger.error({ error, userId1, userId2 }, '距离验证失败');
    return {
      valid: false,
      distance: null,
      error: '距离验证失败'
    };
  }
}

/**
 * 获取用户位置
 * @param {string} userId - 用户ID
 * @returns {Object} { longitude: number, latitude: number } | null
 */
async function getUserLocation(userId) {
  try {
    const client = await initRedisClient();
    const GEO_KEY = 'user:locations';
    
    const pos = await client.geoPos(GEO_KEY, userId);
    
    if (!pos || pos.length === 0 || !pos[0]) {
      return null;
    }

    return {
      longitude: parseFloat(pos[0][0]),
      latitude: parseFloat(pos[0][1])
    };
  } catch (error) {
    logger.error({ error, userId }, '获取用户位置失败');
    return null;
  }
}

/**
 * 更新用户位置
 * @param {string} userId - 用户ID
 * @param {number} longitude - 经度
 * @param {number} latitude - 纬度
 */
async function updateUserLocation(userId, longitude, latitude) {
  try {
    const client = await initRedisClient();
    const GEO_KEY = 'user:locations';
    
    await client.geoAdd(GEO_KEY, {
      longitude,
      latitude,
      member: userId
    });

    // 设置过期时间（30分钟）
    await client.expire(GEO_KEY, 1800);

    logger.debug({ userId, longitude, latitude }, '用户位置已更新');
  } catch (error) {
    logger.error({ error, userId }, '更新用户位置失败');
  }
}

/**
 * 检查用户是否在线（有位置记录）
 * @param {string} userId - 用户ID
 * @returns {boolean}
 */
async function isUserOnline(userId) {
  try {
    const location = await getUserLocation(userId);
    return location !== null;
  } catch (error) {
    return false;
  }
}

module.exports = {
  validateTradeDistance,
  getUserLocation,
  updateUserLocation,
  isUserOnline,
  MAX_TRADE_DISTANCE
};
