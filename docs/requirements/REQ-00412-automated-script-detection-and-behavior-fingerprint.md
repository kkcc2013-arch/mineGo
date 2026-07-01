# REQ-00412：游戏自动化脚本检测与行为指纹识别系统

- **编号**：REQ-00412
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、catch-service、gym-service、backend/shared、game-client、admin-dashboard、database/migrations
- **创建时间**：2026-07-01 14:00 UTC
- **依赖需求**：REQ-00010（GPS伪造检测）、REQ-00100（自动化脚本检测）

## 1. 背景与问题

当前 mineGo 已实现基础的反作弊机制：
- GPS 伪造检测（REQ-00010）：检测位置伪造和速度异常
- 基础自动化脚本检测（REQ-00100）：检测简单的自动化工具

然而，作弊者正在使用更高级的技术：
1. **高级自动化脚本**：使用 OCR、图像识别、AI 自动化的脚本难以检测
2. **行为模拟器**：模拟真实用户操作模式，绕过简单规则
3. **设备指纹伪造**：修改设备标识信息
4. **分布式攻击**：从多个 IP/设备发起攻击，规避单一阈值
5. **智能规避**：根据检测阈值动态调整行为参数

当前系统的不足：
- 缺少细粒度行为分析：无法识别复杂的行为模式
- 单一维度检测：未结合多维度数据综合判断
- 缺少机器学习模型：依赖规则引擎，易被绕过
- 缺少实时阻断能力：检测滞后，损失已发生

## 2. 目标

建立多层级行为分析系统，通过以下能力提升反作弊水平：
1. **行为指纹识别**：建立用户行为基线，识别异常偏离
2. **多维度特征融合**：整合点击、滑动、陀螺仪、GPS、时间等多维数据
3. **机器学习模型**：训练行为分类模型，识别自动化脚本特征
4. **实时风险评分**：对每次操作实时计算风险分数
5. **智能阻断策略**：根据风险等级动态触发不同强度的防护措施

预期收益：
- 自动化脚本检测准确率提升 40%+
- 误判率降低至 0.1% 以下
- 检测延迟 < 100ms
- 覆盖 95% 以上的作弊场景

## 3. 范围

### 包含
- 用户行为数据采集 SDK（game-client）
- 行为特征提取引擎（backend/shared）
- 机器学习模型训练与推理服务
- 实时风险评分系统
- 多层级阻断策略管理器
- 行为分析仪表板（admin-dashboard）
- 历史行为数据分析与回溯
- 自适应阈值动态调整

### 不包含
- 客户端加固（单独需求）
- 服务器端代码混淆
- 第三方反作弊 SDK 集成

## 4. 详细需求

### 4.1 行为数据采集 SDK

