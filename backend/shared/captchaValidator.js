/**
 * CAPTCHA Validator
 * 风险触发式人机验证答案验证器
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('./logger');
const { metrics } = require('./metrics');

const logger = createLogger('captcha-validator');

/**
 * 验证答案验证器类
 */
class CaptchaValidator {
  constructor(config = {}) {
    this.db = config.db || new Pool(config.database);
    this.redis = config.redis || new Redis(config.redisConfig);
    
    // 最小响应时间配置（毫秒）
    this.minResponseTime = {
      low: 1000,
      medium: 2000,
      high: 3000
    };
    
    // 可信度调整值
    this.trustScoreRecovery = 10;
    this.trustScorePenalty = 10;
    
    // 冻结配置
    this.freezeThreshold = 3;
    this.freezeDurationHours = 24;
  }

  /**
   * 验证答案
   * @param {string} sessionId - 会话ID
   * @param {Object} answer - 用户答案
   * @param {Object} clientData - 客户端数据
   * @returns {Object} 验证结果
   */
  async validate(sessionId, answer, clientData = {}) {
    const startTime = Date.now();
    
    try {
      // 1. 获取会话信息
      const session = await this.getSession(sessionId);
      
      if (!session) {
        return { valid: false, error: 'session_not_found', code: 404 };
      }
      
      if (session.status !== 'pending') {
        return { 
          valid: false, 
          error: 'session_already_completed',
          code: 400,
          status: session.status
        };
      }
      
      // 2. 检查过期
      if (new Date() > new Date(session.expires_at)) {
        await this.updateSessionStatus(sessionId, 'expired');
        metrics.captchaResultsTotal.inc({ type: session.session_type, status: 'expired' });
        return { valid: false, error: 'session_expired', code: 410 };
      }
      
      // 3. 检查尝试次数
      if (session.attempt_count >= session.max_attempts) {
        await this.updateSessionStatus(sessionId, 'failed');
        metrics.captchaResultsTotal.inc({ type: session.session_type, status: 'failed' });
        return { 
          valid: false, 
          error: 'max_attempts_exceeded',
          code: 429
        };
      }
      
      // 4. 验证答案正确性
      const isCorrect = this.verifyAnswer(session.session_type, session.expected_answer, answer);
      
      // 5. 反机器人检测
      const botScore = await this.detectBot(session, clientData);
      
      // 6. 更新尝试次数
      await this.incrementAttemptCount(sessionId);
      
      // 7. 计算响应时间
      const responseTime = clientData.responseTimeMs || (Date.now() - startTime);
      
      // 8. 处理验证结果
      if (isCorrect && botScore < 0.7) {
        // 验证通过
        return await this.handleSuccess(session, clientData, responseTime);
      } else {
        // 验证失败
        return await this.handleFailure(session, clientData, responseTime, !isCorrect);
      }
      
    } catch (error) {
      logger.error({ error, sessionId }, 'Captcha validation error');
      return { valid: false, error: 'validation_error', code: 500 };
    }
  }

  /**
   * 获取会话信息
   */
  async getSession(sessionId) {
    const result = await this.db.query(
      `SELECT * FROM captcha_sessions WHERE id = $1`,
      [sessionId]
    );
    return result.rows[0] || null;
  }

  /**
   * 更新会话状态
   */
  async updateSessionStatus(sessionId, status, clientData = null) {
    const updateFields = ['status = $2', 'completed_at = NOW()'];
    const params = [sessionId, status];
    
    if (clientData) {
      updateFields.push(`client_data = $${params.length + 1}`);
      params.push(JSON.stringify(clientData));
    }
    
    await this.db.query(
      `UPDATE captcha_sessions SET ${updateFields.join(', ')} WHERE id = $1`,
      params
    );
  }

  /**
   * 增加尝试次数
   */
  async incrementAttemptCount(sessionId) {
    await this.db.query(
      `UPDATE captcha_sessions SET attempt_count = attempt_count + 1 WHERE id = $1`,
      [sessionId]
    );
  }

  /**
   * 验证答案正确性
   */
  verifyAnswer(type, expectedAnswer, userAnswer) {
    switch (type) {
      case 'slide':
        return this.verifySlideAnswer(expectedAnswer, userAnswer);
      case 'click':
        return this.verifyClickAnswer(expectedAnswer, userAnswer);
      case 'calculate':
        return this.verifyCalculateAnswer(expectedAnswer, userAnswer);
      default:
        return false;
    }
  }

