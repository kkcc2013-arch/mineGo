# REQ-00354: 玩家行为漏斗分析与流失预警系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00354 |
| 标题 | 玩家行为漏斗分析与流失预警系统 |
| 类别 | 运营/数据分析 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、backend/shared、backend/jobs、admin-dashboard、database/migrations、Kafka、Redis |
| 创建时间 | 2026-06-29 03:00 UTC |

## 需求描述

构建玩家行为漏斗分析系统，实时追踪玩家在关键业务流程中的转化率，识别流失节点；结合机器学习模型预测玩家流失风险，支持运营团队提前介入挽留，提升玩家留存率与生命周期价值（LTV）。

### 核心功能
1. **行为漏斗定义与追踪**
   - 可配置的多阶段漏斗模型（注册→首次捕捉→首次战斗→好友添加→首次付费→活跃玩家）
   - 实时计算各阶段转化率与流失率
   - 漏斗耗时分析（各阶段平均停留时间）
   - 漏斗细分维度（设备、地区、渠道、精灵等级段等）

2. **流失风险预测**
   - 基于历史数据的机器学习流失预测模型
   - 实时计算每位玩家的流失风险评分（0-100）
   - 风险因素分析（最近登录间隔、活跃度下降、社交互动减少、付费频率降低等）
   - 高风险玩家自动标记与告警

3. **预警与干预建议**
   - 可配置的流失预警规则（风险评分阈值、触发条件）
   - 智能干预建议生成（推送优惠、专属任务、好友召回等）
   - 干预效果追踪与闭环分析
   - A/B 测试支持验证干预策略有效性

4. **可视化与报表**
   - 漏斗可视化图表（阶段转化率、耗时分布）
   - 流失风险热力图与趋势分析
   - 关键指标仪表板（DAU、MAU、次日留存、7日留存、30日留存）
   - 自动化日报/周报生成与推送

## 技术方案

### 1. 数据采集层

**事件埋点规范**
```javascript
// backend/shared/analytics/EventSchema.js
const FLOW_EVENTS = {
  // 注册流程
  'registration_initiated': { required: ['device_id', 'channel'] },
  'registration_completed': { required: ['user_id', 'device_id'] },
  
  // 捕捉流程
  'first_catch_initiated': { required: ['user_id', 'pokemon_id', 'location'] },
  'first_catch_completed': { required: ['user_id', 'pokemon_id', 'success'] },
  
  // 战斗流程
  'first_battle_initiated': { required: ['user_id', 'gym_id', 'pokemon_ids'] },
  'first_battle_completed': { required: ['user_id', 'gym_id', 'result'] },
  
  // 社交流程
  'first_friend_added': { required: ['user_id', 'friend_id'] },
  
  // 付费流程
  'first_payment_initiated': { required: ['user_id', 'amount', 'currency'] },
  'first_payment_completed': { required: ['user_id', 'transaction_id'] },
  
  // 活跃行为
  'daily_login': { required: ['user_id'] },
  'session_start': { required: ['user_id', 'device_id'] },
  'session_end': { required: ['user_id', 'duration_seconds'] }
};

// 事件发送中间件
class AnalyticsMiddleware {
  constructor(kafkaProducer) {
    this.producer = kafkaProducer;
    this.eventBuffer = [];
    this.flushInterval = 5000; // 5秒批量发送
  }
  
  async trackEvent(eventType, eventData) {
    const event = {
      event_type: eventType,
      event_data: eventData,
      timestamp: Date.now(),
      user_id: eventData.user_id,
      session_id: eventData.session_id
    };
    
    this.eventBuffer.push(event);
    
    if (this.eventBuffer.length >= 100) {
      await this.flush();
    }
  }
  
  async flush() {
    if (this.eventBuffer.length === 0) return;
    
    const messages = this.eventBuffer.map(event => ({
      topic: 'player-behavior-events',
      key: event.user_id,
      value: JSON.stringify(event)
    }));
    
    await this.producer.sendBatch(messages);
    this.eventBuffer = [];
  }
}
```

### 2. 漏斗计算引擎

