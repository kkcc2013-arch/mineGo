# REQ-00405: 玩家流失预测与智能挽留系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00405 |
| 标题 | 玩家流失预测与智能挽留系统 |
| 类别 | 运营/数据分析 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、reward-service、social-service、gateway、backend/jobs、admin-dashboard、Kafka、Redis、PostgreSQL、machine-learning-pipeline |
| 创建时间 | 2026-07-01 04:00 UTC |

## 需求描述

构建基于机器学习的玩家流失预测系统，实时分析玩家行为特征，预测 7/14/30 天内的流失风险，并自动触发个性化的挽留策略，包括：

1. **流失风险评分** - 基于多维特征的流失概率预测
2. **流失原因分析** - 自动识别玩家流失的主要原因（社交孤立、进度瓶颈、经济失衡等）
3. **智能挽留策略** - 根据流失原因自动选择最优挽留方案
4. **挽留效果追踪** - 闭环追踪挽留行动的效果并优化策略
5. **运营仪表板** - 可视化流失风险分布与挽留效果

### 核心价值

- **降低玩家流失率** - 提前干预高风险玩家，预计降低流失率 15-20%
- **提升玩家生命周期价值（LTV）** - 延长活跃周期，增加付费转化
- **精细化运营** - 从被动挽留转向主动预防，降低获客成本
- **数据驱动决策** - 为运营团队提供量化决策依据

## 技术方案

### 1. 数据采集层

