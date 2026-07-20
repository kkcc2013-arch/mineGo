# REQ-00608：反作弊规则动态更新与灰度测试系统

- **编号**：REQ-00608
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/risk-engine, gateway, admin-dashboard, backend/security
- **创建时间**：2026-07-20 13:47
- **依赖需求**：REQ-00556 (机器学习行为异常检测), REQ-00550 (协作作弊团伙检测)

## 1. 背景与问题

mineGo 当前已实现多种反作弊检测规则（GPS 欺骗、速度异常、捕捉频率异常等），但存在以下痛点：

1. **规则更新流程僵化**：所有反作弊规则硬编码在 `backend/shared/risk-engine/anti-cheat-rules.js` 中，调整阈值或新增规则需要修改代码、重新部署，响应周期长达数小时甚至数天。

2. **无法评估新规则效果**：新增反作弊规则后，无法在不影响全量用户的情况下进行小规模验证，可能导致误封或漏封。

3. **缺乏实时调整能力**：当检测到新型作弊手段时，无法通过配置快速调整检测策略，只能被动等待下一次发布。

4. **规则冲突和叠加问题**：多条规则可能对同一行为产生冲突判断，当前缺乏统一协调机制。

**实际案例**：
- REQ-00586 GPS 欺骗检测中，速度阈值需要根据不同场景（走路/骑车/开车）动态调整，但当前无法实时修改
- REQ-00556 机器学习模型更新需要 A/B 测试验证，但缺乏基础设施支持

## 2. 目标

构建**反作弊规则动态管理与灰度测试平台**，实现：

1. **动态规则配置**：通过管理后台实时调整反作弊规则参数（阈值、权重、启用状态），无需重启服务
2. **灰度发布机制**：新规则先对 1% → 10% → 50% → 100% 用户逐步灰度，验证效果后全量发布
3. **A/B 测试框架**：支持多组规则并行测试，对比检测率、误封率等关键指标
4. **智能规则推荐**：基于历史数据推荐最优规则参数组合
5. **实时监控面板**：展示每条规则的实时效果和影响范围

**预期收益**：
- 新反作弊策略上线时间从 **小时级缩短到分钟级**
- 减少 90% 的规则变更导致的线上事故（通过灰度验证）
- 提升规则调优效率 10 倍（支持快速迭代测试）

## 3. 范围

### 包含
- 反作弊规则配置管理系统（数据库表设计、CRUD API）
- 规则引擎动态加载机制（支持热更新）
- 灰度发布控制器（按用户 ID 哈希分组）
- A/B 测试框架（分组、指标采集、统计分析）
- 规则效果监控面板（Prometheus 指标 + Grafana 看板）
- 管理后台界面（规则配置、灰度控制、测试结果展示）

### 不包含
- 新的反作弊检测算法（使用现有规则）
- 机器学习模型训练流程（REQ-00556 已覆盖）
- 用户封禁申诉流程（REQ-00521 已覆盖）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 反作弊规则表
CREATE TABLE anti_cheat_rules (
  id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) UNIQUE NOT NULL,          -- 规则ID，如 'SPEED_HACK_001'
  rule_name VARCHAR(200) NOT NULL,              -- 规则名称
  category VARCHAR(50) NOT NULL,                -- 类别：location/catch/social/payment
  description TEXT,
  
  -- 规则配置（JSON格式）
  config JSONB NOT NULL DEFAULT '{}',
  /*
    示例:
    {
      "thresholds": {
        "maxSpeed": 100,          -- 最大速度 m/s
        "avgSpeed": 30
      },
      "weights": {
        "severity": "high",
        "score": 85
      },
      "enabled": true,
      "cooldownSeconds": 300
    }
  */
  
  -- 灰度配置
  rollout_strategy VARCHAR(20) DEFAULT 'instant', -- instant/gradual/ab_test
  rollout_percentage INT DEFAULT 100 CHECK (rollout_percentage BETWEEN 0 AND 100),
  rollout_groups JSONB DEFAULT '[]',              -- 灰度分组配置
  
  -- A/B 测试配置
  ab_test_enabled BOOLEAN DEFAULT FALSE,
  ab_test_variants JSONB DEFAULT '[]',
  /*
    示例:
    [
      {"id": "control", "config": {...}, "percentage": 50},
      {"id": "treatment", "config": {...}, "percentage": 50}
    ]
  */
  
  -- 元数据
  status VARCHAR(20) DEFAULT 'active',            -- active/paused/deprecated
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INT REFERENCES users(id),
  
  -- 效果统计（定时更新）
  stats JSONB DEFAULT '{}',
  /*
    示例:
    {
      "totalChecks": 150000,
      "matchedCount": 1200,
      "truePositiveRate": 0.85,
      "falsePositiveRate": 0.02,
      "avgLatencyMs": 12
    }
  */
);

