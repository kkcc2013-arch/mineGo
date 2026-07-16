'use strict';

/**
 * 位置信任引擎
 * REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
 * 
 * 综合多个维度计算位置可信度评分
 */

const { query, preparedQuery } = require('../../../shared/db');
const { getRedis, setJSON, getJSON } = require('../../../shared/redis');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('location-trust-engine');

// 速度阈值 (m/s)
const VELOCITY_THRESHOLDS = {
  WALKING: 2,      // 7.2 km/h
  BIKING: 10,      // 36 km/h
  DRIVING: 40,     // 144 km/h
  TRAIN: 80,       // 288 km/h
  PLANE: 250,      // 900 km/h
  IMPOSSIBLE: 280  // 超过飞机速度为不可能
};

// 风险等级
const RISK_LEVELS = {
  LOW: { min: 0, max: 30 },
  MEDIUM: { min: 30, max: 50 },
  HIGH: { min: 50, max: 70 },
  CRITICAL: { min: 70, max: 100 }
};

class LocationTrustEngine {
  constructor() {
    this.redis = null;
  }

  async init() {
    this.redis = await getRedis();
    logger.info('LocationTrustEngine initialized');
  }

  /**
   * 计算位置可信度评分 (0-100)
   * 100 = 完全可信，0 = 完全不可信
   */
  async calculateLocationTrustScore(userId, location, deviceRisk, context) {
    const startTime = Date.now();

    try {
      const scores = {
        velocity: await this.validateVelocity(userId, location),
        terrain: await this.validateTerrain(location),
        network: await this.validateNetworkConsistency(userId, location),
        history: await this.analyzeMovementPattern(userId, location),
        device: deviceRisk?.score ?? 50
      };

      // 加权平均（权重可配置）
      const weights = {
        velocity: 0.30,   // 速度合理性最重要
        terrain: 0.15,    // 地形验证
        network: 0.15,    // 网络一致性
        history: 0.25,    // 历史行为模式
        device: 0.15      // 设备风险
      };

      let totalScore = 0;
      let totalWeight = 0;

      for (const [key, score] of Object.entries(scores)) {
        const weight = weights[key] || 0.1;
        const value = typeof score === 'object' ? (score.score ?? 50) : score;
        totalScore += value * weight;
        totalWeight += weight;
      }

      const trustScore = Math.round(totalScore / totalWeight);

      // 记录指标
      this.recordMetrics(userId, trustScore, Date.now() - startTime);

      return {
        trustScore,
        riskLevel: this.getRiskLevel(trustScore),
        recommendation: this.getRecommendation(trustScore),
        details: scores,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to calculate location trust score');
      // 出错时返回中等信任度，避免误封
      return {
        trustScore: 50,
        riskLevel: 'MEDIUM',
        recommendation: 'monitor',
        details: {},
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * 速度合理性验证
   */
  async validateVelocity(userId, newLocation) {
    try {
      // 获取上次位置
      const lastLocation = await this.getLastLocation(userId);
      
      if (!lastLocation) {
        return { score: 70, velocity: 0, reason: 'no_previous_location' };
      }

      const timeDiff = (Date.now() - lastLocation.timestamp) / 1000; // 秒
      const distance = this.calculateDistance(
        lastLocation.latitude, lastLocation.longitude,
        newLocation.latitude, newLocation.longitude
      ); // 公里

      if (timeDiff <= 0) {
        return { score: 30, velocity: 0, reason: 'invalid_time' };
      }

      const velocityKmh = (distance / timeDiff) * 3600; // km/h
      const velocityMs = (distance * 1000) / timeDiff; // m/s

      // 计算速度得分
      let score = 100;
      let isImpossible = false;

      if (velocityMs > VELOCITY_THRESHOLDS.IMPOSSIBLE) {
        score = 0;
        isImpossible = true;
      } else if (velocityMs > VELOCITY_THRESHOLDS.PLANE) {
        score = 10;
      } else if (velocityMs > VELOCITY_THRESHOLDS.TRAIN) {
        score = 30;
      } else if (velocityMs > VELOCITY_THRESHOLDS.DRIVING) {
        score = 50;
      } else if (velocityMs > VELOCITY_THRESHOLDS.BIKING) {
        score = 70;
      }

      // 如果速度异常高，记录可疑行为
      if (velocityMs > VELOCITY_THRESHOLDS.PLANE) {
        await this.recordSuspiciousVelocity(userId, {
          velocity: velocityKmh,
          distance,
          timeDiff,
          prevLocation: lastLocation,
          newLocation
        });
      }

      return {
        score,
        velocity: velocityKmh,
        velocityMs,
        distance,
        timeDiff,
        isImpossible,
        thresholds: VELOCITY_THRESHOLDS
      };
    } catch (error) {
      logger.error({ error, userId }, 'Velocity validation failed');
      return { score: 50, error: error.message };
    }
  }

  /**
   * 地形一致性验证
   */
  async validateTerrain(location) {
    try {
      // 检查是否在海洋/湖泊中央（简化的边界框检测）
      const isOcean = await this.checkOceanLocation(location);
      
      if (isOcean) {
        return {
          score: 10,
          terrainType: 'ocean',
          accessible: false,
          reason: 'ocean_location'
        };
      }

      // 检查是否在禁区（机场、军事基地等）
      const isRestricted = await this.checkRestrictedArea(location);
      
      if (isRestricted) {
        return {
          score: 20,
          terrainType: 'restricted',
          accessible: false,
          reason: 'restricted_area'
        };
      }

      // 默认认为地形合理
      return {
        score: 90,
        terrainType: 'land',
        accessible: true
      };
    } catch (error) {
      logger.error({ error }, 'Terrain validation failed');
      return { score: 70, terrainType: 'unknown', accessible: true };
    }
  }

  /**
   * 网络位置一致性验证
   */
  async validateNetworkConsistency(userId, location) {
    try {
      // 获取用户 IP 地理位置（从 Redis 缓存或请求头）
      const ipLocation = await this.getIPLocation(userId);
      
      if (!ipLocation) {
        return { score: 70, reason: 'no_ip_location' };
      }

      const distance = this.calculateDistance(
        location.latitude, location.longitude,
        ipLocation.latitude, ipLocation.longitude
      );

      // GPS 与 IP 位置差异
      // < 100km: 正常
      // 100-500km: 可能使用 VPN/漫游
      // > 500km: 高度可疑
      // > 1000km: 极度可疑

      let score = 100;
      if (distance > 1000) {
        score = 30;
      } else if (distance > 500) {
        score = 50;
      } else if (distance > 100) {
        score = 70;
      }

      return {
        score,
        distance,
        ipLocation,
        reason: distance > 500 ? 'large_gps_ip_discrepancy' : 'normal'
      };
    } catch (error) {
      logger.error({ error, userId }, 'Network consistency validation failed');
      return { score: 70, reason: 'validation_failed' };
    }
  }

  /**
   * 移动模式分析
   */
  async analyzeMovementPattern(userId, location) {
    try {
      // 获取过去24小时的位置历史
      const history = await this.getLocationHistory(userId, 24);
      
      if (history.length < 2) {
        return { score: 70, reason: 'insufficient_history' };
      }

      // 计算移动特征
      const features = this.extractMovementFeatures(history);
      
      // 检测异常模式
      const anomalyScore = this.detectMovementAnomaly(features, location);

      return {
        score: Math.round((1 - anomalyScore) * 100),
        anomalyScore,
        features: {
          avgVelocity: features.avgVelocity,
          maxVelocity: features.maxVelocity,
          totalDistance: features.totalDistance,
          uniqueLocations: features.uniqueLocations
        }
      };
    } catch (error) {
      logger.error({ error, userId }, 'Movement pattern analysis failed');
      return { score: 70, reason: 'analysis_failed' };
    }
  }

  /**
   * 获取上次位置
   */
  async getLastLocation(userId) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `location:last:${userId}`;
      const data = await getJSON(this.redis, key);
      return data;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get last location');
      return null;
    }
  }

  /**
   * 保存当前位置
   */
  async saveCurrentLocation(userId, location) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `location:last:${userId}`;
      const data = {
        userId,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        timestamp: location.timestamp || Date.now()
      };
      
      // 缓存 1 小时
      await this.redis.set(key, JSON.stringify(data), 'EX', 3600);
      
      // 同时保存到位置历史列表
      const historyKey = `location:history:${userId}`;
      await this.redis.lpush(historyKey, JSON.stringify(data));
      await this.redis.ltrim(historyKey, 0, 999); // 保留最近 1000 条
      await this.redis.expire(historyKey, 86400); // 24 小时过期
    } catch (error) {
      logger.error({ error, userId }, 'Failed to save current location');
    }
  }

