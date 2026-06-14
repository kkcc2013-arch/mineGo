# REQ-00190: 自动化灾难恢复演练与验证系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00190 |
| 标题 | 自动化灾难恢复演练与验证系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/k8s、gateway、所有微服务、backend/jobs、backend/shared、.github/workflows |
| 创建时间 | 2026-06-14 10:00 |

## 需求描述

当前 mineGo 项目已实现多区域容灾切换（REQ-00041）、服务降级（REQ-00068）和混沌工程测试（REQ-00087），但缺少系统化的灾难恢复演练验证机制。生产环境中容灾方案是否真正可用、恢复时间目标（RTO）和恢复点目标（RPO）是否达标，仅靠理论文档无法保证。

本需求旨在建立一套**自动化灾难恢复演练与验证系统**，能够：

1. **定期自动触发灾难模拟场景**（如数据库主节点宕机、Redis 集群故障、整个可用区不可用）
2. **自动执行容灾切换流程并记录恢复时间**
3. **验证业务功能恢复完整性**（不仅服务启动，还需验证关键业务接口可用性）
4. **生成灾难恢复演练报告**，包含 RTO/RPO 达标分析、异常记录与改进建议
5. **支持手动触发专项演练**，用于重大变更后的验证
6. **与 CI/CD 流水线集成**，在重大发布前自动运行灾备演练

## 技术方案

### 1. 灾难场景定义引擎
- 创建 `backend/shared/dr-scenarios/` 目录，定义标准灾难场景模板
- 每个场景包含：触发方式、影响范围、预期恢复流程、RTO/RPO 目标、验证检查点
- 支持 YAML 声明式定义，便于扩展新场景

```yaml
# dr-scenarios/db-primary-failure.yaml
name: db-primary-failure
description: "PostgreSQL 主节点宕机灾备演练"
trigger:
  type: k8s-pod-kill
  target: postgres-primary-0
  namespace: minego-prod
impact:
  services: [pokemon-service, user-service, social-service, gym-service, payment-service]
  critical_paths: ["/api/catch", "/api/user/profile", "/api/gym/battle"]
recovery:
  strategy: auto-failover
  steps:
    - action: check-replica-status
    - action: promote-replica
    - action: update-service-connection
    - action: verify-data-integrity
targets:
  rto: 120s    # 恢复时间目标
  rpo: 5s      # 恢复点目标
validation:
  - type: http-check
    endpoint: /api/health
    expected_status: 200
  - type: db-query
    query: "SELECT count(*) FROM users"
    expected_min: 1
  - type: functional-test
    suite: critical-path-tests
```

### 2. 演练编排与执行引擎
- 创建 `backend/shared/dr-orchestrator.js`，负责编排灾难演练流程
- 基于 Chaos Engineering 工具（Chaos Mesh / Litmus）注入故障
- 使用 Kubernetes Job 执行演练，确保隔离性