```javascript
// frontend/game-client/src/security/BehaviorCollector.js

class BehaviorCollector {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 100; // Hz
    this.bufferSize = options.bufferSize || 1000;
    this.features = new Map();
    this.initCollectors();
  }

  initCollectors() {
    // 触摸事件采集器
    this.touchCollector = new TouchEventCollector({
      sampleRate: this.sampleRate,
      features: ['position', 'pressure', 'duration', 'interval', 'trajectory']
    });

    // 陀螺仪采集器
    this.gyroscopeCollector = new GyroscopeCollector({
      sampleRate: this.sampleRate,
      features: ['rotation', 'acceleration', 'orientation']
    });

    // 操作序列采集器
    this.actionSequenceCollector = new ActionSequenceCollector({
      features: ['actionType', 'targetElement', 'timestamp', 'context']
    });

    // 网络行为采集器
    this.networkBehaviorCollector = new NetworkBehaviorCollector({
      features: ['requestPattern', 'responseTime', 'errorCode']
    });
  }

  // 收集行为指纹
  collectFingerprint() {
    return {
      deviceId: this.getDeviceId(),
      sessionId: this.getSessionId(),
      timestamp: Date.now(),
      
      // 触摸特征
      touch: {
        avgSpeed: this.calculateTouchSpeed(),
        pressureVariance: this.calculatePressureVariance(),
        trajectorySmoothness: this.calculateTrajectorySmoothness(),
        tapInterval: this.calculateTapInterval()
      },
      
      // 陀螺仪特征
      gyroscope: {
        rotationVariance: this.calculateRotationVariance(),
        steadyStateRatio: this.calculateSteadyStateRatio(),
        naturalMovementScore: this.calculateNaturalMovement()
      },
      
      // 操作模式
      actionPattern: {
        actionFrequency: this.calculateActionFrequency(),
        sequenceEntropy: this.calculateSequenceEntropy(),
        reactionTime: this.calculateReactionTime()
      },
      
      // 设备指纹
      device: {
        canvas: this.getCanvasFingerprint(),
        webgl: this.getWebGLFingerprint(),
        audio: this.getAudioFingerprint(),
        fonts: this.getFontList()
      }
    };
  }

  // 计算触摸速度特征
  calculateTouchSpeed() {
    const events = this.touchCollector.getRecentEvents(100);
    if (events.length < 2) return 0;
    
    const speeds = [];
    for (let i = 1; i < events.length; i++) {
      const dx = events[i].x - events[i-1].x;
      const dy = events[i].y - events[i-1].y;
      const dt = events[i].timestamp - events[i-1].timestamp;
      if (dt > 0) {
        speeds.push(Math.sqrt(dx*dx + dy*dy) / dt);
      }
    }
    
    return {
      mean: this.mean(speeds),
      variance: this.variance(speeds),
      max: Math.max(...speeds),
      distribution: this.histogram(speeds, 10)
    };
  }

  // 计算轨迹平滑度（自然人类轨迹的平滑度）
  calculateTrajectorySmoothness() {
    const trajectory = this.touchCollector.getTrajectory();
    if (trajectory.length < 5) return 1;
    
    // 计算轨迹的贝塞尔曲线拟合误差
    const bezierFit = this.fitBezierCurve(trajectory);
    const error = this.calculateFittingError(trajectory, bezierFit);
    
    // 自然轨迹拟合误差通常较小
    // 自动化脚本通常是直线，拟合误差也小但模式不同
    return {
      bezierError: error,
      linearity: this.calculateLinearity(trajectory),
      curvatureVariance: this.calculateCurvatureVariance(trajectory)
    };
  }

  // 行为熵值计算（衡量操作序列的随机性）
  calculateSequenceEntropy() {
    const sequence = this.actionSequenceCollector.getSequence(100);
    const frequency = new Map();
    
    for (const action of sequence) {
      const key = `${action.type}:${action.target}`;
      frequency.set(key, (frequency.get(key) || 0) + 1);
    }
    
    let entropy = 0;
    const total = sequence.length;
    for (const count of frequency.values()) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
    
    return entropy;
  }
}

export default BehaviorCollector;
```

### 4.2 行为特征分析引擎

