/**
 * API 性能基准对比工具
 * 每次发布对比关键接口性能，自动告警性能退化
 * 
 * @module PerformanceBenchmark
 */

const fs = require('fs').promises;
const path = require('path');
const { performance } = require('perf_hooks');

class PerformanceBenchmark {
  constructor(options = {}) {
    this.baselineDir = options.baselineDir || path.join(__dirname, 'baselines');
    this.endpoints = options.endpoints || [
      { method: 'GET', path: '/api/location/nearby', maxLatency: 200 },
      { method: 'GET', path: '/api/pokemon/list', maxLatency: 150 },
      { method: 'POST', path: '/api/catch/attempt', maxLatency: 300 },
      { method: 'GET', path: '/api/gym/battle', maxLatency: 250 },
      { method: 'GET', path: '/api/social/leaderboard', maxLatency: 180 },
      { method: 'GET', path: '/api/pokemon/:id', maxLatency: 100 },
      { method: 'GET', path: '/api/user/profile', maxLatency: 120 },
      { method: 'POST', path: '/api/social/friends/request', maxLatency: 200 },
    ];
    this.iterations = options.iterations || 100;
    this.warmupIterations = options.warmupIterations || 10;
    this.degradationThreshold = options.degradationThreshold || 20; // 20% 退化阈值
    this.app = options.app;
    this.redis = options.redis;
  }

  /**
   * 运行性能基准测试
   * @returns {Promise<PerformanceReport>}
   */
  async runBenchmark() {
    const results = [];

    for (const endpoint of this.endpoints) {
      console.log(`基准测试: ${endpoint.method} ${endpoint.path}`);
      
      const metrics = await this.measureEndpoint(endpoint);
      
      results.push({
        ...endpoint,
        ...metrics,
        regression: metrics.p95Latency > endpoint.maxLatency,
        degradationPercent: this.calculateDegradation(metrics, endpoint),
      });
    }

    // 加载并对比历史基准
    const baseline = await this.loadBaseline();
    const comparison = this.compareWithBaseline(results, baseline);

    const report = {
      timestamp: new Date().toISOString(),
      environment: await this.getEnvironmentInfo(),
      results,
      comparison,
      passed: results.every(r => !r.regression) && 
             comparison.every(c => !c.degraded),
      summary: this.generateSummary(results, comparison),
    };

    return report;
  }

  /**
   * 测量单个端点的性能
   */
  async measureEndpoint(endpoint) {
    const samples = [];

    // 预热
    for (let i = 0; i < this.warmupIterations; i++) {
      await this.makeRequest(endpoint);
    }

    // 正式测试
    for (let i = 0; i < this.iterations; i++) {
      const start = performance.now();
      await this.makeRequest(endpoint);
      const end = performance.now();
      
      samples.push(end - start);
    }

    return {
      samples,
      avgLatency: this.average(samples),
      minLatency: Math.min(...samples),
      maxLatency: Math.max(...samples),
      p50Latency: this.percentile(samples, 50),
      p90Latency: this.percentile(samples, 90),
      p95Latency: this.percentile(samples, 95),
      p99Latency: this.percentile(samples, 99),
      stdDev: this.standardDeviation(samples),
      throughput: this.calculateThroughput(samples),
      errorRate: 0, // 需要跟踪错误
    };
  }

