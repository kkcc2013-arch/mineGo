# REQ-00476：API性能预算与基准测试自动化系统

- **编号**：REQ-00476
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway/shared/performance-budget、backend/tests/benchmark、backend/shared/middleware/perBudgetMiddleware
- **创建时间**：2026-07-07 07:00 UTC
- **依赖需求**：REQ-00033-api-stress-test-performance-benchmark（已创建）、REQ-00301-full-chain-load-testing-and-performance-benchmark-system（已创建）

## 1. 背景与问题

### 当前痛点

mineGo 项目目前已有 API 压力测试系统（REQ-00033）和全链路负载测试系统（REQ-00301），但缺乏一个**持续性的性能预算管理机制**：

1. **无性能预算定义**：各 API 没有明确的性能目标（如 P99 < 200ms），导致性能退化时无预警
2. **基准测试散落**：压力测试是手动触发，缺乏自动化周期性基准测试
3. **性能退化无感知**：新代码合并后性能下降，直到用户投诉才被发现
4. **API 级别性能指标缺失**：监控系统只有整体延迟，无法识别哪些 API 性能不达标
5. **性能预算超额无阻断**：性能退化代码可随意合并到生产分支

### 代码现状分析

```javascript
// backend/shared/metrics.js - 当前只有全局指标
metrics.histogram('api_response_time', duration, {
  method, path, status
});

// 缺失：按 API 端点分类的性能预算检查
// 缺失：性能基准测试自动化调度
// 缺失：性能退化 CI 阻断机制
```

## 2. 目标

建立完整的 API 性能预算管理体系，确保每个 API 都有明确的性能目标，并在性能退化时自动预警和阻断：

1. **定义性能预算**：为每个关键 API 端点定义 P50/P95/P99 延迟预算
2. **自动化基准测试**：每日定时运行基准测试，跟踪性能趋势
3. **性能退化预警**：当 API 延迟超出预算时自动告警
4. **CI 性能门禁**：PR 合并前运行性能基准测试，退化超阈值则阻断
5. **性能热点识别**：自动识别性能不达标的热点 API

## 3. 范围

- **包含**：
  - 性能预算定义与存储系统
  - 自动化基准测试调度器
  - 性能预算检查中间件
  - 性能退化告警系统
  - CI/CD 性能门禁集成
  - 性能热点分析仪表板
  
- **不包含**：
  - 具体性能优化实现（属于性能优化类别）
  - 端到端负载测试（已由 REQ-00301 覆盖）
  - 单次压力测试脚本（已由 REQ-00033 覆盖）

## 4. 详细需求

### 4.1 性能预算定义模块

```javascript
// backend/shared/performance-budget/BudgetDefinition.js

const API_PERFORMANCE_BUDGETS = {
  // 核心捕捉 API - 严格预算
  'POST /api/v1/catch': {
    p50: 100,   // ms
    p95: 200,
    p99: 500,
    max: 1000,
    budgetType: 'strict',  // strict | relaxed
    priority: 'P0'
  },
  
  // 用户认证 API - 中等预算
  'POST /api/v1/auth/login': {
    p50: 150,
    p95: 300,
    p99: 600,
    max: 2000,
    budgetType: 'moderate',
    priority: 'P0'
  },
  
  // 精灵列表查询 - 大数据量预算
  'GET /api/v1/pokemon': {
    p50: 200,
    p95: 400,
    p99: 800,
    max: 2000,
    budgetType: 'relaxed',
    priority: 'P1'
  },
  
  // 社交好友列表
  'GET /api/v1/friends': {
    p50: 150,
    p95: 300,
    p99: 600,
    max: 1500,
    budgetType: 'moderate',
    priority: 'P1'
  },
  
  // 支付处理 - 严格预算
  'POST /api/v1/payment/purchase': {
    p50: 100,
    p95: 250,
    p99: 500,
    max: 1000,
    budgetType: 'strict',
    priority: 'P0'
  },
  
  // 默认预算（未定义的 API）
  '_default': {
    p50: 200,
    p95: 500,
    p99: 1000,
    max: 3000,
    budgetType: 'relaxed',
    priority: 'P2'
  }
};

class BudgetDefinition {
  constructor() {
    this.budgets = API_PERFORMANCE_BUDGETS;
  }
  
  getBudget(method, path) {
    const key = `${method.toUpperCase()} ${path}`;
    return this.budgets[key] || this.budgets['_default'];
  }
  
  validateBudget(budget) {
    // 验证预算定义合理性
    if (budget.p50 > budget.p95 || budget.p95 > budget.p99) {
      throw new Error('性能预算必须递增：p50 < p95 < p99');
    }
    return true;
  }
  
  addBudget(method, path, budget) {
    this.validateBudget(budget);
    const key = `${method.toUpperCase()} ${path}`;
    this.budgets[key] = budget;
  }
}
```

