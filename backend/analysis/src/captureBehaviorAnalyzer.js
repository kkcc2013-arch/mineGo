/**
 * 捕获行为分析引擎
 * 分析 AR 捕获模式下的用户行为特征，检测异常和作弊行为
 * 
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 */

'use strict';

const { logger, metrics } = require('../../shared/logging');
const { v4: uuidv4 } = require('uuid');

/**
 * 捕获行为分析器
 */
class CaptureBehaviorAnalyzer {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    
    this.config = {
      // 位置熵值阈值（低于此值表示位置过于集中）
      locationEntropyThreshold: config.locationEntropyThreshold || 0.3,
      // 位置跳变次数阈值
      locationJumpThreshold: config.locationJumpThreshold || 5,
      // 成功率异常阈值
      successRateThreshold: config.successRateThreshold || 0.95,
      // 捕获间隔方差阈值（低于此值可能为自动化脚本）
      captureIntervalVarianceThreshold: config.captureIntervalVarianceThreshold || 0.1,
      // 设备变更次数阈值
      deviceChangeThreshold: config.deviceChangeThreshold || 3,
      // 分析时间窗口（小时）
      analysisWindowHours: config.analysisWindowHours || 24,
      // 历史数据查询天数
      historyDays: config.historyDays || 7,
      ...config
    };
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    if (metrics && metrics.gauge) {
      metrics.gauge('capture_risk_score', 'Current capture risk score', ['user_id']);
      metrics.counter('capture_analysis_total', 'Total capture analyses', ['risk_level']);
      metrics.counter('suspicious_capture_detected_total', 'Suspicious captures detected', ['reason']);
    }
  }
  
  /**
   * 分析捕获行为
   * @param {number} userId - 用户 ID
   * @param {Object} captureData - 捕获数据
   * @returns {Object} 分析结果
   */
  async analyzeCapture(userId, captureData) {
    const analysisId = uuidv4();
    const startTime = Date.now();
    
    try {
      // 提取特征
      const features = await this.extractFeatures(userId, captureData);
      
      // 计算风险分数
      const riskScore = this.calculateRiskScore(features);
      
      // 分类风险等级
      const riskLevel = this.classifyRisk(riskScore);
      
      // 生成标记
      const flags = this.generateFlags(features);
      
      // 生成建议
      const recommendation = this.generateRecommendation(riskScore, flags);
      
      // 记录分析结果
      await this.recordAnalysis(userId, analysisId, {
        features,
        riskScore,
        riskLevel,
        flags,
        captureData
      });
      
      // 更新指标
      this.updateMetrics(userId, riskScore, riskLevel);
      
      const duration = Date.now() - startTime;
      logger.info('Capture behavior analysis completed', {
        userId,
        analysisId,
        riskScore,
        riskLevel,
        duration
      });
      
      return {
        analysisId,
        riskScore,
        riskLevel,
        features,
        flags,
        recommendation,
        analyzedAt: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('Capture behavior analysis failed', {
        userId,
        analysisId,
        error: error.message
      });
      
      return {
        analysisId,
        riskScore: 50, // 中等风险
        riskLevel: 'medium',
        flags: [{ type: 'analysis_failed', reason: error.message }],
        recommendation: { type: 'monitor', reason: 'analysis_failure' }
      };
    }
  }
  
  /**
   * 提取特征
   */
  async extractFeatures(userId, captureData) {
    const windowHours = this.config.analysisWindowHours;
    const historyDays = this.config.historyDays;
    
    // 并行提取所有特征
    const [
      locationEntropy,
      locationJumpCount,
      impossibleTravel,
      captureSuccessRate,
      capturePattern,
      captureIntervals,
      deviceChanges,
      deviceFingerprint,
      playTimePattern
    ] = await Promise.all([
      this.calculateLocationEntropy(userId, { hours: historyDays * 24 }),
      this.countLocationJumps(userId, { hours: windowHours }),
      this.detectImpossibleTravel(userId, captureData.location),
      this.calculateSuccessRate(userId, { hours: windowHours }),
      this.analyzeCapturePattern(userId, { hours: windowHours }),
      this.analyzeCaptureIntervals(userId, { hours: windowHours }),
      this.countDeviceChanges(userId, { days: historyDays }),
      this.validateDeviceFingerprint(captureData.deviceFingerprint),
      this.analyzePlayTimePattern(userId, { days: historyDays })
    ]);
    
    return {
      // 位置相关特征
      location: {
        entropy: locationEntropy,
        jumpCount: locationJumpCount,
        impossibleTravel
      },
      
      // 捕获行为特征
      capture: {
        successRate: captureSuccessRate.rate,
        totalAttempts: captureSuccessRate.total,
        successAttempts: captureSuccessRate.success,
        pattern: capturePattern,
        intervals: captureIntervals
      },
      
      // 设备特征
      device: {
        changes: deviceChanges,
        fingerprint: deviceFingerprint
      },
      
      // 时间特征
      time: {
        playPattern: playTimePattern
      },
      
      // 原始数据快照
      raw: {
        location: captureData.location,
        timestamp: captureData.timestamp,
        pokemonId: captureData.pokemonId
      }
    };
  }
  
  /**
   * 计算位置熵值
   * 熵值低表示位置过于集中，可能是伪造位置
   */
  async calculateLocationEntropy(userId, options = {}) {
    const hours = options.hours || 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    try {
      const result = await this.db.query(`
        SELECT latitude, longitude
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
        ORDER BY created_at DESC
        LIMIT 500
      `, [userId, startTime]);
      
      if (result.rows.length < 10) {
        return 1; // 数据不足，不判断
      }
      
      // 将位置离散化为网格
      const gridSize = 0.001; // 约 100 米
      const gridCounts = {};
      
      for (const row of result.rows) {
        const gridKey = `${Math.floor(row.latitude / gridSize)},${Math.floor(row.longitude / gridSize)}`;
        gridCounts[gridKey] = (gridCounts[gridKey] || 0) + 1;
      }
      
      // 计算熵值
      const total = result.rows.length;
      let entropy = 0;
      
      for (const count of Object.values(gridCounts)) {
        const p = count / total;
        if (p > 0) {
          entropy -= p * Math.log2(p);
        }
      }
      
      // 归一化到 0-1 范围
      const maxEntropy = Math.log2(Object.keys(gridCounts).length);
      return maxEntropy > 0 ? entropy / maxEntropy : 0;
      
    } catch (error) {
      logger.error('Failed to calculate location entropy', { userId, error: error.message });
      return 0.5; // 默认中等值
    }
  }
  
  /**
   * 统计位置跳变次数
   * 位置跳变（瞬移）是典型的作弊特征
   */
  async countLocationJumps(userId, options = {}) {
    const hours = options.hours || 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const speedThreshold = 55.5; // 200 km/h，超过飞机速度
    
    try {
      const result = await this.db.query(`
        SELECT latitude, longitude, created_at
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
        ORDER BY created_at ASC
        LIMIT 200
      `, [userId, startTime]);
      
      if (result.rows.length < 2) {
        return 0;
      }
      
      let jumpCount = 0;
      
      for (let i = 1; i < result.rows.length; i++) {
        const prev = result.rows[i - 1];
        const curr = result.rows[i];
        
        const distance = this.calculateDistance(
          prev.latitude, prev.longitude,
          curr.latitude, curr.longitude
        );
        
        const timeDiff = (new Date(curr.created_at) - new Date(prev.created_at)) / 1000;
        const speed = timeDiff > 0 ? distance / timeDiff : 0;
        
        if (speed > speedThreshold) {
          jumpCount++;
        }
      }
      
      return jumpCount;
      
    } catch (error) {
      logger.error('Failed to count location jumps', { userId, error: error.message });
      return 0;
    }
  }
  
  /**
   * 检测不可能的位置移动
   */
  async detectImpossibleTravel(userId, currentLocation) {
    if (!currentLocation) {
      return false;
    }
    
    try {
      // 获取最近一次捕获位置
      const result = await this.db.query(`
        SELECT latitude, longitude, created_at
        FROM capture_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);
      
      if (result.rows.length === 0) {
        return false;
      }
      
      const lastLocation = result.rows[0];
      const distance = this.calculateDistance(
        lastLocation.latitude, lastLocation.longitude,
        currentLocation.latitude, currentLocation.longitude
      );
      
      const timeDiff = (Date.now() - new Date(lastLocation.created_at)) / 1000;
      const speed = timeDiff > 0 ? distance / timeDiff : 0;
      
      // 速度超过 200 km/h
      return speed > 55.5;
      
    } catch (error) {
      logger.error('Failed to detect impossible travel', { userId, error: error.message });
      return false;
    }
  }
  
  /**
   * 计算捕获成功率
   */
  async calculateSuccessRate(userId, options = {}) {
    const hours = options.hours || 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    try {
      const result = await this.db.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE success = true) as success
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
      `, [userId, startTime]);
      
      const row = result.rows[0];
      const total = parseInt(row.total) || 0;
      const success = parseInt(row.success) || 0;
      
      return {
        rate: total > 0 ? success / total : 0,
        total,
        success
      };
      
    } catch (error) {
      logger.error('Failed to calculate success rate', { userId, error: error.message });
      return { rate: 0, total: 0, success: 0 };
    }
  }
  
  /**
   * 分析捕获模式
   */
  async analyzeCapturePattern(userId, options = {}) {
    const hours = options.hours || 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    try {
      // 按精灵类型分组统计
      const result = await this.db.query(`
        SELECT 
          pokemon_id,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE success = true) as success_count
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
        GROUP BY pokemon_id
        ORDER BY count DESC
      `, [userId, startTime]);
      
      const patterns = result.rows.map(row => ({
        pokemonId: row.pokemon_id,
        count: parseInt(row.count),
        successRate: row.count > 0 ? parseInt(row.success_count) / parseInt(row.count) : 0
      }));
      
      // 检测稀有精灵异常捕获
      const rarePokemonIds = [150, 151, 144, 145, 146]; // 传说精灵
      const rareCaptures = patterns.filter(p => 
        rarePokemonIds.includes(p.pokemonId) && p.successRate > 0.8
      );
      
      return {
        uniquePokemonCount: patterns.length,
        hasRareAnomaly: rareCaptures.length > 0,
        rareCaptures,
        topPokemon: patterns.slice(0, 5)
      };
      
    } catch (error) {
      logger.error('Failed to analyze capture pattern', { userId, error: error.message });
      return { uniquePokemonCount: 0, hasRareAnomaly: false };
    }
  }
  
  /**
   * 分析捕获间隔
   */
  async analyzeCaptureIntervals(userId, options = {}) {
    const hours = options.hours || 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    try {
      const result = await this.db.query(`
        SELECT created_at
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
        ORDER BY created_at ASC
        LIMIT 100
      `, [userId, startTime]);
      
      if (result.rows.length < 2) {
        return { variance: 1, mean: 0, stdDev: 0 };
      }
      
      const intervals = [];
      for (let i = 1; i < result.rows.length; i++) {
        const interval = (new Date(result.rows[i].created_at) - new Date(result.rows[i - 1].created_at)) / 1000;
        intervals.push(interval);
      }
      
      // 计算统计量
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);
      
      // 归一化方差（相对于均值）
      const normalizedVariance = mean > 0 ? variance / (mean * mean) : 0;
      
      return {
        variance: normalizedVariance,
        mean,
        stdDev,
        count: intervals.length
      };
      
    } catch (error) {
      logger.error('Failed to analyze capture intervals', { userId, error: error.message });
      return { variance: 1, mean: 0, stdDev: 0 };
    }
  }
  
  /**
   * 统计设备变更次数
   */
  async countDeviceChanges(userId, options = {}) {
    const days = options.days || 7;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    try {
      const result = await this.db.query(`
        SELECT DISTINCT device_id
        FROM user_sessions
        WHERE user_id = $1 AND created_at > $2
      `, [userId, startTime]);
      
      return result.rows.length;
      
    } catch (error) {
      logger.error('Failed to count device changes', { userId, error: error.message });
      return 0;
    }
  }
  
  /**
   * 验证设备指纹
   */
  async validateDeviceFingerprint(fingerprint) {
    if (!fingerprint) {
      return { valid: false, reason: 'missing_fingerprint' };
    }
    
    const checks = {
      hasDeviceId: !!fingerprint.deviceId,
      hasOsVersion: !!fingerprint.osVersion,
      hasAppVersion: !!fingerprint.appVersion,
      hasScreenInfo: !!fingerprint.screenWidth && !!fingerprint.screenHeight,
      hasTimestamp: !!fingerprint.timestamp,
      timestampValid: fingerprint.timestamp && 
        (Date.now() - new Date(fingerprint.timestamp)) < 300000 // 5 分钟内
    };
    
    const validChecks = Object.values(checks).filter(v => v).length;
    const totalChecks = Object.keys(checks).length;
    
    return {
      valid: validChecks >= totalChecks * 0.8,
      checks,
      score: validChecks / totalChecks
    };
  }
  
  /**
   * 分析游戏时间模式
   */
  async analyzePlayTimePattern(userId, options = {}) {
    const days = options.days || 7;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    try {
      const result = await this.db.query(`
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as count
        FROM capture_logs
        WHERE user_id = $1 AND created_at > $2
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hour
      `, [userId, startTime]);
      
      if (result.rows.length < 3) {
        return { normal: true, reason: 'insufficient_data' };
      }
      
      // 检测异常：24 小时持续活动（自动化脚本特征）
      const hourlyCounts = new Array(24).fill(0);
      for (const row of result.rows) {
        hourlyCounts[parseInt(row.hour)] = parseInt(row.count);
      }
      
      // 计算活动小时数
      const activeHours = hourlyCounts.filter(c => c > 0).length;
      
      // 24 小时全时段活跃是异常
      if (activeHours > 22) {
        return { normal: false, reason: 'continuous_activity', activeHours };
      }
      
      return { normal: true, activeHours, hourlyDistribution: hourlyCounts };
      
    } catch (error) {
      logger.error('Failed to analyze play time pattern', { userId, error: error.message });
      return { normal: true, reason: 'analysis_failed' };
    }
  }
  
  /**
   * 计算风险分数
   */
  calculateRiskScore(features) {
    let score = 0;
    
    // 位置风险（权重 30%）
    if (features.location.entropy < this.config.locationEntropyThreshold) {
      score += 20;
    }
    if (features.location.jumpCount > this.config.locationJumpThreshold) {
      score += 15;
    }
    if (features.location.impossibleTravel) {
      score += 30;
    }
    
    // 捕获成功率风险（权重 20%）
    if (features.capture.successRate > this.config.successRateThreshold) {
      score += 15;
    }
    if (features.capture.pattern.hasRareAnomaly) {
      score += 10;
    }
    
    // 时间模式风险（权重 25%）
    if (!features.time.playPattern.normal) {
      score += 20;
    }
    if (features.capture.intervals.variance < this.config.captureIntervalVarianceThreshold) {
      score += 15;
    }
    
    // 设备风险（权重 25%）
    if (features.device.changes > this.config.deviceChangeThreshold) {
      score += 10;
    }
    if (!features.device.fingerprint.valid) {
      score += 20;
    }
    
    return Math.min(100, score);
  }
  
  /**
   * 分类风险等级
   */
  classifyRisk(score) {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    if (score >= 20) return 'low';
    return 'normal';
  }
  
  /**
   * 生成标记
   */
  generateFlags(features) {
    const flags = [];
    
    // 位置相关标记
    if (features.location.entropy < this.config.locationEntropyThreshold) {
      flags.push({
        type: 'low_location_entropy',
        severity: 'medium',
        value: features.location.entropy
      });
    }
    
    if (features.location.jumpCount > this.config.locationJumpThreshold) {
      flags.push({
        type: 'location_teleportation',
        severity: 'high',
        count: features.location.jumpCount
      });
    }
    
    if (features.location.impossibleTravel) {
      flags.push({
        type: 'impossible_travel',
        severity: 'critical'
      });
    }
    
    // 捕获行为标记
    if (features.capture.successRate > this.config.successRateThreshold) {
      flags.push({
        type: 'abnormal_success_rate',
        severity: 'high',
        value: features.capture.successRate
      });
    }
    
    if (features.capture.pattern.hasRareAnomaly) {
      flags.push({
        type: 'rare_pokemon_anomaly',
        severity: 'high',
        details: features.capture.pattern.rareCaptures
      });
    }
    
    if (features.capture.intervals.variance < this.config.captureIntervalVarianceThreshold) {
      flags.push({
        type: 'automated_pattern',
        severity: 'high',
        variance: features.capture.intervals.variance
      });
    }
    
    // 设备标记
    if (features.device.changes > this.config.deviceChangeThreshold) {
      flags.push({
        type: 'multiple_devices',
        severity: 'medium',
        count: features.device.changes
      });
    }
    
    if (!features.device.fingerprint.valid) {
      flags.push({
        type: 'invalid_fingerprint',
        severity: 'high',
        reason: features.device.fingerprint.reason
      });
    }
    
    // 时间标记
    if (!features.time.playPattern.normal) {
      flags.push({
        type: 'continuous_activity',
        severity: 'high',
        reason: features.time.playPattern.reason
      });
    }
    
    return flags;
  }
  
  /**
   * 生成建议
   */
  generateRecommendation(riskScore, flags) {
    const criticalFlags = flags.filter(f => f.severity === 'critical');
    const highFlags = flags.filter(f => f.severity === 'high');
    
    if (criticalFlags.length > 0) {
      return {
        type: 'reject',
        reason: 'critical_violation',
        details: criticalFlags.map(f => f.type),
        autoAction: 'ban_pending_review'
      };
    }
    
    if (riskScore >= 70) {
      return {
        type: 'flag',
        reason: 'high_risk_activity',
        details: highFlags.map(f => f.type),
        autoAction: 'shadow_ban',
        review: true
      };
    }
    
    if (riskScore >= 50) {
      return {
        type: 'monitor',
        reason: 'suspicious_activity',
        details: flags.slice(0, 3).map(f => f.type),
        autoAction: 'increase_monitoring',
        track: true
      };
    }
    
    if (riskScore >= 30) {
      return {
        type: 'log',
        reason: 'minor_anomaly',
        details: flags.map(f => f.type)
      };
    }
    
    return {
      type: 'allow',
      reason: 'normal'
    };
  }
  
  /**
   * 计算两点距离（米）
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球半径（米）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  toRad(deg) {
    return deg * Math.PI / 180;
  }
  
  /**
   * 记录分析结果
   */
  async recordAnalysis(userId, analysisId, data) {
    try {
      await this.db.query(`
        INSERT INTO capture_analyses (
          id, user_id, risk_score, risk_level, features, flags, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        analysisId,
        userId,
        data.riskScore,
        data.riskLevel,
        JSON.stringify(data.features),
        JSON.stringify(data.flags)
      ]);
      
      // 缓存最近的分析结果
      await this.redis.setex(
        `capture_analysis:${userId}:latest`,
        3600,
        JSON.stringify({ analysisId, riskScore: data.riskScore, riskLevel: data.riskLevel })
      );
      
    } catch (error) {
      logger.error('Failed to record analysis', { userId, analysisId, error: error.message });
    }
  }
  
  /**
   * 更新指标
   */
  updateMetrics(userId, riskScore, riskLevel) {
    if (metrics) {
      metrics.set('capture_risk_score', { user_id: userId }, riskScore);
      metrics.inc('capture_analysis_total', { risk_level: riskLevel });
    }
  }
}

module.exports = CaptureBehaviorAnalyzer;
