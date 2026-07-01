// backend/shared/RiskEvaluator.js - API 敏感操作风险评估系统
'use strict';

const { redis } = require('./database');
const { createLogger } = require('./logger');
const crypto = require('crypto');

const logger = createLogger('risk-evaluator');

/**
 * 风险评估器 - 评估 API 操作的风险等级
 */
class RiskEvaluator {
  constructor(options = {}) {
    // 敏感操作配置
    this.sensitiveOperations = new Map([
      // 支付相关
      ['payment.purchase', { level: 'critical', weight: 100, description: '购买支付' }],
      ['payment.refund', { level: 'critical', weight: 100, description: '退款操作' }],
      ['payment.withdraw', { level: 'critical', weight: 100, description: '提现操作' }],
      ['payment.bindCard', { level: 'high', weight: 80, description: '绑定银行卡' }],
      ['payment.unbindCard', { level: 'high', weight: 80, description: '解绑银行卡' }],
      
      // 账户安全相关
      ['user.changePassword', { level: 'critical', weight: 100, description: '修改密码' }],
      ['user.bindEmail', { level: 'high', weight: 80, description: '绑定邮箱' }],
      ['user.bindPhone', { level: 'high', weight: 80, description: '绑定手机' }],
      ['user.deleteAccount', { level: 'critical', weight: 100, description: '注销账户' }],
      ['user.exportData', { level: 'high', weight: 80, description: '导出数据' }],
      ['user.updateProfile', { level: 'medium', weight: 50, description: '更新资料' }],
      
      // 精灵交易相关
      ['pokemon.trade', { level: 'high', weight: 80, description: '精灵交易' }],
      ['pokemon.transfer', { level: 'medium', weight: 50, description: '精灵转移' }],
      ['pokemon.release', { level: 'low', weight: 20, description: '放生精灵' }],
      
      // 社交相关
      ['social.addFriend', { level: 'low', weight: 20, description: '添加好友' }],
      ['social.removeFriend', { level: 'low', weight: 20, description: '删除好友' }],
      ['social.sendMessage', { level: 'low', weight: 20, description: '发送消息' }],
      
      // 道馆相关
      ['gym.challenge', { level: 'low', weight: 20, description: '道馆挑战' }],
      ['gym.claim', { level: 'medium', weight: 50, description: '占领道馆' }]
    ]);
    
    // 风险等级阈值
    this.riskThresholds = {
      low: options.lowThreshold ?? 30,
      medium: options.mediumThreshold ?? 60,
      high: options.highThreshold ?? 80,
      critical: options.criticalThreshold ?? 90
    };
    
    // 风险因子权重
    this.factorWeights = {
      deviceTrust: 25,
      locationRisk: 20,
      behaviorRisk: 20,
      timeRisk: 10,
      ipRisk: 15,
      accountRisk: 10
    };
    
    // 地理位置风险配置
    this.locationRiskConfig = {
      maxSpeed: options.maxSpeed ?? 500, // km/h
      maxDistanceChange: options.maxDistanceChange ?? 1000, // km
      suspiciousRegions: options.suspiciousRegions ?? []
    };
    
    // 缓存
    this.evaluationCache = new Map();
  }