```javascript
// backend/shared/behavior/BehaviorAnalyzer.js

class BehaviorAnalyzer {
  constructor(config = {}) {
    this.models = new Map();
    this.userBaselines = new Map();
    this.riskThresholds = config.thresholds || this.getDefaultThresholds();
    this.loadModels();
  }

  async loadModels() {
    // 加载预训练模型
    this.models.set('touch', await this.loadTensorFlowModel('touch_model.h5'));
    this.models.set('sequence', await this.loadTensorFlowModel('sequence_model.h5'));
    this.models.set('fusion', await this.loadTensorFlowModel('fusion_model.h5'));
  }

  // 分析行为并返回风险评分
  async analyze(behaviorData) {
    const features = await this.extractFeatures(behaviorData);
    const baseline = await this.getUserBaseline(behaviorData.userId);
    
    // 多模型融合分析
    const touchScore = await this.analyzeTouchBehavior(features.touch, baseline.touch);
    const sequenceScore = await this.analyzeSequencePattern(features.sequence, baseline.sequence);
    const deviceScore = await this.analyzeDeviceFingerprint(features.device);
    
    // 融合评分
    const fusionScore = await this.fusionAnalysis({
      touch: touchScore,
      sequence: sequenceScore,
      device: deviceScore,
      context: features.context
    });
    
    return {
      riskScore: fusionScore.score,
      confidence: fusionScore.confidence,
      signals: {
        touch: touchScore.signals,
        sequence: sequenceScore.signals,
        device: deviceScore.signals
      },
      recommendation: this.generateRecommendation(fusionScore),
      timestamp: Date.now()
    };
  }

  // 触摸行为分析
  async analyzeTouchBehavior(touchFeatures, baseline) {
    const model = this.models.get('touch');
    
    // 异常信号检测
    const signals = [];
    
    // 速度异常（自动化脚本可能过快或过于均匀）
    const speedAnomaly = this.detectSpeedAnomaly(touchFeatures.avgSpeed, baseline.avgSpeed);
    if (speedAnomaly.score > 0.7) {
      signals.push({
        type: 'SPEED_ANOMALY',
        score: speedAnomaly.score,
        detail: speedAnomaly.detail
      });
    }
    
    // 轨迹异常（自动化脚本轨迹过于规则）
    const trajectoryAnomaly = this.detectTrajectoryAnomaly(
      touchFeatures.trajectorySmoothness,
      baseline.trajectorySmoothness
    );
    if (trajectoryAnomaly.score > 0.6) {
      signals.push({
        type: 'TRAJECTORY_ANOMALY',
        score: trajectoryAnomaly.score,
        detail: trajectoryAnomaly.detail
      });
    }
    
    // 点击间隔异常（自动化脚本间隔过于规律）
    const intervalAnomaly = this.detectIntervalAnomaly(
      touchFeatures.tapInterval,
      baseline.tapInterval
    );
    if (intervalAnomaly.score > 0.7) {
      signals.push({
        type: 'INTERVAL_ANOMALY',
        score: intervalAnomaly.score,
        detail: intervalAnomaly.detail
      });
    }
    
    // 使用深度学习模型进行综合评分
    const mlScore = await model.predict(this.normalizeFeatures(touchFeatures));
    
    const combinedScore = this.combineScores(signals, mlScore);
    
    return {
      score: combinedScore,
      signals: signals,
      mlScore: mlScore
    };
  }

  // 操作序列分析
  async analyzeSequencePattern(sequenceFeatures, baseline) {
    const model = this.models.get('sequence');
    const signals = [];
    
    // 序列熵值异常（自动化脚本熵值通常较低）
    const entropyAnomaly = this.detectEntropyAnomaly(
      sequenceFeatures.sequenceEntropy,
      baseline.sequenceEntropy
    );
    if (entropyAnomaly.score > 0.6) {
      signals.push({
        type: 'LOW_ENTROPY',
        score: entropyAnomaly.score,
        detail: '操作序列过于规律，疑似自动化脚本'
      });
    }
    
    // 反应时间异常
    const reactionAnomaly = this.detectReactionAnomaly(
      sequenceFeatures.reactionTime,
      baseline.reactionTime
    );
    if (reactionAnomaly.score > 0.7) {
      signals.push({
        type: 'REACTION_ANOMALY',
        score: reactionAnomaly.score,
        detail: reactionAnomaly.detail
      });
    }
    
    // 操作频率异常
    const frequencyAnomaly = this.detectFrequencyAnomaly(
      sequenceFeatures.actionFrequency,
      baseline.actionFrequency
    );
    if (frequencyAnomaly.score > 0.6) {
      signals.push({
        type: 'FREQUENCY_ANOMALY',
        score: frequencyAnomaly.score,
        detail: frequencyAnomaly.detail
      });
    }
    
    const mlScore = await model.predict(this.normalizeFeatures(sequenceFeatures));
    const combinedScore = this.combineScores(signals, mlScore);
    
    return {
      score: combinedScore,
      signals: signals,
      mlScore: mlScore
    };
  }

  // 设备指纹分析
  async analyzeDeviceFingerprint(deviceFeatures) {
    const signals = [];
    
    // 检测虚拟机/模拟器特征
    const emulatorIndicators = this.detectEmulatorIndicators(deviceFeatures);
    if (emulatorIndicators.score > 0.5) {
      signals.push({
        type: 'EMULATOR_DETECTED',
        score: emulatorIndicators.score,
        detail: emulatorIndicators.indicators
      });
    }
    
    // 检测设备指纹伪造
    const spoofingIndicators = this.detectFingerprintSpoofing(deviceFeatures);
    if (spoofingIndicators.score > 0.5) {
      signals.push({
        type: 'FINGERPRINT_SPOOFING',
        score: spoofingIndicators.score,
        detail: spoofingIndicators.indicators
      });
    }
    
    // 检测设备一致性（与历史记录对比）
    const consistencyScore = await this.checkDeviceConsistency(deviceFeatures);
    if (consistencyScore.anomaly > 0.6) {
      signals.push({
        type: 'DEVICE_INCONSISTENCY',
        score: consistencyScore.anomaly,
        detail: consistencyScore.detail
      });
    }
    
    const combinedScore = Math.max(...signals.map(s => s.score), 0);
    
    return {
      score: combinedScore,
      signals: signals
    };
  }

  // 融合分析
  async fusionAnalysis(scores) {
    const model = this.models.get('fusion');
    
    // 构建融合特征向量
    const fusionFeatures = [
      scores.touch.score,
      scores.sequence.score,
      scores.device.score,
      this.encodeContext(scores.context),
      this.calculateCrossCorrelation(scores)
    ];
    
    const mlScore = await model.predict(fusionFeatures);
    
    // 加权融合
    const weights = {
      touch: 0.35,
      sequence: 0.35,
      device: 0.15,
      ml: 0.15
    };
    
    const weightedScore = 
      weights.touch * scores.touch.score +
      weights.sequence * scores.sequence.score +
      weights.device * scores.device.score +
      weights.ml * mlScore;
    
    return {
      score: Math.min(weightedScore, 1.0),
      confidence: this.calculateConfidence(scores)
    };
  }

  // 生成处置建议
  generateRecommendation(score) {
    if (score.score < 0.3) {
      return { action: 'allow', reason: '正常用户行为' };
    } else if (score.score < 0.5) {
      return { 
        action: 'monitor', 
        reason: '行为轻微异常，继续监控',
        monitoring: 'enhanced'
      };
    } else if (score.score < 0.7) {
      return { 
        action: 'challenge', 
        reason: '行为异常，需要人机验证',
        challengeType: 'captcha'
      };
    } else if (score.score < 0.9) {
      return { 
        action: 'throttle', 
        reason: '高度疑似作弊，限制操作频率',
        throttleRate: 0.5
      };
    } else {
      return { 
        action: 'block', 
        reason: '确认作弊行为，临时封禁',
        blockDuration: 3600
      };
    }
  }
}

export default BehaviorAnalyzer;
```

