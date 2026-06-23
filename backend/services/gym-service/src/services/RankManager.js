const db = require('@pmg/shared/db');
const { getRedis } = require('@pmg/shared/redis');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('rank-manager');

// 段位配置
const TIER_CONFIG = {
  bronze: { name: '青铜', minPoints: 0, maxPoints: 999, level: 1 },
  silver: { name: '白银', minPoints: 1000, maxPoints: 1999, level: 2 },
  gold: { name: '黄金', minPoints: 2000, maxPoints: 2999, level: 3 },
  platinum: { name: '铂金', minPoints: 3000, maxPoints: 3999, level: 4 },
  diamond: { name: '钻石', minPoints: 4000, maxPoints: 4999, level: 5 },
  master: { name: '大师', minPoints: 5000, maxPoints: 6999, level: 6 },
  grandmaster: { name: '宗师', minPoints: 7000, maxPoints: 999999, level: 7 }
};

// 积分配置
const POINTS_CONFIG = {
  win: 25,
  lose: -20,
  draw: 5,
  winStreakBonus: 5, // 每连胜额外加分
  maxWinStreakBonus: 25, // 最大连胜奖励
  placementWinBonus: 50, // 定位赛胜利加分
  decayDays: 7, // 多少天后开始衰减
  decayRate: 10, // 每天衰减积分
  tierProtectionMatches: 3 // 段位保护场次
};

class RankManager {
  // 获取玩家段位
  async getPlayerRank(userId, seasonId) {
    const result = await db.query(
      `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2`,
      [userId, seasonId]
    );
    
    if (result.rows.length === 0) {
      // 创建新玩家段位记录
      return await this.createPlayerRank(userId, seasonId);
    }
    
    return result.rows[0];
  }
  
  // 创建玩家段位记录
  async createPlayerRank(userId, seasonId) {
    const result = await db.query(
      `INSERT INTO player_ranks (user_id, season_id, tier, tier_level, rank_points)
       VALUES ($1, $2, 'bronze', 5, 0)
       RETURNING *`,
      [userId, seasonId]
    );
    
    logger.info('Player rank created', { userId, seasonId });
    return result.rows[0];
  }
  
  // 获取段位信息
  getTierInfo(tier, level) {
    const config = TIER_CONFIG[tier];
    if (!config) return null;
    
    return {
      tier,
      level,
      name: `${config.name}${this.getLevelRoman(level)}`,
      minPoints: config.minPoints,
      maxPoints: config.maxPoints,
      icon: `/assets/tiers/${tier}_${level}.png`,
      color: this.getTierColor(tier)
    };
  }
  
  // 获取升级进度
  getProgressToNextTier(rank) {
    const currentTier = TIER_CONFIG[rank.tier];
    const nextTier = this.getNextTier(rank.tier);
    
    if (!nextTier) {
      // 最高段位
      return { progress: 100, pointsToNext: 0, isMaxTier: true };
    }
    
    const pointsInTier = rank.rank_points - currentTier.minPoints;
    const tierRange = currentTier.maxPoints - currentTier.minPoints + 1;
    const progress = (pointsInTier / tierRange) * 100;
    
    return {
      progress: Math.min(progress, 100),
      pointsToNext: nextTier.minPoints - rank.rank_points,
      nextTier: nextTier.name,
      isMaxTier: false
    };
  }
  
  // 计算段位
  calculateTier(points) {
    for (const [tier, config] of Object.entries(TIER_CONFIG).reverse()) {
      if (points >= config.minPoints) {
        const level = this.calculateTierLevel(points, config);
        return { tier, level };
      }
    }
    return { tier: 'bronze', level: 5 };
  }
  
  // 计算段位等级
  calculateTierLevel(points, tierConfig) {
    const pointsInTier = points - tierConfig.minPoints;
    const rangePerLevel = (tierConfig.maxPoints - tierConfig.minPoints + 1) / 5;
    const level = 5 - Math.floor(pointsInTier / rangePerLevel);
    return Math.max(1, Math.min(5, level));
  }
  
