// backend/shared/TrafficGradualRecovery.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('traffic-gradual-recovery');

/**
 * 渐进式流量恢复系统
 * 
 * 功能：
 * 1. 流量百分比控制（10% → 30% → 50% → 100%）
 * 2. 健康度评分（基于错误率、延迟、资源使用）
 * 3. 自动回滚（恢复期间异常立即回滚）
 */
class TrafficGradualRecovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // 恢复阶段定义
    this.recoveryStages = config.recoveryStages || [
      { percent: 10, duration: 60000, healthThreshold: 0.95 },      // 10% 流量，1分钟，健康度要求 95%
      { percent: 30, duration: 120000, healthThreshold: 0.90 },     // 30% 流量，2分钟，健康度要求 90%
      { percent: 50, duration: 180000, healthThreshold: 0.85 },     // 50% 流量，3分钟，健康度要求 85%
      { percent: 100, duration: 0, healthThreshold: 0.80 }          // 100% 流量，完成
    ];
    
    this.config = {
      healthCheckInterval: config.healthCheckInterval || 10000, // 健康检查间隔 10秒
      healthCheckTimeout: config.healthCheckTimeout || 5000,    // 健康检查超时 5秒
      maxRollbackAttempts: config.maxRollbackAttempts || 3,     // 最大回滚尝试次数
      ...config
    };
    
    // 活跃的恢复任务
    this.activeRecoveries = new Map();
    
    // 健康检查器
    this.healthChecker = config.healthChecker || null;
    
    // 流量控制器
    this.trafficController = config.trafficController || null;
  }
  
  /**
   * 启动渐进式恢复
   */
  async startRecovery(serviceName, initialHealth = {}) {
    // 检查是否已有恢复任务
    if (this.activeRecoveries.has(serviceName)) {
      logger.warn('Recovery already in progress', { serviceName });
      return {
        success: false,
        reason: 'Recovery already in progress'
      };
    }
    
    const recovery = {
      serviceName,
      startTime: Date.now(),
      currentStage: -1,
      healthHistory: [initialHealth],
      status: 'starting',
      rollbackAttempts: 0
    };
    
    this.activeRecoveries.set(serviceName, recovery);
    
    logger.info('Starting gradual recovery', {
      serviceName,
      initialHealthScore: initialHealth.score || 0
    });
    
    // 应用第一阶段
    await this.applyStage(serviceName, 0);
    
    // 调度下一阶段
    this.scheduleNextStage(serviceName);
    
    this.emit('recovery-started', {
      serviceName,
      startTime: recovery.startTime
    });
    
    return {
      success: true,
      serviceName,
      stage: 0,
      percent: this.recoveryStages[0].percent
    };
  }
  
  /**
   * 应用流量百分比
   */
  async applyStage(serviceName, stageIndex) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      logger.warn('Recovery not found', { serviceName });
      return { success: false, reason: 'Recovery not found' };
    }
    
    const stage = this.recoveryStages[stageIndex];
    
    if (!stage) {
      logger.error('Invalid stage index', { serviceName, stageIndex });
      return { success: false, reason: 'Invalid stage index' };
    }
    
    logger.info('Applying recovery stage', {
      serviceName,
      stage: stageIndex,
      percent: stage.percent,
      duration: stage.duration
    });
    
    // 更新流量权重
    if (this.trafficController) {
      try {
        await this.trafficController.setWeight(serviceName, stage.percent);
        logger.info('Traffic weight updated', {
          serviceName,
          percent: stage.percent
        });
      } catch (error) {
        logger.error('Failed to update traffic weight', {
          serviceName,
          error: error.message
        });
        
        return {
          success: false,
          reason: 'Failed to update traffic weight'
        };
      }
    }
    
    // 更新恢复状态
    recovery.currentStage = stageIndex;
    recovery.currentPercent = stage.percent;
    recovery.status = 'recovering';
    
    this.emit('stage-applied', {
      serviceName,
      stage: stageIndex,
      percent: stage.percent
    });
    
    return {
      success: true,
      stage: stageIndex,
      percent: stage.percent
    };
  }
  
  /**
   * 调度下一阶段
   */
  scheduleNextStage(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery || recovery.status !== 'recovering') {
      return;
    }
    
    const stage = this.recoveryStages[recovery.currentStage];
    
    if (!stage || stage.duration === 0) {
      // 最后阶段，完成恢复
      this.completeRecovery(serviceName);
      return;
    }
    
    setTimeout(async () => {
      await this.evaluateAndProgress(serviceName);
    }, stage.duration);
    
    logger.debug('Next stage scheduled', {
      serviceName,
      currentStage: recovery.currentStage,
      nextStageIn: stage.duration
    });
  }
  
  /**
   * 评估并推进到下一阶段
   */
  async evaluateAndProgress(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery || recovery.status !== 'recovering') {
      return;
    }
    
    // 执行健康检查
    const health = await this.checkHealth(serviceName);
    recovery.healthHistory.push(health);
    
    const stage = this.recoveryStages[recovery.currentStage];
    
    logger.info('Evaluating recovery progress', {
      serviceName,
      stage: recovery.currentStage,
      healthScore: health.score,
      threshold: stage.healthThreshold
    });
    
    // 检查健康度是否达标
    if (health.score >= stage.healthThreshold) {
      // 健康度达标，进入下一阶段
      if (recovery.currentStage < this.recoveryStages.length - 1) {
        const nextStage = recovery.currentStage + 1;
        await this.applyStage(serviceName, nextStage);
        this.scheduleNextStage(serviceName);
      } else {
        // 最后阶段，完成恢复
        this.completeRecovery(serviceName);
      }
    } else {
      // 健康度不达标，回滚
      await this.rollback(serviceName, health);
    }
  }
  
  /**
   * 回滚恢复
   */
  async rollback(serviceName, health) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      return { success: false, reason: 'Recovery not found' };
    }
    
    recovery.rollbackAttempts++;
    
    logger.error('Recovery rollback triggered', {
      serviceName,
      currentStage: recovery.currentStage,
      healthScore: health.score,
      rollbackAttempt: recovery.rollbackAttempts
    });
    
    // 检查回滚尝试次数
    if (recovery.rollbackAttempts > this.config.maxRollbackAttempts) {
      logger.error('Max rollback attempts reached, aborting recovery', {
        serviceName,
        attempts: recovery.rollbackAttempts
      });
      
      await this.abortRecovery(serviceName, 'Max rollback attempts reached');
      
      return {
        success: false,
        reason: 'Max rollback attempts reached'
      };
    }
    
    // 回滚到上一个阶段
    if (recovery.currentStage > 0) {
      const previousStage = recovery.currentStage - 1;
      await this.applyStage(serviceName, previousStage);
      
      logger.info('Recovery rolled back', {
        serviceName,
        fromStage: recovery.currentStage + 1,
        toStage: previousStage
      });
      
      this.emit('recovery-rolled-back', {
        serviceName,
        fromStage: recovery.currentStage + 1,
        toStage: previousStage,
        healthScore: health.score
      });
      
      // 重新调度
      this.scheduleNextStage(serviceName);
      
      return {
        success: true,
        rolledBackTo: previousStage
      };
    } else {
      // 第一阶段就失败，完全隔离
      await this.abortRecovery(serviceName, 'Health check failed at first stage');
      
      return {
        success: false,
        reason: 'Health check failed at first stage'
      };
    }
  }
  
  /**
   * 完成恢复
   */
  completeRecovery(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      return;
    }
    
    recovery.status = 'completed';
    
    const duration = Date.now() - recovery.startTime;
    
    logger.info('Recovery completed', {
      serviceName,
      duration_ms: duration,
      stagesCompleted: recovery.currentStage + 1
    });
    
    this.emit('recovery-completed', {
      serviceName,
      duration_ms: duration,
      stagesCompleted: recovery.currentStage + 1,
      healthHistory: recovery.healthHistory
    });
    
    // 移除恢复任务
    this.activeRecoveries.delete(serviceName);
  }
  
  /**
   * 中止恢复
   */
  async abortRecovery(serviceName, reason) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      return;
    }
    
    recovery.status = 'aborted';
    
    logger.error('Recovery aborted', {
      serviceName,
      reason,
      duration_ms: Date.now() - recovery.startTime
    });
    
    // 将流量设置为 0
    if (this.trafficController) {
      try {
        await this.trafficController.setWeight(serviceName, 0);
      } catch (error) {
        logger.error('Failed to set traffic to zero', {
          serviceName,
          error: error.message
        });
      }
    }
    
    this.emit('recovery-aborted', {
      serviceName,
      reason,
      duration_ms: Date.now() - recovery.startTime
    });
    
    // 移除恢复任务
    this.activeRecoveries.delete(serviceName);
  }
  
  /**
   * 检查服务健康状态
   */
  async checkHealth(serviceName) {
    if (this.healthChecker) {
      try {
        const health = await Promise.race([
          this.healthChecker.runAllChecks(),
          this.createTimeout(this.config.healthCheckTimeout)
        ]);
        
        // 计算健康度评分
        const score = this.calculateHealthScore(health);
        
        return {
          status: health.status,
          score,
          checks: health.checks,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        logger.error('Health check failed during recovery', {
          serviceName,
          error: error.message
        });
        
        return {
          status: 'unhealthy',
          score: 0,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // 默认返回健康
    return {
      status: 'healthy',
      score: 1.0,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 计算健康度评分
   */
  calculateHealthScore(health) {
    if (!health || !health.checks) {
      return 0;
    }
    
    const checks = health.checks;
    let totalScore = 0;
    let totalChecks = 0;
    
    for (const [name, check] of Object.entries(checks)) {
      totalChecks++;
      
      if (check.status === 'healthy') {
        totalScore += 1.0;
      } else if (check.status === 'degraded') {
        totalScore += 0.5;
      } else {
        totalScore += 0;
      }
      
      // 考虑延迟因素
      if (check.latency_ms) {
        if (check.latency_ms < 100) {
          totalScore += 0.1;
        } else if (check.latency_ms > 1000) {
          totalScore -= 0.2;
        }
      }
    }
    
    return totalChecks > 0 ? Math.max(0, Math.min(1, totalScore / totalChecks)) : 0;
  }
  
  /**
   * 获取恢复状态
   */
  getRecoveryStatus(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      return null;
    }
    
    return {
      serviceName: recovery.serviceName,
      status: recovery.status,
      currentStage: recovery.currentStage,
      currentPercent: recovery.currentPercent,
      startTime: recovery.startTime,
      duration_ms: Date.now() - recovery.startTime,
      healthHistory: recovery.healthHistory.slice(-10) // 最近10次健康检查
    };
  }
  
  /**
   * 获取所有活跃恢复
   */
  getAllRecoveries() {
    const recoveries = [];
    
    for (const [serviceName, recovery] of this.activeRecoveries) {
      recoveries.push({
        serviceName,
        status: recovery.status,
        currentStage: recovery.currentStage,
        currentPercent: recovery.currentPercent,
        duration_ms: Date.now() - recovery.startTime
      });
    }
    
    return recoveries;
  }
  
  /**
   * 手动推进恢复
   */
  async advanceRecovery(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    if (!recovery) {
      return { success: false, reason: 'Recovery not found' };
    }
    
    if (recovery.currentStage >= this.recoveryStages.length - 1) {
      return { success: false, reason: 'Already at final stage' };
    }
    
    return await this.applyStage(serviceName, recovery.currentStage + 1);
  }
  
  /**
   * 创建超时 Promise
   */
  createTimeout(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), ms);
    });
  }
  
  /**
   * 清理资源
   */
  cleanup() {
    this.activeRecoveries.clear();
    logger.info('Traffic gradual recovery cleaned up');
  }
}

module.exports = TrafficGradualRecovery;
