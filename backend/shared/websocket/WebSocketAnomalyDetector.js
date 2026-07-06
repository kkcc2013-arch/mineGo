/**
 * WebSocket 异常检测器
 * REQ-00434: WebSocket 异常行为检测
 * 
 * 功能：
 * - 记录安全违规（消息篡改、重放攻击等）
 * - 检测异常行为模式
 * - 自动断开高风险连接
 * - 发送安全告警
 * - 统计分析
 */

const { logger } = require('../logger');

class WebSocketAnomalyDetector {
  constructor(options = {}) {
    this.redis = options.redis;
    
    // 阈值配置
    this.thresholds = {
      maxViolationsPerMinute: options.maxViolationsPerMinute || 5,
      maxDuplicateMessages: options.maxDuplicateMessages || 10,
      maxSequenceSkips: options.maxSequenceSkips || 3,
      maxChallengeFailures: options.maxChallengeFailures || 3,
      maxTimestampDrift: options.maxTimestampDrift || 60000 // 60秒
    };
    
    // 本地缓存（开发环境）
    this.violationsCache = new Map(); // sessionId -> [{ timestamp, reason }]
    this.recentMessagesCache = new Map(); // sessionId -> [message]
    this.suspiciousIPs = new Map(); // ip -> { violations, firstSeen, lastSeen }
    
    // 统计
    this.stats = {
      totalViolations: 0,
      disconnections: 0,
      alertsSent: 0,
      ipViolations: 0
    };
  }

  /**
   * 记录安全违规
   * @param {object} ws - WebSocket 连接
   * @param {string} reason - 违规原因
   * @param {object} details - 详细信息
   */
  async recordViolation(ws, reason, details = {}) {
    const sessionId = ws.sessionId || 'unknown';
    const ip = ws.handshake?.address || ws._socket?.remoteAddress || 'unknown';

    // 记录到统计
    this.stats.totalViolations++;

    // 按会话记录
    if (this.redis) {
      const sessionKey = `ws:violations:session:${sessionId}`;
      await this.redis.incr(sessionKey);
      await this.redis.expire(sessionKey, 60);
      
      // 详细日志
      await this.redis.lpush(`ws:violations:log:${sessionId}`, JSON.stringify({
        reason,
        details,
        timestamp: Date.now()
      }));
      await this.redis.ltrim(`ws:violations:log:${sessionId}`, 0, 99);
    } else {
      const violations = this.violationsCache.get(sessionId) || [];
      violations.push({ reason, details, timestamp: Date.now() });
      
      // 只保留最近100条
      if (violations.length > 100) {
        violations.shift();
      }
      
      this.violationsCache.set(sessionId, violations);
    }

    // 按 IP 记录
    if (this.redis) {
      const ipKey = `ws:violations:ip:${ip}`;
      await this.redis.incr(ipKey);
      await this.redis.expire(ipKey, 60);
    } else {
      const ipData = this.suspiciousIPs.get(ip) || { violations: 0, firstSeen: Date.now() };
      ipData.violations++;
      ipData.lastSeen = Date.now();
      this.suspiciousIPs.set(ip, ipData);
      this.stats.ipViolations++;
    }

    logger.warn({
      sessionId,
      ip,
      reason,
      details,
      violations: await this.getSessionViolationCount(sessionId)
    }, 'WebSocket security violation recorded');

    // 检查是否需要发送告警
    if (await this.shouldAlert(sessionId)) {
      await this.sendSecurityAlert(sessionId, ip, reason, details);
    }
  }

  /**
   * 获取会话违规次数
   * @param {string} sessionId - 会话ID
   * @returns {Promise<number>}
   */
  async getSessionViolationCount(sessionId) {
    if (this.redis) {
      return parseInt(await this.redis.get(`ws:violations:session:${sessionId}`) || '0');
    }
    
    const violations = this.violationsCache.get(sessionId) || [];
    const oneMinuteAgo = Date.now() - 60000;
    return violations.filter(v => v.timestamp > oneMinuteAgo).length;
  }

  /**
   * 判断是否应该断开连接
   * @param {object} ws - WebSocket 连接
   * @returns {Promise<{shouldDisconnect: boolean, reason?: string}>}
   */
  async shouldDisconnect(ws) {
    const sessionId = ws.sessionId || 'unknown';
    const ip = ws.handshake?.address || ws._socket?.remoteAddress || 'unknown';

    // 检查会话违规次数
    const sessionViolations = await this.getSessionViolationCount(sessionId);
    if (sessionViolations > this.thresholds.maxViolationsPerMinute) {
      return { 
        shouldDisconnect: true, 
        reason: `Session violations exceeded threshold (${sessionViolations} > ${this.thresholds.maxViolationsPerMinute})` 
      };
    }

    // 检查 IP 违规次数
    const ipViolations = await this.getIPViolationCount(ip);
    if (ipViolations > this.thresholds.maxViolationsPerMinute * 2) {
      return { 
        shouldDisconnect: true, 
        reason: `IP violations exceeded threshold (${ipViolations} > ${this.thresholds.maxViolationsPerMinute * 2})` 
      };
    }

    return { shouldDisconnect: false };
  }

