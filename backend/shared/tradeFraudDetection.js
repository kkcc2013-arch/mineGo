// shared/tradeFraudDetection.js - 精灵交换欺诈检测与交易安全系统
'use strict';

const { query } = require('./db');
const { getRedis, setRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('trade-fraud-detection');

// ============================================================
// Prometheus 指标
// ============================================================

const fraudDetectionMetrics = {
  tradesAnalyzed: new promClient.Counter({
    name: 'trade_fraud_trades_analyzed_total',
    help: 'Total number of trades analyzed for fraud',
    labelNames: ['risk_level']
  }),
  
  fraudDetected: new promClient.Counter({
    name: 'trade_fraud_detected_total',
    help: 'Number of frauds detected',
    labelNames: ['type', 'severity']
  }),
  
  detectionLatency: new promClient.Histogram({
    name: 'trade_fraud_detection_latency_seconds',
    help: 'Fraud detection latency',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2]
  })
};

// ============================================================
// 风险等级枚举
// ============================================================

const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

const FraudType = {
  VALUE_DISPARITY: 'value_disparity',
  ACCOUNT_ANOMALY: 'account_anomaly',
  DEVICE_FINGERPRINT: 'device_fingerprint',
  BEHAVIORAL_PATTERN: 'behavioral_pattern',
  NETWORK_ANOMALY: 'network_anomaly',
  GROUP_DETECTION: 'group_detection'
};

// ============================================================
// 精灵价值评估引擎
// ============================================================

class PokemonValuationEngine {
  constructor() {
    this.valueWeights = {
      base: 0.3,      // 基础价值
      market: 0.25,   // 市场价值
      rarity: 0.2,    // 稀有度
      potential: 0.15, // 潜力值
      sentimental: 0.1 // 情感价值
    };
  }

  /**
   * 评估精灵综合价值
   */
  async evaluate(pokemon) {
    const baseValue = this.calculateBaseValue(pokemon);
    const marketValue = await this.getMarketValue(pokemon.species_id);
    const rarity = this.calculateRarity(pokemon);
    const potential = this.calculatePotential(pokemon);
    const sentimental = await this.calculateSentimental(pokemon);

    const totalValue = 
      baseValue * this.valueWeights.base +
      marketValue * this.valueWeights.market +
      rarity * this.valueWeights.rarity +
      potential * this.valueWeights.potential +
      sentimental * this.valueWeights.sentimental;

    return {
      pokemonId: pokemon.id,
      speciesId: pokemon.species_id,
      baseValue,
      marketValue,
      rarity,
      potential,
      sentimental,
      totalValue: Math.round(totalValue)
    };
  }

  /**
   * 计算基础价值
   */
  calculateBaseValue(pokemon) {
    // CP、等级、IV 综合评分
    const cpScore = Math.min(pokemon.cp / 5000, 1) * 100;
    const levelScore = (pokemon.level / 50) * 100;
    const ivScore = ((pokemon.iv_attack + pokemon.iv_defense + pokemon.iv_hp) / 45) * 100;
    
    // 闪光和幸运加成
    let bonus = 1;
    if (pokemon.is_shiny) bonus += 0.3;
    if (pokemon.is_lucky) bonus += 0.2;
    
    return ((cpScore + levelScore + ivScore) / 3) * bonus;
  }

  /**
   * 获取市场价值（基于最近交易）
   */
  async getMarketValue(speciesId) {
    try {
      const { rows: [result] } = await query(`
        SELECT AVG(
          (pi.cp / 100.0) + 
          (pi.level * 2) + 
          ((pi.iv_attack + pi.iv_defense + pi.iv_hp) / 3.0)
        ) AS avg_value
        FROM pokemon_trades pt
        JOIN pokemon_instances pi ON pi.id = pt.offered_pokemon
        WHERE pi.species_id = $1
          AND pt.created_at >= NOW() - INTERVAL '30 days'
          AND pt.status = 'completed'
      `, [speciesId]);

      return result.avg_value || 50; // 默认价值
    } catch (error) {
      logger.error({ error, speciesId }, '获取市场价值失败');
      return 50;
    }
  }

