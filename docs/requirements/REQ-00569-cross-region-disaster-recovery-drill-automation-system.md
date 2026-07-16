# REQ-00569：跨区域容灾演练自动化与灾备切换决策引擎

- **编号**：REQ-00569
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway, infrastructure, multiRegionArbitration, disasterRecovery
- **创建时间**：2026-07-16 04:00
- **依赖需求**：REQ-00041, REQ-00375

## 1. 背景与问题

当前 mineGo 项目虽然已实现了多区域灾备基础设施，但容灾演练仍依赖人工执行，存在以下问题：

1. **演练频率不足**：人工演练成本高，难以实现每周一次的常态化演练，导致灾备预案可能过期失效
2. **切换决策滞后**：故障发生时，运维人员需要人工评估各区域健康状态、数据同步延迟、流量权重等因素，决策时间长（平均15-30分钟）
3. **缺乏演练数据沉淀**：每次演练的结果没有系统化记录，难以形成可量化的容灾能力指标
4. **误切换风险**：缺乏智能阈值判定，可能因临时抖动触发不必要的灾备切换

## 2. 目标

1. 建立自动化的容灾演练调度系统，支持按周/月自动执行演练
2. 构建智能灾备切换决策引擎，将决策时间从15-30分钟缩短至1分钟内
3. 形成演练数据沉淀，生成容灾能力评分报告
4. 实现演练与真实故障的智能区分，避免误切换

## 3. 范围

### 包含
- 自动化演练调度器（支持配置演练时间窗口、演练范围）
- 智能切换决策引擎（多指标加权评分、阈值动态调整）
- 演练结果记录与报告生成
- 灾备切换执行器（流量切分、DNS切换、数据同步状态检查）
- 演练模式标记与告警抑制

### 不包含
- 新区域的灾备基础设施部署
- 数据库实时同步机制（已有REQ-00041覆盖）
- 成本优化相关功能

## 4. 详细需求

### 4.1 自动化演练调度器

```javascript
// backend/shared/disasterRecovery/DrillScheduler.js
class DrillScheduler {
  constructor(config) {
    this.drillConfig = config; // { schedule: 'weekly', timeWindow: '02:00-05:00', regions: ['cn-east', 'cn-west'] }
    this.drillHistory = new DrillHistoryStore();
  }

  async scheduleNextDrill() {
    // 计算下次演练时间
    // 检查当前系统状态是否适合演练
    // 发送演练预告通知
  }

  async executeDrill(drillPlan) {
    // 标记演练模式
    // 逐步执行演练步骤
    // 收集演练指标
    // 生成演练报告
  }
}
```

### 4.2 智能切换决策引擎

```javascript
// backend/shared/disasterRecovery/SwitchoverDecisionEngine.js
class SwitchoverDecisionEngine {
  constructor() {
    this.metricsCollector = new MultiRegionMetricsCollector();
    this.decisionThresholds = new DynamicThresholds();
  }

  async evaluateSwitchoverNeed(faultEvent) {
    const metrics = await this.metricsCollector.collect({
      regions: ['cn-east', 'cn-west', 'cn-south'],
      indicators: ['latency', 'errorRate', 'syncLag', 'cpuUsage', 'dbConnections']
    });

    const scores = this.calculateRegionScores(metrics);
    const decision = this.makeDecision(scores, faultEvent);

    return {
      shouldSwitch: decision.needSwitch,
      targetRegion: decision.bestRegion,
      confidence: decision.confidence,
      estimatedImpact: decision.impactEstimate
    };
  }

  calculateRegionScores(metrics) {
    // 多指标加权评分
    // latency: 0.25, errorRate: 0.3, syncLag: 0.2, cpuUsage: 0.15, dbConnections: 0.1
  }
}
```

### 4.3 演练模式管理

```javascript
// backend/shared/disasterRecovery/DrillModeManager.js
class DrillModeManager {
  constructor() {
    this.activeDrills = new Map();
    this.alertSuppressor = new AlertSuppressor();
  }

  async startDrill(drillId, config) {
    this.activeDrills.set(drillId, {
      startTime: Date.now(),
      affectedRegions: config.regions,
      alertRules: config.suppressedAlerts
    });
    await this.alertSuppressor.suppress(config.suppressedAlerts);
    await this.publishDrillAnnouncement(drillId);
  }

  async endDrill(drillId) {
    const drill = this.activeDrills.get(drillId);
    await this.alertSuppressor.restore(drill.alertRules);
    this.activeDrills.delete(drillId);
  }
}
```

