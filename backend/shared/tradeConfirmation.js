// shared/tradeConfirmation.js - 交易确认与保护机制
'use strict';

const { query, transaction } = require('./db');
const { getRedis, setRedis, delRedis } = require('./redis');
const { createLogger } = require('./logger');
const notificationService = require('./notification/pushNotificationService');
const { RiskLevel } = require('./tradeFraudDetection');

const logger = createLogger('trade-confirmation');

// ============================================================
// 配置常量
// ============================================================

const CONFIG = {
  COOL_DOWN_DURATION: {
    [RiskLevel.MEDIUM]: 5 * 60 * 1000,    // 5 分钟
    [RiskLevel.HIGH]: 30 * 60 * 1000,      // 30 分钟
    [RiskLevel.CRITICAL]: 24 * 60 * 60 * 1000  // 24 小时
  },
  
  CONFIRMATION_TOKEN_EXPIRY: 3600,  // 1 小时
  ROLLBACK_WINDOW: 24 * 60 * 60 * 1000,  // 24 小时
  
  VALUE_WARNING_THRESHOLDS: {
    SAFE_RATIO_MIN: 0.7,
    SAFE_RATIO_MAX: 1.4,
    WARNING_RATIO_MIN: 0.4,
    WARNING_RATIO_MAX: 2.5
  }
};

// ============================================================
// 交易确认服务
// ============================================================

class TradeConfirmationService {
  /**
   * 处理高风险交易确认
   */
  async confirmHighRiskTrade(tradeId, userId, riskAnalysis) {
    const { riskLevel, scores } = riskAnalysis;

    // 应用冷却期
    if (riskLevel === RiskLevel.HIGH || riskLevel === RiskLevel.CRITICAL) {
      const coolDownDuration = CONFIG.COOL_DOWN_DURATION[riskLevel];
      await this.enforceCoolDown(userId, coolDownDuration);
      
      logger.info({
        tradeId,
        userId,
        riskLevel,
        coolDownDuration
      }, '应用交易冷却期');
    }

    // 生成确认令牌
    const confirmationToken = await this.generateConfirmationToken(tradeId, userId);

    // 发送确认通知
    await notificationService.send({
      userId,
      type: 'trade_confirmation_required',
      title: '交易确认',
      body: '您有一笔交易需要额外确认',
      data: {
        tradeId,
        riskLevel,
        warnings: scores.flatMap(s => s.indicators),
        confirmationToken,
        expiresIn: CONFIG.CONFIRMATION_TOKEN_EXPIRY
      }
    });

    return {
      status: 'pending_confirmation',
      confirmationToken,
      expiresIn: CONFIG.CONFIRMATION_TOKEN_EXPIRY,
      coolDownApplied: riskLevel === RiskLevel.HIGH || riskLevel === RiskLevel.CRITICAL
    };
  }

  /**
   * 应用冷却期
   */
  async enforceCoolDown(userId, durationMs) {
    const coolDownKey = `trade_cooldown:${userId}`;
    const existingCoolDown = await getRedis(coolDownKey);

    if (existingCoolDown) {
      const remainingTime = parseInt(existingCoolDown) - Date.now();
      if (remainingTime > 0) {
        throw new Error(`冷却期未结束，剩余 ${Math.ceil(remainingTime / 60000)} 分钟`);
      }
    }

    // 设置冷却期
    const expireAt = Date.now() + durationMs;
    await setRedis(coolDownKey, expireAt.toString(), Math.ceil(durationMs / 1000));

    logger.info({ userId, durationMs }, '冷却期已应用');
  }

  /**
   * 检查冷却期
   */
  async checkCoolDown(userId) {
    const coolDownKey = `trade_cooldown:${userId}`;
    const expireAt = await getRedis(coolDownKey);

    if (!expireAt) {
      return { inCoolDown: false };
    }

    const remainingMs = parseInt(expireAt) - Date.now();
    if (remainingMs <= 0) {
      await delRedis(coolDownKey);
      return { inCoolDown: false };
    }

    return {
      inCoolDown: true,
      remainingMs,
      remainingMinutes: Math.ceil(remainingMs / 60000)
    };
  }

