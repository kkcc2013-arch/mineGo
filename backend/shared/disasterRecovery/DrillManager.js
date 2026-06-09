/**
 * DrillManager - 容灾演练管理器
 * 
 * 功能：
 * - 调度和执行容灾演练
 * - 自动回切支持
 * - 演练历史记录
 * - RTO/RPO 验证
 */

const { v4: uuidv4 } = require('uuid');

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
    this.metrics = null;
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    try {
      const { metrics } = require('../logging');
      this.metrics = metrics;
      
      if (!metrics._registered_dr_drill_in_progress) {
        metrics.gauge('dr_drill_in_progress', 'Drill in progress flag');
        metrics._registered_dr_drill_in_progress = true;
      }
      
      if (!metrics._registered_dr_drill_total) {
        metrics.counter('dr_drill_total', 'Total drills', ['result']);
        metrics._registered_dr_drill_total = true;
      }
      
      if (!metrics._registered_dr_drill_duration_seconds) {
        metrics.histogram('dr_drill_duration_seconds', 'Drill duration');
        metrics._registered_dr_drill_duration_seconds = true;
      }
      
      if (!metrics._registered_dr_drill_rto_seconds) {
        metrics.histogram('dr_drill_rto_seconds', 'Actual RTO achieved');
        metrics._registered_dr_drill_rto_seconds = true;
      }
    } catch (e) {
      // metrics may not be available
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
      createdBy: options.createdBy || 'system'
    };
    
    // 发送通知
    await this.sendNotification('drill-scheduled', drill);
    
    console.log('[DrillManager] Drill scheduled:', { drillId, scheduledTime: drill.scheduledTime });
    
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
    
    this.setMetric('dr_drill_in_progress', 1);
    
    console.log('[DrillManager] Drill started:', drillId);
    
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
        duration: failoverResult.duration
      });
      
      const rto = (Date.now() - this.activeDrill.startTime) / 1000;
      this.observeMetric('dr_drill_rto_seconds', rto);
      
      this.activeDrill.rto = rto;
      
      console.log('[DrillManager] Drill failover completed:', { drillId, rto });
      
      // 自动回切
      if (this.config.autoRollback) {
        setTimeout(() => {
          this.rollbackDrill(drillId).catch(err => {
            console.error('[DrillManager] Auto-rollback failed:', drillId, err.message);
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
      
      this.incMetric('dr_drill_total', { result: 'failed' });
      
      console.error('[DrillManager] Drill failed:', drillId, error.message);
      
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
    
    console.log('[DrillManager] Drill rollback started:', drillId);
    
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
        startTime: rollbackStartTime
      });
      
      this.activeDrill.status = 'completed';
      this.activeDrill.endTime = Date.now();
      this.activeDrill.totalDuration = this.activeDrill.endTime - this.activeDrill.startTime;
      
      this.incMetric('dr_drill_total', { result: 'success' });
      this.observeMetric('dr_drill_duration_seconds', this.activeDrill.totalDuration / 1000);
      this.setMetric('dr_drill_in_progress', 0);
      
      // 保存历史
      this.drillHistory.push(this.activeDrill);
      
      // 发送通知
      await this.sendNotification('drill-completed', this.activeDrill);
      
      console.log('[DrillManager] Drill completed:', { 
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
      
      this.incMetric('dr_drill_total', { result: 'rollback-failed' });
      this.setMetric('dr_drill_in_progress', 0);
      
      console.error('[DrillManager] Drill rollback failed:', drillId, error.message);
      
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
    this.activeDrill.endTime = Date.now();
    
    this.incMetric('dr_drill_total', { result: 'cancelled' });
    this.setMetric('dr_drill_in_progress', 0);
    
    const cancelled = this.activeDrill;
    this.drillHistory.push(cancelled);
    this.activeDrill = null;
    
    await this.sendNotification('drill-cancelled', cancelled);
    
    console.log('[DrillManager] Drill cancelled:', drillId);
    
    return cancelled;
  }
  
  /**
   * 发送通知
   */
  async sendNotification(event, data) {
    console.log('[DrillManager] Sending notification:', { event, drillId: data.id });
    
    // 在生产环境中，这里会：
    // 1. 发送 Slack 通知
    // 2. 发送邮件
    // 3. 发送短信（紧急情况）
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
   * 设置 Prometheus 指标
   */
  setMetric(name, value) {
    if (this.metrics) {
      try {
        this.metrics.gauge(name).set(value);
      } catch (e) {
        // Ignore
      }
    }
  }
  
  /**
   * 增加 Prometheus 计数器
   */
  incMetric(name, labels) {
    if (this.metrics) {
      try {
        this.metrics.counter(name).inc(labels);
      } catch (e) {
        // Ignore
      }
    }
  }
  
  /**
   * 观察 Prometheus 直方图
   */
  observeMetric(name, value) {
    if (this.metrics) {
      try {
        this.metrics.histogram(name).observe(value);
      } catch (e) {
        // Ignore
      }
    }
  }
}

module.exports = DrillManager;
