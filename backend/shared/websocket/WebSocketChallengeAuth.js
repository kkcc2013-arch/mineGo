/**
 * WebSocket 连续身份验证（Challenge-Response）系统
 * REQ-00434: WebSocket 连续身份验证
 * 
 * 功能：
 * - 定时发送 challenge 进行身份验证
 * - HMAC-SHA256 challenge 响应验证
 * - 挑战超时检测
 * - 认证状态管理
 * - 异常行为检测
 */

const crypto = require('crypto');
const { logger } = require('../logger');

class WebSocketChallengeAuth {
  constructor(options = {}) {
    this.redis = options.redis;
    this.secretKey = options.secretKey || process.env.WS_SECRET_KEY;
    
    if (!this.secretKey) {
      throw new Error('WebSocket secret key is required for challenge auth');
    }
    
    // 配置
    this.challengeInterval = options.challengeInterval || 300000; // 5 分钟挑战一次
    this.challengeTimeout = options.challengeTimeout || 30000; // 30 秒响应超时
    this.maxChallengeFailures = options.maxChallengeFailures || 3; // 最大失败次数
    
    // 挑战缓存（开发环境）
    this.pendingChallenges = new Map(); // sessionId -> { nonce, timestamp, status }
    
    // 认证状态缓存
    this.authState = new Map(); // sessionId -> { lastAuth, authCount, failures }
    
    // 统计
    this.stats = {
      challengesSent: 0,
      challengesSuccess: 0,
      challengesFailed: 0,
      challengesTimeout: 0,
      authCount: 0
    };
  }

  /**
   * 发送挑战（Challenge）
   * @param {WebSocket} ws - WebSocket 连接
   * @param {string} sessionId - 会话ID
   * @returns {object} 挑战消息
   */
  async sendChallenge(ws, sessionId) {
    const challengeNonce = crypto.randomBytes(32).toString('hex');
    const challengeTimestamp = Date.now();
    const challengeId = crypto.randomBytes(16).toString('hex');

    // 存储挑战
    const challengeData = {
      nonce: challengeNonce,
      timestamp: challengeTimestamp,
      id: challengeId,
      status: 'pending',
      createdAt: Date.now()
    };

    if (this.redis) {
      await this.redis.set(
        `ws:challenge:${sessionId}`,
        JSON.stringify(challengeData),
        'PX',
        this.challengeTimeout
      );
    } else {
      this.pendingChallenges.set(sessionId, challengeData);
    }

    // 发送挑战消息
    const challengeMessage = {
      type: 'auth_challenge',
      challengeId,
      challenge: challengeNonce,
      timestamp: challengeTimestamp,
      expiresIn: this.challengeTimeout
    };

    this.stats.challengesSent++;

    logger.debug({ sessionId, challengeId }, 'Challenge sent');

    return challengeMessage;
  }

  /**
   * 验证挑战响应（Response）
   * @param {string} sessionId - 会话ID
   * @param {object} response - 响应对象 { challengeId, response }
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async verifyChallengeResponse(sessionId, response) {
    const { challengeId, response: challengeResponse } = response;

    if (!challengeId || !challengeResponse) {
      this.stats.challengesFailed++;
      return { valid: false, reason: 'INVALID_RESPONSE_FORMAT' };
    }

    // 获取挑战数据
    let challengeData;
    if (this.redis) {
      const data = await this.redis.get(`ws:challenge:${sessionId}`);
      if (!data) {
        this.stats.challengesTimeout++;
        return { valid: false, reason: 'CHALLENGE_EXPIRED' };
      }
      challengeData = JSON.parse(data);
    } else {
      challengeData = this.pendingChallenges.get(sessionId);
      if (!challengeData) {
        this.stats.challengesTimeout++;
        return { valid: false, reason: 'CHALLENGE_EXPIRED' };
      }
    }

    // 验证 challenge ID
    if (challengeData.id !== challengeId) {
      this.stats.challengesFailed++;
      return { valid: false, reason: 'CHALLENGE_ID_MISMATCH' };
    }

    // 验证时间（是否超时）
    const elapsed = Date.now() - challengeData.createdAt;
    if (elapsed > this.challengeTimeout) {
      this.stats.challengesTimeout++;
      return { valid: false, reason: 'CHALLENGE_TIMEOUT' };
    }

    // 计算预期响应
    const expectedResponse = this.calculateExpectedResponse(
      challengeData.nonce,
      challengeData.timestamp
    );

    // 使用时间安全比较验证响应
    try {
      const actualBuffer = Buffer.from(challengeResponse, 'hex');
      const expectedBuffer = Buffer.from(expectedResponse, 'hex');
      
      if (actualBuffer.length !== expectedBuffer.length) {
        this.stats.challengesFailed++;
        return { valid: false, reason: 'RESPONSE_LENGTH_MISMATCH' };
      }
      
      const isValid = crypto.timingSafeEqual(actualBuffer, expectedBuffer);
      
      if (!isValid) {
        this.stats.challengesFailed++;
        
        // 记录失败次数
        await this.recordFailure(sessionId);
        
        return { valid: false, reason: 'RESPONSE_INVALID' };
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Challenge response comparison error');
      this.stats.challengesFailed++;
      return { valid: false, reason: 'RESPONSE_FORMAT_ERROR' };
    }

    // 认证成功
    this.stats.challengesSuccess++;
    this.stats.authCount++;

    // 清理挑战
    await this.clearChallenge(sessionId);

    // 更新认证状态
    await this.updateAuthState(sessionId, true);

    logger.debug({ sessionId, challengeId }, 'Challenge verified successfully');

    return { valid: true };
  }

  /**
   * 计算预期响应
   * @param {string} nonce - 挑战 nonce
   * @param {number} timestamp - 挑战时间戳
   * @returns {string} 预期响应（hex格式）
   */
  calculateExpectedResponse(nonce, timestamp) {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(`${nonce}:${timestamp}`)
      .digest('hex');
  }