**漏斗定义与计算**
```javascript
// backend/jobs/funnel/FunnelEngine.js
class FunnelEngine {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
  }
  
  // 预定义漏斗模型
  static FUNNEL_DEFINITIONS = {
    'new_player_journey': {
      name: '新手玩家转化漏斗',
      stages: [
        { event: 'registration_completed', name: '注册完成' },
        { event: 'first_catch_completed', name: '首次捕捉', time_limit: 24 * 3600 },
        { event: 'first_battle_completed', name: '首次战斗', time_limit: 72 * 3600 },
        { event: 'first_friend_added', name: '首次加好友', time_limit: 168 * 3600 },
        { event: 'first_payment_completed', name: '首次付费', time_limit: 720 * 3600 }
      ]
    },
    
    'daily_active_funnel': {
      name: '日活跃漏斗',
      stages: [
        { event: 'daily_login', name: '登录' },
        { event: 'session_start', name: '开始游戏' },
        { event: 'catch_initiated', name: '尝试捕捉', time_limit: 3600 },
        { event: 'battle_initiated', name: '尝试战斗', time_limit: 3600 },
        { event: 'social_interaction', name: '社交互动', time_limit: 3600 }
      ]
    }
  };
  
  // 计算漏斗转化率
  async calculateFunnelConversion(funnelId, startDate, endDate) {
    const funnel = this.constructor.FUNNEL_DEFINITIONS[funnelId];
    if (!funnel) throw new Error('Funnel not found');
    
    const results = {
      funnel_id: funnelId,
      funnel_name: funnel.name,
      period: { start: startDate, end: endDate },
      stages: [],
      overall_conversion: 0
    };
    
    let previousStageUsers = null;
    let totalUsers = 0;
    
    for (let i = 0; i < funnel.stages.length; i++) {
      const stage = funnel.stages[i];
      
      // 获取该阶段完成用户
      const stageUsers = await this.getUsersCompletedEvent(
        stage.event,
        startDate,
        endDate,
        previousStageUsers,
        stage.time_limit
      );
      
      const stageCount = stageUsers.size;
      
      if (i === 0) {
        totalUsers = stageCount;
      }
      
      const conversionFromPrevious = i === 0 ? 100 : 
        (previousStageUsers ? (stageCount / previousStageUsers.size * 100) : 0);
      
      results.stages.push({
        stage_name: stage.name,
        event: stage.event,
        user_count: stageCount,
        conversion_from_previous: conversionFromPrevious,
        conversion_from_start: (stageCount / totalUsers * 100)
      });
      
      previousStageUsers = stageUsers;
    }
    
    results.overall_conversion = results.stages[results.stages.length - 1].conversion_from_start;
    
    return results;
  }
  
  // 获取完成特定事件的用户集合
  async getUsersCompletedEvent(eventType, startDate, endDate, previousUsers, timeLimit) {
    const query = `
      SELECT DISTINCT user_id
      FROM player_events
      WHERE event_type = $1
        AND timestamp >= $2
        AND timestamp <= $3
        ${previousUsers ? 'AND user_id = ANY($4)' : ''}
    `;
    
    const params = [eventType, startDate, endDate];
    if (previousUsers) {
      params.push(Array.from(previousUsers));
    }
    
    const result = await this.db.query(query, params);
    
    if (timeLimit && previousUsers) {
      // 应用时间限制：从上一阶段到当前阶段的时间差
      const timeFilteredUsers = await this.applyTimeLimit(
        previousUsers,
        eventType,
        timeLimit,
        startDate
      );
      return timeFilteredUsers;
    }
    
    return new Set(result.rows.map(r => r.user_id));
  }
  
  // 应用时间限制
  async applyTimeLimit(previousUsers, eventType, timeLimit, startDate) {
    const query = `
      WITH previous_events AS (
        SELECT user_id, MIN(timestamp) as first_event
        FROM player_events
        WHERE user_id = ANY($1)
          AND timestamp >= $2
        GROUP BY user_id
      ),
      current_events AS (
        SELECT user_id, MIN(timestamp) as first_event
        FROM player_events
        WHERE event_type = $3
          AND timestamp >= $2
        GROUP BY user_id
      )
      SELECT p.user_id
      FROM previous_events p
      JOIN current_events c ON p.user_id = c.user_id
      WHERE (c.first_event - p.first_event) <= $4
    `;
    
    const result = await this.db.query(query, [
      Array.from(previousUsers),
      startDate,
      eventType,
      timeLimit
    ]);
    
    return new Set(result.rows.map(r => r.user_id));
  }
}
```

### 3. 流失预测模型