-- 规则变更历史表
CREATE TABLE anti_cheat_rule_history (
  id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,                  -- created/updated/rolled_back
  old_config JSONB,
  new_config JSONB,
  reason TEXT,
  changed_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- A/B 测试结果表
CREATE TABLE anti_cheat_ab_test_results (
  id SERIAL PRIMARY KEY,
  test_id VARCHAR(100) NOT NULL,
  rule_id VARCHAR(50) NOT NULL,
  variant_id VARCHAR(50) NOT NULL,              -- control/treatment
  user_id INT NOT NULL,
  result VARCHAR(50) NOT NULL,                  -- matched/not_matched/error
  score INT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_ab_test (test_id, variant_id)
);

-- 索引
CREATE INDEX idx_rules_category ON anti_cheat_rules(category);
CREATE INDEX idx_rules_status ON anti_cheat_rules(status);
CREATE INDEX idx_rule_history_rule ON anti_cheat_rule_history(rule_id, created_at DESC);
```

### 4.2 规则引擎动态加载器

```javascript
// backend/shared/risk-engine/DynamicRuleLoader.js

'use strict';

const { logger } = require('../logging');

class DynamicRuleLoader {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.rulesCache = new Map();
    this.cacheTTL = 300; // 5分钟缓存
  }

  /**
   * 加载所有活跃规则
   */
  async loadActiveRules() {
    const cacheKey = 'anti_cheat:active_rules';
    
    // 先查缓存
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const rules = JSON.parse(cached);
      rules.forEach(rule => this.rulesCache.set(rule.rule_id, rule));
      return rules;
    }
    
    // 查数据库
    const result = await this.db.query(`
      SELECT * FROM anti_cheat_rules 
      WHERE status = 'active'
      ORDER BY priority DESC, created_at DESC
    `);
    
    const rules = result.rows;
    
    // 写入缓存
    await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(rules));
    
    // 更新本地缓存
    rules.forEach(rule => this.rulesCache.set(rule.rule_id, rule));
    
    logger.info('Loaded active anti-cheat rules', { count: rules.length });
    return rules;
  }

  /**
   * 获取特定用户的规则配置
   * 根据灰度分组返回适用的规则版本
   */
  async getRuleForUser(ruleId, userId) {
    let rule = this.rulesCache.get(ruleId);
    
    if (!rule) {
      // 重新加载
      await this.loadActiveRules();
      rule = this.rulesCache.get(ruleId);
    }
    
    if (!rule) return null;
    
    // 检查灰度发布
    if (rule.rollout_strategy === 'gradual') {
      const userBucket = this.hashUserId(userId);
      if (userBucket >= rule.rollout_percentage) {
        // 用户不在灰度范围内
        return { ...rule, config: { enabled: false } };
      }
    }
    
    // 检查 A/B 测试
    if (rule.ab_test_enabled && rule.ab_test_variants.length > 0) {
      const variant = this.selectVariant(userId, rule.ab_test_variants);
      return {
        ...rule,
        config: variant.config,
        variant_id: variant.id
      };
    }
    
    return rule;
  }

  /**
   * 用户 ID 哈希分桶（0-100）
   */
  hashUserId(userId) {
    const hash = require('crypto')
      .createHash('md5')
      .update(userId.toString())
      .digest('hex');
    return parseInt(hash.slice(0, 2), 16) % 100;
  }

  /**
   * A/B 测试变体选择
   */
  selectVariant(userId, variants) {
    const bucket = this.hashUserId(userId);
    let cumulative = 0;
    
    for (const variant of variants) {
      cumulative += variant.percentage;
      if (bucket < cumulative) {
        return variant;
      }
    }
    
    return variants[0]; // 默认返回第一个
  }

  /**
   * 热更新规则（清除缓存）
   */
  async invalidateCache(ruleId = null) {
    if (ruleId) {
      this.rulesCache.delete(ruleId);
    } else {
      this.rulesCache.clear();
    }
    
    await this.redis.del('anti_cheat:active_rules');
    
    // 重新加载
    await this.loadActiveRules();
  }

  /**
   * 订阅规则变更通知
   */
  subscribeToChanges() {
    this.redis.subscribe('anti_cheat:rule_updated', (channel, message) => {
      const { ruleId } = JSON.parse(message);
      logger.info('Rule updated notification received', { ruleId });
      this.invalidateCache(ruleId);
    });
  }
}

