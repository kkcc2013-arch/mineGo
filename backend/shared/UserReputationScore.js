/**
 * 用户信誉度评分系统
 * 基于多维度因素计算用户信誉等级，用于智能限流配额调整
 */

const Redis = require('ioredis');
const { logger, metrics } = require('./logger');
const { db } = require('./db');

class UserReputationScore {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.SCORE_KEY_PREFIX = 'user:reputation:';
    this.BEHAVIOR_KEY_PREFIX = 'user:behavior:';
    
    // 信誉度因子权重
    this.FACTORS = {
      accountAge: 0.15,           // 账号年龄
      activityConsistency: 0.20,  // 活跃一致性
      violationHistory: 0.25,     // 违规历史（负向）
      paymentReliability: 0.15,   // 支付可靠性
      socialTrust: 0.10,          // 社交信任度
      gameplayNorms: 0.15         // 游戏行为规范性
    };
    
    // 信誉等级阈值
    this.LEVELS = {
      NEW: { min: 0, max: 30, multiplier: 0.5 },       // 新用户
      BRONZE: { min: 30, max: 50, multiplier: 0.8 },   // 青铜
      SILVER: { min: 50, max: 70, multiplier: 1.0 },   // 白银
      GOLD: { min: 70, max: 85, multiplier: 1.3 },     // 黄金
      PLATINUM: { min: 85, max: 100, multiplier: 1.5 } // 铂金
    };
  }
  
  /**
   * 计算用户综合信誉度
   */
  async calculateReputation(userId) {
    const cacheKey = `${this.SCORE_KEY_PREFIX}${userId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 获取各维度数据
    const factors = await Promise.all([
      this.getAccountAge(userId),
      this.getActivityConsistency(userId),
      this.getViolationHistory(userId),
      this.getPaymentReliability(userId),
      this.getSocialTrust(userId),
      this.getGameplayNorms(userId)
    ]);
    
    // 计算加权总分
    let totalScore = 0;
    const breakdown = {};
    
    const factorNames = Object.keys(this.FACTORS);
    factors.forEach((score, index) => {
      const factorName = factorNames[index];
      const weight = this.FACTORS[factorName];
      totalScore += score * weight;
      breakdown[factorName] = { score, weight, contribution: score * weight };
    });
    
    // 确定信誉等级
    const level = this.determineLevel(totalScore);
    
    const result = {
      userId,
      totalScore: Math.round(totalScore * 100) / 100,
      level: level.name,
      multiplier: level.multiplier,
      breakdown,
      calculatedAt: new Date().toISOString()
    };
    
    // 缓存 1 小时
    await this.redis.setex(cacheKey, 3600, JSON.stringify(result));
    
    if (metrics && metrics.gauge) {
      metrics.gauge('user_reputation_score', totalScore, { userId, level: level.name });
    }
    
    return result;
  }
  
  /**
   * 账号年龄评分
   */
  async getAccountAge(userId) {
    try {
      const result = await db.query(
        `SELECT created_at FROM users WHERE id = $1`,
        [userId]
      );
      
      if (!result.rows.length) return 0;
      
      const ageInDays = (Date.now() - new Date(result.rows[0].created_at)) / (1000 * 60 * 60 * 24);
      
      // 年龄评分曲线：7天内快速上升，30天后趋于平缓
      if (ageInDays < 7) return Math.min(100, ageInDays * 10);
      if (ageInDays < 30) return 70 + (ageInDays - 7) * 1;
      if (ageInDays < 90) return 93 + (ageInDays - 30) * 0.1;
      return 100;
    } catch (error) {
      logger.error('Failed to get account age', { userId, error: error.message });
      return 50; // 默认中等分数
    }
  }
  
  /**
   * 活跃一致性评分
   */
  async getActivityConsistency(userId) {
    try {
      const result = await db.query(`
        SELECT 
          COUNT(DISTINCT DATE(created_at)) as active_days,
          COUNT(*) as total_requests
        FROM api_access_logs
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '30 days'
      `, [userId]);
      
      if (!result.rows.length || result.rows[0].active_days === 0) return 50; // 默认中等
      
      const { active_days, total_requests } = result.rows[0];
      const avgRequestsPerDay = total_requests / active_days;
      
      // 活跃天数占比
      const dayConsistency = (active_days / 30) * 100;
      
      // 请求量合理性（异常高或低都扣分）
      const requestReasonability = avgRequestsPerDay > 10 && avgRequestsPerDay < 1000 
        ? 100 
        : Math.max(0, 100 - Math.abs(Math.log10(avgRequestsPerDay + 1) - 2) * 20);
      
      return (dayConsistency * 0.6 + requestReasonability * 0.4);
    } catch (error) {
      logger.error('Failed to get activity consistency', { userId, error: error.message });
      return 50;
    }
  }
  
  /**
   * 违规历史评分（负向指标）
   */
  async getViolationHistory(userId) {
    try {
      const result = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE severity = 'high') as high_violations,
          COUNT(*) FILTER (WHERE severity = 'medium') as medium_violations,
          COUNT(*) FILTER (WHERE severity = 'low') as low_violations,
          MAX(created_at) as last_violation
        FROM user_violations
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '90 days'
      `, [userId]);
      
      if (!result.rows.length) return 100;
      
      const { high_violations, medium_violations, low_violations, last_violation } = result.rows[0];
      
      // 扣分规则
      let deduction = 0;
      deduction += parseInt(high_violations || 0) * 30;
      deduction += parseInt(medium_violations || 0) * 10;
      deduction += parseInt(low_violations || 0) * 3;
      
      // 时间衰减：近期违规扣分更多
      if (last_violation) {
        const daysSinceViolation = (Date.now() - new Date(last_violation)) / (1000 * 60 * 60 * 24);
        const timeMultiplier = Math.max(0.5, 1 - daysSinceViolation / 90);
        deduction *= timeMultiplier;
      }
      
      return Math.max(0, 100 - deduction);
    } catch (error) {
      logger.error('Failed to get violation history', { userId, error: error.message });
      return 100; // 无违规记录时默认满分
    }
  }
  
  /**
   * 支付可靠性评分
   */
  async getPaymentReliability(userId) {
    try {
      const result = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'refunded') as refunded,
          COUNT(*) FILTER (WHERE status = 'chargeback') as chargebacks,
          COUNT(*) as total
        FROM payment_orders
        WHERE user_id = $1
      `, [userId]);
      
      if (!result.rows.length || result.rows[0].total === 0) return 70; // 无支付记录默认中等
      
      const { completed, refunded, chargebacks, total } = result.rows[0];
      
      // 拒付是严重负面信号
      const chargebackRate = parseInt(chargebacks || 0) / parseInt(total);
      if (chargebackRate > 0.05) return 20;
      if (chargebackRate > 0) return 50;
      
      // 退款率
      const refundRate = parseInt(refunded || 0) / parseInt(total);
      const refundScore = Math.max(0, 100 - refundRate * 200);
      
      // 完成率
      const completionRate = parseInt(completed || 0) / parseInt(total);
      const completionScore = completionRate * 100;
      
      return refundScore * 0.5 + completionScore * 0.5;
    } catch (error) {
      logger.error('Failed to get payment reliability', { userId, error: error.message });
      return 70;
    }
  }
  
  /**
   * 社交信任度评分
   */
  async getSocialTrust(userId) {
    try {
      const result = await db.query(`
        SELECT 
          (SELECT COUNT(*) FROM friendships WHERE user_id = $1 AND status = 'accepted') as friends,
          (SELECT COUNT(*) FROM guild_members WHERE user_id = $1) as guilds,
          (SELECT COUNT(*) FROM user_reports WHERE reported_user_id = $1) as reports_received,
          (SELECT COUNT(*) FROM user_reports WHERE reporter_id = $1 AND status = 'valid') as valid_reports
      `, [userId]);
      
      if (!result.rows.length) return 70;
      
      const { friends, guilds, reports_received, valid_reports } = result.rows[0];
      
      let score = 50;
      
      // 好友数加分
      score += Math.min(20, parseInt(friends || 0) * 0.5);
      
      // 公会成员加分
      score += Math.min(10, parseInt(guilds || 0) * 5);
      
      // 被举报扣分
      score -= Math.min(40, parseInt(reports_received || 0) * 10);
      
      // 有效举报加分（社区贡献）
      score += Math.min(10, parseInt(valid_reports || 0) * 2);
      
      return Math.max(0, Math.min(100, score));
    } catch (error) {
      logger.error('Failed to get social trust', { userId, error: error.message });
      return 70;
    }
  }
  
  /**
   * 游戏行为规范性评分
   */
  async getGameplayNorms(userId) {
    try {
      const result = await db.query(`
        SELECT 
          AVG(catch_rate) as avg_catch_rate,
          AVG(battle_win_rate) as avg_win_rate,
          COUNT(*) FILTER (WHERE is_suspicious = true) as suspicious_actions
        FROM user_gameplay_stats
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '30 days'
      `, [userId]);
      
      if (!result.rows.length) return 70;
      
      const { avg_catch_rate, avg_win_rate, suspicious_actions } = result.rows[0];
      
      let score = 80;
      
      // 异常捕捉率扣分（过高可能使用外挂）
      const catchRate = parseFloat(avg_catch_rate) || 0;
      if (catchRate > 0.95) score -= 30;
      else if (catchRate > 0.85) score -= 10;
      
      // 异常胜率扣分
      const winRate = parseFloat(avg_win_rate) || 0;
      if (winRate > 0.9) score -= 20;
      else if (winRate > 0.8) score -= 5;
      
      // 可疑行为扣分
      score -= Math.min(30, parseInt(suspicious_actions || 0) * 5);
      
      return Math.max(0, score);
    } catch (error) {
      logger.error('Failed to get gameplay norms', { userId, error: error.message });
      return 70;
    }
  }
  
  /**
   * 确定信誉等级
   */
  determineLevel(score) {
    for (const [name, config] of Object.entries(this.LEVELS)) {
      if (score >= config.min && score < config.max) {
        return { name, ...config };
      }
    }
    return { name: 'PLATINUM', ...this.LEVELS.PLATINUM };
  }
  
  /**
   * 记录行为事件（影响未来评分）
   */
  async recordBehaviorEvent(userId, eventType, data = {}) {
    const key = `${this.BEHAVIOR_KEY_PREFIX}${userId}`;
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...data
    };
    
    await this.redis.lpush(key, JSON.stringify(event));
    await this.redis.ltrim(key, 0, 999); // 保留最近 1000 条
    
    // 根据事件类型更新评分
    const scoreDelta = this.getEventScoreDelta(eventType, data);
    if (scoreDelta !== 0) {
      await this.adjustReputationScore(userId, scoreDelta);
    }
  }
  
  getEventScoreDelta(eventType, data) {
    const deltas = {
      'violation_high': -30,
      'violation_medium': -10,
      'violation_low': -3,
      'valid_report': 2,
      'payment_completed': 5,
      'payment_refunded': -5,
      'chargeback': -50,
      'suspicious_catch': -5,
      'friend_accepted': 1,
      'guild_joined': 2
    };
    
    return deltas[eventType] || 0;
  }
  
  async adjustReputationScore(userId, delta) {
    const cacheKey = `${this.SCORE_KEY_PREFIX}${userId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      const data = JSON.parse(cached);
      data.totalScore = Math.max(0, Math.min(100, data.totalScore + delta));
      data.level = this.determineLevel(data.totalScore).name;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(data));
    }
    
    // 清除缓存，下次重新计算
    await this.redis.del(cacheKey);
    
    logger.info('Reputation score adjusted', { userId, delta });
  }
}

module.exports = new UserReputationScore();
