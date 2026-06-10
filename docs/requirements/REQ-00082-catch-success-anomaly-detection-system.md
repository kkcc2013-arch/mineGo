# REQ-00082：精灵捕捉成功率异常检测系统

- **编号**：REQ-00082
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：catch-service、gateway、backend/shared/anti-cheat.js、Redis、PostgreSQL
- **创建时间**：2026-06-10 07:00
- **依赖需求**：REQ-00010（GPS伪造检测）、REQ-00028（行为异常检测）

## 1. 背景与问题

当前 mineGo 已实现 GPS 伪造检测（REQ-00010）、行为异常检测（REQ-00028）、设备完整性检测（REQ-00045）等反作弊系统，但**精灵捕捉环节仍存在作弊风险**：

### 现实痛点
1. **异常成功率作弊**：部分玩家通过修改客户端数据、使用外挂工具等方式，人为提高捕捉成功率（如将 5% 稀有精灵捕捉率提升至 95%+）
2. **捕捉数据篡改**：客户端上报的捕捉结果可能被篡改（如捕捉球数量、精灵 CP 值、捕捉坐标等）
3. **批量刷精灵**：利用脚本自动捕捉，短时间内大量捕捉精灵
4. **道具异常使用**：修改道具效果（如高级球当普通球用、无限使用道具）

### 数据现状
- 正常玩家稀有精灵捕捉成功率：5-15%
- 作弊玩家异常捕捉成功率：可达 80%+
- 日均捕捉请求数：约 500 万次
- 异常捕捉占比（估算）：2-5%

### 风险影响
- 破坏游戏公平性，导致正常玩家流失
- 影响游戏经济系统（稀有精灵泛滥贬值）
- 损害游戏口碑与营收

## 2. 目标

建立精灵捕捉成功率异常检测系统，**阻止 90%+ 的捕捉成功率作弊行为**，同时将误判率控制在 0.5% 以内。

### 核心收益
1. **公平性保障**：稀有精灵捕捉成功率恢复至正常水平
2. **数据完整性**：客户端上报数据完整性验证，防止篡改
3. **作弊威慑**：实时检测 + 快速封禁，形成有效威慑
4. **运营数据**：提供捕捉行为分析数据，辅助运营决策

## 3. 范围

### 包含
- 捕捉成功率统计与异常检测（分精灵稀有度、道具类型、玩家等级）
- 捕捉请求数据完整性验证（签名、时间戳、坐标）
- 批量捕捉行为检测（频率、模式识别）
- 道具使用异常检测（道具数量、效果异常）
- 实时风控决策引擎（通过/警告/拒绝）
- 捕捉行为审计日志与可视化分析

### 不包含
- 支付相关反作弊（已在 REQ-00003 实现）
- 交易反作弊（已在 REQ-00018 实现）
- GPS 伪造检测（已在 REQ-00010 实现）
- 设备完整性检测（已在 REQ-00045 实现）

## 4. 详细需求

### 4.1 捕捉成功率统计系统

#### 数据模型
```sql
-- 捕捉成功率统计表（按小时维度）
CREATE TABLE catch_success_stats (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  pokemon_id VARCHAR(64) NOT NULL,
  pokemon_rarity VARCHAR(32) NOT NULL, -- common/rare/epic/legendary
  ball_type VARCHAR(32) NOT NULL, -- poke/great/ultra/master
  attempt_count INT DEFAULT 0,
  success_count INT DEFAULT 0,
  expected_success_rate DECIMAL(5,4), -- 基础捕捉率
  actual_success_rate DECIMAL(5,4), -- 实际捕捉率
  anomaly_score DECIMAL(5,2), -- 异常评分 0-100
  hour_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX idx_user_pokemon (user_id, pokemon_id),
  INDEX idx_hour_anomaly (hour_timestamp, anomaly_score)
);

-- 捕捉会话表
CREATE TABLE catch_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  pokemon_id VARCHAR(64) NOT NULL,
  pokemon_rarity VARCHAR(32),
  ball_type VARCHAR(32),
  ball_count_used INT,
  berries_used INT,
  throw_type VARCHAR(32), -- normal/nice/great/excellent
  curveball BOOLEAN,
  expected_success_rate DECIMAL(5,4),
  actual_result VARCHAR(16), -- success/fail/escape
  catch_timestamp TIMESTAMPTZ NOT NULL,
  location GEOMETRY(POINT, 4326),
  device_fingerprint VARCHAR(256),
  request_signature VARCHAR(512),
  data_integrity_score DECIMAL(5,2),
  risk_score DECIMAL(5,2),
  risk_level VARCHAR(16), -- low/medium/high/critical
  action_taken VARCHAR(32), -- allowed/warned/blocked
  created_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX idx_user_time (user_id, catch_timestamp),
  INDEX idx_risk_level (risk_level, catch_timestamp)
);
```