  /**
   * 计算稀有度评分
   */
  calculateRarity(pokemon) {
    const rarityScores = {
      'COMMON': 10,
      'UNCOMMON': 25,
      'RARE': 50,
      'EPIC': 75,
      'LEGENDARY': 95,
      'MYTHICAL': 100
    };

    let score = rarityScores[pokemon.rarity] || 10;
    
    // 闪光稀有度加成
    if (pokemon.is_shiny) {
      score = Math.min(score * 1.5, 100);
    }

    return score;
  }

  /**
   * 计算潜力值（IV、技能）
   */
  calculatePotential(pokemon) {
    // IV 总分
    const ivTotal = (pokemon.iv_attack || 0) + (pokemon.iv_defense || 0) + (pokemon.iv_hp || 0);
    const ivScore = (ivTotal / 45) * 100;

    // TODO: 技能评分（需要技能数据）
    const skillScore = 50; // 默认

    return (ivScore + skillScore) / 2;
  }

  /**
   * 计算情感价值
   */
  async calculateSentimental(pokemon) {
    try {
      // 陪伴时长
      const { rows: [ownership] } = await query(`
        SELECT 
          EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS days_owned
        FROM pokemon_instances
        WHERE id = $1
      `, [pokemon.id]);

      const daysOwned = ownership?.days_owned || 0;
      
      // 陪伴时间加成（最多 30 分）
      const timeScore = Math.min(daysOwned / 30, 1) * 30;

      // 特殊事件精灵（如活动限定）
      const isEvent = pokemon.is_event || false;
      const eventScore = isEvent ? 20 : 0;

      return timeScore + eventScore;
    } catch (error) {
      logger.error({ error, pokemonId: pokemon.id }, '计算情感价值失败');
      return 0;
    }
  }

  /**
   * 评估交易公平性
   */
  async evaluateTradeFairness(offer, receive) {
    const offerValue = await this.evaluate(offer);
    const receiveValue = await this.evaluate(receive);

    const ratio = offerValue.totalValue / Math.max(receiveValue.totalValue, 1);
    const difference = Math.abs(offerValue.totalValue - receiveValue.totalValue);

    let risk;
    if (ratio >= 0.7 && ratio <= 1.4) {
      risk = RiskLevel.LOW;
    } else if (ratio >= 0.4 && ratio <= 2.5) {
      risk = RiskLevel.MEDIUM;
    } else {
      risk = RiskLevel.HIGH;
    }

    return {
      offerValue: offerValue.totalValue,
      receiveValue: receiveValue.totalValue,
      ratio: Math.round(ratio * 100) / 100,
      difference,
      risk,
      recommendation: this.getRecommendation(risk, ratio),
      offerDetails: offerValue,
      receiveDetails: receiveValue
    };
  }

  /**
   * 获取建议
   */
  getRecommendation(risk, ratio) {
    if (risk === RiskLevel.LOW) {
      return '交易价值合理，可以继续';
    } else if (risk === RiskLevel.MEDIUM) {
      return '交易价值有一定差异，请谨慎确认';
    } else {
      return '交易价值严重不对等，建议重新考虑';
    }
  }
}

// ============================================================
// 欺诈检测器基类
// ============================================================

class FraudDetector {
  constructor(type) {
    this.type = type;
  }

  async detect(request) {
    throw new Error('detect() must be implemented');
  }
}

// ============================================================
// 价值不对等检测器
// ============================================================

class ValueDisparityDetector extends FraudDetector {
  constructor() {
    super(FraudType.VALUE_DISPARITY);
    this.valuationEngine = new PokemonValuationEngine();
  }

  async detect(request) {
    const { initiatorOffer, receiverOffer } = request;

    // 计算双方总价值
    let initiatorTotalValue = 0;
    let receiverTotalValue = 0;

    for (const pokemon of initiatorOffer) {
      const valuation = await this.valuationEngine.evaluate(pokemon);
      initiatorTotalValue += valuation.totalValue;
    }

    for (const pokemon of receiverOffer) {
      const valuation = await this.valuationEngine.evaluate(pokemon);
      receiverTotalValue += valuation.totalValue;
    }

    const ratio = initiatorTotalValue / Math.max(receiverTotalValue, 1);
    const indicators = [];

    let score = 0;
    
    // 极端不对等
    if (ratio < 0.1 || ratio > 10) {
      score = 0.9;
      indicators.push('extreme_value_disparity');
    } else if (ratio < 0.3 || ratio > 3) {
      score = 0.5;
      indicators.push('moderate_value_disparity');
    } else if (ratio < 0.5 || ratio > 2) {
      score = 0.2;
      indicators.push('minor_value_disparity');
    }

    return {
      type: this.type,
      score,
      details: { initiatorTotalValue, receiverTotalValue, ratio: Math.round(ratio * 100) / 100 },
      indicators
    };
  }
}

