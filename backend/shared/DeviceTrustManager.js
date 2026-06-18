'use strict';

/**
 * 设备信任管理器
 * 根据设备行为历史自动评估信任等级
 */
class DeviceTrustManager {
  constructor() {
    // 信任等级定义
    this.trustLevels = {
      UNTRUSTED: 0,    // 新设备/可疑设备
      LOW: 1,          // 少量历史记录
      MEDIUM: 2,       // 正常使用设备
      HIGH: 3,         // 长期信任设备
      VERIFIED: 4      // 已验证设备（通过MFA等）
    };

    // 信任评分规则
    this.trustFactors = {
      accountAge: { weight: 0.15, maxScore: 100 },
      loginCount: { weight: 0.20, maxScore: 100 },
      successfulActions: { weight: 0.25, maxScore: 100 },
      mfaVerified: { weight: 0.25, maxScore: 100 },
      consistentLocation: { weight: 0.15, maxScore: 100 }
    };
  }

  /**
   * 计算设备信任评分
   * @param {Object} deviceHistory - 设备历史记录
   * @returns {Object} { score, level, factors }
   */
  calculateTrustScore(deviceHistory) {
    const factors = {};
    let totalScore = 0;

    // 账号年龄因素
    factors.accountAge = this._calculateAgeScore(deviceHistory.accountAge || 0);
    totalScore += factors.accountAge * this.trustFactors.accountAge.weight;

    // 登录次数因素
    factors.loginCount = this._calculateLoginScore(deviceHistory.loginCount || 0);
    totalScore += factors.loginCount * this.trustFactors.loginCount.weight;

    // 成功操作因素
    factors.successfulActions = this._calculateActionScore(
      deviceHistory.successfulActions || 0,
      deviceHistory.failedActions || 0
    );
    totalScore += factors.successfulActions * this.trustFactors.successfulActions.weight;

    // MFA 验证因素
    factors.mfaVerified = deviceHistory.mfaVerified ? 100 : 0;
    totalScore += factors.mfaVerified * this.trustFactors.mfaVerified.weight;

    // 地理位置一致性因素
    factors.consistentLocation = this._calculateLocationScore(
      deviceHistory.locations || []
    );
    totalScore += factors.consistentLocation * this.trustFactors.consistentLocation.weight;

    // 确定信任等级
    const level = this._determineLevel(totalScore);

    return {
      score: Math.round(totalScore),
      level,
      levelName: this.getLevelName(level),
      factors
    };
  }

  _calculateAgeScore(ageDays) {
    if (ageDays >= 365) return 100;
    if (ageDays >= 180) return 80;
    if (ageDays >= 90) return 60;
    if (ageDays >= 30) return 40;
    if (ageDays >= 7) return 20;
    return 0;
  }

  _calculateLoginScore(loginCount) {
    if (loginCount >= 100) return 100;
    if (loginCount >= 50) return 80;
    if (loginCount >= 20) return 60;
    if (loginCount >= 10) return 40;
    if (loginCount >= 5) return 20;
    return 0;
  }

  _calculateActionScore(successCount, failCount) {
    if (successCount === 0 && failCount === 0) return 0;
    
    const total = successCount + failCount;
    const successRate = (successCount / total) * 100;
    
    // 成功率权重 70%，次数权重 30%
    const rateScore = successRate * 0.7;
    const countScore = Math.min(100, total * 0.3);
    
    return Math.round(rateScore + countScore);
  }

  _calculateLocationScore(locations) {
    if (!locations || locations.length === 0) return 50;
    
    // 计算位置集中度
    const uniqueLocations = [...new Set(locations.filter(l => l))];
    if (uniqueLocations.length === 0) return 50;
    
    const concentration = 1 - (uniqueLocations.length / Math.max(locations.length, 1));
    
    // 集中度越高，评分越高
    return Math.round(concentration * 100);
  }

  _determineLevel(score) {
    if (score >= 90) return this.trustLevels.VERIFIED;
    if (score >= 70) return this.trustLevels.HIGH;
    if (score >= 50) return this.trustLevels.MEDIUM;
    if (score >= 30) return this.trustLevels.LOW;
    return this.trustLevels.UNTRUSTED;
  }

  /**
   * 获取信任等级名称
   * @param {number} level - 等级数值
   * @returns {string} 等级名称
   */
  getLevelName(level) {
    const names = ['UNTRUSTED', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED'];
    return names[level] || 'UNKNOWN';
  }

  /**
   * 检查设备是否需要额外验证
   * @param {number} trustLevel - 信任等级
   * @param {Object} context - 登录上下文
   * @returns {Object} { required, methods }
   */
  requireAdditionalVerification(trustLevel, context) {
    const verification = { required: false, methods: [] };

    // 新设备或低信任设备
    if (trustLevel <= this.trustLevels.LOW) {
      verification.required = true;
      verification.methods.push('email', 'sms');
    }

    // 异地登录检测
    if (context && context.isNewLocation && trustLevel < this.trustLevels.HIGH) {
      verification.required = true;
      verification.methods.push('email');
    }

    // 敏感操作
    if (context && context.isSensitiveAction && trustLevel < this.trustLevels.VERIFIED) {
      verification.required = true;
      verification.methods.push('mfa');
    }

    return verification;
  }

  /**
   * 获取所有信任等级定义
   * @returns {Object}
   */
  getTrustLevels() {
    return { ...this.trustLevels };
  }
}

module.exports = DeviceTrustManager;
