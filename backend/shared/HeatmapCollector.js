/**
 * 热力图收集器
 * 实时追踪各区域活跃玩家数
 *
 * @module HeatmapCollector
 */

class HeatmapCollector {
  constructor(config) {
    this.redis = config.redis;
    this.db = config.db;
    this.logger = config.logger || console;
    this.metrics = config.metrics || null;

    // 玩家活跃超时（5分钟无活动视为不活跃）
    this.playerTimeout = config.playerTimeout || 5 * 60 * 1000;

    // 统计写入间隔（每小时写入数据库）
    this.statsWriteInterval = config.statsWriteInterval || 60 * 60 * 1000;

    this.statsLoopInterval = null;
  }

  /**
   * 启动统计写入循环
   */
  start() {
    if (this.statsLoopInterval) {
      clearInterval(this.statsLoopInterval);
    }

    this.statsLoopInterval = setInterval(async () => {
      try {
        await this.writeHourlyStats();
      } catch (error) {
        this.logger.error('Hourly stats write error:', error);
      }
    }, this.statsWriteInterval);

    this.logger.info('Heatmap collector started');
  }

  /**
   * 停止循环
   */
  stop() {
    if (this.statsLoopInterval) {
      clearInterval(this.statsLoopInterval);
      this.statsLoopInterval = null;
    }
    this.logger.info('Heatmap collector stopped');
  }

  /**
   * 更新区域热度
   * 当玩家移动时调用
   */
  async updateCellHeat(geohash, playerId) {
    const key = `heatmap:cell:${geohash}`;
    const now = Date.now();

    try {
      // 添加玩家到活跃集合
      await this.redis.zadd(key, now, playerId);

      // 清理过期玩家（5分钟无活动）
      const expireTime = now - this.playerTimeout;
      await this.redis.zremrangebyscore(key, '-inf', expireTime);

      // 获取活跃玩家数
      const activePlayers = await this.redis.zcard(key);

      // 存储聚合数据
      await this.redis.hset(
        `heatmap:stats:${geohash}`,
        'activePlayers', activePlayers,
        'lastUpdate', now
      );

      // 更新指标
      if (this.metrics) {
        this.metrics.cellHeat.set(
          { geohash_prefix: geohash.substring(0, 4) },
          activePlayers
        );
      }

      return activePlayers;
    } catch (error) {
      this.logger.error('Error updating cell heat:', error);
      throw error;
    }
  }

  /**
   * 获取区域热度
   */
  async getHeatmap(geohash) {
    const stats = await this.redis.hgetall(`heatmap:stats:${geohash}`);
    return {
      activePlayers: parseInt(stats.activePlayers || 0),
      lastUpdate: parseInt(stats.lastUpdate || 0)
    };
  }

  /**
   * 获取全局热力图
   */
  async getGlobalHeatmap() {
    const keys = await this.redis.keys('heatmap:stats:*');
    const heatmap = {};

    for (const key of keys) {
      const geohash = key.split(':').pop();
      const stats = await this.redis.hgetall(key);
      heatmap[geohash] = {
        activePlayers: parseInt(stats.activePlayers || 0),
        lastUpdate: parseInt(stats.lastUpdate || 0)
      };
    }

    return heatmap;
  }

  /**
   * 获取热门区域（按活跃玩家数排序）
   */
  async getHotAreas(limit = 10) {
    const heatmap = await this.getGlobalHeatmap();

    const sorted = Object.entries(heatmap)
      .map(([geohash, data]) => ({
        geohash,
        ...data
      }))
      .sort((a, b) => b.activePlayers - a.activePlayers)
      .slice(0, limit);

    return sorted;
  }

  /**
   * 移除玩家热度
   * 当玩家退出游戏时调用
   */
  async removePlayerHeat(playerId, geohash) {
    if (geohash) {
      await this.redis.zrem(`heatmap:cell:${geohash}`, playerId);
    } else {
      // 从所有区域移除
      const keys = await this.redis.keys('heatmap:cell:*');
      for (const key of keys) {
        await this.redis.zrem(key, playerId);
      }
    }
  }