```javascript
// backend/shared/churnPredictor/FeatureCollector.js
const { Kafka } = require('kafkajs');
const Redis = require('ioredis');

class FeatureCollector {
  constructor() {
    this.kafka = new Kafka({ brokers: process.env.KAFKA_BROKERS.split(',') });
    this.redis = new Redis(process.env.REDIS_URL);
    this.featureBuffer = new Map();
  }

  // 定义流失预测特征集
  static FEATURES = {
    // 活跃度特征
    activity: {
      login_frequency_7d: 'number',      // 7天内登录天数
      login_frequency_30d: 'number',     // 30天内登录天数
      session_duration_avg: 'number',   // 平均会话时长（分钟）
      session_duration_trend: 'number',  // 会话时长趋势（-1到1）
      last_login_days: 'number',         // 距上次登录天数
      play_time_total_hours: 'number',   // 总游戏时长
    },

    // 社交特征
    social: {
      friends_count: 'number',           // 好友数量
      friend_interactions_7d: 'number',  // 7天内好友互动次数
      guild_member: 'boolean',           // 是否加入公会
      guild_activity_score: 'number',    // 公会活跃度得分
      social_messages_sent_30d: 'number', // 30天内发送消息数
      social_isolation_score: 'number',  // 社交孤立指数（0-100）
    },

    // 游戏进度特征
    progress: {
      pokemon_caught_total: 'number',    // 捕捉精灵总数
      pokemon_caught_7d: 'number',       // 7天内捕捉数
      pokedex_completion_pct: 'number', // 图鉴完成度百分比
      gym_battles_total: 'number',       // 道馆战斗总数
      gym_battles_win_rate: 'number',    // 道馆战斗胜率
      level_current: 'number',           // 当前等级
      level_progress_pct: 'number',      // 当前等级进度
      progress_stagnation_days: 'number', // 进度停滞天数
    },

    // 经济特征
    economy: {
      coins_balance: 'number',           // 金币余额
      coins_spent_30d: 'number',          // 30天内金币消费
      premium_currency_balance: 'number', // 高级货币余额
      purchase_count_total: 'number',    // 总购买次数
      purchase_amount_total: 'number',   // 总购买金额
      days_since_last_purchase: 'number', // 距上次购买天数
      is_paying_user: 'boolean',          // 是否付费用户
      arpu_30d: 'number',                 // 30天ARPU
    },

    // 行为模式特征
    behavior: {
      preferred_play_time: 'string',     // 偏好游戏时段（morning/afternoon/evening/night）
      play_time_variance: 'number',       // 游戏时间波动性
      catch_success_rate_7d: 'number',   // 7天捕捉成功率
      feature_usage_breadth: 'number',   // 功能使用广度（使用的功能数/总功能数）
      tutorial_completed: 'boolean',      // 是否完成教程
      daily_task_completion_rate: 'number', // 每日任务完成率
      event_participation_30d: 'number',  // 30天内活动参与次数
    },

    // 设备与技术特征
    technical: {
      device_type: 'string',             // 设备类型（iOS/Android）
      app_version: 'string',             // 应用版本
      os_version: 'string',              // 操作系统版本
      crash_count_7d: 'number',          // 7天内崩溃次数
      network_error_rate: 'number',      // 网络错误率
    }
  };

  // 实时特征采集
  async collectUserFeatures(userId) {
    const features = {};
    
    // 从 Redis 缓存获取实时数据
    const cachedFeatures = await this.redis.hgetall(`user:${userId}:features:realtime`);
    
    // 从数据库获取历史数据
    const historicalFeatures = await this.fetchHistoricalFeatures(userId);
    
    // 合并特征
    Object.assign(features, cachedFeatures, historicalFeatures);
    
    // 计算衍生特征
    features.derived = this.calculateDerivedFeatures(features);
    
    return features;
  }

  // Kafka 事件驱动更新
  async startFeatureStream() {
    const consumer = this.kafka.consumer({ groupId: 'churn-predictor-features' });
    await consumer.connect();
    
    // 订阅用户行为事件
    const topics = [
      'user.login',
      'user.logout',
      'pokemon.caught',
      'pokemon.evolved',
      'gym.battle',
      'social.friend_added',
      'social.message_sent',
      'payment.completed',
      'quest.completed',
    ];
    
    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }
    
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value.toString());
        await this.updateFeatures(event);
      }
    });
  }

  // 更新实时特征
  async updateFeatures(event) {
    const { userId, type, timestamp, data } = event;
    const key = `user:${userId}:features:realtime`;
    
    switch (type) {
      case 'user.login':
        await this.redis.hincrby(key, 'login_frequency_7d', 1);
        await this.redis.hset(key, 'last_login', timestamp);
        break;
      case 'pokemon.caught':
        await this.redis.hincrby(key, 'pokemon_caught_7d', 1);
        await this.redis.hincrby(key, 'pokemon_caught_total', 1);
        break;
      case 'gym.battle':
        if (data.result === 'win') {
          await this.redis.hincrby(key, 'gym_battles_won', 1);
        }
        await this.redis.hincrby(key, 'gym_battles_total', 1);
        break;
      case 'social.message_sent':
        await this.redis.hincrby(key, 'social_messages_sent_30d', 1);
        break;
      case 'payment.completed':
        await this.redis.hincrby(key, 'purchase_count_total', 1);
        await this.redis.hincrbyfloat(key, 'purchase_amount_total', data.amount);
        await this.redis.hset(key, 'last_purchase', timestamp);
        break;
    }
    
    // 触发预测更新
    await this.schedulePrediction(userId);
  }
}

module.exports = FeatureCollector;
```

### 2. 流失预测模型