module.exports = { DynamicRuleLoader };
```

### 4.3 灰度发布控制器

```javascript
// backend/security/src/RuleRolloutController.js

'use strict';

const { logger } = require('../../shared/logging');

class RuleRolloutController {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  /**
   * 创建灰度发布计划
   */
  async createRolloutPlan(ruleId, strategy, options = {}) {
    const {
      initialPercentage = 1,
      targetPercentage = 100,
      incrementStep = 10,
      intervalMinutes = 60,
      autoRollback = true,
      rollbackThreshold = 0.05 // 误封率超过 5% 自动回滚
    } = options;

    // 创建灰度计划
    const plan = {
      ruleId,
      strategy, // 'gradual' or 'instant'
      currentPercentage: initialPercentage,
      targetPercentage,
      incrementStep,
      intervalMinutes,
      autoRollback,
      rollbackThreshold,
      status: 'running',
      stages: [
        { percentage: initialPercentage, status: 'active', startedAt: new Date() }
      ],
      createdAt: new Date()
    };

    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_strategy = $1,
        rollout_percentage = $2,
        rollout_plan = $3
      WHERE rule_id = $4
    `, [strategy, initialPercentage, JSON.stringify(plan), ruleId]);

    logger.info('Rollout plan created', { ruleId, strategy });

    return plan;
  }

  /**
   * 推进灰度进度
   */
  async advanceRollout(ruleId) {
    const result = await this.db.query(`
      SELECT rollout_plan, rollout_percentage, stats 
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    const rule = result.rows[0];
    if (!rule) throw new Error('Rule not found');

    const plan = rule.rollout_plan;
    
    // 检查是否需要回滚
    if (plan.autoRollback) {
      const falsePositiveRate = rule.stats?.falsePositiveRate || 0;
      if (falsePositiveRate > plan.rollbackThreshold) {
        return await this.rollbackRollout(ruleId, 'High false positive rate detected');
      }
    }

    // 推进到下一阶段
    const nextPercentage = Math.min(
      plan.currentPercentage + plan.incrementStep,
      plan.targetPercentage
    );

    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_percentage = $1,
        rollout_plan = jsonb_set(
          rollout_plan, 
          '{currentPercentage}', 
          $2::jsonb
        )
      WHERE rule_id = $3
    `, [nextPercentage, JSON.stringify(nextPercentage), ruleId]);

    logger.info('Rollout advanced', { 
      ruleId, 
      from: plan.currentPercentage, 
      to: nextPercentage 
    });

    // 通知规则引擎刷新缓存
    await this.redis.publish('anti_cheat:rule_updated', JSON.stringify({ ruleId }));

    return { percentage: nextPercentage, completed: nextPercentage >= plan.targetPercentage };
  }

  /**
   * 回滚灰度发布
   */
  async rollbackRollout(ruleId, reason) {
    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        rollout_percentage = 0,
        status = 'paused',
        rollout_plan = jsonb_set(
          rollout_plan,
          '{status}',
          '"rolled_back"'
        )
      WHERE rule_id = $1
    `, [ruleId]);

    // 记录回滚原因
    await this.db.query(`
      INSERT INTO anti_cheat_rule_history (rule_id, action, reason, created_at)
      VALUES ($1, 'rolled_back', $2, NOW())
    `, [ruleId, reason]);

    logger.warn('Rollout rolled back', { ruleId, reason });

    await this.redis.publish('anti_cheat:rule_updated', JSON.stringify({ ruleId }));

    return { success: true, reason };
  }

  /**
   * 定时任务：自动推进灰度
   */
  startAutoAdvanceJob() {
    const cron = require('node-cron');
    
    // 每小时检查一次
    cron.schedule('0 * * * *', async () => {
      const result = await this.db.query(`
        SELECT rule_id, rollout_plan 
        FROM anti_cheat_rules 
        WHERE status = 'active' 
        AND rollout_strategy = 'gradual'
        AND rollout_percentage < 100
      `);

      for (const row of result.rows) {
        try {
          await this.advanceRollout(row.rule_id);
        } catch (error) {
          logger.error('Auto advance failed', { 
            ruleId: row.rule_id, 
            error: error.message 
          });
        }
      }
    });
  }
}

