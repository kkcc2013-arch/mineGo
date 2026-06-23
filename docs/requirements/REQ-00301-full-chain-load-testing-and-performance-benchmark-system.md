# REQ-00301: 全链路压测系统与生产环境性能基准

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00301 |
| 标题 | 全链路压测系统与生产环境性能基准 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s、backend/tests/load |
| 创建时间 | 2026-06-23 16:00 |

## 需求描述

建立完整的全链路压测系统，支持对 mineGo 游戏核心业务流程进行生产级性能验证，包括：

1. **压测场景编排**：支持复杂业务场景的压测脚本编写
2. **流量隔离与染色**：压测流量不影响正常用户，支持流量标记
3. **实时监控与分析**：压测过程中的实时性能指标采集和分析
4. **性能基准管理**：建立性能基线，自动检测性能退化
5. **压测报告生成**：自动生成详细的压测报告和优化建议

### 核心价值
- 验证系统在生产负载下的稳定性和性能表现
- 发现性能瓶颈和资源浪费点
- 为容量规划提供数据支撑
- 建立性能回归检测机制

## 技术方案

### 1. 压测框架架构

```javascript
// backend/tests/load/framework/TestOrchestrator.js
const { EventEmitter } = require('events');
const k6 = require('k6');
const { Kafka } = require('kafkajs');

class TestOrchestrator extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.kafka = new Kafka({
      clientId: 'load-test-orchestrator',
      brokers: process.env.KAFKA_BROKERS.split(',')
    });
    this.producer = this.kafka.producer();
    this.metricsCollector = new MetricsCollector();
  }

  /**
   * 执行压测场景
   */
  async executeScenario(scenario) {
    const testId = `load-test-${Date.now()}`;
    
    // 发送压测开始事件
    await this.producer.send({
      topic: 'load-test-events',
      messages: [{
        key: testId,
        value: JSON.stringify({
          type: 'TEST_STARTED',
          testId,
          scenario: scenario.name,
          config: {
            vus: scenario.virtualUsers,
            duration: scenario.duration,
            rampUp: scenario.rampUp
          },
          timestamp: new Date().toISOString()
        })
      }]
    });

    // 初始化虚拟用户
    const vus = await this.initializeVirtualUsers(scenario);
    
    // 执行压测
    const results = await this.runTest(testId, vus, scenario);
    
    // 收集和分析结果
    const report = await this.analyzeResults(testId, results);
    
    return report;
  }

  /**
   * 初始化虚拟用户
   */
  async initializeVirtualUsers(scenario) {
    const { virtualUsers, rampUp } = scenario;
    const vus = [];
    
    for (let i = 0; i < virtualUsers; i++) {
      const vu = new VirtualUser({
        id: `vu-${i}`,
        scenario,
        headers: {
          'X-Load-Test': 'true',
          'X-Test-User-Id': `load-test-user-${i}`
        }
      });
      vus.push(vu);
    }
    
    return vus;
  }
}

module.exports = { TestOrchestrator };
```

### 2. 压测场景定义

```javascript
// backend/tests/load/scenarios/CatchPokemonScenario.js
class CatchPokemonScenario {
  constructor() {
    this.name = 'catch-pokemon-flow';
    this.description = '精灵捕捉完整流程压测';
    this.virtualUsers = 1000;
    this.duration = '5m';
    this.rampUp = '1m';
    this.steps = [
      { name: 'login', weight: 1 },
      { name: 'get_nearby_pokemon', weight: 10 },
      { name: 'throw_ball', weight: 8 },
      { name: 'catch_result', weight: 8 },
      { name: 'update_pokedex', weight: 5 }
    ];
  }

  /**
   * 生成压测脚本
   */
  generateScript() {
    return `
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// 自定义指标
const catchSuccessRate = new Rate('catch_success_rate');
const responseTime = new Trend('response_time');

export const options = {
  stages: [
    { duration: '${this.rampUp}', target: ${this.virtualUsers} },
    { duration: '${this.duration}', target: ${this.virtualUsers} },
    { duration: '1m', target: 0 }
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    catch_success_rate: ['rate>0.95'],
    http_req_failed: ['rate<0.01']
  }
};

