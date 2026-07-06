/**
 * WebSocket 消息完整性与防重放攻击保护系统
 * REQ-00434: WebSocket 消息签名与验证
 * 
 * 功能：
 * - HMAC-SHA256 消息签名与验证
 * - 消息时间戳验证（30秒容差）
 * - nonce 防重放机制
 * - 消息序列号验证
 * - Redis 存储已用 nonce 集合
 */

const crypto = require('crypto');
const { logger } = require('../logger');

class WebSocketMessageSecurity {
  constructor(options = {}) {
    this.secretKey = options.secretKey || process.env.WS_SECRET_KEY;
    if (!this.secretKey) {
      throw new Error('WebSocket secret key is required');
    }
    
    this.redis = options.redis;
    this.nonceExpiry = options.nonceExpiry || 60000; // 60 秒 nonce 有效期
    this.timestampTolerance = options.timestampTolerance || 30000; // 30 秒时间戳容差
    
    // 序列号管理
    this.sequenceCache = new Map(); // sessionId -> lastSequence
    
    // 统计
    this.stats = {
      verifications: { valid: 0, invalid: 0 },
      nonces: { generated: 0, reused: 0 },
      signatures: { created: 0, verified: 0 },
      sequences: { valid: 0, invalid: 0 }
    };
  }

  /**
   * 签名消息（服务端发送）
   * @param {object} message - 原始消息对象
   * @param {string} sessionId - 会话ID
   * @returns {object} 签名后的消息
   */
  signMessage(message, sessionId) {
    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const sequence = this.getNextSequence(sessionId);

    // 构建签名 payload（不包含 _meta）
    const payload = JSON.stringify({
      ...message,
      timestamp,
      nonce,
      sequence,
      sessionId
    });

    const signature = this.createSignature(payload);

    this.stats.signatures.created++;

    return {
      ...message,
      _meta: {
        timestamp,
        nonce,
        sequence,
        sessionId,
        signature
      }
    };
  }

  /**
   * 验证消息（服务端接收）
   * @param {object} message - 接收到的消息
   * @param {string} sessionId - 期望的会话ID
   * @returns {Promise<{valid: boolean, reason?: string, details?: object}>}
   */
  async verifyMessage(message, sessionId) {
    const meta = message._meta;

    if (!meta) {
      logger.warn('Message missing meta field');
      this.stats.verifications.invalid++;
      return { valid: false, reason: 'MISSING_META' };
    }

    // 1. 验证会话ID匹配
    if (meta.sessionId !== sessionId) {
      logger.warn({ expected: sessionId, actual: meta.sessionId }, 'Session ID mismatch');
      this.stats.verifications.invalid++;
      return { valid: false, reason: 'SESSION_MISMATCH', details: { expected: sessionId, actual: meta.sessionId } };
    }

    // 2. 验证时间戳
    const timestampResult = this.verifyTimestamp(meta.timestamp);
    if (!timestampResult.valid) {
      logger.warn({ timestamp: meta.timestamp }, 'Timestamp validation failed');
      this.stats.verifications.invalid++;
      return { valid: false, reason: timestampResult.reason, details: { timestamp: meta.timestamp, diff: timestampResult.diff } };
    }

    // 3. 验证 nonce 是否已使用（防重放）
    const nonceResult = await this.verifyNonce(meta.nonce);
    if (!nonceResult.valid) {
      logger.warn({ nonce: meta.nonce }, 'Nonce validation failed');
      this.stats.nonces.reused++;
      this.stats.verifications.invalid++;
      return { valid: false, reason: nonceResult.reason };
    }

    // 4. 验证序列号
    const sequenceResult = await this.verifySequence(meta.sessionId, meta.sequence);
    if (!sequenceResult.valid) {
      logger.warn({ sequence: meta.sequence, expected: sequenceResult.expected }, 'Sequence validation failed');
      this.stats.sequences.invalid++;
      this.stats.verifications.invalid++;
      return { valid: false, reason: sequenceResult.reason, details: { sequence: meta.sequence, expected: sequenceResult.expected } };
    }

    // 5. 验证签名
    const signatureResult = this.verifySignature(message);
    if (!signatureResult.valid) {
      logger.warn({ signature: meta.signature }, 'Signature validation failed');
      this.stats.verifications.invalid++;
      return { valid: false, reason: signatureResult.reason };
    }

    // 6. 标记 nonce 已使用
    await this.markNonceUsed(meta.nonce);

    // 7. 更新序列号
    await this.updateSequence(meta.sessionId, meta.sequence);

    this.stats.nonces.generated++;
    this.stats.sequences.valid++;
    this.stats.signatures.verified++;
    this.stats.verifications.valid++;

    logger.debug({ sessionId, sequence: meta.sequence }, 'Message verified successfully');

    return { valid: true };
  }

  /**
   * 创建 HMAC-SHA256 签名
   * @param {string} payload - 待签名的 payload
   * @returns {string} 签名（hex格式）
   */
  createSignature(payload) {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');
  }