### 4.4 演练报告生成

```javascript
// backend/shared/disasterRecovery/DrillReportGenerator.js
class DrillReportGenerator {
  async generateReport(drillId, metrics) {
    return {
      drillId,
      duration: metrics.endTime - metrics.startTime,
      steps: metrics.stepResults,
      scores: {
        rtoAchieved: metrics.rtoActual <= metrics.rtoTarget,
        rpoAchieved: metrics.rpoActual <= metrics.rpoTarget,
        dataIntegrity: metrics.dataIntegrityScore,
        serviceRecoveryTime: metrics.serviceRecoveryTime
      },
      issues: metrics.issuesFound,
      recommendations: this.generateRecommendations(metrics)
    };
  }
}
```

### 4.5 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/disaster-recovery/drills` | POST | 创建演练计划 |
| `/api/v1/disaster-recovery/drills/:id/execute` | POST | 执行演练 |
| `/api/v1/disaster-recovery/drills/:id/report` | GET | 获取演练报告 |
| `/api/v1/disaster-recovery/switchover/evaluate` | POST | 评估切换需求 |
| `/api/v1/disaster-recovery/switchover/execute` | POST | 执行切换 |
| `/api/v1/disaster-recovery/status` | GET | 获取当前灾备状态 |

## 5. 验收标准（可测试）

- [ ] 系统能够按配置的时间窗口自动调度并执行容灾演练
- [ ] 演练过程不影响正常服务（告警抑制生效）
- [ ] 智能决策引擎能在30秒内给出切换建议，准确率≥95%
- [ ] 演练报告包含RTO/RPO指标、问题列表和改进建议
- [ ] 真实故障与演练模式能被正确区分
- [ ] 切换执行后，新区域能在5分钟内承接全部流量
- [ ] 所有演练记录持久化存储，可追溯查询

## 6. 工作量估算

**L（Large）** - 需要跨多个服务实现核心逻辑，包括调度器、决策引擎、执行器和报告系统。预计需要3-5个工作日。

## 7. 优先级理由

虽然灾备基础设施已部署，但缺乏自动化演练和智能决策支持会导致：
- 灾备预案可能因长期不演练而失效
- 真实故障时决策时间长，影响业务连续性
- 无法量化容灾能力，难以持续改进

P1优先级确保在关键业务功能稳定的前提下，提升系统的整体可靠性。

## 8. 数据库迁移

```sql
-- backend/migrations/20260716040000_add_disaster_recovery_tables.sql

CREATE TABLE drill_schedules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  schedule_type VARCHAR(50) NOT NULL, -- 'weekly', 'monthly'
  time_window_start TIME NOT NULL,
  time_window_end TIME NOT NULL,
  target_regions JSONB NOT NULL,
  drill_steps JSONB NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE drill_executions (
  id SERIAL PRIMARY KEY,
  schedule_id INTEGER REFERENCES drill_schedules(id),
  drill_id VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL, -- 'scheduled', 'running', 'completed', 'failed'
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  regions JSONB NOT NULL,
  rto_actual INTEGER, -- seconds
  rpo_actual INTEGER, -- seconds
  issues_found JSONB,
  recommendations JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE switchover_decisions (
  id SERIAL PRIMARY KEY,
  decision_id VARCHAR(100) UNIQUE NOT NULL,
  trigger_type VARCHAR(50) NOT NULL, -- 'manual', 'auto', 'drill'
  source_region VARCHAR(100),
  target_region VARCHAR(100),
  confidence DECIMAL(5,4),
  metrics_snapshot JSONB,
  executed BOOLEAN DEFAULT false,
  execution_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_drill_executions_status ON drill_executions(status);
CREATE INDEX idx_drill_executions_drill_id ON drill_executions(drill_id);
CREATE INDEX idx_switchover_decisions_created ON switchover_decisions(created_at DESC);
```

## 9. 测试计划

```javascript
// backend/shared/tests/disasterRecovery/drillScheduler.test.js
describe('DrillScheduler', () => {
  it('should schedule next drill within configured window', async () => {
    // ...
  });

  it('should execute drill steps in correct order', async () => {
    // ...
  });
});

// backend/shared/tests/disasterRecovery/switchoverDecision.test.js
describe('SwitchoverDecisionEngine', () => {
  it('should recommend switchover when primary region fails', async () => {
    // ...
  });

  it('should not recommend switchover for temporary latency spike', async () => {
    // ...
  });

  it('should calculate confidence score correctly', async () => {
    // ...
  });
});
```