**特征工程与预测**
```javascript
// backend/shared/ml/ChurnPredictionModel.js
const TensorFlow = require('@tensorflow/tfjs-node');

class ChurnPredictionModel {
  constructor() {
    this.model = null;
    this.featureExtractor = new FeatureExtractor();
    this.modelPath = './models/churn-prediction';
  }
  
  // 特征提取
  extractPlayerFeatures(playerId, timeWindow = 30) {
    return {
      // 活跃度特征
      login_days_last_7: 0, // 过去7天登录天数
      login_days_last_30: 0, // 过去30天登录天数
      avg_session_duration: 0, // 平均会话时长（分钟）
      max_inactive_days: 0, // 最大未登录天数
      
      // 社交特征
      friends_count: 0, // 好友数量
      social_interactions_7d: 0, // 7天内社交互动次数
      guild_active: false, // 是否活跃公会成员
      
      // 游戏行为特征
      catches_7d: 0, // 7天内捕捉次数
      battles_7d: 0, // 7天内战斗次数
      pokemon_count: 0, // 精灵总数
      avg_pokemon_level: 0, // 平均精灵等级
      
      // 付费特征
      total_payments: 0, // 累计付费金额
      payment_frequency: 0, // 付费频率
      last_payment_days: 0, // 距上次付费天数
      is_payer: false, // 是否付费玩家
      
      // 进度特征
      achievements_completed: 0, // 完成成就数
      quests_completed_7d: 0, // 7天完成任务数
      level_progress_rate: 0, // 等级进度速率
      
      // 时间特征
      days_since_registration: 0, // 注册天数
      last_active_hours: 0 // 距上次活跃小时数
    };
  }
  
  // 构建神经网络模型
  buildModel(inputSize) {
    const model = TensorFlow.sequential();
    
    model.add(TensorFlow.layers.dense({
      units: 64,
      activation: 'relu',
      inputShape: [inputSize],
      kernelRegularizer: TensorFlow.regularizers.l2({ l2: 0.01 })
    }));
    
    model.add(TensorFlow.layers.dropout({ rate: 0.3 }));
    
    model.add(TensorFlow.layers.dense({
      units: 32,
      activation: 'relu',
      kernelRegularizer: TensorFlow.regularizers.l2({ l2: 0.01 })
    }));
    
    model.add(TensorFlow.layers.dropout({ rate: 0.2 }));
    
    model.add(TensorFlow.layers.dense({
      units: 16,
      activation: 'relu'
    }));
    
    model.add(TensorFlow.layers.dense({
      units: 1,
      activation: 'sigmoid' // 输出流失概率 0-1
    }));
    
    model.compile({
      optimizer: TensorFlow.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy', 'auc']
    });
    
    this.model = model;
    return model;
  }
  
  // 预测流失风险
  async predictChurnRisk(playerId) {
    const features = await this.featureExtractor.extract(playerId);
    const featureVector = this.normalizeFeatures(features);
    
    const inputTensor = TensorFlow.tensor2d([featureVector]);
    const prediction = this.model.predict(inputTensor);
    const churnProbability = (await prediction.data())[0];
    
    inputTensor.dispose();
    prediction.dispose();
    
    return {
      player_id: playerId,
      churn_probability: churnProbability,
      risk_level: this.classifyRiskLevel(churnProbability),
      risk_factors: this.analyzeRiskFactors(features)
    };
  }
  
  // 风险等级分类
  classifyRiskLevel(probability) {
    if (probability >= 0.7) return 'high';
    if (probability >= 0.4) return 'medium';
    return 'low';
  }
  
  // 风险因素分析
  analyzeRiskFactors(features) {
    const factors = [];
    
    if (features.login_days_last_7 < 3) {
      factors.push({
        factor: 'low_activity',
        description: '近7天登录少于3次',
        severity: 'high'
      });
    }
    
    if (features.max_inactive_days > 5) {
      factors.push({
        factor: 'long_absence',
        description: '存在超过5天未登录',
        severity: 'medium'
      });
    }
    
    if (features.social_interactions_7d < 2 && features.friends_count > 0) {
      factors.push({
        factor: 'social_decline',
        description: '社交互动减少',
        severity: 'medium'
      });
    }
    
    if (features.is_payer && features.last_payment_days > 60) {
      factors.push({
        factor: 'payment_decline',
        description: '付费玩家超过60天未付费',
        severity: 'high'
      });
    }
    
    return factors;
  }
}
```

