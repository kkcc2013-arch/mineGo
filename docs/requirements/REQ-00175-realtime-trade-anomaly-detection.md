# REQ-00175: 实时交易异常检测与风控系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00175 |
| 标题 | 实时交易异常检测与风控系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、pokemon-service、user-service、gateway、backend/shared |
| 创建时间 | 2026-06-14 01:00 |

## 需求描述

精灵交易系统上线后，需要建立实时交易异常检测与风控系统，防止以下恶意行为：
- 洗钱行为：通过频繁交易转移非法获取的精灵
- 价格操纵：通过异常低价/高价交易进行利益输送
- 账号盗用：盗号后快速转移高价值精灵
- 虚假交易：刷交易记录获取不当奖励
- 批量操控：多账号间循环交易套利

本系统需实现实时检测、智能风控、自动处置三位一体的安全防护。

## 技术方案

### 1. 交易行为特征采集模块

```javascript
// backend/shared/tradeAnalytics.js
const TRADE_FEATURES = {
  // 交易频率特征
  frequency: {
    tradeCount1h: 'number',      // 1小时内交易次数
    tradeCount24h: 'number',     // 24小时内交易次数
    tradeCount7d: 'number',      // 7天内交易次数
    avgTradeInterval: 'number',  // 平均交易间隔（秒）
  },
  
  // 交易价值特征
  value: {
    avgTradeValue: 'number',     // 平均交易价值
    maxTradeValue: 'number',     // 最大单笔交易价值
    valueDeviation: 'number',    // 价值偏离度（与市场价比较）
    totalTradeValue24h: 'number', // 24小时总交易价值
  },
  
  // 交易关系特征
  relationship: {
    uniquePartners: 'number',    // 唯一交易对象数
    repeatPartnerRatio: 'number', // 重复交易对象比例
    mutualTradeCount: 'number',  // 互惠交易次数（A->B, B->A）
    relationshipAge: 'number',   // 交易关系建立时长
  },
  
  // 时间模式特征
  temporal: {
    nightTradeRatio: 'number',   // 夜间交易比例
    burstTradeScore: 'number',   // 突发交易评分
    regularityScore: 'number',   // 规律性评分
  }
};

class TradeFeatureCollector {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
  }
  
  async collectFeatures(userId, tradeContext) {
    const pipeline = this.redis.pipeline();
    const now = Date.now();
    const hour = 3600000;
    const day = 86400000;
    
    // 滑动窗口统计
    const windows = {
      '1h': now - hour,
      '24h': now - day,
      '7d': now - 7 * day
    };
    
    // 从 Redis 获取实时统计
    const keys = {
      tradeCount: `trade:stats:${userId}:count`,
      tradeValue: `trade:stats:${userId}:value`,
      partners: `trade:stats:${userId}:partners`,
      timestamps: `trade:stats:${userId}:timestamps`
    };
    
    // 批量获取统计数据
    const [count, value, partners, timestamps] = await Promise.all([
      this.redis.hgetall(keys.tradeCount),
      this.redis.hgetall(keys.tradeValue),
      this.redis.smembers(keys.partners),
      this.redis.zrangebyscore(keys.timestamps, windows['1h'], now)
    ]);
    
    return this.computeFeatures({
      count,
      value,
      partners,
      recentTrades: timestamps,
      currentTrade: tradeContext
    });
  }
  
  computeFeatures(raw) {
    return {
      frequency: {
        tradeCount1h: raw.recentTrades.length,
        tradeCount24h: parseInt(raw.count['24h'] || 0),
        tradeCount7d: parseInt(raw.count['7d'] || 0),
        avgTradeInterval: this.computeAvgInterval(raw.recentTrades)
      },
      value: {
        avgTradeValue: this.computeAvgValue(raw.value),
        maxTradeValue: this.computeMaxValue(raw.value),
        valueDeviation: this.computeDeviation(raw.currentTrade),
        totalTradeValue24h: parseFloat(raw.value['24h'] || 0)
      },
      relationship: {
        uniquePartners: raw.partners.length,
        repeatPartnerRatio: this.computeRepeatRatio(raw.partners),
        mutualTradeCount: 0, // 需要数据库查询
        relationshipAge: 0
      },
      temporal: {
        nightTradeRatio: this.computeNightRatio(raw.recentTrades),
        burstTradeScore: this.computeBurstScore(raw.recentTrades),
        regularityScore: this.computeRegularity(raw.recentTrades)
      }
    };
  }
}

module.exports = { TradeFeatureCollector, TRADE_FEATURES };
```