### 4.3 实时风险评分中间件

```javascript
// backend/shared/middleware/behaviorRiskMiddleware.js

import BehaviorAnalyzer from '../behavior/BehaviorAnalyzer.js';
import { Redis } from '../cache/RedisClient.js';
import logger from '../logger.js';

class BehaviorRiskMiddleware {
  constructor() {
    this.analyzer = new BehaviorAnalyzer();
    this.redis = new Redis();
    this.actionConfigs = this.loadActionConfigs();
  }

  loadActionConfigs() {
    // 不同操作的风险阈值配置
    return {
      'catch_pokemon': { threshold: 0.5, action: 'challenge' },
      'battle_gym': { threshold: 0.6, action: 'challenge' },
      'trade_pokemon': { threshold: 0.4, action: 'challenge' },
      'claim_reward': { threshold: 0.7, action: 'throttle' },
      'spin_pokestop': { threshold: 0.8, action: 'throttle' }
    };
  }

  async middleware(req, res, next) {
    const startTime = Date.now();
    const userId = req.user?.id;
    const action = this.identifyAction(req);
    
    if (!action || !userId) {
      return next();
    }
    
    try {
      // 获取行为数据
      const behaviorData = req.body.behaviorData || req.headers['x-behavior-fingerprint'];
      
      if (!behaviorData) {
        // 无行为数据时的处理
        logger.warn('Missing behavior data', { userId, action });
        return next();
      }
      
      // 分析行为
      const analysis = await this.analyzer.analyze({
        ...behaviorData,
        userId,
        action,
        context: {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          timestamp: Date.now()
        }
      });
      
      // 记录分析结果
      await this.recordAnalysis(userId, action, analysis);
      
      // 附加风险信息到请求
      req.behaviorRisk = analysis;
      
      // 判断是否需要处置
      const config = this.actionConfigs[action];
      if (config && analysis.riskScore >= config.threshold) {
        return this.handleRisk(req, res, next, analysis, config);
      }
      
      // 更新用户基线
      await this.updateUserBaseline(userId, behaviorData);
      
      next();
      
    } catch (error) {
      logger.error('Behavior analysis error', { error, userId });
      next(); // 失败时放行，避免影响正常用户
    }
  }

  async handleRisk(req, res, next, analysis, config) {
    const { action } = analysis.recommendation;
    
    switch (action) {
      case 'challenge':
        // 需要 CAPTCHA 验证
        return res.status(202).json({
          requiresChallenge: true,
          challengeType: 'captcha',
          riskScore: analysis.riskScore,
          challengeToken: await this.generateChallengeToken(req.user.id)
        });
        
      case 'throttle':
        // 限流
        req.rateLimit = { multiplier: 0.5 };
        next();
        break;
        
      case 'block':
        // 临时封禁
        await this.temporaryBlock(req.user.id, analysis.recommendation.blockDuration);
        return res.status(429).json({
          error: 'TEMPORARILY_BLOCKED',
          message: '检测到异常行为，请稍后重试',
          retryAfter: analysis.recommendation.blockDuration
        });
        
      case 'monitor':
        // 增强监控
        req.enhancedMonitoring = true;
        next();
        break;
        
      default:
        next();
    }
  }

  async recordAnalysis(userId, action, analysis) {
    const key = `behavior:analysis:${userId}:${Date.now()}`;
    await this.redis.hset(key, {
      action,
      riskScore: analysis.riskScore,
      signals: JSON.stringify(analysis.signals),
      timestamp: Date.now()
    });
    await this.redis.expire(key, 86400 * 7); // 保留7天
    
    // 累计统计
    await this.redis.hincrby(`behavior:stats:${userId}:${new Date().toISOString().split('T')[0]}`, action, 1);
  }

  async updateUserBaseline(userId, behaviorData) {
    // 增量更新用户行为基线
    const key = `behavior:baseline:${userId}`;
    const baseline = await this.redis.hgetall(key) || {};
    
    // 使用指数移动平均更新基线
    const alpha = 0.1;
    
    if (behaviorData.touch) {
      baseline.touchAvgSpeed = this.ema(baseline.touchAvgSpeed, behaviorData.touch.avgSpeed, alpha);
      baseline.touchSmoothness = this.ema(baseline.touchSmoothness, behaviorData.touch.trajectorySmoothness, alpha);
    }
    
    if (behaviorData.actionPattern) {
      baseline.sequenceEntropy = this.ema(baseline.sequenceEntropy, behaviorData.actionPattern.sequenceEntropy, alpha);
    }
    
    await this.redis.hset(key, baseline);
    await this.redis.expire(key, 86400 * 30); // 保留30天
  }

  ema(oldValue, newValue, alpha) {
    if (!oldValue) return newValue;
    return alpha * newValue + (1 - alpha) * parseFloat(oldValue);
  }
}

export default BehaviorRiskMiddleware;
```

