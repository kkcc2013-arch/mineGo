/**
 * REQ-00028: 玩家行为异常模式智能检测系统
 * 核心行为分析引擎
 * 
 * 创建时间: 2026-06-05 21:20
 */

'use strict';

const { query } = require('./db');
const logger = require('./logger');
const metrics = require('./metrics');

// 捕捉成功率模型
const CATCH_RATE_MODEL = {
  // 基础捕获率（按稀有度）
  BASE_RATES: {
    COMMON: 0.50,
    UNCOMMON: 0.30,
    RARE: 0.15,
    EPIC: 0.08,
    LEGENDARY: 0.03,
  },
  
  // 道具加成
  ITEM_BONUS: {
    GREAT_BALL: 1.5,
    ULTRA_BALL: 2.0,
    RAZZ_BERRY: 1.5,
    GOLDEN_RAZZ: 2.5,
  },
  
  // 技术加成
  TECHNIQUE_BONUS: {
    CURVEBALL: 1.7,
    NICE: 1.0,
    GREAT: 1.3,
    EXCELLENT: 1.7,
  },
  
  // 等级修正
  LEVEL_BONUS: (level) => Math.min(1 + level * 0.005, 1.2),
};

/**
 * 计算期望捕获率
 */
function calculateExpectedCatchRate(pokemonRarity, playerLevel, items, technique) {
  let rate = CATCH_RATE_MODEL.BASE_RATES[pokemonRarity] || 0.30;
  rate *= CATCH_RATE_MODEL.LEVEL_BONUS(playerLevel || 1);
  
  if (Array.isArray(items)) {
    items.forEach(item => {
      rate *= CATCH_RATE_MODEL.ITEM_BONUS[item] || 1;
    });
  }
  
  if (technique) {
    rate *= CATCH_RATE_MODEL.TECHNIQUE_BONUS[technique] || 1;
  }
  
  return Math.min(rate, 0.95);
}

/**
 * 捕捉成功率异常检测
 */
async function analyzeCatchAnomaly(userId, periodDays = 7) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'catch' });
  
  try {
    const result = await query(`
      SELECT 
        pokemon_rarity,
        COUNT(*) as total_attempts,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
        AVG(expected_rate) as avg_expected_rate
      FROM catch_attempts
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${periodDays} days'
      GROUP BY pokemon_rarity
      HAVING COUNT(*) >= 10
    `, [userId]);
    
    const anomalies = [];
    
    for (const stat of result.rows) {
      const actualRate = stat.successful / stat.total_attempts;
      const expectedRate = parseFloat(stat.avg_expected_rate);
      
      if (expectedRate === 0) continue;
      
      const deviation = (actualRate - expectedRate) / expectedRate;
      
      // 统计显著性检验（二项分布）
      const zScore = (stat.successful - stat.total_attempts * expectedRate)
        / Math.sqrt(stat.total_attempts * expectedRate * (1 - expectedRate));
      
      // 异常判定：z > 3.0 且偏差 > 50%
      if (zScore > 3.0 && deviation > 0.5) {
        const severity = deviation > 1.0 ? 'HIGH' : 'MEDIUM';
        
        anomalies.push({
          type: 'CATCH_RATE_ANOMALY',
          rarity: stat.pokemon_rarity,
          actualRate: Math.round(actualRate * 1000) / 1000,
          expectedRate: Math.round(expectedRate * 1000) / 1000,
          deviation: Math.round(deviation * 1000) / 1000,
          zScore: Math.round(zScore * 100) / 100,
          totalAttempts: parseInt(stat.total_attempts),
          severity,
        });
        
        metrics.counters.behaviorAnomalyDetected.inc({
          type: 'CATCH_RATE_ANOMALY',
          severity,
        });
      }
    }
    
    return anomalies;
  } finally {
    timer();
  }
}

/**
 * 轨迹特征提取
 */
