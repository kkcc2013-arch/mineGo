// shared/risk-engine/risk-scorer.js - Risk Scoring Engine
'use strict';

const { query } = require('../db');
const { getRedis, getJSON, setJSON } = require('../redis');
const { createLogger } = require('../logger');
const BehaviorAnalyzer = require('./analyzers/behavior-analyzer');

const logger = createLogger('risk-engine');

// Risk levels
const RISK_LEVELS = {
  LOW: { threshold: 20, action: 'ALLOW' },
  MEDIUM: { threshold: 40, action: 'MONITOR' },
  HIGH: { threshold: 60, action: 'THROTTLE' },
  CRITICAL: { threshold: 80, action: 'BLOCK_AND_REVIEW' },
  BAN: { threshold: 100, action: 'AUTO_BAN' }
};

// Scoring weights
const WEIGHTS = {
  transaction: 0.3,
  behavior: 0.25,
  account: 0.2,
  device: 0.15,
  history: 0.1
};

class RiskScorer {
  constructor(redis) {
    this.redis = redis || getRedis();
    this.behaviorAnalyzer = new BehaviorAnalyzer(this.redis);
    this.rules = new Map();
  }

  /**
   * Calculate comprehensive risk score (0-100)
   */
  async calculateRiskScore(userId, context = {}) {
    const scores = {
      transaction: await this.evalTransactionRisk(userId, context),
      behavior: await this.evalBehaviorRisk(userId, context),
      account: await this.evalAccountRisk(userId),
      device: await this.evalDeviceRisk(userId, context.deviceId),
      history: await this.evalHistoryRisk(userId)
    };

    let totalScore = 0;
    for (const [key, score] of Object.entries(scores)) {
      totalScore += score * WEIGHTS[key];
    }

    const result = {
      score: Math.round(totalScore),
      breakdown: scores,
      level: this.getRiskLevel(totalScore),
      recommendedAction: this.getRecommendedAction(totalScore),
      timestamp: Date.now()
    };

    // Cache the score
    const cacheKey = `risk:score:${userId}`;
    await setJSON(cacheKey, result, 300); // 5 minute cache

    // Record to history
    await this.recordScoreHistory(userId, result);

    return result;
  }

  /**
   * Evaluate transaction-based risk
   */
  async evalTransactionRisk(userId, context) {
    let score = 0;

    // Check recent transaction volume
    const recentTransactions = await this.getRecentTransactionVolume(userId);
    
    // High frequency
    if (recentTransactions.count > 50 && recentTransactions.window < 3600) {
      score += 30;
    }

    // Large amount anomaly
    if (context.amount && recentTransactions.avgAmount) {
      if (context.amount > recentTransactions.avgAmount * 10) {
        score += 40;
      }
    }

    // New account with high activity
    const accountAge = await this.getAccountAge(userId);
    if (accountAge < 7 * 24 * 3600 && recentTransactions.totalValue > 10000) {
      score += 45;
    }

    return Math.min(score, 100);
  }

  /**
   * Evaluate behavior-based risk
   */
  async evalBehaviorRisk(userId, context) {
    const analysis = await this.behaviorAnalyzer.analyzeTradePattern(userId);
    let score = 0;

    if (analysis.anomalyCount > 0) {
      score += analysis.anomalyCount * 15;
    }

    // Time distribution anomaly
    if (analysis.patterns.timeDistributionAnomaly?.isAnomaly) {
      score += 25;
    }

    // Counterparty concentration
    if (analysis.patterns.counterpartyConcentration?.isAnomaly) {
      score += 20;
    }

    return Math.min(score, 100);
  }

  /**
   * Evaluate account-based risk
   */
  async evalAccountRisk(userId) {
    let score = 0;

    const { rows } = await query(`
      SELECT 
        u.created_at,
        u.premium_coins,
        u.level,
        COUNT(o.id) as order_count,
        COUNT(r.id) as report_count
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'PAID'
      LEFT JOIN user_reports r ON r.reported_user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [userId]);

    if (!rows.length) return 0;

    const account = rows[0];
    const ageHours = (Date.now() - new Date(account.created_at)) / 3600000;

    // Very new account
    if (ageHours < 24) {
      score += 15;
    }

    // High coins but low level
    if (account.premium_coins > 5000 && account.level < 5) {
      score += 30;
    }

    // Reports against user
    if (account.report_count > 3) {
      score += account.report_count * 10;
    }

    return Math.min(score, 100);
  }

  /**
   * Evaluate device-based risk
   */
  async evalDeviceRisk(userId, deviceId) {
    if (!deviceId) return 0;

    let score = 0;
    const key = `risk:device:${deviceId}`;

    // Check accounts on same device
    const deviceAccounts = await this.redis.smembers(key);
    
    if (deviceAccounts.length > 3) {
      score += 50;
    } else if (deviceAccounts.length > 1) {
      score += 20;
    }

    // Add this user to device set
    await this.redis.sadd(key, userId.toString());
    await this.redis.expire(key, 86400 * 30); // 30 days

    return Math.min(score, 100);
  }

  /**
   * Evaluate history-based risk
   */
  async evalHistoryRisk(userId) {
    const { rows } = await query(`
      SELECT 
        COUNT(*) as event_count,
        MAX(score) as max_score,
        AVG(score) as avg_score
      FROM risk_score_history
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    `, [userId]);

    if (!rows.length || rows[0].event_count === 0) return 0;

    const history = rows[0];
    let score = 0;

    // Historical high scores
    if (history.max_score > 60) {
      score += 20;
    }

    // Elevated average
    if (history.avg_score > 40) {
      score += 15;
    }

    // Frequent events
    if (history.event_count > 10) {
      score += 10;
    }

    return Math.min(score, 100);
  }

  getRiskLevel(score) {
    if (score < 20) return 'LOW';
    if (score < 40) return 'MEDIUM';
    if (score < 60) return 'HIGH';
    if (score < 80) return 'CRITICAL';
    return 'BAN';
  }

  getRecommendedAction(score) {
    if (score < 20) return 'ALLOW';
    if (score < 40) return 'MONITOR';
    if (score < 60) return 'THROTTLE';
    if (score < 80) return 'BLOCK_AND_REVIEW';
    return 'AUTO_BAN';
  }

  async getRecentTransactionVolume(userId) {
    const { rows } = await query(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(amount_fen), 0) as total_value,
        COALESCE(AVG(amount_fen), 0) as avg_amount,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) as window
      FROM orders
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
    `, [userId]);

    return rows[0] || { count: 0, total_value: 0, avg_amount: 0, window: 0 };
  }

  async getAccountAge(userId) {
    const { rows } = await query(`
      SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) as age
      FROM users WHERE id = $1
    `, [userId]);

    return rows[0]?.age || 0;
  }

  async recordScoreHistory(userId, result) {
    await query(`
      INSERT INTO risk_score_history 
        (user_id, score, level, breakdown, trigger_action, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, result.score, result.level, JSON.stringify(result.breakdown), result.recommendedAction]);
  }
}

module.exports = RiskScorer;