#### 成功率异常检测算法
```javascript
// 正态分布模型 + 贝叶斯更新
class CatchSuccessRateAnalyzer {
  // 基础捕捉率配置（按稀有度）
  BASE_RATES = {
    common: 0.40,      // 40%
    rare: 0.20,        // 20%
    epic: 0.10,        // 10%
    legendary: 0.05,   // 5%
  };

  // 道具加成
  BALL_MODIFIERS = {
    poke: 1.0,
    great: 1.5,
    ultra: 2.0,
    master: 255.0,     // 大师球必中
  };

  // 投掷加成
  THROW_MODIFIERS = {
    normal: 1.0,
    nice: 1.1,
    great: 1.3,
    excellent: 1.5,
  };

  // 计算预期成功率
  calculateExpectedRate(pokemon, ballType, throwType, curveball, berries) {
    let base = this.BASE_RATES[pokemon.rarity] || 0.10;
    let modifier = this.BALL_MODIFIERS[ballType] || 1.0;
    modifier *= this.THROW_MODIFIERS[throwType] || 1.0;
    if (curveball) modifier *= 1.7;
    if (berries > 0) modifier *= (1 + berries * 0.1);
    
    return Math.min(1.0, base * modifier);
  }

  // 异常评分（0-100）
  calculateAnomalyScore(userId, pokemonId, expectedRate, actualRate, attempts) {
    // 1. 统计显著性检验（Z-test）
    const zScore = (actualRate - expectedRate) / Math.sqrt(expectedRate * (1 - expectedRate) / attempts);
    
    // 2. 贝叶斯更新（基于历史数据）
    const prior = this.getHistoricalPrior(userId);
    const posterior = this.updateBayesian(prior, actualRate, attempts);
    
    // 3. 综合评分
    let score = 0;
    
    // Z-score 贡献（超过 2σ 开始计分）
    if (zScore > 2) {
      score += Math.min(40, (zScore - 2) * 10);
    }
    
    // 概率差异贡献
    const diff = actualRate - expectedRate;
    if (diff > 0.3) {
      score += Math.min(40, diff * 100);
    }
    
    // 样本量权重（至少 20 次才计分）
    if (attempts >= 20) {
      score *= Math.min(1.5, attempts / 50);
    }
    
    // 历史模式权重
    if (posterior.anomalyProbability > 0.5) {
      score += 20;
    }
    
    return Math.min(100, score);
  }
}
```

### 4.2 数据完整性验证系统

#### 请求签名机制
```javascript
class CatchRequestValidator {
  // 生成请求签名（服务端验证）
  generateRequestSignature(userId, pokemonId, timestamp, location, nonce) {
    const payload = `${userId}|${pokemonId}|${timestamp}|${location.lng},${location.lat}|${nonce}`;
    return crypto
      .createHmac('sha256', process.env.CATCH_SECRET_KEY)
      .update(payload)
      .digest('hex');
  }

  // 验证请求数据完整性
  async validateCatchRequest(req) {
    const { userId, pokemonId, timestamp, location, signature, nonce, ballType, ballCount } = req.body;
    
    const checks = {
      signatureValid: false,
      timestampValid: false,
      locationConsistent: false,
      inventoryConsistent: false,
      ballCountValid: false,
    };

    // 1. 签名验证
    const expectedSig = this.generateRequestSignature(userId, pokemonId, timestamp, location, nonce);
    checks.signatureValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );

    // 2. 时间戳验证（防重放，5分钟窗口）
    const now = Date.now();
    checks.timestampValid = Math.abs(now - timestamp) < 5 * 60 * 1000;

    // 3. 位置一致性验证（与上次报告位置对比）
    const lastLocation = await this.getLastLocation(userId);
    if (lastLocation) {
      const distance = this.calculateDistance(location, lastLocation);
      const timeDiff = (now - lastLocation.timestamp) / 1000;
      const maxSpeed = 50; // m/s
      checks.locationConsistent = distance / timeDiff < maxSpeed;
    } else {
      checks.locationConsistent = true;
    }

    // 4. 道具数量验证（与库存对比）
    const inventory = await this.getUserInventory(userId);
    checks.inventoryConsistent = inventory[ballType] >= ballCount;
    checks.ballCountValid = ballCount > 0 && ballCount <= 100;

    // 5. 计算完整性评分
    const passedChecks = Object.values(checks).filter(v => v).length;
    const integrityScore = (passedChecks / Object.keys(checks).length) * 100;

    return {
      valid: integrityScore >= 80,
      integrityScore,
      checks,
    };
  }
}
```