function extractTrajectoryFeatures(locations) {
  if (!locations || locations.length < 3) return null;
  
  const features = {
    avgSpeed: 0,
    maxSpeed: 0,
    avgTurnAngle: 0,
    straightnessRatio: 0,
    revisitCount: 0,
    pathEfficiency: 0,
  };
  
  // 计算速度
  const speeds = [];
  for (let i = 1; i < locations.length; i++) {
    const speed = calculateSpeed(
      locations[i-1].latitude, locations[i-1].longitude, locations[i-1].timestamp,
      locations[i].latitude, locations[i].longitude, locations[i].timestamp
    );
    speeds.push(speed);
  }
  
  features.avgSpeed = average(speeds);
  features.maxSpeed = Math.max(...speeds);
  
  // 直线度计算
  const totalDistance = calculatePathLength(locations);
  const directDistance = haversineDistance(
    locations[0].latitude, locations[0].longitude,
    locations[locations.length-1].latitude, locations[locations.length-1].longitude
  );
  
  if (totalDistance > 0) {
    features.straightnessRatio = directDistance / totalDistance;
    features.pathEfficiency = directDistance / totalDistance;
  }
  
  // 重访位置计数
  features.revisitCount = countRevisits(locations, 500);
  
  return features;
}

/**
 * 移动轨迹异常检测
 */
async function analyzeTrajectoryAnomaly(userId) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'trajectory' });
  
  try {
    // 获取最近1小时的移动轨迹
    const locations = await query(`
      SELECT latitude, longitude, timestamp
      FROM user_movement_trajectories
      WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '1 hour'
      ORDER BY timestamp
      LIMIT 1000
    `, [userId]);
    
    if (locations.rows.length < 10) {
      return []; // 数据不足，跳过分析
    }
    
    const features = extractTrajectoryFeatures(locations.rows.map(r => ({
      latitude: r.latitude,
      longitude: r.longitude,
      timestamp: new Date(r.timestamp).getTime(),
    })));
    
    if (!features) return [];
    
    const anomalies = [];
    
    // 过于笔直的路径（脚本特征）
    if (features.straightnessRatio > 0.95) {
      anomalies.push({
        type: 'TOO_STRAIGHT_PATH',
        severity: 'MEDIUM',
        detail: `Straightness ratio: ${features.straightnessRatio.toFixed(3)}`,
        straightnessRatio: features.straightnessRatio,
      });
      
      metrics.counters.behaviorAnomalyDetected.inc({
        type: 'TOO_STRAIGHT_PATH',
        severity: 'MEDIUM',
      });
    }
    
    // 频繁重访同一位置（挂机刷怪点）
    if (features.revisitCount > 10) {
      anomalies.push({
        type: 'FREQUENT_REVISITS',
        severity: 'HIGH',
        detail: `Revisited ${features.revisitCount} locations`,
        revisitCount: features.revisitCount,
      });
      
      metrics.counters.behaviorAnomalyDetected.inc({
        type: 'FREQUENT_REVISITS',
        severity: 'HIGH',
      });
    }
    
    return anomalies;
  } finally {
    timer();
  }
}

/**
 * 战斗数据异常检测
 */
