/**
 * REQ-00073: PVP 玩家对战系统 - 匹配引擎
 * 创建时间: 2026-06-10 01:35
 * 
 * 功能:
 * - ELO 排位匹配算法
 * - 段位计算
 * - 匹配队列管理
 */

const { logger } = require('../../shared/logger');
const { query } = require('../../shared/db');

/**
 * ELO 排位匹配系统
 */
class PVPMatchingEngine {
  constructor() {
    // K-factor: ELO 计算系数
    this.kFactor = 32;
    // 匹配参数
    this.matchingConfig = {
      maxRatingDiff: 200,        // 最大 ELO 差
      ratingDiffGrowth: 10,      // 每秒扩大的 ELO 差
      maxRatingDiffCap: 500,     // 最大扩大的 ELO 差
      maxWaitTime: 60000,        // 最大等待时间（毫秒）
      minWaitTime: 3000          // 最小等待时间（快速匹配）
    };
  }

  /**
   * 计算 ELO 变化
   * @param {number} winnerRating - 胜者 ELO
   * @param {number} loserRating - 败者 ELO
   * @param {number} kFactor - K 系数
   * @returns {Object} ELO 变化
   */
  calculateEloChange(winnerRating, loserRating, kFactor = this.kFactor) {
    // 期望胜率
    const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLose = 1 - expectedWin;
    
    // ELO 变化
    const winnerChange = Math.round(kFactor * (1 - expectedWin));
    const loserChange = Math.round(kFactor * (0 - expectedLose));
    
    return {
      winnerChange,
      loserChange,
      expectedWin: expectedWin.toFixed(3),
      expectedLose: expectedLose.toFixed(3)
    };
  }

  /**
   * 根据等待时间计算当前允许的 ELO 差
   * @param {number} waitTimeMs - 等待时间（毫秒）
   * @returns {number} 允许的 ELO 差
   */
  calculateAllowedRatingDiff(waitTimeMs) {
    const { maxRatingDiff, ratingDiffGrowth, maxRatingDiffCap } = this.matchingConfig;
    const seconds = waitTimeMs / 1000;
    const expandedDiff = maxRatingDiff + seconds * ratingDiffGrowth;
    return Math.min(expandedDiff, maxRatingDiffCap);
  }