  /**
   * 验证滑动答案
   */
  verifySlideAnswer(expected, answer) {
    if (!answer || !Array.isArray(answer.pieceOrder)) {
      return false;
    }
    
    // 检查块顺序是否正确
    if (answer.pieceOrder.length !== expected.pieceOrder.length) {
      return false;
    }
    
    for (let i = 0; i < expected.pieceOrder.length; i++) {
      if (answer.pieceOrder[i] !== expected.pieceOrder[i]) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 验证点选答案
   */
  verifyClickAnswer(expected, answer) {
    if (!answer || !Array.isArray(answer.positions)) {
      return false;
    }
    
    // 检查点击位置
    if (answer.positions.length !== expected.positions.length) {
      return false;
    }
    
    for (let i = 0; i < expected.positions.length; i++) {
      if (answer.positions[i] !== expected.positions[i]) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 验证计算答案
   */
  verifyCalculateAnswer(expected, answer) {
    if (answer.value !== undefined) {
      return answer.value === expected.value;
    }
    if (answer.optionIndex !== undefined) {
      return answer.optionIndex === expected.optionIndex;
    }
    return false;
  }

  /**
   * 机器人检测
   */
  async detectBot(session, clientData) {
    let score = 0;
    
    // 1. 响应时间检测
    const minTime = this.minResponseTime[session.difficulty] || 1000;
    if (clientData.responseTimeMs && clientData.responseTimeMs < minTime) {
      score += 0.4;
      logger.warn({ 
        sessionId: session.id, 
        responseTime: clientData.responseTimeMs, 
        minTime 
      }, 'Captcha response too fast');
    }
    
    // 2. 轨迹分析
    if (clientData.trajectory && session.session_type === 'slide') {
      const trajectoryScore = this.analyzeTrajectory(clientData.trajectory);
      if (trajectoryScore < 0.3) {
        score += 0.3;
        logger.warn({ 
          sessionId: session.id, 
          trajectoryScore 
        }, 'Suspicious trajectory detected');
      }
    }
    
    // 3. 设备指纹一致性
    if (session.device_fingerprint && clientData.deviceFingerprint) {
      if (session.device_fingerprint !== clientData.deviceFingerprint) {
        score += 0.2;
        logger.warn({ 
          sessionId: session.id 
        }, 'Device fingerprint mismatch');
      }
    }
    
    // 4. IP 地址检查
    if (session.ip_address && clientData.ipAddress) {
      if (session.ip_address !== clientData.ipAddress) {
        score += 0.1;
      }
    }
    
    return score;
  }

  /**
   * 轨迹分析
   */
  analyzeTrajectory(trajectory) {
    if (!trajectory || trajectory.length < 5) {
      return 0;
    }
    
    // 计算速度变化
    const speeds = [];
    for (let i = 1; i < trajectory.length; i++) {
      const dx = (trajectory[i].x || 0) - (trajectory[i-1].x || 0);
      const dy = (trajectory[i].y || 0) - (trajectory[i-1].y || 0);
      const dt = (trajectory[i].t || 0) - (trajectory[i-1].t || 0) || 1;
      speeds.push(Math.sqrt(dx*dx + dy*dy) / dt);
    }
    
    // 计算速度方差（人类行为速度变化不均匀）
    const speedVariance = this.calculateVariance(speeds);
    
    // 计算抖动（人类行为有微小抖动）
    const jitter = this.calculateJitter(trajectory);
    
    // 检查起点和终点停顿
    const hasPauses = trajectory.length > 2 && 
      ((trajectory[0].duration || 0) > 100 || 
       (trajectory[trajectory.length-1].duration || 0) > 100);
    
    // 综合评分
    const score = 
      (speedVariance > 0.1 ? 0.3 : 0) +
      (jitter > 0.5 ? 0.3 : 0) +
      (hasPauses ? 0.4 : 0);
    
    return score;
  }

  /**
   * 计算方差
   */
  calculateVariance(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
  }

  /**
   * 计算抖动
   */
  calculateJitter(trajectory) {
    if (trajectory.length < 3) return 0;
    
    let jitterCount = 0;
    for (let i = 2; i < trajectory.length; i++) {
      const dx1 = (trajectory[i-1].x || 0) - (trajectory[i-2].x || 0);
      const dx2 = (trajectory[i].x || 0) - (trajectory[i-1].x || 0);
      const dy1 = (trajectory[i-1].y || 0) - (trajectory[i-2].y || 0);
      const dy2 = (trajectory[i].y || 0) - (trajectory[i-1].y || 0);
      
      // 方向改变视为抖动
      if ((dx1 > 0 && dx2 < 0) || (dx1 < 0 && dx2 > 0) ||
          (dy1 > 0 && dy2 < 0) || (dy1 < 0 && dy2 > 0)) {
        jitterCount++;
      }
    }
    
    return jitterCount / (trajectory.length - 2);
  }

  /**
   * 处理验证成功
   */
  async handleSuccess(session, clientData, responseTime) {
    // 更新会话状态
    await this.updateSessionStatus(session.id, 'passed', clientData);
    
    // 恢复可信度
    await this.updateTrustScore(session.user_id, this.trustScoreRecovery, 'captcha_passed');
    
    // 更新统计
    await this.updateStats(session.user_id, true, responseTime);
    
    // 清除缓存
    await this.redis.del(`captcha:trigger:${session.user_id}`);
    
    // 记录指标
    metrics.captchaResultsTotal.inc({ type: session.session_type, status: 'passed' });
    metrics.captchaResponseTime.observe(
      { type: session.session_type, difficulty: session.difficulty },
      responseTime / 1000
    );
    
    logger.info({ 
      sessionId: session.id, 
      userId: session.user_id,
      responseTime 
    }, 'Captcha passed');
    
    return {
      valid: true,
      message: 'Verification passed',
      trustScoreRecovery: this.trustScoreRecovery
    };
  }

  /**
   * 处理验证失败
   */
  async handleFailure(session, clientData, responseTime, wrongAnswer) {
    // 降低可信度
    await this.updateTrustScore(session.user_id, -this.trustScorePenalty, 'captcha_failed');
    
    // 更新统计
    await this.updateStats(session.user_id, false, responseTime);
    
    // 获取当前尝试次数
    const currentSession = await this.getSession(session.id);
    const remainingAttempts = currentSession.max_attempts - currentSession.attempt_count;
    
    // 检查是否需要冻结账号
    let accountFrozen = false;
    if (remainingAttempts <= 0) {
      await this.updateSessionStatus(session.id, 'failed', clientData);
      
      // 检查24小时内失败次数
      const recentFailures = await this.countRecentFailures(session.user_id, 24);
      if (recentFailures >= this.freezeThreshold) {
        await this.freezeAccount(session.user_id);
        accountFrozen = true;
      }
    }
    
    // 记录指标
    metrics.captchaResultsTotal.inc({ type: session.session_type, status: 'failed' });
    
    logger.warn({ 
      sessionId: session.id, 
      userId: session.user_id,
      remainingAttempts,
      accountFrozen 
    }, 'Captcha failed');
    
    const result = {
      valid: false,
      error: wrongAnswer ? 'incorrect_answer' : 'verification_failed',
      remainingAttempts,
      message: `Verification failed. ${remainingAttempts} attempts remaining.`
    };
    
    if (accountFrozen) {
      result.error = 'account_frozen';
      result.message = 'Account temporarily frozen due to multiple verification failures';
      result.contactSupport = true;
    }
    
    return result;
  }

  /**
   * 更新可信度分数
   */
  async updateTrustScore(userId, delta, reason) {
    // 这里应该调用 trust score 服务或直接更新用户表
    // 简化实现：直接记录日志
    logger.info({ userId, delta, reason }, 'Trust score updated');
    
    // 如果有 user_trust_scores 表，可以更新
    try {
      await this.db.query(
        `UPDATE user_trust_scores 
         SET score = GREATEST(0, LEAST(100, score + $2)),
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, delta]
      );
    } catch (e) {
      // 表可能不存在，忽略错误
    }
  }

  /**
   * 更新验证统计
   */
  async updateStats(userId, passed, responseTime) {
    await this.db.query(
      `INSERT INTO captcha_stats (user_id, total_verifications, passed_verifications, failed_verifications, avg_response_time_ms, last_verification_at, last_verification_status)
       VALUES ($1, 1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (user_id) DO UPDATE SET
         total_verifications = captcha_stats.total_verifications + 1,
         passed_verifications = captcha_stats.passed_verifications + $2,
         failed_verifications = captcha_stats.failed_verifications + $3,
         avg_response_time_ms = (captcha_stats.avg_response_time_ms + $4) / 2,
         last_verification_at = NOW(),
         last_verification_status = $5`,
      [userId, passed ? 1 : 0, passed ? 0 : 1, responseTime, passed ? 'passed' : 'failed']
    );
  }

  /**
   * 统计最近失败次数
   */
  async countRecentFailures(userId, hours) {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM captcha_sessions
       WHERE user_id = $1 
         AND status = 'failed'
         AND created_at > NOW() - INTERVAL '${hours} hours'`,
      [userId]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  /**
   * 冻结账号
   */
  async freezeAccount(userId) {
    // 记录冻结事件
    await this.db.query(
      `INSERT INTO account_freezes (user_id, reason, duration_hours, created_at)
       VALUES ($1, 'captcha_failures', $2, NOW())`,
      [userId, this.freezeDurationHours]
    );
    
    // 设置 Redis 标记
    await this.redis.setex(
      `account:frozen:${userId}`,
      this.freezeDurationHours * 3600,
      'captcha_failures'
    );
    
    logger.warn({ userId, duration: this.freezeDurationHours }, 'Account frozen');
  }
}

module.exports = CaptchaValidator;
