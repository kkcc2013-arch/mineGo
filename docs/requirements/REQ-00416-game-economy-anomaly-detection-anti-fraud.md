# REQ-00416: 游戏经济系统异常检测与防刷风控系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00416 |
| 标题 | 游戏经济系统异常检测与防刷风控系统 |
| 类别 | 反作弊 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | payment-service、reward-service、trade-service、gateway、admin-dashboard、shared/risk-engine |
| 创建时间 | 2026-07-01 18:00 |

## 需求描述

游戏经济系统是 mineGo 的核心资产，当前存在多种作弊和刷取风险：

1. **资源刷取**：通过脚本自动刷取金币、道具、精灵
2. **交易异常**：异常交易模式（如大量低价交易、频繁同账号交易）
3. **奖励滥用**：重复领取奖励、利用漏洞刷取活动奖励
4. **支付欺诈**：虚假支付、退款欺诈、支付劫持
5. **市场操纵**：人为操控市场价格、囤积居奇

需要建立多层次风控系统，实时检测和预防经济系统作弊行为，保护游戏经济平衡。

### 目标

- 实时检测异常交易行为，拦截率 > 95%
- 建立用户风险评分体系，实现分级风控
- 支持自动处置（警告、限制、封禁）与人工审核流程
- 提供完整的审计追踪和风控数据分析能力

## 技术方案

### 1. 风险评分引擎

```javascript
// shared/risk-engine/risk-scorer.js
class RiskScorer {
  constructor() {
    this.rules = new Map();
    this.weights = {
      transaction: 0.3,
      behavior: 0.25,
      account: 0.2,
      device: 0.15,
      history: 0.1
    };
  }

  // 计算综合风险分数 (0-100)
  async calculateRiskScore(userId, context) {
    const scores = {
      transaction: await this.evalTransactionRisk(userId, context),
      behavior: await this.evalBehaviorRisk(userId, context),
      account: await this.evalAccountRisk(userId),
      device: await this.evalDeviceRisk(userId, context.deviceId),
      history: await this.evalHistoryRisk(userId)
    };

    let totalScore = 0;
    for (const [key, score] of Object.entries(scores)) {
      totalScore += score * this.weights[key];
    }

    return {
      score: Math.round(totalScore),
      breakdown: scores,
      level: this.getRiskLevel(totalScore),
      recommendedAction: this.getRecommendedAction(totalScore)
    };
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
}
```

### 2. 异常交易检测规则

```javascript
// shared/risk-engine/rules/transaction-rules.js
const TRANSACTION_RULES = {
  // 高频交易检测
  HIGH_FREQUENCY: {
    name: '高频交易',
    condition: (ctx) => ctx.transactionCount > 50 && ctx.timeWindow < 3600,
    score: 30,
    severity: 'HIGH'
  },

  // 大额异常
  LARGE_AMOUNT_ANOMALY: {
    name: '大额交易异常',
    condition: (ctx) => ctx.amount > ctx.avgAmount * 10,
    score: 40,
    severity: 'HIGH'
  },

  // 同设备多账号交易
  SAME_DEVICE_TRADE: {
    name: '同设备多账号交易',
    condition: (ctx) => ctx.sameDeviceTrades > 5,
    score: 50,
    severity: 'CRITICAL'
  },

  // 价格异常
  PRICE_MANIPULATION: {
    name: '价格操纵嫌疑',
    condition: (ctx) => {
      const priceDeviation = Math.abs(ctx.price - ctx.marketAvgPrice) / ctx.marketAvgPrice;
      return priceDeviation > 0.5;
    },
    score: 35,
    severity: 'HIGH'
  },

  // 对敲交易（买卖双方为关联账号）
  WASH_TRADING: {
    name: '对敲交易嫌疑',
    condition: (ctx) => ctx.relatedAccounts.includes(ctx.counterpartyId),
    score: 60,
    severity: 'CRITICAL'
  },

  // 新账号异常活跃
  NEW_ACCOUNT_SURGE: {
    name: '新账号异常活跃',
    condition: (ctx) => ctx.accountAge < 7 * 24 * 3600 && ctx.totalTradeValue > 10000,
    score: 45,
    severity: 'HIGH'
  }
};
```

### 3. 行为模式分析器

