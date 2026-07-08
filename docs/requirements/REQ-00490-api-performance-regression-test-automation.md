# REQ-00490：API性能回归测试自动化与基准线管理系统

- **编号**：REQ-00490
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/tests/regression/shared/performance-baseline
- **创建时间**：2026-07-08 00:09 UTC
- **依赖需求**：REQ-00257（API回归测试系统）、REQ-00476（API性能预算系统）

## 1. 背景与问题

mineGo 项目已有 API 回归测试系统（REQ-00257）和性能预算系统（REQ-00476），但缺乏自动化的性能回归检测机制：

**当前痛点：**
1. **性能退化难以发现**：代码变更导致的性能退化（响应时间增加、内存泄漏）在 CI/CD 中无法自动检测
2. **无历史基准线**：缺乏各 API 的性能历史基准，无法判断当前性能是否正常
3. **性能抖动误报**：由于网络波动、测试环境差异导致的性能抖动无法智能过滤
4. **性能趋势不可视**：无法查看各 API 的性能变化趋势，难以发现潜在问题

**真实代码现状：**
- `backend/tests/regression/` 有回归测试框架，但不包含性能检测
- `backend/tests/performance/` 有性能测试，但无历史数据对比
- `backend/shared/ApiClient.js` 有性能指标收集，但未集成到回归流程
- 缺乏性能基准线存储和趋势分析

**影响范围：**
- 性能退化可能在上线后才被发现
- 无预警机制，可能导致用户体验下降
- 无法量化评估性能优化的效果

## 2. 目标

构建自动化的 API 性能回归测试系统，实现：

- **自动性能检测**：每次 CI/CD 运行自动检测 API 性能变化
- **历史基准线管理**：存储和维护各 API 的性能基准线
- **智能异常检测**：使用统计学方法过滤性能抖动，识别真实退化
- **趋势可视化**：提供性能变化趋势图表和报告

**可量化目标：**
- 性能退化检测准确率：> 90%
- 性能抖动误报率：< 5%
- 基准线数据保留：至少 90 天
- 性能报告生成时间：< 30 秒

## 3. 范围

**包含：**
- 性能回归测试框架核心模块
- 历史基准线存储和查询系统
- 统计学异常检测算法（Z-score、移动平均）
- 性能趋势分析和报告生成
- CI/CD 集成配置
- 管理后台性能看板 API

**不包含：**
- 前端性能监控（仅后端 API）
- 压力测试工具（使用现有 k6/JMeter）
- 自动性能优化（仅检测和告警）
- 客户端性能分析

## 4. 详细需求

### 4.1 性能回归测试框架

创建 `backend/tests/regression/shared/performanceRegressionTester.js`：