  /**
   * 发送请求
   */
  async makeRequest(endpoint) {
    if (!this.app) {
      // 模拟延迟
      await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 50));
      return { status: 200, body: {} };
    }

    const request = require('supertest');
    const agent = request(this.app);

    let response;
    const method = endpoint.method.toLowerCase();
    const path = this.resolvePath(endpoint.path);

    switch (method) {
      case 'get':
        response = await agent.get(path);
        break;
      case 'post':
        response = await agent.post(path).send(endpoint.body || {});
        break;
      case 'put':
        response = await agent.put(path).send(endpoint.body || {});
        break;
      case 'delete':
        response = await agent.delete(path);
        break;
      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    return response;
  }

  /**
   * 解析路径中的参数
   */
  resolvePath(path) {
    // 替换路径参数为测试值
    return path
      .replace(':id', 'test-id-123')
      .replace(':userId', '1');
  }

  /**
   * 对比当前结果与历史基准
   */
  compareWithBaseline(current, baseline) {
    if (!baseline || !baseline.results) {
      return current.map(r => ({
        endpoint: r.path,
        method: r.method,
        baselineP95: null,
        currentP95: r.p95Latency,
        latencyChange: null,
        degraded: false,
      }));
    }

    return current.map((curr, i) => {
      const base = baseline.results.find(
        b => b.path === curr.path && b.method === curr.method
      );

      if (!base) {
        return {
          endpoint: curr.path,
          method: curr.method,
          baselineP95: null,
          currentP95: curr.p95Latency,
          latencyChange: null,
          degraded: false,
        };
      }

      const latencyChange = base.p95Latency > 0 
        ? ((curr.p95Latency - base.p95Latency) / base.p95Latency) * 100 
        : 0;

      return {
        endpoint: curr.path,
        method: curr.method,
        baselineP95: base.p95Latency,
        baselineP50: base.p50Latency,
        baselineAvg: base.avgLatency,
        currentP95: curr.p95Latency,
        currentP50: curr.p50Latency,
        currentAvg: curr.avgLatency,
        latencyChange: latencyChange.toFixed(2),
        degraded: latencyChange > this.degradationThreshold,
        throughputChange: base.throughput > 0 
          ? ((curr.throughput - base.throughput) / base.throughput) * 100 
          : 0,
      };
    });
  }

  /**
   * 保存当前基准
   */
  async saveBaseline(results) {
    await fs.mkdir(this.baselineDir, { recursive: true });
    
    const baseline = {
      timestamp: new Date().toISOString(),
      results,
      environment: await this.getEnvironmentInfo(),
    };

    const fileName = `baseline-${Date.now()}.json`;
    await fs.writeFile(
      path.join(this.baselineDir, fileName),
      JSON.stringify(baseline, null, 2)
    );

    // 更新 latest 链接
    await fs.writeFile(
      path.join(this.baselineDir, 'latest.json'),
      JSON.stringify(baseline, null, 2)
    );

    return fileName;
  }

  /**
   * 加载最新基准
   */
  async loadBaseline() {
    try {
      const content = await fs.readFile(
        path.join(this.baselineDir, 'latest.json'),
        'utf-8'
      );
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * 生成测试报告
   */
  generateSummary(report) {
    const lines = [
      '# 性能基准测试报告',
      '',
      `**测试时间**: ${report.timestamp}`,
      `**测试结果**: ${report.passed ? '✅ 通过' : '❌ 未通过'}`,
      '',
      '## 性能摘要',
      '',
      '| 接口 | 方法 | P50 延迟 | P95 延迟 | 最大延迟 | 状态 |',
      '|------|------|----------|----------|----------|------|',
    ];

    for (const r of report.results) {
      const status = r.regression ? '❌' : '✅';
      lines.push(
        `| ${r.path} | ${r.method} | ${r.p50Latency.toFixed(2)}ms | ` +
        `${r.p95Latency.toFixed(2)}ms | ${r.maxLatency.toFixed(2)}ms | ${status} |`
      );
    }

    if (report.comparison && report.comparison.length > 0) {
      lines.push('', '## 与基准对比', '', 
        '| 接口 | 基准 P95 | 当前 P95 | 变化 | 状态 |',
        '|------|----------|----------|------|------|'
      );

      for (const c of report.comparison) {
        if (c.baselineP95 === null) continue;
        const status = c.degraded ? '❌ 退化' : '✅ 正常';
        lines.push(
          `| ${c.endpoint} | ${c.baselineP95?.toFixed(2) || '-'}ms | ` +
          `${c.currentP95?.toFixed(2)}ms | ${c.latencyChange}% | ${status} |`
        );
      }
    }

    lines.push('', '## 环境', '', 
      `- Node.js: ${report.environment.node}`,
      `- Platform: ${report.environment.platform}`,
      `- CPUs: ${report.environment.cpus}`,
      `- Memory: ${report.environment.memory}MB`,
    );

    return lines.join('\n');
  }

  /**
   * 计算退化百分比
   */
  calculateDegradation(metrics, endpoint) {
    const expectedLatency = endpoint.maxLatency;
    const actualLatency = metrics.p95Latency;
    
    if (actualLatency <= expectedLatency) return 0;
    return ((actualLatency - expectedLatency) / expectedLatency) * 100;
  }

  /**
   * 生成汇总摘要
   */
  generateSummary(results, comparison) {
    const regressions = results.filter(r => r.regression);
    const degraded = comparison.filter(c => c.degraded);

    return {
      totalEndpoints: results.length,
      regressions: regressions.length,
      degraded: degraded.length,
      averageLatency: this.average(results.map(r => r.avgLatency)),
      p95Latency: this.percentile(results.flatMap(r => r.samples), 95),
    };
  }

  /**
   * 获取环境信息
   */
  async getEnvironmentInfo() {
    const os = require('os');
    return {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      memory: Math.round(os.totalmem() / 1024 / 1024),
      hostname: os.hostname(),
    };
  }

  // 统计辅助方法

  average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  standardDeviation(arr) {
    const avg = this.average(arr);
    const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
    return Math.sqrt(this.average(squareDiffs));
  }

  calculateThroughput(samples) {
    if (samples.length === 0) return 0;
    const totalTimeMs = samples.reduce((a, b) => a + b, 0);
    return (samples.length / totalTimeMs) * 1000; // 请求/秒
  }

  sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  }
}

module.exports = PerformanceBenchmark;