```javascript
// shared/risk-engine/analyzers/behavior-analyzer.js
class BehaviorAnalyzer {
  constructor(redis) {
    this.redis = redis;
    this.windows = {
      minute: 60,
      hour: 3600,
      day: 86400
    };
  }

  // 分析交易行为模式
  async analyzeTradePattern(userId) {
    const patterns = {
      // 交易时间分布异常（如全天 24 小时均匀交易）
      timeDistributionAnomaly: await this.checkTimeDistribution(userId),
      
      // 交易对象集中度（总是与少数账号交易）
      counterpartyConcentration: await this.checkCounterpartyConcentration(userId),
      
      // 交易金额模式（总是整数或固定模式）
      amountPattern: await this.checkAmountPattern(userId),
      
      // 交易频率突变
      frequencySpike: await this.checkFrequencySpike(userId),
      
      // 资产流动方向（只进不出或只出不进）
      flowDirectionBias: await this.checkFlowDirectionBias(userId)
    };

    return {
      patterns,
      anomalyCount: Object.values(patterns).filter(p => p.isAnomaly).length,
      details: this.generatePatternReport(patterns)
    };
  }

  // 检查时间分布异常（机器人行为特征）
  async checkTimeDistribution(userId) {
    const hourlyKey = `risk:trade:hourly:${userId}`;
    const hourlyCounts = await this.redis.hgetall(hourlyKey);
    
    // 如果 24 小时内每小时都有交易，且分布均匀（标准差极小），可能为脚本
    const counts = Object.values(hourlyCounts).map(Number);
    if (counts.length >= 20) {
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / counts.length;
      const stdDev = Math.sqrt(variance);
      
      // 标准差小于平均值的 10% 且平均值 > 5，视为脚本行为
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
}
```

### 4. 实时风控中间件

```javascript
// gateway/middleware/risk-control.js
class RiskControlMiddleware {
  constructor(riskEngine, redis) {
    this.riskEngine = riskEngine;
    this.redis = redis;
    this.actionConfigs = {
      'trade:create': { threshold: 40, action: 'block' },
      'trade:complete': { threshold: 50, action: 'block' },
      'reward:claim': { threshold: 35, action: 'throttle' },
      'payment:initiate': { threshold: 60, action: 'block_and_review' },
      'item:transfer': { threshold: 45, action: 'block' }
    };
  }

  async handle(req, res, next) {
    const { actionType } = req;
    const userId = req.user.sub;
    const config = this.actionConfigs[actionType];

    if (!config) {
      return next();
    }

    // 获取或计算风险分数（带缓存）
    const cacheKey = `risk:score:${userId}`;
    let riskData = await this.redis.get(cacheKey);
    
    if (!riskData) {
      riskData = await this.riskEngine.calculateRiskScore(userId, {
        actionType,
        ...req.body
      });
      await this.redis.setex(cacheKey, 300, JSON.stringify(riskData)); // 缓存 5 分钟
    } else {
      riskData = JSON.parse(riskData);
    }

    // 记录风控日志
    await this.logRiskCheck(userId, actionType, riskData);

    // 执行风控动作
    if (riskData.score >= config.threshold) {
      return this.executeAction(req, res, riskData, config.action);
    }

    // 低风险用户也需要监控
    if (riskData.score >= 20) {
      res.setHeader('X-Risk-Level', riskData.level);
      await this.addToWatchlist(userId, riskData);
    }

    req.riskData = riskData;
    next();
  }

  async executeAction(req, res, riskData, action) {
    switch (action) {
      case 'throttle':
        // 限流：降低操作频率
        res.setHeader('X-Rate-Limit', 'reduced');
        break;
      case 'block':
        return res.status(403).json({
          code: 7001,
          message: '操作已被风控系统拦截',
          data: { riskLevel: riskData.level }
        });
      case 'block_and_review':
        await this.createReviewTask(req.user.sub, riskData);
        return res.status(403).json({
          code: 7002,
          message: '操作需要人工审核',
          data: { ticketId: riskData.ticketId }
        });
      case 'auto_ban':
        await this.autoBanUser(req.user.sub, riskData);
        return res.status(403).json({
          code: 7003,
          message: '账号因异常行为已被限制'
        });
    }
  }
}
```

### 5. 数据库 Schema

```sql
-- 风险评分历史表
CREATE TABLE risk_score_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  level VARCHAR(20) NOT NULL,
  breakdown JSONB,
  trigger_action VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_risk_score_user_time ON risk_score_history(user_id, created_at DESC);

-- 风控事件表
CREATE TABLE risk_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_type VARCHAR(50) NOT NULL, -- 'RULE_TRIGGERED', 'ACTION_TAKEN', 'SCORE_CHANGE'
  rule_name VARCHAR(100),
  score_delta INTEGER,
  action_taken VARCHAR(50),
  details JSONB,
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_risk_events_user ON risk_events(user_id, created_at DESC);
CREATE INDEX idx_risk_events_type ON risk_events(event_type, created_at DESC);

-- 关联账号表（用于检测多账号作弊）
CREATE TABLE related_accounts (
  id SERIAL PRIMARY KEY,
  user_id_a INTEGER NOT NULL,
  user_id_b INTEGER NOT NULL,
  relation_type VARCHAR(50) NOT NULL, -- 'SAME_DEVICE', 'SAME_IP', 'FREQUENT_TRADE'
  confidence DECIMAL(5, 4),
  evidence JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id_a, user_id_b, relation_type)
);

-- 风控审核队列表
CREATE TABLE risk_review_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  risk_score INTEGER NOT NULL,
  trigger_event_id INTEGER REFERENCES risk_events(id),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'
  assigned_to INTEGER,
  resolution VARCHAR(50),
  resolution_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX idx_review_queue_status ON risk_review_queue(status, created_at);
```

