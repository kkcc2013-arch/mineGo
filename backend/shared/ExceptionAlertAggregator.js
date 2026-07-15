/**
 * REQ-00555: 异常告警聚合器
 * 智能聚合异常告警，避免告警轰炸
 */

const logger = require('./logger');

class ExceptionAlertAggregator {
  constructor(config = {}) {
    this.config = {
      // 告警阈值
      thresholds: {
        critical: { count: 1, windowSeconds: 60 },      // 1分钟内1次即告警
        high: { count: 5, windowSeconds: 300 },         // 5分钟内5次告警
        medium: { count: 20, windowSeconds: 600 },      // 10分钟内20次告警
        low: { count: 50, windowSeconds: 1800 }         // 30分钟内50次告警
      },
      // 告警抑制
      suppression: {
        maxAlertsPerHour: 100,           // 每小时最多告警数
        duplicateSuppressionMinutes: 60, // 相同指纹1小时内只告警一次
        burstDetectionWindow: 300,       // 暴发检测窗口（秒）
        burstThreshold: 10               // 暴发阈值
      },
      // 通知渠道
      channels: config.channels || ['log', 'webhook'],
      webhookUrl: config.webhookUrl || process.env.ALERT_WEBHOOK_URL
    };
    
    // 告警状态
    this.alertHistory = [];
    this.suppressionCache = new Map();  // fingerprintId -> 最后告警时间
    this.hourlyAlertCount = 0;
    this.hourlyResetTime = Date.now() + 3600000;
    
    // 统计
    this.stats = {
      totalAlerts: 0,
      suppressedAlerts: 0,
      burstDetected: 0
    };
    
    // 事件监听器
    this.listeners = [];
  }

  /**
   * 检查并触发告警
   * @param {Object} clusterInfo - 集群信息
   * @param {Object} fingerprint - 指纹信息
   * @returns {Object|null} 告警对象或null（被抑制）
   */
  checkAndAlert(clusterInfo, fingerprint) {
    // 检查是否应该抑制
    if (this._shouldSuppress(fingerprint.fingerprintId)) {
      this.stats.suppressedAlerts++;
      return null;
    }
    
    // 检查小时限制
    if (!this._checkHourlyLimit()) {
      this.stats.suppressedAlerts++;
      return null;
    }
    
    // 计算严重程度
    const severity = this._calculateSeverity(clusterInfo);
    
    // 检查是否满足告警阈值
    if (!this._checkThreshold(clusterInfo, severity)) {
      return null;
    }
    
    // 创建告警
    const alert = this._createAlert(clusterInfo, fingerprint, severity);
    
    // 发送告警
    this._sendAlert(alert);
    
    // 更新抑制缓存
    this.suppressionCache.set(fingerprint.fingerprintId, Date.now());
    
    return alert;
  }

  /**
   * 批量检查告警
   */
  checkBatch(clusterUpdates) {
    const alerts = [];
    
    for (const update of clusterUpdates) {
      const alert = this.checkAndAlert(update.cluster, update.fingerprint);
      if (alert) {
        alerts.push(alert);
      }
    }
    
    // 暴发检测
    if (alerts.length >= this.config.suppression.burstThreshold) {
      this._handleBurst(alerts);
    }
    
    return alerts;
  }

  /**
   * 检查是否应该抑制
   */
  _shouldSuppress(fingerprintId) {
    const lastAlert = this.suppressionCache.get(fingerprintId);
    if (!lastAlert) return false;
    
    const elapsed = (Date.now() - lastAlert) / 1000 / 60;
    return elapsed < this.config.suppression.duplicateSuppressionMinutes;
  }

  /**
   * 检查小时限制
   */
  _checkHourlyLimit() {
    // 重置计数器
    if (Date.now() > this.hourlyResetTime) {
      this.hourlyAlertCount = 0;
      this.hourlyResetTime = Date.now() + 3600000;
    }
    
    return this.hourlyAlertCount < this.config.suppression.maxAlertsPerHour;
  }

  /**
   * 计算严重程度
   */
  _calculateSeverity(clusterInfo) {
    const count = clusterInfo.memberCount || 0;
    const serviceCount = clusterInfo.serviceCount || 1;
    
    // 规则：
    // - 单服务 > 50次异常 = critical
    // - 多服务异常 = critical
    // - 20-50次 = high
    // - 5-20次 = medium
    // - <5次 = low
    
    if (serviceCount > 1 || count > 50) {
      return 'critical';
    } else if (count > 20) {
      return 'high';
    } else if (count > 5) {
      return 'medium';
    }
    
    return 'low';
  }