```javascript
// backend/shared/churnPredictor/ChurnModel.js
const tf = require('@tensorflow/tfjs-node');
const { Redis } = require('ioredis');

class ChurnPredictionModel {
  constructor() {
    this.model = null;
    this.redis = new Redis(process.env.REDIS_URL);
    this.modelVersion = '1.0.0';
  }

  // 构建神经网络模型
  buildModel(inputDim) {
    const model = tf.sequential();
    
    // 输入层 + 第一隐藏层
    model.add(tf.layers.dense({
      units: 128,
      activation: 'relu',
      inputDim: inputDim,
      kernelInitializer: 'heNormal',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
    }));
    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({ rate: 0.3 }));
    
    // 第二隐藏层
    model.add(tf.layers.dense({
      units: 64,
      activation: 'relu',
      kernelInitializer: 'heNormal',
    }));
    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({ rate: 0.2 }));
    
    // 第三隐藏层
    model.add(tf.layers.dense({
      units: 32,
      activation: 'relu',
    }));
    
    // 输出层 - 多任务学习（7天、14天、30天流失概率）
    model.add(tf.layers.dense({
      units: 3,
      activation: 'sigmoid',
    }));
    
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy', 'auc'],
    });
    
    this.model = model;
    return model;
  }

  // 预测流失风险
  async predict(userId, features) {
    // 特征标准化
    const normalizedFeatures = await this.normalizeFeatures(features);
    
    // 转换为张量
    const inputTensor = tf.tensor2d([normalizedFeatures]);
    
    // 预测
    const prediction = this.model.predict(inputTensor);
    const probabilities = await prediction.data();
    
    // 清理张量
    inputTensor.dispose();
    prediction.dispose();
    
    return {
      userId,
      modelVersion: this.modelVersion,
      predictedAt: new Date().toISOString(),
      probabilities: {
        churn_7d: probabilities[0],
        churn_14d: probabilities[1],
        churn_30d: probabilities[2],
      },
      riskLevel: this.classifyRiskLevel(probabilities[7]), // 基于14天流失概率
    };
  }

  // 风险分级
  classifyRiskLevel(probability) {
    if (probability >= 0.7) return 'critical';    // 高危 - 紧急干预
    if (probability >= 0.5) return 'high';       // 高风险 - 主动挽留
    if (probability >= 0.3) return 'medium';     // 中风险 - 持续关注
    return 'low';                                 // 低风险 - 正常维护
  }

  // 特征标准化
  async normalizeFeatures(features) {
    // 从 Redis 获取特征统计信息（均值、标准差）
    const stats = await this.redis.hgetall('model:feature_stats');
    
    return Object.keys(features).map(key => {
      const value = features[key];
      const mean = parseFloat(stats[`${key}:mean`] || 0);
      const std = parseFloat(stats[`${key}:std`] || 1);
      return (value - mean) / std;
    });
  }

  // 模型训练（离线批处理）
  async trainModel(trainingData, labels) {
    const xs = tf.tensor2d(trainingData);
    const ys = tf.tensor2d(labels);
    
    await this.model.fit(xs, ys, {
      epochs: 100,
      batchSize: 256,
      validationSplit: 0.2,
      callbacks: {
        onEpochEnd: async (epoch, logs) => {
          if (epoch % 10 === 0) {
            console.log(`Epoch ${epoch}: loss=${logs.loss.toFixed(4)}, acc=${logs.acc.toFixed(4)}`);
          }
        }
      }
    });
    
    xs.dispose();
    ys.dispose();
  }

  // 保存模型
  async saveModel(path) {
    await this.model.save(`file://${path}`);
  }

  // 加载模型
  async loadModel(path) {
    this.model = await tf.loadLayersModel(`file://${path}/model.json`);
  }
}

module.exports = ChurnPredictionModel;
```

### 3. 流失原因分析

```javascript
// backend/shared/churnPredictor/ChurnReasonAnalyzer.js
class ChurnReasonAnalyzer {
  constructor() {
    this.reasonPatterns = {
      social_isolation: {
        weight: 0.25,
        conditions: [
          { feature: 'friends_count', threshold: 3, operator: '<' },
          { feature: 'social_isolation_score', threshold: 60, operator: '>' },
          { feature: 'guild_member', value: false },
        ]
      },
      progress_stagnation: {
        weight: 0.30,
        conditions: [
          { feature: 'progress_stagnation_days', threshold: 7, operator: '>' },
          { feature: 'pokemon_caught_7d', threshold: 5, operator: '<' },
          { feature: 'level_progress_pct', threshold: 10, operator: '<' },
        ]
      },
      economic_barrier: {
        weight: 0.20,
        conditions: [
          { feature: 'is_paying_user', value: false },
          { feature: 'coins_balance', threshold: 100, operator: '<' },
          { feature: 'daily_task_completion_rate', threshold: 0.3, operator: '<' },
        ]
      },
      difficulty_frustration: {
        weight: 0.15,
        conditions: [
          { feature: 'catch_success_rate_7d', threshold: 0.3, operator: '<' },
          { feature: 'gym_battles_win_rate', threshold: 0.3, operator: '<' },
        ]
      },
      technical_issues: {
        weight: 0.10,
        conditions: [
          { feature: 'crash_count_7d', threshold: 5, operator: '>' },
          { feature: 'network_error_rate', threshold: 0.1, operator: '>' },
        ]
      }
    };
  }