async function analyzeBattleAnomaly(userId) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'battle' });
  
  try {
    const stats = await query(`
      SELECT 
        COUNT(*) as total_battles,
        SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
        AVG(player_power) as avg_player_power,
        AVG(enemy_power) as avg_enemy_power,
        AVG(CASE WHEN result = 'WIN' THEN battle_duration ELSE NULL END) as avg_duration_when_win
      FROM gym_battles
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    `, [userId]);
    
    if (stats.rows.length === 0 || parseInt(stats.rows[0].total_battles) < 20) {
      return []; // 数据不足
    }
    
    const s = stats.rows[0];
    const anomalies = [];
    
    const winRate = parseInt(s.wins) / parseInt(s.total_battles);
    const powerRatio = parseFloat(s.avg_player_power) / parseFloat(s.avg_enemy_power);
    
    // 胜率异常
    if (winRate > 0.85 && powerRatio < 1.2) {
      const severity = winRate > 0.95 ? 'CRITICAL' : 'HIGH';
      
      anomalies.push({
        type: 'SUSPICIOUS_WIN_RATE',
        severity,
        detail: `Win rate ${(winRate * 100).toFixed(1)}% with power ratio ${powerRatio.toFixed(2)}`,
        winRate,
        powerRatio,
      });
      
      metrics.counters.behaviorAnomalyDetected.inc({
        type: 'SUSPICIOUS_WIN_RATE',
        severity,
      });
    }
    
    // 战斗时长异常（过短可能是秒杀作弊）
    const avgDuration = parseFloat(s.avg_duration_when_win);
    if (avgDuration < 5 && parseInt(s.wins) > 20) {
      anomalies.push({
        type: 'INSTANT_WIN_SUSPECTED',
        severity: 'HIGH',
        detail: `Avg win duration: ${avgDuration.toFixed(1)}s`,
        avgDuration,
      });
      
      metrics.counters.behaviorAnomalyDetected.inc({
        type: 'INSTANT_WIN_SUSPECTED',
        severity: 'HIGH',
      });
    }
    
    return anomalies;
  } finally {
    timer();
  }
}

/**
 * 资源增长异常检测
 */
async function analyzeResourceAnomaly(userId) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'resource' });
  
  try {
    // 获取用户资源增长统计
    const userStats = await query(`
      SELECT 
        resource_type,
        SUM(CASE WHEN change_amount > 0 THEN change_amount ELSE 0 END) as total_gain,
        COUNT(CASE WHEN change_amount > 0 THEN 1 END) as gain_events,
        MAX(created_at) - MIN(created_at) as period
      FROM resource_transactions
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY resource_type
    `, [userId]);
    
    if (userStats.rows.length === 0) return [];
    
    const anomalies = [];
    
    for (const stat of userStats.rows) {
      const totalGain = parseFloat(stat.total_gain);
      const days = Math.max(1, extractDays(stat.period));
      const dailyGrowth = totalGain / days;
      
      // 获取全局资源统计
      const globalStats = await query(`
        SELECT p95_value, p99_value
        FROM global_resource_stats
        WHERE resource_type = $1
        ORDER BY stat_date DESC
        LIMIT 1
      `, [stat.resource_type]);
      
      if (globalStats.rows.length === 0) continue;
      
      const p95 = parseFloat(globalStats.rows[0].p95_value);
      const p99 = parseFloat(globalStats.rows[0].p99_value);
      
      if (dailyGrowth > p99) {
        anomalies.push({
          type: 'ABNORMAL_RESOURCE_GROWTH',
          resource: stat.resource_type,
          severity: 'CRITICAL',
          detail: `Daily growth ${dailyGrowth.toFixed(0)} vs p99 ${p99.toFixed(0)}`,
          dailyGrowth,
          p95,
          p99,
        });
        
        metrics.counters.behaviorAnomalyDetected.inc({
          type: 'ABNORMAL_RESOURCE_GROWTH',
          severity: 'CRITICAL',
        });
      } else if (dailyGrowth > p95) {
        anomalies.push({
          type: 'ABNORMAL_RESOURCE_GROWTH',
          resource: stat.resource_type,
          severity: 'HIGH',
          detail: `Daily growth ${dailyGrowth.toFixed(0)} vs p95 ${p95.toFixed(0)}`,
          dailyGrowth,
          p95,
          p99,
        });
        
        metrics.counters.behaviorAnomalyDetected.inc({
          type: 'ABNORMAL_RESOURCE_GROWTH',
          severity: 'HIGH',
        });
      }
    }
    
    return anomalies;
  } finally {
    timer();
  }
}

/**
 * 时段行为模式异常检测
 */