### 2. 异常检测引擎

```javascript
// backend/shared/tradeAnomalyDetector.js
const { TradeFeatureCollector } = require('./tradeAnalytics');

class TradeAnomalyDetector {
  constructor(redis, db, config = {}) {
    this.redis = redis;
    this.db = db;
    this.collector = new TradeFeatureCollector(redis, db);
    
    // 风控规则配置
    this.rules = {
      // 高频交易检测
      highFrequency: {
        threshold: config.highFreqThreshold || 10, // 1小时内超过10笔
        weight: 0.3,
        action: 'flag'
      },
      
      // 异常价格检测
      priceAnomaly: {
        deviationThreshold: config.priceDeviationThreshold || 0.5, // 偏离市场价50%
        weight: 0.25,
        action: 'review'
      },
      
      // 关系异常检测
      relationshipAnomaly: {
        mutualThreshold: config.mutualThreshold || 3, // 互惠交易超过3次
        weight: 0.2,
        action: 'flag'
      },
      
      // 时间模式异常
      temporalAnomaly: {
        nightRatioThreshold: config.nightRatioThreshold || 0.8,
        burstScoreThreshold: config.burstScoreThreshold || 0.7,
        weight: 0.15,
        action: 'monitor'
      },
      
      // 价值异常
      valueAnomaly: {
        highValueThreshold: config.highValueThreshold || 10000,
        rapidAccumulationThreshold: config.rapidAccumThreshold || 50000,
        weight: 0.1,
        action: 'freeze'
      }
    };
    
    // 机器学习模型（可选，用于高级检测）
    this.mlModel = null;
  }
  
  async analyze(userId, tradeContext) {
    // 1. 收集特征
    const features = await this.collector.collectFeatures(userId, tradeContext);
    
    // 2. 规则引擎检测
    const ruleResults = await this.applyRules(features, tradeContext);
    
    // 3. 行为基线检测
    const baselineResult = await this.checkBaseline(userId, features);
    
    // 4. 关联分析
    const correlationResult = await this.analyzeCorrelation(userId, tradeContext);
    
    // 5. 综合风险评估
    const riskScore = this.computeRiskScore({
      ruleResults,
      baselineResult,
      correlationResult
    });
    
    // 6. 生成风控决策
    const decision = this.makeDecision(riskScore, ruleResults);
    
    // 7. 记录检测日志
    await this.logDetection({
      userId,
      tradeContext,
      features,
      ruleResults,
      riskScore,
      decision,
      timestamp: Date.now()
    });
    
    return {
      riskScore,
      decision,
      flags: ruleResults.filter(r => r.triggered).map(r => r.rule),
      features
    };
  }
  
  async applyRules(features, tradeContext) {
    const results = [];
    
    // 高频交易检测
    results.push({
      rule: 'highFrequency',
      triggered: features.frequency.tradeCount1h > this.rules.highFrequency.threshold,
      score: Math.min(features.frequency.tradeCount1h / this.rules.highFrequency.threshold, 3),
      action: this.rules.highFrequency.action,
      details: {
        count: features.frequency.tradeCount1h,
        threshold: this.rules.highFrequency.threshold
      }
    });
    
    // 价格异常检测
    if (tradeContext.estimatedValue && tradeContext.marketValue) {
      const deviation = Math.abs(
        (tradeContext.estimatedValue - tradeContext.marketValue) / tradeContext.marketValue
      );
      results.push({
        rule: 'priceAnomaly',
        triggered: deviation > this.rules.priceAnomaly.deviationThreshold,
        score: Math.min(deviation / this.rules.priceAnomaly.deviationThreshold, 3),
        action: this.rules.priceAnomaly.action,
        details: {
          estimatedValue: tradeContext.estimatedValue,
          marketValue: tradeContext.marketValue,
          deviation
        }
      });
    }
    
    // 关系异常检测
    results.push({
      rule: 'relationshipAnomaly',
      triggered: features.relationship.mutualTradeCount > this.rules.relationshipAnomaly.mutualThreshold,
      score: Math.min(features.relationship.mutualTradeCount / this.rules.relationshipAnomaly.mutualThreshold, 2),
      action: this.rules.relationshipAnomaly.action,
      details: {
        mutualCount: features.relationship.mutualTradeCount,
        uniquePartners: features.relationship.uniquePartners
      }
    });
    
    // 时间模式异常检测
    results.push({
      rule: 'temporalAnomaly',
      triggered: features.temporal.nightTradeRatio > this.rules.temporalAnomaly.nightRatioThreshold ||
                 features.temporal.burstTradeScore > this.rules.temporalAnomaly.burstScoreThreshold,
      score: Math.max(
        features.temporal.nightTradeRatio / this.rules.temporalAnomaly.nightRatioThreshold,
        features.temporal.burstTradeScore / this.rules.temporalAnomaly.burstScoreThreshold
      ),
      action: this.rules.temporalAnomaly.action,
      details: {
        nightRatio: features.temporal.nightTradeRatio,
        burstScore: features.temporal.burstTradeScore
      }
    });
    
    // 价值异常检测
    results.push({
      rule: 'valueAnomaly',
      triggered: tradeContext.estimatedValue > this.rules.valueAnomaly.highValueThreshold ||
                 features.value.totalTradeValue24h > this.rules.valueAnomaly.rapidAccumulationThreshold,
      score: Math.max(
        tradeContext.estimatedValue / this.rules.valueAnomaly.highValueThreshold,
        features.value.totalTradeValue24h / this.rules.valueAnomaly.rapidAccumulationThreshold
      ),
      action: this.rules.valueAnomaly.action,
      details: {
        tradeValue: tradeContext.estimatedValue,
        dailyTotal: features.value.totalTradeValue24h
      }
    });
    
    return results;
  }
  
  async checkBaseline(userId, features) {
    // 获取用户历史基线
    const baselineKey = `trade:baseline:${userId}`;
    const baseline = await this.redis.hgetall(baselineKey);
    
    if (!baseline || Object.keys(baseline).length === 0) {
      // 首次交易，建立基线
      await this.establishBaseline(userId, features);
      return { deviation: 0, isNewUser: true };
    }
    
    // 计算与基线的偏离
    const deviation = this.computeBaselineDeviation(features, baseline);
    
    return {
      deviation,
      isNewUser: false,
      baselineAge: parseInt(baseline.establishedAt || 0)
    };
  }
  
  async analyzeCorrelation(userId, tradeContext) {
    // 分析交易双方的关系
    const { targetUserId } = tradeContext;
    
    // 检查是否在黑名单中
    const blacklistKey = 'trade:blacklist';
    const [userBlacklisted, targetBlacklisted] = await Promise.all([
      this.redis.sismember(blacklistKey, userId),
      this.redis.sismember(blacklistKey, targetUserId)
    ]);
    
    // 检查历史关联
    const associationKey = `trade:association:${userId}:${targetUserId}`;
    const association = await this.redis.hgetall(associationKey);
    
    // 检查IP关联
    const ipAssociation = await this.checkIPAssociation(userId, targetUserId);
    
    return {
      userBlacklisted: userBlacklisted === 1,
      targetBlacklisted: targetBlacklisted === 1,
      hasAssociation: Object.keys(association).length > 0,
      ipShared: ipAssociation,
      riskLevel: this.computeCorrelationRisk({
        userBlacklisted,
        targetBlacklisted,
        hasAssociation: Object.keys(association).length > 0,
        ipShared: ipAssociation
      })
    };
  }
  
  computeRiskScore(components) {
    let totalScore = 0;
    let totalWeight = 0;
    
    // 规则引擎评分
    for (const result of components.ruleResults) {
      const weight = this.rules[result.rule]?.weight || 0.1;
      if (result.triggered) {
        totalScore += result.score * weight;
      }
      totalWeight += weight;
    }
    
    // 基线偏离评分
    if (components.baselineResult.deviation > 2) {
      totalScore += 0.5;
    }
    
    // 关联风险评分
    if (components.correlationResult.riskLevel > 0.5) {
      totalScore += components.correlationResult.riskLevel * 0.3;
    }
    
    return Math.min(totalScore / totalWeight, 10);
  }
  
  makeDecision(riskScore, ruleResults) {
    if (riskScore >= 8) {
      return {
        action: 'block',
        reason: 'high_risk',
        requireReview: true,
        notifyAdmin: true
      };
    } else if (riskScore >= 5) {
      return {
        action: 'review',
        reason: 'suspicious',
        requireReview: true,
        notifyAdmin: false
      };
    } else if (riskScore >= 3) {
      return {
        action: 'flag',
        reason: 'anomaly_detected',
        requireReview: false,
        notifyAdmin: false
      };
    } else {
      return {
        action: 'allow',
        reason: 'normal',
        requireReview: false,
        notifyAdmin: false
      };
    }
  }
  
  async logDetection(data) {
    const logKey = `trade:detection:log:${data.userId}`;
    await this.redis.zadd(logKey, data.timestamp, JSON.stringify({
      tradeId: data.tradeContext.tradeId,
      riskScore: data.riskScore,
      decision: data.decision.action,
      flags: data.flags
    }));
    
    // 保留30天日志
    const cutoff = Date.now() - 30 * 86400000;
    await this.redis.zremrangebyscore(logKey, '-inf', cutoff);
    
    // 同步写入数据库（用于审计）
    await this.db.query(`
      INSERT INTO trade_detection_logs 
      (user_id, trade_id, risk_score, decision, flags, features, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      data.userId,
      data.tradeContext.tradeId,
      data.riskScore,
      data.decision.action,
      JSON.stringify(data.flags),
      JSON.stringify(data.features)
    ]);
  }
}

