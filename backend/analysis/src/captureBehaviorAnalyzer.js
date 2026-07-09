/**
 * CaptureBehaviorAnalyzer - AR 捕获行为分析引擎
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 * 
 * 功能：
 * - 捕捉行为特征提取
 * - 风险评分计算
 * - 异常行为检测
 * - 模式识别
 */

const db = require('../../shared/db');
const logger = require('../../shared/logger');
const metrics = require('../../shared/metrics');

class CaptureBehaviorAnalyzer {
  constructor() {
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initMetrics() {
    return {
      analysesTotal: metrics.registerCounter(
        'capture_behavior_analysis_total',
        'Total capture behavior analyses',
        ['result']
      ),
      riskScores: metrics.registerHistogram(
        'capture_risk_score',
        'Capture risk score distribution',
        { buckets: [0, 20, 40, 60, 80, 100] }
      ),
      violationsDetected: metrics.registerCounter(
        'capture_violation_detected_total',
        'Total violations detected',
        ['violation_type']
      )
    };
  }

  /**
   * 分析捕捉行为
   */
  async analyzeCapture(userId, captureData) {
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

      // 记录指标
      this.metrics.analysesTotal.inc({ result: riskLevel });
      this.metrics.riskScores.observe(riskScore);

      logger.info('Capture behavior analyzed', {
        userId,
        riskScore,
        riskLevel,
        flags: flags.map(f => f.type)
      });

      return {
        riskScore,
        riskLevel,
        features,
        flags,
        recommendation
      };
    } catch (error) {
      logger.error('Failed to analyze capture behavior', { userId, error });
      throw error;
    }
  }

  /**
   * 提取特征
   */
  async extractFeatures(userId, captureData) {
    const features = {
      // 位置相关
      location: {},
      // 捕捉行为
      capture: {},
      // 设备特征
      device: {},
      // 时间特征
      timing: {}
    };

    try {
      // ===== 位置特征 =====
      features.location = {
        entropy: await this._calculateLocationEntropy(userId),
        jumpCount: await this._countLocationJumps(userId, { hours: 24 }),
        impossibleTravel: await this._detectImpossibleTravel(userId),
        radiusKm: await this._calculateActivityRadius(userId),
        uniqueLocations: await this._countUniqueLocations(userId)
      };

      // ===== 捕捉行为特征 =====
      features.capture = {
        successRate: await this._calculateSuccessRate(userId),
        speed: this._calculateCaptureSpeed(captureData),
        pattern: await this._analyzeCapturePattern(userId),
        rarityScore: await this._calculateRarityScore(userId),
        consecutiveCaptures: await this._countConsecutiveCaptures(userId)
      };

      // ===== 设备特征 =====
      features.device = {
        changes: await this._countDeviceChanges(userId),
        fingerprintValid: captureData.deviceFingerprint?.valid !== false,
        emulatorDetected: captureData.deviceFingerprint?.emulatorDetected || false,
        rootDetected: captureData.deviceFingerprint?.rootDetected || false
      };

      // ===== 时间特征 =====
      features.timing = {
        playPattern: await this._analyzePlayTimePattern(userId),
        captureIntervals: await this._analyzeCaptureIntervals(userId),
        sessionDuration: captureData.sessionDuration || 0
      };
    } catch (error) {
      logger.error('Failed to extract features', { userId, error });
    }

    return features;
  }