async function analyzeTimePatternAnomaly(userId) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'time_pattern' });
  
  try {
    const actions = await query(`
      SELECT 
        action_type,
        created_at,
        EXTRACT(HOUR FROM created_at) as hour,
        EXTRACT(MINUTE FROM created_at) as minute
      FROM user_action_events
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at
      LIMIT 5000
    `, [userId]);
    
    if (actions.rows.length < 50) return [];
    
    const anomalies = [];
    
    // 24小时活跃检测
    const hourlyDistribution = new Array(24).fill(0);
    actions.rows.forEach(a => hourlyDistribution[parseInt(a.hour)]++);
    
    const activeHours = hourlyDistribution.filter(h => h > 0).length;
    
    if (activeHours >= 23 && actions.rows.length > 500) {
      anomalies.push({
        type: '24H_CONTINUOUS_ACTIVITY',
        severity: 'HIGH',
        detail: `Active in ${activeHours} hours with ${actions.rows.length} actions`,
        activeHours,
        totalActions: actions.rows.length,
      });
      
      metrics.counters.behaviorAnomalyDetected.inc({
        type: '24H_CONTINUOUS_ACTIVITY',
        severity: 'HIGH',
      });
    }
    
    // 固定间隔检测（脚本特征）
    const intervals = [];
    for (let i = 1; i < actions.rows.length; i++) {
      const diff = (new Date(actions.rows[i].created_at) - new Date(actions.rows[i-1].created_at)) / 1000;
      intervals.push(diff);
    }
    
    if (intervals.length > 10) {
      const mean = average(intervals);
      const variance = calculateVariance(intervals);
      const stdDev = Math.sqrt(variance);
      
      // 间隔过于规律（标准差 < 5% 均值）
      if (stdDev < mean * 0.05 && actions.rows.length > 100) {
        anomalies.push({
          type: 'REGULAR_INTERVAL_PATTERN',
          severity: 'CRITICAL',
          detail: `Interval std dev: ${stdDev.toFixed(2)}s, mean: ${mean.toFixed(2)}s`,
          meanInterval: mean,
          stdDev,
        });
        
        metrics.counters.behaviorAnomalyDetected.inc({
          type: 'REGULAR_INTERVAL_PATTERN',
          severity: 'CRITICAL',
        });
      }
    }
    
    return anomalies;
  } finally {
    timer();
  }
}

/**
 * 设备关联异常检测
 */
async function analyzeDeviceAnomaly(deviceHash) {
  const timer = metrics.histograms.analysisDuration.startTimer({ analysis_type: 'device' });
  
  try {
    const accountsOnDevice = await query(`
      SELECT DISTINCT user_id
      FROM device_fingerprints
      WHERE device_hash = $1 AND last_seen > NOW() - INTERVAL '30 days'
    `, [deviceHash]);
    
    if (accountsOnDevice.rows.length <= 3) return null;
    
    const userIds = accountsOnDevice.rows.map(r => r.user_id);
    
    // 检测内部资源转移（群控特征）
    const transfers = await query(`
      SELECT COUNT(*) as count
      FROM pokemon_trades
      WHERE 
        (sender_id = ANY($1) AND receiver_id = ANY($1))
        AND created_at > NOW() - INTERVAL '30 days'
    `, [userIds]);
    
    const transferCount = parseInt(transfers.rows[0].count);
    
    if (transferCount > 10) {
      metrics.counters.multiAccountDeviceDetected.inc();
      
      return {
        type: 'DEVICE_CLUSTER_CHEAT',
        severity: 'CRITICAL',
        detail: `${userIds.length} accounts on device with ${transferCount} internal transfers`,
        affectedAccounts: userIds,
        transferCount,
      };
    }
    
    metrics.counters.multiAccountDeviceDetected.inc();
    
    return {
      type: 'MULTI_ACCOUNT_DEVICE',
      severity: 'HIGH',
      detail: `${userIds.length} accounts on single device`,
      affectedAccounts: userIds,
    };
  } finally {
    timer();
  }
}

/**
 * 综合行为可信度评分
 */