  /**
   * 检查阈值
   */
  _checkThreshold(clusterInfo, severity) {
    const threshold = this.config.thresholds[severity];
    if (!threshold) return false;
    
    // 这里需要根据时间窗口内的统计来判断
    // 简化实现：直接使用集群的成员计数
    return clusterInfo.memberCount >= threshold.count;
  }

  /**
   * 创建告警对象
   */
  _createAlert(clusterInfo, fingerprint, severity) {
    return {
      alertId: `alert_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      fingerprintId: fingerprint.fingerprintId,
      exceptionType: fingerprint.exceptionType,
      message: fingerprint.normalizedMessage?.substring(0, 200),
      severity,
      occurrences: clusterInfo.memberCount,
      affectedServices: clusterInfo.services || [],
      stackSignature: fingerprint.stackSignature?.substring(0, 100),
      codeLocations: fingerprint.codeLocations?.slice(0, 5),
      createdAt: new Date().toISOString(),
      metadata: {
        clusterCreatedAt: clusterInfo.createdAt,
        lastUpdated: clusterInfo.lastUpdated
      }
    };
  }

  /**
   * 发送告警
   */
  async _sendAlert(alert) {
    this.stats.totalAlerts++;
    this.hourlyAlertCount++;
    this.alertHistory.push(alert);
    
    // 维护历史大小
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-500);
    }
    
    // 触发监听器
    for (const listener of this.listeners) {
      try {
        await listener(alert);
      } catch (err) {
        logger.error('Alert listener error', { error: err.message });
      }
    }
    
    // 日志输出
    logger.warn({
      module: 'ExceptionAlertAggregator',
      alert,
      msg: `Exception Alert [${alert.severity.toUpperCase()}]: ${alert.exceptionType}`
    });
    
    // Webhook 通知
    if (this.config.webhookUrl) {
      await this._sendWebhook(alert);
    }
  }

  /**
   * 发送 Webhook
   */
  async _sendWebhook(alert) {
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'exception_alert',
          data: alert
        }),
        timeout: 5000
      });
      
      if (!response.ok) {
        logger.error('Webhook notification failed', {
          status: response.status,
          alertId: alert.alertId
        });
      }
    } catch (err) {
      logger.error('Webhook notification error', {
        error: err.message,
        alertId: alert.alertId
      });
    }
  }

  /**
   * 处理暴发
   */
  _handleBurst(alerts) {
    this.stats.burstDetected++;
    
    logger.error({
      module: 'ExceptionAlertAggregator',
      burstAlerts: alerts.length,
      severity: 'critical',
      msg: 'Exception burst detected! Multiple alerts triggered rapidly'
    });
    
    // 创建暴发告警
    const burstAlert = {
      alertId: `burst_${Date.now()}`,
      type: 'burst',
      alertCount: alerts.length,
      fingerprints: alerts.map(a => a.fingerprintId).slice(0, 20),
      createdAt: new Date().toISOString()
    };
    
    // 暴发告警进入抑制模式
    for (const alert of alerts) {
      this.suppressionCache.set(alert.fingerprintId, Date.now());
    }
  }

  /**
   * 添加监听器
   */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /**
   * 获取告警历史
   */
  getAlertHistory(options = {}) {
    let history = [...this.alertHistory];
    
    // 按严重程度过滤
    if (options.severity) {
      history = history.filter(a => a.severity === options.severity);
    }
    
    // 按时间范围过滤
    if (options.since) {
      const sinceTime = new Date(options.since).getTime();
      history = history.filter(a => new Date(a.createdAt).getTime() >= sinceTime);
    }
    
    // 排序和分页
    history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const limit = options.limit || 50;
    return history.slice(0, limit);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      hourlyAlertCount: this.hourlyAlertCount,
      hourlyLimit: this.config.suppression.maxAlertsPerHour,
      suppressionCacheSize: this.suppressionCache.size,
      alertHistorySize: this.alertHistory.length
    };
  }

  /**
   * 清除抑制缓存
   */
  clearSuppressionCache() {
    this.suppressionCache.clear();
  }
}

module.exports = ExceptionAlertAggregator;