  /**
   * 生成确认令牌
   */
  async generateConfirmationToken(tradeId, userId) {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    
    const tokenData = {
      tradeId,
      userId,
      createdAt: Date.now()
    };

    // 存储 token
    const tokenKey = `trade_confirmation_token:${token}`;
    await setRedis(tokenKey, JSON.stringify(tokenData), CONFIG.CONFIRMATION_TOKEN_EXPIRY);

    return token;
  }

  /**
   * 验证确认令牌
   */
  async verifyConfirmationToken(token, userId) {
    const tokenKey = `trade_confirmation_token:${token}`;
    const tokenDataStr = await getRedis(tokenKey);

    if (!tokenDataStr) {
      return { valid: false, reason: 'token_expired' };
    }

    const tokenData = JSON.parse(tokenDataStr);

    if (tokenData.userId !== userId) {
      return { valid: false, reason: 'user_mismatch' };
    }

    // 删除 token（一次性使用）
    await delRedis(tokenKey);

    return {
      valid: true,
      tradeId: tokenData.tradeId
    };
  }

  /**
   * 显示价值警告
   */
  async showValueWarning(userId, trade, valuation) {
    if (valuation.risk === RiskLevel.LOW) {
      return { show: false };
    }

    const warning = {
      type: 'value_disparity_warning',
      message: this.getWarningMessage(valuation),
      details: {
        yourPokemonValue: valuation.offerValue,
        theirPokemonValue: valuation.receiveValue,
        ratio: valuation.ratio,
        difference: valuation.difference
      },
      acknowledged: false,
      requireAcknowledgment: valuation.risk === RiskLevel.HIGH
    };

    // 记录警告
    await this.logValueWarning(userId, trade.id, warning);

    return {
      show: true,
      warning
    };
  }

  /**
   * 获取警告消息
   */
  getWarningMessage(valuation) {
    const { ratio, offerValue, receiveValue } = valuation;

    if (ratio < 0.1 || ratio > 10) {
      return `⚠️ 严重警告：您的精灵价值（${offerValue}）与对方精灵价值（${receiveValue}）差异极大。这可能是欺诈行为，请务必谨慎！`;
    }

    if (ratio < 0.3 || ratio > 3) {
      return `⚠️ 警告：交易价值存在较大差异（${offerValue} vs ${receiveValue}）。请确认您了解此交易的内容。`;
    }

    return `ℹ️ 提示：交易价值有一定差异（${offerValue} vs ${receiveValue}）。`;
  }

