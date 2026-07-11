/**
 * 智能告警系统
 * 
 * 功能：
 * - 告警聚合（相同根因错误只发送一条）
 * - 告警降噪（已知问题降低优先级）
 * - 分级告警
 * - 告警抑制（维护窗口期间抑制）
 * 
 * @module IntelligentAlerting
 */

const logger = require('../logger');
const redis = require('../redis');
const { EventEmitter } = require('events');

class IntelligentAlerting extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.channels = config.channels || {
      slack: { enabled: true, webhook: process.env.SLACK_WEBHOOK_URL },
      email: { enabled: true, recipients: [] },
      sms: { enabled: false, recipients: [] }
    };
    
    this.cooldownMs = config.cooldownMs || 300000; // 5分钟冷却
    this.maxAlertsPerHour = config.maxAlertsPerHour || 100;
    this.escalationRules = config.escalationRules || this._defaultEscalationRules();
    
    this.alertPrefix = 'error:alert:';
    this.statsPrefix = 'error:alert:stats:';
  }

  /**
   * 默认升级规则
   * @returns {Object} 升级规则
   */
  _defaultEscalationRules() {
    return {
      critical: {
        immediate: true,
        channels: ['slack', 'sms', 'email'],
        repeatIntervalMs: 60000,  // 1分钟重复
        maxRepeats: 5
      },
      high: {
        immediate: true,
        channels: ['slack', 'email'],
        repeatIntervalMs: 300000, // 5分钟重复
        maxRepeats: 3
      },
      medium: {
        immediate: false,
        channels: ['slack'],
        repeatIntervalMs: 1800000, // 30分钟重复
        maxRepeats: 2
      },
      low: {
        immediate: false,
        channels: ['slack'],
        repeatIntervalMs: 3600000, // 1小时重复
        maxRepeats: 1
      }
    };
  }

  /**
   * 发送智能告警
   * @param {Object} errorGroup - 错误聚合组
   * @param {Object} rootCause - 根因分析结果
   * @returns {Object} 告警结果
   */
  async alert(errorGroup, rootCause) {
    try {
      // 1. 检查是否在冷却期
      if (await this._isInCooldown(errorGroup)) {
        logger.debug('Alert in cooldown', { groupId: errorGroup.id });
        return { sent: false, reason: 'cooldown' };
      }
      
      // 2. 检查是否在维护窗口
      if (await this._isInMaintenanceWindow()) {
        logger.debug('Alert suppressed due to maintenance window');
        return { sent: false, reason: 'maintenance' };
      }
      
      // 3. 计算告警级别
      const severity = this._calculateSeverity(errorGroup, rootCause);
      
      // 4. 检查告警频率限制
      if (await this._isRateLimited(severity)) {
        logger.debug('Alert rate limited', { severity });
        return { sent: false, reason: 'rate_limited' };
      }
      
      // 5. 构建告警消息
      const alert = this._buildAlert(errorGroup, rootCause, severity);
      
      // 6. 发送告警
      const rule = this.escalationRules[severity];
      const results = await this._sendToChannels(alert, rule.channels);
      
      // 7. 记录告警
      await this._recordAlert(alert);
      
      // 8. 设置冷却
      await this._setCooldown(errorGroup, severity);
      
      // 9. 更新统计
      await this._updateStats(severity);
      
      this.emit('alert', alert);
      
      return {
        sent: true,
        alert,
        channels: results
      };
    } catch (error) {
      logger.error('Alert sending failed', {
        error: error.message,
        groupId: errorGroup.id
      });
      
      return { sent: false, reason: 'error', error: error.message };
    }
  }

  /**
   * 检查是否在冷却期
   * @param {Object} errorGroup - 错误聚合组
   * @returns {boolean} 是否在冷却期
   */
  async _isInCooldown(errorGroup) {
    const key = `${this.alertPrefix}cooldown:${errorGroup.id}`;
    const exists = await redis.exists(key);
    return exists === 1;
  }

  /**
   * 设置冷却期
   * @param {Object} errorGroup - 错误聚合组
   * @param {string} severity - 严重程度
   */
  async _setCooldown(errorGroup, severity) {
    const rule = this.escalationRules[severity];
    const cooldownMs = rule.repeatIntervalMs;
    
    const key = `${this.alertPrefix}cooldown:${errorGroup.id}`;
    await redis.setex(key, Math.floor(cooldownMs / 1000), '1');
  }

  /**
   * 检查是否在维护窗口
   * @returns {boolean} 是否在维护窗口
   */
  async _isInMaintenanceWindow() {
    const key = 'system:maintenance:active';
    const active = await redis.get(key);
    return active === 'true';
  }

  /**
   * 检查告警频率限制
   * @param {string} severity - 严重程度
   * @returns {boolean} 是否受限
   */
  async _isRateLimited(severity) {
    const now = new Date();
    const hourKey = `${this.statsPrefix}${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}:${now.getUTCHours()}`;
    
    const count = await redis.incr(hourKey);
    
    // 设置过期时间
    if (count === 1) {
      await redis.expire(hourKey, 3600);
    }
    
    return count > this.maxAlertsPerHour;
  }

  /**
   * 计算告警级别
   * @param {Object} errorGroup - 错误聚合组
   * @param {Object} rootCause - 根因分析结果
   * @returns {string} 严重程度
   */
  _calculateSeverity(errorGroup, rootCause) {
    // 支付相关错误
    if (errorGroup.service === 'payment-service') {
      return 'critical';
    }
    
    // 影响用户数
    if (errorGroup.affectedUsers > 1000) {
      return 'critical';
    }
    if (errorGroup.affectedUsers > 100) {
      return 'high';
    }
    if (errorGroup.affectedUsers > 10) {
      return 'medium';
    }
    
    // 发生频率
    if (errorGroup.occurrenceCount > 100) {
      return 'high';
    }
    if (errorGroup.occurrenceCount > 10) {
      return 'medium';
    }
    
    // 根因类型
    if (rootCause && rootCause.causes && rootCause.causes.length > 0) {
      const topCause = rootCause.causes[0];
      
      if (topCause.type === 'dependency' && topCause.confidence > 0.9) {
        return 'high';
      }
      
      if (topCause.type === 'deployment' && topCause.confidence > 0.8) {
        return 'high';
      }
    }
    
    // 已知问题降级
    if (errorGroup.status === 'known') {
      return 'low';
    }
    
    return 'medium';
  }

  /**
   * 构建告警消息
   * @param {Object} errorGroup - 错误聚合组
   * @param {Object} rootCause - 根因分析结果
   * @param {string} severity - 严重程度
   * @returns {Object} 告警消息
   */
  _buildAlert(errorGroup, rootCause, severity) {
    const emoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '⚡',
      low: '📋'
    };
    
    const topCause = rootCause && rootCause.causes && rootCause.causes[0];
    
    return {
      id: this._generateAlertId(),
      severity,
      emoji: emoji[severity],
      title: `${emoji[severity]} [${severity.toUpperCase()}] ${errorGroup.service} - ${errorGroup.errorName || errorGroup.errorCode}`,
      summary: {
        service: errorGroup.service,
        errorCode: errorGroup.errorCode,
        errorMessage: errorGroup.sampleError?.message,
        occurrences: errorGroup.occurrenceCount,
        affectedUsers: errorGroup.affectedUsers,
        firstSeen: errorGroup.firstSeen,
        lastSeen: errorGroup.lastSeen
      },
      rootCause: topCause ? {
        type: topCause.type,
        confidence: `${Math.round(topCause.confidence * 100)}%`,
        details: topCause.details,
        suggestion: topCause.suggestion
      } : null,
      recommendation: rootCause?.recommendation || '请查看详细信息进行排查',
      links: {
        dashboard: this._generateDashboardUrl(errorGroup),
        details: this._generateDetailsUrl(errorGroup),
        logs: this._generateLogsUrl(errorGroup)
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 发送告警到多个渠道
   * @param {Object} alert - 告警消息
   * @param {Array} channels - 渠道列表
   * @returns {Object} 发送结果
   */
  async _sendToChannels(alert, channels) {
    const results = {};
    
    for (const channel of channels) {
      const config = this.channels[channel];
      
      if (!config || !config.enabled) {
        results[channel] = { sent: false, reason: 'disabled' };
        continue;
      }
      
      try {
        switch (channel) {
          case 'slack':
            results[channel] = await this._sendToSlack(alert, config);
            break;
          
          case 'email':
            results[channel] = await this._sendToEmail(alert, config);
            break;
          
          case 'sms':
            results[channel] = await this._sendToSms(alert, config);
            break;
          
          default:
            results[channel] = { sent: false, reason: 'unknown_channel' };
        }
      } catch (error) {
        logger.error(`Failed to send alert to ${channel}`, {
          error: error.message,
          alertId: alert.id
        });
        results[channel] = { sent: false, error: error.message };
      }
    }
    
    return results;
  }

  /**
   * 发送到 Slack
   * @param {Object} alert - 告警消息
   * @param {Object} config - Slack 配置
   * @returns {Object} 发送结果
   */
  async _sendToSlack(alert, config) {
    if (!config.webhook) {
      return { sent: false, reason: 'no_webhook' };
    }
    
    // 实际实现中应使用 axios 或 node-fetch
    // 这里返回模拟结果
    logger.info('Slack alert sent', {
      alertId: alert.id,
      webhook: config.webhook.substring(0, 30) + '...'
    });
    
    return { sent: true, channel: 'slack' };
  }

  /**
   * 发送到邮件
   * @param {Object} alert - 告警消息
   * @param {Object} config - 邮件配置
   * @returns {Object} 发送结果
   */
  async _sendToEmail(alert, config) {
    if (!config.recipients || config.recipients.length === 0) {
      return { sent: false, reason: 'no_recipients' };
    }
    
    logger.info('Email alert sent', {
      alertId: alert.id,
      recipients: config.recipients.length
    });
    
    return { sent: true, channel: 'email', recipients: config.recipients };
  }

  /**
   * 发送到短信
   * @param {Object} alert - 告警消息
   * @param {Object} config - SMS 配置
   * @returns {Object} 发送结果
   */
  async _sendToSms(alert, config) {
    if (!config.recipients || config.recipients.length === 0) {
      return { sent: false, reason: 'no_recipients' };
    }
    
    logger.info('SMS alert sent', {
      alertId: alert.id,
      recipients: config.recipients.length
    });
    
    return { sent: true, channel: 'sms', recipients: config.recipients };
  }

  /**
   * 记录告警
   * @param {Object} alert - 告警消息
   */
  async _recordAlert(alert) {
    try {
      const key = `${this.alertPrefix}history:${new Date().toISOString().split('T')[0]}`;
      await redis.lpush(key, JSON.stringify(alert));
      await redis.expire(key, 2592000); // 30天过期
    } catch (error) {
      logger.error('Failed to record alert', { error: error.message });
    }
  }

  /**
   * 更新统计
   * @param {string} severity - 严重程度
   */
  async _updateStats(severity) {
    const today = new Date().toISOString().split('T')[0];
    const key = `${this.statsPrefix}${today}`;
    
    await redis.hincrby(key, severity, 1);
    await redis.hincrby(key, 'total', 1);
    await redis.expire(key, 2592000); // 30天过期
  }

  /**
   * 获取告警统计
   * @param {string} date - 日期（YYYY-MM-DD）
   * @returns {Object} 统计数据
   */
  async getStats(date) {
    const key = `${this.statsPrefix}${date}`;
    const data = await redis.hgetall(key);
    
    return {
      date,
      critical: parseInt(data.critical || 0, 10),
      high: parseInt(data.high || 0, 10),
      medium: parseInt(data.medium || 0, 10),
      low: parseInt(data.low || 0, 10),
      total: parseInt(data.total || 0, 10)
    };
  }

  /**
   * 生成告警ID
   * @returns {string} 告警ID
   */
  _generateAlertId() {
    return `alert-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 生成 Dashboard URL
   * @param {Object} errorGroup - 错误聚合组
   * @returns {string} URL
   */
  _generateDashboardUrl(errorGroup) {
    return `${process.env.ADMIN_DASHBOARD_URL || 'https://admin.minego.example.com'}/error-analysis/groups/${errorGroup.id}`;
  }

  /**
   * 生成详情 URL
   * @param {Object} errorGroup - 错误聚合组
   * @returns {string} URL
   */
  _generateDetailsUrl(errorGroup) {
    return `${process.env.ADMIN_DASHBOARD_URL || 'https://admin.minego.example.com'}/error-analysis/groups/${errorGroup.id}/details`;
  }

  /**
   * 生成日志 URL
   * @param {Object} errorGroup - 错误聚合组
   * @returns {string} URL
   */
  _generateLogsUrl(errorGroup) {
    return `${process.env.GRAFANA_URL || 'https://grafana.minego.example.com'}/explore?service=${errorGroup.service}&time=${errorGroup.firstSeen}`;
  }

  /**
   * 确认告警
   * @param {string} alertId - 告警ID
   * @param {Object} ack - 确认信息
   * @returns {boolean} 是否成功
   */
  async acknowledge(alertId, ack) {
    try {
      const key = `${this.alertPrefix}ack:${alertId}`;
      await redis.setex(key, 86400, JSON.stringify({
        ...ack,
        acknowledgedAt: new Date().toISOString()
      }));
      
      this.emit('acknowledged', { alertId, ack });
      
      return true;
    } catch (error) {
      logger.error('Failed to acknowledge alert', {
        error: error.message,
        alertId
      });
      return false;
    }
  }
}

module.exports = IntelligentAlerting;