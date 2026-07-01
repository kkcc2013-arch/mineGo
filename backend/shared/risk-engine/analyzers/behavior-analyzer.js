// shared/risk-engine/analyzers/behavior-analyzer.js - Behavior Pattern Analyzer
'use strict';

const { createLogger } = require('../../logger');
const { getRedis, getJSON, setJSON } = require('../../redis');

const logger = createLogger('behavior-analyzer');

class BehaviorAnalyzer {
  constructor(redis) {
    this.redis = redis || getRedis();
  }

  /**
   * Analyze trade behavior pattern for a user
   */
  async analyzeTradePattern(userId) {
    const patterns = {
      timeDistributionAnomaly: await this.checkTimeDistribution(userId),
      counterpartyConcentration: await this.checkCounterpartyConcentration(userId),
      amountPattern: await this.checkAmountPattern(userId),
      frequencySpike: await this.checkFrequencySpike(userId),
      flowDirectionBias: await this.checkFlowDirectionBias(userId)
    };

    return {
      patterns,
      anomalyCount: Object.values(patterns).filter(p => p.isAnomaly).length,
      details: this.generatePatternReport(patterns)
    };
  }

  /**
   * Check time distribution anomaly (bot behavior)
   */
  async checkTimeDistribution(userId) {
    const hourlyKey = `risk:trade:hourly:${userId}`;
    const hourlyCounts = await this.redis.hgetall(hourlyKey);

    const counts = Object.values(hourlyCounts).map(Number);
    if (counts.length >= 20) {
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / counts.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev < avg * 0.1 && avg > 5) {
        return {
          isAnomaly: true,
          reason: '交易时间分布过于均匀，疑似脚本行为',
          confidence: 0.85
        };
      }
    }

    return { isAnomaly: false };
  }

  /**
   * Check counterparty concentration
   */
  async checkCounterpartyConcentration(userId) {
    const key = `risk:counterparty:${userId}`;
    const counterparties = await this.redis.hgetall(key);

    if (!Object.keys(counterparties).length) {
      return { isAnomaly: false };
    }

    const totalTrades = Object.values(counterparties)
      .reduce((sum, count) => sum + parseInt(count, 10), 0);

    if (totalTrades < 5) return { isAnomaly: false };

    const maxCount = Math.max(...Object.values(counterparties).map(Number));
    const maxRatio = maxCount / totalTrades;

    if (maxRatio > 0.6) {
      const topCounterparty = Object.entries(counterparties)
        .sort(([, a], [, b]) => Number(b) - Number(a))[0][0];

      return {
        isAnomaly: true,
        reason: `交易对象过于集中，${(maxRatio * 100).toFixed(1)}%的交易与同一用户`,
        topCounterparty,
        ratio: maxRatio
      };
    }

    return { isAnomaly: false };
  }

  /**
   * Check amount pattern (round numbers = script)
   */
  async checkAmountPattern(userId) {
    const key = `risk:amounts:${userId}`;
    const amounts = await this.redis.lrange(key, 0, 49);

    if (amounts.length < 10) return { isAnomaly: false };

    const values = amounts.map(Number);
    const roundCount = values.filter(v => v % 100 === 0).length;
    const roundRatio = roundCount / values.length;

    if (roundRatio > 0.8) {
      return {
        isAnomaly: true,
        reason: '交易金额多为整数，疑似脚本行为',
        roundRatio
      };
    }

    return { isAnomaly: false };
  }

  /**
   * Check frequency spike
   */
  async checkFrequencySpike(userId) {
    const key = `risk:frequency:${userId}`;
    const data = await getJSON(key);

    if (!data) return { isAnomaly: false };

    const { currentRate, avgRate } = data;

    if (currentRate > avgRate * 5 && currentRate > 10) {
      return {
        isAnomaly: true,
        reason: '交易频率突增，超过历史平均5倍',
        currentRate,
        avgRate
      };
    }

    return { isAnomaly: false };
  }

  /**
   * Check flow direction bias
   */
  async checkFlowDirectionBias(userId) {
    const key = `risk:flow:${userId}`;
    const data = await getJSON(key);

    if (!data) return { isAnomaly: false };

    const { inflow, outflow } = data;
    const total = inflow + outflow;

    if (total < 5) return { isAnomaly: false };

    const inflowRatio = inflow / total;
    const outflowRatio = outflow / total;

    if (inflowRatio > 0.9) {
      return {
        isAnomaly: true,
        reason: '资产几乎只进不出，疑似刷取账号',
        inflowRatio
      };
    }

    if (outflowRatio > 0.9) {
      return {
        isAnomaly: true,
        reason: '资产几乎只出不进，疑似洗号账号',
        outflowRatio
      };
    }

    return { isAnomaly: false };
  }

  /**
   * Record a trade event for analysis
   */
  async recordTradeEvent(userId, event) {
    const now = new Date();
    const hour = now.getHours();

    // Update hourly distribution
    const hourlyKey = `risk:trade:hourly:${userId}`;
    await this.redis.hincrby(hourlyKey, hour.toString(), 1);
    await this.redis.expire(hourlyKey, 86400);

    // Update counterparty tracking
    if (event.counterpartyId) {
      const counterKey = `risk:counterparty:${userId}`;
      await this.redis.hincrby(counterKey, event.counterpartyId, 1);
      await this.redis.expire(counterKey, 86400);
    }

    // Update amount tracking
    if (event.amount) {
      const amountKey = `risk:amounts:${userId}`;
      await this.redis.lpush(amountKey, event.amount);
      await this.redis.ltrim(amountKey, 0, 49);
      await this.redis.expire(amountKey, 86400);
    }

    // Update flow direction
    if (event.direction) {
      const flowKey = `risk:flow:${userId}`;
      const flowData = (await getJSON(flowKey)) || { inflow: 0, outflow: 0 };

      if (event.direction === 'in') flowData.inflow++;
      else flowData.outflow++;

      await setJSON(flowKey, flowData, 86400);
    }
  }

  generatePatternReport(patterns) {
    const anomalies = Object.entries(patterns)
      .filter(([, v]) => v.isAnomaly)
      .map(([key, v]) => ({ pattern: key, reason: v.reason }));

    return {
      totalChecks: Object.keys(patterns).length,
      anomalyCount: anomalies.length,
      anomalies
    };
  }
}

module.exports = BehaviorAnalyzer;