  /**
   * 记录价值警告
   */
  async logValueWarning(userId, tradeId, warning) {
    try {
      await query(`
        INSERT INTO trade_value_warnings 
          (trade_id, user_id, warning_data, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [tradeId, userId, JSON.stringify(warning)]);
    } catch (error) {
      logger.error({ error, userId, tradeId }, '记录价值警告失败');
    }
  }

  /**
   * 确认价值警告
   */
  async acknowledgeValueWarning(userId, tradeId) {
    try {
      await query(`
        UPDATE trade_value_warnings
        SET acknowledged = true, acknowledged_at = NOW()
        WHERE trade_id = $1 AND user_id = $2
      `, [tradeId, userId]);

      logger.info({ userId, tradeId }, '价值警告已确认');
    } catch (error) {
      logger.error({ error, userId, tradeId }, '确认价值警告失败');
    }
  }
}

// ============================================================
// 交易回滚服务
// ============================================================

class TradeRollbackService {
  constructor() {
    this.rollbackWindow = CONFIG.ROLLBACK_WINDOW;
  }

  /**
   * 回滚交易
   */
  async rollback(tradeId, reason) {
    const trade = await this.getTrade(tradeId);

    if (!trade) {
      throw new Error('交易不存在');
    }

    if (Date.now() - new Date(trade.created_at).getTime() > this.rollbackWindow) {
      throw new Error('回滚窗口已过期');
    }

    if (trade.status !== 'completed') {
      throw new Error('只能回滚已完成的交易');
    }

    // 开始事务
    return await transaction(async (client) => {
      // 1. 返还精灵给发起方
      for (const pokemon of trade.receiver_offer) {
        await client.query(`
          UPDATE pokemon_instances
          SET user_id = $1, updated_at = NOW()
          WHERE id = $2
        `, [trade.initiator_id, pokemon.id]);
      }

      // 2. 返还精灵给接收方
      for (const pokemon of trade.initiator_offer) {
        await client.query(`
          UPDATE pokemon_instances
          SET user_id = $1, updated_at = NOW()
          WHERE id = $2
        `, [trade.receiver_id, pokemon.id]);
      }

      // 3. 更新交易状态
      await client.query(`
        UPDATE pokemon_trades
        SET status = 'rolled_back', rolled_back_at = NOW(), rollback_reason = $1
        WHERE id = $2
      `, [reason, tradeId]);

      // 4. 记录回滚日志
      await client.query(`
        INSERT INTO trade_rollbacks 
          (trade_id, initiator_id, receiver_id, reason, rolled_back_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [tradeId, trade.initiator_id, trade.receiver_id, reason]);

      // 5. 记录审计日志
      await client.query(`
        INSERT INTO audit_log 
          (action, entity_type, entity_id, details, created_at)
        VALUES ('trade_rollback', 'pokemon_trades', $1, $2, NOW())
      `, [tradeId, JSON.stringify({
        reason,
        initiatorId: trade.initiator_id,
        receiverId: trade.receiver_id,
        initiatorOffer: trade.initiator_offer,
        receiverOffer: trade.receiver_offer
      })]);

      logger.info({
        tradeId,
        reason,
        initiatorId: trade.initiator_id,
        receiverId: trade.receiver_id
      }, '交易已回滚');

      return {
        success: true,
        tradeId,
        rolledBackAt: new Date().toISOString()
      };
    });
  }

  /**
   * 获取交易详情
   */
  async getTrade(tradeId) {
    const { rows: [trade] } = await query(`
      SELECT 
        pt.*,
        array_agg(json_build_object(
          'id', pi1.id,
          'species_id', pi1.species_id,
          'cp', pi1.cp
        )) FILTER (WHERE pi1.id IS NOT NULL) AS initiator_offer,
        array_agg(json_build_object(
          'id', pi2.id,
          'species_id', pi2.species_id,
          'cp', pi2.cp
        )) FILTER (WHERE pi2.id IS NOT NULL) AS receiver_offer
      FROM pokemon_trades pt
      LEFT JOIN pokemon_instances pi1 ON pi1.id = pt.offered_pokemon
      LEFT JOIN pokemon_instances pi2 ON pi2.id = pt.received_pokemon
      WHERE pt.id = $1
      GROUP BY pt.id
    `, [tradeId]);

    return trade;
  }

  /**
   * 检查是否可以回滚
   */
  async canRollback(tradeId) {
    const trade = await this.getTrade(tradeId);

    if (!trade) {
      return { canRollback: false, reason: '交易不存在' };
    }

    const tradeTime = new Date(trade.created_at).getTime();
    const elapsed = Date.now() - tradeTime;

    if (elapsed > this.rollbackWindow) {
      return { canRollback: false, reason: '回滚窗口已过期' };
    }

    if (trade.status !== 'completed') {
      return { canRollback: false, reason: '只能回滚已完成的交易' };
    }

    return {
      canRollback: true,
      remainingTime: this.rollbackWindow - elapsed
    };
  }