```javascript
/**
 * API 性能回归测试框架
 * 自动检测 API 性能变化，与历史基准线对比
 */
class PerformanceRegressionTester {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    this.config = {
      // 性能阈值配置
      responseTimeThreshold: config.responseTimeThreshold || 0.2, // 增加20%告警
      throughputThreshold: config.throughputThreshold || 0.15, // 下降15%告警
      errorRateThreshold: config.errorRateThreshold || 0.01, // 错误率增加1%告警
      
      // 统计学参数
      minSampleSize: config.minSampleSize || 5, // 最小样本量
      significanceLevel: config.significanceLevel || 0.05, // 显著性水平
      
      // 基准线配置
      baselineWindowDays: config.baselineWindowDays || 7, // 基准线时间窗口
      baselineMinSamples: config.baselineMinSamples || 10, // 基准线最小样本数
      
      // 抖动过滤
      jitterFilterEnabled: config.jitterFilterEnabled !== false,
      outlierThreshold: config.outlierThreshold || 3, // Z-score 阈值
      
      ...config
    };
  }

  /**
   * 运行性能回归测试
   */
  async runTest(apiEndpoint, testConfig) {
    const startTime = Date.now();
    
    // 1. 执行性能测试
    const performanceResults = await this._executePerformanceTest(apiEndpoint, testConfig);
    
    // 2. 获取历史基准线
    const baseline = await this._getBaseline(apiEndpoint);
    
    // 3. 统计学异常检测
    const analysis = this._analyzePerformance(performanceResults, baseline);
    
    // 4. 更新基准线（如果测试通过）
    if (analysis.isRegression === false) {
      await this._updateBaseline(apiEndpoint, performanceResults);
    }
    
    // 5. 存储测试结果
    const testRecord = await this._storeTestResult(apiEndpoint, performanceResults, analysis);
    
    return {
      testId: testRecord.id,
      endpoint: apiEndpoint,
      duration: Date.now() - startTime,
      performance: performanceResults,
      baseline,
      analysis,
      passed: analysis.isRegression === false
    };
  }

  /**
   * 执行性能测试
   */
  async _executePerformanceTest(endpoint, config) {
    const iterations = config.iterations || 100;
    const concurrency = config.concurrency || 10;
    const results = [];
    
    // 并发执行测试
    const batches = Math.ceil(iterations / concurrency);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchSize = Math.min(concurrency, iterations - batch * concurrency);
      const batchPromises = [];
      
      for (let i = 0; i < batchSize; i++) {
        batchPromises.push(this._measureApiCall(endpoint, config));
      }
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    // 计算统计数据
    return this._calculateMetrics(results);
  }

  /**
   * 测量单次 API 调用
   */
  async _measureApiCall(endpoint, config) {
    const startTime = process.hrtime.bigint();
    let error = null;
    let statusCode = 200;
    
    try {
      const response = await this._makeRequest(endpoint, config);
      statusCode = response.statusCode;
    } catch (e) {
      error = e.message;
      statusCode = e.statusCode || 500;
    }
    
    const endTime = process.hrtime.bigint();
    const responseTimeNs = endTime - startTime;
    const responseTimeMs = Number(responseTimeNs) / 1_000_000;
    
    return {
      responseTime: responseTimeMs,
      statusCode,
      error,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 计算性能指标
   */
  _calculateMetrics(results) {
    const responseTimes = results.map(r => r.responseTime).sort((a, b) => a - b);
    const successCount = results.filter(r => r.statusCode >= 200 && r.statusCode < 300).length;
    const errorCount = results.length - successCount;
    
    // 过滤异常值
    const filteredTimes = this._filterOutliers(responseTimes);
    
    return {
      totalRequests: results.length,
      successCount,
      errorCount,
      errorRate: errorCount / results.length,
      
      // 响应时间统计
      avgResponseTime: this._average(filteredTimes),
      medianResponseTime: this._median(filteredTimes),
      p90ResponseTime: this._percentile(filteredTimes, 90),
      p95ResponseTime: this._percentile(filteredTimes, 95),
      p99ResponseTime: this._percentile(filteredTimes, 99),
      minResponseTime: filteredTimes[0] || 0,
      maxResponseTime: filteredTimes[filteredTimes.length - 1] || 0,
      stdDev: this._standardDeviation(filteredTimes),
      
      // 吞吐量（每秒请求数）
      throughput: this._calculateThroughput(results),
      
      // 原始数据
      samples: filteredTimes.length,
      outliersRemoved: responseTimes.length - filteredTimes.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 过滤异常值（使用 Z-score）
   */
  _filterOutliers(values) {
    if (!this.config.jitterFilterEnabled || values.length < 5) {
      return values;
    }
    
    const mean = this._average(values);
    const stdDev = this._standardDeviation(values);
    
    if (stdDev === 0) return values;
    
    return values.filter(v => {
      const zScore = Math.abs((v - mean) / stdDev);
      return zScore <= this.config.outlierThreshold;
    });
  }

  /**
   * 获取历史基准线
   */
  async _getBaseline(endpoint) {
    // 先尝试从 Redis 缓存获取
    const cacheKey = `perf:baseline:${endpoint}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 从数据库获取
    const result = await this.db.query(`
      SELECT 
        endpoint,
        avg_response_time,
        median_response_time,
        p90_response_time,
        p95_response_time,
        p99_response_time,
        error_rate,
        throughput,
        sample_count,
        last_updated
      FROM api_performance_baselines
      WHERE endpoint = $1
        AND last_updated > NOW() - INTERVAL '${this.config.baselineWindowDays} days'
      ORDER BY last_updated DESC
      LIMIT 1
    `, [endpoint]);
    
    if (result.rows.length === 0) {
      return null; // 无基准线
    }
    
    const baseline = result.rows[0];
    
    // 缓存基准线
    await this.redis.set(cacheKey, JSON.stringify(baseline), 300);
    
    return baseline;
  }

  /**
   * 分析性能变化
   */
  _analyzePerformance(current, baseline) {
    if (!baseline) {
      return {
        hasBaseline: false,
        isRegression: null,
        message: '无历史基准线，无法判断性能变化',
        details: null
      };
    }
    
    const regressions = [];
    const improvements = [];
    
    // 1. 响应时间分析
    const responseTimeChange = (current.avgResponseTime - baseline.avg_response_time) / baseline.avg_response_time;
    
    if (responseTimeChange > this.config.responseTimeThreshold) {
      regressions.push({
        metric: 'avgResponseTime',
        baseline: baseline.avg_response_time,
        current: current.avgResponseTime,
        change: responseTimeChange * 100,
        severity: responseTimeChange > 0.5 ? 'high' : 'medium'
      });
    } else if (responseTimeChange < -this.config.responseTimeThreshold) {
      improvements.push({
        metric: 'avgResponseTime',
        baseline: baseline.avg_response_time,
        current: current.avgResponseTime,
        change: Math.abs(responseTimeChange) * 100
      });
    }
    
    // 2. P95 响应时间分析
    const p95Change = (current.p95ResponseTime - baseline.p95_response_time) / baseline.p95_response_time;
    
    if (p95Change > this.config.responseTimeThreshold) {
      regressions.push({
        metric: 'p95ResponseTime',
        baseline: baseline.p95_response_time,
        current: current.p95ResponseTime,
        change: p95Change * 100,
        severity: p95Change > 0.5 ? 'high' : 'medium'
      });
    }
    
    // 3. 错误率分析
    const errorRateChange = current.errorRate - baseline.error_rate;
    
    if (errorRateChange > this.config.errorRateThreshold) {
      regressions.push({
        metric: 'errorRate',
        baseline: baseline.error_rate,
        current: current.errorRate,
        change: errorRateChange * 100,
        severity: errorRateChange > 0.05 ? 'critical' : 'high'
      });
    }
    
    // 4. 吞吐量分析
    const throughputChange = (baseline.throughput - current.throughput) / baseline.throughput;
    
    if (throughputChange > this.config.throughputThreshold) {
      regressions.push({
        metric: 'throughput',
        baseline: baseline.throughput,
        current: current.throughput,
        change: throughputChange * 100,
        severity: throughputChange > 0.3 ? 'high' : 'medium'
      });
    }
    
    // 5. 统计学显著性检验
    const statisticalTest = this._performTTest(current, baseline);
    
    return {
      hasBaseline: true,
      isRegression: regressions.length > 0,
      regressions,
      improvements,
      statisticalTest,
      overallScore: this._calculateOverallScore(regressions, improvements),
      recommendation: this._generateRecommendation(regressions, statisticalTest)
    };
  }

  /**
   * 执行 t-test 显著性检验
   */
  _performTTest(current, baseline) {
    // 简化版 t-test
    const tValue = (current.avgResponseTime - baseline.avg_response_time) / 
                   (current.stdDev / Math.sqrt(current.samples));
    
    // 判断是否显著
    const isSignificant = Math.abs(tValue) > 1.96; // p < 0.05
    
    return {
      tValue: tValue.toFixed(4),
      isSignificant,
      pValue: isSignificant ? '<0.05' : '>=0.05',
      confidence: isSignificant ? 95 : 0
    };
  }

  /**
   * 更新基准线
   */
  async _updateBaseline(endpoint, metrics) {
    await this.db.query(`
      INSERT INTO api_performance_baselines
        (endpoint, avg_response_time, median_response_time, 
         p90_response_time, p95_response_time, p99_response_time,
         error_rate, throughput, sample_count, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        avg_response_time = EXCLUDED.avg_response_time,
        median_response_time = EXCLUDED.median_response_time,
        p90_response_time = EXCLUDED.p90_response_time,
        p95_response_time = EXCLUDED.p95_response_time,
        p99_response_time = EXCLUDED.p99_response_time,
        error_rate = EXCLUDED.error_rate,
        throughput = EXCLUDED.throughput,
        sample_count = EXCLUDED.sample_count,
        last_updated = NOW()
    `, [
      endpoint,
      metrics.avgResponseTime,
      metrics.medianResponseTime,
      metrics.p90ResponseTime,
      metrics.p95ResponseTime,
      metrics.p99ResponseTime,
      metrics.errorRate,
      metrics.throughput,
      metrics.samples
    ]);
    
    // 清除缓存
    await this.redis.del(`perf:baseline:${endpoint}`);
  }

  /**
   * 存储测试结果
   */
  async _storeTestResult(endpoint, metrics, analysis) {
    const result = await this.db.query(`
      INSERT INTO api_performance_test_results
        (endpoint, test_type, metrics, analysis_result, created_at)
      VALUES ($1, 'regression', $2, $3, NOW())
      RETURNING id
    `, [endpoint, JSON.stringify(metrics), JSON.stringify(analysis)]);
    
    return { id: result.rows[0].id };
  }

  // 辅助方法
  _average(values) {
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }

  _median(values) {
    const mid = Math.floor(values.length / 2);
    return values.length % 2 !== 0
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2;
  }

  _percentile(values, p) {
    const index = Math.ceil(values.length * p / 100) - 1;
    return values[Math.max(0, index)] || 0;
  }

  _standardDeviation(values) {
    const avg = this._average(values);
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(this._average(squareDiffs));
  }

  _calculateThroughput(results) {
    if (results.length < 2) return 0;
    
    const times = results.map(r => r.responseTime);
    const totalTime = times.reduce((a, b) => a + b, 0);
    
    // 请求/秒
    return (results.length / totalTime) * 1000;
  }

  _calculateOverallScore(regressions, improvements) {
    let score = 100;
    
    for (const r of regressions) {
      const severityScore = {
        critical: 40,
        high: 20,
        medium: 10,
        low: 5
      };
      score -= severityScore[r.severity] || 10;
    }
    
    score += improvements.length * 5;
    
    return Math.max(0, Math.min(100, score));
  }

  _generateRecommendation(regressions, statisticalTest) {
    if (regressions.length === 0) {
      return '性能测试通过，无性能退化';
    }
    
    const criticalRegressions = regressions.filter(r => r.severity === 'critical');
    if (criticalRegressions.length > 0) {
      return '发现严重性能退化，建议立即修复后再部署';
    }
    
    if (regressions.some(r => r.severity === 'high')) {
      return '发现显著性能退化，建议检查相关代码变更';
    }
    
    if (!statisticalTest.isSignificant) {
      return '性能变化未达统计显著性，可继续观察';
    }
    
    return '发现轻微性能退化，建议持续关注';
  }
}