  /**
   * 查找匹配对手
   * @param {number} userId - 用户 ID
   * @param {number} rating - 用户 ELO
   * @param {Object} preferences - 匹配偏好
   * @returns {Promise<Object|null>} 匹配结果
   */
  async findMatch(userId, rating, preferences = {}) {
    try {
      // 获取匹配队列中的用户
      const allowedDiff = this.calculateAllowedRatingDiff(preferences.waitTime || 0);
      
      const { rows } = await query(`
        SELECT 
          user_id,
          elo_rating,
          created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 as wait_time_ms
        FROM pvp_match_queue
        WHERE user_id != $1
          AND matched = false
          AND ABS(elo_rating - $2) <= $3
        ORDER BY ABS(elo_rating - $2) ASC, created_at ASC
        LIMIT 5
      `, [userId, rating, allowedDiff]);
      
      if (rows.length === 0) {
        // 没有找到匹配，加入队列
        await this.joinQueue(userId, rating, preferences);
        return null;
      }
      
      // 选择最佳匹配（考虑等待时间加权）
      const bestMatch = this.selectBestMatch(rows, rating);
      
      // 标记双方已匹配
      await query(`
        UPDATE pvp_match_queue
        SET matched = true
        WHERE user_id IN ($1, $2)
      `, [userId, bestMatch.user_id]);
      
      // 从队列移除
      await query(`
        DELETE FROM pvp_match_queue
        WHERE user_id IN ($1, $2)
      `, [userId, bestMatch.user_id]);
      
      logger.info('PVP match found', {
        player1: userId,
        player2: bestMatch.user_id,
        ratingDiff: Math.abs(rating - bestMatch.elo_rating)
      });
      
      return {
        opponentId: bestMatch.user_id,
        opponentRating: bestMatch.elo_rating,
        ratingDiff: Math.abs(rating - bestMatch.elo_rating),
        waitTime: bestMatch.wait_time_ms
      };
    } catch (error) {
      logger.error('Failed to find match', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 选择最佳匹配
   * @param {Array} candidates - 候选列表
   * @param {number} myRating - 我的 ELO
   * @returns {Object} 最佳匹配
   */
  selectBestMatch(candidates, myRating) {
    let bestMatch = null;
    let bestScore = Infinity;
    
    for (const candidate of candidates) {
      const ratingDiff = Math.abs(candidate.elo_rating - myRating);
      const waitBonus = candidate.wait_time_ms / 1000 * 5; // 等待时间加成
      
      // 评分：ELO 差异 - 等待时间加成（越小越好）
      const score = ratingDiff - waitBonus;
      
      if (score < bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }
    
    return bestMatch;
  }

  /**
   * 加入匹配队列
   * @param {number} userId - 用户 ID
   * @param {number} rating - 用户 ELO
   * @param {Object} preferences - 偏好设置
   */
  async joinQueue(userId, rating, preferences = {}) {
    try {
      await query(`
        INSERT INTO pvp_match_queue (user_id, elo_rating, preferences)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
          elo_rating = $2,
          preferences = $3,
          created_at = NOW(),
          matched = false
      `, [userId, rating, JSON.stringify(preferences)]);
      
      logger.info('Player joined PVP queue', { userId, rating });
    } catch (error) {
      logger.error('Failed to join queue', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 离开匹配队列
   * @param {number} userId - 用户 ID
   */
  async leaveQueue(userId) {
    try {
      const result = await query(`
        DELETE FROM pvp_match_queue WHERE user_id = $1
      `, [userId]);
      
      logger.info('Player left PVP queue', { userId, removed: result.rowCount > 0 });
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Failed to leave queue', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 计算段位
   * @param {number} eloRating - ELO 积分
   * @returns {Object} 段位信息
   */
  calculateTier(eloRating) {
    if (eloRating >= 2400) {
      return { tier: 'grandmaster', tierLevel: Math.floor((eloRating - 2400) / 50), stars: (eloRating - 2400) % 50 };
    }
    if (eloRating >= 2000) {
      return { tier: 'master', tierLevel: Math.floor((eloRating - 2000) / 50), stars: (eloRating - 2000) % 50 };
    }
    if (eloRating >= 1600) {
      return { tier: 'diamond', tierLevel: Math.floor((eloRating - 1600) / 50), stars: (eloRating - 1600) % 50 };
    }
    if (eloRating >= 1300) {
      return { tier: 'platinum', tierLevel: Math.floor((eloRating - 1300) / 50), stars: (eloRating - 1300) % 50 };
    }
    if (eloRating >= 1000) {
      return { tier: 'gold', tierLevel: Math.floor((eloRating - 1000) / 50), stars: (eloRating - 1000) % 50 };
    }
    if (eloRating >= 700) {
      return { tier: 'silver', tierLevel: Math.floor((eloRating - 700) / 50), stars: (eloRating - 700) % 50 };
    }
    return { tier: 'bronze', tierLevel: Math.floor(eloRating / 50), stars: eloRating % 50 };
  }

  /**
   * 获取段位显示名称
   * @param {string} tier - 段位
   * @param {number} tierLevel - 段位等级
   * @returns {string} 显示名称
   */
  getTierDisplayName(tier, tierLevel = 0) {
    const tierNames = {
      grandmaster: '传奇大师',
      master: '大师',
      diamond: '钻石',
      platinum: '铂金',
      gold: '黄金',
      silver: '白银',
      bronze: '青铜'
    };
    
    const romanNumerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
    const level = romanNumerals[tierLevel] || '';
    
    return level ? `${tierNames[tier]} ${level}` : tierNames[tier];
  }

  /**
   * 更新排位积分
   * @param {number} userId - 用户 ID
   * @param {number} eloChange - ELO 变化
   * @param {boolean} isWin - 是否胜利
   * @returns {Promise<Object>} 更新后的排名信息
   */
  async updateRanking(userId, eloChange, isWin) {
    try {
      // 获取或创建排名记录
      await query(`
        INSERT INTO pvp_rankings (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);
      
      // 更新积分
      const { rows: [ranking] } = await query(`
        UPDATE pvp_rankings
        SET 
          elo_rating = GREATEST(0, elo_rating + $2),
          wins = wins + CASE WHEN $3 THEN 1 ELSE 0 END,
          losses = losses + CASE WHEN $3 THEN 0 ELSE 1 END,
          total_battles = total_battles + 1,
          current_streak = CASE 
            WHEN $3 THEN current_streak + 1 
            ELSE 0 
          END,
          best_streak = CASE 
            WHEN $3 AND current_streak + 1 > best_streak 
            THEN current_streak + 1 
            ELSE best_streak 
          END,
          tier = $4
        WHERE user_id = $1
        RETURNING *
      `, [userId, eloChange, isWin, this.calculateTier(Math.max(0, eloChange)).tier]);
      
      logger.info('PVP ranking updated', {
        userId,
        eloChange,
        isWin,
        newRating: ranking.elo_rating
      });
      
      return {
        ...ranking,
        tierInfo: this.calculateTier(ranking.elo_rating),
        tierDisplayName: this.getTierDisplayName(
          this.calculateTier(ranking.elo_rating).tier,
          this.calculateTier(ranking.elo_rating).tierLevel
        )
      };
    } catch (error) {
      logger.error('Failed to update ranking', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 获取排行榜
   * @param {string} tier - 段位过滤（可选）
   * @param {number} limit - 数量限制
   * @param {number} offset - 偏移量
   * @returns {Promise<Array>} 排行榜列表
   */
  async getLeaderboard(tier = null, limit = 100, offset = 0) {
    try {
      let whereClause = '';
      const params = [limit, offset];
      
      if (tier) {
        whereClause = 'WHERE pr.tier = $3';
        params.push(tier);
      }
      
      const { rows } = await query(`
        SELECT 
          pr.user_id,
          pr.elo_rating,
          pr.tier,
          pr.wins,
          pr.losses,
          pr.current_streak,
          pr.best_streak,
          pr.total_battles,
          u.username,
          u.avatar_url
        FROM pvp_rankings pr
        JOIN users u ON u.id = pr.user_id
        ${whereClause}
        ORDER BY pr.elo_rating DESC
        LIMIT $1 OFFSET $2
      `, params);
      
      return rows.map((row, index) => ({
        rank: offset + index + 1,
        ...row,
        tierDisplayName: this.getTierDisplayName(
          this.calculateTier(row.elo_rating).tier,
          this.calculateTier(row.elo_rating).tierLevel
        )
      }));
    } catch (error) {
      logger.error('Failed to get leaderboard', { error: error.message, tier });
      throw error;
    }
  }

  /**
   * 获取用户排名
   * @param {number} userId - 用户 ID
   * @returns {Promise<Object>} 排名信息
   */
  async getUserRanking(userId) {
    try {
      const { rows: [ranking] } = await query(`
        SELECT 
          pr.*,
          (SELECT COUNT(*) + 1 FROM pvp_rankings WHERE elo_rating > pr.elo_rating) as rank
        FROM pvp_rankings pr
        WHERE pr.user_id = $1
      `, [userId]);
      
      if (!ranking) {
        return {
          user_id: userId,
          elo_rating: 1000,
          tier: 'bronze',
          wins: 0,
          losses: 0,
          rank: await query(`SELECT COUNT(*) + 1 as rank FROM pvp_rankings`).then(r => r.rows[0].rank)
        };
      }
      
      return {
        ...ranking,
        tierInfo: this.calculateTier(ranking.elo_rating),
        tierDisplayName: this.getTierDisplayName(
          this.calculateTier(ranking.elo_rating).tier,
          this.calculateTier(ranking.elo_rating).tierLevel
        )
      };
    } catch (error) {
      logger.error('Failed to get user ranking', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * 清理超时匹配
   */
  async cleanupStaleMatches() {
    try {
      const { rowCount } = await query(`
        DELETE FROM pvp_match_queue
        WHERE created_at < NOW() - INTERVAL '2 minutes'
      `);
      
      if (rowCount > 0) {
        logger.info('Cleaned up stale PVP queue entries', { count: rowCount });
      }
      
      return rowCount;
    } catch (error) {
      logger.error('Failed to cleanup stale matches', { error: error.message });
      throw error;
    }
  }
}

// 导出单例
module.exports = new PVPMatchingEngine();
