/**
 * 反作弊响应引擎
 * 执行反作弊措施和响应动作
 * 
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 */

'use strict';

const { logger, metrics } = require('../../shared/logging');
const { v4: uuidv4 } = require('uuid');

/**
 * 反作弊响应类型
 */
const ResponseTypes = {
  BAN: 'ban',
  SUSPEND: 'suspend',
  SHADOW_BAN: 'shadow_ban',
  WARN: 'warn',
  FLAG: 'flag',
  MONITOR: 'monitor'
};

/**
 * 违规严重度
 */
const SeverityLevels = {
  LOW: 30,
  MEDIUM: 50,
  HIGH: 70,
  CRITICAL: 90
};

/**
 * 反作弊响应引擎
 */
class AntiCheatResponse {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    
    this.config = {
      // 封禁时长配置
      banDurations: {
        permanent: null,
        temporary: {
          first: 7 * 24 * 60 * 60 * 1000,  // 7 天
          second: 30 * 24 * 60 * 60 * 1000, // 30 天
          third: null // 永久
        }
      },
      // 影子封禁配置
      shadowBanEffects: {
        reduced_spawn_rate: 0.5,
        increased_flee_rate: 0.8,
        reduced_item_drop: 0.5
      },
      // 申诉配置
      appealConfig: {
        enabled: true,
        cooldownDays: 7
      },
      ...config
    };
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    if (metrics && metrics.counter) {
      metrics.counter('anti_cheat_action_taken_total', 'Anti-cheat actions taken', ['action_type', 'reason']);
      metrics.counter('anti_cheat_violation_detected_total', 'Violations detected', ['violation_type']);
      metrics.gauge('anti_cheat_active_bans', 'Currently active bans');
      metrics.gauge('anti_cheat_active_shadow_bans', 'Currently active shadow bans');
    }
  }
  
  /**
   * 处理违规
   * @param {number} userId - 用户 ID
   * @param {Object} violation - 违规信息
   * @returns {Object} 响应结果
   */
  async handleViolation(userId, violation) {
    const responseId = uuidv4();
    
    try {
      // 获取违规历史
      const history = await this.getViolationHistory(userId);
      
      // 计算严重度
      const severity = this.calculateSeverity(violation, history);
      
      // 确定响应措施
      const response = await this.determineResponse(userId, violation, history, severity);
      
      // 执行响应
      const result = await this.executeResponse(userId, response);
      
      // 记录日志
      await this.logResponse(userId, responseId, violation, response, result);
      
      // 更新指标
      this.updateMetrics(response.type, violation.type);
      
      return {
        responseId,
        userId,
        responseType: response.type,
        severity,
        result,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('Failed to handle violation', {
        userId,
        violation,
        error: error.message
      });
      
      // 失败时降级为标记审核
      return {
        responseId,
        userId,
        responseType: ResponseTypes.FLAG,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * 确定响应措施
   */
  async determineResponse(userId, violation, history, severity) {
    // 根据严重度确定响应类型
    if (severity >= SeverityLevels.CRITICAL) {
      return {
        type: ResponseTypes.BAN,
        duration: 'permanent',
        reason: violation.type,
        evidence: violation.evidence,
        appealable: true
      };
    }
    
    if (severity >= SeverityLevels.HIGH) {
      // 根据历史记录决定封禁时长
      const banCount = history.filter(h => h.responseType === ResponseTypes.BAN).length;
      
      return {
        type: ResponseTypes.SUSPEND,
        duration: this.config.banDurations.temporary[banCount] || 'permanent',
        reason: violation.type,
        evidence: violation.evidence,
        appealable: true
      };
    }
    
    if (severity >= SeverityLevels.MEDIUM) {
      return {
        type: ResponseTypes.SHADOW_BAN,
        duration: 30 * 24 * 60 * 60 * 1000, // 30 天
        effects: this.config.shadowBanEffects,
        reason: violation.type,
        appealable: true
      };
    }
    
    if (severity >= SeverityLevels.LOW) {
      // 检查是否已有警告
      const warningCount = history.filter(h => 
        h.responseType === ResponseTypes.WARN && 
        Date.now() - new Date(h.createdAt) < 7 * 24 * 60 * 60 * 1000
      ).length;
      
      if (warningCount >= 2) {
        // 多次警告后升级
        return {
          type: ResponseTypes.SHADOW_BAN,
          duration: 7 * 24 * 60 * 60 * 1000,
          effects: { reduced_spawn_rate: 0.7 },
          reason: 'multiple_warnings',
          appealable: false
        };
      }
      
      return {
        type: ResponseTypes.WARN,
        message: 'suspicious_activity_detected',
        strike: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      };
    }
    
    return {
      type: ResponseTypes.FLAG,
      reason: violation.type,
      review: true
    };
  }
  
  /**
   * 执行响应措施
   */
  async executeResponse(userId, response) {
    switch (response.type) {
      case ResponseTypes.BAN:
        return await this.banUser(userId, response);
        
      case ResponseTypes.SUSPEND:
        return await this.suspendUser(userId, response);
        
      case ResponseTypes.SHADOW_BAN:
        return await this.shadowBanUser(userId, response);
        
      case ResponseTypes.WARN:
        return await this.warnUser(userId, response);
        
      case ResponseTypes.FLAG:
        return await this.flagForReview(userId, response);
        
      default:
        return await this.monitorUser(userId, response);
    }
  }
  
  /**
   * 封禁用户
   */
  async banUser(userId, response) {
    try {
      const expiresAt = response.duration === 'permanent' ? null : new Date(Date.now() + response.duration);
      
      await this.db.query(`
        INSERT INTO user_bans (
          user_id, ban_type, reason, evidence, expires_at, created_at
        ) VALUES ($1, 'permanent', $2, $3, $4, NOW())
      `, [userId, response.reason, JSON.stringify(response.evidence), expiresAt]);
      
      // 清除所有会话
      await this.redis.del(`user_sessions:${userId}:*`);
      
      // 加入封禁列表
      await this.redis.sadd('banned_users', userId.toString());
      
      // 发送通知
      await this.notifyUser(userId, 'account_banned', {
        reason: response.reason,
        appealable: response.appealable,
        expiresAt
      });
      
      logger.info('User banned', { userId, reason: response.reason, expiresAt });
      
      return {
        success: true,
        action: 'ban',
        expiresAt,
        appealable: response.appealable
      };
      
    } catch (error) {
      logger.error('Failed to ban user', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 暂停用户
   */
  async suspendUser(userId, response) {
    try {
      const expiresAt = new Date(Date.now() + response.duration);
      
      await this.db.query(`
        INSERT INTO user_bans (
          user_id, ban_type, reason, evidence, expires_at, created_at
        ) VALUES ($1, 'temporary', $2, $3, $4, NOW())
      `, [userId, response.reason, JSON.stringify(response.evidence), expiresAt]);
      
      // 暂时禁用会话
      await this.redis.setex(`user_suspended:${userId}`, response.duration / 1000, '1');
      
      // 发送通知
      await this.notifyUser(userId, 'account_suspended', {
        reason: response.reason,
        expiresAt,
        appealable: response.appealable
      });
      
      logger.info('User suspended', { userId, reason: response.reason, expiresAt });
      
      return {
        success: true,
        action: 'suspend',
        expiresAt,
        appealable: response.appealable
      };
      
    } catch (error) {
      logger.error('Failed to suspend user', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 影子封禁用户
   */
  async shadowBanUser(userId, response) {
    try {
      const expiresAt = new Date(Date.now() + response.duration);
      
      // 设置影子封禁标记
      await this.redis.hset(`user_shadow_ban:${userId}`, {
        active: '1',
        expiresAt: expiresAt.toISOString(),
        effects: JSON.stringify(response.effects)
      });
      
      await this.redis.expire(`user_shadow_ban:${userId}`, response.duration / 1000);
      
      // 记录到数据库
      await this.db.query(`
        INSERT INTO user_shadow_bans (
          user_id, effects, reason, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `, [userId, JSON.stringify(response.effects), response.reason, expiresAt]);
      
      // 不通知用户（影子封禁的要点）
      logger.info('User shadow banned', { userId, reason: response.reason, expiresAt });
      
      return {
        success: true,
        action: 'shadow_ban',
        expiresAt,
        effects: response.effects
      };
      
    } catch (error) {
      logger.error('Failed to shadow ban user', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 警告用户
   */
  async warnUser(userId, response) {
    try {
      // 记录警告
      await this.db.query(`
        INSERT INTO user_warnings (
          user_id, message, strike, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `, [userId, response.message, response.strike, response.expiresAt]);
      
      // 发送通知
      await this.notifyUser(userId, 'account_warning', {
        message: response.message,
        strike: response.strike,
        expiresAt: response.expiresAt
      });
      
      logger.info('User warned', { userId, message: response.message });
      
      return {
        success: true,
        action: 'warn',
        strike: response.strike,
        expiresAt: response.expiresAt
      };
      
    } catch (error) {
      logger.error('Failed to warn user', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 标记用户待审核
   */
  async flagForReview(userId, response) {
    try {
      await this.db.query(`
        INSERT INTO review_queue (
          user_id, reason, status, created_at
        ) VALUES ($1, $2, 'pending', NOW())
      `, [userId, response.reason]);
      
      // 通知管理员
      await this.notifyAdmins('user_flagged', {
        userId,
        reason: response.reason
      });
      
      logger.info('User flagged for review', { userId, reason: response.reason });
      
      return {
        success: true,
        action: 'flag',
        status: 'pending_review'
      };
      
    } catch (error) {
      logger.error('Failed to flag user', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 监控用户
   */
  async monitorUser(userId, response) {
    try {
      // 增加用户监控等级
      await this.redis.hincrby(`user_monitor:${userId}`, 'level', 1);
      await this.redis.expire(`user_monitor:${userId}`, 24 * 60 * 60); // 24 小时
      
      logger.info('User set for monitoring', { userId, reason: response.reason });
      
      return {
        success: true,
        action: 'monitor',
        reason: response.reason
      };
      
    } catch (error) {
      logger.error('Failed to set user for monitoring', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 获取违规历史
   */
  async getViolationHistory(userId) {
    try {
      const result = await this.db.query(`
        SELECT 
          violation_type as type,
          severity,
          response_type,
          created_at
        FROM security_violations
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId]);
      
      return result.rows;
      
    } catch (error) {
      logger.error('Failed to get violation history', { userId, error: error.message });
      return [];
    }
  }
  
  /**
   * 计算严重度
   */
  calculateSeverity(violation, history) {
    let severity = violation.severity || SeverityLevels.MEDIUM;
    
    // 根据违规类型调整
    const typeSeverity = {
      'mock_location_detected': SeverityLevels.CRITICAL,
      'hook_framework_detected': SeverityLevels.CRITICAL,
      'emulator_detected': SeverityLevels.HIGH,
      'root_detected': SeverityLevels.HIGH,
      'impossible_travel': SeverityLevels.CRITICAL,
      'automated_pattern': SeverityLevels.HIGH,
      'abnormal_success_rate': SeverityLevels.MEDIUM,
      'rare_pokemon_anomaly': SeverityLevels.HIGH,
      'sensor_anomaly': SeverityLevels.MEDIUM
    };
    
    severity = typeSeverity[violation.type] || severity;
    
    // 根据历史记录加重
    const recentViolations = history.filter(h => 
      Date.now() - new Date(h.created_at) < 30 * 24 * 60 * 60 * 1000
    ).length;
    
    if (recentViolations >= 3) {
      severity = Math.min(100, severity + 20);
    } else if (recentViolations >= 1) {
      severity = Math.min(100, severity + 10);
    }
    
    return severity;
  }
  
  /**
   * 记录响应日志
   */
  async logResponse(userId, responseId, violation, response, result) {
    try {
      await this.db.query(`
        INSERT INTO security_response_logs (
          id, user_id, violation_type, violation_details,
          response_type, response_details, result, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        responseId,
        userId,
        violation.type,
        JSON.stringify(violation),
        response.type,
        JSON.stringify(response),
        JSON.stringify(result)
      ]);
      
    } catch (error) {
      logger.error('Failed to log response', { responseId, error: error.message });
    }
  }
  
  /**
   * 通知用户
   */
  async notifyUser(userId, type, data) {
    try {
      // 通过 WebSocket 或推送通知
      await this.redis.publish(`user_notifications:${userId}`, JSON.stringify({
        type,
        data,
        timestamp: new Date().toISOString()
      }));
      
    } catch (error) {
      logger.error('Failed to notify user', { userId, error: error.message });
    }
  }
  
  /**
   * 通知管理员
   */
  async notifyAdmins(type, data) {
    try {
      await this.redis.publish('admin_notifications', JSON.stringify({
        type,
        data,
        timestamp: new Date().toISOString()
      }));
      
    } catch (error) {
      logger.error('Failed to notify admins', { error: error.message });
    }
  }
  
  /**
   * 更新指标
   */
  updateMetrics(actionType, violationType) {
    if (metrics) {
      metrics.inc('anti_cheat_action_taken_total', { 
        action_type: actionType, 
        reason: violationType 
      });
      metrics.inc('anti_cheat_violation_detected_total', { 
        violation_type: violationType 
      });
    }
  }
  
  /**
   * 检查用户是否被封禁
   */
  async isUserBanned(userId) {
    try {
      // 检查 Redis 缓存
      const banned = await this.redis.sismember('banned_users', userId.toString());
      if (banned === 1) return true;
      
      // 检查数据库
      const result = await this.db.query(`
        SELECT 1 FROM user_bans
        WHERE user_id = $1 
        AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `, [userId]);
      
      return result.rows.length > 0;
      
    } catch {
      return false;
    }
  }
  
  /**
   * 检查用户是否被影子封禁
   */
  async isUserShadowBanned(userId) {
    try {
      const data = await this.redis.hgetall(`user_shadow_ban:${userId}`);
      if (!data || data.active !== '1') return false;
      
      const expiresAt = new Date(data.expiresAt);
      return expiresAt > new Date();
      
    } catch {
      return false;
    }
  }
  
  /**
   * 获取影子封禁效果
   */
  async getShadowBanEffects(userId) {
    try {
      const data = await this.redis.hgetall(`user_shadow_ban:${userId}`);
      if (!data || data.active !== '1') return null;
      
      return JSON.parse(data.effects);
      
    } catch {
      return null;
    }
  }
}

module.exports = AntiCheatResponse;
module.exports.ResponseTypes = ResponseTypes;
module.exports.SeverityLevels = SeverityLevels;