module.exports = PerformanceRegressionTester;
```

### 4.2 基准线管理服务

创建 `backend/tests/regression/shared/performanceBaselineManager.js`：

```javascript
/**
 * 性能基准线管理服务
 * 维护和查询历史性能基准线数据
 */
class PerformanceBaselineManager {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  /**
   * 获取所有 API 的基准线摘要
   */
  async getBaselineSummary() {
    const result = await this.db.query(`
      SELECT 
        endpoint,
        avg_response_time,
        p95_response_time,
        error_rate,
        throughput,
        sample_count,
        last_updated,
        EXTRACT(EPOCH FROM (NOW() - last_updated)) / 3600 as hours_since_update
      FROM api_performance_baselines
      WHERE last_updated > NOW() - INTERVAL '30 days'
      ORDER BY endpoint
    `);
    
    return result.rows.map(row => ({
      endpoint: row.endpoint,
      avgResponseTime: Math.round(row.avg_response_time * 100) / 100,
      p95ResponseTime: Math.round(row.p95_response_time * 100) / 100,
      errorRate: (row.error_rate * 100).toFixed(2) + '%',
      throughput: Math.round(row.throughput),
      samples: row.sample_count,
      lastUpdated: row.last_updated,
      freshness: this._describeFreshness(row.hours_since_update)
    }));
  }