// ============================================================
// 账号异常检测器
// ============================================================

class AccountAnomalyDetector extends FraudDetector {
  constructor() {
    super(FraudType.ACCOUNT_ANOMALY);
  }

  async detect(request) {
    const { initiatorId, receiverId, context } = request;
    const indicators = [];
    let score = 0;

    const {
      initiatorAccountAge,
      receiverAccountAge,
      initiatorTradeHistory,
      receiverTradeHistory
    } = context;

    // 新账号风险
    if (initiatorAccountAge < 7 || receiverAccountAge < 7) {
      score += 0.3;
      indicators.push('new_account_involved');
    }

    // 休眠账号突然活跃
    if (initiatorTradeHistory.totalTrades === 0 && initiatorAccountAge > 30) {
      score += 0.2;
      indicators.push('dormant_account_sudden_activity');
    }

    // 高频交易
    if (initiatorTradeHistory.tradesLast24h > 10) {
      score += 0.25;
      indicators.push('high_frequency_trading');
    }

    // 单向转移模式
    const initiatorNetTransfer = initiatorTradeHistory.givenCount - initiatorTradeHistory.receivedCount;
    if (Math.abs(initiatorNetTransfer) > 5) {
      score += 0.35;
      indicators.push('one_way_transfer_pattern');
    }

    return {
      type: this.type,
      score: Math.min(score, 1),
      details: {
        initiatorAccountAge,
        receiverAccountAge,
        initiatorTradeHistory,
        receiverTradeHistory
      },
      indicators
    };
  }
}

// ============================================================
// 设备指纹检测器
// ============================================================

class DeviceFingerprintDetector extends FraudDetector {
  constructor() {
    super(FraudType.DEVICE_FINGERPRINT);
  }

  async detect(request) {
    const { context } = request;
    const indicators = [];
    let score = 0;

    // 检测相同设备指纹
    if (context.initiatorDeviceFingerprint === context.receiverDeviceFingerprint) {
      score += 0.6;
      indicators.push('same_device_fingerprint');
    }

    // 检测设备指纹历史
    const initiatorDevices = await this.getUserDeviceHistory(request.initiatorId);
    const receiverDevices = await this.getUserDeviceHistory(request.receiverId);

    // 设备重叠度
    const deviceOverlap = this.calculateOverlap(initiatorDevices, receiverDevices);
    if (deviceOverlap > 0.5) {
      score += 0.4;
      indicators.push('high_device_overlap');
    }

    return {
      type: this.type,
      score: Math.min(score, 1),
      details: {
        initiatorDeviceFingerprint: context.initiatorDeviceFingerprint,
        receiverDeviceFingerprint: context.receiverDeviceFingerprint,
        deviceOverlap
      },
      indicators
    };
  }

  async getUserDeviceHistory(userId) {
    try {
      const { rows } = await query(`
        SELECT DISTINCT device_fingerprint
        FROM user_sessions
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        LIMIT 10
      `, [userId]);

      return rows.map(r => r.device_fingerprint);
    } catch (error) {
      logger.error({ error, userId }, '获取设备历史失败');
      return [];
    }
  }

  calculateOverlap(devices1, devices2) {
    if (devices1.length === 0 || devices2.length === 0) return 0;
    
    const set1 = new Set(devices1);
    const set2 = new Set(devices2);
    const intersection = [...set1].filter(d => set2.has(d));
    
    return intersection.length / Math.min(set1.size, set2.size);
  }
}

// ============================================================
// 行为模式检测器
// ============================================================

class BehavioralPatternDetector extends FraudDetector {
  constructor() {
    super(FraudType.BEHAVIORAL_PATTERN);
  }

