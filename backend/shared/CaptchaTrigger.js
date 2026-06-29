'use strict';

/**
 * CAPTCHA 触发器
 * 根据风险评分和行为分析自动触发验证
 */

class CaptchaTrigger {
  constructor(config = {}) {
    this.config = {
      // 可信度阈值触发
      trustScoreThresholds: {
        high: 40,    // < 40: 高风险验证
        medium: 60,  // < 60: 中风险验证
        low: 80      // < 80: 低风险验证
      },
      
      // 高风险操作触发
      highRiskActions: {
        crossRegionLogin: true,
        anomalousCatch: true,
        deviceSwitch: true,
        bulkOperation: true,
        nightActivity: true
      },
      
      // 定期验证
      periodic: {
        highRiskUserDays: 7,
        normalUserDays: 30
      },
      
      // 冷却期（避免频繁触发）
      cooldownMinutes: 30,
      
      ...config
    };
  }

  /**
   * 检查是否需要触发验证
   * @param {Object} user - 用户信息
   * @param {string} action - 当前操作
   * @param {Object} context - 上下文信息
   * @returns {Object|null} 触发结果
   */
  async shouldTrigger(user, action, context = {}) {
    const triggers = [];
    
    // 1. 可信度阈值检查
    const trustTrigger = this._checkTrustScore(user);
    if (trustTrigger) {
      triggers.push(trustTrigger);
    }
    
    // 2. 高风险操作检查
    const actionTrigger = this._checkHighRiskAction(action, context);
    if (actionTrigger) {
      triggers.push(actionTrigger);
    }
    
    // 3. 定期验证检查
    const periodicTrigger = this._checkPeriodicVerification(user);
    if (periodicTrigger) {
      triggers.push(periodicTrigger);
    }
    
    // 4. 选择优先级最高的触发
    if (triggers.length === 0) {
      return null;
    }
    
    // 优先级：高风险操作 > 可信度阈值 > 定期验证
    const priorityOrder = ['high_risk_action', 'risk_score', 'periodic'];
    
    for (const reason of priorityOrder) {
      const trigger = triggers.find(t => t.reason === reason);
      if (trigger) {
        // 检查冷却期
        if (await this._isInCooldown(user.id)) {
          return null;
        }
        
        return trigger;
      }
    }
    
    return triggers[0];
  }

  /**
   * 检查可信度阈值
   */
  _checkTrustScore(user) {
    const score = user.trustScore || 100;
    
    if (score < this.config.trustScoreThresholds.high) {
      return {
        reason: 'risk_score',
        difficulty: 'high',
        score,
        description: `Trust score ${score} below threshold ${this.config.trustScoreThresholds.high}`
      };
    }
    
    if (score < this.config.trustScoreThresholds.medium) {
      return {
        reason: 'risk_score',
        difficulty: 'medium',
        score,
        description: `Trust score ${score} below threshold ${this.config.trustScoreThresholds.medium}`
      };
    }
    
    if (score < this.config.trustScoreThresholds.low) {
      return {
        reason: 'risk_score',
        difficulty: 'low',
        score,
        description: `Trust score ${score} below threshold ${this.config.trustScoreThresholds.low}`
      };
    }
    
    return null;
  }

  /**
   * 检查高风险操作
   */
  _checkHighRiskAction(action, context) {
    const { highRiskActions } = this.config;
    
    // 跨区域登录
    if (highRiskActions.crossRegionLogin && action === 'login') {
      if (this._isCrossRegion(context.previousLocation, context.currentLocation)) {
        return {
          reason: 'cross_region_login',
          difficulty: 'medium',
          description: 'Cross-region login detected'
        };
      }
    }
    
    // 异常捕捉
    if (highRiskActions.anomalousCatch && action === 'catch') {
      if (this._isAnomalousCatch(context)) {
        return {
          reason: 'anomalous_catch',
          difficulty: 'medium',
          description: 'Anomalous catch pattern detected'
        };
      }
    }
    
    // 设备切换
    if (highRiskActions.deviceSwitch && action === 'login') {
      if (context.deviceChanged) {
        return {
          reason: 'device_switch',
          difficulty: 'low',
          description: 'New device detected'
        };
      }
    }
    
    // 批量操作
    if (highRiskActions.bulkOperation) {
      if (this._isBulkOperation(context)) {
        return {
          reason: 'bulk_operation',
          difficulty: 'medium',
          description: 'Bulk operation detected'
        };
      }
    }
    
    // 深夜活动
    if (highRiskActions.nightActivity) {
      const hour = new Date().getHours();
      if (hour >= 2 && hour < 6) {
        return {
          reason: 'night_activity',
          difficulty: 'low',
          description: 'Night activity detected (2-6 AM)'
        };
      }
    }
    
    return null;
  }