  /**
   * 获取 IP 违规次数
   * @param {string} ip - IP地址
   * @returns {Promise<number>}
   */
  async getIPViolationCount(ip) {
    if (this.redis) {
      return parseInt(await this.redis.get(`ws:violations:ip:${ip}`) || '0');
    }
    
    const ipData = this.suspiciousIPs.get(ip);
    return ipData ? ipData.violations : 0;
  }

  /**
   * 判断是否应该发送告警
   * @param {string} sessionId - 会话ID
   * @returns {Promise<boolean>}
   */
  async shouldAlert(sessionId) {
    const violations = await this.getSessionViolationCount(sessionId);
    return violations >= 3;
  }

  /**
   * 发送安全告警
   * @param {string} sessionId - 会话ID
   * @param {string} ip - IP地址
   * @param {string} reason - 告警原因
   * @param {object} details - 详细信息
   */
  async sendSecurityAlert(sessionId, ip, reason, details) {
    this.stats.alertsSent++;

    const alert = {
      type: 'websocket_security_violation',
      sessionId,
      ip,
      reason,
      details,
      timestamp: Date.now(),
      severity: 'high'
    };

    logger.error(alert, 'WebSocket security alert');

    // 发送到监控系统（通过 Redis pub/sub）
    if (this.redis) {
      await this.redis.publish('security:alert', JSON.stringify(alert));
    }

    // TODO: 发送到外部告警系统（如 PagerDuty、Slack）
  }

  /**
   * 检测重放攻击模式
   * @param {object} ws - WebSocket 连接
   * @param {object} message - 消息对象
   * @returns {Promise<{detected: boolean, details?: object}>}
   */
  async detectReplayPattern(ws, message) {
    const sessionId = ws.sessionId || 'unknown';
    const meta = message._meta;
    
    if (!meta) return { detected: false };

    // 检查最近消息列表
    const recentKey = `ws:recent:${sessionId}`;
    let recent;
    
    if (this.redis) {
      recent = await this.redis.lrange(recentKey, 0, 9);
    } else {
      recent = this.recentMessagesCache.get(sessionId) || [];
    }

    // 检查是否有相似消息（相同类型、相近时间戳）
    const similarCount = recent.filter(m => {
      const parsed = typeof m === 'string' ? JSON.parse(m) : m;
      return parsed.type === message.type && 
             parsed._meta?.nonce === meta.nonce;
    }).length;

    // 如果有重复 nonce，很可能是重放攻击
    if (similarCount > 0) {
      return {
        detected: true,
        details: {
          message,
          duplicateCount: similarCount,
          reason: 'DUPLICATE_NONCE'
        }
      };
    }

    // 检查时间戳异常（未来时间或过于久远）
    const now = Date.now();
    const timestampDrift = Math.abs(now - meta.timestamp);
    
    if (timestampDrift > this.thresholds.maxTimestampDrift) {
      return {
        detected: true,
        details: {
          message,
          timestamp: meta.timestamp,
          drift: timestampDrift,
          reason: 'TIMESTAMP_ANOMALY'
        }
      };
    }

    // 记录消息到最近列表
    await this.recordRecentMessage(sessionId, message);

    return { detected: false };
  }

  /**
   * 记录最近消息
   * @param {string} sessionId - 会话ID
   * @param {object} message - 消息对象
   */
  async recordRecentMessage(sessionId, message) {
    const recentKey = `ws:recent:${sessionId}`;
    const messageStr = JSON.stringify(message);
    
    if (this.redis) {
      await this.redis.lpush(recentKey, messageStr);
      await this.redis.ltrim(recentKey, 0, 99);
      await this.redis.expire(recentKey, 60);
    } else {
      let recent = this.recentMessagesCache.get(sessionId) || [];
      recent.unshift(messageStr);
      
      // 只保留最近100条
      if (recent.length > 100) {
        recent = recent.slice(0, 100);
      }
      
      this.recentMessagesCache.set(sessionId, recent);
    }
  }

  /**
   * 记录断开连接
   * @param {string} sessionId - 会话ID
   * @param {string} reason - 断开原因
   */
  recordDisconnection(sessionId, reason) {
    this.stats.disconnections++;
    
    logger.info({
      sessionId,
      reason,
      totalDisconnections: this.stats.disconnections
    }, 'WebSocket disconnected due to security violation');
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    return {
      ...this.stats,
      thresholds: this.thresholds,
      cacheSizes: {
        violations: this.violationsCache.size,
        recentMessages: this.recentMessagesCache.size,
        suspiciousIPs: this.suspiciousIPs.size
      }
    };
  }

  /**
   * 清理过期数据（定时任务调用）
   */
  async cleanup() {
    if (!this.redis) {
      const now = Date.now();
      
      // 清理过期的违规记录
      for (const [sessionId, violations] of this.violationsCache.entries()) {
        const oneMinuteAgo = now - 60000;
        const filtered = violations.filter(v => v.timestamp > oneMinuteAgo);
        
        if (filtered.length === 0) {
          this.violationsCache.delete(sessionId);
        } else {
          this.violationsCache.set(sessionId, filtered);
        }
      }
      
      // 清理过期的最近消息
      for (const [sessionId] of this.recentMessagesCache.entries()) {
        // 消息缓存通过过期时间自动清理
      }
    }
    
    logger.debug('WebSocket anomaly detector cleanup completed');
  }
}

module.exports = WebSocketAnomalyDetector;