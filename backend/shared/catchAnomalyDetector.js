// shared/catchAnomalyDetector.js - 精灵捕捉成功率异常检测系统
// REQ-00082: 捕捉成功率异常检测、数据完整性验证、批量检测、风控引擎
'use strict';

const crypto = require('crypto');
const { query } = require('./db');
const { getRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('catch-anomaly');

// ============================================================
// 配置常量
// ============================================================

// 基础捕捉率配置（按稀有度）
const BASE_CATCH_RATES = {
  common: 0.40,      // 40%
  rare: 0.20,        // 20%
  epic: 0.10,        // 10%
  legendary: 0.05,   // 5%
};

// 道具加成
const BALL_MODIFIERS = {
  poke: 1.0,
  great: 1.5,
  ultra: 2.0,
  master: 255.0,     // 大师球必中
};

// 投掷加成
const THROW_MODIFIERS = {
  normal: 1.0,
  nice: 1.1,
  great: 1.3,
  excellent: 1.5,
};

// 捕捉频率限制
const CATCH_RATE_LIMITS = {
  common: { maxPerMinute: 15, maxPerHour: 200, maxPerDay: 1500 },
  rare: { maxPerMinute: 10, maxPerHour: 100, maxPerDay: 600 },
  epic: { maxPerMinute: 5, maxPerHour: 50, maxPerDay: 200 },
  legendary: { maxPerMinute: 2, maxPerHour: 15, maxPerDay: 50 },
};

// 风控规则配置
const RISK_RULES = [
  { name: 'high_success_rate', weight: 30, threshold: 70 },
  { name: 'batch_catch', weight: 25, threshold: 50 },
  { name: 'data_integrity', weight: 20, threshold: 60 },
  { name: 'item_anomaly', weight: 15, threshold: 50 },
  { name: 'device_trust', weight: 10, threshold: 40 },
];

// ============================================================
// Prometheus 指标
// ============================================================

const register = new promClient.Registry();

const metrics = {
  catchRequestsTotal: new promClient.Counter({
    name: 'minego_catch_requests_total',
    help: 'Total catch requests',
    labelNames: ['result', 'risk_level'],
    registers: [register],
  }),

  catchSuccessRate: new promClient.Gauge({
    name: 'minego_catch_success_rate',
    help: 'Catch success rate by pokemon rarity',
    labelNames: ['rarity', 'ball_type'],
    registers: [register],
  }),

  catchAnomalyTotal: new promClient.Counter({
    name: 'minego_catch_anomaly_total',
    help: 'Catch anomaly detections',
    labelNames: ['type', 'severity'],
    registers: [register],
  }),

  riskBlockedTotal: new promClient.Counter({
    name: 'minego_catch_risk_blocked_total',
    help: 'Catch requests blocked by risk engine',
    labelNames: ['risk_level'],
    registers: [register],
  }),

  integrityScoreHistogram: new promClient.Histogram({
    name: 'minego_catch_integrity_score',
    help: 'Catch request integrity score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
    registers: [register],
  }),
};

// ============================================================
// 捕捉成功率分析器
// ============================================================

class CatchSuccessRateAnalyzer {
  /**
   * 计算预期成功率
   */
  calculateExpectedRate(pokemonRarity, ballType, throwType = 'normal', curveball = false, berries = 0) {
    let base = BASE_CATCH_RATES[pokemonRarity] || 0.10;
    let modifier = BALL_MODIFIERS[ballType] || 1.0;
    modifier *= THROW_MODIFIERS[throwType] || 1.0;
    if (curveball) modifier *= 1.7;
    if (berries > 0) modifier *= (1 + berries * 0.1);
    
    return Math.min(1.0, base * modifier);
  }

  /**
   * 异常评分（0-100）
   */
  calculateAnomalyScore(expectedRate, actualRate, attempts) {
    if (attempts < 5) return 0; // 样本量太小不计分

    // 1. Z-score 检验（统计显著性）
    const variance = expectedRate * (1 - expectedRate) / attempts;
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? (actualRate - expectedRate) / stdDev : 0;

    let score = 0;

    // Z-score 贡献（超过 2σ 开始计分）
    if (zScore > 2) {
      score += Math.min(40, (zScore - 2) * 10);
    }

    // 概率差异贡献
    const diff = actualRate - expectedRate;
    if (diff > 0.3) {
      score += Math.min(40, diff * 100);
    }

    // 样本量权重（至少 20 次才完全计分）
    if (attempts >= 20) {
      score *= Math.min(1.5, attempts / 50);
    } else {
      score *= (attempts / 20);
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * 获取用户历史捕捉统计
   */
  async getUserCatchStats(userId, pokemonId, hours = 24) {
    try {
      const result = await query(`
        SELECT 
          SUM(attempt_count) as total_attempts,
          SUM(success_count) as total_success,
          AVG(expected_success_rate) as avg_expected_rate,
          MAX(anomaly_score) as max_anomaly_score
        FROM catch_success_stats
        WHERE user_id = $1 
          AND pokemon_id = $2
          AND hour_timestamp > NOW() - INTERVAL '${hours} hours'
      `, [userId, pokemonId]);

      const row = result.rows[0];
      const attempts = parseInt(row.total_attempts) || 0;
      const success = parseInt(row.total_success) || 0;

      return {
        attempts,
        success,
        actualRate: attempts > 0 ? success / attempts : 0,
        expectedRate: parseFloat(row.avg_expected_rate) || 0.1,
        maxAnomalyScore: parseFloat(row.max_anomaly_score) || 0,
      };
    } catch (err) {
      logger.error('Failed to get user catch stats', { userId, pokemonId, error: err.message });
      return { attempts: 0, success: 0, actualRate: 0, expectedRate: 0.1, maxAnomalyScore: 0 };
    }
  }

  /**
   * 记录捕捉统计
   */
  async recordCatchStats(userId, pokemonId, pokemonRarity, ballType, success, expectedRate) {
    const hourTimestamp = new Date();
    hourTimestamp.setMinutes(0, 0, 0);

    try {
      await query(`
        INSERT INTO catch_success_stats (
          user_id, pokemon_id, pokemon_rarity, ball_type,
          attempt_count, success_count, expected_success_rate,
          actual_success_rate, hour_timestamp
        )
        VALUES ($1, $2, $3, $4, 1, $5, $6, $5, $7)
        ON CONFLICT DO NOTHING
      `, [userId, pokemonId, pokemonRarity, ballType, success ? 1 : 0, expectedRate, hourTimestamp]);

      // 更新统计
      await query(`
        UPDATE catch_success_stats
        SET 
          attempt_count = attempt_count + 1,
          success_count = success_count + $1,
          actual_success_rate = success_count::DECIMAL / attempt_count,
          updated_at = NOW()
        WHERE user_id = $2 
          AND pokemon_id = $3
          AND hour_timestamp = $4
      `, [success ? 1 : 0, userId, pokemonId, hourTimestamp]);
    } catch (err) {
      logger.error('Failed to record catch stats', { userId, pokemonId, error: err.message });
    }
  }
}

// ============================================================
// 数据完整性验证器
// ============================================================

class CatchRequestValidator {
  /**
   * 生成请求签名
   */
  generateRequestSignature(userId, pokemonId, timestamp, location, nonce) {
    const payload = `${userId}|${pokemonId}|${timestamp}|${location.lng},${location.lat}|${nonce}`;
    const secretKey = process.env.CATCH_SECRET_KEY || 'default-catch-secret-key';
    return crypto
      .createHmac('sha256', secretKey)
      .update(payload)
      .digest('hex');
  }

  /**
   * 验证请求数据完整性
   */
  async validateCatchRequest(req) {
    const { 
      userId, pokemonId, timestamp, location, 
      signature, nonce, ballType, ballCount 
    } = req;

    const checks = {
      signatureValid: false,
      timestampValid: false,
      locationConsistent: true,
      inventoryConsistent: true,
      ballCountValid: false,
    };

    // 1. 签名验证
    if (signature && nonce) {
      try {
        const expectedSig = this.generateRequestSignature(userId, pokemonId, timestamp, location, nonce);
        checks.signatureValid = crypto.timingSafeEqual(
          Buffer.from(signature.padEnd(64, '0').slice(0, 64), 'hex'),
          Buffer.from(expectedSig, 'hex')
        );
      } catch (e) {
        checks.signatureValid = false;
      }
    }

    // 2. 时间戳验证（防重放，5分钟窗口）
    const now = Date.now();
    checks.timestampValid = Math.abs(now - timestamp) < 5 * 60 * 1000;

    // 3. 道具数量验证
    checks.ballCountValid = ballCount > 0 && ballCount <= 100;

    // 4. 计算完整性评分
    const passedChecks = Object.values(checks).filter(v => v).length;
    const integrityScore = (passedChecks / Object.keys(checks).length) * 100;

    metrics.integrityScoreHistogram.observe(integrityScore);

    return {
      valid: integrityScore >= 60,
      integrityScore,
      checks,
    };
  }

  /**
   * 计算两点距离（Haversine 公式）
   */
  calculateDistance(loc1, loc2) {
    const R = 6371000; // 地球半径（米）
    const lat1 = loc1.lat * Math.PI / 180;
    const lat2 = loc2.lat * Math.PI / 180;
    const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
    const dLng = (loc2.lng - loc1.lng) * Math.PI / 180;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}

// ============================================================
// 批量捕捉检测器
// ============================================================

class BatchCatchDetector {
  /**
   * 检测批量捕捉行为
   */
  async detectBatchCatch(userId, pokemonRarity) {
    const limits = CATCH_RATE_LIMITS[pokemonRarity] || CATCH_RATE_LIMITS.common;
    const redis = getRedis();

    const violations = [];

    try {
      // 滑动窗口计数
      const minuteKey = `catch:${userId}:minute`;
      const hourKey = `catch:${userId}:hour`;
      const dayKey = `catch:${userId}:day`;

      const minuteCount = parseInt(await redis.get(minuteKey) || '0');
      const hourCount = parseInt(await redis.get(hourKey) || '0');
      const dayCount = parseInt(await redis.get(dayKey) || '0');

      if (minuteCount > limits.maxPerMinute) {
        violations.push({ window: 'minute', count: minuteCount, limit: limits.maxPerMinute });
      }
      if (hourCount > limits.maxPerHour) {
        violations.push({ window: 'hour', count: hourCount, limit: limits.maxPerHour });
      }
      if (dayCount > limits.maxPerDay) {
        violations.push({ window: 'day', count: dayCount, limit: limits.maxPerDay });
      }
    } catch (err) {
      logger.error('Failed to detect batch catch', { userId, error: err.message });
    }

    const riskScore = this.calculateRiskScore(violations);

    return {
      isBatch: violations.length > 0,
      violations,
      riskScore,
      riskLevel: this.calculateRiskLevel(violations),
    };
  }

  /**
   * 增加捕捉计数
   */
  async incrementCatchCount(userId) {
    const redis = getRedis();
    try {
      const minuteKey = `catch:${userId}:minute`;
      const hourKey = `catch:${userId}:hour`;
      const dayKey = `catch:${userId}:day`;

      await redis.multi()
        .incr(minuteKey).expire(minuteKey, 60)
        .incr(hourKey).expire(hourKey, 3600)
        .incr(dayKey).expire(dayKey, 86400)
        .exec();
    } catch (err) {
      logger.error('Failed to increment catch count', { userId, error: err.message });
    }
  }

  calculateRiskScore(violations) {
    if (violations.length === 0) return 0;
    let score = 0;
    for (const v of violations) {
      const ratio = v.count / v.limit;
      score += Math.min(50, (ratio - 1) * 100);
    }
    return Math.min(100, score);
  }

  calculateRiskLevel(violations) {
    if (violations.length === 0) return 'low';
    if (violations.some(v => v.count > v.limit * 2)) return 'critical';
    if (violations.some(v => v.count > v.limit * 1.5)) return 'high';
    return 'medium';
  }
}

// ============================================================
// 风控决策引擎
// ============================================================

class CatchRiskEngine {
  constructor() {
    this.rateAnalyzer = new CatchSuccessRateAnalyzer();
    this.requestValidator = new CatchRequestValidator();
    this.batchDetector = new BatchCatchDetector();
  }

  /**
   * 综合风险评估
   */
  async evaluateRisk(userId, catchRequest) {
    const startTime = Date.now();

    // 并行执行所有检测
    const [
      successRateResult,
      batchResult,
      integrityResult,
    ] = await Promise.all([
      this.checkSuccessRate(userId, catchRequest),
      this.checkBatchCatch(userId, catchRequest.pokemonRarity),
      this.checkDataIntegrity(userId, catchRequest),
    ]);

    // 计算各维度评分
    const scores = {
      high_success_rate: successRateResult.anomalyScore,
      batch_catch: batchResult.riskScore,
      data_integrity: 100 - integrityResult.integrityScore,
      item_anomaly: 0, // 简化实现
      device_trust: 0, // 简化实现
    };

    // 计算综合风险评分
    let totalRiskScore = 0;
    for (const rule of RISK_RULES) {
      const score = scores[rule.name] || 0;
      const weightedScore = (score / rule.threshold) * rule.weight;
      totalRiskScore += Math.min(rule.weight, weightedScore);
    }

    // 确定风险等级和动作
    let riskLevel = 'low';
    let action = 'allow';

    if (totalRiskScore >= 80) {
      riskLevel = 'critical';
      action = 'block';
    } else if (totalRiskScore >= 60) {
      riskLevel = 'high';
      action = 'block';
    } else if (totalRiskScore >= 40) {
      riskLevel = 'medium';
      action = 'warn';
    } else if (totalRiskScore >= 20) {
      riskLevel = 'low';
      action = 'allow';
    }

    // 记录指标
    metrics.catchRequestsTotal.inc({ result: action, risk_level: riskLevel });
    if (action === 'block') {
      metrics.riskBlockedTotal.inc({ risk_level: riskLevel });
    }

    const duration = Date.now() - startTime;
    logger.info('Risk evaluation completed', {
      userId,
      riskLevel,
      action,
      totalRiskScore,
      duration,
    });

    return {
      riskScore: totalRiskScore,
      riskLevel,
      action,
      scores,
      details: {
        successRate: successRateResult,
        batch: batchResult,
        integrity: integrityResult,
      },
    };
  }

  /**
   * 检查成功率异常
   */
  async checkSuccessRate(userId, catchRequest) {
    const { pokemonId, pokemonRarity, ballType, throwType, curveball, berries } = catchRequest;

    const expectedRate = this.rateAnalyzer.calculateExpectedRate(
      pokemonRarity, ballType, throwType, curveball, berries
    );

    const stats = await this.rateAnalyzer.getUserCatchStats(userId, pokemonId, 24);

    const anomalyScore = this.rateAnalyzer.calculateAnomalyScore(
      expectedRate, stats.actualRate, stats.attempts
    );

    if (anomalyScore > 50) {
      metrics.catchAnomalyTotal.inc({ type: 'success_rate', severity: anomalyScore > 80 ? 'high' : 'medium' });
    }

    return {
      expectedRate,
      actualRate: stats.actualRate,
      attempts: stats.attempts,
      anomalyScore,
    };
  }

  /**
   * 检查批量捕捉
   */
  async checkBatchCatch(userId, pokemonRarity) {
    return this.batchDetector.detectBatchCatch(userId, pokemonRarity);
  }

  /**
   * 检查数据完整性
   */
  async checkDataIntegrity(userId, catchRequest) {
    return this.requestValidator.validateCatchRequest({
      userId,
      ...catchRequest,
    });
  }

  /**
   * 执行风控动作
   */
  async executeAction(action, catchRequest) {
    switch (action) {
      case 'block':
        return {
          success: false,
          error: 'CATCH_BLOCKED_RISK_DETECTED',
          message: '捕捉请求已被风控系统拦截',
          retryable: false,
        };

      case 'warn':
        return {
          success: true,
          warning: true,
          message: '您的捕捉行为存在异常，请遵守游戏规则',
        };

      case 'allow':
      default:
        return { success: true };
    }
  }

  /**
   * 记录捕捉会话
   */
  async recordCatchSession(catchRequest, riskResult, actualResult) {
    const sessionId = crypto.randomUUID();

    try {
      await query(`
        INSERT INTO catch_sessions (
          session_id, user_id, pokemon_id, pokemon_rarity,
          ball_type, ball_count_used, berries_used, throw_type, curveball,
          expected_success_rate, actual_result, catch_timestamp,
          location_lat, location_lng, device_fingerprint, request_signature,
          data_integrity_score, risk_score, risk_level, action_taken
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      `, [
        sessionId,
        catchRequest.userId,
        catchRequest.pokemonId,
        catchRequest.pokemonRarity,
        catchRequest.ballType,
        catchRequest.ballCount || 1,
        catchRequest.berries || 0,
        catchRequest.throwType || 'normal',
        catchRequest.curveball || false,
        riskResult.details?.successRate?.expectedRate || 0,
        actualResult,
        new Date(),
        catchRequest.location?.lat,
        catchRequest.location?.lng,
        catchRequest.deviceFingerprint,
        catchRequest.signature,
        riskResult.details?.integrity?.integrityScore || 0,
        riskResult.riskScore,
        riskResult.riskLevel,
        riskResult.action,
      ]);

      // 更新用户统计
      await query(`
        INSERT INTO user_catch_stats (user_id, total_catches, total_attempts, last_catch_at)
        VALUES ($1, $2, 1, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          total_catches = user_catch_stats.total_catches + $2,
          total_attempts = user_catch_stats.total_attempts + 1,
          last_catch_at = NOW(),
          updated_at = NOW()
      `, [catchRequest.userId, actualResult === 'success' ? 1 : 0]);

    } catch (err) {
      logger.error('Failed to record catch session', { sessionId, error: err.message });
    }

    return sessionId;
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  CatchRiskEngine,
  CatchSuccessRateAnalyzer,
  CatchRequestValidator,
  BatchCatchDetector,
  BASE_CATCH_RATES,
  BALL_MODIFIERS,
  THROW_MODIFIERS,
  CATCH_RATE_LIMITS,
  metrics,
  register,
};