  /**
   * 计算风险分数
   */
  calculateRiskScore(features) {
    let score = 0;
    const weights = {
      location: 0.35,    // 位置风险权重 35%
      capture: 0.25,     // 捕捉行为权重 25%
      device: 0.25,      // 设备风险权重 25%
      timing: 0.15       // 时间特征权重 15%
    };

    // ===== 位置风险 =====
    if (features.location) {
      const loc = features.location;
      
      // 位置熵过低（过于集中）
      if (loc.entropy < 0.3) {
        score += 20 * weights.location;
        this.metrics.violationsDetected.inc({ violation_type: 'low_location_entropy' });
      }
      
      // 频繁瞬移
      if (loc.jumpCount > 5) {
        score += Math.min(30, loc.jumpCount * 3) * weights.location;
        this.metrics.violationsDetected.inc({ violation_type: 'frequent_teleportation' });
      }
      
      // 不可能的位置移动
      if (loc.impossibleTravel) {
        score += 40 * weights.location;
        this.metrics.violationsDetected.inc({ violation_type: 'impossible_travel' });
      }
    }

    // ===== 捕捉行为风险 =====
    if (features.capture) {
      const cap = features.capture;
      
      // 异常高的捕捉成功率
      if (cap.successRate > 0.95) {
        score += 20 * weights.capture;
        this.metrics.violationsDetected.inc({ violation_type: 'abnormal_success_rate' });
      }
      
      // 捕捉速度过快（自动化特征）
      if (cap.speed && cap.speed < 2000) { // 小于 2 秒
        score += 15 * weights.capture;
        this.metrics.violationsDetected.inc({ violation_type: 'fast_capture_speed' });
      }
      
      // 捕捉模式过于规律
      if (cap.pattern && cap.pattern.variance < 0.1) {
        score += 20 * weights.capture;
        this.metrics.violationsDetected.inc({ violation_type: 'regular_pattern' });
      }
      
      // 稀有精灵捕捉过多
      if (cap.rarityScore > 0.8) {
        score += 25 * weights.capture;
        this.metrics.violationsDetected.inc({ violation_type: 'high_rarity_captures' });
      }
    }

    // ===== 设备风险 =====
    if (features.device) {
      const dev = features.device;
      
      // 设备频繁更换
      if (dev.changes > 3) {
        score += 15 * weights.device;
        this.metrics.violationsDetected.inc({ violation_type: 'device_changes' });
      }
      
      // 设备指纹无效
      if (!dev.fingerprintValid) {
        score += 30 * weights.device;
        this.metrics.violationsDetected.inc({ violation_type: 'invalid_fingerprint' });
      }
      
      // 检测到模拟器
      if (dev.emulatorDetected) {
        score += 35 * weights.device;
        this.metrics.violationsDetected.inc({ violation_type: 'emulator_detected' });
      }
      
      // 检测到 Root
      if (dev.rootDetected) {
        score += 20 * weights.device;
        this.metrics.violationsDetected.inc({ violation_type: 'root_detected' });
      }
    }

    // ===== 时间特征风险 =====
    if (features.timing) {
      const tim = features.timing;
      
      // 捕捉间隔过于规律
      if (tim.captureIntervals && tim.captureIntervals.variance < 0.05) {
        score += 20 * weights.timing;
        this.metrics.violationsDetected.inc({ violation_type: 'regular_intervals' });
      }
      
      // 异常长的游戏时长（机器人特征）
      if (tim.sessionDuration > 8 * 3600) { // 超过 8 小时
        score += 15 * weights.timing;
        this.metrics.violationsDetected.inc({ violation_type: 'long_session' });
      }
    }

    return Math.min(100, Math.round(score));
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

    // 位置标记
    if (features.location?.jumpCount > 5) {
      flags.push({ type: 'teleportation', severity: 'high', count: features.location.jumpCount });
    }
    if (features.location?.impossibleTravel) {
      flags.push({ type: 'impossible_travel', severity: 'critical' });
    }

    // 捕捉标记
    if (features.capture?.successRate > 0.95) {
      flags.push({ type: 'abnormal_success', severity: 'medium', rate: features.capture.successRate });
    }
    if (features.capture?.pattern?.variance < 0.1) {
      flags.push({ type: 'automated_pattern', severity: 'high' });
    }

    // 设备标记
    if (features.device?.emulatorDetected) {
      flags.push({ type: 'emulator', severity: 'high' });
    }
    if (features.device?.rootDetected) {
      flags.push({ type: 'rooted_device', severity: 'medium' });
    }

    return flags;
  }

  /**
   * 生成建议
   */
  generateRecommendation(score, flags) {
    if (score >= 80) {
      return {
        action: 'block',
        reason: 'critical_risk_detected',
        logActivity: true,
        notifyAdmin: true
      };
    }
    if (score >= 60) {
      return {
        action: 'flag',
        reason: 'high_risk_detected',
        manualReview: true
      };
    }
    if (score >= 40) {
      return {
        action: 'monitor',
        reason: 'medium_risk_detected',
        enhancedTracking: true
      };
    }
    return {
      action: 'allow',
      reason: 'normal'
    };
  }

  // ========== 特征提取辅助方法 ==========

