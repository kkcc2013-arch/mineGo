/**
 * REQ-00466: 告警聚合器
 * 避免告警风暴，实现告警降噪
 */

class AlertAggregator {
  constructor(options = {}) {
    // 聚合窗口（秒）
    this.windowSeconds = options.windowSeconds || 300;  // 5分钟
    // 相同告警阈值（窗口内超过此数量才发送）
    this.threshold = options.threshold || 3;
    // 冷却期（秒）
    this.coolDownSeconds = options.coolDownSeconds || 900;  // 15分钟
    // 历史告警缓存
    this.alertHistory = new Map();
    // 最大缓存大小
    this.maxCacheSize = options.maxCacheSize || 1000;
  }

  /**
   * 处理告警
   * @param {Object} alert - 原始告警
   * @returns {Object|null} 聚合后的告警或 null（被降噪）
   */
  process(alert) {
    const key = this.generateAlertKey(alert);
    const now = Date.now();

    // 获取历史记录
    let history = this.alertHistory.get(key) || {
      count: 0,
      firstTime: now,
      lastSent: 0,
      aggregatedAlerts: []
    };

    // 检查是否超出窗口
    if (now - history.firstTime > this.windowSeconds * 1000) {
      // 重置窗口
      history = {
        count: 0,
        firstTime: now,
        lastSent: history.lastSent,
        aggregatedAlerts: []
      };
    }

    // 检查冷却期
    if (now - history.lastSent < this.coolDownSeconds * 1000) {
      history.aggregatedAlerts.push(alert);
      this.alertHistory.set(key, history);
      return null;  // 冷却期内，不发送
    }

    // 更新计数
    history.count++;
    history.aggregatedAlerts.push(alert);

    // 立即发送条件：critical 级别，或达到阈值
    const shouldSendNow = alert.severity === 'critical' || history.count >= this.threshold;

    if (shouldSendNow) {
      // 创建聚合告警
      const aggregatedAlert = {
        ...alert,
        count: history.count,
        firstOccurrence: new Date(history.firstTime).toISOString(),
        lastOccurrence: new Date().toISOString(),
        aggregatedFrom: history.aggregatedAlerts.length,
        isAggregated: true,
        durationSeconds: Math.round((now - history.firstTime) / 1000)
      };

      // 重置历史
      history.lastSent = now;
      history.count = 0;
      history.firstTime = now;
      history.aggregatedAlerts = [];
      this.alertHistory.set(key, history);

      return aggregatedAlert;
    }

    // 保存历史
    this.alertHistory.set(key, history);
    return null;
  }

  /**
   * 生成告警键
   */
  generateAlertKey(alert) {
    const type = alert.type || alert.anomalyType || 'unknown';
    const severity = alert.severity || 'low';
    const scope = alert.scope || alert.budgetName || 'global';
    return `${type}:${severity}:${scope}`;
  }

  /**
   * 强制发送（绕过降噪）
   */
  forceSend(alert) {
    const key = this.generateAlertKey(alert);
    const history = this.alertHistory.get(key);
    
    if (history) {
      history.lastSent = Date.now();
      this.alertHistory.set(key, history);
    }

    return {
      ...alert,
      isAggregated: false,
      forced: true
    };
  }

  /**
   * 清理过期告警历史
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.windowSeconds * 1000 * 10;  // 10个窗口周期

    for (const [key, history] of this.alertHistory.entries()) {
      if (now - history.firstTime > maxAge) {
        this.alertHistory.delete(key);
      }
    }

    // 如果缓存太大，删除最旧的条目
    if (this.alertHistory.size > this.maxCacheSize) {
      const entriesToDelete = this.alertHistory.size - this.maxCacheSize;
      const keys = Array.from(this.alertHistory.keys()).slice(0, entriesToDelete);
      for (const key of keys) {
        this.alertHistory.delete(key);
      }
    }
  }

  /**
   * 获取当前缓存统计
   */
  getStats() {
    const stats = {
      totalKeys: this.alertHistory.size,
      pendingAlerts: 0,
      bySeverity: {}
    };

    for (const [key, history] of this.alertHistory.entries()) {
      stats.pendingAlerts += history.count;
      
      const severity = key.split(':')[1];
      stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
    }

    return stats;
  }
}

module.exports = { AlertAggregator };