  // 分析流失原因
  analyzeReasons(features) {
    const reasons = [];
    
    for (const [reason, pattern] of Object.entries(this.reasonPatterns)) {
      const matchedConditions = pattern.conditions.filter(cond => 
        this.evaluateCondition(features, cond)
      );
      
      if (matchedConditions.length >= Math.ceil(pattern.conditions.length / 2)) {
        const confidence = matchedConditions.length / pattern.conditions.length;
        reasons.push({
          reason,
          weight: pattern.weight,
          confidence,
          matchedConditions,
          impact: pattern.weight * confidence,
        });
      }
    }
    
    // 按影响力排序
    reasons.sort((a, b) => b.impact - a.impact);
    
    return {
      primaryReason: reasons[0]?.reason || 'unknown',
      allReasons: reasons,
      explanation: this.generateExplanation(reasons),
    };
  }

  // 评估条件
  evaluateCondition(features, condition) {
    const value = features[condition.feature];
    
    if (condition.operator) {
      switch (condition.operator) {
        case '<': return value < condition.threshold;
        case '>': return value > condition.threshold;
        case '<=': return value <= condition.threshold;
        case '>=': return value >= condition.threshold;
        case '==': return value === condition.threshold;
      }
    }
    
    if ('value' in condition) {
      return value === condition.value;
    }
    
    return false;
  }

  // 生成可读解释
  generateExplanation(reasons) {
    const explanations = {
      social_isolation: '玩家缺乏社交互动，未建立稳定的社交关系网络',
      progress_stagnation: '玩家遭遇进度瓶颈，缺乏明确的游戏目标',
      economic_barrier: '玩家面临经济压力，无法通过游戏内货币获取所需资源',
      difficulty_frustration: '游戏难度过高，挫败感积累影响游戏体验',
      technical_issues: '技术问题影响游戏体验（崩溃、网络延迟等）',
    };
    
    return reasons.slice(0, 3).map(r => ({
      reason: r.reason,
      explanation: explanations[r.reason],
      confidence: r.confidence,
    }));
  }
}

module.exports = ChurnReasonAnalyzer;
```

### 4. 智能挽留策略引擎

```javascript
// backend/shared/churnPredictor/RetentionStrategyEngine.js
const { Kafka } = require('kafkajs');

