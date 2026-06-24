const db = require('@pmg/shared/db');
const { createLogger } = require('@pmg/shared/logger');
const cron = require('node-cron');
const RankManager = require('./RankManager');

const logger = createLogger('season-manager');

// 赛季段位配置
const TIER_CONFIG = {
  bronze: { name: '青铜', minPoints: 0, maxPoints: 999, level: 1 },
  silver: { name: '白银', minPoints: 1000, maxPoints: 1999, level: 2 },
  gold: { name: '黄金', minPoints: 2000, maxPoints: 2999, level: 3 },
  platinum: { name: '铂金', minPoints: 3000, maxPoints: 3999, level: 4 },
  diamond: { name: '钻石', minPoints: 4000, maxPoints: 4999, level: 5 },
  master: { name: '大师', minPoints: 5000, maxPoints: 6999, level: 6 },
  grandmaster: { name: '宗师', minPoints: 7000, maxPoints: 999999, level: 7 }
};

class SeasonManager {
  constructor() {
    this.initializeCronJobs();
  }
  
  // 初始化定时任务
  initializeCronJobs() {
    // 每小时检查赛季状态
    cron.schedule('0 * * * *', () => this.checkSeasonTransition());
    
    // 每天凌晨3点处理段位衰减
    cron.schedule('0 3 * * *', () => this.processRankDecay());
    
    // 每周一早上6点创建周赛
    cron.schedule('0 6 * * 1', () => this.createWeeklyTournament());
  }
  
  // 获取当前赛季
  async getCurrentSeason() {
    const result = await db.query(
      `SELECT * FROM seasons WHERE status = 'active' ORDER BY start_time DESC LIMIT 1`
    );
    return result.rows[0] || null;
  }
  
  // 创建新赛季
  async createSeason(config) {
    const { name, duration, rewards } = config;
    
    // 结束当前赛季
    await this.endCurrentSeason();
    
    // 创建新赛季
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + duration * 24 * 60 * 60 * 1000);
    
    const result = await db.query(
      `INSERT INTO seasons (season_number, name, start_time, end_time, status, config, rewards)
       SELECT COALESCE(MAX(season_number), 0) + 1, $1, $2, $3, 'active', $4, $5
       FROM seasons
       RETURNING *`,
      [name, startTime, endTime, JSON.stringify(config), JSON.stringify(rewards)]
    );
    
    const season = result.rows[0];
    
    logger.info('New season created', { seasonId: season.id, name: season.name });
    
    // 创建赛季锦标赛
    await this.createSeasonTournaments(season.id);
    