### 4.2 性能预算检查中间件

```javascript
// backend/shared/middleware/PerformanceBudgetMiddleware.js

class PerformanceBudgetMiddleware {
  constructor(budgetDefinition, alerting) {
    this.budgets = budgetDefinition;
    this.alerting = alerting;
    this.violations = new Map();  // 记录违规次数
  }
  
  middleware() {
    return async (req, res, next) => {
      const startTime = Date.now();
      const budget = this.budgets.getBudget(req.method, req.path);
      
      // 响应完成后检查
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        this.checkBudget(req, duration, budget);
      });
      
      next();
    };
  }
  
  checkBudget(req, duration, budget) {
    const key = `${req.method} ${req.path}`;
    
    // 检查 P99 预算
    if (duration > budget.p99) {
      this.recordViolation(key, 'p99', duration, budget.p99);
      
      // 严格预算立即告警
      if (budget.budgetType === 'strict') {
        this.alerting.sendAlert({
          level: 'critical',
          type: 'performance_budget_violation',
          api: key,
          actual: duration,
          budget: budget.p99,
          percentile: 'p99',
          priority: budget.priority
        });
      }
    }
    
    // 检查 MAX 预算
    if (duration > budget.max) {
      this.alerting.sendAlert({
        level: 'emergency',
        type: 'performance_max_exceeded',
        api: key,
        actual: duration,
        max: budget.max,
        priority: budget.priority
      });
    }
    
    // 记录到 Prometheus
    this.recordMetrics(key, duration, budget);
  }
  
  recordViolation(key, percentile, actual, budget) {
    const violations = this.violations.get(key) || { p99: 0, max: 0 };
    violations[percentile]++;
    this.violations.set(key, violations);
    
    // 持久化到 Redis
    redis.hincrby(`perf:violations:${key}`, percentile, 1);
  }
  
  getViolationStats() {
    return Object.fromEntries(this.violations);
  }
}
```

### 4.3 自动化基准测试调度器