### 4. 预警与干预系统

**预警规则引擎**
```javascript
// backend/jobs/alerts/ChurnAlertEngine.js
class ChurnAlertEngine {
  constructor(db, redis, notificationService) {
    this.db = db;
    this.redis = redis;
    this.notificationService = notificationService;
  }
  
  // 预警规则定义
  static ALERT_RULES = [
    {
      id: 'high_churn_risk',
      name: '高流失风险预警',
      condition: (data) => data.churn_probability >= 0.7,
      severity: 'critical',
      actions: ['immediate_intervention', 'manager_notification']
    },
    {
      id: 'medium_churn_risk',
      name: '中流失风险预警',
      condition: (data) => data.churn_probability >= 0.4 && data.churn_probability < 0.7,
      severity: 'warning',
      actions: ['scheduled_intervention', 'team_notification']
    },
    {
      id: 'activity_drop',
      name: '活跃度骤降预警',
      condition: (data) => data.activity_trend === 'sharp_decline',
      severity: 'warning',
      actions: ['engagement_campaign']
    }
  ];
  
  // 检查预警规则
  async checkAlertRules(playerId, playerData) {
    const triggeredAlerts = [];
    
    for (const rule of this.constructor.ALERT_RULES) {
      if (rule.condition(playerData)) {
        const alert = {
          rule_id: rule.id,
          rule_name: rule.name,
          player_id: playerId,
          severity: rule.severity,
          triggered_at: new Date(),
          player_data: playerData
        };
        
        triggeredAlerts.push(alert);
        
        // 执行预警动作
        await this.executeAlertActions(rule.actions, alert);
      }
    }
    
    return triggeredAlerts;
  }
  
  // 执行预警动作
  async executeAlertActions(actions, alert) {
    for (const action of actions) {
      switch (action) {
        case 'immediate_intervention':
          await this.triggerImmediateIntervention(alert);
          break;
        case 'scheduled_intervention':
          await this.scheduleIntervention(alert);
          break;
        case 'manager_notification':
          await this.sendManagerNotification(alert);
          break;
        case 'team_notification':
          await this.sendTeamNotification(alert);
          break;
        case 'engagement_campaign':
          await this.triggerEngagementCampaign(alert);
          break;
      }
    }
  }
  
  // 立即干预
  async triggerImmediateIntervention(alert) {
    // 根据风险因素生成个性化干预建议
    const intervention = await this.generateIntervention(alert);
    
    await this.db.query(`
      INSERT INTO churn_interventions 
        (player_id, intervention_type, details, status, created_at)
      VALUES ($1, $2, $3, 'pending', NOW())
    `, [alert.player_id, intervention.type, JSON.stringify(intervention)]);
    
    // 触发推送通知
    await this.notificationService.sendPush(alert.player_id, {
      title: intervention.title,
      body: intervention.message,
      deep_link: intervention.deep_link
    });
  }
  
  // 生成干预建议
  async generateIntervention(alert) {
    const riskFactors = alert.player_data.risk_factors;
    
    if (riskFactors.some(f => f.factor === 'low_activity')) {
      return {
        type: 'welcome_back_bonus',
        title: '我们想你了！',
        message: '回归即送稀有精灵蛋一枚！',
        deep_link: 'minego://rewards/claim',
        reward: { type: 'pokemon_egg', rarity: 'rare' }
      };
    }
    
    if (riskFactors.some(f => f.factor === 'social_decline')) {
      return {
        type: 'friend_activity',
        title: '你的好友在等你',
        message: '查看好友最新动态，一起探索吧！',
        deep_link: 'minego://friends/activity',
        reward: { type: 'coins', amount: 100 }
      };
    }
    
    if (riskFactors.some(f => f.factor === 'payment_decline')) {
      return {
        type: 'vip_offer',
        title: 'VIP专属优惠',
        message: '尊享5折特惠礼包，限时72小时',
        deep_link: 'minego://shop/vip',
        discount: 0.5
      };
    }
    
    return {
      type: 'general_retention',
      title: '探索新区域',
      message: '发现新的精灵栖息地，立即出发！',
      deep_link: 'minego://map/new'
    };
  }
}
```

### 5. 数据库设计