module.exports = { TradeAnomalyDetector };
```

### 3. 风控处置中心

```javascript
// backend/shared/tradeRiskHandler.js
class TradeRiskHandler {
  constructor(redis, db, notificationService) {
    this.redis = redis;
    this.db = db;
    this.notificationService = notificationService;
    
    this.actions = {
      allow: this.allowTrade.bind(this),
      flag: this.flagTrade.bind(this),
      review: this.reviewTrade.bind(this),
      block: this.blockTrade.bind(this),
      freeze: this.freezeAccounts.bind(this)
    };
  }
  
  async handle(tradeId, decision, context) {
    const handler = this.actions[decision.action];
    if (!handler) {
      throw new Error(`Unknown action: ${decision.action}`);
    }
    
    return handler(tradeId, decision, context);
  }
  
  async allowTrade(tradeId, decision, context) {
    // 正常放行，更新统计
    await this.updateTradeStats(context);
    return { success: true, action: 'allow' };
  }
  
  async flagTrade(tradeId, decision, context) {
    // 标记交易，记录到监控列表
    const flagKey = `trade:flagged:${tradeId}`;
    await this.redis.hset(flagKey, {
      userId: context.userId,
      targetUserId: context.targetUserId,
      reason: decision.reason,
      timestamp: Date.now()
    });
    
    await this.updateTradeStats(context);
    
    // 发送内部告警
    await this.notificationService.sendInternalAlert({
      type: 'trade_flagged',
      tradeId,
      userId: context.userId,
      reason: decision.reason
    });
    
    return { success: true, action: 'flag', flagged: true };
  }
  