class RetentionStrategyEngine {
  constructor() {
    this.kafka = new Kafka({ brokers: process.env.KAFKA_BROKERS.split(',') });
    this.producer = this.kafka.producer();
    
    // 策略库
    this.strategies = {
      social_isolation: [
        {
          name: 'friend_recommendation',
          action: 'recommend_friends',
          params: { count: 5, criteria: 'nearby_activity' },
          priority: 1,
        },
        {
          name: 'guild_invitation',
          action: 'invite_to_guild',
          params: { target_guilds: 'active_nearby' },
          priority: 2,
        },
        {
          name: 'social_bonus',
          action: 'grant_social_rewards',
          params: { reward_type: 'friend_invite_bonus' },
          priority: 3,
        },
      ],
      progress_stagnation: [
        {
          name: 'exp_boost',
          action: 'grant_temporary_boost',
          params: { boost_type: 'exp', multiplier: 2, duration_hours: 48 },
          priority: 1,
        },
        {
          name: 'rare_spawn_nearby',
          action: 'spawn_rare_pokemon',
          params: { rarity: 'rare', radius_km: 2 },
          priority: 2,
        },
        {
          name: 'quest_guidance',
          action: 'show_personalized_quest',
          params: { quest_type: 'achievable' },
          priority: 3,
        },
      ],
      economic_barrier: [
        {
          name: 'login_bonus',
          action: 'grant_daily_bonus',
          params: { coins: 500, premium_currency: 10 },
          priority: 1,
        },
        {
          name: 'discount_offer',
          action: 'send_discount_coupon',
          params: { discount_pct: 30, valid_days: 7 },
          priority: 2,
        },
        {
          name: 'free_lootbox',
          action: 'grant_free_lootbox',
          params: { tier: 'silver' },
          priority: 3,
        },
      ],
      difficulty_frustration: [
        {
          name: 'catch_assist',
          action: 'enable_catch_assist',
          params: { bonus_throw_pct: 20, duration_hours: 24 },
          priority: 1,
        },
        {
          name: 'tutorial_hint',
          action: 'show_contextual_tutorial',
          params: { topic: 'catching_techniques' },
          priority: 2,
        },
        {
          name: 'easy_gym',
          action: 'highlight_easy_gyms',
          params: { max_defender_cp: 1000 },
          priority: 3,
        },
      ],
      technical_issues: [
        {
          name: 'compensation',
          action: 'grant_technical_compensation',
          params: { coins: 1000, items: ['stardust', 'rare_candy'] },
          priority: 1,
        },
        {
          name: 'support_ticket',
          action: 'create_support_ticket',
          params: { priority: 'high', category: 'technical' },
          priority: 2,
        },
      ],
    };
  }

  // 选择最优策略
  selectStrategy(userId, churnAnalysis) {
    const { riskLevel, reasons } = churnAnalysis;
    
    // 根据风险等级确定干预强度
    const intensity = {
      critical: { strategies: 3, immediate: true },
      high: { strategies: 2, immediate: true },
      medium: { strategies: 1, immediate: false },
      low: { strategies: 0, immediate: false },
    }[riskLevel];
    
    if (intensity.strategies === 0) {
      return null;
    }
    
    // 选择策略
    const selectedStrategies = [];
    const primaryReason = reasons.allReasons[0]?.reason;
    const strategyPool = this.strategies[primaryReason] || [];
    
    for (let i = 0; i < Math.min(intensity.strategies, strategyPool.length); i++) {
      const strategy = strategyPool[i];
      selectedStrategies.push({
        ...strategy,
        triggeredAt: new Date().toISOString(),
        reason: primaryReason,
      });
    }
    
    return {
      userId,
      riskLevel,
      intensity,
      strategies: selectedStrategies,
      scheduledAt: intensity.immediate ? 'immediate' : this.scheduleOptimalTime(userId),
    };
  }

  // 调度最佳触发时间
  scheduleOptimalTime(userId) {
    // 基于用户历史活跃时段
    // 简化：返回下次黄金时段
    const now = new Date();
    const evening = new Date(now);
    evening.setHours(19, 0, 0, 0);
    
    if (now < evening) {
      return evening.toISOString();
    }
    
    // 已过今日19点，安排明日早间
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    return tomorrow.toISOString();
  }

  // 执行挽留策略
  async executeStrategy(strategyPlan) {
    await this.producer.connect();
    
    for (const strategy of strategyPlan.strategies) {
      const event = {
        type: 'retention.action',
        userId: strategyPlan.userId,
        action: strategy.action,
        params: strategy.params,
        reason: strategy.reason,
        triggeredAt: strategyPlan.scheduledAt,
        trackingId: `${strategyPlan.userId}-${strategy.name}-${Date.now()}`,
      };
      
      await this.producer.send({
        topic: 'retention.actions',
        messages: [{ value: JSON.stringify(event) }],
      });
    }
    
    await this.producer.disconnect();
    
    return {
      success: true,
      executedAt: new Date().toISOString(),
      strategyCount: strategyPlan.strategies.length,
    };
  }
}