module.exports = { RuleRolloutController };
```

### 4.4 A/B 测试分析器

```javascript
// backend/security/src/ABTestAnalyzer.js

'use strict';

class ABTestAnalyzer {
  constructor(db) {
    this.db = db;
  }

  /**
   * 分析 A/B 测试结果
   */
  async analyzeTestResults(testId, ruleId) {
    const result = await this.db.query(`
      SELECT 
        variant_id,
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE result = 'matched') as matched_count,
        COUNT(*) FILTER (WHERE result = 'error') as error_count,
        AVG(score) FILTER (WHERE result = 'matched') as avg_score
      FROM anti_cheat_ab_test_results
      WHERE test_id = $1 AND rule_id = $2
      GROUP BY variant_id
    `, [testId, ruleId]);

    const stats = {};
    for (const row of result.rows) {
      stats[row.variant_id] = {
        totalUsers: parseInt(row.total_users),
        matchedCount: parseInt(row.matched_count),
        errorCount: parseInt(row.error_count),
        matchedRate: row.matched_count / row.total_users,
        avgScore: parseFloat(row.avg_score) || 0
      };
    }

    // 计算显著性差异
    const analysis = this.calculateSignificance(stats);

    return {
      testId,
      ruleId,
      stats,
      analysis,
      recommendation: this.generateRecommendation(stats, analysis)
    };
  }

  /**
   * 计算统计学显著性
   */
  calculateSignificance(stats) {
    if (!stats.control || !stats.treatment) {
      return { significant: false, reason: 'Insufficient data' };
    }

    const controlRate = stats.control.matchedRate;
    const treatmentRate = stats.treatment.matchedRate;
    const controlN = stats.control.totalUsers;
    const treatmentN = stats.treatment.totalUsers;

    // 使用 Z-test 检测比例差异
    const pooledRate = (stats.control.matchedCount + stats.treatment.matchedCount) / 
                       (controlN + treatmentN);
    
    const se = Math.sqrt(
      pooledRate * (1 - pooledRate) * (1/controlN + 1/treatmentN)
    );
    
    const zScore = (treatmentRate - controlRate) / se;
    const pValue = this.normalCDF(-Math.abs(zScore)) * 2;

    return {
      significant: pValue < 0.05,
      pValue,
      zScore,
      improvement: ((treatmentRate - controlRate) / controlRate * 100).toFixed(2)
    };
  }

  /**
   * 正态分布累积函数
   */
  normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * 生成推荐
   */
  generateRecommendation(stats, analysis) {
    if (!analysis.significant) {
      return {
        action: 'continue_test',
        reason: 'No significant difference detected yet. Continue collecting data.'
      };
    }

    const improvement = parseFloat(analysis.improvement);
    
    if (improvement > 10) {
      return {
        action: 'adopt_treatment',
        confidence: 'high',
        reason: `Treatment shows ${improvement}% improvement. Recommend full rollout.`
      };
    } else if (improvement > 0) {
      return {
        action: 'adopt_treatment',
        confidence: 'medium',
        reason: `Treatment shows modest improvement (${improvement}%). Consider gradual rollout.`
      };
    } else {
      return {
        action: 'keep_control',
        reason: 'Treatment performs worse than control. Keep current configuration.'
      };
    }
  }
}

module.exports = { ABTestAnalyzer };
```

### 4.5 管理后台 API

```javascript
// gateway/src/routes/security/antiCheatRules.js

module.exports = {
  name: 'anti-cheat-rules',
  routes: [
    // 获取所有规则
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules',
      handler: 'security/antiCheatRules.list',
      auth: true,
      roles: ['admin'],
      validate: {
        query: {
          category: { type: 'string', required: false },
          status: { type: 'string', required: false }
        }
      }
    },

    // 创建新规则
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules',
      handler: 'security/antiCheatRules.create',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          rule_id: { type: 'string', required: true },
          rule_name: { type: 'string', required: true },
          category: { type: 'string', required: true },
          config: { type: 'object', required: true }
        }
      }
    },

    // 更新规则配置
    {
      method: 'PATCH',
      path: '/api/admin/anti-cheat/rules/:ruleId',
      handler: 'security/antiCheatRules.update',
      auth: true,
      roles: ['admin']
    },

    // 创建灰度发布
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout',
      handler: 'security/antiCheatRules.createRollout',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          strategy: { type: 'string', required: true }, // gradual/instant
          initialPercentage: { type: 'number', required: false },
          incrementStep: { type: 'number', required: false }
        }
      }
    },

    // 推进灰度
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout/advance',
      handler: 'security/antiCheatRules.advanceRollout',
      auth: true,
      roles: ['admin']
    },

    // 回滚灰度
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout/rollback',
      handler: 'security/antiCheatRules.rollbackRollout',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          reason: { type: 'string', required: true }
        }
      }
    },

    // 创建 A/B 测试
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/ab-test',
      handler: 'security/antiCheatRules.createABTest',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          variants: { 
            type: 'array', 
            required: true,
            items: {
              id: 'string',
              config: 'object',
              percentage: 'number'
            }
          }
        }
      }
    },

    // 分析 A/B 测试结果
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId/ab-test/results',
      handler: 'security/antiCheatRules.getABTestResults',
      auth: true,
      roles: ['admin']
    },

    // 获取规则统计
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId/stats',
      handler: 'security/antiCheatRules.getStats',
      auth: true,
      roles: ['admin']
    }
  ]
};
```

### 4.6 Prometheus 指标

```javascript
// backend/shared/metrics.js 新增指标