  /**
   * 综合风险评估
   */
  async evaluate(context) {
    const {
      operation,
      userId,
      deviceId,
      ip,
      userAgent,
      location,
      metadata = {}
    } = context;

    const startTime = Date.now();
    
    try {
      // 1. 获取操作基础风险
      const operationRisk = this.getOperationRisk(operation);
      
      if (!operationRisk) {
        // 未知操作，默认中等风险
        return {
          level: 'medium',
          score: 50,
          factors: { unknown: { score: 50, reason: '未知操作类型' } },
          recommendation: 'review',
          operation
        };
      }
      
      // 2. 计算各风险因子
      const factors = {};
      
      // 设备信任风险
      factors.deviceTrust = await this.evaluateDeviceTrust(userId, deviceId);
      
      // 地理位置风险
      factors.locationRisk = await this.evaluateLocationRisk(userId, location);
      
      // 行为风险
      factors.behaviorRisk = await this.evaluateBehaviorRisk(userId, operation);
      
      // 时间风险
      factors.timeRisk = this.evaluateTimeRisk();
      
      // IP 风险
      factors.ipRisk = await this.evaluateIpRisk(ip, userId);
      
      // 账户风险
      factors.accountRisk = await this.evaluateAccountRisk(userId);
      
      // 3. 计算综合风险分数
      let totalScore = operationRisk.weight;
      let factorWeight = 0;
      
      for (const [factorName, factor] of Object.entries(factors)) {
        const weight = this.factorWeights[factorName] || 10;
        totalScore += (factor.score / 100) * weight;
        factorWeight += weight;
      }
      
      // 归一化分数
      const normalizedScore = Math.min(100, Math.max(0, totalScore));
      
      // 4. 确定风险等级
      const level = this.determineRiskLevel(normalizedScore);
      
      // 5. 生成建议
      const recommendation = this.generateRecommendation(level, factors, operationRisk);
      
      const evaluation = {
        level,
        score: normalizedScore,
        operationRisk,
        factors,
        recommendation,
        metadata: {
          evaluationTime: Date.now() - startTime,
          timestamp: Date.now()
        }
      };
      
      // 6. 记录评估结果
      await this.recordEvaluation(userId, operation, evaluation);
      
      return evaluation;
      
    } catch (error) {
      logger.error({ error, operation, userId }, 'Risk evaluation failed');
      
      // 评估失败，保守起见返回高风险
      return {
        level: 'high',
        score: 80,
        factors: {},
        recommendation: 'verify',
        error: error.message
      };
    }
  }

  /**
   * 获取操作风险
   */
  getOperationRisk(operation) {
    return this.sensitiveOperations.get(operation) || null;
  }

  /**
   * 评估设备信任
   */
  async evaluateDeviceTrust(userId, deviceId) {
    if (!deviceId) {
      return {
        score: 70,
        reason: '未提供设备信息',
        risk: 'high'
      };
    }
    
    try {
      // 获取设备信任记录
      const deviceKey = `device:trust:${userId}:${deviceId}`;
      const trustData = await redis.get(deviceKey);
      
      if (!trustData) {
        return {
          score: 50,
          reason: '新设备',
          risk: 'medium'
        };
      }
      
      const trust = JSON.parse(trustData);
      
      // 计算设备信任分数
      let score = 0;
      const reasons = [];
      
      // 使用时长
      if (trust.firstSeen) {
        const daysSinceFirstSeen = (Date.now() - trust.firstSeen) / (1000 * 60 * 60 * 24);
        if (daysSinceFirstSeen > 30) {
          score -= 10;
          reasons.push('长期信任设备');
        } else if (daysSinceFirstSeen > 7) {
          score -= 5;
          reasons.push('已使用一周以上');
        }
      }
      
      // 最近使用频率
      if (trust.recentUsageCount > 10) {
        score -= 10;
        reasons.push('频繁使用');
      }
      
      // 安全标记
      if (trust.isTrusted) {
        score -= 20;
        reasons.push('已标记为信任设备');
      }
      
      if (trust.isSuspicious) {
        score += 30;
        reasons.push('可疑设备');
      }
      
      // 设备指纹异常
      if (trust.fingerprintMismatch) {
        score += 20;
        reasons.push('设备指纹不匹配');
      }
      
      // Root/越狱
      if (trust.isRooted) {
        score += 15;
        reasons.push('设备已 Root/越狱');
      }
      
      return {
        score: Math.min(100, Math.max(0, 30 + score)),
        reason: reasons.join(', ') || '正常设备',
        risk: score > 20 ? 'high' : score > 0 ? 'medium' : 'low',
        details: trust
      };
      
    } catch (error) {
      logger.error({ error, userId, deviceId }, 'Device trust evaluation failed');
      return {
        score: 50,
        reason: '评估失败',
        risk: 'unknown'
      };
    }
  }