**事件表与汇总表**
```sql
-- database/migrations/035_churn_analytics_tables.sql

-- 玩家事件原始表（分区表）
CREATE TABLE player_events (
  id BIGSERIAL,
  user_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB,
  session_id UUID,
  device_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (timestamp);

-- 按月分区
CREATE TABLE player_events_2026_06 PARTITION OF player_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE player_events_2026_07 PARTITION OF player_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 索引
CREATE INDEX idx_player_events_user_time ON player_events (user_id, timestamp);
CREATE INDEX idx_player_events_type_time ON player_events (event_type, timestamp);
CREATE INDEX idx_player_events_session ON player_events (session_id);

-- 漏斗分析结果表
CREATE TABLE funnel_analysis_results (
  id BIGSERIAL PRIMARY KEY,
  funnel_id VARCHAR(50) NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  stages_data JSONB NOT NULL,
  overall_conversion DECIMAL(5,2),
  total_users INTEGER,
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_funnel_results_period ON funnel_analysis_results (funnel_id, period_start);

-- 玩家流失风险评估表
CREATE TABLE player_churn_assessments (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  assessment_date DATE NOT NULL,
  churn_probability DECIMAL(5,4) NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  risk_factors JSONB,
  feature_vector JSONB,
  model_version VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, assessment_date)
);

CREATE INDEX idx_churn_user_date ON player_churn_assessments (user_id, assessment_date);
CREATE INDEX idx_churn_risk_date ON player_churn_assessments (risk_level, assessment_date);

-- 流失干预记录表
CREATE TABLE churn_interventions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  intervention_type VARCHAR(50) NOT NULL,
  details JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  triggered_by_rule VARCHAR(50),
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  effectiveness_score DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_interventions_user ON churn_interventions (user_id);
CREATE INDEX idx_interventions_status ON churn_interventions (status, created_at);

-- 漏斗定义表
CREATE TABLE funnel_definitions (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  stages JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入预定义漏斗
INSERT INTO funnel_definitions (id, name, description, stages) VALUES
('new_player_journey', '新手玩家转化漏斗', '追踪新手玩家从注册到活跃的全流程', 
 '[{"event":"registration_completed","name":"注册完成"},{"event":"first_catch_completed","name":"首次捕捉","time_limit":86400},{"event":"first_battle_completed","name":"首次战斗","time_limit":259200},{"event":"first_friend_added","name":"首次加好友","time_limit":604800},{"event":"first_payment_completed","name":"首次付费","time_limit":2592000}]'::jsonb),
 
('daily_active_funnel', '日活跃漏斗', '追踪玩家每日活跃行为',
 '[{"event":"daily_login","name":"登录"},{"event":"session_start","name":"开始游戏"},{"event":"catch_initiated","name":"尝试捕捉","time_limit":3600},{"event":"battle_initiated","name":"尝试战斗","time_limit":3600}]'::jsonb);
```

### 6. 定时任务

**批量计算任务**
```javascript
// backend/jobs/scheduled/ChurnAnalysisJobs.js
const { CronJob } = require('cron');

class ChurnAnalysisJobs {
  constructor(funnelEngine, churnModel, alertEngine) {
    this.funnelEngine = funnelEngine;
    this.churnModel = churnModel;
    this.alertEngine = alertEngine;
  }
  
  // 每日流失风险评估
  startDailyChurnAssessment() {
    return new CronJob('0 2 * * *', async () => {
      console.log('Starting daily churn assessment...');
      
      // 获取所有活跃玩家
      const activePlayers = await this.getActivePlayers(30); // 30天内有登录
      
      // 批量预测流失风险
      const batchSize = 100;
      for (let i = 0; i < activePlayers.length; i += batchSize) {
        const batch = activePlayers.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (player) => {
          const assessment = await this.churnModel.predictChurnRisk(player.user_id);
          
          // 保存评估结果
          await this.saveAssessment(assessment);
          
          // 检查预警规则
          if (assessment.risk_level !== 'low') {
            await this.alertEngine.checkAlertRules(player.user_id, assessment);
          }
        }));
        
        console.log(`Processed ${Math.min(i + batchSize, activePlayers.length)} / ${activePlayers.length} players`);
      }
      
      console.log('Daily churn assessment completed');
    });
  }
  
  // 每日漏斗分析
  startDailyFunnelAnalysis() {
    return new CronJob('0 3 * * *', async () => {
      console.log('Starting daily funnel analysis...');
      
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const startDate = new Date(yesterday.setHours(0, 0, 0, 0));
      const endDate = new Date(yesterday.setHours(23, 59, 59, 999));
      
      // 计算所有漏斗
      for (const funnelId of Object.keys(FunnelEngine.FUNNEL_DEFINITIONS)) {
        const result = await this.funnelEngine.calculateFunnelConversion(
          funnelId,
          startDate,
          endDate
        );
        
        // 保存结果
        await this.saveFunnelResult(result);
      }
      
      console.log('Daily funnel analysis completed');
    });
  }
  
  // 每周模型重训练
  startWeeklyModelRetraining() {
    return new CronJob('0 4 * * 0', async () => {
      console.log('Starting weekly model retraining...');
      
      // 准备训练数据
      const trainingData = await this.prepareTrainingData();
      
      // 重训练模型
      await this.churnModel.train(trainingData);
      
      // 验证模型性能
      const metrics = await this.churnModel.validate();
      
      // 如果新模型更好，则部署
      if (metrics.auc > 0.75) {
        await this.churnModel.save();
        console.log('Model retrained and deployed successfully');
      } else {
        console.log('Model performance below threshold, keeping previous model');
      }
    });
  }
  
  // 获取活跃玩家
  async getActivePlayers(days) {
    const query = `
      SELECT DISTINCT user_id
      FROM player_events
      WHERE event_type = 'daily_login'
        AND timestamp >= NOW() - INTERVAL '${days} days'
    `;
    
    const result = await this.db.query(query);
    return result.rows;
  }
}

module.exports = { ChurnAnalysisJobs };
```

