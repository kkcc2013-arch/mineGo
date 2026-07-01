// gateway/src/middleware/risk-control.js - Risk Control Middleware
'use strict';

const { createLogger } = require('../../shared/logger');
const { getRedis, getJSON, setJSON } = require('../../shared/redis');
const RiskScorer = require('../../shared/risk-engine/risk-scorer');
const {
  evaluateTransactionRules,
  evaluateRewardRules,
  evaluatePaymentRules
} = require('../../shared/risk-engine/rules/transaction-rules');

const logger = createLogger('risk-control');

// Action type configurations
const ACTION_CONFIGS = {
  'trade:create': { threshold: 40, action: 'block' },
  'trade:complete': { threshold: 50, action: 'block' },
  'trade:cancel': { threshold: 60, action: 'block' },
  'reward:claim': { threshold: 35, action: 'throttle' },
  'payment:initiate': { threshold: 60, action: 'block_and_review' },
  'payment:verify': { threshold: 70, action: 'block_and_review' },
  'item:transfer': { threshold: 45, action: 'block' },
  'pokemon:trade': { threshold: 50, action: 'block' },
  'pokemon:release': { threshold: 55, action: 'throttle' },
  'currency:transfer': { threshold: 50, action: 'block' }
};

class RiskControlMiddleware {
  constructor() {
    this.redis = getRedis();
    this.riskScorer = new RiskScorer(this.redis);
  }

  /**
   * Get middleware for specific action type
   */
  forAction(actionType) {
    return async (req, res, next) => {
      return this.handle(req, res, next, actionType);
    };
  }

  /**
   * Main handler
   */
  async handle(req, res, next, actionType) {
    const userId = req.user?.sub;
    if (!userId) {
      return next(); // No auth, let other middleware handle
    }

    const config = ACTION_CONFIGS[actionType];
    if (!config) {
      logger.warn({ actionType }, 'Unknown action type for risk control');
      return next();
    }

    const startTime = Date.now();

    try {
      // Get cached or compute risk score
      const cacheKey = `risk:score:${userId}`;
      let riskData = await getJSON(cacheKey);

      if (!riskData) {
        riskData = await this.riskScorer.calculateRiskScore(userId, {
          actionType,
          ...req.body
        });
      }

      // Build context for rule evaluation
      const context = await this.buildRuleContext(userId, actionType, req.body);

      // Evaluate rules
      let triggeredRules = [];
      if (actionType.startsWith('trade:')) {
        triggeredRules = evaluateTransactionRules(context);
      } else if (actionType.startsWith('reward:')) {
        triggeredRules = evaluateRewardRules(context);
      } else if (actionType.startsWith('payment:')) {
        triggeredRules = evaluatePaymentRules(context);
      }

      // Add triggered rules to score
      let totalScore = riskData.score;
      for (const rule of triggeredRules) {
        totalScore += rule.score * 0.5; // Weight rules lower than base score
      }
      totalScore = Math.min(totalScore, 100);

      // Log the check
      await this.logRiskCheck(userId, actionType, {
        score: totalScore,
        level: riskData.level,
        rules: triggeredRules.map(r => r.name)
      });

      // Add risk info to request
      req.riskData = {
        score: totalScore,
        level: riskData.level,
        triggeredRules,
        checkedAt: startTime
      };

      // Track metrics
      this.trackMetrics(actionType, totalScore);

      // Execute action based on score and config
      if (totalScore >= config.threshold) {
        return this.executeAction(req, res, {
          action: config.action,
          score: totalScore,
          rules: triggeredRules,
          actionType
        });
      }

      // Add monitoring for elevated risk
      if (totalScore >= 20) {
        res.setHeader('X-Risk-Level', riskData.level);
        await this.addToWatchlist(userId, {
          score: totalScore,
          level: riskData.level,
          lastAction: actionType
        });
      }

      next();

    } catch (err) {
      logger.error({ err, actionType, userId }, 'Risk control error');
      // Fail open - don't block on errors
      next();
    }
  }

