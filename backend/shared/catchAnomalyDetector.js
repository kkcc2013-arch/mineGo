// shared/catchAnomalyDetector.js - 精灵捕捉成功率异常检测系统
// REQ-00082: 捕捉成功率异常检测、数据完整性验证、批量检测、风控引擎
'use strict';

const crypto = require('crypto');
const { query, getPool } = require('./db');
const { getRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('catch-anomaly');

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value,name) {
  if(typeof value!=='string'||!UUID_PATTERN.test(value))throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}
function text(value,name,max=64) {if(typeof value!=='string'||!value.length||value.length>max)throw new Error(`Invalid ${name}`);return value;}
function number(value,name,min,max) {if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`Invalid ${name}`);return value;}
function subject(value) {text(value,'Pokemon identity');return UUID_PATTERN.test(value)?value.toLowerCase():value;}
function optionalNumber(value,name,min,max) {return value==null?null:number(value,name,min,max);}

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
  constructor(options={}) {this.query=options.query||query;}
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
  async getUserCatchStats(userId,pokemonId,hours=24) {
    userId=requireUuid(userId,'user identity');pokemonId=subject(pokemonId);
    if(!Number.isInteger(hours)||hours<1||hours>8760)throw new Error('Invalid statistics interval');
    const {rows:[row]}=await this.query(`SELECT COALESCE(SUM(attempt_count),0)::bigint AS total_attempts,
      COALESCE(SUM(success_count),0)::bigint AS total_success,
      SUM(expected_rate_sum)/NULLIF(SUM(attempt_count),0) AS avg_expected_rate,
      MAX(anomaly_score) AS max_anomaly_score FROM catch_success_stats WHERE user_id=$1 AND pokemon_id=$2
      AND hour_timestamp>NOW()-$3*INTERVAL '1 hour'`,[userId,pokemonId,hours]);
    const attempts=Number(row.total_attempts),success=Number(row.total_success);
    return {attempts,success,actualRate:attempts?success/attempts:null,
      expectedRate:row.avg_expected_rate===null?null:Number(row.avg_expected_rate),
      maxAnomalyScore:row.max_anomaly_score===null?null:Number(row.max_anomaly_score)};
  }

  async recordCatchStats(userId,pokemonId,pokemonRarity,ballType,success,expectedRate,auditId=null) {
    userId=requireUuid(userId,'user identity');pokemonId=subject(pokemonId);text(pokemonRarity,'rarity',32);text(ballType,'ball type',32);
    if(typeof success!=='boolean')throw new Error('Catch success must be an observed boolean');number(expectedRate,'expected probability',0,1);
    if(auditId!==null)auditId=requireUuid(auditId,'audit identity');
    const {rows:[row]}=await this.query(`WITH bucket AS(SELECT CASE WHEN $7::uuid IS NULL THEN date_trunc('hour',NOW())
      ELSE(SELECT date_trunc('hour',catch_timestamp) AT TIME ZONE current_setting('TimeZone') FROM catch_risk_attempts
        WHERE id=$7 AND user_id=$1::uuid AND pokemon_id=$2 AND pokemon_rarity=$3 AND ball_type=$4
          AND actual_result IS NOT NULL AND (actual_result='success')=($5::integer=1) AND expected_success_rate=$6::numeric) END AS observed_hour)
      INSERT INTO catch_success_stats(user_id,pokemon_id,pokemon_rarity,ball_type,
      attempt_count,success_count,expected_rate_sum,expected_success_rate,actual_success_rate,hour_timestamp)
      SELECT $1,$2,$3,$4,1,$5::integer,$6::numeric,$6::numeric,$5::integer::numeric,observed_hour FROM bucket WHERE observed_hour IS NOT NULL
      ON CONFLICT(user_id,pokemon_id,pokemon_rarity,ball_type,hour_timestamp) DO UPDATE SET
      attempt_count=catch_success_stats.attempt_count+1,success_count=catch_success_stats.success_count+EXCLUDED.success_count,
      expected_rate_sum=catch_success_stats.expected_rate_sum+EXCLUDED.expected_rate_sum,
      expected_success_rate=(catch_success_stats.expected_rate_sum+EXCLUDED.expected_rate_sum)/(catch_success_stats.attempt_count+1),
      actual_success_rate=(catch_success_stats.success_count+EXCLUDED.success_count)::numeric/(catch_success_stats.attempt_count+1),
      updated_at=NOW() RETURNING *`,[userId,pokemonId,pokemonRarity,ballType,success?1:0,expectedRate,auditId]);
    if(!row)throw new Error('Hourly observation lacks matching owned audit evidence');
    return row;
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
  constructor(options={}) {
    this.db=options.db||null;
    this.rateAnalyzer = new CatchSuccessRateAnalyzer({query:options.db?.query.bind(options.db)});
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
      ...catchRequest,
      userId,
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
  async recordCatchSession(catchRequest,riskResult,actualResult=null) {
    if(!catchRequest||typeof catchRequest!=='object'||Array.isArray(catchRequest)||!riskResult||typeof riskResult!=='object')throw new Error('Invalid catch risk record');
    const userId=requireUuid(catchRequest.userId,'user identity');const pokemonId=subject(catchRequest.pokemonId);
    const auditId=catchRequest.auditId===undefined?crypto.randomUUID():requireUuid(catchRequest.auditId,'audit identity');
    const gameSessionId=catchRequest.gameSessionId==null?null:requireUuid(catchRequest.gameSessionId,'game session identity');
    const throwId=catchRequest.throwId==null?null:requireUuid(catchRequest.throwId,'throw identity');
    if(![null,'success','fail','escape'].includes(actualResult)||(actualResult!==null)!==(throwId!==null))throw new Error('Observed catch outcome requires actual gameplay throw evidence');
    if(!['allow','warn','block'].includes(riskResult.action)||!['low','medium','high','critical'].includes(riskResult.riskLevel))throw new Error('Invalid catch risk decision');
    number(riskResult.riskScore,'risk score',0,100);
    const ballCount=optionalNumber(catchRequest.ballCount,'ball count',1,100),berries=optionalNumber(catchRequest.berries,'berries',0,2147483647);
    if((ballCount!==null&&!Number.isInteger(ballCount))||(berries!==null&&!Number.isInteger(berries)))throw new Error('Invalid item quantity');
    if(catchRequest.curveball!==undefined&&typeof catchRequest.curveball!=='boolean')throw new Error('Invalid curveball flag');
    const lat=optionalNumber(catchRequest.location?.lat,'latitude',-90,90),lng=optionalNumber(catchRequest.location?.lng,'longitude',-180,180);
    if((lat===null)!==(lng===null))throw new Error('Both location coordinates are required');
    const probability=optionalNumber(riskResult.details?.successRate?.expectedRate,'expected probability',0,1);
    const integrity=optionalNumber(riskResult.details?.integrity?.integrityScore,'integrity score',0,100);
    const snapshot=JSON.stringify({request:{userId,pokemonId,gameSessionId,throwId,pokemonRarity:catchRequest.pokemonRarity,
      ballType:catchRequest.ballType,ballCount,berries,throwType:catchRequest.throwType,curveball:catchRequest.curveball,
      location:lat===null?null:{lat,lng},timestamp:catchRequest.timestamp,deviceFingerprint:catchRequest.deviceFingerprint,signature:catchRequest.signature},
      risk:riskResult,actualResult});
    if(Buffer.byteLength(snapshot)>65536)throw new Error('Catch risk snapshot exceeds storage limit');
    const client=await (this.db||getPool()).connect();
    try {
      await client.query('BEGIN');
      const {rows:[stored]}=await client.query(`INSERT INTO catch_risk_attempts(id,user_id,pokemon_id,game_session_id,throw_id,
        pokemon_rarity,ball_type,ball_count_used,berries_used,throw_type,curveball,expected_success_rate,actual_result,
        location_lat,location_lng,device_fingerprint,request_signature,data_integrity_score,risk_score,risk_level,action_taken,request_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT(id) DO NOTHING RETURNING *`,[auditId,userId,pokemonId,gameSessionId,throwId,catchRequest.pokemonRarity??null,
        catchRequest.ballType??null,ballCount,berries,catchRequest.throwType??null,catchRequest.curveball??null,probability,actualResult,
        lat,lng,catchRequest.deviceFingerprint??null,catchRequest.signature??null,integrity,riskResult.riskScore,riskResult.riskLevel,riskResult.action,snapshot]);
      if(!stored) {
        const {rows:[previous]}=await client.query('SELECT user_id=$2::uuid AND request_snapshot=$3::jsonb AS matches FROM catch_risk_attempts WHERE id=$1',[auditId,userId,snapshot]);
        if(previous?.matches!==true)throw new Error('Catch risk audit identity conflicts with an existing record');
        await client.query('COMMIT');return auditId;
      }
      const observed=stored.actual_result!==null,success=stored.actual_result==='success';
      if(observed)await new CatchSuccessRateAnalyzer({query:client.query.bind(client)}).recordCatchStats(userId,pokemonId,stored.pokemon_rarity,stored.ball_type,success,Number(stored.expected_success_rate),stored.id);
      await client.query(`INSERT INTO user_catch_stats(user_id,total_catches,total_attempts,risk_requests,last_catch_at,warning_count,blocked_count)
        VALUES($1,$2,$3,1,(SELECT catch_timestamp FROM catch_risk_attempts WHERE id=$4),$5,$6) ON CONFLICT(user_id) DO UPDATE SET total_catches=user_catch_stats.total_catches+EXCLUDED.total_catches,
        total_attempts=user_catch_stats.total_attempts+EXCLUDED.total_attempts,risk_requests=user_catch_stats.risk_requests+1,
        last_catch_at=GREATEST(EXCLUDED.last_catch_at,user_catch_stats.last_catch_at),warning_count=user_catch_stats.warning_count+EXCLUDED.warning_count,
        blocked_count=user_catch_stats.blocked_count+EXCLUDED.blocked_count,updated_at=NOW()`,[userId,success?1:0,observed?1:0,stored.id,riskResult.action==='warn'?1:0,riskResult.action==='block'?1:0]);
      await client.query('COMMIT');return stored.id;
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
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