### 6. Prometheus 指标

```javascript
const riskMetrics = {
  // 风控事件计数
  riskEventsTotal: new Counter({
    name: 'minego_risk_events_total',
    help: 'Total risk events by type and action',
    labelNames: ['event_type', 'action', 'level']
  }),

  // 风险分数分布
  riskScoreHistogram: new Histogram({
    name: 'minego_risk_score',
    help: 'User risk score distribution',
    buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  }),

  // 规则触发统计
  ruleTriggersTotal: new Counter({
    name: 'minego_risk_rule_triggers_total',
    help: 'Times each risk rule was triggered',
    labelNames: ['rule_name', 'severity']
  }),

  // 审核队列大小
  reviewQueueSize: new Gauge({
    name: 'minego_risk_review_queue_size',
    help: 'Current size of risk review queue',
    labelNames: ['status']
  }),

  // 自动处理统计
  autoActionsTotal: new Counter({
    name: 'minego_risk_auto_actions_total',
    help: 'Automated risk actions taken',
    labelNames: ['action_type', 'result']
  })
};
```

### 7. 管理后台 API

```
GET /admin/risk/users
  - 查询高风险用户列表
  - 支持按风险等级、分数范围筛选
  - 参数：level, minScore, maxScore, page, limit

GET /admin/risk/users/:userId
  - 查询用户风险详情
  - 返回风险评分、触发规则、历史事件

GET /admin/risk/events
  - 查询风控事件日志
  - 支持按时间、类型、用户筛选

GET /admin/risk/review-queue
  - 查询待审核队列
  - 支持分配审核任务

POST /admin/risk/review/:ticketId
  - 提交审核结果
  - 参数：resolution, notes, action (warn/ban/dismiss)

GET /admin/risk/statistics
  - 风控统计数据
  - 各等级用户数、事件趋势、处理率

POST /admin/risk/rules
  - 管理风控规则
  - 支持启用/禁用、调整阈值

POST /admin/risk/users/:userId/adjust-score
  - 手动调整用户风险分数
  - 参数：delta, reason
```

## 验收标准

- [ ] 风险评分引擎：支持 5 维度评分，综合分数计算准确
- [ ] 交易规则检测：至少 6 条规则生效，触发后正确记录事件
- [ ] 行为模式分析：时间分布、交易对象集中度检测准确率 > 85%
- [ ] 实时风控中间件：集成到交易、奖励、支付相关接口，拦截延迟 < 50ms
- [ ] 风控动作：支持 ALLOW、MONITOR、THROTTLE、BLOCK、AUTO_BAN 五种动作
- [ ] 审核队列：风险分数 >= 60 的用户自动进入人工审核
- [ ] Prometheus 指标：risk_events_total、risk_score、rule_triggers_total 等指标可查询
- [ ] 管理后台：可查看高风险用户列表、用户风险详情、审核队列
- [ ] 单元测试：风险评分、规则检测、行为分析覆盖率 > 80%
- [ ] 集成测试：模拟欺诈行为被正确检测和拦截

## 影响范围

- **新增模块**：
  - `shared/risk-engine/` - 风险评分引擎
  - `shared/risk-engine/rules/` - 风控规则定义
  - `shared/risk-engine/analyzers/` - 行为分析器
- **修改服务**：
  - `gateway/` - 集成风控中间件
  - `trade-service/` - 交易风控钩子
  - `payment-service/` - 支付风控钩子
  - `reward-service/` - 奖励领取风控
  - `admin-dashboard/` - 风控管理界面
- **数据库**：
  - 新增 `risk_score_history`、`risk_events`、`related_accounts`、`risk_review_queue` 表

## 参考

- REQ-00010 GPS 伪造检测与速度限制反作弊系统（已完成）
- 风控系统最佳实践：https://www.oreilly.com/content/real-time-fraud-detection/
- 行为分析方法：User Behavior Analytics (UBA)