### 4.3 批量捕捉检测系统

#### 频率限制配置
```javascript
const CATCH_RATE_LIMITS = {
  // 按精灵稀有度分级
  common: {
    maxPerMinute: 15,
    maxPerHour: 200,
    maxPerDay: 1500,
  },
  rare: {
    maxPerMinute: 10,
    maxPerHour: 100,
    maxPerDay: 600,
  },
  epic: {
    maxPerMinute: 5,
    maxPerHour: 50,
    maxPerDay: 200,
  },
  legendary: {
    maxPerMinute: 2,
    maxPerHour: 15,
    maxPerDay: 50,
  },
};

// 批量检测逻辑
class BatchCatchDetector {
  async detectBatchCatch(userId, pokemonRarity) {
    const limits = CATCH_RATE_LIMITS[pokemonRarity] || CATCH_RATE_LIMITS.common;
    const now = Date.now();
    
    // Redis 滑动窗口计数
    const minuteCount = await this.getSlidingWindowCount(userId, 'catch', 60 * 1000);
    const hourCount = await this.getSlidingWindowCount(userId, 'catch', 60 * 60 * 1000);
    const dayCount = await this.getSlidingWindowCount(userId, 'catch', 24 * 60 * 60 * 1000);

    const violations = [];
    
    if (minuteCount > limits.maxPerMinute) {
      violations.push({ window: 'minute', count: minuteCount, limit: limits.maxPerMinute });
    }
    if (hourCount > limits.maxPerHour) {
      violations.push({ window: 'hour', count: hourCount, limit: limits.maxPerHour });
    }
    if (dayCount > limits.maxPerDay) {
      violations.push({ window: 'day', count: dayCount, limit: limits.maxPerDay });
    }

    return {
      isBatch: violations.length > 0,
      violations,
      riskLevel: this.calculateRiskLevel(violations),
    };
  }

  calculateRiskLevel(violations) {
    if (violations.length === 0) return 'low';
    if (violations.some(v => v.count > v.limit * 2)) return 'critical';
    if (violations.some(v => v.count > v.limit * 1.5)) return 'high';
    return 'medium';
  }
}
```

### 4.4 道具使用异常检测