export default function() {
  // 登录获取 Token
  const loginRes = http.post(\`\${__ENV.API_BASE_URL}/api/v1/auth/login\`, JSON.stringify({
    email: \`load-test-\${__VU}@test.com\`,
    password: 'test-password'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
  
  check(loginRes, { 'login success': r => r.status === 200 });
  const token = loginRes.json('token');
  
  // 获取附近精灵
  const nearbyRes = http.get(\`\${__ENV.API_BASE_URL}/api/v1/pokemon/nearby?lat=35.68&lng=139.69\`, {
    headers: { 
      'Authorization': \`Bearer \${token}\`,
      'X-Load-Test': 'true'
    }
  });
  
  check(nearbyRes, { 'nearby pokemon fetched': r => r.status === 200 });
  sleep(1);
  
  // 投掷精灵球
  const catchRes = http.post(\`\${__ENV.API_BASE_URL}/api/v1/catch/throw\`, JSON.stringify({
    pokemonId: nearbyRes.json('pokemon[0].id'),
    ballType: 'pokeball',
    throwType: 'normal'
  }), {
    headers: { 
      'Authorization': \`Bearer \${token}\`,
      'X-Load-Test': 'true'
    }
  });
  
  catchSuccessRate.add(catchRes.json('success') === true);
  responseTime.add(catchRes.timings.duration);
  
  sleep(Math.random() * 3 + 1);
}
`;
  }
}

module.exports = { CatchPokemonScenario };
```

### 3. 流量染色与隔离

```javascript
// backend/shared/middleware/loadTestMiddleware.js
const { v4: uuidv4 } = require('uuid');

class LoadTestMiddleware {
  constructor() {
    this.shadowDatabase = process.env.SHADOW_DB_URL;
    this.shadowRedis = process.env.SHADOW_REDIS_URL;
  }

  /**
   * 压测流量识别中间件
   */
  identify() {
    return (req, res, next) => {
      const isLoadTest = req.headers['x-load-test'] === 'true';
      
      if (isLoadTest) {
        req.isLoadTest = true;
        req.loadTestId = req.headers['x-test-id'] || uuidv4();
        req.loadTestUserId = req.headers['x-test-user-id'];
        
        // 标记响应头
        res.setHeader('X-Load-Test', 'true');
        res.setHeader('X-Test-Id', req.loadTestId);
      }
      
      next();
    };
  }

  /**
   * 压测流量路由中间件
   * 将压测流量路由到影子库
   */
  routeToShadow() {
    return (req, res, next) => {
      if (req.isLoadTest) {
        // 切换到影子数据库
        req.dbConnection = this.getShadowConnection();
        req.redisClient = this.getShadowRedis();
        
        // 标记日志
        req.logContext = {
          ...req.logContext,
          loadTest: true,
          testId: req.loadTestId
        };
      }
      
      next();
    };
  }

  /**
   * 压测数据清理中间件
   */
  cleanup() {
    return async (req, res, next) => {
      if (req.isLoadTest) {
        // 请求结束后清理压测数据
        res.on('finish', async () => {
          await this.cleanupLoadTestData(req.loadTestId);
        });
      }
      
      next();
    };
  }

  async cleanupLoadTestData(testId) {
    // 清理影子库中的测试数据
    const client = await this.getShadowConnection();
    await client.query(
      'DELETE FROM catch_records WHERE test_id = $1',
      [testId]
    );
    await client.query(
      'DELETE FROM pokemon WHERE test_id = $1',
      [testId]
    );
  }
}

module.exports = { LoadTestMiddleware };
```

### 4. 实时监控与分析

```javascript
// backend/tests/load/monitoring/RealTimeMonitor.js
const { Kafka } = require('kafkajs');
const { PrometheusDriver } = require('prometheus-query');

class RealTimeMonitor {
  constructor(config) {
    this.kafka = new Kafka({ brokers: config.kafkaBrokers });
    this.consumer = this.kafka.consumer({ groupId: 'load-test-monitor' });
    this.prometheus = new PrometheusDriver({
      endpoint: config.prometheusUrl
    });
    this.metrics = new Map();
  }