  /**
   * 通知交易双方
   */
  async notifyRollback(initiatorId, receiverId, reason) {
    // 通知发起方
    await notificationService.send({
      userId: initiatorId,
      type: 'trade_rollback',
      title: '交易已回滚',
      body: '您的交易已被系统回滚，精灵已返还',
      data: { reason }
    });

    // 通知接收方
    await notificationService.send({
      userId: receiverId,
      type: 'trade_rollback',
      title: '交易已回滚',
      body: '您的交易已被系统回滚，精灵已返还',
      data: { reason }
    });
  }
}

// ============================================================
// 交易审计服务
// ============================================================

class TradeAuditService {
  /**
   * 记录交易事件
   */
  async logTradeEvent(event) {
    const auditRecord = {
      trade_id: event.tradeId,
      timestamp: Date.now(),
      event_type: event.type,

      // 交易双方信息
      initiator: {
        id: event.initiatorId,
        ip: event.initiatorIP,
        device: event.initiatorDevice,
        geo: event.initiatorGeo
      },
      receiver: {
        id: event.receiverId,
        ip: event.receiverIP,
        device: event.receiverDevice,
        geo: event.receiverGeo
      },

      // 交易内容
      trade_content: {
        initiator_offer: event.initiatorOffer,
        receiver_offer: event.receiverOffer
      },

      // 风险评估
      risk_analysis: event.riskAnalysis,

      // 系统信息
      server_node: process.env.HOSTNAME || 'unknown',
      trace_id: event.traceId
    };

    try {
      await query(`
        INSERT INTO trade_audit_log 
          (trade_id, event_type, audit_data, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [event.tradeId, event.type, JSON.stringify(auditRecord)]);
    } catch (error) {
      logger.error({ error, event }, '记录交易审计日志失败');
    }
  }

  /**
   * 生成异常交易报表
   */
  async generateAnomalyReport(timeRange) {
    const { start, end } = timeRange;

    // 查询高风险交易
    const { rows: anomalies } = await query(`
      SELECT 
        tfa.*,
        pt.initiator_id,
        pt.receiver_id,
        pt.status
      FROM trade_fraud_analysis tfa
      JOIN pokemon_trades pt ON pt.id = tfa.trade_id
      WHERE tfa.created_at >= $1
        AND tfa.created_at <= $2
        AND tfa.risk_level IN ('high', 'critical')
      ORDER BY tfa.overall_score DESC
    `, [start, end]);

    // 按类型分组
    const byType = {};
    const byRiskLevel = { high: 0, critical: 0 };

    for (const anomaly of anomalies) {
      const scores = anomaly.scores;
      byRiskLevel[anomaly.risk_level]++;

      for (const score of scores) {
        if (!byType[score.type]) {
          byType[score.type] = 0;
        }
        byType[score.type]++;
      }
    }

    return {
      totalAnomalies: anomalies.length,
      byType,
      byRiskLevel,
      anomalies: anomalies.slice(0, 100), // 返回前 100 条
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 获取用户交易历史
   */
  async getUserTradeHistory(userId, limit = 50) {
    const { rows } = await query(`
      SELECT 
        pt.*,
        tfa.risk_level,
        tfa.overall_score
      FROM pokemon_trades pt
      LEFT JOIN trade_fraud_analysis tfa ON tfa.trade_id = pt.id
      WHERE pt.initiator_id = $1 OR pt.receiver_id = $1
      ORDER BY pt.created_at DESC
      LIMIT $2
    `, [userId, limit]);

    return rows;
  }
}

// ============================================================
// 团伙检测服务
// ============================================================

class FraudRingDetector {
  /**
   * 分析交易网络
   */
  async analyzeTradeNetwork() {
    // 构建交易图谱
    const graph = await this.buildTradeGraph();

    // 检测异常聚集
    const clusters = await this.detectAnomalousClusters(graph);

    // 分析团伙特征
    const rings = [];

    for (const cluster of clusters) {
      const ring = await this.analyzeCluster(cluster);
      if (ring.suspicionScore > 0.7) {
        rings.push(ring);
      }
    }

    return {
      totalClusters: clusters.length,
      suspiciousRings: rings,
      recommendations: this.generateRingRecommendations(rings)
    };
  }

  /**
   * 构建交易图谱
   */
  async buildTradeGraph() {
    const { rows: trades } = await query(`
      SELECT 
        initiator_id,
        receiver_id,
        COUNT(*) AS trade_count,
        MAX(created_at) AS last_trade
      FROM pokemon_trades
      WHERE status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY initiator_id, receiver_id
    `);

    // 构建邻接表
    const graph = new Map();

    for (const trade of trades) {
      if (!graph.has(trade.initiator_id)) {
        graph.set(trade.initiator_id, new Map());
      }
      if (!graph.has(trade.receiver_id)) {
        graph.set(trade.receiver_id, new Map());
      }

      graph.get(trade.initiator_id).set(trade.receiver_id, {
        count: trade.trade_count,
        lastTrade: trade.last_trade
      });
      graph.get(trade.receiver_id).set(trade.initiator_id, {
        count: trade.trade_count,
        lastTrade: trade.last_trade
      });
    }

    return graph;
  }

  /**
   * 检测异常聚集
   */
  async detectAnomalousClusters(graph) {
    const visited = new Set();
    const clusters = [];

    for (const [userId] of graph) {
      if (visited.has(userId)) continue;

      // BFS 找到连通分量
      const cluster = this.findCluster(userId, graph, visited);
      
      if (cluster.members.length >= 3) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * 查找聚集
   */
  findCluster(startUserId, graph, visited) {
    const members = [];
    const trades = [];
    const queue = [startUserId];

    while (queue.length > 0) {
      const userId = queue.shift();
      if (visited.has(userId)) continue;

      visited.add(userId);
      members.push({ id: userId });

      const neighbors = graph.get(userId);
      if (neighbors) {
        for (const [neighborId, data] of neighbors) {
          if (!visited.has(neighborId)) {
            queue.push(neighborId);
          }
          trades.push({
            from: userId,
            to: neighborId,
            count: data.count
          });
        }
      }
    }

    return { members, trades };
  }

  /**
   * 分析聚集特征
   */
  async analyzeCluster(cluster) {
    const { members, trades } = cluster;

    // 精灵流向集中度
    const pokemonFlowConcentration = this.calculateFlowConcentration(trades);

    // 时间聚集度
    const timeClustering = this.calculateTimeClustering(trades);

    // 账号创建时间聚集度
    const accountAgeClustering = await this.calculateAccountAgeClustering(members);

    // 设备/IP 重叠度
    const deviceOverlap = await this.calculateDeviceOverlap(members);

    // 单向交易比例
    const oneWayTradeRatio = this.calculateOneWayRatio(trades);

    // 计算嫌疑分数
    const suspicionScore = this.calculateSuspicionScore({
      pokemonFlowConcentration,
      timeClustering,
      accountAgeClustering,
      deviceOverlap,
      oneWayTradeRatio
    });

    return {
      id: `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      members: members.map(m => m.id),
      characteristics: {
        pokemonFlowConcentration,
        timeClustering,
        accountAgeClustering,
        deviceOverlap,
        oneWayTradeRatio
      },
      suspicionScore,
      riskLevel: suspicionScore > 0.9 ? 'critical' : suspicionScore > 0.7 ? 'high' : 'medium'
    };
  }

  /**
   * 计算精灵流向集中度
   */
  calculateFlowConcentration(trades) {
    if (trades.length === 0) return 0;

    // 计算交易量的基尼系数
    const volumes = trades.map(t => t.count);
    const sorted = volumes.sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);

    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sorted[i];
    }