### 4.4 数据库迁移

```sql
-- database/migrations/050_behavior_analysis_tables.sql

-- 行为分析记录表
CREATE TABLE behavior_analysis_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    risk_score DECIMAL(5,4) NOT NULL,
    confidence DECIMAL(5,4),
    signals JSONB,
    recommendation JSONB,
    ip_address INET,
    user_agent TEXT,
    device_fingerprint JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_behavior_analysis_user_time ON behavior_analysis_logs(user_id, created_at DESC);
CREATE INDEX idx_behavior_analysis_risk ON behavior_analysis_logs(risk_score DESC) WHERE risk_score > 0.5;
CREATE INDEX idx_behavior_analysis_action ON behavior_analysis_logs(action, created_at);

-- 用户行为基线表
CREATE TABLE user_behavior_baselines (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    touch_avg_speed DECIMAL(10,4),
    touch_smoothness DECIMAL(10,4),
    sequence_entropy DECIMAL(10,4),
    reaction_time_avg INTEGER,
    action_frequency JSONB,
    device_fingerprints JSONB,
    sample_count INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 行为黑名单表
CREATE TABLE behavior_blacklist (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    device_fingerprint TEXT,
    reason TEXT NOT NULL,
    risk_score DECIMAL(5,4),
    blocked_until TIMESTAMP,
    is_permanent BOOLEAN DEFAULT FALSE,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_blacklist_user ON behavior_blacklist(user_id) WHERE blocked_until > CURRENT_TIMESTAMP OR is_permanent;
CREATE INDEX idx_blacklist_device ON behavior_blacklist(device_fingerprint);

-- 行为规则配置表
CREATE TABLE behavior_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    rule_type VARCHAR(50) NOT NULL, -- 'threshold', 'pattern', 'ml'
    description TEXT,
    parameters JSONB NOT NULL,
    action VARCHAR(20) NOT NULL, -- 'challenge', 'throttle', 'block'
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 50,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO behavior_rules (rule_name, rule_type, description, parameters, action, priority) VALUES
('speed_anomaly', 'threshold', '触摸速度异常检测', '{"threshold": 3, "window": 60}', 'challenge', 60),
('entropy_low', 'threshold', '操作序列熵值过低', '{"threshold": 1.5, "min_samples": 50}', 'challenge', 70),
('emulator_detected', 'pattern', '检测到模拟器特征', '{"indicators": ["vm", "root", "hook"]}', 'block', 90),
('interval_regular', 'ml', '点击间隔过于规律', '{"model": "interval_classifier"}', 'throttle', 50);
```

