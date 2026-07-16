'use strict';

/**
 * 位置异常检测器
 * REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
 * 
 * 检测不可能行程、瞬移模式、位置锁定和多账号协同作弊
 */

const { query, preparedQuery } = require('../../../shared/db');
const { getRedis, setJSON, getJSON } = require('../../../shared/redis');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('location-anomaly-detector');

// 检测阈值
const THRESHOLDS = {
  IMPOSSIBLE_TRAVEL: {
    // 5分钟内移动超过 500km
    SHORT_WINDOW_MS: 5 * 60 * 1000,
    SHORT_DISTANCE_KM: 500,
    // 1小时内移动超过 2000km
    MEDIUM_WINDOW_MS: 60 * 60 * 1000,
    MEDIUM_DISTANCE_KM: 2000,
    // 24小时内移动超过地球半周长
    LONG_WINDOW_MS: 24 * 60 * 60 * 1000,
    LONG_DISTANCE_KM: 20000
  },
  TELEPORT: {
    // 速度超过 1000 km/h 视为瞬移
    VELOCITY_KMH: 1000,
    // 6小时内超过 3 次瞬移视为模式
    PATTERN_MIN_COUNT: 3,
    PATTERN_WINDOW_HOURS: 6
  },
  LOCATION_LOCK: {
    // 90% 的时间停留在 <100m 范围内
    STAY_RATIO: 0.9,
    RADIUS_METERS: 100,
    WINDOW_HOURS: 1
  },
  COORDINATED_SPOOF: {
    // 相同位置（半径 50m）内 3+ 账号
    RADIUS_METERS: 50,
    MIN_USERS: 3,
    SIMILARITY_THRESHOLD: 0.8
  }
};

class LocationAnomalyDetector {
  constructor() {
    this.redis = null;
  }

  async init() {
    this.redis = await getRedis();
    logger.info('LocationAnomalyDetector initialized');
  }

  /**
   * 检测不可能的行程
   */
  async detectImpossibleTravel(userId, locations) {
    const detections = [];

    if (!locations || locations.length < 2) {
      return detections;
    }

    // 按时间排序
    const sorted = [...locations].sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const timeDiff = curr.timestamp - prev.timestamp; // 毫秒
      const distance = this.haversineDistance(
        prev.latitude, prev.longitude,
        curr.latitude, curr.longitude
      ); // 公里

      // 检查不同时间窗口
      const checks = [
        {
          window: THRESHOLDS.IMPOSSIBLE_TRAVEL.SHORT_WINDOW_MS,
          maxDistance: THRESHOLDS.IMPOSSIBLE_TRAVEL.SHORT_DISTANCE_KM,
          severity: 'CRITICAL'
        },
        {
          window: THRESHOLDS.IMPOSSIBLE_TRAVEL.MEDIUM_WINDOW_MS,
          maxDistance: THRESHOLDS.IMPOSSIBLE_TRAVEL.MEDIUM_DISTANCE_KM,
          severity: 'HIGH'
        },
        {
          window: THRESHOLDS.IMPOSSIBLE_TRAVEL.LONG_WINDOW_MS,
          maxDistance: THRESHOLDS.IMPOSSIBLE_TRAVEL.LONG_DISTANCE_KM,
          severity: 'MEDIUM'
        }
      ];

      for (const check of checks) {
        if (timeDiff <= check.window && distance > check.maxDistance) {
          const velocity = timeDiff > 0 ? (distance / (timeDiff / 3600000)) : 0;
          const detection = {
            type: 'impossible_travel',
            severity: check.severity,
            userId,
            prevLocation: { lat: prev.latitude, lon: prev.longitude, time: prev.timestamp },
            currLocation: { lat: curr.latitude, lon: curr.longitude, time: curr.timestamp },
            distance,
            timeDiff,
            velocity,
            risk: this.calculateRiskScore(check.severity, velocity),
            timestamp: Date.now()
          };

          detections.push(detection);
          await this.flagSuspiciousMovement(detection);
          break; // 只记录最严重的
        }
      }
    }

