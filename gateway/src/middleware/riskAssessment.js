/**
 * 敏感 API 风险评估中间件
 * 
 * REQ-00588: 敏感 API 二次身份验证与风控行为分级系统
 * 
 * 根据多维度指标计算请求风险分值，触发二次验证
 */

'use strict';

const { logger } = require('../../../shared/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * 风险等级定义
 */
const RiskLevel = {
  LOW: 'low',           // 0-30 分：低风险，正常访问
  MEDIUM: 'medium',     // 31-60 分：中等风险，监控
  HIGH: 'high',         // 61-80 分：高风险，需要二次验证
  CRITICAL: 'critical'  // 81-100 分：严重风险，拒绝访问
};

/**
 * 风险评分阈值
 */
const RISK_THRESHOLDS = {
  [RiskLevel.LOW]: 30,
  [RiskLevel.MEDIUM]: 60,
  [RiskLevel.HIGH]: 80,
  [RiskLevel.CRITICAL]: 100
};

/**
 * 敏感 API 清单
 */
const SENSITIVE_API_DEFINITIONS = {
  // P0 - 极度敏感：涉及资金、账号安全
  'P0': [
    '/api/v1/payment/withdraw',
    '/api/v1/payment/transfer',
    '/api/v1/user/change-password',
    '/api/v1/user/delete-account',
    '/api/v1/user/bind-email',
    '/api/v1/user/bind-phone',
    '/api/v1/user/change-payment-password'
  ],
  // P1 - 高敏感：涉及重要资产操作
  'P1': [
    '/api/v1/pokemon/trade',
    '/api/v1/pokemon/transfer',
    '/api/v1/pokemon/release-batch',
    '/api/v1/gym/claim-reward',
    '/api/v1/social/update-profile',
    '/api/v1/user/update-settings'
  ],
  // P2 - 中敏感：涉及用户数据
  'P2': [
    '/api/v1/user/export-data',
    '/api/v1/social/post-create',
    '/api/v1/social/post-delete'
  ]
};

/**
 * 风险评估中间件
 */
class RiskAssessmentMiddleware {
  constructor(redis, db, config = {}) {
    this.redis = redis;
    this.db = db;
    
    this.config = {
      // 二次验证有效期（秒）
      mfaTokenTTL: config.mfaTokenTTL || 300, // 5 分钟
      // 风险评估缓存时间
      riskCacheTTL: config.riskCacheTTL || 60,
      // 地理位置变化阈值（km）
      geoDistanceThreshold: config.geoDistanceThreshold || 500,
      // IP 频率阈值（每分钟）
      ipFrequencyThreshold: config.ipFrequencyThreshold || 100,
      // 设备切换阈值
      deviceSwitchThreshold: config.deviceSwitchThreshold || 3,
      ...config
    };
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 指标会在 shared/metrics 中统一注册
  }
  
  /**
   * 判断 API 敏感级别
   */
  getApiSensitivity(path) {
    for (const [level, apis] of Object.entries(SENSITIVE_API_DEFINITIONS)) {
      if (apis.some(api => path.startsWith(api))) {
        return level;
      }
    }
    return null; // 非敏感 API
  }
  
  /**
   * 主中间件函数
   */
  middleware() {
    return async (req, res, next) => {
      // 1. 检查是否为敏感 API
      const sensitivity = this.getApiSensitivity(req.path);
      if (!sensitivity) {
        return next(); // 非敏感 API，直接放行
      }
      
      // 2. 检查是否已携带有效的二次验证令牌
      const mfaToken = req.headers['x-mfa-token'];
      if (mfaToken) {
        const isValid = await this.validateMfaToken(req.user?.id, mfaToken, req.path);
        if (isValid) {
          return next(); // 令牌有效，放行
        }
      }
      
      // 3. 计算风险分值
      const riskScore = await this.calculateRiskScore(req);
      const riskLevel = this.getRiskLevel(riskScore);
      
      // 4. 根据风险等级和 API 敏感度决定处理策略
      const decision = this.makeDecision(sensitivity, riskLevel, riskScore);
      
      // 记录风险评估日志
      await this.logRiskAssessment(req, riskScore, riskLevel, decision);
      
      switch (decision.action) {
        case 'allow':
          return next();
          
        case 'challenge':
          // 触发二次验证
          const challengeToken = await this.createChallengeToken(req.user?.id, req.path, riskScore);
          return res.status(403).json({
            error: 'MFA_REQUIRED',
            message: '此操作需要二次身份验证',
            challengeToken,
            challengeType: decision.challengeType,
            expiresAt: new Date(Date.now() + this.config.mfaTokenTTL * 1000).toISOString()
          });
          
        case 'deny':
          return res.status(403).json({
            error: 'ACCESS_DENIED',
            message: '检测到异常访问行为，操作已被拒绝',
            reason: decision.reason,
            supportContact: 'security@minego.game'
          });
          
        default:
          return next();
      }
    };
  }
  
  /**
   * 计算风险分值（0-100）
   */
  async calculateRiskScore(req) {
    const userId = req.user?.id;
    const ip = req.ip;
    const deviceId = req.headers['x-device-id'];
    const userAgent = req.headers['user-agent'];
    
    let score = 0;
    const factors = [];
    
    try {
      // 1. IP 风险评估（权重 25%）
      const ipRisk = await this.assessIpRisk(ip, userId);
      score += ipRisk.score;
      factors.push(ipRisk);
      
      // 2. 设备风险评估（权重 20%）
      const deviceRisk = await this.assessDeviceRisk(deviceId, userId);
      score += deviceRisk.score;
      factors.push(deviceRisk);
      
      // 3. 地理位置风险评估（权重 20%）
      const geoRisk = await this.assessGeoRisk(req, userId);
      score += geoRisk.score;
      factors.push(geoRisk);
      
      // 4. 会话风险评估（权重 15%）
      const sessionRisk = await this.assessSessionRisk(req);
      score += sessionRisk.score;
      factors.push(sessionRisk);
      
      // 5. 行为模式评估（权重 20%）
      const behaviorRisk = await this.assessBehaviorRisk(userId, req.path);
      score += behaviorRisk.score;
      factors.push(behaviorRisk);
      
      // 缓存风险评分
      await this.cacheRiskScore(userId, score);
      
      return Math.min(100, Math.max(0, score));
      
    } catch (error) {
      logger.error('Risk assessment failed', {
        userId,
        ip,
        error: error.message
      });
      
      // 评估失败时返回中等风险
      return 50;
    }
  }
  
  /**
   * IP 风险评估
   */
  async assessIpRisk(ip, userId) {
    let score = 0;
    const reasons = [];
    
    // 检查 IP 是否在黑名单
    const isBlacklisted = await this.redis.sismember('ip_blacklist', ip);
    if (isBlacklisted) {
      score += 40;
      reasons.push('ip_blacklisted');
    }
    
    // 检查 IP 频率
    const ipFreqKey = `ip_freq:${ip}`;
    const ipFreq = await this.redis.incr(ipFreqKey);
    if (ipFreq === 1) {
      await this.redis.expire(ipFreqKey, 60);
    }
    if (ipFreq > this.config.ipFrequencyThreshold) {
      score += 15;
      reasons.push('ip_high_frequency');
    }
    
    // 检查 IP 是否为已知代理/VPN
    const isProxy = await this.checkProxyIP(ip);
    if (isProxy) {
      score += 10;
      reasons.push('ip_proxy_detected');
    }
    
    // 检查 IP 归属地与用户常用地区是否匹配
    const userRegion = await this.getUserRegion(userId);
    const ipRegion = await this.getIpRegion(ip);
    if (userRegion && ipRegion && userRegion !== ipRegion) {
      score += 8;
      reasons.push('ip_region_mismatch');
    }
    
    return { score, reasons, category: 'ip' };
  }
  
  /**
   * 设备风险评估
   */
  async assessDeviceRisk(deviceId, userId) {
    if (!deviceId) {
      return { score: 10, reasons: ['missing_device_id'], category: 'device' };
    }
    
    let score = 0;
    const reasons = [];
    
    // 检查设备是否被标记
    const deviceFlagKey = `device_flag:${deviceId}`;
    const isFlagged = await this.redis.get(deviceFlagKey);
    if (isFlagged) {
      score += 25;
      reasons.push('device_flagged');
    }
    
    // 检查设备切换频率
    const recentDevicesKey = `user_devices:${userId}`;
    const recentDevices = await this.redis.lrange(recentDevicesKey, 0, -1);
    
    if (!recentDevices.includes(deviceId)) {
      await this.redis.lpush(recentDevicesKey, deviceId);
      await this.redis.ltrim(recentDevicesKey, 0, 9);
      await this.redis.expire(recentDevicesKey, 24 * 3600);
      
      if (recentDevices.length >= this.config.deviceSwitchThreshold) {
        score += 15;
        reasons.push('frequent_device_switch');
      }
    }
    
    // 检查设备指纹异常（root/越狱/模拟器）
    const deviceFingerprint = await this.redis.hgetall(`device_info:${deviceId}`);
    if (deviceFingerprint) {
      if (deviceFingerprint.isRooted === 'true') {
        score += 12;
        reasons.push('device_rooted');
      }
      if (deviceFingerprint.isEmulator === 'true') {
        score += 18;
        reasons.push('device_emulator');
      }
      if (deviceFingerprint.hookDetected === 'true') {
        score += 20;
        reasons.push('device_hook_detected');
      }
    }
    
    return { score, reasons, category: 'device' };
  }
  
  /**
   * 地理位置风险评估
   */
  async assessGeoRisk(req, userId) {
    let score = 0;
    const reasons = [];
    
    const locationHeader = req.headers['x-user-location'];
    if (!locationHeader) {
      return { score: 5, reasons: ['missing_location'], category: 'geo' };
    }
    
    try {
      const location = JSON.parse(locationHeader);
      const lastLocationKey = `user_last_location:${userId}`;
      const lastLocationData = await this.redis.get(lastLocationKey);
      
      if (lastLocationData) {
        const lastLocation = JSON.parse(lastLocationData);
        const distance = this.calculateDistance(
          location.lat, location.lng,
          lastLocation.lat, lastLocation.lng
        );
        
        // 检查时间戳
        const timeDiff = Date.now() - lastLocation.timestamp;
        const hours = timeDiff / (1000 * 60 * 60);
        
        if (hours > 0 && distance / hours > this.config.geoDistanceThreshold) {
          score += 25;
          reasons.push('impossible_travel');
        }
      }
      
      // 更新最后位置
      await this.redis.setex(lastLocationKey, 3600, JSON.stringify({
        ...location,
        timestamp: Date.now()
      }));
      
    } catch (error) {
      score += 5;
      reasons.push('invalid_location_format');
    }
    
    return { score, reasons, category: 'geo' };
  }
  
  /**
   * 会话风险评估
   */
  async assessSessionRisk(req) {
    let score = 0;
    const reasons = [];
    
    // 检查会话年龄
    const sessionAge = req.user?.sessionCreatedAt 
      ? Date.now() - new Date(req.user.sessionCreatedAt).getTime()
      : 0;
    
    // 新会话（< 5 分钟）在敏感操作时增加风险
    if (sessionAge < 5 * 60 * 1000) {
      score += 10;
      reasons.push('new_session');
    }
    
    // 检查会话是否存在异地登录
    const sessionCountKey = `user_sessions:${req.user?.id}`;
    const sessionCount = await this.redis.scard(sessionCountKey);
    if (sessionCount > 3) {
      score += 8;
      reasons.push('multiple_sessions');
    }
    
    return { score, reasons, category: 'session' };
  }
  
  /**
   * 行为模式风险评估
   */
  async assessBehaviorRisk(userId, path) {
    let score = 0;
    const reasons = [];
    
    // 检查敏感操作频率
    const sensitiveOpKey = `sensitive_ops:${userId}`;
    const opCount = await this.redis.incr(sensitiveOpKey);
    if (opCount === 1) {
      await this.redis.expire(sensitiveOpKey, 3600);
    }
    
    if (opCount > 5) {
      score += 15;
      reasons.push('high_sensitive_operation_frequency');
    }
    
    // 检查最近是否有失败的验证尝试
    const failedAttemptsKey = `failed_mfa:${userId}`;
    const failedAttempts = await this.redis.get(failedAttemptsKey);
    if (failedAttempts && parseInt(failedAttempts) >= 3) {
      score += 20;
      reasons.push('multiple_failed_mfa');
    }
    
    return { score, reasons, category: 'behavior' };
  }
  
  /**
   * 获取风险等级
   */
  getRiskLevel(score) {
    if (score <= RISK_THRESHOLDS[RiskLevel.LOW]) return RiskLevel.LOW;
    if (score <= RISK_THRESHOLDS[RiskLevel.MEDIUM]) return RiskLevel.MEDIUM;
    if (score <= RISK_THRESHOLDS[RiskLevel.HIGH]) return RiskLevel.HIGH;
    return RiskLevel.CRITICAL;
  }
  
  /**
   * 决策处理策略
   */
  makeDecision(sensitivity, riskLevel, riskScore) {
    // P0 极度敏感 API：任何中等以上风险都需要验证
    if (sensitivity === 'P0') {
      if (riskLevel === RiskLevel.CRITICAL) {
        return { action: 'deny', reason: 'critical_risk_on_highly_sensitive_api' };
      }
      if (riskLevel === RiskLevel.HIGH) {
        return { action: 'challenge', challengeType: 'full_mfa' };
      }
      if (riskLevel === RiskLevel.MEDIUM) {
        return { action: 'challenge', challengeType: 'quick_verify' };
      }
      return { action: 'challenge', challengeType: 'quick_verify' }; // P0 默认需要验证
    }
    
    // P1 高敏感 API
    if (sensitivity === 'P1') {
      if (riskLevel === RiskLevel.CRITICAL) {
        return { action: 'deny', reason: 'critical_risk_on_sensitive_api' };
      }
      if (riskLevel === RiskLevel.HIGH) {
        return { action: 'challenge', challengeType: 'full_mfa' };
      }
      if (riskLevel === RiskLevel.MEDIUM) {
        return { action: 'challenge', challengeType: 'quick_verify' };
      }
      return { action: 'allow' };
    }
    
    // P2 中敏感 API
    if (sensitivity === 'P2') {
      if (riskLevel === RiskLevel.CRITICAL) {
        return { action: 'deny', reason: 'critical_risk_detected' };
      }
      if (riskLevel === RiskLevel.HIGH) {
        return { action: 'challenge', challengeType: 'quick_verify' };
      }
      return { action: 'allow' };
    }
    
    return { action: 'allow' };
  }
  
  /**
   * 创建挑战令牌
   */
  async createChallengeToken(userId, path, riskScore) {
    const token = uuidv4();
    const key = `mfa_challenge:${userId}:${token}`;
    
    await this.redis.hset(key, {
      path,
      riskScore: riskScore.toString(),
      createdAt: Date.now().toString()
    });
    await this.redis.expire(key, this.config.mfaTokenTTL);
    
    return token;
  }
  
  /**
   * 验证二次验证令牌
   */
  async validateMfaToken(userId, token, path) {
    try {
      const key = `mfa_verified:${userId}:${token}`;
      const data = await this.redis.hgetall(key);
      
      if (!data || !data.path) {
        return false;
      }
      
      // 检查路径是否匹配
      if (!path.startsWith(data.path)) {
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to validate MFA token', { userId, error: error.message });
      return false;
    }
  }
  
  /**
   * 记录风险评估日志
   */
  async logRiskAssessment(req, score, level, decision) {
    try {
      const logEntry = {
        userId: req.user?.id,
        ip: req.ip,
        path: req.path,
        method: req.method,
        score,
        level,
        action: decision.action,
        timestamp: new Date().toISOString()
      };
      
      // 写入 Redis 用于实时分析
      await this.redis.lpush('risk_assessment_logs', JSON.stringify(logEntry));
      await this.redis.ltrim('risk_assessment_logs', 0, 9999);
      
      // 写入数据库用于审计
      await this.db.query(`
        INSERT INTO security_risk_assessments (
          user_id, ip_address, endpoint, risk_score, risk_level, action, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [req.user?.id, req.ip, req.path, score, level, decision.action]);
      
      logger.info('Risk assessment completed', logEntry);
      
    } catch (error) {
      logger.error('Failed to log risk assessment', { error: error.message });
    }
  }
  
  /**
   * 缓存风险评分
   */
  async cacheRiskScore(userId, score) {
    const key = `user_risk_score:${userId}`;
    await this.redis.setex(key, this.config.riskCacheTTL, score.toString());
  }
  
  // ==================== 辅助方法 ====================
  
  async checkProxyIP(ip) {
    // 简化实现：检查已知代理 IP 段
    const proxyRanges = ['10.', '172.16.', '192.168.'];
    return proxyRanges.some(range => ip.startsWith(range));
  }
  
  async getUserRegion(userId) {
    try {
      const key = `user_region:${userId}`;
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }
  
  async getIpRegion(ip) {
    // 简化实现：基于 IP 段判断
    if (ip.startsWith('10.') || ip.startsWith('192.168.')) return 'local';
    return 'unknown';
  }
  
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（km）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  toRad(deg) {
    return deg * (Math.PI / 180);
  }
}

module.exports = RiskAssessmentMiddleware;
module.exports.RiskLevel = RiskLevel;
module.exports.SENSITIVE_API_DEFINITIONS = SENSITIVE_API_DEFINITIONS;