### 7. 可视化 API

**仪表板数据接口**
```javascript
// user-service/routes/analytics.js
const express = require('express');
const router = express.Router();

// 获取漏斗分析结果
router.get('/funnel/:funnelId', async (req, res) => {
  const { funnelId } = req.params;
  const { period = '7d' } = req.query;
  
  const daysBack = period === '30d' ? 30 : period === '7d' ? 7 : 1;
  
  const query = `
    SELECT 
      period_start,
      stages_data,
      overall_conversion,
      total_users
    FROM funnel_analysis_results
    WHERE funnel_id = $1
      AND period_start >= NOW() - INTERVAL '${daysBack} days'
    ORDER BY period_start DESC
  `;
  
  const result = await req.db.query(query, [funnelId]);
  
  res.json({
    funnel_id: funnelId,
    period: period,
    data: result.rows
  });
});

// 获取流失风险分布
router.get('/churn/risk-distribution', async (req, res) => {
  const query = `
    SELECT 
      risk_level,
      COUNT(*) as player_count,
      AVG(churn_probability) as avg_probability
    FROM player_churn_assessments
    WHERE assessment_date = CURRENT_DATE
    GROUP BY risk_level
    ORDER BY 
      CASE risk_level 
        WHEN 'high' THEN 1 
        WHEN 'medium' THEN 2 
        ELSE 3 
      END
  `;
  
  const result = await req.db.query(query);
  
  res.json({
    date: new Date().toISOString().split('T')[0],
    distribution: result.rows
  });
});

// 获取高风险玩家列表
router.get('/churn/high-risk-players', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  
  const query = `
    SELECT 
      ca.user_id,
      ca.churn_probability,
      ca.risk_factors,
      u.username,
      u.level,
      u.last_login_at,
      u.total_payments
    FROM player_churn_assessments ca
    JOIN users u ON ca.user_id = u.id
    WHERE ca.assessment_date = CURRENT_DATE
      AND ca.risk_level = 'high'
    ORDER BY ca.churn_probability DESC
    LIMIT $1 OFFSET $2
  `;
  
  const result = await req.db.query(query, [limit, offset]);
  
  res.json({
    players: result.rows,
    total: result.rowCount
  });
});

// 获取干预效果统计
router.get('/interventions/effectiveness', async (req, res) => {
  const { period = '30d' } = req.query;
  
  const query = `
    SELECT 
      intervention_type,
      COUNT(*) as total_sent,
      COUNT(CASE WHEN responded_at IS NOT NULL THEN 1 END) as responded,
      AVG(effectiveness_score) as avg_effectiveness
    FROM churn_interventions
    WHERE created_at >= NOW() - INTERVAL '${period.replace('d', ' days')}'
    GROUP BY intervention_type
  `;
  
  const result = await req.db.query(query);
  
  res.json({
    period: period,
    interventions: result.rows
  });
});

// 获取留存率趋势
router.get('/retention/trend', async (req, res) => {
  const { days = 30 } = req.query;
  
  const query = `
    WITH daily_cohorts AS (
      SELECT 
        DATE(created_at) as cohort_date,
        COUNT(DISTINCT user_id) as new_users
      FROM users
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
    ),
    retained_users AS (
      SELECT 
        DATE(u.created_at) as cohort_date,
        COUNT(DISTINCT CASE WHEN pe.timestamp >= u.created_at + INTERVAL '1 day' 
                           AND pe.timestamp < u.created_at + INTERVAL '2 days' 
                           THEN u.user_id END) as day1_retained,
        COUNT(DISTINCT CASE WHEN pe.timestamp >= u.created_at + INTERVAL '7 days' 
                           AND pe.timestamp < u.created_at + INTERVAL '8 days' 
                           THEN u.user_id END) as day7_retained,
        COUNT(DISTINCT CASE WHEN pe.timestamp >= u.created_at + INTERVAL '30 days' 
                           AND pe.timestamp < u.created_at + INTERVAL '31 days' 
                           THEN u.user_id END) as day30_retained
      FROM users u
      LEFT JOIN player_events pe ON u.user_id = pe.user_id
      WHERE u.created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(u.created_at)
    )
    SELECT 
      dc.cohort_date,
      dc.new_users,
      ru.day1_retained,
      ru.day7_retained,
      ru.day30_retained,
      ROUND(ru.day1_retained::DECIMAL / NULLIF(dc.new_users, 0) * 100, 2) as day1_retention_rate,
      ROUND(ru.day7_retained::DECIMAL / NULLIF(dc.new_users, 0) * 100, 2) as day7_retention_rate,
      ROUND(ru.day30_retained::DECIMAL / NULLIF(dc.new_users, 0) * 100, 2) as day30_retention_rate
    FROM daily_cohorts dc
    LEFT JOIN retained_users ru ON dc.cohort_date = ru.cohort_date
    ORDER BY dc.cohort_date DESC
  `;
  
  const result = await req.db.query(query);
  
  res.json({
    period_days: days,
    retention_data: result.rows
  });
});

module.exports = router;
```