// 反作弊规则检查指标
const antiCheatRuleChecksTotal = safeCounter({
  name: 'minego_anti_cheat_rule_checks_total',
  help: 'Total number of anti-cheat rule checks',
  labelNames: ['rule_id', 'category', 'result'] // result: matched/not_matched/error
});

const antiCheatRuleCheckDuration = safeHistogram({
  name: 'minego_anti_cheat_rule_check_duration_ms',
  help: 'Duration of anti-cheat rule checks in milliseconds',
  labelNames: ['rule_id'],
  buckets: [1, 5, 10, 25, 50, 100, 250]
});

// 灰度发布指标
const ruleRolloutPercentage = safeGauge({
  name: 'minego_rule_rollout_percentage',
  help: 'Current rollout percentage of anti-cheat rule',
  labelNames: ['rule_id']
});

const ruleRollbackTotal = safeCounter({
  name: 'minego_rule_rollback_total',
  help: 'Total number of rule rollbacks',
  labelNames: ['rule_id', 'reason']
});

// A/B 测试指标
const abTestVariantUsers = safeGauge({
  name: 'minego_ab_test_variant_users',
  help: 'Number of users in each A/B test variant',
  labelNames: ['rule_id', 'variant_id']
});

const abTestMatchedRate = safeGauge({
  name: 'minego_ab_test_matched_rate',
  help: 'Matched rate for each A/B test variant',
  labelNames: ['rule_id', 'variant_id']
});
```

## 5. 验收标准（可测试）

- [ ] 管理员可通过 API 创建/更新/删除反作弊规则，无需重启服务
- [ ] 规则更新后 10 秒内生效（通过缓存失效机制）
- [ ] 支持灰度发布，可设置初始百分比、递增步长、自动推进间隔
- [ ] 灰度发布过程中，误封率超过阈值时自动回滚
- [ ] 支持 A/B 测试，可配置多组变体和流量分配
- [ ] A/B 测试结果包含统计学显著性分析（p-value、Z-score）
- [ ] 管理后台可查看每条规则的实时统计（检测率、误封率、延迟）
- [ ] Prometheus 指标正确暴露规则检查、灰度、A/B 测试相关数据
- [ ] 单元测试覆盖率 >= 85%
- [ ] 性能测试：规则动态加载对检测延迟影响 < 5ms

## 6. 工作量估算

**L（大型）**

理由：
- 涉及数据库设计、规则引擎重构、灰度发布、A/B 测试等多个复杂模块
- 需要管理后台界面开发
- 需要大量统计分析和监控集成
- 涉及多个服务模块的协调（gateway、security、shared）

## 7. 优先级理由

**P1 理由**：

1. **安全运维刚需**：当前反作弊规则调整需要重启服务，无法快速响应新型作弊手段
2. **避免线上事故**：灰度发布机制可避免规则变更导致的误封，影响用户体验
3. **提升运营效率**：通过 A/B 测试可优化规则参数，提升检测准确率
4. **已有技术基础**：已有 Redis、PostgreSQL 基础设施，可快速实现
5. **用户价值高**：直接影响游戏公平性和正常玩家体验

---

**下一步行动**：
1. 创建数据库表和迁移文件
2. 实现 DynamicRuleLoader 动态加载器
3. 实现 RuleRolloutController 灰度控制器
4. 实现 ABTestAnalyzer 分析器
5. 开发管理后台 API 和界面
6. 集成 Prometheus 指标
7. 编写单元测试和集成测试