```javascript
class ItemUsageValidator {
  // 道具效果验证
  async validateItemUsage(userId, itemType, expectedEffect, actualEffect) {
    const itemConfigs = {
      razz_berry: { catchMultiplier: 1.5, duration: 1 },
      nanab_berry: { movementReduction: 0.8, duration: 1 },
      pinap_berry: { candyMultiplier: 2, duration: 1 },
      golden_razz: { catchMultiplier: 2.5, duration: 1 },
    };

    const config = itemConfigs[itemType];
    if (!config) return { valid: false, reason: 'unknown_item' };

    // 检查道具效果是否被篡改
    const actualMultiplier = actualEffect.multiplier || 1;
    const expectedMultiplier = config.catchMultiplier || 1;
    
    const effectValid = Math.abs(actualMultiplier - expectedMultiplier) < 0.01;
    
    // 检查道具库存
    const inventory = await this.getUserInventory(userId);
    const hasItem = (inventory[itemType] || 0) > 0;

    return {
      valid: effectValid && hasItem,
      effectValid,
      hasItem,
      expectedMultiplier,
      actualMultiplier,
    };
  }

  // 检测道具数量异常
  async detectItemAnomaly(userId) {
    const inventory = await this.getUserInventory(userId);
    const purchaseHistory = await this.getItemPurchaseHistory(userId, 30); // 最近30天
    const usageHistory = await this.getItemUsageHistory(userId, 30);

    const anomalies = [];

    for (const [itemType, currentCount] of Object.entries(inventory)) {
      const purchased = purchaseHistory[itemType] || 0;
      const used = usageHistory[itemType] || 0;
      const initial = 50; // 初始道具数量
      
      // 库存数量应 = 初始 + 购买 - 使用
      const expectedCount = initial + purchased - used;
      
      // 允许 5% 的误差（网络延迟、缓存不一致等）
      if (Math.abs(currentCount - expectedCount) > expectedCount * 0.05) {
        anomalies.push({
          itemType,
          currentCount,
          expectedCount,
          discrepancy: currentCount - expectedCount,
          severity: Math.abs(currentCount - expectedCount) > 10 ? 'high' : 'medium',
        });
      }
    }

    return {
      hasAnomaly: anomalies.length > 0,
      anomalies,
    };
  }
}
```

### 4.5 实时风控决策引擎

```javascript
class CatchRiskEngine {
  constructor() {
    this.rules = [
      { name: 'high_success_rate', weight: 30, threshold: 70 },
      { name: 'batch_catch', weight: 25, threshold: 50 },
      { name: 'data_integrity', weight: 20, threshold: 60 },
      { name: 'item_anomaly', weight: 15, threshold: 50 },
      { name: 'device_trust', weight: 10, threshold: 40 },
    ];
  }

  async evaluateRisk(userId, catchRequest) {
    // 并行执行所有检测
    const [
      successRateResult,
      batchResult,
      integrityResult,
      itemResult,
      deviceResult,
    ] = await Promise.all([
      this.checkSuccessRate(userId, catchRequest.pokemonId),
      this.checkBatchCatch(userId, catchRequest.pokemonRarity),
      this.checkDataIntegrity(userId, catchRequest),
      this.checkItemUsage(userId, catchRequest),
      this.checkDeviceTrust(userId, catchRequest.deviceFingerprint),
    ]);

    // 计算综合风险评分
    const scores = {
      high_success_rate: successRateResult.anomalyScore,
      batch_catch: batchResult.riskScore,
      data_integrity: 100 - integrityResult.integrityScore,
      item_anomaly: itemResult.anomalyScore,
      device_trust: 100 - deviceResult.trustScore,
    };

    let totalRiskScore = 0;
    for (const rule of this.rules) {
      const score = scores[rule.name] || 0;
      const weightedScore = (score / rule.threshold) * rule.weight;
      totalRiskScore += Math.min(rule.weight, weightedScore);
    }

    // 确定风险等级
    let riskLevel = 'low';
    let action = 'allow';
    
    if (totalRiskScore >= 80) {
      riskLevel = 'critical';
      action = 'block';
    } else if (totalRiskScore >= 60) {
      riskLevel = 'high';
      action = 'block';
    } else if (totalRiskScore >= 40) {
      riskLevel = 'medium';
      action = 'warn';
    } else if (totalRiskScore >= 20) {
      riskLevel = 'low';
      action = 'allow';
    }

    // 记录审计日志
    await this.logRiskDecision({
      userId,
      catchRequest,
      scores,
      totalRiskScore,
      riskLevel,
      action,
      timestamp: new Date(),
    });

    return {
      riskScore: totalRiskScore,
      riskLevel,
      action,
      details: {
        successRate: successRateResult,
        batch: batchResult,
        integrity: integrityResult,
        item: itemResult,
        device: deviceResult,
      },
    };
  }

  // 风险决策动作
  async executeAction(action, catchRequest) {
    switch (action) {
      case 'block':
        return {
          success: false,
          error: 'CATCH_BLOCKED_RISK_DETECTED',
          message: '捕捉请求已被风控系统拦截',
          retryable: false,
        };
      
      case 'warn':
        // 允许捕捉，但记录警告
        await this.recordWarning(catchRequest.userId);
        return {
          success: true,
          warning: true,
          message: '您的捕捉行为存在异常，请遵守游戏规则',
        };
      
      case 'allow':
      default:
        return { success: true };
    }
  }
}
```