  /**
   * 获取特定 API 的性能趋势
   */
  async getPerformanceTrend(endpoint, days = 30) {
    const result = await this.db.query(`
      SELECT 
        DATE(created_at) as date,
        AVG((metrics->>'avgResponseTime')::float) as avg_response_time,
        AVG((metrics->>'p95ResponseTime')::float) as p95_response_time,
        AVG((metrics->>'errorRate')::float) as error_rate
      FROM api_performance_test_results
      WHERE endpoint = $1
        AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [endpoint]);
    
    return {
      endpoint,
      period: `${days} days`,
      data: result.rows.map(row => ({
        date: row.date,
        avgResponseTime: Math.round(row.avg_response_time * 100) / 100,
        p95ResponseTime: Math.round(row.p95_response_time * 100) / 100,
        errorRate: (row.error_rate * 100).toFixed(2)
      }))
    };
  }

  /**
   * 强制更新基准线
   */
  async forceUpdateBaseline(endpoint, baseline) {
    await this.db.query(`
      INSERT INTO api_performance_baselines
        (endpoint, avg_response_time, median_response_time,
         p90_response_time, p95_response_time, p99_response_time,
         error_rate, throughput, sample_count, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        avg_response_time = EXCLUDED.avg_response_time,
        median_response_time = EXCLUDED.median_response_time,
        p90_response_time = EXCLUDED.p90_response_time,
        p95_response_time = EXCLUDED.p95_response_time,
        p99_response_time = EXCLUDED.p99_response_time,
        error_rate = EXCLUDED.error_rate,
        throughput = EXCLUDED.throughput,
        sample_count = EXCLUDED.sample_count,
        last_updated = NOW()
    `, [
      endpoint,
      baseline.avgResponseTime,
      baseline.medianResponseTime,
      baseline.p90ResponseTime,
      baseline.p95ResponseTime,
      baseline.p99ResponseTime,
      baseline.errorRate,
      baseline.throughput,
      baseline.samples
    ]);
    
    await this.redis.del(`perf:baseline:${endpoint}`);
    
    return { success: true, endpoint };
  }

  /**
   * 清理过期基准线
   */
  async cleanupOldBaselines() {
    const result = await this.db.query(`
      DELETE FROM api_performance_test_results
      WHERE created_at < NOW() - INTERVAL '90 days'
      RETURNING COUNT(*) as deleted_count
    `);
    
    return { deleted: result.rows[0].deleted_count };
  }

  _describeFreshness(hours) {
    if (hours < 1) return '刚刚更新';
    if (hours < 24) return `${Math.floor(hours)}小时前`;
    return `${Math.floor(hours / 24)}天前`;
  }
}

module.exports = PerformanceBaselineManager;
```

### 4.3 CI/CD 集成配置

创建 `.github/workflows/performance-regression.yml`：

```yaml
name: Performance Regression Tests

on:
  pull_request:
    branches: [main, develop]
  workflow_dispatch:
    inputs:
      endpoints:
        description: 'API endpoints to test (comma-separated, or "all")'
        required: false
        default: 'all'

jobs:
  performance-regression:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: minego_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test123
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      
      redis:
        image: redis:7
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
        working-directory: backend
      
      - name: Setup test database
        run: npm run db:migrate:test
        working-directory: backend
        env:
          DATABASE_URL: postgres://test:test123@localhost:5432/minego_test
      
      - name: Run performance regression tests
        run: npm run test:performance-regression
        working-directory: backend
        env:
          DATABASE_URL: postgres://test:test123@localhost:5432/minego_test
          REDIS_URL: redis://localhost:6379
          TEST_ENDPOINTS: ${{ github.event.inputs.endpoints }}
      
      - name: Upload performance report
        uses: actions/upload-artifact@v4
        with:
          name: performance-report
          path: backend/test-results/performance/
      
      - name: Comment on PR (if regression detected)
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('backend/test-results/performance/regression-report.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## ⚠️ Performance Regression Detected\n\n${report}`
            });
```

## 5. 验收标准（可测试）

- [ ] CI/CD 流水线能够自动执行性能回归测试
- [ ] 历史基准线数据存储在 PostgreSQL 中且可查询
- [ ] 性能退化超过 20% 自动标记为失败
- [ ] 统计学异常检测能够过滤性能抖动（Z-score > 3）
- [ ] 性能报告生成时间 < 30 秒
- [ ] 提供 REST API 查询性能趋势和基准线
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

L - 需要实现完整的测试框架、数据库设计、统计分析算法和 CI/CD 集成，预计需要 3-5 天。

## 7. 优先级理由

作为测试覆盖类需求，这是项目"可用"标准的关键组成部分。性能回归测试能够防止性能退化流入生产环境，与性能预算系统（REQ-00476）和回归测试系统（REQ-00257）形成完整的质量保障闭环，因此定为 P1。
