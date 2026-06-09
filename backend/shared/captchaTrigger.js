/**
 * CAPTCHA Trigger
 * 风险触发式人机验证触发器
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const { metrics } = require('./metrics');
const CaptchaChallengeGenerator = require('./captchaChallenge');

const logger = createLogger('captcha-trigger');

/**
 * 验证触发器类
 */
class CaptchaTrigger {
  constructor(config = {}) {
    this.db = config.db || new Pool(config.database);
    this.redis = config.redis || new Redis(config.redisConfig);
    this.challengeGenerator = new CaptchaChallengeGenerator();
    
    // 触发阈值配置
    this.thresholds = {
      low_risk: 80,
      medium_risk: 60,
      high_risk: 40
    };
    
    // 会话超时时间（秒）
    this.sessionTimeout = 300;
    
    // 最大尝试次数
    this.maxAttempts = 3;
  }

  /**
   * 检查是否需要触发验证
   * @param {string} userId - 用户ID
   * @param {string} action - 操作类型
   * @param {Object} context - 上下文信息
   * @returns {Object|null} 触发信息
   */
  async checkTrigger(userId, action, context = {}) {
    const triggers = [];
    
    try {
      // 1. 获取用户可信度
      const trustScore = await this.getUserTrustScore(userId);
      
      // 2. 检查可信度阈值
      if (trustScore < this.thresholds.high_risk) {
        triggers.push({
          reason: 'risk_score',
          difficulty: 'high',
          score: trustScore
        });
      } else if (trustScore < this.thresholds.medium_risk) {
        triggers.push({
          reason: 'risk_score',
          difficulty: 'medium',
          score: trustScore
        });
      } else if (trustScore < this.thresholds.low_risk) {
        triggers.push({
          reason: 'risk_score',
          difficulty: 'low',
          score: trustScore
        });
      }
      
      // 3. 检查高风险操作
      const highRiskTrigger = await this.checkHighRiskActions(userId, action, context);
      if (highRiskTrigger) {
        triggers.push(highRiskTrigger);
      }
      
      // 4. 检查定期验证
      const periodicTrigger = await this.checkPeriodicVerification(userId, trustScore);
      if (periodicTrigger) {
        triggers.push(periodicTrigger);
      }
      
      // 5. 返回优先级最高的触发
      if (triggers.length === 0) {
        return null;
      }
      
      // 按难度排序（high > medium > low）
      triggers.sort((a, b) => {
        const order = { high: 3, medium: 2, low: 1 };
        return order[b.difficulty] - order[a.difficulty];
      });
      
      return triggers[0];
      
    } catch (error) {
      logger.error({ error, userId, action }, 'Error checking captcha trigger');
      return null;
    }
  }