### 4.6 API 端点设计

```
POST /api/v1/catch/attempt
  - 功能：捕捉精灵请求（增加风控检查）
  - 请求体：{ pokemonId, ballType, throwType, curveball, berries, location, signature, ... }
  - 响应：{ success, result, riskLevel, warning? }

GET /api/v1/catch/stats/:userId
  - 功能：获取用户捕捉统计数据
  - 查询参数：period (hour/day/week/month)
  - 响应：{ totalAttempts, successRate, byRarity, anomalyScore, ... }

GET /api/v1/catch/risk-report
  - 功能：管理员查看风险报告（需 admin 权限）
  - 查询参数：startDate, endDate, riskLevel, userId?
  - 响应：{ totalCatches, anomalyCount, byRiskLevel, topAnomalousUsers, ... }

POST /api/v1/catch/validate-request
  - 功能：验证捕捉请求数据完整性
  - 请求体：{ ...catchRequest }
  - 响应：{ valid, integrityScore, checks }
```

### 4.7 Prometheus 指标

```javascript
const metrics = {
  // 捕捉请求总数
  catchRequestsTotal: new promClient.Counter({
    name: 'minego_catch_requests_total',
    help: 'Total catch requests',
    labelNames: ['result', 'risk_level'],
  }),

  // 捕捉成功率
  catchSuccessRate: new promClient.Gauge({
    name: 'minego_catch_success_rate',
    help: 'Catch success rate by pokemon rarity',
    labelNames: ['rarity', 'ball_type'],
  }),

  // 异常捕捉次数
  catchAnomalyTotal: new promClient.Counter({
    name: 'minego_catch_anomaly_total',
    help: 'Catch anomaly detections',
    labelNames: ['type', 'severity'],
  }),

  // 风控拦截次数
  riskBlockedTotal: new promClient.Counter({
    name: 'minego_catch_risk_blocked_total',
    help: 'Catch requests blocked by risk engine',
    labelNames: ['risk_level'],
  }),

  // 数据完整性评分分布
  integrityScoreHistogram: new promClient.Histogram({
    name: 'minego_catch_integrity_score',
    help: 'Catch request integrity score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
  }),
};
```

## 5. 验收标准（可测试）

- [ ] 捕捉成功率异常检测模块已实现，支持按稀有度、道具、玩家分级统计
- [ ] 数据完整性验证系统已实现，请求签名验证成功率 99.9%+
- [ ] 批量捕捉检测系统已实现，滑动窗口算法正确，阈值可配置
- [ ] 道具使用异常检测已实现，能识别道具数量与效果篡改
- [ ] 实时风控决策引擎已实现，综合评分算法正确，决策延迟 < 50ms
- [ ] 6 个 API 端点已实现，返回格式符合规范
- [ ] 数据库迁移文件已创建，包含 2 个表（catch_success_stats, catch_sessions）
- [ ] 单元测试覆盖率 ≥ 80%，包含至少 30 个测试用例
- [ ] Prometheus 指标已集成，5 个指标正常上报
- [ ] 审核文档已创建（docs/review/REQ-00082-catch-success-anomaly-detection-review.md）
- [ ] 已集成到 catch-service，捕捉流程已接入风控检查
- [ ] 异常捕捉阻止率 ≥ 90%，误判率 ≤ 0.5%

## 6. 工作量估算

**L（Large）** - 预计 2-3 天

理由：
- 涉及多个复杂子系统（成功率分析、数据验证、批量检测、道具验证、风控引擎）
- 需要实现统计模型与算法（正态分布、贝叶斯更新）
- 需要与现有反作弊系统集成
- 需要处理大量历史数据分析

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **核心玩法保护**：捕捉是游戏核心玩法，作弊直接影响游戏公平性
2. **经济系统影响**：稀有精灵泛滥会破坏游戏经济平衡
3. **用户留存影响**：作弊猖獗会导致正常玩家流失
4. **现有系统缺口**：GPS/设备检测已实现，但捕捉环节仍无保护
5. **技术可行性强**：基于现有反作弊基础设施，可快速实现