```javascript
// backend/shared/performance-budget/BenchmarkScheduler.js

class BenchmarkScheduler {
  constructor(config) {
    this.config = {
      schedule: '0 2 * * *',  // 每日凌晨2点
      endpoints: this.getCriticalEndpoints(),
      iterations: 100,
      concurrency: 10,
      reportPath: '/data/mineGo/logs/benchmark'
    };
    
    this.runner = new BenchmarkRunner();
    this.reporter = new BenchmarkReporter();
  }
  
  getCriticalEndpoints() {
    // 从 BudgetDefinition 获取 P0 优先级的 API
    return Object.entries(API_PERFORMANCE_BUDGETS)
      .filter(([_, budget]) => budget.priority === 'P0')
      .map(([key, _]) => key);
  }
  
  async runDailyBenchmark() {
    const results = [];
    
    for (const endpoint of this.config.endpoints) {
      const [method, path] = endpoint.split(' ');
      const result = await this.runner.runBenchmark({
        method,
        path,
        iterations: this.config.iterations,
        concurrency: this.config.concurrency
      });
      
      results.push({
        endpoint,
        ...result,
        budget: API_PERFORMANCE_BUDGETS[endpoint]
      });
    }
    
    // 生成趋势报告
    const report = this.reporter.generateTrendReport(results);
    
    // 检查退化
    const regressions = this.detectRegression(results);
    if (regressions.length > 0) {
      await this.alertRegression(regressions);
    }
    
    return { results, report, regressions };
  }
  
  detectRegression(results) {
    // 与上周基准对比
    const lastWeek = this.loadLastWeekBaseline();
    const regressions = [];
    
    for (const result of results) {
      const prev = lastWeek[result.endpoint];
      if (!prev) continue;
      
      // P99 增长超过 20% 视为退化
      const p99Change = (result.p99 - prev.p99) / prev.p99;
      if (p99Change > 0.2) {
        regressions.push({
          endpoint: result.endpoint,
          metric: 'p99',
          change: `${(p99Change * 100).toFixed(1)}%`,
          previous: prev.p99,
          current: result.p99
        });
      }
    }
    
    return regressions;
  }
  
  alertRegression(regressions) {
    for (const reg of regressions) {
      this.alerting.sendAlert({
        level: 'warning',
        type: 'performance_regression',
        ...reg
      });
    }
  }
}
```

### 4.4 CI/CD 性能门禁

```yaml
# .github/workflows/performance-gate.yml
name: Performance Budget Gate

on:
  pull_request:
    branches: [main, release/*]
    paths:
      - 'backend/**'
      - 'backend/services/**'
      - 'backend/shared/**'

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup environment
        run: |
          docker-compose up -d postgres redis
          npm ci
          
      - name: Run baseline benchmark
        run: |
          node backend/scripts/run-benchmark.js \
            --endpoints "POST /api/v1/catch,POST /api/v1/auth/login" \
            --iterations 50 \
            --output baseline.json
            
      - name: Compare with reference
        run: |
          node backend/scripts/compare-benchmark.js \
            --baseline baseline.json \
            --reference .github/reference-benchmark.json \
            --threshold 0.15 \
            --fail-on-regression
            
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: benchmark-results
          path: baseline.json
```

### 4.5 性能热点分析仪表板

```javascript
// backend/shared/performance-budget/HotspotAnalyzer.js

class HotspotAnalyzer {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
  }
  
  async analyzeHotspots(timeRange = '24h') {
    // 从 Redis 获取违规统计
    const violations = await this.getViolationStats(timeRange);
    
    // 从 Prometheus 获取延迟分布
    const latencyDistribution = await this.getLatencyDistribution(timeRange);
    
    // 计算热点分数
    const hotspots = [];
    for (const [api, stats] of Object.entries(violations)) {
      const budget = API_PERFORMANCE_BUDGETS[api] || API_PERFORMANCE_BUDGETS['_default'];
      
      const hotspotScore = this.calculateHotspotScore({
        violations: stats,
        latency: latencyDistribution[api],
        budget
      });
      
      if (hotspotScore > 0.5) {  // 热点阈值
        hotspots.push({
          api,
          score: hotspotScore,
          violations: stats,
          budget,
          recommendation: this.generateRecommendation(api, stats, budget)
        });
      }
    }
    
    return hotspots.sort((a, b) => b.score - a.score);
  }
  
  calculateHotspotScore({ violations, latency, budget }) {
    // 热点分数 = 违规率 * 超预算程度 * 优先级权重
    const violationRate = violations.p99 / (violations.total || 1);
    const overBudgetRatio = latency.p99 / budget.p99;
    const priorityWeight = { P0: 3, P1: 2, P2: 1 }[budget.priority];
    
    return violationRate * overBudgetRatio * priorityWeight;
  }
  
  generateRecommendation(api, stats, budget) {
    if (stats.p99 > 50) {
      return `P99 预算违规频繁，建议：1) 添加缓存 2) 优化查询 3) 检查 N+1 问题`;
    }
    return `监控该 API，设置更严格预算`;
  }
}
```

