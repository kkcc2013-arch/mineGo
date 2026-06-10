/**
 * 排行榜服务
 * 
 * REQ-00074: 玩家排行榜系统
 * 
 * 功能：
 * - 多维度排行榜管理
 * - 赛季机制
 * - 实时排名更新
 * - 奖励发放
 */

const { Pool } = require('pg');
const LeaderboardCache = require('../../shared/leaderboardCache');
const { getRedisClient } = require('../../shared/redis');
const { publishEvent } = require('../../shared/EventBus');
const { logger } = require('../../shared/logger');
const { 
  leaderboardUpdateTotal,
  leaderboardQueryLatency,
  leaderboardPlayersCount,
  seasonEndTotal,
  rankChangeNotifications
} = require('./metrics');

// 有效的排行榜类型
const VALID_LEADERBOARD_TYPES = [
  'catch_total',
  'catch_rare',
  'battle_pvp',
  'battle_gym',
  'pokedex_completion',
  'shiny_collection',
  'guild_contribution'
];

class LeaderboardService {
  constructor(db = null, redisClient = null) {
    this.db = db || new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = redisClient || getRedisClient();
    this.cache = new LeaderboardCache(this.redis);
  }

  /**
   * 验证排行榜类型
   */
  isValidType(type) {
    return VALID_LEADERBOARD_TYPES.includes(type);
  }

  /**
   * 获取当前赛季
   */
  async getCurrentSeason(leaderboardType) {
    const result = await this.db.query(`
      SELECT * FROM seasons 
      WHERE leaderboard_type = $1 
        AND status = 'active' 
        AND start_time <= NOW() 
        AND end_time > NOW()
      ORDER BY start_time DESC
      LIMIT 1
    `, [leaderboardType]);
    
    return result.rows[0] || null;
  }

  /**
   * 根据 ID 获取赛季
   */
  async getSeasonById(seasonId) {
    const result = await this.db.query(`
      SELECT * FROM seasons WHERE id = $1
    `, [seasonId]);
    
    return result.rows[0] || null;
  }

  /**
   * 更新玩家分数（捕捉触发）
   */
  async onCatchEvent(userId, rarity, pokemonId = null) {
    try {
      // 更新捕捉总数榜
      const totalSeason = await this.getCurrentSeason('catch_total');
      if (totalSeason) {
        const totalResult = await this.cache.incrementScore(
          'catch_total',
          totalSeason.id,
          userId,
          1
        );

        await this.syncToDatabase('catch_total', totalSeason.id, userId, totalResult.score);
        await this.checkRankChange(userId, 'catch_total', totalResult.rank, totalSeason.id);
        
        leaderboardUpdateTotal.inc({ type: 'catch_total' });
      }

      // 更新稀有捕捉榜
      if (rarity === 'rare' || rarity === 'legendary' || rarity === 'mythical') {
        const rareSeason = await this.getCurrentSeason('catch_rare');
        if (rareSeason) {
          const points = rarity === 'mythical' ? 50 : (rarity === 'legendary' ? 10 : 1);
          const rareResult = await this.cache.incrementScore(
            'catch_rare',
            rareSeason.id,
            userId,
            points
          );

          await this.syncToDatabase('catch_rare', rareSeason.id, userId, rareResult.score);
          await this.checkRankChange(userId, 'catch_rare', rareResult.rank, rareSeason.id);
          
          leaderboardUpdateTotal.inc({ type: 'catch_rare' });
        }
      }

      logger.info('LeaderboardService.onCatchEvent', { userId, rarity, pokemonId });
    } catch (error) {
      logger.error('LeaderboardService.onCatchEvent error', { error: error.message, userId, rarity });
    }
  }

  /**
   * 更新战斗积分
   */
  async onBattleResult(userId, isWin, points, battleType = 'pvp') {
    try {
      const leaderboardType = battleType === 'pvp' ? 'battle_pvp' : 'battle_gym';
      const season = await this.getCurrentSeason(leaderboardType);
      
      if (!season) return;

      const scoreChange = isWin ? points : -Math.floor(points * 0.3);
      const result = await this.cache.incrementScore(
        leaderboardType,
        season.id,
        userId,
        scoreChange
      );

      await this.syncToDatabase(leaderboardType, season.id, userId, result.score);
      await this.checkRankChange(userId, leaderboardType, result.rank, season.id);
      
      leaderboardUpdateTotal.inc({ type: leaderboardType });
      
      logger.info('LeaderboardService.onBattleResult', { userId, isWin, points, battleType });
    } catch (error) {
      logger.error('LeaderboardService.onBattleResult error', { error: error.message, userId, battleType });
    }
  }