  /**
   * 计算位置熵
   */
  async _calculateLocationEntropy(userId) {
    try {
      const { rows } = await db.query(`
        SELECT latitude, longitude
        FROM user_activities
        WHERE user_id = $1 
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 100
      `, [userId]);

      if (rows.length < 5) return 1.0; // 数据不足，跳过

      // 将位置网格化为 0.01 度（约 1km）的单元格
      const grid = {};
      rows.forEach(r => {
        const cell = `${Math.floor(r.latitude * 100)}_${Math.floor(r.longitude * 100)}`;
        grid[cell] = (grid[cell] || 0) + 1;
      });

      // 计算熵
      const total = rows.length;
      let entropy = 0;
      Object.values(grid).forEach(count => {
        const p = count / total;
        entropy -= p * Math.log2(p);
      });

      // 归一化到 0-1 范围
      const maxEntropy = Math.log2(Object.keys(grid).length);
      return maxEntropy > 0 ? entropy / maxEntropy : 0;
    } catch (error) {
      logger.error('Failed to calculate location entropy', { userId, error });
      return 0.5;
    }
  }

  /**
   * 计数位置跳变
   */
  async _countLocationJumps(userId, options = {}) {
    const { hours = 24, speedThreshold = 200 } = options; // 200 km/h

    try {
      const { rows } = await db.query(`
        SELECT latitude, longitude, created_at
        FROM user_activities
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '${hours} hours'
        ORDER BY created_at ASC
      `, [userId]);

      let jumpCount = 0;
      for (let i = 1; i < rows.length; i++) {
        const distance = this._calculateDistance(
          rows[i-1].latitude, rows[i-1].longitude,
          rows[i].latitude, rows[i].longitude
        );
        const timeDiff = (new Date(rows[i].created_at) - new Date(rows[i-1].created_at)) / 1000 / 3600; // 小时
        if (timeDiff > 0) {
          const speed = distance / timeDiff; // km/h
          if (speed > speedThreshold) {
            jumpCount++;
          }
        }
      }

      return jumpCount;
    } catch (error) {
      logger.error('Failed to count location jumps', { userId, error });
      return 0;
    }
  }

  /**
   * 检测不可能的位置移动
   */
  async _detectImpossibleTravel(userId) {
    try {
      const { rows } = await db.query(`
        SELECT latitude, longitude, created_at
        FROM user_activities
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC
        LIMIT 10
      `, [userId]);

      if (rows.length < 2) return false;

      // 检查最近两次位置
      const distance = this._calculateDistance(
        rows[0].latitude, rows[0].longitude,
        rows[1].latitude, rows[1].longitude
      );
      const timeDiff = (new Date(rows[0].created_at) - new Date(rows[1].created_at)) / 1000; // 秒

      // 超过 1000 km/h 的速度（飞机速度）且时间间隔小于 1 小时
      if (timeDiff > 0 && timeDiff < 3600) {
        const speed = (distance / timeDiff) * 3600; // km/h
        return speed > 1000;
      }

      return false;
    } catch (error) {
      logger.error('Failed to detect impossible travel', { userId, error });
      return false;
    }
  }

  /**
   * 计算活动半径
   */
  async _calculateActivityRadius(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          AVG(latitude) as center_lat,
          AVG(longitude) as center_lon,
          STDDEV(latitude) as lat_stddev,
          STDDEV(longitude) as lon_stddev
        FROM user_activities
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'
      `, [userId]);

      if (!rows[0]) return 0;

      // 使用标准差估算半径（粗略）
      const latStddev = rows[0].lat_stddev || 0;
      const lonStddev = rows[0].lon_stddev || 0;
      
      // 1度纬度约111km，1度经度约111*cos(lat)km
      const avgLat = rows[0].center_lat || 0;
      const radiusKm = Math.max(
        latStddev * 111,
        lonStddev * 111 * Math.cos(avgLat * Math.PI / 180)
      );

      return radiusKm;
    } catch (error) {
      logger.error('Failed to calculate activity radius', { userId, error });
      return 0;
    }
  }

  /**
   * 计数唯一位置
   */
  async _countUniqueLocations(userId) {
    try {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT CONCAT(
          FLOOR(latitude * 100), '_',
          FLOOR(longitude * 100)
        )) as unique_count
        FROM user_activities
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'
      `, [userId]);