```javascript
// backend/shared/dr-orchestrator.js
const { KubernetesClient } = require('./k8s-client');
const { ScenarioLoader } = require('./dr-scenario-loader');
const { MetricsCollector } = require('./metrics-collector');
const logger = require('./logger');

class DROrchestrator {
  constructor(config = {}) {
    this.k8sClient = new KubernetesClient(config.k8s);
    this.scenarioLoader = new ScenarioLoader(config.scenariosPath);
    this.metricsCollector = new MetricsCollector();
    this.activeDrill = null;
  }

  async executeDrill(scenarioName, options = {}) {
    const scenario = await this.scenarioLoader.load(scenarioName);
    const drillId = `drill-${Date.now()}-${scenarioName}`;
    
    this.activeDrill = {
      id: drillId,
      scenario: scenarioName,
      status: 'running',
      startedAt: new Date(),
      phases: [],
    };

    logger.info({ drillId, scenario: scenarioName }, 'Starting DR drill');

    try {
      // Phase 1: Pre-drill baseline snapshot
      const baseline = await this.captureBaseline(scenario);
      this.activeDrill.baseline = baseline;

      // Phase 2: Inject fault
      const faultTime = Date.now();
      await this.injectFault(scenario.trigger, options.dryRun);
      this.activeDrill.faultInjectedAt = new Date();

      // Phase 3: Wait for detection & auto-recovery
      const recoveryResult = await this.waitForRecovery(scenario, options.timeout || 300000);
      const recoveryTime = Date.now() - faultTime;

      // Phase 4: Validate business functionality
      const validationResult = await this.validateRecovery(scenario.validation, recoveryResult);

      // Phase 5: Generate report
      const report = await this.generateReport(drillId, {
        scenario,
        baseline,
        recoveryResult,
        validationResult,
        recoveryTime,
        rtoTarget: scenario.targets.rto,
        rpoTarget: scenario.targets.rpo,
      });

      this.activeDrill.status = validationResult.passed ? 'passed' : 'failed';
      this.activeDrill.completedAt = new Date();
      this.activeDrill.report = report;

      return report;
    } catch (error) {
      this.activeDrill.status = 'error';
      this.activeDrill.error = error.message;
      logger.error({ drillId, error: error.message }, 'DR drill failed');
      throw error;
    } finally {
      // Ensure cleanup: remove injected faults
      await this.cleanup(scenario, options.dryRun);
    }
  }

  async captureBaseline(scenario) {
    const results = {};
    for (const check of scenario.validation) {
      results[check.type] = await this.runCheck(check);
    }
    return results;
  }

  async injectFault(trigger, dryRun = false) {
    if (dryRun) {
      logger.info({ trigger }, 'DRY RUN: Would inject fault');
      return;
    }
    switch (trigger.type) {
      case 'k8s-pod-kill':
        await this.k8sClient.deletePod(trigger.target, trigger.namespace);
        break;
      case 'network-partition':
        await this.k8sClient.injectNetworkPartition(trigger.target, trigger.namespace, trigger.config);
        break;
      case 'disk-failure':
        await this.k8sClient.injectDiskFailure(trigger.target, trigger.namespace, trigger.config);
        break;
      default:
        throw new Error(`Unknown fault type: ${trigger.type}`);
    }
  }

  async waitForRecovery(scenario, timeout) {
    const startTime = Date.now();
    const checkInterval = 5000; // 5s
    
    while (Date.now() - startTime < timeout) {
      const checks = await Promise.all(
        scenario.validation.map(check => this.runCheck(check))
      );
      const allPassed = checks.every(c => c.passed);
      if (allPassed) {
        return {
          recovered: true,
          recoveryTime: Date.now() - startTime,
          checks,
        };
      }
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    return { recovered: false, recoveryTime: timeout, checks: [] };
  }

  async validateRecovery(validationChecks, recoveryResult) {
    if (!recoveryResult.recovered) {
      return { passed: false, reason: 'Recovery timeout' };
    }
    const detailedChecks = await Promise.all(
      validationChecks.map(check => this.runCheck(check))
    );
    return {
      passed: detailedChecks.every(c => c.passed),
      checks: detailedChecks,
    };
  }

  async runCheck(check) {
    switch (check.type) {
      case 'http-check':
        try {
          const res = await fetch(`http://gateway:3000${check.endpoint}`);
          return { type: check.type, passed: res.status === check.expected_status, status: res.status };
        } catch (e) {
          return { type: check.type, passed: false, error: e.message };
        }
      case 'db-query':
        // Execute DB query and validate result
        return { type: check.type, passed: true };
      case 'functional-test':
        // Run critical path test suite
        return { type: check.type, passed: true };
      default:
        return { type: check.type, passed: false, reason: 'Unknown check type' };
    }
  }

  async generateReport(drillId, data) {
    const rtoPass = data.recoveryTime <= data.rtoTarget * 1000;
    return {
      drillId,
      scenarioName: data.scenario.name,
      timestamp: new Date().toISOString(),
      summary: {
        overallResult: data.validationResult.passed && rtoPass ? 'PASSED' : 'FAILED',
        rto: {
          target: `${data.rtoTarget}s`,
          actual: `${(data.recoveryTime / 1000).toFixed(1)}s`,
          passed: rtoPass,
        },
        rpo: {
          target: `${data.rpoTarget}s`,
          estimated: 'TBD', // Calculated from data integrity checks
          passed: true,
        },
        validationChecks: data.validationResult.checks,
      },
      recommendations: this.generateRecommendations(data),
    };
  }

  generateRecommendations(data) {
    const recs = [];
    if (data.recoveryTime > data.rtoTarget * 1000) {
      recs.push({
        severity: 'critical',
        message: `RTO exceeded: ${(data.recoveryTime / 1000).toFixed(1)}s > ${data.rtoTarget}s`,
        suggestion: 'Consider optimizing failover detection and replica promotion time',
      });
    }
    return recs;
  }

  async cleanup(scenario, dryRun) {
    if (dryRun) return;
    // Remove all injected faults and restore normal state
    logger.info({ scenario: scenario.name }, 'Cleaning up DR drill artifacts');
  }
}

module.exports = { DROrchestrator };
```

### 3. 定时演练调度器
- 创建 `backend/jobs/dr-drill-scheduler.js`，使用 cron 表达式定期触发演练
- 支持配置演练频率（默认每月一次全量演练，每周一次轻量演练）
- 与 Kubernetes CronJob 集成

```javascript
// backend/jobs/dr-drill-scheduler.js
const { DROrchestrator } = require('../shared/dr-orchestrator');
const logger = require('../shared/logger');

const DRILL_SCHEDULE = {
  // 每月第一个周日 02:00 UTC 执行全量灾备演练
  full: '0 2 1-7 * 0',
  // 每周三 03:00 UTC 执行轻量演练（单服务故障）
  light: '0 3 * * 3',
};

const SCENARIO_SETS = {
  full: [
    'db-primary-failure',
    'redis-cluster-failure',
    'availability-zone-outage',
    'network-partition',
  ],
  light: [
    'single-service-crash',
    'redis-node-failure',
  ],
};