  /**
   * Build context for rule evaluation
   */
  async buildRuleContext(userId, actionType, body) {
    const now = Date.now();

    // Get recent transaction stats
    const { rows } = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as tx_last_hour,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as tx_last_day,
        COALESCE(AVG(amount_fen) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) as avg_amount_24h,
        COALESCE(SUM(amount_fen) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) as total_value_24h,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FILTER (WHERE status = 'PAID') as first_payment_age
      FROM orders
      WHERE user_id = $1
    `, [userId]);

    const stats = rows[0] || {};

    return {
      userId,
      actionType,
      timestamp: now,
      transactionCount: parseInt(stats.tx_last_hour, 10) || 0,
      timeWindow: 3600,
      amount: body.amount || 0,
      avgAmount: parseFloat(stats.avg_amount_24h) || 0,
      totalTradeValue: parseFloat(stats.total_value_24h) || 0,
      accountAge: stats.first_payment_age || 0,
      counterpartyId: body.counterpartyId || body.toUserId,
      price: body.price,
      marketAvgPrice: body.marketAvgPrice,
      deviceId: body.deviceId || body.device_id,
      relatedAccounts: body.relatedAccounts || [],
      // Payment specific
      paymentAttempts: await this.getPaymentAttempts(userId),
      // Reward specific  
      claimAttempts: await this.getClaimAttempts(userId, body.rewardId),
      rewardId: body.rewardId,
      rewardCreateTime: body.rewardCreateTime,
      claimTime: now,
      normalMaxValue: body.normalMaxValue || 100
    };
  }

  async getPaymentAttempts(userId) {
    const key = `risk:payment:attempts:${userId}`;
    const count = await this.redis.get(key);
    return parseInt(count, 10) || 0;
  }

  async getClaimAttempts(userId, rewardId) {
    if (!rewardId) return 0;
    const key = `risk:claim:attempts:${userId}:${rewardId}`;
    const count = await this.redis.get(key);
    return parseInt(count, 10) || 0;
  }

  /**
   * Execute risk action
   */
  async executeAction(req, res, { action, score, rules, actionType }) {
    const userId = req.user.sub;

    switch (action) {
      case 'throttle':
        // Apply rate limiting
        res.setHeader('X-Rate-Limit', 'reduced');
        res.setHeader('X-Risk-Score', score);
        logger.info({ userId, actionType, score }, 'Risk throttle applied');
        // Continue but with reduced limits
        break;

      case 'block':
        await this.createRiskEvent(userId, actionType, score, rules, 'BLOCKED');
        return res.status(403).json({
          code: 7001,
          message: '操作已被风控系统拦截',
          data: { 
            riskLevel: this.getRiskLevel(score),
            hint: '如误判请提交工单申诉'
          }
        });

      case 'block_and_review':
        const ticketId = await this.createReviewTask(userId, score, actionType, rules);
        await this.createRiskEvent(userId, actionType, score, rules, 'BLOCKED_FOR_REVIEW', ticketId);
        return res.status(403).json({
          code: 7002,
          message: '操作需要人工审核',
          data: { 
            ticketId,
            estimatedTime: '24小时'
          }
        });

      case 'auto_ban':
        await this.autoBanUser(userId, score, actionType, rules);
        await this.createRiskEvent(userId, actionType, score, rules, 'AUTO_BAN');
        return res.status(403).json({
          code: 7003,
          message: '账号因异常行为已被限制',
          data: { banReason: '风控系统自动封禁' }
        });
    }
  }

  getRiskLevel(score) {
    if (score < 20) return 'LOW';
    if (score < 40) return 'MEDIUM';
    if (score < 60) return 'HIGH';
    return 'CRITICAL';
  }

  async logRiskCheck(userId, actionType, data) {
    await query(`
      INSERT INTO risk_events 
        (user_id, event_type, rule_name, score_delta, details, created_at)
      VALUES ($1, 'RULE_TRIGGERED', $2, $3, $4, NOW())
    `, [userId, actionType, data.score, JSON.stringify(data)]);
  }

  async createRiskEvent(userId, actionType, score, rules, event) {
    await query(`
      INSERT INTO risk_events 
        (user_id, event_type, action_taken, score_delta, details, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, actionType, event, score, JSON.stringify({ rules: rules.map(r => r.name) })]);
  }

  async createReviewTask(userId, score, actionType, rules) {
    const { rows: [task] } = await query(`
      INSERT INTO risk_review_queue 
        (user_id, risk_score, trigger_event, status, created_at)
      VALUES ($1, $2, $3, 'PENDING', NOW())
      RETURNING id
    `, [userId, score, actionType]);

    return task.id;
  }

  async autoBanUser(userId, score, actionType, rules) {
    await query(`
      UPDATE users SET 
        status = 'BANNED',
        banned_at = NOW(),
        ban_reason = '风控系统自动封禁'
      WHERE id = $1
    `, [userId]);

    logger.warn({ userId, score, actionType, rules }, 'User auto-banned by risk control');
  }

  async addToWatchlist(userId, data) {
    const key = `risk:watchlist:${userId}`;
    await setJSON(key, data, 86400 * 7); // Watch for 7 days
  }

  trackMetrics(actionType, score) {
    // Prometheus metrics tracked via shared/metrics
    logger.metrics({
      name: 'minego_risk_checks_total',
      labels: { action: actionType, level: this.getRiskLevel(score) },
      value: 1
    });
  }
}

// Simple query wrapper
async function query(sql, params) {
  const { query: _query } = require('../../shared/db');
  return _query(sql, params);
}

module.exports = new RiskControlMiddleware();