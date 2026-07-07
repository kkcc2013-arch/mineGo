/**
 * REQ-00466: 成本自动响应器
 * 当成本异常时自动触发防护措施
 */

class CostAutoResponder {
  constructor(options = {}) {
    this.rateLimiter = options.rateLimiter;
    this.degradationManager = options.degradationManager;
    this.notificationService = options.notificationService;

    // 响应策略配置
    this.strategies = {
      critical: {
        actions: ['throttle', 'degrade', 'notify_admin'],
        throttlePercent: 50,  // 限流50%
        degradeLevel: 'minimal'
      },
      high: {
        actions: ['throttle', 'notify'],
        throttlePercent: 30,
        degradeLevel: 'normal'
      },
      medium: {
        actions: ['notify'],
        throttlePercent: 0,
        degradeLevel: null
      },
      low: {
        actions: ['log'],
        throttlePercent: 0,
        degradeLevel: null
      }
    };

    // 响应历史记录
    this.responseHistory = [];
    this.maxHistorySize = 100;
  }

  /**
   * 执行自动响应
   * @param {Object} anomaly - 异常检测结果
   * @param {Object} context - 上下文信息
   */
  async respond(anomaly, context) {
    const strategy = this.strategies[anomaly.severity];
    if (!strategy) {
      console.warn(`[CostAutoResponder] Unknown severity: ${anomaly.severity}`);
      return { executed: false, reason: 'Unknown severity' };
    }

    const results = [];

    // 执行策略动作
    for (const action of strategy.actions) {
      try {
        const result = await this.executeAction(action, strategy, anomaly, context);
        results.push({ action, success: true, result });
      } catch (error) {
        console.error(`[CostAutoResponder] Action ${action} failed:`, error.message);
        results.push({ action, success: false, error: error.message });
      }
    }

    // 记录响应历史
    this.recordResponse(anomaly, results);

    return {
      executed: true,
      severity: anomaly.severity,
      strategy: strategy.actions,
      results,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 执行具体动作
   */
  async executeAction(action, strategy, anomaly, context) {
    switch (action) {
      case 'throttle':
        return await this.applyThrottle(strategy.throttlePercent, context);

      case 'degrade':
        return await this.applyDegradation(strategy.degradeLevel, context);

      case 'notify_admin':
        return await this.notifyAdmins(anomaly, context);

      case 'notify':
        return await this.notifyTeam(anomaly, context);

      case 'log':
        return await this.logAnomaly(anomaly, context);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * 应用限流
   */
  async applyThrottle(percent, context) {
    if (!this.rateLimiter) {
      throw new Error('Rate limiter not configured');
    }

    // 设置全局限流百分比
    if (typeof this.rateLimiter.setGlobalThrottle === 'function') {
      await this.rateLimiter.setGlobalThrottle(percent);
    } else {
      console.log(`[CostAutoResponder] Would apply ${percent}% global throttle`);
    }

    return {
      throttlePercent: percent,
      duration: '30m',
      reason: 'Cost anomaly detected',
      appliedAt: new Date().toISOString()
    };
  }

  /**
   * 应用降级
   */
  async applyDegradation(level, context) {
    if (!level) {
      return { skipped: true, reason: 'No degradation level specified' };
    }

    if (!this.degradationManager) {
      throw new Error('Degradation manager not configured');
    }

    if (typeof this.degradationManager.activateDegradation === 'function') {
      await this.degradationManager.activateDegradation(level);
    } else {
      console.log(`[CostAutoResponder] Would activate degradation level: ${level}`);
    }

    return {
      degradeLevel: level,
      featuresDisabled: this.getFeaturesForLevel(level),
      appliedAt: new Date().toISOString()
    };
  }

  /**
   * 通知管理员
   */
  async notifyAdmins(anomaly, context) {
    if (!this.notificationService) {
      return { skipped: true, reason: 'Notification service not configured' };
    }

    if (typeof this.notificationService.sendAdminAlert === 'function') {
      await this.notificationService.sendAdminAlert({
        type: 'cost_anomaly',
        severity: anomaly.severity,
        message: `Critical cost anomaly detected. Current cost: $${(anomaly.currentCost || 0).toFixed(2)}`,
        anomaly,
        context
      });
    } else {
      console.log(`[CostAutoResponder] Would notify admins about cost anomaly`);
    }

    return { notified: true, channel: 'admin' };
  }

  /**
   * 通知团队
   */
  async notifyTeam(anomaly, context) {
    if (!this.notificationService) {
      return { skipped: true, reason: 'Notification service not configured' };
    }

    if (typeof this.notificationService.sendTeamAlert === 'function') {
      await this.notificationService.sendTeamAlert({
        type: 'cost_warning',
        severity: anomaly.severity,
        message: `Cost anomaly detected. Please review usage.`
      });
    } else {
      console.log(`[CostAutoResponder] Would notify team about cost anomaly`);
    }

    return { notified: true, channel: 'team' };
  }

  /**
   * 记录异常日志
   */
  async logAnomaly(anomaly, context) {
    console.log('[CostAutoResponder] Cost anomaly logged:', {
      severity: anomaly.severity,
      type: anomaly.anomalyType,
      currentCost: anomaly.currentCost,
      zScore: anomaly.zScore,
      timestamp: new Date().toISOString(),
      context
    });

    return { logged: true };
  }

  /**
   * 获取降级级别对应的功能列表
   */
  getFeaturesForLevel(level) {
    switch (level) {
      case 'minimal':
        return ['battle', 'trade', 'social'];
      case 'normal':
        return ['social'];
      default:
        return [];
    }
  }

  /**
   * 记录响应历史
   */
  recordResponse(anomaly, results) {
    this.responseHistory.push({
      timestamp: new Date().toISOString(),
      severity: anomaly.severity,
      type: anomaly.anomalyType,
      currentCost: anomaly.currentCost,
      results
    });

    // 限制历史大小
    if (this.responseHistory.length > this.maxHistorySize) {
      this.responseHistory.shift();
    }
  }

  /**
   * 获取响应历史
   */
  getHistory(limit = 20) {
    return this.responseHistory.slice(-limit);
  }
}

module.exports = { CostAutoResponder };