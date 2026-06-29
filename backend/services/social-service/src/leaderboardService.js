/**
 * LeaderboardService - 玩家排行榜服务
 * 支持多维度排名、实时更新、赛季机制
 */

const { Pool } = require('pg');
const LeaderboardCache = require('../../../shared/leaderboardCache');
const { getRedisClient } = require('../../../shared/redis');
const { publishEvent } = require('../../../shared/EventBus');
const logger = require('../../../shared/logger');

const VALID_TYPES = [
  'catch_total', 'catch_rare', 'battle_pvp', 'battle_gym',
  'pokedex_completion', 'shiny_collection', 'guild_contribution'
];

class LeaderboardService {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.cache = new LeaderboardCache(getRedisClient());
  }

  /**
   * 验证排行榜类型
   */
  isValidType(type) {
    return VALID_TYPES.includes(type);
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
   * 获取赛季信息
   */
  async getSeasonById(seasonId) {
    const result = await this.db.query(`
      SELECT * FROM seasons WHERE id = $1
    `, [seasonId]);
    
    return result.rows[0] || null;
  }

  /**
   * 处理捕捉事件
   */
  async onCatchEvent(userId, rarity) {
    try {
      // 更新捕捉总数榜
      const totalSeason = await this.getCurrentSeason('catch_total');
      if (totalSeason) {
        const result = await this.cache.incrementScore(
          'catch_total', 
          totalSeason.id, 
          userId, 
          1
        );
        await this.syncToDatabase('catch_total', totalSeason.id, userId, result.score);
        await this.checkRankChange(userId, 'catch_total', result.rank);
      }

      // 更新稀有捕捉榜
      if (rarity === 'rare' || rarity === 'legendary' || rarity === 'mythic') {
        const rareSeason = await this.getCurrentSeason('catch_rare');
        if (rareSeason) {
          const points = this.getRarePoints(rarity);
          const result = await this.cache.incrementScore(
            'catch_rare',
            rareSeason.id,
            userId,
            points
          );
          await this.syncToDatabase('catch_rare', rareSeason.id, userId, result.score);
        }
      }
    } catch (error) {
      logger.error('[Leaderboard] Catch event error:', error);
    }
  }

  /**
   * 处理战斗结果
   */
  async onBattleResult(userId, isWin, points) {
    try {
      const season = await this.getCurrentSeason('battle_pvp');
      if (!season) return;

      const delta = isWin ? points : -Math.floor(points * 0.3);
      const result = await this.cache.incrementScore(
        'battle_pvp',
        season.id,
        userId,
        delta
      );

      await this.syncToDatabase('battle_pvp', season.id, userId, result.score);
      await this.checkRankChange(userId, 'battle_pvp', result.rank);
    } catch (error) {
      logger.error('[Leaderboard] Battle result error:', error);
    }
  }

  /**
   * 处理道馆战斗
   */
  async onGymBattle(userId, isWin) {
    try {
      const season = await this.getCurrentSeason('battle_gym');
      if (!season) return;

      const points = isWin ? 10 : 1;
      const result = await this.cache.incrementScore(
        'battle_gym',
        season.id,
        userId,
        points
      );

      await this.syncToDatabase('battle_gym', season.id, userId, result.score);
    } catch (error) {
      logger.error('[Leaderboard] Gym battle error:', error);
    }
  }

  /**
   * 处理图鉴更新
   */
  async onPokedexUpdate(userId, completionRate) {
    try {
      const season = await this.getCurrentSeason('pokedex_completion');
      if (!season) return;

      const score = Math.floor(completionRate * 100);
      await this.cache.updateScore(
        'pokedex_completion',
        season.id,
        userId,
        score
      );

      await this.syncToDatabase('pokedex_completion', season.id, userId, score);
    } catch (error) {
      logger.error('[Leaderboard] Pokedex update error:', error);
    }
  }

  /**
   * 处理闪光捕捉
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
    } catch (error) {
      logger.error('[Leaderboard] Shiny catch error:', error);
    }
  }

  /**
   * 获取稀有度对应积分
   */
  getRarePoints(rarity) {
    const points = {
      rare: 1,
      legendary: 10,
      mythic: 50
    };
    return points[rarity] || 0;
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
   * 检查排名变化并通知
   */
  async checkRankChange(userId, leaderboardType, newRank) {
    if (!newRank || newRank > 100) return;

    const key = `rank_change:${leaderboardType}:${userId}`;
    const oldRankStr = await this.cache.redis.get(key);
    
    if (oldRankStr) {
      const oldRank = parseInt(oldRankStr);
      const change = oldRank - newRank;
      
      if (change > 0) {
        // 排名上升
        await publishEvent('leaderboard.rank_up', {
          userId,
          leaderboardType,
          oldRank,
          newRank,
          change
        });
        
        logger.info(`[Leaderboard] Player ${userId} rank up: ${oldRank} -> ${newRank}`);
      }
    }
    
    await this.cache.redis.setex(key, 3600, newRank.toString());
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(leaderboardType, options = {}) {
    const { limit = 100, aroundPlayer = null, seasonId = null } = options;

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

    return {
      season,
      players: players.map(p => ({
        ...p,
        ...userInfo[p.playerId]
      }))
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
   * 结算赛季
   */
  async settleSeason(seasonId) {
    const season = await this.getSeasonById(seasonId);
    if (!season) throw new Error('Season not found');

    logger.info(`[Leaderboard] Settling season ${seasonId} (${season.leaderboard_type})`);

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

    logger.info(`[Leaderboard] Season ${seasonId} settled, ${topPlayers.length} players recorded`);
    
    return { success: true, topPlayers: topPlayers.length };
  }

  /**
   * 领取赛季奖励
   */
  async claimSeasonRewards(seasonId, userId) {
    const history = await this.db.query(`
      SELECT lh.*, s.rewards 
      FROM leaderboard_history lh
      JOIN seasons s ON s.id = lh.season_id
      WHERE lh.season_id = $1 AND lh.player_id = $2
    `, [seasonId, userId]);

    if (history.rows.length === 0) {
      throw new Error('No record found for this season');
    }

    const record = history.rows[0];
    if (record.rewards_claimed) {
      throw new Error('Rewards already claimed');
    }

    // 获取对应排名的奖励
    const rewards = record.rewards[record.final_rank - 1];
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
   * 初始化赛季数据（从数据库同步到 Redis）
   */
  async initializeSeasonData(leaderboardType) {
    const season = await this.getCurrentSeason(leaderboardType);
    if (!season) return;

    const result = await this.db.query(`
      SELECT player_id, score 
      FROM leaderboards 
      WHERE leaderboard_type = $1 AND season_id = $2
      ORDER BY score DESC
      LIMIT 1000
    `, [leaderboardType, season.id]);

    if (result.rows.length > 0) {
      const players = result.rows.map(r => ({
        playerId: r.player_id,
        score: r.score
      }));

      await this.cache.syncFromDatabase(leaderboardType, season.id, players);
      logger.info(`[Leaderboard] Initialized ${players.length} players for ${leaderboardType}`);
    }
  }
}

module.exports = LeaderboardService;