      return parseInt(rows[0]?.unique_count || 0);
    } catch (error) {
      logger.error('Failed to count unique locations', { userId, error });
      return 0;
    }
  }

  /**
   * 计算捕捉成功率
   */
  async _calculateSuccessRate(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE result = 'success') as successful
        FROM capture_attempts
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'
      `, [userId]);

      if (!rows[0] || rows[0].total === 0) return 0;

      return rows[0].successful / rows[0].total;
    } catch (error) {
      logger.error('Failed to calculate success rate', { userId, error });
      return 0;
    }
  }

  /**
   * 计算捕捉速度
   */
  _calculateCaptureSpeed(captureData) {
    if (!captureData.startTime || !captureData.endTime) return null;
    return captureData.endTime - captureData.startTime; // 毫秒
  }

  /**
   * 分析捕捉模式
   */
  async _analyzeCapturePattern(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as count
        FROM capture_attempts
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hour
      `, [userId]);

      if (rows.length < 3) return { variance: 1.0 };

      const counts = rows.map(r => r.count);
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;

      return {
        variance: variance / (mean * mean), // 归一化方差
        hourlyDistribution: rows
      };
    } catch (error) {
      logger.error('Failed to analyze capture pattern', { userId, error });
      return { variance: 1.0 };
    }
  }

  /**
   * 计算稀有度分数
   */
  async _calculateRarityScore(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE p.rarity IN ('legendary', 'mythical')) as rare_count,
          COUNT(*) as total_count
        FROM captures c
        JOIN pokemon p ON c.pokemon_id = p.id
        WHERE c.user_id = $1
          AND c.created_at > NOW() - INTERVAL '24 hours'
      `, [userId]);

      if (!rows[0] || rows[0].total_count === 0) return 0;

      return rows[0].rare_count / rows[0].total_count;
    } catch (error) {
      logger.error('Failed to calculate rarity score', { userId, error });
      return 0;
    }
  }

  /**
   * 计数连续捕捉
   */
  async _countConsecutiveCaptures(userId) {
    try {
      const { rows } = await db.query(`
        SELECT created_at
        FROM captures
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId]);

      if (rows.length < 2) return 0;

      let maxConsecutive = 1;
      let currentConsecutive = 1;

      for (let i = 1; i < rows.length; i++) {
        const timeDiff = (new Date(rows[i-1].created_at) - new Date(rows[i].created_at)) / 1000;
        if (timeDiff < 60) { // 60秒内
          currentConsecutive++;
          maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
          currentConsecutive = 1;
        }
      }

      return maxConsecutive;
    } catch (error) {
      logger.error('Failed to count consecutive captures', { userId, error });
      return 0;
    }
  }

  /**
   * 计数设备更换
   */
  async _countDeviceChanges(userId) {
    try {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT device_id) as device_count
        FROM user_sessions
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '30 days'
      `, [userId]);

      return parseInt(rows[0]?.device_count || 1) - 1;
    } catch (error) {
      logger.error('Failed to count device changes', { userId, error });
      return 0;
    }
  }

  /**
   * 分析游戏时间模式
   */
  async _analyzePlayTimePattern(userId) {
    try {
      const { rows } = await db.query(`
        SELECT 
          DATE(created_at) as date,
          SUM(EXTRACT(EPOCH FROM (ended_at - created_at))/3600) as hours
        FROM user_sessions
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date
      `, [userId]);

      if (rows.length < 3) return { regular: false };

      const hours = rows.map(r => parseFloat(r.hours || 0));
      const mean = hours.reduce((a, b) => a + b, 0) / hours.length;
      const variance = hours.reduce((sum, h) => sum + Math.pow(h - mean, 2), 0) / hours.length;

      return {
        regular: variance < 1,
        averageHours: mean,
        variance
      };
    } catch (error) {
      logger.error('Failed to analyze play time pattern', { userId, error });
      return { regular: false };
    }
  }

  /**
   * 分析捕捉间隔
   */
  async _analyzeCaptureIntervals(userId) {
    try {
      const { rows } = await db.query(`
        SELECT created_at
        FROM captures
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at
      `, [userId]);

      if (rows.length < 3) return { variance: 1.0 };

      const intervals = [];
      for (let i = 1; i < rows.length; i++) {
        intervals.push((new Date(rows[i].created_at) - new Date(rows[i-1].created_at)) / 1000);
      }

      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / intervals.length;

      return {
        mean,
        variance: variance / (mean * mean), // 归一化
        count: intervals.length
      };
    } catch (error) {
      logger.error('Failed to analyze capture intervals', { userId, error });
      return { variance: 1.0 };
    }
  }

  /**
   * 计算两点间距离（Haversine 公式）
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（km）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}

module.exports = CaptureBehaviorAnalyzer;