  /**
   * 更新图鉴完成度
   */
  async onPokedexUpdate(userId, completionRate, totalCaught) {
    try {
      const season = await this.getCurrentSeason('pokedex_completion');
      if (!season) return;

      const score = Math.floor(completionRate * 1000) + totalCaught;
      const rank = await this.cache.updateScore(
        'pokedex_completion',
        season.id,
        userId,
        score
      );

      await this.syncToDatabase('pokedex_completion', season.id, userId, score);
      await this.checkRankChange(userId, 'pokedex_completion', rank, season.id);
      
      leaderboardUpdateTotal.inc({ type: 'pokedex_completion' });
    } catch (error) {
      logger.error('LeaderboardService.onPokedexUpdate error', { error: error.message, userId });
    }
  }

  /**
   * 更新闪光收集
   */
  async onShinyCatch(userId) {
    try {
      const season = await this.getCurrentSeason('shiny_collection');
      if (!season) return;

      const result = await this.cache.incrementScore(
        'shiny_collection',
        season.id,
        userId,
        1
      );

      await this.syncToDatabase('shiny_collection', season.id, userId, result.score);
      await this.checkRankChange(userId, 'shiny_collection', result.rank, season.id);
      
      leaderboardUpdateTotal.inc({ type: 'shiny_collection' });
    } catch (error) {
      logger.error('LeaderboardService.onShinyCatch error', { error: error.message, userId });
    }
  }

  /**
   * 检查排名变化并通知
   */
  async checkRankChange(userId, leaderboardType, newRank, seasonId) {
    if (!newRank) return;

    const key = `rank_change:${leaderboardType}:${seasonId}:${userId}`;
    const oldRank = await this.redis.get(key);
    
    if (oldRank && parseInt(oldRank) !== newRank) {
      const change = parseInt(oldRank) - newRank;
      
      if (change > 0 && newRank <= 100) {
        // 排名上升且进入前 100，发送通知
        await publishEvent('leaderboard.rank_up', {
          userId,
          leaderboardType,
          oldRank: parseInt(oldRank),
          newRank,
          change,
          seasonId
        });
        
        rankChangeNotifications.inc({ type: leaderboardType, direction: 'up' });
      } else if (change < 0) {
        rankChangeNotifications.inc({ type: leaderboardType, direction: 'down' });
      }
    }
    
    await this.redis.setex(key, 3600, newRank.toString());
  }