  /**
   * 评估地理位置风险
   */
  async evaluateLocationRisk(userId, currentLocation) {
    if (!currentLocation) {
      return {
        score: 50,
        reason: '未提供位置信息',
        risk: 'medium'
      };
    }
    
    try {
      // 获取上次位置
      const lastLocationKey = `user:lastLocation:${userId}`;
      const lastLocationData = await redis.get(lastLocationKey);
      
      if (!lastLocationData) {
        // 第一次提供位置
        await redis.setex(lastLocationKey, 3600 * 24 * 7, JSON.stringify({
          ...currentLocation,
          timestamp: Date.now()
        }));
        
        return {
          score: 30,
          reason: '首次记录位置',
          risk: 'low'
        };
      }
      
      const lastLocation = JSON.parse(lastLocationData);
      
      // 计算距离变化
      const distance = this.calculateDistance(
        lastLocation.lat,
        lastLocation.lng,
        currentLocation.lat,
        currentLocation.lng
      );
      
      // 计算时间差
      const timeDiff = (Date.now() - lastLocation.timestamp) / 1000 / 3600; // 小时
      
      // 计算速度
      const speed = distance / timeDiff;
      
      // 风险评估
      let score = 0;
      const reasons = [];
      
      // 检查速度异常（瞬移）
      if (speed > this.locationRiskConfig.maxSpeed && timeDiff < 24) {
        score += 50;
        reasons.push(`异常移动速度: ${speed.toFixed(0)} km/h`);
      }
      
      // 检查跨区域
      if (distance > this.locationRiskConfig.maxDistanceChange) {
        score += 30;
        reasons.push(`跨区域登录: ${distance.toFixed(0)} km`);
      }
      
      // 更新位置记录
      await redis.setex(lastLocationKey, 3600 * 24 * 7, JSON.stringify({
        ...currentLocation,
        timestamp: Date.now()
      }));
      
      return {
        score: Math.min(100, score),
        reason: reasons.length > 0 ? reasons.join(', ') : '位置正常',
        risk: score > 50 ? 'high' : score > 20 ? 'medium' : 'low',
        details: { distance, speed, timeDiff }
      };
      
    } catch (error) {
      logger.error({ error, userId }, 'Location risk evaluation failed');
      return {
        score: 30,
        reason: '评估失败',
        risk: 'unknown'
      };
    }
  }

  /**
   * 评估行为风险
   */
  async evaluateBehaviorRisk(userId, operation) {
    try {
      // 获取近期操作历史
      const historyKey = `user:operations:${userId}`;
      const historyData = await redis.lrange(historyKey, 0, 50);
      
      if (historyData.length === 0) {
        return {
          score: 20,
          reason: '无历史记录',
          risk: 'low'
        };
      }
      
      const history = historyData.map(h => JSON.parse(h));
      
      // 计算风险因子
      let score = 0;
      const reasons = [];
      
      // 高频操作
      const recentCount = history.filter(h => 
        Date.now() - h.timestamp < 60000
      ).length;
      
      if (recentCount > 10) {
        score += 30;
        reasons.push(`高频操作: ${recentCount} 次/分钟`);
      }
      
      // 敏感操作频率
      const sensitiveOps = history.filter(h => {
        const opRisk = this.getOperationRisk(h.operation);
        return opRisk && opRisk.level === 'critical';
      });
      
      if (sensitiveOps.length > 3) {
        score += 20;
        reasons.push('频繁敏感操作');
      }
      
      // 操作模式异常
      const uniqueOps = new Set(history.map(h => h.operation));
      if (history.length > 20 && uniqueOps.size < 3) {
        score += 15;
        reasons.push('操作模式单一');
      }
      
      // 失败率
      const failedOps = history.filter(h => h.status === 'failed');
      if (failedOps.length > history.length * 0.3) {
        score += 25;
        reasons.push('操作失败率高');
      }
      
      return {
        score: Math.min(100, score),
        reason: reasons.length > 0 ? reasons.join(', ') : '行为正常',
        risk: score > 50 ? 'high' : score > 20 ? 'medium' : 'low'
      };
      
    } catch (error) {
      logger.error({ error, userId }, 'Behavior risk evaluation failed');
      return {
        score: 30,
        reason: '评估失败',
        risk: 'unknown'
      };
    }
  }