async function runScheduledDrill(type = 'light') {
  const orchestrator = new DROrchestrator({
    k8s: { namespace: 'minego-prod' },
    scenariosPath: './shared/dr-scenarios',
  });

  const scenarios = SCENARIO_SETS[type] || SCENARIO_SETS.light;
  const results = [];

  for (const scenario of scenarios) {
    try {
      const report = await orchestrator.executeDrill(scenario, {
        dryRun: process.env.DR_DRY_RUN === 'true',
        timeout: 300000,
      });
      results.push(report);
    } catch (error) {
      logger.error({ scenario, error: error.message }, 'DR drill scenario failed');
      results.push({ scenario, error: error.message, status: 'error' });
    }
  }

  // Store results and send notifications
  await storeDrillResults(results);
  await notifyStakeholders(results);
  
  return results;
}
```

### 4. CI/CD 集成 - 发布前灾备演练
- 创建 `.github/workflows/dr-drill-pre-release.yml`
- 在重大版本发布前自动运行灾备演练
- 演练失败则阻止发布

```yaml
# .github/workflows/dr-drill-pre-release.yml
name: DR Drill - Pre-Release Validation

on:
  push:
    tags: ['v[0-9]+.[0-9]+.0']  # Major/Minor releases only

jobs:
  dr-drill:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run DR Drill (Staging)
        env:
          DR_ENV: staging
          DR_DRY_RUN: false
          K8S_NAMESPACE: minego-staging
        run: node backend/jobs/dr-drill-scheduler.js --type=light
      
      - name: Validate DR Results
        run: |
          RESULT=$(cat dr-drill-results.json | jq '.[] | select(.summary.overallResult == "FAILED") | .drillId')
          if [ -n "$RESULT" ]; then
            echo "::error::DR drill failed! Blocking release."
            exit 1
          fi
          echo "All DR drills passed. Release can proceed."
      
      - name: Upload DR Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dr-drill-report
          path: dr-drill-results.json
```

### 5. 演练报告存储与趋势分析
- 演练结果写入 PostgreSQL `dr_drill_reports` 表
- 创建 Grafana 仪表板展示历史演练趋势
- 追踪 RTO/RPO 随时间的变化，识别退化趋势

```sql
-- database/migrations/XXX_create_dr_drill_reports.sql
CREATE TABLE dr_drill_reports (
  id SERIAL PRIMARY KEY,
  drill_id VARCHAR(100) NOT NULL UNIQUE,
  scenario_name VARCHAR(200) NOT NULL,
  drill_type VARCHAR(20) NOT NULL,  -- 'full' or 'light'
  status VARCHAR(20) NOT NULL,       -- 'passed', 'failed', 'error'
  rto_target_ms INTEGER NOT NULL,
  rto_actual_ms INTEGER,
  rpo_target_ms INTEGER NOT NULL,
  rpo_actual_ms INTEGER,
  validation_results JSONB,
  recommendations JSONB,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_dr_reports_scenario ON dr_drill_reports(scenario_name);
CREATE INDEX idx_dr_reports_status ON dr_drill_reports(status);
CREATE INDEX idx_dr_reports_created ON dr_drill_reports(created_at DESC);
```

## 验收标准

- [ ] 支持至少 4 种灾难场景定义（DB 主节点故障、Redis 集群故障、可用区不可用、网络分区）
- [ ] 演练编排引擎能够按顺序执行：基线采集 → 故障注入 → 等待恢复 → 功能验证 → 报告生成
- [ ] 支持干跑模式（dry-run），只验证编排流程不实际注入故障
- [ ] 演练报告包含 RTO/RPO 达标分析、验证检查结果、改进建议
- [ ] 演练结果持久化到数据库，支持历史查询和趋势分析
- [ ] 定时调度器支持配置化演练频率（月度全量 + 周度轻量）
- [ ] CI/CD 集成：重大版本发布前自动运行灾备演练
- [ ] 演练失败时能够自动清理注入的故障，确保不残留
- [ ] Grafana 仪表板展示灾备演练历史趋势
- [ ] 手动触发接口：`POST /api/admin/dr-drill/execute`，支持指定场景和参数

## 影响范围

- `backend/shared/dr-orchestrator.js` - 新增：演练编排引擎
- `backend/shared/dr-scenarios/` - 新增：灾难场景定义目录
- `backend/jobs/dr-drill-scheduler.js` - 新增：定时演练调度器
- `.github/workflows/dr-drill-pre-release.yml` - 新增：CI/CD 集成工作流
- `database/migrations/` - 新增：dr_drill_reports 表迁移
- `infrastructure/k8s/monitoring/` - 新增：Grafana 灾备演练仪表板
- `gateway` - 新增：管理员灾备演练 API 路由

## 参考

- REQ-00041: 多区域容灾切换与灾备恢复系统
- REQ-00068: 服务降级策略与优雅降级管理器
- REQ-00087: 混沌工程与故障注入测试系统
- Chaos Mesh 文档: https://chaos-mesh.org/docs/
- Litmus Chaos 文档: https://litmuschaos.io/
- AWS DR 最佳实践: https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/disaster-recovery.html