  /**
   * 实时采集压测指标
   */
  async startMonitoring(testId) {
    await this.consumer.subscribe({ topic: 'load-test-metrics' });
    
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const metric = JSON.parse(message.value.toString());
        
        if (metric.testId === testId) {
          this.processMetric(metric);
        }
      }
    });

    // 定期采集 Prometheus 指标
    this.metricsInterval = setInterval(async () => {
      await this.collectPrometheusMetrics(testId);
    }, 5000);
  }

  /**
   * 处理单条指标
   */
  processMetric(metric) {
    const key = `${metric.endpoint}-${metric.status}`;
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        endpoint: metric.endpoint,
        status: metric.status,
        count: 0,
        totalDuration: 0,
        errors: []
      });
    }
    
    const data = this.metrics.get(key);
    data.count++;
    data.totalDuration += metric.duration;
    
    if (metric.error) {
      data.errors.push({
        timestamp: metric.timestamp,
        error: metric.error
      });
    }
  }

  /**
   * 采集 Prometheus 指标
   */
  async collectPrometheusMetrics(testId) {
    const queries = [
      `rate(http_requests_total{test_id="${testId}"}[1m])`,
      `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{test_id="${testId}"}[1m]))`,
      `rate(http_errors_total{test_id="${testId}"}[1m])`,
      `container_memory_usage_bytes{pod=~"minego-.*"}`,
      `container_cpu_usage_seconds_total{pod=~"minego-.*"}`
    ];

    for (const query of queries) {
      const result = await this.prometheus.rangeQuery(query, {
        start: Date.now() - 60000,
        end: Date.now(),
        step: 15
      });
      
      this.emit('metric', {
        testId,
        query,
        data: result.result
      });
    }
  }

  /**
   * 生成实时报告
   */
  generateRealtimeReport(testId) {
    const report = {
      testId,
      timestamp: new Date().toISOString(),
      summary: {
        totalRequests: 0,
        successRate: 0,
        avgResponseTime: 0,
        p95ResponseTime: 0,
        errorRate: 0
      },
      endpoints: [],
      alerts: []
    };

    for (const [key, data] of this.metrics) {
      report.summary.totalRequests += data.count;
      
      report.endpoints.push({
        endpoint: data.endpoint,
        status: data.status,
        requestCount: data.count,
        avgDuration: data.totalDuration / data.count,
        errorCount: data.errors.length
      });
    }

    // 计算成功率和错误率
    const successCount = report.endpoints
      .filter(e => e.status < 400)
      .reduce((sum, e) => sum + e.requestCount, 0);
    
    report.summary.successRate = successCount / report.summary.totalRequests;
    report.summary.errorRate = 1 - report.summary.successRate;

    // 检查告警条件
    if (report.summary.errorRate > 0.05) {
      report.alerts.push({
        level: 'warning',
        message: `错误率过高: ${(report.summary.errorRate * 100).toFixed(2)}%`
      });
    }

    return report;
  }
}

module.exports = { RealTimeMonitor };
```

### 5. 性能基准管理

```javascript
// backend/tests/load/benchmark/BaselineManager.js
const fs = require('fs').promises;
const path = require('path');

class BaselineManager {
  constructor() {
    this.baselinesDir = path.join(__dirname, 'baselines');
  }

  /**
   * 保存性能基准
   */
  async saveBaseline(testId, report) {
    const baseline = {
      testId,
      timestamp: new Date().toISOString(),
      version: await this.getCurrentVersion(),
      metrics: {
        throughput: report.summary.throughput,
        p50ResponseTime: report.summary.p50ResponseTime,
        p95ResponseTime: report.summary.p95ResponseTime,
        p99ResponseTime: report.summary.p99ResponseTime,
        errorRate: report.summary.errorRate,
        cpuUsage: report.resources.cpu.max,
        memoryUsage: report.resources.memory.max
      },
      scenario: report.scenario
    };

    const baselinePath = path.join(
      this.baselinesDir, 
      `baseline-${report.scenario.name}-${Date.now()}.json`
    );
    
    await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2));
    
    return baseline;
  }

  /**
   * 获取最近基准
   */
  async getLatestBaseline(scenarioName) {
    const files = await fs.readdir(this.baselinesDir);
    
    const baselineFiles = files
      .filter(f => f.startsWith(`baseline-${scenarioName}-`))
      .sort()
      .reverse();
    
    if (baselineFiles.length === 0) {
      return null;
    }
    
    const content = await fs.readFile(
      path.join(this.baselinesDir, baselineFiles[0])
    );
    
    return JSON.parse(content);
  }

  /**
   * 对比性能基准
   */
  async compareWithBaseline(report) {
    const baseline = await this.getLatestBaseline(report.scenario.name);
    
    if (!baseline) {
      return { status: 'no_baseline', message: '无历史基准数据' };
    }

    const comparison = {
      status: 'ok',
      baseline: baseline.testId,
      current: report.testId,
      regressions: [],
      improvements: []
    };

    // 对比关键指标
    const metrics = ['throughput', 'p95ResponseTime', 'errorRate', 'cpuUsage'];
    
    for (const metric of metrics) {
      const current = report.summary[metric] || report.resources[metric.split('.')[0]]?.max;
      const expected = baseline.metrics[metric];
      
      if (!current || !expected) continue;
      
      const change = (current - expected) / expected;
      const threshold = this.getThreshold(metric);
      
      if (change > threshold) {
        comparison.regressions.push({
          metric,
          expected,
          current,
          change: `${(change * 100).toFixed(2)}%`,
          severity: change > threshold * 2 ? 'high' : 'medium'
        });
        comparison.status = 'regression';
      } else if (change < -threshold) {
        comparison.improvements.push({
          metric,
          expected,
          current,
          change: `${(change * 100).toFixed(2)}%`
        });
      }
    }

    return comparison;
  }

  /**
   * 获取指标阈值
   */
  getThreshold(metric) {
    const thresholds = {
      throughput: 0.1,      // 10%
      p95ResponseTime: 0.2, // 20%
      errorRate: 0.05,      // 5%
      cpuUsage: 0.15,       // 15%
      memoryUsage: 0.15     // 15%
    };
    return thresholds[metric] || 0.1;
  }
}