async function calculateBehaviorTrustScore(userId) {
  const [
    catchAnomalies,
    trajectoryAnomalies,
    battleAnomalies,
    resourceAnomalies,
    timeAnomalies,
  ] = await Promise.all([
    analyzeCatchAnomaly(userId),
    analyzeTrajectoryAnomaly(userId),
    analyzeBattleAnomaly(userId),
    analyzeResourceAnomaly(userId),
    analyzeTimePatternAnomaly(userId),
  ]);
  
  const allAnomalies = [
    ...catchAnomalies,
    ...trajectoryAnomalies,
    ...battleAnomalies,
    ...resourceAnomalies,
    ...timeAnomalies,
  ];
  
  // 计算行为评分
  let behaviorScore = 100;
  
  for (const anomaly of allAnomalies) {
    const penalty = {
      CRITICAL: 40,
      HIGH: 20,
      MEDIUM: 10,
      LOW: 5,
    }[anomaly.severity] || 5;
    
    behaviorScore -= penalty;
  }
  
  behaviorScore = Math.max(0, behaviorScore);
  
  // 获取 GPS 可信度
  const trustResult = await query(`
    SELECT trust_score FROM user_trust_scores WHERE user_id = $1
  `, [userId]);
  
  const gpsTrustScore = trustResult.rows.length > 0
    ? parseInt(trustResult.rows[0].trust_score)
    : 100;
  
  // 最终评分（加权平均）
  const finalScore = Math.round((behaviorScore * 0.6 + gpsTrustScore * 0.4));
  
  // 记录评分分布
  metrics.histograms.behaviorScore.observe(behaviorScore);
  
  return {
    behaviorScore,
    gpsTrustScore,
    finalScore,
    anomalies: allAnomalies,
  };
}

/**
 * 记录异常
 */
async function recordAnomaly(userId, anomaly, behaviorScoreBefore, behaviorScoreAfter, actionTaken = 'FLAGGED') {
  await query(`
    INSERT INTO behavior_anomaly_records (
      user_id, anomaly_type, severity, details,
      behavior_score_before, behavior_score_after, action_taken
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    userId,
    anomaly.type,
    anomaly.severity,
    JSON.stringify(anomaly),
    behaviorScoreBefore,
    behaviorScoreAfter,
    actionTaken,
  ]);
}

// ============================================================
// 辅助函数
// ============================================================

function calculateSpeed(lat1, lng1, time1, lat2, lng2, time2) {
  const distance = haversineDistance(lat1, lng1, lat2, lng2);
  const timeDiff = (time2 - time1) / 1000; // 秒
  return timeDiff > 0 ? distance / timeDiff : 0;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculatePathLength(locations) {
  let total = 0;
  for (let i = 1; i < locations.length; i++) {
    total += haversineDistance(
      locations[i-1].latitude, locations[i-1].longitude,
      locations[i].latitude, locations[i].longitude
    );
  }
  return total;
}

function countRevisits(locations, thresholdMeters = 500) {
  const visited = new Set();
  let revisits = 0;
  
  for (const loc of locations) {
    const key = `${Math.round(loc.latitude * 1000)},${Math.round(loc.longitude * 1000)}`;
    if (visited.has(key)) {
      revisits++;
    } else {
      visited.add(key);
    }
  }
  
  return revisits;
}

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateVariance(arr) {
  if (!arr || arr.length === 0) return 0;
  const mean = average(arr);
  return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
}

function extractDays(intervalStr) {
  if (!intervalStr) return 1;
  const match = intervalStr.match(/(\d+)\s*days?/i);
  return match ? parseInt(match[1]) : 1;
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  calculateExpectedCatchRate,
  analyzeCatchAnomaly,
  analyzeTrajectoryAnomaly,
  analyzeBattleAnomaly,
  analyzeResourceAnomaly,
  analyzeTimePatternAnomaly,
  analyzeDeviceAnomaly,
  calculateBehaviorTrustScore,
  recordAnomaly,
  extractTrajectoryFeatures,
  CATCH_RATE_MODEL,
};