module.exports = RetentionStrategyEngine;
```

### 5. 挽留效果追踪系统

```javascript
// backend/shared/churnPredictor/RetentionTracker.js
const { Pool } = require('pg');

class RetentionTracker {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  // 记录挽留行动
  async logRetentionAction(action) {
    const query = `
      INSERT INTO retention_actions (
        tracking_id, user_id, action_type, action_params,
        reason, risk_level, triggered_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    `;
    
    await this.db.query(query, [
      action.trackingId,
      action.userId,
      action.action,
      JSON.stringify(action.params),
      action.reason,
      action.riskLevel,
      action.triggeredAt,
    ]);
  }

  // 更新挽留效果
  async trackOutcome(trackingId, outcome) {
    const query = `
      UPDATE retention_actions
      SET 
        status = $2,
        outcome = $3,
        completed_at = NOW()
      WHERE tracking_id = $1
    `;
    
    await this.db.query(query, [
      trackingId,
      outcome.status, // 'successful', 'failed', 'ignored'
      JSON.stringify(outcome),
    ]);
  }

  // 计算策略效果指标
  async calculateEffectiveness(days = 30) {
    const query = `
      WITH strategy_outcomes AS (
        SELECT 
          action_type,
          COUNT(*) FILTER (WHERE status = 'successful') as successful_count,
          COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
          COUNT(*) FILTER (WHERE status = 'ignored') as ignored_count,
          COUNT(*) as total_count,
          AVG(
            EXTRACT(EPOCH FROM (
              SELECT user_last_activity - triggered_at
              FROM user_activity_log ual
              WHERE ual.user_id = ra.user_id
              AND ual.activity_type = 'login'
              AND ual.occurred_at > ra.triggered_at
              ORDER BY ual.occurred_at ASC
              LIMIT 1
            )) / 3600
          ) FILTER (WHERE status = 'successful') as avg_hours_to_return
        FROM retention_actions ra
        WHERE triggered_at > NOW() - INTERVAL '${days} days'
        GROUP BY action_type
      )
      SELECT 
        action_type,
        successful_count,
        failed_count,
        ignored_count,
        total_count,
        ROUND(successful_count::numeric / NULL(total_count, 1) * 100, 2) as success_rate,
        ROUND(avg_hours_to_return, 2) as avg_hours_to_return
      FROM strategy_outcomes
      ORDER BY success_rate DESC
    `;
    
    const result = await this.db.query(query);
    return result.rows;
  }

  // 计算整体挽留系统 ROI
  async calculateROI() {
    const query = `
      SELECT 
        COUNT(DISTINCT user_id) as users_retained,
        AVG(predicted_ltv_before) as avg_predicted_ltv_before,
        AVG(actual_ltv_after) as avg_actual_ltv_after,
        SUM(cost_of_retention) as total_retention_cost,
        SUM(additional_revenue) as total_additional_revenue,
        ROUND(
          (SUM(additional_revenue) - SUM(cost_of_retention)) / 
          NULL(SUM(cost_of_retention), 1) * 100, 2
        ) as roi_percentage
      FROM retention_roi_summary
      WHERE period = 'last_30_days'
    `;
    
    const result = await this.db.query(query);
    return result.rows[0];
  }
}

module.exports = RetentionTracker;
```

### 6. 数据库迁移

```sql
-- database/migrations/20260701_04_retention_system.sql

-- 流失预测结果表
CREATE TABLE churn_predictions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  model_version VARCHAR(20) NOT NULL,
  predicted_at TIMESTAMP NOT NULL,
  churn_prob_7d DECIMAL(5,4),
  churn_prob_14d DECIMAL(5,4),
  churn_prob_30d DECIMAL(5,4),
  risk_level VARCHAR(20) NOT NULL,
  features JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_churn_predictions_user ON churn_predictions(user_id, predicted_at DESC);