  async detect(request) {
    const { initiatorId, receiverId } = request;
    const indicators = [];
    let score = 0;

    // 获取最近行为
    const initiatorBehavior = await this.getRecentBehavior(initiatorId);
    const receiverBehavior = await this.getRecentBehavior(receiverId);

    // 突然高价值精灵获取
    if (initiatorBehavior.recentHighValueAcquisitions > 3) {
      score += 0.4;
      indicators.push('sudden_high_value_acquisitions');
    }

    // 密码重置后立即交易
    if (initiatorBehavior.recentPasswordChange || receiverBehavior.recentPasswordChange) {
      score += 0.35;
      indicators.push('trade_after_password_change');
    }

    // 交易后立即下线
    if (receiverBehavior.lastSessionDuration < 300 && receiverBehavior.totalTrades > 0) {
      score += 0.3;
      indicators.push('quick_logout_after_trade');
    }

    // 异常登录模式
    if (initiatorBehavior.unusualLoginPattern || receiverBehavior.unusualLoginPattern) {
      score += 0.25;
      indicators.push('unusual_login_pattern');
    }

    return {
      type: this.type,
      score: Math.min(score, 1),
      details: {
        initiatorBehavior,
        receiverBehavior
      },
      indicators
    };
  }

  async getRecentBehavior(userId) {
    try {
      // 最近高价值精灵获取
      const { rows: [highValue] } = await query(`
        SELECT COUNT(*)::int AS count
        FROM pokemon_instances
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '7 days'
          AND cp >= 3000
      `, [userId]);

      // 密码重置
      const { rows: [pwdReset] } = await query(`
        SELECT EXISTS(
          SELECT 1 FROM user_security_events
          WHERE user_id = $1
            AND event_type = 'password_change'
            AND created_at >= NOW() - INTERVAL '24 hours'
        ) AS recent_change
      `, [userId]);

      // 最后会话时长
      const { rows: [session] } = await query(`
        SELECT 
          EXTRACT(EPOCH FROM (last_activity - created_at)) AS duration
        FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);

      // 总交易数
      const { rows: [trades] } = await query(`
        SELECT COUNT(*)::int AS total
        FROM pokemon_trades
        WHERE (initiator_id = $1 OR receiver_id = $1)
          AND status = 'completed'
      `, [userId]);

      // 异常登录模式（多地登录）
      const { rows: [login] } = await query(`
        SELECT COUNT(DISTINCT ip_address) > 5 AS unusual
        FROM user_sessions
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '24 hours'
      `, [userId]);

      return {
        recentHighValueAcquisitions: highValue?.count || 0,
        recentPasswordChange: pwdReset?.recent_change || false,
        lastSessionDuration: session?.duration || 0,
        totalTrades: trades?.total || 0,
        unusualLoginPattern: login?.unusual || false
      };
    } catch (error) {
      logger.error({ error, userId }, '获取用户行为失败');
      return {};
    }
  }
}

// ============================================================
// 网络异常检测器
// ============================================================

class NetworkAnomalyDetector extends FraudDetector {
  constructor() {
    super(FraudType.NETWORK_ANOMALY);
  }

  async detect(request) {
    const { context } = request;
    const indicators = [];
    let score = 0;

    // 相同 IP
    if (context.initiatorIPAddress === context.receiverIPAddress) {
      score += 0.5;
      indicators.push('same_ip_address');
    }

    // IP 地理距离异常
    if (context.geoDistance > 10000) { // 超过 10000 km
      score += 0.2;
      indicators.push('extreme_geo_distance');
    }

    // VPN/代理检测
    const initiatorVPN = await this.checkVPN(context.initiatorIPAddress);
    const receiverVPN = await this.checkVPN(context.receiverIPAddress);

    if (initiatorVPN || receiverVPN) {
      score += 0.3;
      indicators.push('vpn_or_proxy_detected');
    }

    return {
      type: this.type,
      score: Math.min(score, 1),
      details: {
        initiatorIP: context.initiatorIPAddress,
        receiverIP: context.receiverIPAddress,
        geoDistance: context.geoDistance,
        initiatorVPN,
        receiverVPN
      },
      indicators
    };
  }

  async checkVPN(ip) {
    // 简化版 VPN 检测（实际应调用第三方服务）
    try {
      const cacheKey = `vpn_check:${ip}`;
      const cached = await getRedis(cacheKey);
      
      if (cached !== null) {
        return cached === '1';
      }

      // TODO: 调用 IP 信誉服务
      const isVPN = false;
      
      await setRedis(cacheKey, isVPN ? '1' : '0', 3600); // 缓存 1 小时
      return isVPN;
    } catch (error) {
      logger.error({ error, ip }, 'VPN 检测失败');
      return false;
    }
  }
}

// ============================================================
// 团伙检测器
// ============================================================

class GroupDetectionDetector extends FraudDetector {
  constructor() {
    super(FraudType.GROUP_DETECTION);
  }

  async detect(request) {
    const { initiatorId, receiverId } = request;
    const indicators = [];
    let score = 0;

    // 检测交易网络关联
    const network = await this.analyzeTradeNetwork(initiatorId, receiverId);
    
    // 密集交易网络
    if (network.density > 0.7) {
      score += 0.4;
      indicators.push('dense_trade_network');
    }

    // 单向流动模式
    if (network.oneWayRatio > 0.8) {
      score += 0.3;
      indicators.push('one_way_flow_pattern');
    }

    // 账号创建时间聚集
    if (network.accountAgeClustering > 0.6) {
      score += 0.3;
      indicators.push('account_age_clustering');
    }

    return {
      type: this.type,
      score: Math.min(score, 1),
      details: network,
      indicators
    };
  }

  async analyzeTradeNetwork(userId1, userId2) {
    try {
      // 获取共同交易伙伴
      const { rows: partners } = await query(`
        WITH user1_partners AS (
          SELECT DISTINCT 
            CASE WHEN initiator_id = $1 THEN receiver_id ELSE initiator_id END AS partner_id
          FROM pokemon_trades
          WHERE (initiator_id = $1 OR receiver_id = $1)
            AND status = 'completed'
            AND created_at >= NOW() - INTERVAL '30 days'
        ),
        user2_partners AS (
          SELECT DISTINCT 
            CASE WHEN initiator_id = $2 THEN receiver_id ELSE initiator_id END AS partner_id
          FROM pokemon_trades
          WHERE (initiator_id = $2 OR receiver_id = $2)
            AND status = 'completed'
            AND created_at >= NOW() - INTERVAL '30 days'
        )
        SELECT 
          COUNT(DISTINCT u1.partner_id) AS user1_total,
          COUNT(DISTINCT u2.partner_id) AS user2_total,
          COUNT(DISTINCT CASE WHEN u2.partner_id IS NOT NULL THEN u1.partner_id END) AS common_partners
        FROM user1_partners u1
        FULL OUTER JOIN user2_partners u2 ON u1.partner_id = u2.partner_id
      `, [userId1, userId2]);

      const total = partners[0]?.user1_total + partners[0]?.user2_total || 0;
      const common = partners[0]?.common_partners || 0;
      const density = total > 0 ? common / Math.min(total, 10) : 0;

      // 单向流动比例
      const { rows: [flow] } = await query(`
        SELECT 
          COUNT(*) FILTER (WHERE initiator_id = $1) AS given,
          COUNT(*) FILTER (WHERE receiver_id = $1) AS received
        FROM pokemon_trades
        WHERE ((initiator_id = $1 AND receiver_id = $2)
           OR (initiator_id = $2 AND receiver_id = $1))
          AND status = 'completed'
          AND created_at >= NOW() - INTERVAL '30 days'
      `, [userId1, userId2]);

      const totalTrades = (flow?.given || 0) + (flow?.received || 0);
      const oneWayRatio = totalTrades > 0 
        ? Math.max(flow?.given || 0, flow?.received || 0) / totalTrades
        : 0;

      return {
        density: Math.round(density * 100) / 100,
        oneWayRatio: Math.round(oneWayRatio * 100) / 100,
        accountAgeClustering: 0, // TODO: 实现账号年龄聚集分析
        commonPartners: common
      };
    } catch (error) {
      logger.error({ error, userId1, userId2 }, '交易网络分析失败');
      return { density: 0, oneWayRatio: 0, accountAgeClustering: 0 };
    }
  }
}

// ============================================================
// 欺诈检测服务
// ============================================================

class FraudDetectionService {
  constructor() {
    this.detectors = [
      new ValueDisparityDetector(),
      new AccountAnomalyDetector(),
      new DeviceFingerprintDetector(),
      new BehavioralPatternDetector(),
      new NetworkAnomalyDetector(),
      new GroupDetectionDetector()
    ];
    
    this.valuationEngine = new PokemonValuationEngine();
  }

  /**
   * 分析交易欺诈风险
   */
  async analyze(request) {
    const timer = fraudDetectionMetrics.detectionLatency.startTimer();
    
    try {
      const scores = [];

      // 运行所有检测器
      for (const detector of this.detectors) {
        try {
          const score = await detector.detect(request);
          scores.push(score);
          
          if (score.score > 0) {
            fraudDetectionMetrics.fraudDetected.inc({
              type: score.type,
              severity: score.score > 0.7 ? 'high' : score.score > 0.4 ? 'medium' : 'low'
            });
          }
        } catch (error) {
          logger.error({ 
            error, 
            detector: detector.type,
            tradeId: request.tradeId 
          }, '检测器执行失败');
        }
      }

      // 聚合分数
      const overallScore = this.aggregateScores(scores);
      const riskLevel = this.determineRiskLevel(overallScore);

      // 记录指标
      fraudDetectionMetrics.tradesAnalyzed.inc({ risk_level: riskLevel });

      // 保存分析结果
      await this.saveAnalysis(request.tradeId, scores, overallScore, riskLevel);

      return {
        tradeId: request.tradeId,
        scores,
        overallScore: Math.round(overallScore * 100) / 100,
        riskLevel,
        recommendation: this.getRecommendation(riskLevel),
        requiredActions: this.getRequiredActions(riskLevel),
        timestamp: Date.now()
      };
    } finally {
      timer();
    }
  }

  /**
   * 聚合分数
   */
  aggregateScores(scores) {
    if (scores.length === 0) return 0;

    // 加权聚合（高风险类型权重更高）
    const weights = {
      [FraudType.VALUE_DISPARITY]: 1.0,
      [FraudType.ACCOUNT_ANOMALY]: 1.2,
      [FraudType.DEVICE_FINGERPRINT]: 1.3,
      [FraudType.BEHAVIORAL_PATTERN]: 1.1,
      [FraudType.NETWORK_ANOMALY]: 1.0,
      [FraudType.GROUP_DETECTION]: 1.4
    };

    let totalWeight = 0;
    let weightedSum = 0;

    for (const score of scores) {
      const weight = weights[score.type] || 1.0;
      weightedSum += score.score * weight;
      totalWeight += weight;
    }

    return Math.min(weightedSum / totalWeight, 1);
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(score) {
    if (score < 0.2) return RiskLevel.LOW;
    if (score < 0.5) return RiskLevel.MEDIUM;
    if (score < 0.8) return RiskLevel.HIGH;
    return RiskLevel.CRITICAL;
  }

  /**
   * 获取建议
   */
  getRecommendation(riskLevel) {
    const recommendations = {
      [RiskLevel.LOW]: '交易风险较低，可以继续',
      [RiskLevel.MEDIUM]: '交易存在一定风险，建议用户确认',
      [RiskLevel.HIGH]: '交易风险较高，需要额外验证',
      [RiskLevel.CRITICAL]: '交易风险极高，建议阻止'
    };
    return recommendations[riskLevel];
  }

  /**
   * 获取必要操作
   */
  getRequiredActions(riskLevel) {
    const actions = {
      [RiskLevel.LOW]: ['proceed'],
      [RiskLevel.MEDIUM]: ['proceed', 'send_warning', 'log_details'],
      [RiskLevel.HIGH]: ['require_confirmation', 'cool_down_period', 'notify_support'],
      [RiskLevel.CRITICAL]: ['block_trade', 'flag_accounts', 'auto_review']
    };
    return actions[riskLevel];
  }

  /**
   * 保存分析结果
   */
  async saveAnalysis(tradeId, scores, overallScore, riskLevel) {
    try {
      await query(`
        INSERT INTO trade_fraud_analysis 
          (trade_id, scores, overall_score, risk_level, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (trade_id) DO UPDATE SET
          scores = EXCLUDED.scores,
          overall_score = EXCLUDED.overall_score,
          risk_level = EXCLUDED.risk_level,
          updated_at = NOW()
      `, [tradeId, JSON.stringify(scores), overallScore, riskLevel]);
    } catch (error) {
      logger.error({ error, tradeId }, '保存分析结果失败');
    }
  }

  /**
   * 构建交易上下文
   */
  async buildTradeContext(initiatorId, receiverId) {
    const [initiatorData, receiverData] = await Promise.all([
      this.getUserTradeContext(initiatorId),
      this.getUserTradeContext(receiverId)
    ]);

    // 计算地理距离
    const geoDistance = await this.calculateGeoDistance(
      initiatorData.location,
      receiverData.location
    );

    return {
      initiatorAccountAge: initiatorData.accountAge,
      receiverAccountAge: receiverData.accountAge,
      initiatorTradeHistory: initiatorData.tradeHistory,
      receiverTradeHistory: receiverData.tradeHistory,
      initiatorLoginPattern: initiatorData.loginPattern,
      receiverLoginPattern: receiverData.loginPattern,
      initiatorDeviceFingerprint: initiatorData.deviceFingerprint,
      receiverDeviceFingerprint: receiverData.deviceFingerprint,
      initiatorIPAddress: initiatorData.ipAddress,
      receiverIPAddress: receiverData.ipAddress,
      geoDistance
    };
  }

  /**
   * 获取用户交易上下文
   */
  async getUserTradeContext(userId) {
    try {
      // 账号年龄
      const { rows: [user] } = await query(`
        SELECT 
          EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS account_age,
          created_at
        FROM users
        WHERE id = $1
      `, [userId]);

      // 交易历史
      const { rows: [trades] } = await query(`
        SELECT 
          COUNT(*)::int AS total_trades,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS trades_last_24h,
          COUNT(*) FILTER (WHERE initiator_id = $1)::int AS given_count,
          COUNT(*) FILTER (WHERE receiver_id = $1)::int AS received_count
        FROM pokemon_trades
        WHERE (initiator_id = $1 OR receiver_id = $1)
          AND status = 'completed'
      `, [userId]);

      // 最后会话信息
      const { rows: [session] } = await query(`
        SELECT ip_address, device_fingerprint, location
        FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);

      return {
        accountAge: Math.floor(user?.account_age || 0),
        tradeHistory: {
          totalTrades: trades?.total_trades || 0,
          tradesLast24h: trades?.trades_last_24h || 0,
          givenCount: trades?.given_count || 0,
          receivedCount: trades?.received_count || 0
        },
        loginPattern: {}, // TODO: 实现登录模式分析
        deviceFingerprint: session?.device_fingerprint,
        ipAddress: session?.ip_address,
        location: session?.location
      };
    } catch (error) {
      logger.error({ error, userId }, '获取用户交易上下文失败');
      return {
        accountAge: 0,
        tradeHistory: { totalTrades: 0, tradesLast24h: 0, givenCount: 0, receivedCount: 0 },
        loginPattern: {},
        deviceFingerprint: null,
        ipAddress: null,
        location: null
      };
    }
  }

  /**
   * 计算地理距离
   */
  async calculateGeoDistance(loc1, loc2) {
    if (!loc1 || !loc2) return 0;

    try {
      const { rows: [result] } = await query(`
        SELECT ST_Distance(
          ST_MakePoint($1, $2)::geography,
          ST_MakePoint($3, $4)::geography
        ) / 1000 AS distance_km
      `, [loc1.lng, loc1.lat, loc2.lng, loc2.lat]);

      return result.distance_km || 0;
    } catch (error) {
      logger.error({ error, loc1, loc2 }, '计算地理距离失败');
      return 0;
    }
  }

  /**
   * 评估交易公平性（快速接口）
   */
  async quickEvaluateFairness(offerPokemon, receivePokemon) {
    return await this.valuationEngine.evaluateTradeFairness(offerPokemon, receivePokemon);
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  FraudDetectionService,
  PokemonValuationEngine,
  RiskLevel,
  FraudType,
  // 检测器
  ValueDisparityDetector,
  AccountAnomalyDetector,
  DeviceFingerprintDetector,
  BehavioralPatternDetector,
  NetworkAnomalyDetector,
  GroupDetectionDetector
};
