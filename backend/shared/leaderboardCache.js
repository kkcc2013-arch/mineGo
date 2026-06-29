/**
 * LeaderboardCache - Redis 排行榜缓存层
 * 使用 Redis Sorted Set 实现高性能排行榜
 */

class LeaderboardCache {
  /**
   * @param {import('ioredis').Redis} redisClient
   */
  constructor(redisClient) {
    this.redis = redisClient;
    this.prefix = 'lb';
  }

  /**
   * 生成排行榜 Redis Key
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @returns {string}
   */
  getKey(leaderboardType, seasonId) {
    return `${this.prefix}:${leaderboardType}:s:${seasonId}`;
  }

  /**
   * 更新玩家分数
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {number} playerId
   * @param {number} score
   * @returns {Promise<{score: number, rank: number}>}
   */
  async updateScore(leaderboardType, seasonId, playerId, score) {
    const key = this.getKey(leaderboardType, seasonId);
    
    await this.redis.zadd(key, score, playerId.toString());
    await this.redis.expire(key, 7 * 24 * 60 * 60);
    
    const rank = await this.redis.zrevrank(key, playerId.toString());
    return {
      score: score,
      rank: rank !== null ? rank + 1 : null
    };
  }

  /**
   * 增加玩家分数
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {number} playerId
   * @param {number} increment
   * @returns {Promise<{score: number, rank: number}>}
   */
  async incrementScore(leaderboardType, seasonId, playerId, increment) {
    const key = this.getKey(leaderboardType, seasonId);
    
    const newScore = await this.redis.zincrby(key, increment, playerId.toString());
    await this.redis.expire(key, 7 * 24 * 60 * 60);
    
    const rank = await this.redis.zrevrank(key, playerId.toString());
    return {
      score: parseInt(newScore),
      rank: rank !== null ? rank + 1 : null
    };
  }

  /**
   * 获取玩家排名
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {number} playerId
   * @returns {Promise<{rank: number|null, score: number}>}
   */
  async getPlayerRank(leaderboardType, seasonId, playerId) {
    const key = this.getKey(leaderboardType, seasonId);
    
    const [rank, score] = await Promise.all([
      this.redis.zrevrank(key, playerId.toString()),
      this.redis.zscore(key, playerId.toString())
    ]);
    
    return {
      rank: rank !== null ? rank + 1 : null,
      score: score ? parseInt(score) : 0
    };
  }

  /**
   * 获取排行榜前 N 名
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {number} limit
   * @returns {Promise<Array<{rank: number, playerId: number, score: number}>>}
   */
  async getTopPlayers(leaderboardType, seasonId, limit = 100) {
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
    
    return players;
  }

  /**
   * 获取玩家附近排名
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {number} playerId
   * @param {number} range
   * @returns {Promise<Array<{rank: number, playerId: number, score: number}>>}
   */
  async getPlayersAround(leaderboardType, seasonId, playerId, range = 5) {
    const key = this.getKey(leaderboardType, seasonId);
    
    const playerRank = await this.redis.zrevrank(key, playerId.toString());
    if (playerRank === null) return [];
    
    const start = Math.max(0, playerRank - range);
    const end = playerRank + range;
    
    const results = await this.redis.zrevrange(key, start, end, 'WITHSCORES');
    
    const players = [];
    for (let i = 0; i < results.length; i += 2) {
      players.push({
        rank: start + Math.floor(i / 2) + 1,
        playerId: parseInt(results[i]),
        score: parseInt(results[i + 1])
      });
    }
    
    return players;
  }

  /**
   * 批量同步数据库到 Redis
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @param {Array<{playerId: number, score: number}>} players
   */
  async syncFromDatabase(leaderboardType, seasonId, players) {
    const key = this.getKey(leaderboardType, seasonId);
    
    const pipeline = this.redis.pipeline();
    
    for (const player of players) {
      pipeline.zadd(key, player.score, player.playerId.toString());
    }
    
    await pipeline.exec();
    await this.redis.expire(key, 7 * 24 * 60 * 60);
  }

  /**
   * 获取排行榜总人数
   * @param {string} leaderboardType
   * @param {number} seasonId
   * @returns {Promise<number>}
   */
  async getTotalCount(leaderboardType, seasonId) {
    const key = this.getKey(leaderboardType, seasonId);
    return await this.redis.zcard(key);
  }

  /**
   * 清除排行榜缓存
   * @param {string} leaderboardType
   * @param {number} seasonId
   */
  async clear(leaderboardType, seasonId) {
    const key = this.getKey(leaderboardType, seasonId);
    await this.redis.del(key);
  }
}

module.exports = LeaderboardCache;