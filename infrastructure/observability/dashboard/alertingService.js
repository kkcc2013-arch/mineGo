/**
 * 实时告警推送服务
 * 使用 Socket.io 推送关键告警指标
 */

const EventEmitter = require('events');

class AlertingService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.thresholds = {
      errorRate: config.errorRateThreshold || 5, // 5%
      latencyP99: config.latencyThreshold || 500, // 500ms
      timeoutRate: config.timeoutThreshold || 1 // 1%
    };
    
    this.alerts = [];
    this.maxAlerts = config.maxAlerts || 100;
    this.isRunning = false;
    this.timer = null;
    this.checkInterval = config.checkInterval || 3000; // 3秒检查一次
  }

  /**
   * 启动告警服务
   */
  start(monitoringAggregator) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.aggregator = monitoringAggregator;
    
    // 监听聚合事件
    monitoringAggregator.on('aggregated', (data) => {
      this.checkAlerts(data);
    });
    
    this.emit('started');
  }

  /**
   * 停止告警服务
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    this.emit('stopped');
  }

  /**
   * 检查告警
   */
  checkAlerts(data) {
    const { slo, anomalies, topology } = data;
    
    // 检查 SLO 指标告警
    for (const [link, metrics] of Object.entries(slo)) {
      if (metrics.errorRate > this.thresholds.errorRate) {
        this.createAlert({
          type: 'slo-error-rate',
          severity: 'high',
          link,
          value: metrics.errorRate,
          threshold: this.thresholds.errorRate,
          message: `${link} 链路错误率 ${metrics.errorRate.toFixed(2)}% 超过阈值 ${this.thresholds.errorRate}%`
        });
      }
      
      if (metrics.latency > this.thresholds.latencyP99) {
        this.createAlert({
          type: 'slo-latency',
          severity: 'medium',
          link,
          value: metrics.latency,
          threshold: this.thresholds.latencyP99,
          message: `${link} 链路延迟 ${metrics.latency.toFixed(0)}ms 超过阈值 ${this.thresholds.latencyP99}ms`
        });
      }
    }
    
    // 检查服务拓扑告警
    for (const node of topology.nodes) {
      if (node.status === 'unhealthy') {
        this.createAlert({
          type: 'service-unhealthy',
          severity: 'critical',
          service: node.id,
          message: `服务 ${node.id} 状态异常`
        });
      }
    }
    
    // 检查异常指标
    if (anomalies.error_rate) {
      for (const item of anomalies.error_rate) {
        const service = item.metric.service;
        const value = parseFloat(item.value[1]);
        
        if (value > this.thresholds.errorRate / 100) {
          this.createAlert({
            type: 'anomaly-error-rate',
            severity: 'high',
            service,
            value: value * 100,
            threshold: this.thresholds.errorRate,
            message: `服务 ${service} 错误率 ${value.toFixed(2)}% 超过阈值 ${this.thresholds.errorRate}%`
          });
        }
      }
    }
  }

  /**
   * 创建告警
   */
  createAlert(alert) {
    const newAlert = {
      ...alert,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      acknowledged: false
    };
    
    // 检查重复告警（5分钟内相同类型和目标）
    const isDuplicate = this.alerts.some(a => 
      a.type === newAlert.type &&
      (a.service === newAlert.service || a.link === newAlert.link) &&
      (Date.now() - a.timestamp) < 300000
    );
    
    if (!isDuplicate) {
      this.alerts.unshift(newAlert);
      
      // 保持最大告警数量
      if (this.alerts.length > this.maxAlerts) {
        this.alerts = this.alerts.slice(0, this.maxAlerts);
      }
      
      // 发送告警事件
      this.emit('alert', newAlert);
    }
  }

  /**
   * 确认告警
   */
  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('acknowledged', alert);
      return true;
    }
    return false;
  }

  /**
   * 获取活跃告警
   */
  getActiveAlerts() {
    const oneHourAgo = Date.now() - 3600000;
    return this.alerts.filter(a => 
      !a.acknowledged && 
      a.timestamp > oneHourAgo
    );
  }

  /**
   * 获取所有告警
   */
  getAllAlerts(limit = 50) {
    return this.alerts.slice(0, limit);
  }

  /**
   * 清理过期告警
   */
  cleanupExpiredAlerts() {
    const oneDayAgo = Date.now() - 86400000;
    this.alerts = this.alerts.filter(a => a.timestamp > oneDayAgo);
  }

  /**
   * 获取告警统计
   */
  getAlertStats() {
    const stats = {
      total: this.alerts.length,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0
      },
      byType: {},
      acknowledged: 0,
      unacknowledged: 0
    };
    
    for (const alert of this.alerts) {
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
      stats.byType[alert.type] = (stats.byType[alert.type] || 0) + 1;
      
      if (alert.acknowledged) {
        stats.acknowledged++;
      } else {
        stats.unacknowledged++;
      }
    }
    
    return stats;
  }
}

module.exports = AlertingService;