  /**
   * 同步到数据库
   */
  async syncToDatabase(leaderboardType, seasonId, userId, score) {
    await this.db.query(`
      INSERT INTO leaderboards (leaderboard_type, season_id, player_id, score, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (leaderboard_type, season_id, player_id)
      DO UPDATE SET score = $4, updated_at = NOW()
    `, [leaderboardType, seasonId, userId, score]);
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(leaderboardType, options = {}) {
    const end = leaderboardQueryLatency.startTimer({ type: leaderboardType });
    
    try {
      const {
        limit = 100,
        aroundPlayer = null,
        seasonId = null
      } = options;

      const season = seasonId
        ? await this.getSeasonById(seasonId)
        : await this.getCurrentSeason(leaderboardType);

      if (!season) {
        throw new Error('No active season found');
      }

      let players;
      if (aroundPlayer) {
        players = await this.cache.getPlayersAround(
          leaderboardType,
          season.id,
          aroundPlayer,
          5
        );
      } else {
        players = await this.cache.getTopPlayers(
          leaderboardType,
          season.id,
          limit
        );
      }

      // 批量获取玩家信息
      const playerIds = players.map(p => p.playerId);
      const userInfo = await this.getUserInfoBatch(playerIds);

      // 更新 Prometheus 指标
      const totalPlayers = await this.cache.getTotalPlayers(leaderboardType, season.id);
      leaderboardPlayersCount.set({ type: leaderboardType, season_id: season.id }, totalPlayers);

      return {
        season,
        players: players.map(p => ({
          ...p,
          ...userInfo[p.playerId]
        })),
        totalPlayers
      };
    } finally {
      end();
    }
  }

  /**
   * 获取玩家排名
   */
  async getPlayerRankInfo(leaderboardType, userId) {
    const season = await this.getCurrentSeason(leaderboardType);
    if (!season) {
      return { season: null, rank: null, score: 0 };
    }

    const rankInfo = await this.cache.getPlayerRank(
      leaderboardType,
      season.id,
      userId
    );

    return {
      season,
      ...rankInfo
    };
  }

  /**
   * 批量获取用户信息
   */
  async getUserInfoBatch(userIds) {
    if (userIds.length === 0) return {};
    
    const result = await this.db.query(`
      SELECT id, username, avatar, level
      FROM users
      WHERE id = ANY($1)
    `, [userIds]);
    
    const infoMap = {};
    for (const row of result.rows) {
      infoMap[row.id] = {
        username: row.username,
        avatar: row.avatar,
        level: row.level
      };
    }
    
    return infoMap;
  }

  /**
   * 获取赛季历史
   */
  async getSeasonHistory(leaderboardType, limit = 10) {
    const result = await this.db.query(`
      SELECT * FROM seasons
      WHERE leaderboard_type = $1
      ORDER BY start_time DESC
      LIMIT $2
    `, [leaderboardType, limit]);

    return result.rows;
  }

  /**
   * 结算赛季
   */
  async settleSeason(seasonId) {
    const season = await this.getSeasonById(seasonId);
    if (!season) throw new Error('Season not found');

    logger.info('LeaderboardService.settleSeason start', { seasonId, type: season.leaderboard_type });

    // 获取最终排名
    const topPlayers = await this.cache.getTopPlayers(
      season.leaderboard_type,
      seasonId,
      1000
    );

    // 保存历史记录
    for (const player of topPlayers) {
      await this.db.query(`
        INSERT INTO leaderboard_history 
          (season_id, player_id, leaderboard_type, final_rank, final_score)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [seasonId, player.playerId, season.leaderboard_type, player.rank, player.score]);
    }

    // 更新赛季状态
    await this.db.query(`
      UPDATE seasons SET status = 'ended' WHERE id = $1
    `, [seasonId]);

    // 发送赛季结算通知
    await publishEvent('leaderboard.season_end', {
      seasonId,
      leaderboardType: season.leaderboard_type,
      topPlayers: topPlayers.slice(0, 100)
    });

    seasonEndTotal.inc({ type: season.leaderboard_type });
    
    logger.info('LeaderboardService.settleSeason completed', { seasonId, playerCount: topPlayers.length });
  }

  /**
   * 领取赛季奖励
   */
  async claimSeasonRewards(seasonId, userId) {
    // 检查是否已领取
    const historyResult = await this.db.query(`
      SELECT * FROM leaderboard_history
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, userId]);

    if (historyResult.rows.length === 0) {
      throw new Error('No record found for this season');
    }

    const record = historyResult.rows[0];
    if (record.rewards_claimed) {
      throw new Error('Rewards already claimed');
    }

    // 获取赛季奖励配置
    const season = await this.getSeasonById(seasonId);
    const rewards = season.rewards[record.final_rank - 1];

    if (!rewards) {
      throw new Error('No rewards for this rank');
    }

    // 发放奖励
    await publishEvent('leaderboard.claim_rewards', {
      userId,
      rewards,
      seasonId,
      rank: record.final_rank
    });

    // 更新领取状态
    await this.db.query(`
      UPDATE leaderboard_history
      SET rewards_claimed = TRUE, rewards_claimed_at = NOW()
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, userId]);

    return { rewards, rank: record.final_rank };
  }

  /**
   * 创建每日排名快照
   */
  async createDailySnapshot() {
    const types = VALID_LEADERBOARD_TYPES;
    const today = new Date().toISOString().split('T')[0];

    for (const type of types) {
      try {
        const season = await this.getCurrentSeason(type);
        if (!season) continue;

        const topPlayers = await this.cache.getTopPlayers(type, season.id, 1000);

        for (const player of topPlayers) {
          await this.db.query(`
            INSERT INTO leaderboard_snapshots 
              (leaderboard_type, season_id, player_id, rank, score, snapshot_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (leaderboard_type, season_id, player_id, snapshot_date) DO NOTHING
          `, [type, season.id, player.playerId, player.rank, player.score, today]);
        }

        logger.info('LeaderboardService.createDailySnapshot', { type, date: today, count: topPlayers.length });
      } catch (error) {
        logger.error('LeaderboardService.createDailySnapshot error', { error: error.message, type });
      }
    }
  }

  /**
   * 同步所有排行榜到数据库
   */
  async syncAllToDatabase() {
    const types = VALID_LEADERBOARD_TYPES;

    for (const type of types) {
      try {
        const season = await this.getCurrentSeason(type);
        if (!season) continue;

        const topPlayers = await this.cache.getTopPlayers(type, season.id, 1000);

        for (const player of topPlayers) {
          await this.syncToDatabase(type, season.id, player.playerId, player.score);
        }

        logger.info('LeaderboardService.syncAllToDatabase', { type, count: topPlayers.length });
      } catch (error) {
        logger.error('LeaderboardService.syncAllToDatabase error', { error: error.message, type });
      }
    }
  }
}

module.exports = LeaderboardService;
module.exports.VALID_LEADERBOARD_TYPES = VALID_LEADERBOARD_TYPES;