  // 处理比赛结果
  async processMatchResult(userId, matchId, result, battleData) {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前赛季
      const seasonResult = await client.query(
        `SELECT * FROM seasons WHERE status = 'active' LIMIT 1`
      );
      
      if (seasonResult.rows.length === 0) {
        throw new Error('No active season');
      }
      
      const season = seasonResult.rows[0];
      
      // 获取玩家段位
      const rankResult = await client.query(
        `SELECT * FROM player_ranks WHERE user_id = $1 AND season_id = $2 FOR UPDATE`,
        [userId, season.id]
      );
      
      let rank = rankResult.rows[0];
      if (!rank) {
        rank = await this.createPlayerRank(userId, season.id);
      }
      
      // 计算积分变化
      let pointsChange = 0;
      let isPlacement = !rank.placement_done && rank.placement_matches < 10;
      
      if (result === 'win') {
        pointsChange = isPlacement 
          ? POINTS_CONFIG.placementWinBonus 
          : POINTS_CONFIG.win;
        
        // 连胜奖励
        if (!isPlacement && rank.win_streak > 0) {
          const streakBonus = Math.min(
            rank.win_streak * POINTS_CONFIG.winStreakBonus,
            POINTS_CONFIG.maxWinStreakBonus
          );
          pointsChange += streakBonus;
        }
      } else if (result === 'lose') {
        pointsChange = isPlacement ? 0 : POINTS_CONFIG.lose;
      } else {
        pointsChange = POINTS_CONFIG.draw;
      }
      
      // 更新段位
      const newPoints = Math.max(0, rank.rank_points + pointsChange);
      const { tier: newTier, level: newLevel } = this.calculateTier(newPoints);
      const tierChanged = newTier !== rank.tier;
      
      // 构建 TIER_CONFIG 的静态 values list 供 SQL 使用
      const staticValues = Object.entries(TIER_CONFIG).map(([t, c]) => `('${t}', ${c.level})`).join(',');
      
      // 更新数据库
      const updateResult = await client.query(
        `UPDATE player_ranks 
         SET rank_points = $1,
             tier = $2,
             tier_level = $3,
             wins = wins + CASE WHEN $4 = 'win' THEN 1 ELSE 0 END,
             losses = losses + CASE WHEN $4 = 'lose' THEN 1 ELSE 0 END,
             win_streak = CASE WHEN $4 = 'win' THEN win_streak + 1 ELSE 0 END,
             max_win_streak = GREATEST(max_win_streak, CASE WHEN $4 = 'win' THEN win_streak + 1 ELSE win_streak END),
             placement_matches = placement_matches + CASE WHEN $5 THEN 1 ELSE 0 END,
             placement_done = CASE WHEN $5 AND placement_matches >= 9 THEN true ELSE placement_done END,
             highest_tier = CASE WHEN $6 > (SELECT level FROM (VALUES ${staticValues}) AS t(tier, level) WHERE t.tier = highest_tier) THEN $7 ELSE highest_tier END,
             last_match_at = NOW(),
             updated_at = NOW()
         WHERE user_id = $8 AND season_id = $9
         RETURNING *`,
        [newPoints, newTier, newLevel, result, isPlacement, TIER_CONFIG[newTier].level, newTier, userId, season.id]
      );
      
      // 记录对战
      await client.query(
        `INSERT INTO battle_records 
         (season_id, attacker_id, defender_id, attacker_pokemon, defender_pokemon, 
          result, battle_type, rank_points_change, battle_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'ranked', $7, $8)`,
        [season.id, userId, battleData.opponentId, JSON.stringify(battleData.attackerPokemon), 
         JSON.stringify(battleData.defenderPokemon), result, pointsChange, JSON.stringify(battleData)]
      );
      
      // 计算奖励
      const rewards = await this.calculateMatchRewards(result, newTier, tierChanged);
      
      await client.query('COMMIT');
      
      // 更新 Redis 缓存
      await this.updateLeaderboardCache(userId, season.id, newPoints);
      
      logger.info('Match result processed', {
        userId,
        matchId,
        result,
        pointsChange,
        newTier,
        tierChanged
      });
      
      return {
        pointsChange,
        newRank: updateResult.rows[0],
        tierChanged,
        previousTier: rank.tier,
        rewards
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // 计算比赛奖励
  async calculateMatchRewards(result, tier, tierChanged) {
    const rewards = {
      coins: 0,
      items: [],
      exp: 0
    };
    
    if (result === 'win') {
      rewards.coins = 50;
      rewards.exp = 100;
      
      // 根据段位增加奖励
      const tierBonus = TIER_CONFIG[tier]?.level || 1;
      rewards.coins += tierBonus * 10;
      rewards.exp += tierBonus * 20;
      
      // 晋级奖励
      if (tierChanged) {
        rewards.items.push({
          type: 'promotion_pack',
          tier: tier,
          quantity: 1
        });
      }
    } else if (result === 'lose') {
      rewards.coins = 10;
      rewards.exp = 20;
    }
    
    return rewards;
  }
  
  // 获取排行榜
  async getLeaderboard(seasonId, options = {}) {
    const { tier, limit = 50 } = options;
    
    let queryStr = `
      SELECT pr.*, u.username, u.avatar_url,
             ROW_NUMBER() OVER (ORDER BY pr.rank_points DESC) as rank
      FROM player_ranks pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.season_id = $1
    `;
    
    const params = [seasonId];
    
    if (tier) {
      queryStr += ` AND pr.tier = $${params.length + 1}`;
      params.push(tier);
    }
    
    queryStr += ` ORDER BY pr.rank_points DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await db.query(queryStr, params);
    
    return result.rows.map(row => ({
      rank: parseInt(row.rank),
      userId: row.user_id,
      username: row.username,
      avatar: row.avatar_url,
      tier: row.tier,
      tierLevel: row.tier_level,
      rankPoints: row.rank_points,
      wins: row.wins,
      losses: row.losses,
      winRate: row.wins + row.losses > 0 
        ? ((row.wins / (row.wins + row.losses)) * 100).toFixed(1) 
        : 0
    }));
  }
  
  // 检查段位衰减
  async checkDecay(userId, seasonId) {
    const result = await db.query(
      `SELECT * FROM player_ranks 
       WHERE user_id = $1 AND season_id = $2 AND last_match_at < NOW() - INTERVAL '${POINTS_CONFIG.decayDays} days'`,
      [userId, seasonId]
    );
    
    return result.rows.length > 0;
  }
  
  // 应用段位衰减
  async applyDecay(userId, seasonId) {
    const rank = await this.getPlayerRank(userId, seasonId);
    const daysSinceLastMatch = Math.floor(
      (Date.now() - new Date(rank.last_match_at)) / (1000 * 60 * 60 * 24)
    );
    
    if (daysSinceLastMatch <= POINTS_CONFIG.decayDays) {
      return false;
    }
    
    const decayDays = daysSinceLastMatch - POINTS_CONFIG.decayDays;
    const decayPoints = decayDays * POINTS_CONFIG.decayRate;
    const newPoints = Math.max(0, rank.rank_points - decayPoints);
    
    const { tier: newTier, level: newLevel } = this.calculateTier(newPoints);
    
    await db.query(
      `UPDATE player_ranks 
       SET rank_points = $1, tier = $2, tier_level = $3, decay_points = $4, updated_at = NOW()
       WHERE user_id = $5 AND season_id = $6`,
      [newPoints, newTier, newLevel, decayPoints, userId, seasonId]
    );
    
    logger.info('Rank decay applied', { userId, seasonId, decayPoints, newTier });
    
    return true;
  }
  
  // 更新排行榜缓存
  async updateLeaderboardCache(userId, seasonId, points) {
    const key = `leaderboard:season:${seasonId}`;
    const redis = getRedis();
    await redis.zadd(key, points, userId.toString());
    await redis.expire(key, 3600);
  }
  
  // 获取下一个段位
  getNextTier(currentTier) {
    const tiers = Object.keys(TIER_CONFIG);
    const currentIndex = tiers.indexOf(currentTier);
    if (currentIndex === -1 || currentIndex === tiers.length - 1) {
      return null;
    }
    const nextTierName = tiers[currentIndex + 1];
    return { name: TIER_CONFIG[nextTierName].name, ...TIER_CONFIG[nextTierName] };
  }
  
  // 辅助方法：获取罗马数字
  getLevelRoman(level) {
    const romans = ['I', 'II', 'III', 'IV', 'V'];
    return romans[level - 1] || '';
  }
  
  // 辅助方法：获取段位颜色
  getTierColor(tier) {
    const colors = {
      bronze: '#CD7F32',
      silver: '#C0C0C0',
      gold: '#FFD700',
      platinum: '#E5E4E2',
      diamond: '#B9F2FF',
      master: '#9932CC',
      grandmaster: '#FF4500'
    };
    return colors[tier] || '#808080';
  }
  
  // 模拟定位赛匹配
  async findPlacementMatch(userId, rank) {
    // 匹配算法模拟，寻找差不多积分的定位赛玩家或电脑
    const seed = Math.floor(Math.random() * 1000);
    return {
      matchId: uuidv4(),
      opponentId: seed > 500 ? 2 : 3, // mock opponent users
      opponentUsername: `Opponent_${seed}`,
      estimatedWaitTime: 5
    };
  }

  // 模拟排位赛匹配
  async findRankedMatch(userId, rank) {
    const seed = Math.floor(Math.random() * 1000);
    return {
      matchId: uuidv4(),
      opponentId: seed > 500 ? 2 : 3,
      opponentUsername: `Player_${seed}`,
      estimatedWaitTime: 12
    };
  }
}

module.exports = new RankManager();