  /**
   * 评估时间风险
   */
  evaluateTimeRisk() {
    const hour = new Date().getHours();
    
    // 凌晨 0-6 点高风险
    if (hour >= 0 && hour < 6) {
      return {
        score: 40,
        reason: '非正常时段',
        risk: 'medium'
      };
    }
    
    return {
      score: 10,
      reason: '正常时段',
      risk: 'low'
    };
  }

  /**
   * 评估 IP 风险
   */
  async evaluateIpRisk(ip, userId) {
    if (!ip) {
      return {
        score: 50,
        reason: '未提供 IP',
        risk: 'medium'
      };
    }
    
    try {
      // 获取 IP 历史记录
      const ipHistoryKey = `user:ips:${userId}`;
      const knownIps = await redis.smembers(ipHistoryKey);
      
      // 检查是否为已知 IP
      const isKnownIp = knownIps.includes(ip);
      
      // 获取 IP 风险信息
      const ipRiskKey = `ip:risk:${ip}`;
      const ipRiskData = await redis.get(ipRiskKey);
      
      let score = 0;
      const reasons = [];
      
      if (!isKnownIp) {
        score += 30;
        reasons.push('新 IP 地址');
        
        // 记录新 IP
        await redis.sadd(ipHistoryKey, ip);
        await redis.expire(ipHistoryKey, 3600 * 24 * 30);
      }
      
      if (ipRiskData) {
        const ipRisk = JSON.parse(ipRiskData);
        
        if (ipRisk.isVpn) {
          score += 40;
          reasons.push('VPN/代理');
        }
        
        if (ipRisk.isTor) {
          score += 60;
          reasons.push('Tor 出口节点');
        }
        
        if (ipRisk.isBlacklisted) {
          score += 80;
          reasons.push('IP 在黑名单中');
        }
        
        if (ipRisk.threatScore > 50) {
          score += ipRisk.threatScore * 0.5;
          reasons.push(`威胁评分: ${ipRisk.threatScore}`);
        }
      }
      
      return {
        score: Math.min(100, score),
        reason: reasons.length > 0 ? reasons.join(', ') : 'IP 正常',
        risk: score > 50 ? 'high' : score > 20 ? 'medium' : 'low',
        isKnownIp
      };
      
    } catch (error) {
      logger.error({ error, ip, userId }, 'IP risk evaluation failed');
      return {
        score: 30,
        reason: '评估失败',
        risk: 'unknown'
      };
    }
  }