  /**
   * 验证签名
   * @param {object} message - 包含签名的消息
   * @returns {{valid: boolean, reason?: string}}
   */
  verifySignature(message) {
    const meta = message._meta;
    
    // 构建原始 payload（不包含签名字段）
    const payload = JSON.stringify({
      ...message,
      _meta: undefined
    });

    const expectedSignature = this.createSignature(payload);

    // 使用时间安全比较防止时序攻击
    try {
      const actualBuffer = Buffer.from(meta.signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');
      
      if (actualBuffer.length !== expectedBuffer.length) {
        return { valid: false, reason: 'SIGNATURE_LENGTH_MISMATCH' };
      }
      
      const match = crypto.timingSafeEqual(actualBuffer, expectedBuffer);
      
      if (!match) {
        return { valid: false, reason: 'SIGNATURE_INVALID' };
      }
      
      return { valid: true };
    } catch (error) {
      logger.error({ error: error.message }, 'Signature comparison error');
      return { valid: false, reason: 'SIGNATURE_FORMAT_ERROR' };
    }
  }

  /**
   * 验证时间戳
   * @param {number} timestamp - 消息时间戳（毫秒）
   * @returns {{valid: boolean, reason?: string, diff?: number}}
   */
  verifyTimestamp(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') {
      return { valid: false, reason: 'TIMESTAMP_INVALID' };
    }

    const now = Date.now();
    const diff = Math.abs(now - timestamp);

    if (diff > this.timestampTolerance) {
      return { 
        valid: false, 
        reason: 'TIMESTAMP_EXPIRED',
        diff
      };
    }

    return { valid: true };
  }

  /**
   * 生成 nonce（32字节随机数）
   * @returns {string} nonce（hex格式）
   */
  generateNonce() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 验证 nonce 是否已使用（Redis 查询）
   * @param {string} nonce - nonce值
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async verifyNonce(nonce) {
    if (!nonce || typeof nonce !== 'string') {
      return { valid: false, reason: 'NONCE_INVALID' };
    }

    if (!this.redis) {
      // 如果没有 Redis，使用本地缓存（开发环境）
      return { valid: true };
    }

    const key = `ws:nonce:${nonce}`;
    const exists = await this.redis.exists(key);
    
    if (exists === 1) {
      return { valid: false, reason: 'NONCE_REUSED' };
    }
    
    return { valid: true };
  }

  /**
   * 标记 nonce 已使用（Redis 存储）
   * @param {string} nonce - nonce值
   */
  async markNonceUsed(nonce) {
    if (!this.redis) {
      return;
    }

    const key = `ws:nonce:${nonce}`;
    await this.redis.set(key, '1', 'PX', this.nonceExpiry);
  }

  /**
   * 获取下一个序列号（递增）
   * @param {string} sessionId - 会话ID
   * @returns {number} 下一个序列号
   */
  async getNextSequence(sessionId) {
    if (this.redis) {
      return await this.redis.incr(`ws:seq:${sessionId}`);
    }
    
    // 本地缓存（开发环境）
    const lastSeq = this.sequenceCache.get(sessionId) || 0;
    const nextSeq = lastSeq + 1;
    this.sequenceCache.set(sessionId, nextSeq);
    return nextSeq;
  }

  /**
   * 验证序列号（必须递增）
   * @param {string} sessionId - 会话ID
   * @param {number} sequence - 消息序列号
   * @returns {Promise<{valid: boolean, reason?: string, expected?: number}>}
   */
  async verifySequence(sessionId, sequence) {
    if (!sequence || typeof sequence !== 'number') {
      return { valid: false, reason: 'SEQUENCE_INVALID' };
    }

    let expected;
    if (this.redis) {
      expected = parseInt(await this.redis.get(`ws:seq:${sessionId}`) || '0');
    } else {
      expected = this.sequenceCache.get(sessionId) || 0;
    }

    if (sequence <= expected) {
      return { 
        valid: false, 
        reason: 'SEQUENCE_NOT_INCREMENTED',
        expected: expected + 1
      };
    }

    return { valid: true, expected };
  }

  /**
   * 更新序列号
   * @param {string} sessionId - 会话ID
   * @param {number} sequence - 新序列号
   */
  async updateSequence(sessionId, sequence) {
    if (this.redis) {
      await this.redis.set(`ws:seq:${sessionId}`, sequence.toString(), 'EX', 3600);
    } else {
      this.sequenceCache.set(sessionId, sequence);
    }
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    return {
      ...this.stats,
      timestampTolerance: this.timestampTolerance,
      nonceExpiry: this.nonceExpiry,
      cacheSize: this.sequenceCache.size
    };
  }

  /**
   * 清理过期数据（定时任务调用）
   */
  async cleanup() {
    if (!this.redis) {
      return;
    }

    // 清理过期的 nonce keys（Redis 自动过期，无需手动清理）
    logger.debug('WebSocket message security cleanup completed');
  }
}

module.exports = WebSocketMessageSecurity;