## 验收标准

- [ ] 实现玩家行为事件采集系统，支持至少 20 种事件类型
- [ ] 构建至少 3 个预定义漏斗模型，支持自定义漏斗配置
- [ ] 流失预测模型 AUC 达到 0.75 以上
- [ ] 每日自动评估所有活跃玩家流失风险，完成时间 < 2 小时
- [ ] 高风险玩家预警实时触发，延迟 < 5 分钟
- [ ] 干预建议生成准确率 > 80%（基于历史干预响应率）
- [ ] 提供完整的可视化仪表板，包括漏斗图、风险分布图、留存趋势图
- [ ] 支持 API 查询漏斗分析、流失风险评估、干预效果等数据
- [ ] 数据库查询性能：漏斗查询 < 5s，风险评估列表 < 2s
- [ ] 实现定时任务：每日评估、每日漏斗分析、每周模型重训练

## 影响范围

- **新增服务**：backend/jobs（漏斗计算、流失预测、预警触发）
- **修改服务**：
  - user-service（新增分析 API 路由）
  - gateway（新增分析端点代理）
  - 所有微服务（集成事件埋点中间件）
- **新增文件**：
  - backend/shared/analytics/EventSchema.js
  - backend/shared/analytics/AnalyticsMiddleware.js
  - backend/jobs/funnel/FunnelEngine.js
  - backend/shared/ml/ChurnPredictionModel.js
  - backend/jobs/alerts/ChurnAlertEngine.js
  - backend/jobs/scheduled/ChurnAnalysisJobs.js
  - database/migrations/035_churn_analytics_tables.sql
- **配置变更**：Kafka 新增 `player-behavior-events` topic

## 参考

- [Google Analytics for Firebase - Funnel Analysis](https://firebase.google.com/docs/analytics)
- [Churn Prediction using Machine Learning](https://www.sciencedirect.com/science/article/pii/S187705091830832X)
- [TensorFlow.js - Node.js](https://www.tensorflow.org/js/guide/nodejs)
- [PostgreSQL Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Retention Cohort Analysis Best Practices](https://amplitude.com/blog/cohort-analysis)