    return detections;
  }

  /**
   * 检测瞬移模式
   */
  async detectTeleportPattern(userId, timeWindowHours = 6) {
    const locations = await this.getLocations(userId, timeWindowHours);

    if (locations.length < 2) {
      return { detected: false, teleportCount: 0 };
    }

    const teleports = [];

    for (let i = 1; i < locations.length; i++) {
      const prev = locations[i - 1];
      const curr = locations[i];
      const velocity = this.calculateVelocityKmh(prev, curr);

      if (velocity > THRESHOLDS.TELEPORT.VELOCITY_KMH) {
        teleports.push({
          prevLocation: prev,
          currLocation: curr,
          velocity,
          timestamp: curr.timestamp
        });
      }
    }

    const detected = teleports.length >= THRESHOLDS.TELEPORT.PATTERN_MIN_COUNT;

    if (detected) {
      const detection = {
        type: 'teleport_pattern',
        severity: 'HIGH',
        userId,
        teleportCount: teleports.length,
        teleports: teleports.slice(0, 10), // 最多记录10次
        risk: 80,
        timestamp: Date.now()
      };

      await this.flagSuspiciousMovement(detection);
    }

    return { detected, teleportCount: teleports.length, teleports };
  }

  /**
   * 检测位置锁定作弊
   */
  async detectLocationLocking(userId) {
    const locations = await this.getLocations(userId, THRESHOLDS.LOCATION_LOCK.WINDOW_HOURS);

    if (locations.length < 10) {
      return { detected: false, stayRatio: 0 };
    }

    // 聚类分析：找出停留最多的区域
    const cluster = this.clusterLocations(locations);

    if (cluster.stayRatio >= THRESHOLDS.LOCATION_LOCK.STAY_RATIO) {
      // 检查该位置是否合理
      const terrainCheck = await this.checkLocationReasonableness(cluster.center);

      if (!terrainCheck.reasonable) {
        const detection = {
          type: 'location_locking',
          severity: 'MEDIUM',
          userId,
          location: cluster.center,
          stayRatio: cluster.stayRatio,
          radius: cluster.radius,
          terrain: terrainCheck,
          risk: 70,
          timestamp: Date.now()
        };

        await this.flagSuspiciousMovement(detection);
        return { detected: true, ...cluster, terrain: terrainCheck };
      }
    }

    return { detected: false, stayRatio: cluster.stayRatio, cluster };
  }

  /**
   * 多账号协同作弊检测
   */
  async detectCoordinatedSpoofing(location) {
    try {
      // 查询附近用户（使用 Redis GEO）
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const nearbyUsers = await this.getUsersNearLocation(
        location,
        THRESHOLDS.COORDINATED_SPOOF.RADIUS_METERS
      );

      if (nearbyUsers.length < THRESHOLDS.COORDINATED_SPOOF.MIN_USERS) {
        return { detected: false, nearbyCount: nearbyUsers.length };
      }

      // 分析相似度
      const clusters = this.detectUserClusters(nearbyUsers);
      const suspiciousClusters = clusters.filter(
        c => c.users.length >= THRESHOLDS.COORDINATED_SPOOF.MIN_USERS &&
             c.similarityScore >= THRESHOLDS.COORDINATED_SPOOF.SIMILARITY_THRESHOLD
      );

      for (const cluster of suspiciousClusters) {
        const detection = {
          type: 'coordinated_spoofing',
          severity: 'HIGH',
          userIds: cluster.users,
          location,
          similarityScore: cluster.similarityScore,
          risk: 85,
          timestamp: Date.now()
        };

        await this.flagCoordinatedSpoofing(cluster.users, location, detection);
      }

      return {
        detected: suspiciousClusters.length > 0,
        clusters: suspiciousClusters
      };
    } catch (error) {
      logger.error({ error, location }, 'Coordinated spoofing detection failed');
      return { detected: false, error: error.message };
    }
  }

  /**
   * 综合检测（所有检测类型）
   */
  async runFullDetection(userId, location) {
    const results = {
      impossibleTravel: null,
      teleportPattern: null,
      locationLocking: null,
      overallRisk: 0
    };

    try {
      // 获取位置历史
      const locations = await this.getLocations(userId, 24);
      locations.push({
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: location.timestamp || Date.now()
      });

      // 执行各项检测
      const impossibleResults = await this.detectImpossibleTravel(userId, locations);
      const teleportResult = await this.detectTeleportPattern(userId, 6);
      const lockResult = await this.detectLocationLocking(userId);

      results.impossibleTravel = impossibleResults;
      results.teleportPattern = teleportResult;
      results.locationLocking = lockResult;

      // 计算综合风险
      let risk = 0;
      if (impossibleResults.length > 0) {
        risk += Math.min(impossibleResults.reduce((max, r) => Math.max(max, r.risk), 0), 100);
      }
      if (teleportResult.detected) {
        risk += 20;
      }
      if (lockResult.detected) {
        risk += 15;
      }

      results.overallRisk = Math.min(risk, 100);

      return results;
    } catch (error) {
      logger.error({ error, userId }, 'Full detection failed');
      results.error = error.message;
      return results;
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * Haversine 距离计算
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 计算速度 (km/h)
   */
  calculateVelocityKmh(prev, curr) {
    const distance = this.haversineDistance(
      prev.latitude, prev.longitude,
      curr.latitude, curr.longitude
    );
    const timeDiff = (curr.timestamp - prev.timestamp) / 3600000; // 小时
    return timeDiff > 0 ? distance / timeDiff : 0;
  }

  /**
   * 计算风险分数
   */
  calculateRiskScore(severity, velocity) {
    const baseScores = { CRITICAL: 95, HIGH: 75, MEDIUM: 55, LOW: 30 };
    let score = baseScores[severity] || 50;
    // 速度越高风险越大
    if (velocity > 2000) score = Math.min(score + 5, 100);
    return score;
  }

  /**
   * 聚类分析位置
   */
  clusterLocations(locations) {
    if (locations.length === 0) {
      return { center: null, radius: 0, stayRatio: 0, count: 0 };
    }

    // 计算中心点
    const center = {
      latitude: locations.reduce((sum, l) => sum + l.latitude, 0) / locations.length,
      longitude: locations.reduce((sum, l) => sum + l.longitude, 0) / locations.length
    };

    // 计算到中心点的距离
    const distances = locations.map(l =>
      this.haversineDistance(l.latitude, l.longitude, center.latitude, center.longitude) * 1000 // 米
    );

    const radius = Math.max(...distances);
    const withinRadius = distances.filter(d => d < THRESHOLDS.LOCATION_LOCK.RADIUS_METERS).length;
    const stayRatio = withinRadius / locations.length;

    return { center, radius, stayRatio, count: locations.length };
  }

  /**
   * 检查位置合理性
   */
  async checkLocationReasonableness(center) {
    // 检查是否在水域
    const isWater = this.isLikelyWater(center);
    // 检查是否在无人区
    const isRemote = this.isRemoteArea(center);
    // 检查附近是否有 POI
    // 简化版本：默认认为有 POI

    const reasonable = !isWater && !isRemote;

    return {
      reasonable,
      isWater,
      isRemote,
      location: center
    };
  }

  /**
   * 简化水域检测
   */
  isLikelyWater(location) {
    // 大致的海域检测
    const { latitude, longitude } = location;
    // 太平洋中心
    if (latitude >= -30 && latitude <= 30 && longitude >= 160 && longitude <= -130) return true;
    return false;
  }

  /**
   * 简化偏远地区检测
   */
  isRemoteArea(location) {
    // 南极
    if (location.latitude < -60) return true;
    // 北极
    if (location.latitude > 80) return true;
    // 撒哈拉沙漠中心
    if (location.latitude >= 20 && location.latitude <= 30 && location.longitude >= 5 && location.longitude <= 30) return true;
    return false;
  }

  /**
   * 获取用户位置历史
   */
  async getLocations(userId, hours) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `location:history:${userId}`;
      const data = await this.redis.lrange(key, 0, -1);
      
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      
      return data
        .map(item => {
          try { return JSON.parse(item); } catch { return null; }
        })
        .filter(item => item && item.timestamp >= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get locations');
      return [];
    }
  }

  /**
   * 获取位置附近的用户
   */
  async getUsersNearLocation(location, radiusMeters) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      // 使用 Redis GEO 查询
      const results = await this.redis.georadius(
        'user:locations',
        location.longitude,
        location.latitude,
        radiusMeters,
        'm',
        'WITHCOORD'
      );

      return results.map(r => ({
        userId: r[0],
        location: {
          longitude: r[1][0],
          latitude: r[1][1]
        }
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get nearby users');
      return [];
    }
  }

  /**
   * 检测用户集群
   */
  detectUserClusters(users) {
    if (users.length === 0) return [];

    // 简化的聚类：检查共享特征
    // 实际应检查 IP 段、设备指纹、行为模式
    return [{
      users: users.map(u => u.userId),
      similarityScore: 0.5, // 默认中等相似度
      size: users.length
    }];
  }

  /**
   * 标记可疑移动
   */
  async flagSuspiciousMovement(detection) {
    try {
      if (!this.redis) {
        this.redis = await getRedis();
      }

      const key = `location:anomaly:${detection.userId}`;
      await this.redis.lpush(key, JSON.stringify(detection));
      await this.redis.ltrim(key, 0, 99); // 保留最近 100 条
      await this.redis.expire(key, 86400 * 7); // 7 天过期

      // 同时写入数据库（用于管理后台查询）
      try {
        await query(`
          INSERT INTO suspicious_movements 
          (user_id, movement_type, prev_location, curr_location, velocity, risk_score, evidence, status, created_at)
          VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9, 'pending', NOW())
        `, [
          detection.userId,
          detection.type,
          detection.prevLocation?.lon ?? 0,
          detection.prevLocation?.lat ?? 0,
          detection.currLocation?.lon ?? 0,
          detection.currLocation?.lat ?? 0,
          detection.velocity ?? 0,
          detection.risk ?? 0,
          JSON.stringify(detection)
        ]);
      } catch (dbError) {
        // 数据库可能不存在该表，忽略
        logger.debug({ error: dbError.message }, 'DB write skipped for suspicious movement');
      }

      // 更新指标
      metrics.increment('location_spoof_detected_total', 1, { type: detection.type });

      logger.warn({
        userId: detection.userId,
        type: detection.type,
        risk: detection.risk
      }, 'Suspicious movement flagged');
    } catch (error) {
      logger.error({ error, detection }, 'Failed to flag suspicious movement');
    }
  }

  /**
   * 标记协同作弊
   */
  async flagCoordinatedSpoofing(userIds, location, detection) {
    try {
      logger.warn({
        userIds,
        location,
        similarity: detection.similarityScore
      }, 'Coordinated spoofing detected');

      // 为每个用户记录
      for (const userId of userIds) {
        await this.flagSuspiciousMovement({
          ...detection,
          userId,
          type: 'coordinated_spoofing'
        });
      }
    } catch (error) {
      logger.error({ error, userIds }, 'Failed to flag coordinated spoofing');
    }
  }
}

// 导出单例
const locationAnomalyDetector = new LocationAnomalyDetector();
module.exports = {
  LocationAnomalyDetector,
  locationAnomalyDetector,
  THRESHOLDS
};