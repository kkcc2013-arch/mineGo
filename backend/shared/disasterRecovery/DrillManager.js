const { logger, metrics } = require('../logging');
const { v4: uuidv4 } = require('uuid');

/**
 * 容灾演练管理器
 * 负责调度、执行、记录容灾演练
 */
class DrillManager {
  constructor(failoverController, config = {}) {
    this.failoverController = failoverController;
    
    this.config = {
      scheduleInterval: config.scheduleInterval || 7 * 24 * 60 * 60 * 1000, // 7 days
      maxDrillDuration: config.maxDrillDuration || 1800000, // 30 minutes
      autoRollback: config.autoRollback !== false,
      notifyChannels: config.notifyChannels || ['slack', 'email'],
      ...config
    };
    
    this.activeDrill = null;
    this.drillHistory = [];
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_drill_in_progress', 'Drill in progress flag');
      metrics.counter('dr_drill_total', 'Total drills', ['result']);
      metrics.histogram('dr_drill_duration_seconds', 'Drill duration');
      metrics.histogram('dr_drill_rto_seconds', 'Actual RTO achieved');
    }
  }
  
  /**
   * 调度演练
   */
  async scheduleDrill(options = {}) {
    const drillId = uuidv4();
    
    const drill = {
      id: drillId,
      scheduledTime: options.scheduledTime || new Date(Date.now() + 60000),
      type: options.type || 'planned',
      duration: options.duration || this.config.maxDrillDuration,
      autoRollback: options.autoRollback !== false,
      status: 'scheduled',
      notifyChannels: options.notifyChannels || this.config.notifyChannels,
      createdBy: options.createdBy || 'system',
      createdAt: new Date().toISOString()
    };
    
    // 发送通知
    await this.sendNotification('drill-scheduled', drill);
    
    logger.info('Drill scheduled', { 
      drillId, 
      scheduledTime: drill.scheduledTime,
      createdBy: drill.createdBy
    });
    
    return drill;
  }
  
  /**
   * 开始演练
   */
  async startDrill(drillId) {
    if (this.activeDrill) {
      throw new Error('Another drill is already in progress');
    }
    
    this.activeDrill = {
      id: drillId,
      startTime: Date.now(),
      status: 'running',
      steps: []
    };
    
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_drill_in_progress').set(1);
    }
    
    logger.info('Drill started', { drillId });
    
    // 发送通知
    await this.sendNotification('drill-started', this.activeDrill);
    
    try {
      // 执行故障切换
      const failoverResult = await this.failoverController.failover({
        trigger: 'drill',
        reason: `Disaster recovery drill: ${drillId}`
      });
      
      this.activeDrill.steps.push({
        name: 'failover',
        success: true,
        duration: failoverResult.duration,
        timestamp: new Date().toISOString()
      });
      
      const rto = (Date.now() - this.activeDrill.startTime) / 1000;
      
      if (metrics && metrics.histogram) {
        metrics.histogram('dr_drill_rto_seconds').observe(rto);
      }
      
      this.activeDrill.rto = rto;
      
      logger.info('Drill failover completed', { drillId, rto });
      
      // 自动回切
      if (this.config.autoRollback) {
        setTimeout(() => {
          this.rollbackDrill(drillId).catch(err => {
            logger.error('Drill auto-rollback failed', { drillId, error: err.message });
          });
        }, this.config.maxDrillDuration);
      }
      
      return {
        ...this.activeDrill,
        failoverResult
      };
      
    } catch (error) {
      this.activeDrill.status = 'failed';
      this.activeDrill.error = error.message;
      
      if (metrics && metrics.counter) {
        metrics.counter('dr_drill_total').inc({ result: 'failed' });
      }
      
      logger.error('Drill failed', { drillId, error: error.message });
      
      throw error;
    }
  }
  
  /**
   * 回切演练
   */
  async rollbackDrill(drillId) {
    if (!this.activeDrill || this.activeDrill.id !== drillId) {
      throw new Error('No active drill with the specified ID');
    }
    
    const rollbackStartTime = Date.now();
    
    logger.info('Drill rollback started', { drillId });
    
    try {
      // 执行回切
      const rollbackResult = await this.failoverController.failover({
        trigger: 'drill-rollback',
        reason: `Disaster recovery drill rollback: ${drillId}`
      });
      
      this.activeDrill.steps.push({
        name: 'rollback',
        success: true,
        duration: rollbackResult.duration,
        startTime: rollbackStartTime,
        timestamp: new Date().toISOString()
      });
      
      this.activeDrill.status = 'completed';
      this.activeDrill.endTime = Date.now();
      this.activeDrill.totalDuration = this.activeDrill.endTime - this.activeDrill.startTime;
      
      if (metrics && metrics.counter) {
        metrics.counter('dr_drill_total').inc({ result: 'success' });
      }
      if (metrics && metrics.histogram) {
        metrics.histogram('dr_drill_duration_seconds').observe(this.activeDrill.totalDuration / 1000);
      }
      if (metrics && metrics.gauge) {
        metrics.gauge('dr_drill_in_progress').set(0);
      }
      
      // 保存历史
      this.drillHistory.push(this.activeDrill);
      
      // 发送通知
      await this.sendNotification('drill-completed', this.activeDrill);
      
      logger.info('Drill completed', { 
        drillId, 
        totalDuration: this.activeDrill.totalDuration,
        rto: this.activeDrill.rto
      });
      
      const completed = this.activeDrill;
      this.activeDrill = null;
      
      return completed;
      
    } catch (error) {
      this.activeDrill.status = 'rollback-failed';
      this.activeDrill.error = error.message;
      
      if (metrics && metrics.counter) {
        metrics.counter('dr_drill_total').inc({ result: 'rollback-failed' });
      }
      if (metrics && metrics.gauge) {
        metrics.gauge('dr_drill_in_progress').set(0);
      }
      
      logger.error('Drill rollback failed', { drillId, error: error.message });
      
      throw error;
    }
  }
  
  /**
   * 取消演练
   */
  async cancelDrill(drillId) {
    if (!this.activeDrill || this.activeDrill.id !== drillId) {
      throw new Error('No active drill with the specified ID');
    }
    
    this.activeDrill.status = 'cancelled';
    this.activeDrill.cancelledAt = new Date().toISOString();
    
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_drill_in_progress').set(0);
    }
    
    logger.info('Drill cancelled', { drillId });
    
    await this.sendNotification('drill-cancelled', this.activeDrill);
    
    const cancelled = this.activeDrill;
    this.activeDrill = null;
    
    return cancelled;
  }
  
  /**
   * 发送通知
   */
  async sendNotification(event, data) {
    logger.info('Sending notification', { event, drillId: data.id || data.drillId });
    
    // 实际实现需要集成 Slack、Email 等通知渠道
    // 这里仅记录日志
  }
  
  /**
   * 获取演练状态
   */
  getDrillStatus(drillId) {
    if (this.activeDrill?.id === drillId) {
      return this.activeDrill;
    }
    
    return this.drillHistory.find(d => d.id === drillId);
  }
  
  /**
   * 获取演练历史
   */
  getDrillHistory(limit = 10) {
    return this.drillHistory.slice(-limit);
  }
  
  /**
   * 获取当前活跃演练
   */
  getActiveDrill() {
    return this.activeDrill;
  }
}

module.exports = DrillManager;