  /**
   * 触发验证
   * @param {string} userId - 用户ID
   * @param {Object} trigger - 触发信息
   * @param {Object} context - 上下文信息
   * @returns {Object} 验证会话
   */
  async trigger(userId, trigger, context = {}) {
    const sessionId = uuidv4();
    const difficulty = trigger.difficulty;
    const sessionType = this.challengeGenerator.selectRandomType(difficulty);
    
    // 生成挑战
    const challenge = this.challengeGenerator.generate(sessionType, difficulty);
    
    // 计算过期时间
    const expiresAt = new Date(Date.now() + this.sessionTimeout * 1000);
    
    // 保存会话
    await this.db.query(
      `INSERT INTO captcha_sessions 
       (id, user_id, session_type, difficulty, trigger_reason, challenge_data, expected_answer, 
        expires_at, max_attempts, ip_address, device_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        sessionId,
        userId,
        sessionType,
        difficulty,
        trigger.reason,
        JSON.stringify(challenge),
        JSON.stringify(challenge.expectedAnswer),
        expiresAt,
        this.maxAttempts,
        context.ipAddress,
        context.deviceFingerprint
      ]
    );
    
    // 设置缓存标记
    await this.redis.setex(
      `captcha:trigger:${userId}`,
      this.sessionTimeout,
      sessionId
    );
    
    // 记录指标
    metrics.captchaTriggersTotal.inc({ reason: trigger.reason, difficulty });
    
    logger.info({
      sessionId,
      userId,
      sessionType,
      difficulty,
      reason: trigger.reason
    }, 'Captcha triggered');
    
    // 返回挑战数据（不包含答案）
    return {
      sessionId,
      sessionType,
      difficulty,
      challengeData: this.sanitizeChallengeData(challenge)
    };
  }

  /**
   * 检查高风险操作
   */
  async checkHighRiskActions(userId, action, context) {
    // 检查是否有对应的触发规则
    const result = await this.db.query(
      `SELECT * FROM captcha_trigger_rules 
       WHERE trigger_type = $1 AND enabled = true`,
      [action]
    );
    
    const rule = result.rows[0];
    if (!rule) {
      // 没有匹配的规则，检查内置的高风险操作
      return this.checkBuiltInHighRiskActions(userId, action, context);
    }
    
    // 检查冷却时间
    const lastTrigger = await this.getLastTriggerTime(userId, action);
    if (lastTrigger && Date.now() - lastTrigger.getTime() < rule.cooldown_seconds * 1000) {
      return null;
    }
    
    return {
      reason: action,
      difficulty: rule.difficulty_override || 'medium'
    };
  }

  /**
   * 检查内置高风险操作
   */
  async checkBuiltInHighRiskActions(userId, action, context) {
    const highRiskActions = {
      // 跨区域登录
      cross_region_login: async () => {
        if (context.previousLocation && context.currentLocation) {
          const distance = this.calculateDistance(
            context.previousLocation.lat, context.previousLocation.lng,
            context.currentLocation.lat, context.currentLocation.lng
          );
          // 距离超过 500km 视为跨区域
          if (distance > 500) {
            return { reason: 'cross_region_login', difficulty: 'medium' };
          }
        }
        return null;
      },
      
      // 异常捕捉
      anomalous_catch: async () => {
        if (context.catchSuccessRate && context.catchSuccessRate > 0.95) {
          return { reason: 'anomalous_catch', difficulty: 'medium' };
        }
        return null;
      },
      
      // 设备切换
      device_switch: async () => {
        if (context.deviceChanged) {
          return { reason: 'device_switch', difficulty: 'medium' };
        }
        return null;
      },
      
      // 批量操作
      bulk_operation: async () => {
        if (context.operationCount && context.operationCount > 50) {
          return { reason: 'bulk_operation', difficulty: 'high' };
        }
        return null;
      },
      
      // 深夜活动
      night_activity: async () => {
        const hour = new Date().getHours();
        if (hour >= 2 && hour <= 6) {
          return { reason: 'night_activity', difficulty: 'low' };
        }
        return null;
      }
    };
    
    const checker = highRiskActions[action];
    if (checker) {
      return await checker();
    }
    
    return null;
  }

  /**
   * 检查定期验证
   */
  async checkPeriodicVerification(userId, trustScore) {
    // 获取上次验证时间
    const result = await this.db.query(
      `SELECT last_verification_at FROM captcha_stats WHERE user_id = $1`,
      [userId]
    );
    
    const lastVerification = result.rows[0]?.last_verification_at;
    
    // 高风险用户 7 天验证一次，普通用户 30 天验证一次
    const periodicDays = trustScore < 60 ? 7 : 30;
    
    if (!lastVerification) {
      // 从未验证过，触发验证
      return {
        reason: 'periodic',
        difficulty: trustScore < 60 ? 'medium' : 'low'
      };
    }
    
    const daysSinceLastVerification = 
      (Date.now() - new Date(lastVerification).getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLastVerification >= periodicDays) {
      return {
        reason: 'periodic',
        difficulty: trustScore < 60 ? 'medium' : 'low'
      };
    }
    
    return null;
  }

  /**
   * 获取用户可信度分数
   */
  async getUserTrustScore(userId) {
    // 首先检查 Redis 缓存
    const cached = await this.redis.get(`trust_score:${userId}`);
    if (cached) {
      return parseInt(cached);
    }
    
    // 从数据库获取
    try {
      const result = await this.db.query(
        `SELECT score FROM user_trust_scores WHERE user_id = $1`,
        [userId]
      );
      
      if (result.rows[0]) {
        const score = result.rows[0].score;
        // 缓存 5 分钟
        await this.redis.setex(`trust_score:${userId}`, 300, score.toString());
        return score;
      }
    } catch (e) {
      // 表可能不存在
    }
    
    // 默认返回高分（信任用户）
    return 85;
  }

  /**
   * 获取上次触发时间
   */
  async getLastTriggerTime(userId, triggerType) {
    const result = await this.db.query(
      `SELECT created_at FROM captcha_sessions 
       WHERE user_id = $1 AND trigger_reason = $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, triggerType]
    );
    return result.rows[0]?.created_at || null;
  }

  /**
   * 计算两点距离（km）
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 清理挑战数据中的敏感信息
   */
  sanitizeChallengeData(challenge) {
    const sanitized = { ...challenge };
    delete sanitized.expectedAnswer;
    return sanitized;
  }
}

module.exports = CaptchaTrigger;