-- 流失原因分析表
CREATE TABLE churn_reasons (
  id SERIAL PRIMARY KEY,
  prediction_id INTEGER REFERENCES churn_predictions(id),
  user_id UUID NOT NULL,
  primary_reason VARCHAR(50) NOT NULL,
  all_reasons JSONB,
  explanation JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 挽留行动记录表
CREATE TABLE retention_actions (
  id SERIAL PRIMARY KEY,
  tracking_id VARCHAR(100) UNIQUE NOT NULL,
  user_id UUID NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  action_params JSONB,
  reason VARCHAR(50) NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  triggered_at TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  outcome JSONB,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_retention_actions_user ON retention_actions(user_id, triggered_at DESC);
CREATE INDEX idx_retention_actions_status ON retention_actions(status);

-- 挽留效果追踪表
CREATE TABLE retention_outcomes (
  id SERIAL PRIMARY KEY,
  action_id INTEGER REFERENCES retention_actions(id),
  user_id UUID NOT NULL,
  did_return BOOLEAN,
  return_after_hours DECIMAL(10,2),
  session_count_after INTEGER,
  activity_score_after DECIMAL(10,4),
  days_active_after INTEGER,
  converted_to_paying BOOLEAN,
  additional_revenue DECIMAL(10,2),
  tracked_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 特征统计缓存表（用于模型标准化）
CREATE TABLE feature_statistics (
  feature_name VARCHAR(100) PRIMARY KEY,
  mean_value DECIMAL(20,6),
  std_value DECIMAL(20,6),
  min_value DECIMAL(20,6),
  max_value DECIMAL(20,6),
  last_updated TIMESTAMP DEFAULT NOW()
);

-- 挽留 ROI 汇总表
CREATE TABLE retention_roi_summary (
  id SERIAL PRIMARY KEY,
  period VARCHAR(50) NOT NULL,
  users_retained INTEGER,
  avg_predicted_ltv_before DECIMAL(10,2),
  avg_actual_ltv_after DECIMAL(10,2),
  cost_of_retention DECIMAL(12,2),
  additional_revenue DECIMAL(12,2),
  roi_percentage DECIMAL(10,2),
  calculated_at TIMESTAMP DEFAULT NOW()
);
```

### 7. 定时预测任务

```javascript
// backend/jobs/churnPredictionJob.js
const cron = require('node-cron');
const FeatureCollector = require('../shared/churnPredictor/FeatureCollector');
const ChurnPredictionModel = require('../shared/churnPredictor/ChurnModel');
const ChurnReasonAnalyzer = require('../shared/churnPredictor/ChurnReasonAnalyzer');
const RetentionStrategyEngine = require('../shared/churnPredictor/RetentionStrategyEngine');
const { Pool } = require('pg');

class ChurnPredictionJob {
  constructor() {
    this.featureCollector = new FeatureCollector();
    this.model = new ChurnPredictionModel();
    this.reasonAnalyzer = new ChurnReasonAnalyzer();
    this.strategyEngine = new RetentionStrategyEngine();
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  // 每日全量预测
  async runDailyPrediction() {
    console.log('Starting daily churn prediction...');
    
    // 获取活跃用户列表（过去30天登录过）
    const query = `
      SELECT DISTINCT user_id 
      FROM user_sessions 
      WHERE last_login > NOW() - INTERVAL '30 days'
      AND user_id NOT IN (
        SELECT user_id FROM churn_predictions 
        WHERE predicted_at > NOW() - INTERVAL '24 hours'
      )
    `;
    
    const result = await this.db.query(query);
    const users = result.rows;
    
    console.log(`Processing ${users.length} users...`);
    
    let batchResults = {
      total: users.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    
    // 批量处理
    for (const { user_id } of users) {
      try {
        // 采集特征
        const features = await this.featureCollector.collectUserFeatures(user_id);
        
        // 预测流失风险
        const prediction = await this.model.predict(user_id, features);
        
        // 分析流失原因
        const analysis = this.reasonAnalyzer.analyzeReasons(features);
        
        // 保存预测结果
        await this.savePrediction(user_id, prediction, analysis);
        
        // 高风险用户触发挽留策略
        if (['critical', 'high'].includes(prediction.riskLevel)) {
          const strategy = this.strategyEngine.selectStrategy(user_id, {
            ...prediction,
            reasons: analysis,
          });
          
          if (strategy) {
            await this.strategyEngine.executeStrategy(strategy);
          }
        }
        
        // 统计
        batchResults[prediction.riskLevel]++;
        
      } catch (err) {
        console.error(`Error processing user ${user_id}:`, err.message);
      }
    }
    
    console.log('Daily prediction completed:', batchResults);
    return batchResults;
  }

  // 保存预测结果
  async savePrediction(userId, prediction, analysis) {
    const query = `
      INSERT INTO churn_predictions (
        user_id, model_version, predicted_at,
        churn_prob_7d, churn_prob_14d, churn_prob_30d,
        risk_level, features
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `;
    
    const result = await this.db.query(query, [
      userId,
      prediction.modelVersion,
      prediction.predictedAt,
      prediction.probabilities.churn_7d,
      prediction.probabilities.churn_14d,
      prediction.probabilities.churn_30d,
      prediction.riskLevel,
      JSON.stringify(prediction.features),
    ]);
    
    // 保存原因分析
    await this.db.query(`
      INSERT INTO churn_reasons (
        prediction_id, user_id, primary_reason, all_reasons, explanation
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      result.rows[0].id,
      userId,
      analysis.primaryReason,
      JSON.stringify(analysis.allReasons),
      JSON.stringify(analysis.explanation),
    ]);
  }

  // 启动定时任务
  start() {
    // 每日凌晨 2:00 UTC 运行
    cron.schedule('0 2 * * *', () => {
      this.runDailyPrediction().catch(console.error);
    });
    
    console.log('Churn prediction job scheduled (daily at 02:00 UTC)');
  }
}

module.exports = ChurnPredictionJob;
```

## 验收标准

- [ ] 流失预测模型 AUC 达到 0.85+，准确率达到 80%+
- [ ] 7天流失预测准确率不低于 75%，30天不低于 85%
- [ ] 支持实时特征更新，延迟不超过 5 秒
- [ ] 高风险玩家识别率达到 90%+
- [ ] 挽留策略触发延迟不超过 1 小时
- [ ] 运营仪表板展示流失风险分布、挽留效果指标
- [ ] 支持 A/B 测试不同挽留策略的效果
- [ ] 系统整体可用性达到 99.5%
- [ ] API 响应时间 P95 < 500ms

## 影响范围

- 新增数据库表：churn_predictions, churn_reasons, retention_actions, retention_outcomes
- 新增共享模块：backend/shared/churnPredictor/*
- 新增定时任务：backend/jobs/churnPredictionJob.js
- 新增 Kafka 消费者：特征采集服务
- 新增 API 端点：
  - GET /api/admin/churn/predictions - 预测结果查询
  - GET /api/admin/churn/risk-distribution - 风险分布统计
  - GET /api/admin/retention/effectiveness - 挽留效果分析
  - POST /api/admin/retention/manual-trigger - 手动触发挽留
- 更新运营仪表板：新增流失预警模块

## 参考

- [TensorFlow.js 文档](https://www.tensorflow.org/js)
- [游戏流失预测最佳实践](https://www.gamasutra.com/blogs)
- [机器学习模型可解释性](https://christophm.github.io/interpretable-ml-book/)
- [玩家生命周期价值计算](https://www.gameanalytics.com/blog)