  /**
   * 获取位置历史
   */
  async getLocationHistory(userId, hours = 24) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const historyKey = `location:history:${userId}`;
      const data = await this.redis.lrange(historyKey, 0, -1);
      
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      
      return data
        .map(item => JSON.parse(item))
        .filter(item => item.timestamp >= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get location history');
      return [];
    }
  }

  /**
   * 计算两点间距离（Haversine 公式）
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 获取风险等级
   */
  getRiskLevel(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 获取推荐动作
   */
  getRecommendation(score) {
    if (score >= 70) return 'deny';
    if (score >= 50) return 'restrict';
    if (score >= 30) return 'monitor';
    return 'allow';
  }

  /**
   * 检查是否在海洋
   * 简化版本：使用大致的海洋边界框
   */
  async checkOceanLocation(location) {
    // 主要海洋区域的简化检测
    // 太平洋大致范围
    const pacificOcean = {
      latMin: -60, latMax: 60,
      lonMin: 150, lonMax: -80 // 跨越 180 度经线
    };

    // 大西洋大致范围
    const atlanticOcean = {
      latMin: -60, latMax: 60,
      lonMin: -80, lonMax: 0
    };

    // 印度洋大致范围
    const indianOcean = {
      latMin: -60, latMax: 30,
      lonMin: 20, lonMax: 120
    };

    // 简化检测：如果远离大陆超过 200km，认为是海洋
    // 实际应使用 PostGIS 和自然地球数据
    const { latitude, longitude } = location;

    // 检查主要大陆边界
    const isNearCoast = await this.isNearCoastline(latitude, longitude);
    return !isNearCoast;
  }

  /**
   * 检查是否靠近海岸线
   */
  async isNearCoastline(lat, lon) {
    // 简化版本：检查主要大陆区域
    // 实际应使用 PostGIS 查询自然地球数据

    // 北美洲
    if (lat >= 25 && lat <= 70 && lon >= -170 && lon <= -50) return true;
    // 南美洲
    if (lat >= -60 && lat <= 15 && lon >= -85 && lon <= -30) return true;
    // 欧洲
    if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) return true;
    // 非洲
    if (lat >= -35 && lat <= 35 && lon >= -20 && lon <= 50) return true;
    // 亚洲
    if (lat >= 5 && lat <= 75 && lon >= 40 && lon <= 150) return true;
    // 澳大利亚
    if (lat >= -45 && lat <= -10 && lon >= 110 && lon <= 155) return true;

    return false;
  }

  /**
   * 检查是否在禁区
   */
  async checkRestrictedArea(location) {
    // 简化版本：检查主要机场和军事禁区
    // 实际应使用数据库查询

    const restrictedAreas = [
      // 北京首都机场
      { lat: 40.08, lon: 116.58, radius: 5 },
      // 上海浦东机场
      { lat: 31.14, lon: 121.81, radius: 5 },
      // 东京成田机场
      { lat: 35.77, lon: 140.39, radius: 5 }
    ];

    for (const area of restrictedAreas) {
      const distance = this.calculateDistance(location.latitude, location.longitude, area.lat, area.lon);
      if (distance < area.radius) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取 IP 地理位置
   */
  async getIPLocation(userId) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `user:ip_location:${userId}`;
      const data = await getJSON(this.redis, key);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * 提取移动特征
   */
  extractMovementFeatures(history) {
    if (history.length < 2) {
      return { avgVelocity: 0, maxVelocity: 0, totalDistance: 0, uniqueLocations: 1 };
    }

    let totalDistance = 0;
    let totalTime = 0;
    let maxVelocity = 0;
    const locations = new Set();

    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];

      const distance = this.calculateDistance(
        prev.latitude, prev.longitude,
        curr.latitude, curr.longitude
      );
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000;

      totalDistance += distance;
      totalTime += timeDiff;

      if (timeDiff > 0) {
        const velocity = (distance * 1000) / timeDiff; // m/s
        maxVelocity = Math.max(maxVelocity, velocity);
      }

      // 记录唯一位置（约等于 100m 网格）
      const gridKey = `${Math.floor(curr.latitude * 1000)}_${Math.floor(curr.longitude * 1000)}`;
      locations.add(gridKey);
    }

    const avgVelocity = totalTime > 0 ? (totalDistance * 1000) / totalTime : 0;

    return {
      avgVelocity,
      maxVelocity,
      totalDistance,
      uniqueLocations: locations.size
    };
  }

  /**
   * 检测移动异常
   */
  detectMovementAnomaly(features, newLocation) {
    // 基于历史特征计算异常分数
    let anomalyScore = 0;

    // 如果平均速度远高于历史平均
    if (features.maxVelocity > 100) {
      anomalyScore += 0.3;
    }

    // 如果移动距离异常大
    if (features.totalDistance > 1000) {
      anomalyScore += 0.2;
    }

    // 如果在短时间内访问大量不同位置
    if (features.uniqueLocations > 100) {
      anomalyScore += 0.2;
    }

    return Math.min(anomalyScore, 1);
  }

  /**
   * 记录可疑速度
   */
  async recordSuspiciousVelocity(userId, data) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `location:suspicious:${userId}`;
      await this.redis.lpush(key, JSON.stringify({
        ...data,
        timestamp: Date.now()
      }));
      await this.redis.expire(key, 3600); // 1 小时过期

      logger.warn({
        userId,
        velocity: data.velocity,
        distance: data.distance
      }, 'Suspicious velocity detected');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to record suspicious velocity');
    }
  }

  /**
   * 记录指标
   */
  recordMetrics(userId, score, durationMs) {
    metrics.gauge('location_trust_score', score);
    metrics.histogram('location_trust_calculation_duration_ms', durationMs);
  }
}

// 导出单例
const locationTrustEngine = new LocationTrustEngine();
module.exports = {
  LocationTrustEngine,
  locationTrustEngine,
  VELOCITY_THRESHOLDS,
  RISK_LEVELS
};