module.exports = { BaselineManager };
```

### 6. 压测报告生成

```javascript
// backend/tests/load/report/ReportGenerator.js
const fs = require('fs').promises;
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

class ReportGenerator {
  constructor() {
    this.chartRenderer = new ChartJSNodeCanvas({ width: 800, height: 400 });
  }

  /**
   * 生成完整压测报告
   */
  async generateReport(testId, results, comparison) {
    const report = {
      testId,
      generatedAt: new Date().toISOString(),
      summary: {
        scenario: results.scenario.name,
        duration: results.duration,
        virtualUsers: results.virtualUsers,
        totalRequests: results.totalRequests,
        throughput: results.throughput,
        successRate: results.successRate,
        errorRate: results.errorRate
      },
      latency: {
        min: results.latency.min,
        max: results.latency.max,
        avg: results.latency.avg,
        p50: results.latency.p50,
        p90: results.latency.p90,
        p95: results.latency.p95,
        p99: results.latency.p99
      },
      resources: {
        cpu: results.resources.cpu,
        memory: results.resources.memory,
        network: results.resources.network
      },
      errors: results.errors,
      comparison,
      recommendations: this.generateRecommendations(results, comparison)
    };

    // 生成图表
    report.charts = {
      responseTimeDistribution: await this.generateResponseTimeChart(results),
      throughputOverTime: await this.generateThroughputChart(results),
      errorRateOverTime: await this.generateErrorRateChart(results),
      resourceUsage: await this.generateResourceChart(results)
    };

    // 保存报告
    const reportPath = path.join(
      __dirname, 
      'reports', 
      `load-test-report-${testId}.md`
    );
    
    await fs.writeFile(reportPath, this.formatMarkdownReport(report));
    
    return report;
  }

  /**
   * 生成优化建议
   */
  generateRecommendations(results, comparison) {
    const recommendations = [];

    // 响应时间分析
    if (results.latency.p95 > 500) {
      recommendations.push({
        category: 'performance',
        priority: 'high',
        issue: 'P95 响应时间超过 500ms',
        suggestion: '检查数据库查询优化，添加必要索引，考虑缓存热点数据'
      });
    }

    // 吞吐量分析
    const expectedThroughput = results.virtualUsers * 10; // 假设每秒10次请求
    if (results.throughput < expectedThroughput * 0.8) {
      recommendations.push({
        category: 'capacity',
        priority: 'medium',
        issue: '吞吐量低于预期',
        suggestion: '考虑增加服务实例数量，优化连接池配置'
      });
    }

    // 错误率分析
    if (results.errorRate > 0.01) {
      recommendations.push({
        category: 'stability',
        priority: 'high',
        issue: '错误率超过 1%',
        suggestion: '检查错误日志，修复超时问题，增加重试机制'
      });
    }

    // 资源使用分析
    if (results.resources.cpu.max > 80) {
      recommendations.push({
        category: 'resource',
        priority: 'medium',
        issue: 'CPU 使用率过高',
        suggestion: '优化计算密集型代码，考虑异步处理或队列化'
      });
    }

    // 性能退化分析
    if (comparison.status === 'regression') {
      for (const reg of comparison.regressions) {
        recommendations.push({
          category: 'regression',
          priority: reg.severity === 'high' ? 'high' : 'medium',
          issue: `${reg.metric} 退化 ${(parseFloat(reg.change)).toFixed(2)}%`,
          suggestion: `检查最近代码变更，对比基准 ${comparison.baseline}`
        });
      }
    }

    return recommendations;
  }