  /**
   * 写入每小时统计数据
   */
  async writeHourlyStats() {
    const now = new Date();
    const hour = now.getHours();
    const date = now.toISOString().split('T')[0];

    const heatmap = await this.getGlobalHeatmap();

    for (const [geohash, data] of Object.entries(heatmap)) {
      try {
        // 检查是否已存在
        const existing = await this.db.query(
          'SELECT id FROM spawn_statistics WHERE geohash = $1 AND date = $2 AND hour = $3',
          [geohash, date, hour]
        );

        if (existing.rows.length > 0) {
          // 更新
          await this.db.query(
            `UPDATE spawn_statistics
             SET avg_active_players = $1,
                 updated_at = NOW()
             WHERE geohash = $2 AND date = $3 AND hour = $4`,
            [data.activePlayers, geohash, date, hour]
          );
        } else {
          // 插入
          await this.db.query(
            `INSERT INTO spawn_statistics
              (geohash, date, hour, avg_active_players)
             VALUES ($1, $2, $3, $4)`,
            [geohash, date, hour, data.activePlayers]
          );
        }
      } catch (error) {
        this.logger.error(`Error writing stats for ${geohash}:`, error);
      }
    }

    this.logger.info(`Wrote hourly stats for ${Object.keys(heatmap).length} cells`);
  }

  /**
   * 获取区域历史热度
   */
  async getHeatmapHistory(geohash, days = 7) {
    const result = await this.db.query(
      `SELECT date, hour, avg_active_players
       FROM spawn_statistics
       WHERE geohash = $1
         AND date >= NOW() - INTERVAL '${days} days'
       ORDER BY date DESC, hour DESC`,
      [geohash]
    );

    return result.rows;
  }

  /**
   * 分析玩家分布模式
   */
  async analyzePlayerDistribution() {
    const heatmap = await this.getGlobalHeatmap();

    const totalPlayers = Object.values(heatmap)
      .reduce((sum, data) => sum + data.activePlayers, 0);

    const totalCells = Object.keys(heatmap).length;
    const avgPlayersPerCell = totalCells > 0 ? totalPlayers / totalCells : 0;

    const hotspots = await this.getHotAreas(5);
    const coldspots = Object.entries(heatmap)
      .filter(([_, data]) => data.activePlayers === 0)
      .map(([geohash]) => geohash);

    return {
      totalActivePlayers: totalPlayers,
      totalActiveCells: totalCells,
      avgPlayersPerCell,
      hotspots,
      coldspots,
      distribution: {
        dense: Object.values(heatmap).filter(d => d.activePlayers > 20).length,
        normal: Object.values(heatmap).filter(d => d.activePlayers > 5 && d.activePlayers <= 20).length,
        sparse: Object.values(heatmap).filter(d => d.activePlayers > 0 && d.activePlayers <= 5).length,
        empty: coldspots.length
      }
    };
  }

  /**
   * 预测峰值时段
   */
  async predictPeakHours(geohash) {
    const history = await this.getHeatmapHistory(geohash, 30);

    if (history.length === 0) {
      return null;
    }

    // 按小时聚合
    const hourlyAvg = {};
    for (const row of history) {
      if (!hourlyAvg[row.hour]) {
        hourlyAvg[row.hour] = { total: 0, count: 0 };
      }
      hourlyAvg[row.hour].total += parseFloat(row.avg_active_players || 0);
      hourlyAvg[row.hour].count++;
    }

    // 计算每小时平均
    const peakPrediction = Object.entries(hourlyAvg)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        avgPlayers: data.total / data.count
      }))
      .sort((a, b) => b.avgPlayers - a.avgPlayers);

    return {
      peakHours: peakPrediction.slice(0, 3),
      lowHours: peakPrediction.slice(-3).reverse(),
      hourlyData: peakPrediction.sort((a, b) => a.hour - b.hour)
    };
  }
}

module.exports = HeatmapCollector;
