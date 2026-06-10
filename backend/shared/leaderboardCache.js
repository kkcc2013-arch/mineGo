/**
 * 排行榜 Redis 缓存层
 * 使用 Redis Sorted Set 实现高性能排行榜
 * 
 * REQ-00074: 玩家排行榜系统
 */

const { getRedisClient } = require('./redis');
const { logger } = require('./logger');
const { Counter, Histogram } = require('prom-client');

// Prometheus 指标
const cacheOperationLatency = new Histogram({
  name: 'leaderboard_cache_operation_latency_seconds',
  help: 'Leaderboard cache operation latency',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1]
});

const cacheHitTotal = new Counter({
  name: 'leaderboard_cache_hit_total',
  help: 'Total cache hits',
  labelNames: ['operation']
});

class LeaderboardCache {
  constructor(redisClient = null) {
    this.redis = redisClient || getRedisClient();
  }

  /**
   * 生成排行榜 Redis Key
   */
  getKey(leaderboardType, seasonId) {
    return `leaderboard:${leaderboardType}:season:${seasonId}`;
  }

  /**
   * 更新玩家分数
   */
  async updateScore(leaderboardType, seasonId, playerId, score) {
    const end = cacheOperationLatency.startTimer({ operation: 'updateScore' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      await this.redis.zadd(key, score, playerId.toString());
      
      // 设置过期时间（赛季结束后 7 天）
      const ttl = 7 * 24 * 60 * 60;
      await this.redis.expire(key, ttl);
      
      // 获取新排名
      const rank = await this.redis.zrevrank(key, playerId.toString());
      cacheHitTotal.inc({ operation: 'updateScore' });
      
      return rank !== null ? rank + 1 : null;
    } catch (error) {
      logger.error('LeaderboardCache.updateScore error', { error: error.message, leaderboardType, seasonId, playerId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 增加玩家分数
   */
  async incrementScore(leaderboardType, seasonId, playerId, increment) {
    const end = cacheOperationLatency.startTimer({ operation: 'incrementScore' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      const newScore = await this.redis.zincrby(key, increment, playerId.toString());
      
      // 确保过期时间
      const ttl = await this.redis.ttl(key);
      if (ttl < 0) {
        await this.redis.expire(key, 7 * 24 * 60 * 60);
      }
      
      const rank = await this.redis.zrevrank(key, playerId.toString());
      cacheHitTotal.inc({ operation: 'incrementScore' });
      
      return {
        score: parseInt(newScore),
        rank: rank !== null ? rank + 1 : null
      };
    } catch (error) {
      logger.error('LeaderboardCache.incrementScore error', { error: error.message, leaderboardType, seasonId, playerId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 获取玩家排名
   */
  async getPlayerRank(leaderboardType, seasonId, playerId) {
    const end = cacheOperationLatency.startTimer({ operation: 'getPlayerRank' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      const [rank, score] = await Promise.all([
        this.redis.zrevrank(key, playerId.toString()),
        this.redis.zscore(key, playerId.toString())
      ]);
      
      cacheHitTotal.inc({ operation: 'getPlayerRank' });
      
      return {
        rank: rank !== null ? rank + 1 : null,
        score: score ? parseInt(score) : 0
      };
    } catch (error) {
      logger.error('LeaderboardCache.getPlayerRank error', { error: error.message, leaderboardType, seasonId, playerId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 获取排行榜前 N 名
   */
  async getTopPlayers(leaderboardType, seasonId, limit = 100) {
    const end = cacheOperationLatency.startTimer({ operation: 'getTopPlayers' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      const results = await this.redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
      
      const players = [];
      for (let i = 0; i < results.length; i += 2) {
        players.push({
          rank: Math.floor(i / 2) + 1,
          playerId: parseInt(results[i]),
          score: parseInt(results[i + 1])
        });
      }
      
      cacheHitTotal.inc({ operation: 'getTopPlayers' });
      return players;
    } catch (error) {
      logger.error('LeaderboardCache.getTopPlayers error', { error: error.message, leaderboardType, seasonId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 获取玩家附近排名
   */
  async getPlayersAround(leaderboardType, seasonId, playerId, range = 5) {
    const end = cacheOperationLatency.startTimer({ operation: 'getPlayersAround' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      const playerRank = await this.redis.zrevrank(key, playerId.toString());
      
      if (playerRank === null) {
        // 玩家不在排行榜中，返回前 range 名
        return await this.getTopPlayers(leaderboardType, seasonId, range);
      }
      
      const start = Math.max(0, playerRank - range);
      const endRank = playerRank + range;
      
      const results = await this.redis.zrevrange(key, start, endRank, 'WITHSCORES');
      
      const players = [];
      for (let i = 0; i < results.length; i += 2) {
        players.push({
          rank: start + Math.floor(i / 2) + 1,
          playerId: parseInt(results[i]),
          score: parseInt(results[i + 1])
        });
      }
      
      cacheHitTotal.inc({ operation: 'getPlayersAround' });
      return players;
    } catch (error) {
      logger.error('LeaderboardCache.getPlayersAround error', { error: error.message, leaderboardType, seasonId, playerId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 获取排行榜总人数
   */
  async getTotalPlayers(leaderboardType, seasonId) {
    const key = this.getKey(leaderboardType, seasonId);
    return await this.redis.zcard(key);
  }

  /**
   * 批量同步数据库到 Redis
   */
  async syncFromDatabase(leaderboardType, seasonId, players) {
    const end = cacheOperationLatency.startTimer({ operation: 'syncFromDatabase' });
    try {
      const key = this.getKey(leaderboardType, seasonId);
      const pipeline = this.redis.pipeline();
      
      for (const player of players) {
        pipeline.zadd(key, player.score, player.playerId.toString());
      }
      
      await pipeline.exec();
      await this.redis.expire(key, 7 * 24 * 60 * 60);
      
      logger.info('LeaderboardCache.syncFromDatabase completed', { 
        leaderboardType, 
        seasonId, 
        playerCount: players.length 
      });
    } catch (error) {
      logger.error('LeaderboardCache.syncFromDatabase error', { error: error.message, leaderboardType, seasonId });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * 清空排行榜缓存
   */
  async clearLeaderboard(leaderboardType, seasonId) {
    const key = this.getKey(leaderboardType, seasonId);
    await this.redis.del(key);
    logger.info('LeaderboardCache.clearLeaderboard', { leaderboardType, seasonId });
  }

  /**
   * 获取分数范围内的玩家
   */
  async getPlayersByScoreRange(leaderboardType, seasonId, minScore, maxScore, limit = 100) {
    const key = this.getKey(leaderboardType, seasonId);
    const results = await this.redis.zrevrangebyscore(key, maxScore, minScore, 'WITHSCORES', 'LIMIT', 0, limit);
    
    const players = [];
    for (let i = 0; i < results.length; i += 2) {
      players.push({
        playerId: parseInt(results[i]),
        score: parseInt(results[i + 1])
      });
    }
    
    return players;
  }
}

module.exports = LeaderboardCache;
