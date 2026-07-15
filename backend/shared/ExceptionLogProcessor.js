/**
 * REQ-00555: 异常日志追踪系统主模块
 * 整合聚类器和告警聚合器，提供统一的日志处理入口
 */

const ExceptionLogClusterer = require('./ExceptionLogClusterer');
const ExceptionAlertAggregator = require('./ExceptionAlertAggregator');
const logger = require('./logger');

class ExceptionLogProcessor {
  constructor(config = {}) {
    this.clusterer = new ExceptionLogClusterer(config.clusterer || {});
    this.alertAggregator = new ExceptionAlertAggregator(config.alertAggregator || {});
    
    // 处理统计
    this.processingStats = {
      logsProcessed: 0,
      errorsProcessed: 0,
      alertsTriggered: 0,
      startTime: new Date()
    };
    
    // 启动后台任务
    this._startBackgroundTasks();
  }

  /**
   * 处理单条日志
   */
  processLog(logEntry) {
    this.processingStats.logsProcessed++;
    
    // 传递给聚类器
    const result = this.clusterer.processLog(logEntry);
    
    if (!result) {
      return null;
    }
    
    this.processingStats.errorsProcessed++;
    
    // 检查告警
    const alert = this.alertAggregator.checkAndAlert(result.cluster, result.fingerprint);
    
    if (alert) {
      this.processingStats.alertsTriggered++;
      
      // 记录告警触发
      logger.info({
        module: 'ExceptionLogProcessor',
        alert: {
          id: alert.alertId,
          severity: alert.severity,
          exceptionType: alert.exceptionType
        },
        msg: 'Exception alert triggered'
      });
    }
    
    return {
      fingerprint: result.fingerprint,
      cluster: result.cluster,
      alert,
      isNewCluster: result.isNew
    };
  }

  /**
   * 批量处理日志
   */
  processBatch(logEntries) {
    const results = [];
    const alerts = [];
    
    for (const logEntry of logEntries) {
      const result = this.processLog(logEntry);
      if (result) {
        results.push(result);
        if (result.alert) {
          alerts.push(result.alert);
        }
      }
    }
    
    return { results, alerts };
  }

  /**
   * 获取聚类统计
   */
  getClusterStats() {
    return this.clusterer.getClusterStats();
  }

  /**
   * 获取集群详情
   */
  getClusterDetails(fingerprintId) {
    return this.clusterer.getClusterDetails(fingerprintId);
  }

  /**
   * 获取告警历史
   */
  getAlertHistory(options = {}) {
    return this.alertAggregator.getAlertHistory(options);
  }

  /**
   * 获取处理统计
   */
  getProcessingStats() {
    const clusterStats = this.clusterer.getClusterStats();
    const alertStats = this.alertAggregator.getStats();
    
    return {
      ...this.processingStats,
      clusters: {
        total: clusterStats.totalClusters,
        members: clusterStats.totalMembers
      },
      alerts: {
        total: alertStats.totalAlerts,
        suppressed: alertStats.suppressedAlerts,
        bursts: alertStats.burstDetected
      },
      uptime: Date.now() - this.processingStats.startTime.getTime()
    };
  }

  /**
   * 添加告警监听器
   */
  addAlertListener(listener) {
    this.alertAggregator.addListener(listener);
  }

  /**
   * 启动后台任务
   */
  _startBackgroundTasks() {
    // 每5分钟输出一次统计
    this.statsInterval = setInterval(() => {
      this._logStats();
    }, 300000);
    
    // 每小时清理旧数据
    this.cleanupInterval = setInterval(() => {
      this.clusterer.cleanup();
    }, 3600000);
  }

  /**
   * 记录统计信息
   */
  _logStats() {
    const stats = this.getProcessingStats();
    logger.info({
      module: 'ExceptionLogProcessor',
      stats,
      msg: 'Exception processing stats'
    });
  }

  /**
   * 停止处理
   */
  stop() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clusterer.stop();
  }

  /**
   * 健康检查
   */
  healthCheck() {
    const stats = this.getProcessingStats();
    
    return {
      healthy: true,
      clusters: stats.clusters.total,
      alerts: stats.alerts.total,
      uptime: stats.uptime,
      lastProcessingTime: this.processingStats.logsProcessed > 0 
        ? new Date().toISOString() 
        : null
    };
  }
}

module.exports = ExceptionLogProcessor;