  /**
   * 格式化 Markdown 报告
   */
  formatMarkdownReport(report) {
    return `# 压测报告 - ${report.testId}

> 生成时间: ${report.generatedAt}

## 执行概要

| 指标 | 值 |
|------|-----|
| 场景 | ${report.summary.scenario} |
| 持续时间 | ${report.summary.duration} |
| 虚拟用户数 | ${report.summary.virtualUsers} |
| 总请求数 | ${report.summary.totalRequests} |
| 吞吐量 | ${report.summary.throughput} req/s |
| 成功率 | ${(report.summary.successRate * 100).toFixed(2)}% |
| 错误率 | ${(report.summary.errorRate * 100).toFixed(2)}% |

## 延迟分布

| 百分位 | 响应时间 (ms) |
|--------|--------------|
| Min | ${report.latency.min} |
| Avg | ${report.latency.avg} |
| P50 | ${report.latency.p50} |
| P90 | ${report.latency.p90} |
| P95 | ${report.latency.p95} |
| P99 | ${report.latency.p99} |
| Max | ${report.latency.max} |

## 资源使用

| 资源 | 平均 | 最大 |
|------|------|------|
| CPU (%) | ${report.resources.cpu.avg} | ${report.resources.cpu.max} |
| Memory (MB) | ${report.resources.memory.avg} | ${report.resources.memory.max} |
| Network (MB/s) | ${report.resources.network.avg} | ${report.resources.network.max} |

## 错误分析

${report.errors.length > 0 ? 
  report.errors.map(e => `- **${e.code}**: ${e.message} (${e.count} 次)`).join('\n') :
  '无错误'
}

## 基准对比

${report.comparison.status === 'regression' ? 
  '⚠️ **检测到性能退化**' : 
  '✅ 性能正常'
}

${report.comparison.regressions.map(r => 
  `- ${r.metric}: ${r.expected} → ${r.current} (${r.change})`
).join('\n')}

## 优化建议

${report.recommendations.map(r => 
  `### ${r.category} (${r.priority})
- **问题**: ${r.issue}
- **建议**: ${r.suggestion}`
).join('\n\n')}

---
*报告自动生成 by mineGo Load Testing System*
`;
  }
}

module.exports = { ReportGenerator };
```

## 验收标准

- [ ] 压测框架支持至少 1000 并发虚拟用户
- [ ] 支持捕捉、道馆战斗、支付等核心场景的压测脚本
- [ ] 压测流量完全隔离，不影响正常用户
- [ ] 实时监控面板展示关键指标（TPS、延迟、错误率）
- [ ] 压测报告自动生成，包含图表和优化建议
- [ ] 性能基准对比功能可用，支持退化检测
- [ ] 压测数据自动清理，不污染生产数据
- [ ] 支持压测任务的定时调度和 API 触发

## 影响范围

### 新增文件
- `backend/tests/load/framework/TestOrchestrator.js` - 压测编排器
- `backend/tests/load/scenarios/*.js` - 压测场景脚本
- `backend/tests/load/monitoring/RealTimeMonitor.js` - 实时监控
- `backend/tests/load/benchmark/BaselineManager.js` - 基准管理
- `backend/tests/load/report/ReportGenerator.js` - 报告生成
- `backend/shared/middleware/loadTestMiddleware.js` - 压测中间件

### 修改文件
- `gateway/src/middleware/index.js` - 集成压测中间件
- `infrastructure/k8s/shadow-database.yaml` - 影子数据库配置
- `infrastructure/k8s/monitoring/prometheus-rules.yaml` - 压测指标规则

### 数据库变更
- 新增测试数据标记字段（test_id, is_load_test）

## 参考

- [k6 压测框架文档](https://k6.io/docs/)
- [Kubernetes 压测最佳实践](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [性能测试基准管理](https://www.brendangregg.com/methodology.html)
- REQ-00033：API 压力测试与性能基准系统（基础框架）