### 4.6 性能预算配置文件

```yaml
# config/performance-budget.yaml
version: 1.0

defaults:
  p50: 200ms
  p95: 500ms
  p99: 1000ms
  max: 3000ms
  budgetType: relaxed
  priority: P2

budgets:
  # 核心业务 API - 严格预算
  catch:
    POST /api/v1/catch:
      p50: 100ms
      p95: 200ms
      p99: 500ms
      max: 1000ms
      budgetType: strict
      priority: P0
      
  auth:
    POST /api/v1/auth/login:
      p50: 150ms
      p95: 300ms
      p99: 600ms
      max: 2000ms
      budgetType: moderate
      priority: P0
      
    POST /api/v1/auth/register:
      p50: 200ms
      p95: 400ms
      p99: 800ms
      max: 2500ms
      budgetType: moderate
      priority: P1
      
  pokemon:
    GET /api/v1/pokemon:
      p50: 200ms
      p95: 400ms
      p99: 800ms
      max: 2000ms
      budgetType: relaxed
      priority: P1
      
    GET /api/v1/pokemon/:id:
      p50: 50ms
      p95: 100ms
      p99: 200ms
      max: 500ms
      budgetType: strict
      priority: P0
      
  payment:
    POST /api/v1/payment/purchase:
      p50: 100ms
      p95: 250ms
      p99: 500ms
      max: 1000ms
      budgetType: strict
      priority: P0

regressionThresholds:
  p99: 20%   # P99 增长超过 20% 视为退化
  p95: 15%
  p50: 10%

alertConfig:
  channels:
    - slack: '#perf-alerts'
    - email: 'perf-team@minego.game'
  severityLevels:
    critical:
      conditions:
        - budgetType: strict
        - percentile: p99
        - violationsPerHour: 10
    warning:
      conditions:
        - budgetType: moderate
        - percentile: p95
        - violationsPerHour: 5
```

## 5. 验收标准（可测试）

- [ ] 性能预算定义模块完成，支持 P50/P95/P99/MAX 预算配置
- [ ] 性能预算中间件完成，实时检查每个 API 响应时间
- [ ] 预算违规时自动记录到 Redis 和 Prometheus
- [ ] 严格预算违规立即触发告警
- [ ] 自动化基准测试调度器完成，每日凌晨执行
- [ ] 基准测试覆盖所有 P0 优先级 API（至少 5 个）
- [ ] 性能退化检测完成，P99 增长超 20% 自动告警
- [ ] CI 性能门禁完成，PR 合并前运行基准测试
- [ ] 性能退化超阈值时 CI 阻断合并
- [ ] 性能热点分析器完成，输出热点 API 接榜单
- [ ] 管理仪表板展示：各 API 预算达标率、热点榜单、趋势图表
- [ ] 单元测试覆盖核心模块（BudgetDefinition、Middleware、Analyzer）

## 6. 工作量估算

**L（Large）**

理由：
- 需要新建 5+ 个核心模块
- CI/CD 集成需要配置 GitHub Actions
- 与现有监控系统（Prometheus、Grafana）集成
- 需要设计完整的告警体系
- 测试和调优需要时间

预计工时：3-5 天

## 7. 优先级理由

**P1 优先级**

原因：
1. **影响用户体验**：API 响应慢直接影响游戏体验，捕捉、支付等核心 API 必须有性能保障
2. **预防性能退化**：缺乏性能预算管理，性能退化难以及时发现
3. **支撑其他优化**：为后续性能优化需求提供基线数据
4. **生产级需求**：成熟项目必须有性能预算机制，这是生产可用的必要条件

该需求实现后，可显著提升 mineGo 的性能可控性，避免性能退化影响用户。