  /**
   * 检查定期验证
   */
  _checkPeriodicVerification(user) {
    const lastVerification = user.lastCaptchaVerification;
    
    if (!lastVerification) {
      // 从未验证过
      return {
        reason: 'periodic',
        difficulty: 'low',
        description: 'First-time verification'
      };
    }
    
    const daysSinceVerification = this._daysSince(lastVerification);
    const threshold = user.trustScore < 60
      ? this.config.periodic.highRiskUserDays
      : this.config.periodic.normalUserDays;
    
    if (daysSinceVerification >= threshold) {
      return {
        reason: 'periodic',
        difficulty: user.trustScore < 60 ? 'medium' : 'low',
        description: `Periodic verification required (${daysSinceVerification} days since last verification)`
      };
    }
    
    return null;
  }

  /**
   * 判断是否跨区域
   */
  _isCrossRegion(prevLocation, currLocation) {
    if (!prevLocation || !currLocation) {
      return false;
    }
    
    // 计算距离
    const distance = this._calculateDistance(
      prevLocation.latitude,
      prevLocation.longitude,
      currLocation.latitude,
      currLocation.longitude
    );
    
    // 超过 500km 视为跨区域
    return distance > 500;
  }

  /**
   * 判断是否异常捕捉
   */
  _isAnomalousCatch(context) {
    // 检查捕捉成功率异常
    if (context.recentCatches && context.recentCatches.length > 0) {
      const successRate = context.recentCatches.filter(c => c.success).length / 
                          context.recentCatches.length;
      
      // 成功率 > 90% 视为异常
      if (successRate > 0.9 && context.recentCatches.length >= 10) {
        return true;
      }
    }
    
    // 检查稀有精灵捕捉频率
    if (context.rareCatches && context.rareCatches.length >= 3) {
      const timeWindow = 60 * 60 * 1000; // 1小时
      const recentRare = context.rareCatches.filter(
        c => Date.now() - new Date(c.timestamp).getTime() < timeWindow
      );
      
      if (recentRare.length >= 3) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 判断是否批量操作
   */
  _isBulkOperation(context) {
    if (!context.recentActions || context.recentActions.length === 0) {
      return false;
    }
    
    // 1小时内超过 100 次操作
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentActions = context.recentActions.filter(
      a => new Date(a.timestamp).getTime() > oneHourAgo
    );
    
    return recentActions.length > 100;
  }

  /**
   * 检查冷却期
   */
  async _isInCooldown(userId) {
    // 这里需要从 Redis 或数据库检查最后验证时间
    // 简化实现：假设通过 context 传入
    return false;
  }

  /**
   * 计算两点间距离（公里）
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this._toRad(lat2 - lat1);
    const dLon = this._toRad(lon2 - lon1);
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this._toRad(lat1)) * Math.cos(this._toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
  }

  /**
   * 角度转弧度
   */
  _toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 计算天数差
   */
  _daysSince(timestamp) {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    return Math.floor((now - then) / (24 * 60 * 60 * 1000));
  }

  /**
   * 获取触发统计
   */
  getStats() {
    return {
      totalTriggers: this.stats?.totalTriggers || 0,
      byReason: this.stats?.byReason || {},
      byDifficulty: this.stats?.byDifficulty || {}
    };
  }
}

module.exports = CaptchaTrigger;