  /**
   * 评估账户风险
   */
  async evaluateAccountRisk(userId) {
    try {
      // 获取账户信息
      const accountKey = `user:account:${userId}`;
      const accountData = await redis.get(accountKey);
      
      if (!accountData) {
        return {
          score: 30,
          reason: '账户信息缺失',
          risk: 'medium'
        };
      }
      
      const account = JSON.parse(accountData);
      
      let score = 0;
      const reasons = [];
      
      // 账户年龄
      const accountAge = Date.now() - new Date(account.createdAt).getTime();
      const daysSinceCreation = accountAge / (1000 * 60 * 60 * 24);
      
      if (daysSinceCreation < 1) {
        score += 40;
        reasons.push('新注册账户');
      } else if (daysSinceCreation < 7) {
        score += 20;
        reasons.push('账户注册不足一周');
      }
      
      // 安全设置
      if (!account.mfaEnabled) {
        score += 15;
        reasons.push('未启用 MFA');
      }
      
      if (!account.emailVerified) {
        score += 10;
        reasons.push('邮箱未验证');
      }
      
      // 账户状态
      if (account.isFlagged) {
        score += 50;
        reasons.push('账户被标记');
      }
      
      if (account.suspiciousLoginCount > 3) {
        score += 30;
        reasons.push('多次可疑登录');
      }
      
      return {
        score: Math.min(100, score),
        reason: reasons.length > 0 ? reasons.join(', ') : '账户状态正常',
        risk: score > 50 ? 'high' : score > 20 ? 'medium' : 'low'
      };
      
    } catch (error) {
      logger.error({ error, userId }, 'Account risk evaluation failed');
      return {
        score: 30,
        reason: '评估失败',
        risk: 'unknown'
      };
    }
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(score) {
    if (score >= this.riskThresholds.critical) return 'critical';
    if (score >= this.riskThresholds.high) return 'high';
    if (score >= this.riskThresholds.medium) return 'medium';
    return 'low';
  }

  /**
   * 生成建议
   */
  generateRecommendation(level, factors, operationRisk) {
    const recommendations = [];
    
    switch (level) {
      case 'critical':
        recommendations.push('需要二次验证（MFA/短信/邮箱）');
        recommendations.push('建议人工审核');
        break;
      
      case 'high':
        recommendations.push('需要额外验证');
        if (factors.ipRisk?.score > 50) {
          recommendations.push('建议验证 IP 来源');
        }
        if (factors.deviceTrust?.score > 50) {
          recommendations.push('建议设备验证');
        }
        break;
      
      case 'medium':
        recommendations.push('可选验证');
        recommendations.push('记录操作日志');
        break;
      
      case 'low':
        recommendations.push('允许操作');
        recommendations.push('正常记录');
        break;
    }
    
    // 根据操作类型添加特定建议
    if (operationRisk.level === 'critical') {
      recommendations.unshift('【关键操作】需要强验证');
    }
    
    return recommendations;
  }

  /**
   * 记录评估结果
   */
  async recordEvaluation(userId, operation, evaluation) {
    try {
      // 记录到 Redis
      const historyKey = `user:operations:${userId}`;
      const record = {
        operation,
        score: evaluation.score,
        level: evaluation.level,
        timestamp: Date.now(),
        status: 'evaluated'
      };
      
      await redis.lpush(historyKey, JSON.stringify(record));
      await redis.ltrim(historyKey, 0, 100);
      await redis.expire(historyKey, 3600 * 24 * 7);
      
      // 高风险操作记录到数据库
      if (evaluation.level === 'high' || evaluation.level === 'critical') {
        await this.logHighRiskOperation(userId, operation, evaluation);
      }
      
    } catch (error) {
      logger.error({ error, userId, operation }, 'Failed to record evaluation');
    }
  }

  /**
   * 记录高风险操作
   */
  async logHighRiskOperation(userId, operation, evaluation) {
    // 这里应该写入数据库
    logger.warn({
      userId,
      operation,
      score: evaluation.score,
      level: evaluation.level,
      factors: evaluation.factors
    }, 'High risk operation detected');
  }

  /**
   * 计算两点距离（Haversine 公式）
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 注册敏感操作
   */
  registerOperation(operation, config) {
    this.sensitiveOperations.set(operation, {
      level: config.level || 'medium',
      weight: config.weight || 50,
      description: config.description || ''
    });
  }

  /**
   * 获取所有敏感操作
   */
  getAllOperations() {
    return Array.from(this.sensitiveOperations.entries()).map(([op, config]) => ({
      operation: op,
      ...config
    }));
  }
}

module.exports = RiskEvaluator;