  async reviewTrade(tradeId, decision, context) {
    // 挂起交易，等待人工审核
    await this.db.query(`
      INSERT INTO trade_reviews 
      (trade_id, user_id, target_user_id, risk_score, status, created_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW())
    `, [tradeId, context.userId, context.targetUserId, context.riskScore]);
    
    // 通知用户交易审核中
    await this.notificationService.sendToUser(context.userId, {
      type: 'trade_review',
      message: 'trade.underReview',
      tradeId
    });
    
    // 通知管理员
    if (decision.notifyAdmin) {
      await this.notificationService.sendAdminAlert({
        type: 'trade_requires_review',
        tradeId,
        userId: context.userId,
        riskScore: context.riskScore
      });
    }
    
    return { success: true, action: 'review', status: 'pending' };
  }
  
  async blockTrade(tradeId, decision, context) {
    // 阻止交易
    await this.db.query(`
      INSERT INTO blocked_trades 
      (trade_id, user_id, target_user_id, risk_score, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [tradeId, context.userId, context.targetUserId, context.riskScore, decision.reason]);
    
    // 通知用户
    await this.notificationService.sendToUser(context.userId, {
      type: 'trade_blocked',
      message: 'trade.blocked.security',
      tradeId
    });
    
    // 通知管理员
    await this.notificationService.sendAdminAlert({
      type: 'trade_blocked',
      tradeId,
      userId: context.userId,
      riskScore: context.riskScore,
      reason: decision.reason
    });
    
    return { success: false, action: 'block', reason: decision.reason };
  }
  
  async freezeAccounts(tradeId, decision, context) {
    // 冻结相关账户
    const accounts = [context.userId];
    if (context.targetUserId) {
      accounts.push(context.targetUserId);
    }
    
    for (const userId of accounts) {
      await this.db.query(`
        UPDATE users 
        SET status = 'frozen', frozen_reason = $1, frozen_at = NOW()
        WHERE id = $2
      `, [`suspicious_trade:${tradeId}`, userId]);
      
      // 添加到黑名单
      await this.redis.sadd('trade:blacklist', userId);
    }
    
    // 记录冻结日志
    await this.db.query(`
      INSERT INTO account_freeze_logs 
      (user_ids, trade_id, risk_score, reason, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [accounts, tradeId, context.riskScore, decision.reason]);
    
    // 紧急通知管理员
    await this.notificationService.sendUrgentAlert({
      type: 'accounts_frozen',
      tradeId,
      userIds: accounts,
      riskScore: context.riskScore
    });
    
    return { success: false, action: 'freeze', frozenAccounts: accounts };
  }
  
  async updateTradeStats(context) {
    const pipeline = this.redis.pipeline();
    const now = Date.now();
    
    // 更新交易计数
    pipeline.hincrby(`trade:stats:${context.userId}:count`, '1h', 1);
    pipeline.hincrby(`trade:stats:${context.userId}:count`, '24h', 1);
    pipeline.hincrby(`trade:stats:${context.userId}:count`, '7d', 1);
    
    // 更新交易价值
    if (context.tradeValue) {
      pipeline.hincrbyfloat(`trade:stats:${context.userId}:value`, '1h', context.tradeValue);
      pipeline.hincrbyfloat(`trade:stats:${context.userId}:value`, '24h', context.tradeValue);
      pipeline.hincrbyfloat(`trade:stats:${context.userId}:value`, '7d', context.tradeValue);
    }
    
    // 更新交易对象
    if (context.targetUserId) {
      pipeline.sadd(`trade:stats:${context.userId}:partners`, context.targetUserId);
    }
    
    // 记录交易时间戳
    pipeline.zadd(`trade:stats:${context.userId}:timestamps`, now, `${now}:${context.tradeId}`);
    
    await pipeline.exec();
  }
}

module.exports = { TradeRiskHandler };
```

### 4. 交易中间件集成

```javascript
// social-service/src/middleware/tradeProtection.js
const { TradeAnomalyDetector } = require('../../shared/tradeAnomalyDetector');
const { TradeRiskHandler } = require('../../shared/tradeRiskHandler');

function createTradeProtectionMiddleware(detector, handler) {
  return async (req, res, next) => {
    // 只拦截交易相关请求
    if (!req.path.includes('/trade') || req.method !== 'POST') {
      return next();
    }
    
    const userId = req.user.id;
    const tradeContext = {
      tradeId: req.body.tradeId || generateTradeId(),
      targetUserId: req.body.targetUserId,
      pokemonId: req.body.pokemonId,
      estimatedValue: req.body.estimatedValue,
      marketValue: await getMarketValue(req.body.pokemonId)
    };
    
    try {
      // 执行异常检测
      const analysis = await detector.analyze(userId, tradeContext);
      
      // 根据决策执行相应操作
      const result = await handler.handle(tradeContext.tradeId, analysis.decision, {
        ...tradeContext,
        userId,
        riskScore: analysis.riskScore
      });
      
      if (result.action === 'block' || result.action === 'freeze') {
        return res.status(403).json({
          error: 'trade.blocked',
          message: '交易已被安全系统阻止',
          code: 'TRADE_BLOCKED_SECURITY'
        });
      }
      
      if (result.action === 'review') {
        return res.status(202).json({
          message: '交易正在审核中',
          tradeId: tradeContext.tradeId,
          status: 'pending_review'
        });
      }
      
      // 附加检测结果到请求
      req.tradeAnalysis = analysis;
      next();
      
    } catch (error) {
      console.error('Trade protection error:', error);
      // 发生错误时，保守处理：放行但记录
      await logProtectionError(userId, tradeContext, error);
      next();
    }
  };
}

module.exports = { createTradeProtectionMiddleware };
```

### 5. 数据库迁移

```sql
-- database/migrations/20260614_trade_anomaly_detection.sql

-- 交易检测日志表
CREATE TABLE IF NOT EXISTS trade_detection_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  trade_id VARCHAR(64) NOT NULL,
  risk_score DECIMAL(5,2) NOT NULL,
  decision VARCHAR(20) NOT NULL,
  flags JSONB DEFAULT '[]',
  features JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trade_detection_logs_user ON trade_detection_logs(user_id);
CREATE INDEX idx_trade_detection_logs_risk ON trade_detection_logs(risk_score DESC);
CREATE INDEX idx_trade_detection_logs_created ON trade_detection_logs(created_at DESC);

-- 交易审核表
CREATE TABLE IF NOT EXISTS trade_reviews (
  id SERIAL PRIMARY KEY,
  trade_id VARCHAR(64) NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  risk_score DECIMAL(5,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trade_reviews_status ON trade_reviews(status);
CREATE INDEX idx_trade_reviews_user ON trade_reviews(user_id);

-- 阻止交易表
CREATE TABLE IF NOT EXISTS blocked_trades (
  id SERIAL PRIMARY KEY,
  trade_id VARCHAR(64) NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  risk_score DECIMAL(5,2) NOT NULL,
  reason VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_blocked_trades_user ON blocked_trades(user_id);
CREATE INDEX idx_blocked_trades_created ON blocked_trades(created_at DESC);

-- 账户冻结日志表
CREATE TABLE IF NOT EXISTS account_freeze_logs (
  id SERIAL PRIMARY KEY,
  user_ids INTEGER[] NOT NULL,
  trade_id VARCHAR(64),
  risk_score DECIMAL(5,2) NOT NULL,
  reason VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_freeze_logs_created ON account_freeze_logs(created_at DESC);

-- 用户基线表
CREATE TABLE IF NOT EXISTS trade_baselines (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  avg_trade_interval DECIMAL(10,2),
  avg_trade_value DECIMAL(15,2),
  typical_partners INTEGER[],
  night_trade_ratio DECIMAL(5,4),
  burst_score DECIMAL(5,4),
  sample_size INTEGER DEFAULT 0,
  established_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trade_baselines_user ON trade_baselines(user_id);
```

### 6. 管理后台接口

```javascript
// admin-dashboard/src/routes/tradeRisk.js
const express = require('express');
const router = express.Router();

// 获取待审核交易列表
router.get('/reviews', async (req, res) => {
  const { status = 'pending', limit = 20, offset = 0 } = req.query;
  
  const result = await db.query(`
    SELECT tr.*, 
           u1.username as user_name, 
           u2.username as target_user_name,
           p.name as pokemon_name
    FROM trade_reviews tr
    LEFT JOIN users u1 ON tr.user_id = u1.id
    LEFT JOIN users u2 ON tr.target_user_id = u2.id
    WHERE tr.status = $1
    ORDER BY tr.risk_score DESC, tr.created_at ASC
    LIMIT $2 OFFSET $3
  `, [status, limit, offset]);
  
  res.json(result.rows);
});

// 审核通过/拒绝
router.post('/reviews/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body;
  const reviewerId = req.user.id;
  
  const review = await db.query(`
    UPDATE trade_reviews 
    SET status = $1, reviewer_id = $2, review_note = $3, reviewed_at = NOW()
    WHERE id = $4
    RETURNING *
  `, [action === 'approve' ? 'approved' : 'rejected', reviewerId, note, id]);
  
  if (action === 'approve' && review.rows[0]) {
    // 执行原交易
    await executeTrade(review.rows[0].trade_id);
  }
  
  res.json({ success: true, review: review.rows[0] });
});

// 风险统计仪表板
router.get('/stats', async (req, res) => {
  const stats = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE decision = 'allow') as allowed,
      COUNT(*) FILTER (WHERE decision = 'flag') as flagged,
      COUNT(*) FILTER (WHERE decision = 'review') as reviewed,
      COUNT(*) FILTER (WHERE decision = 'block') as blocked,
      AVG(risk_score) as avg_risk_score,
      MAX(risk_score) as max_risk_score
    FROM trade_detection_logs
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);
  
  res.json(stats.rows[0]);
});

module.exports = router;
```

## 验收标准

- [ ] 交易频率异常检测：1小时内超过阈值交易触发标记
- [ ] 价格异常检测：偏离市场价50%以上触发审核
- [ ] 关系异常检测：互惠交易超过3次触发标记
- [ ] 时间模式异常检测：夜间交易比例>80%或突发交易评分>0.7触发监控
- [ ] 价值异常检测：单笔高价值或24小时累计超额触发冻结
- [ ] 风控决策执行：block/review/flag/allow四种决策正确执行
- [ ] 账户冻结机制：高风险交易自动冻结相关账户
- [ ] 管理后台集成：待审核交易列表可查看、审批
- [ ] 检测日志记录：所有检测记录写入数据库和Redis
- [ ] Prometheus 指标：暴露交易风控相关指标

## 影响范围

- social-service: 添加交易保护中间件
- pokemon-service: 提供精灵市场价值查询接口
- user-service: 账户冻结状态管理
- gateway: 交易请求路由
- backend/shared: 新增 tradeAnalytics.js、tradeAnomalyDetector.js、tradeRiskHandler.js
- database/migrations: 新增交易检测相关表

## 参考

- [金融风控系统设计模式](https://example.com/risk-control-patterns)
- [Redis 实时计算最佳实践](https://redis.io/docs/manual/patterns/)
- [反欺诈检测算法](https://example.com/fraud-detection-algorithms)