    return season;
  }
  
  // 结束当前赛季
  async endCurrentSeason() {
    const currentSeason = await this.getCurrentSeason();
    
    if (!currentSeason) return;
    
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 更新赛季状态
      await client.query(
        `UPDATE seasons SET status = 'ended', updated_at = NOW() WHERE id = $1`,
        [currentSeason.id]
      );
      
      // 计算并发放赛季奖励
      await this.distributeSeasonRewards(client, currentSeason.id);
      
      // 重置玩家段位（保留部分积分）
      await this.resetPlayerRanks(client, currentSeason.id);
      
      await client.query('COMMIT');
      
      logger.info('Season ended', { seasonId: currentSeason.id });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 发放赛季奖励
  async distributeSeasonRewards(client, seasonId) {
    // 获取所有玩家最终段位
    const ranks = await client.query(
      `SELECT pr.*, u.username
       FROM player_ranks pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.season_id = $1
       ORDER BY pr.rank_points DESC`,
      [seasonId]
    );
    
    const season = await client.query(
      `SELECT * FROM seasons WHERE id = $1`,
      [seasonId]
    );
    
    const rewards = season.rows[0].rewards || {};
    
    for (let i = 0; i < ranks.rows.length; i++) {
      const rank = ranks.rows[i];
      const finalRank = i + 1;
      
      // 根据段位和排名计算奖励
      const tierRewards = rewards[rank.tier] || {};
      const rankRewards = finalRank <= 100 ? rewards.top100?.[finalRank] || {} : {};
      
      const finalRewards = {
        coins: (tierRewards.coins || 0) + (rankRewards.coins || 0),
        items: [...(tierRewards.items || []), ...(rankRewards.items || [])],
        title: finalRank <= 10 ? `Season ${season.rows[0].season_number} Top ${finalRank}` : null,
        avatarFrame: finalRank <= 100 ? `season_${season.rows[0].season_number}_top${finalRank <= 10 ? '10' : '100'}` : null
      };
      
      await client.query(
        `INSERT INTO season_rewards (user_id, season_id, tier, final_rank, rewards)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, season_id) DO UPDATE SET rewards = $5`,
        [rank.user_id, seasonId, rank.tier, finalRank, JSON.stringify(finalRewards)]
      );
    }
    
    logger.info('Season rewards distributed', { seasonId, playerCount: ranks.rows.length });
  }
  
  // 重置玩家段位
  async resetPlayerRanks(client, seasonId) {
    // 软重置：保留部分积分（最高段位的玩家保留更多）
    await client.query(
      `UPDATE player_ranks 
       SET rank_points = FLOOR(rank_points * 0.25),
           tier = 'bronze',
           tier_level = 5,
           wins = 0,
           losses = 0,
           win_streak = 0,
           placement_done = false,
           placement_matches = 0,
           updated_at = NOW()
       WHERE season_id = $1`,
      [seasonId]
    );
  }
  
  // 检查赛季过渡
  async checkSeasonTransition() {
    const currentSeason = await this.getCurrentSeason();
    
    if (!currentSeason) {
      // 没有活跃赛季，创建新的
      await this.createSeason({
        name: `Season ${await this.getNextSeasonNumber()}`,
        duration: 30, // 30天
        rewards: this.getDefaultRewards()
      });
      return;
    }
    
    // 检查是否到期
    if (new Date() >= new Date(currentSeason.end_time)) {
      await this.endCurrentSeason();
      await this.createSeason({
        name: `Season ${await this.getNextSeasonNumber()}`,
        duration: 30,
        rewards: this.getDefaultRewards()
      });
    }
  }
  
  // 处理段位衰减
  async processRankDecay() {
    const currentSeason = await this.getCurrentSeason();
    if (!currentSeason) return;
    
    // 获取需要衰减的玩家
    const result = await db.query(
      `SELECT user_id FROM player_ranks 
       WHERE season_id = $1 
         AND tier IN ('diamond', 'master', 'grandmaster')
         AND last_match_at < NOW() - INTERVAL '7 days'`,
      [currentSeason.id]
    );
    
    for (const row of result.rows) {
      await RankManager.applyDecay(row.user_id, currentSeason.id);
    }
    
    logger.info('Rank decay processed', { count: result.rows.length });
  }
  
  // 获取下一个赛季编号
  async getNextSeasonNumber() {
    const result = await db.query(
      `SELECT COALESCE(MAX(season_number), 0) + 1 as next FROM seasons`
    );
    return result.rows[0].next;
  }
  
  // 获取默认奖励
  getDefaultRewards() {
    return {
      bronze: { coins: 100, items: [{ type: 'bronze_pack', quantity: 1 }] },
      silver: { coins: 200, items: [{ type: 'silver_pack', quantity: 1 }] },
      gold: { coins: 400, items: [{ type: 'gold_pack', quantity: 1 }] },
      platinum: { coins: 600, items: [{ type: 'platinum_pack', quantity: 1 }] },
      diamond: { coins: 1000, items: [{ type: 'diamond_pack', quantity: 1 }] },
      master: { coins: 2000, items: [{ type: 'master_pack', quantity: 1 }] },
      grandmaster: { coins: 5000, items: [{ type: 'grandmaster_pack', quantity: 1 }] },
      top100: {
        1: { coins: 10000, items: [{ type: 'champion_pack', quantity: 1 }] },
        2: { coins: 8000, items: [{ type: 'runner_up_pack', quantity: 1 }] },
        3: { coins: 6000, items: [{ type: 'third_place_pack', quantity: 1 }] }
      }
    };
  }
  
  // 创建赛季锦标赛
  async createSeasonTournaments(seasonId) {
    const seasonResult = await db.query(`SELECT * FROM seasons WHERE id = $1`, [seasonId]);
    const seasonNumber = seasonResult.rows[0].season_number;
    
    // 创建每日锦标赛
    await db.query(
      `INSERT INTO tournaments (season_id, name, type, format, max_participants, 
                               registration_start, registration_end, start_time, status, rewards)
       VALUES ($1, $2, 'daily', 'elimination', 32, 
               NOW(), NOW() + INTERVAL '23 hours', NOW() + INTERVAL '24 hours', 'registration', $3)`,
      [seasonId, `Daily Cup #${seasonNumber}`, JSON.stringify({ coins: 500, items: [] })]
    );
    
    logger.info('Season tournaments created', { seasonId });
  }
  
  // 创建周赛
  async createWeeklyTournament() {
    const currentSeason = await this.getCurrentSeason();
    if (!currentSeason) return;
    
    await db.query(
      `INSERT INTO tournaments (season_id, name, type, format, max_participants, min_tier,
                               registration_start, registration_end, start_time, status, rewards)
       VALUES ($1, $2, 'weekly', 'elimination', 64, 'gold',
               NOW(), NOW() + INTERVAL '6 days', NOW() + INTERVAL '7 days', 'registration', $3)`,
      [currentSeason.id, `Weekly Championship`, JSON.stringify({ coins: 2000, items: [{ type: 'rare_pack', quantity: 1 }] })]
    );
    
    logger.info('Weekly tournament created');
  }
  
  // 领取赛季奖励
  async claimSeasonRewards(userId, seasonId) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `SELECT * FROM season_rewards 
         WHERE user_id = $1 AND season_id = $2 AND status = 'pending'
         FOR UPDATE`,
        [userId, seasonId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('NO_REWARDS_TO_CLAIM');
      }
      
      const reward = result.rows[0];
      
      // 发放奖励 (Mock: 直接给金币，或者更新 users 表)
      const rewardsConfig = typeof reward.rewards === 'string' ? JSON.parse(reward.rewards) : reward.rewards;
      if (rewardsConfig.coins) {
        await client.query(`UPDATE users SET gold_count = gold_count + $1 WHERE id = $2`, [rewardsConfig.coins, userId]);
      }
      
      // 更新状态
      await client.query(
        `UPDATE season_rewards SET status = 'claimed', claimed_at = NOW() 
         WHERE user_id = $1 AND season_id = $2`,
        [userId, seasonId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Season rewards claimed', { userId, seasonId });
      
      return reward.rewards;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 获取赛季历史
  async getSeasonHistory(userId, limit = 5) {
    const result = await db.query(
      `SELECT s.*, sr.tier, sr.final_rank, sr.rewards, sr.status as reward_status
       FROM seasons s
       LEFT JOIN season_rewards sr ON s.id = sr.season_id AND sr.user_id = $1
       ORDER BY s.start_time DESC
       LIMIT $2`,
      [userId, limit]
    );
    
    return result.rows;
  }
}

module.exports = new SeasonManager();