  /**
   * 客户端生成挑战响应
   * @param {string} challenge - 挑战 nonce
   * @param {number} timestamp - 挑战时间戳
   * @param {string} secretKey - 密钥
   * @returns {string} 响应（hex格式）
   */
  static generateResponse(challenge, timestamp, secretKey) {
    return crypto
      .createHmac('sha256', secretKey)
      .update(`${challenge}:${timestamp}`)
      .digest('hex');
  }

  /**
   * 清理挑战
   * @param {string} sessionId - 会话ID
   */
  async clearChallenge(sessionId) {
    if (this.redis) {
      await this.redis.del(`ws:challenge:${sessionId}`);
    } else {
      this.pendingChallenges.delete(sessionId);
    }
  }

  /**
   * 记录失败
   * @param {string} sessionId - 会话ID
   */
  async recordFailure(sessionId) {
    if (this.redis) {
      const key = `ws:auth_failures:${sessionId}`;
      const count = await this.redis.incr(key);
      await this.redis.expire(key, 3600); // 1小时过期
      
      // 检查是否达到最大失败次数
      if (count >= this.maxChallengeFailures) {
        logger.warn({ sessionId, failures: count }, 'Max challenge failures reached');
      }
    } else {
      const state = this.authState.get(sessionId) || { failures: 0 };
      state.failures++;
      this.authState.set(sessionId, state);
      
      if (state.failures >= this.maxChallengeFailures) {
        logger.warn({ sessionId, failures: state.failures }, 'Max challenge failures reached');
      }
    }
  }

  /**
   * 更新认证状态
   * @param {string} sessionId - 会话ID
   * @param {boolean} success - 认证是否成功
   */
  async updateAuthState(sessionId, success) {
    if (this.redis) {
      const key = `ws:auth:${sessionId}`;
      
      if (success) {
        const authCount = await this.redis.incr(`ws:auth_count:${sessionId}`);
        await this.redis.set(key, JSON.stringify({
          lastAuth: Date.now(),
          authCount,
          lastSuccess: Date.now()
        }), 'EX', 3600);
        
        // 重置失败计数
        await this.redis.del(`ws:auth_failures:${sessionId}`);
      }
    } else {
      const state = this.authState.get(sessionId) || { 
        lastAuth: 0, 
        authCount: 0, 
        failures: 0 
      };
      
      if (success) {
        state.lastAuth = Date.now();
        state.authCount++;
        state.lastSuccess = Date.now();
        state.failures = 0; // 重置失败计数
      }
      
      this.authState.set(sessionId, state);
    }
  }

  /**
   * 检查是否需要挑战
   * @param {string} sessionId - 会话ID
   * @returns {Promise<boolean>}
   */
  async shouldChallenge(sessionId) {
    if (this.redis) {
      const authData = await this.redis.get(`ws:auth:${sessionId}`);
      if (!authData) return true;
      
      const { lastAuth } = JSON.parse(authData);
      return (Date.now() - lastAuth) > this.challengeInterval;
    }
    
    const state = this.authState.get(sessionId);
    if (!state) return true;
    
    return (Date.now() - state.lastAuth) > this.challengeInterval;
  }

  /**
   * 获取认证状态
   * @param {string} sessionId - 会话ID
   * @returns {Promise<object>}
   */
  async getAuthState(sessionId) {
    if (this.redis) {
      const data = await this.redis.get(`ws:auth:${sessionId}`);
      return data ? JSON.parse(data) : null;
    }
    
    return this.authState.get(sessionId);
  }

  /**
   * 检查会话是否应该断开（失败次数过多）
   * @param {string} sessionId - 会话ID
   * @returns {Promise<boolean>}
   */
  async shouldDisconnect(sessionId) {
    if (this.redis) {
      const failures = parseInt(await this.redis.get(`ws:auth_failures:${sessionId}`) || '0');
      return failures >= this.maxChallengeFailures;
    }
    
    const state = this.authState.get(sessionId);
    return state && state.failures >= this.maxChallengeFailures;
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    return {
      ...this.stats,
      challengeInterval: this.challengeInterval,
      challengeTimeout: this.challengeTimeout,
      maxChallengeFailures: this.maxChallengeFailures,
      pendingChallenges: this.redis ? 'redis' : this.pendingChallenges.size,
      authStates: this.redis ? 'redis' : this.authState.size
    };
  }

  /**
   * 清理过期挑战（定时任务调用）
   */
  async cleanup() {
    if (!this.redis) {
      // 清理本地缓存的过期挑战
      const now = Date.now();
      for (const [sessionId, challenge] of this.pendingChallenges.entries()) {
        if (now - challenge.createdAt > this.challengeTimeout * 2) {
          this.pendingChallenges.delete(sessionId);
          this.stats.challengesTimeout++;
        }
      }
    }
    
    logger.debug('WebSocket challenge auth cleanup completed');
  }
}

module.exports = WebSocketChallengeAuth;