    return giniSum / (n * sum);
  }

  /**
   * 计算时间聚集度
   */
  calculateTimeClustering(trades) {
    // 简化：检查交易是否集中在短时间内
    if (trades.length < 2) return 0;

    const timestamps = trades.map(t => new Date(t.lastTrade).getTime());
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);

    // 如果所有交易在 24 小时内
    if (max - min < 24 * 60 * 60 * 1000) {
      return 0.8;
    }

    // 如果在 7 天内
    if (max - min < 7 * 24 * 60 * 60 * 1000) {
      return 0.5;
    }

    return 0.2;
  }

  /**
   * 计算账号年龄聚集度
   */
  async calculateAccountAgeClustering(members) {
    if (members.length === 0) return 0;

    try {
      const userIds = members.map(m => m.id);
      const { rows } = await query(`
        SELECT 
          STDDEV(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS std_dev,
          AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS avg_age
        FROM users
        WHERE id = ANY($1)
      `, [userIds]);

      const stdDev = parseFloat(rows[0]?.std_dev || 0);
      const avgAge = parseFloat(rows[0]?.avg_age || 0);

      // 标准差越小，聚集度越高
      if (avgAge === 0) return 0;
      return Math.max(0, 1 - (stdDev / avgAge));
    } catch (error) {
      logger.error({ error }, '计算账号年龄聚集度失败');
      return 0;
    }
  }

  /**
   * 计算设备重叠度
   */
  async calculateDeviceOverlap(members) {
    if (members.length < 2) return 0;

    try {
      const userIds = members.map(m => m.id);
      const { rows } = await query(`
        SELECT 
          COUNT(DISTINCT us.device_fingerprint) AS unique_devices,
          COUNT(DISTINCT u.id) AS total_users
        FROM users u
        JOIN user_sessions us ON us.user_id = u.id
        WHERE u.id = ANY($1)
          AND us.created_at >= NOW() - INTERVAL '30 days'
      `, [userIds]);

      const uniqueDevices = parseInt(rows[0]?.unique_devices || 0);
      const totalUsers = parseInt(rows[0]?.total_users || 0);

      // 设备数少于用户数，说明有设备重叠
      if (totalUsers === 0) return 0;
      return Math.max(0, (totalUsers - uniqueDevices) / totalUsers);
    } catch (error) {
      logger.error({ error }, '计算设备重叠度失败');
      return 0;
    }
  }

  /**
   * 计算单向交易比例
   */
  calculateOneWayRatio(trades) {
    if (trades.length === 0) return 0;

    // 统计每对用户的交易次数
    const pairCounts = new Map();

    for (const trade of trades) {
      const key = [trade.from, trade.to].sort().join('-');
      pairCounts.set(key, (pairCounts.get(key) || 0) + trade.count);
    }

    // 计算单向比例
    let oneWayCount = 0;
    let totalPairs = 0;

    for (const [key, count] of pairCounts) {
      totalPairs++;
      if (count >= 5) {  // 单方向交易 5 次以上
        oneWayCount++;
      }
    }

    return totalPairs > 0 ? oneWayCount / totalPairs : 0;
  }

  /**
   * 计算嫌疑分数
   */
  calculateSuspicionScore(characteristics) {
    const weights = {
      pokemonFlowConcentration: 0.2,
      timeClustering: 0.2,
      accountAgeClustering: 0.2,
      deviceOverlap: 0.25,
      oneWayTradeRatio: 0.15
    };

    let score = 0;
    for (const [key, weight] of Object.entries(weights)) {
      score += (characteristics[key] || 0) * weight;
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * 生成团伙处理建议
   */
  generateRingRecommendations(rings) {
    const recommendations = [];

    for (const ring of rings) {
      recommendations.push({
        ringId: ring.id,
        riskLevel: ring.riskLevel,
        actions: ring.riskLevel === 'critical' 
          ? ['立即封禁', '冻结资产', '人工审核']
          : ['密切监控', '限制交易', '标记账户']
      });
    }

    return recommendations;
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  TradeConfirmationService,
  TradeRollbackService,
  TradeAuditService,
  FraudRingDetector,
  CONFIG
};