### 4.5 管理 API

```javascript
// backend/services/gateway/routes/admin/behaviorRoutes.js

import express from 'express';
import { requireAdmin, requirePermission } from '../../../shared/middleware/auth.js';
import BehaviorAnalyzer from '../../../shared/behavior/BehaviorAnalyzer.js';
import { Redis } from '../../../shared/cache/RedisClient.js';
import logger from '../../../shared/logger.js';

const router = express.Router();

// 获取用户行为分析报告
router.get('/users/:userId/behavior-report', 
  requirePermission('behavior:view'), 
  async (req, res) => {
    const { userId } = req.params;
    const { days = 7 } = req.query;
    
    const report = await generateBehaviorReport(userId, parseInt(days));
    res.json(report);
  }
);

// 获取行为分析统计
router.get('/stats', requirePermission('behavior:view'), async (req, res) => {
  const { startDate, endDate, action } = req.query;
  
  const stats = await getBehaviorStats(startDate, endDate, action);
  res.json(stats);
});

// 管理黑名单
router.post('/blacklist', requirePermission('behavior:manage'), async (req, res) => {
  const { userId, deviceFingerprint, reason, duration, isPermanent } = req.body;
  
  const entry = await addToBlacklist({
    userId,
    deviceFingerprint,
    reason,
    duration,
    isPermanent,
    createdBy: req.user.id
  });
  
  logger.info('User added to behavior blacklist', { entry, by: req.user.id });
  res.status(201).json(entry);
});

router.delete('/blacklist/:id', requirePermission('behavior:manage'), async (req, res) => {
  await removeFromBlacklist(req.params.id);
  res.status(204).end();
});

// 更新行为规则
router.put('/rules/:ruleId', requirePermission('behavior:manage'), async (req, res) => {
  const { ruleId } = req.params;
  const updates = req.body;
  
  const rule = await updateBehaviorRule(ruleId, updates);
  res.json(rule);
});

// 获取高风险用户列表
router.get('/high-risk-users', requirePermission('behavior:view'), async (req, res) => {
  const { threshold = 0.7, limit = 100 } = req.query;
  
  const users = await getHighRiskUsers(parseFloat(threshold), parseInt(limit));
  res.json(users);
});

// 导出行为分析数据
router.get('/export', requirePermission('behavior:export'), async (req, res) => {
  const { format = 'csv', startDate, endDate } = req.query;
  
  const data = await exportBehaviorData(startDate, endDate);
  
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="behavior_analysis.csv"');
    res.send(data);
  } else {
    res.json(data);
  }
});

export default router;
```

## 5. 验收标准（可测试）

- [ ] 行为数据采集 SDK 正确采集触摸、陀螺仪、操作序列数据
- [ ] 触摸速度异常检测准确率 >= 85%，误判率 <= 0.1%
- [ ] 操作序列熵值计算正确，能有效识别低熵值自动化脚本
- [ ] 设备指纹检测能识别模拟器特征（如 BlueStacks、Nox、LDPlayer）
- [ ] 实时风险评分延迟 < 100ms（P95）
- [ ] 风险阈值配置生效，能根据不同操作设置不同阈值
- [ ] 验证码挑战机制正常工作，挑战通过后可继续操作
- [ ] 黑名单功能正常，封禁用户无法进行关键操作
- [ ] 管理 API 正常工作，管理员可查看行为分析报告
- [ ] 行为分析仪表板展示实时统计数据
- [ ] 用户行为基线自适应更新正常
- [ ] Prometheus 指标正确暴露：检测次数、风险分布、阻断次数

## 6. 工作量估算

**L**（2-3 周）

理由：
- 涉及客户端 SDK、服务端分析引擎、机器学习模型
- 需要大量数据标注和模型训练工作
- 需要实时系统优化确保低延迟
- 需要与现有反作弊系统集成

## 7. 优先级理由

P1 理由：
1. **作弊影响严重**：自动化脚本严重破坏游戏公平性和经济系统
2. **现有能力不足**：基础规则引擎已无法应对高级作弊技术
3. **用户体验保护**：需要精确检测减少对正常用户的误判
4. **长期投资价值**：机器学习模型可持续优化，长期收益高
5. **合规要求**：部分地区的公平游戏法规要求反作弊能力
