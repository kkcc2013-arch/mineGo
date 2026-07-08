/**
 * API 性能回归测试框架
 * 自动检测 API 性能变化，与历史基准线对比
 * 
 * @module PerformanceRegressionTester
 * @requires REQ-00257 (API回归测试系统)
 * @requires REQ-00476 (API性能预算系统)
 */

'use strict';

const { performance } = require('perf_hooks');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('performance-regression');

/**
 * API 性能回归测试器
 * 
 * 功能：
 * - 执行性能测试并收集指标
 * - 与历史基准线对比
 * - 使用统计学方法过滤性能抖动
 * - 自动检测性能退化
 * - 生成测试报告
 */
class PerformanceRegressionTester {
  /**
   * @param {Object} db - PostgreSQL 数据库连接
   * @param {Object} redis - Redis 连接
   * @param {Object} config - 配置选项
   */
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
      
      // 测试配置
      iterations: config.iterations || 100,
      concurrency: config.concurrency || 10,
      warmupIterations: config.warmupIterations || 5,
      
      ...config
    };
    
    logger.info('PerformanceRegressionTester initialized', {
      thresholds: {
        responseTime: this.config.responseTimeThreshold,
        throughput: this.config.throughputThreshold,
        errorRate: this.config.errorRateThreshold
      }
    });
  }

  /**
   * 运行性能回归测试
   * @param {string} apiEndpoint - API 端点标识（如 'GET /api/pokemon/list'）
   * @param {Object} testConfig - 测试配置
   * @returns {Promise<Object>} 测试结果
   */
  async runTest(apiEndpoint, testConfig = {}) {
    const startTime = Date.now();
    const testId = `perf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    
    logger.info('Starting performance regression test', {
      testId,
      endpoint: apiEndpoint
    });
    
    try {
      // 1. 执行性能测试
      const performanceResults = await this._executePerformanceTest(apiEndpoint, testConfig);
      
      // 2. 获取历史基准线
      const baseline = await this._getBaseline(apiEndpoint);
      
      // 3. 统计学异常检测与分析
      const analysis = this._analyzePerformance(performanceResults, baseline);
      
      // 4. 更新基准线（如果测试通过且无退化）
      if (analysis.isRegression === false) {
        await this._updateBaseline(apiEndpoint, performanceResults);
        logger.info('Baseline updated', { endpoint: apiEndpoint });
      }
      
      // 5. 存储测试结果
      const testRecord = await this._storeTestResult(apiEndpoint, performanceResults, analysis);
      
      const result = {
        testId: testRecord.id,
        endpoint: apiEndpoint,
        duration: Date.now() - startTime,
        performance: performanceResults,
        baseline,
        analysis,
        passed: analysis.isRegression === false
      };
      
      logger.info('Performance regression test completed', {
        testId,
        endpoint: apiEndpoint,
        passed: result.passed,
        duration: result.duration
      });
      
      return result;
      
    } catch (error) {
      logger.error('Performance regression test failed', {
        testId,
        endpoint: apiEndpoint,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * 执行性能测试
   * @private
   */
  async _executePerformanceTest(endpoint, config) {
    const iterations = config.iterations || this.config.iterations;
    const concurrency = config.concurrency || this.config.concurrency;
    const warmupIterations = config.warmupIterations || this.config.warmupIterations;
    
    const results = [];
    
    // 预热阶段
    logger.debug('Warmup phase', { iterations: warmupIterations });
    for (let i = 0; i < warmupIterations; i++) {
      await this._measureApiCall(endpoint, config);
    }
    
    // 正式测试 - 分批并发执行
    const batches = Math.ceil(iterations / concurrency);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchSize = Math.min(concurrency, iterations - batch * concurrency);
      const batchPromises = [];
      
      for (let i = 0; i < batchSize; i++) {
        batchPromises.push(this._measureApiCall(endpoint, config));
      }
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      logger.debug('Batch completed', {
        batch: batch + 1,
        total: batches,
        samples: batchResults.length
      });
    }
    
    // 计算统计数据
    return this._calculateMetrics(results);
  }

  /**
   * 测量单次 API 调用
   * @private
   */
  async _measureApiCall(endpoint, config) {
    const startTime = performance.now();
    let error = null;
    let statusCode = 200;
    
    try {
      const response = await this._makeRequest(endpoint, config);
      statusCode = response.status || response.statusCode || 200;
    } catch (e) {
      error = e.message;
      statusCode = e.statusCode || e.status || 500;
    }
    
    const endTime = performance.now();
    const responseTimeMs = endTime - startTime;
    
    return {
      responseTime: responseTimeMs,
      statusCode,
      error,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 执行 HTTP 请求
   * @private
   */
  async _makeRequest(endpoint, config) {
    // 如果有 app 实例，使用 supertest
    if (config.app) {
      const request = require('supertest');
      const agent = request(config.app);
      
      const [method, path] = endpoint.split(' ');
      const resolvedPath = this._resolvePath(path);
      
      const methodLower = method.toLowerCase();
      
      if (methodLower === 'get') {
        return await agent.get(resolvedPath);
      } else if (methodLower === 'post') {
        return await agent.post(resolvedPath).send(config.body || {});
      } else if (methodLower === 'put') {
        return await agent.put(resolvedPath).send(config.body || {});
      } else if (methodLower === 'delete') {
        return await agent.delete(resolvedPath);
      }
    }
    
    // 使用 axios 进行实际 HTTP 请求
    if (config.baseUrl) {
      const axios = require('axios');
      const [method, path] = endpoint.split(' ');
      const url = `${config.baseUrl}${path}`;
      
      const response = await axios({
        method: method.toLowerCase(),
        url,
        timeout: 30000,
        headers: config.headers || {}
      });
      
      return {
        status: response.status,
        data: response.data
      };
    }
    
    // 模拟请求（用于测试框架本身）
    await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 30));
    return { status: 200 };
  }

  /**
   * 解析路径参数
   * @private
   */
  _resolvePath(path) {
    return path
      .replace(':id', 'test-id-123')
      .replace(':userId', 'user-1')
      .replace(':pokemonId', 'pokemon-1');
  }

  /**
   * 计算性能指标
   * @private
   */
  _calculateMetrics(results) {
    const responseTimes = results.map(r => r.responseTime).sort((a, b) => a - b);
    const successCount = results.filter(r => r.statusCode >= 200 && r.statusCode < 300).length;
    const errorCount = results.length - successCount;
    
    // 过滤异常值（抖动过滤）
    const filteredTimes = this._filterOutliers(responseTimes);
    
    const metrics = {
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
      
      // 样本统计
      samples: filteredTimes.length,
      outliersRemoved: responseTimes.length - filteredTimes.length,
      timestamp: new Date().toISOString()
    };
    
    logger.debug('Performance metrics calculated', {
      total: metrics.totalRequests,
      avgResponseTime: metrics.avgResponseTime,
      p95ResponseTime: metrics.p95ResponseTime,
      errorRate: metrics.errorRate,
      throughput: metrics.throughput
    });
    
    return metrics;
  }

  /**
   * 过滤异常值（使用 Z-score 方法）
   * @private
   */
  _filterOutliers(values) {
    if (!this.config.jitterFilterEnabled || values.length < this.config.minSampleSize) {
      return values;
    }
    
    const mean = this._average(values);
    const stdDev = this._standardDeviation(values);
    
    if (stdDev === 0) return values;
    
    const filtered = values.filter(v => {
      const zScore = Math.abs((v - mean) / stdDev);
      return zScore <= this.config.outlierThreshold;
    });
    
    logger.debug('Outliers filtered', {
      original: values.length,
      filtered: filtered.length,
      removed: values.length - filtered.length
    });
    
    return filtered;
  }

  /**
   * 获取历史基准线
   * @private
   */
  async _getBaseline(endpoint) {
    // 先尝试从 Redis 缓存获取
    const cacheKey = `perf:baseline:${endpoint.replace(/\s+/g, ':')}`;
    
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const baseline = JSON.parse(cached);
        logger.debug('Baseline loaded from cache', { endpoint });
        return baseline;
      }
    } catch (e) {
      logger.warn('Redis cache read failed', { error: e.message });
    }
    
    // 从数据库获取
    try {
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
          std_dev,
          last_updated
        FROM api_performance_baselines
        WHERE endpoint = $1
          AND last_updated > NOW() - INTERVAL '${this.config.baselineWindowDays} days'
        ORDER BY last_updated DESC
        LIMIT 1
      `, [endpoint]);
      
      if (result.rows.length === 0) {
        logger.debug('No baseline found', { endpoint });
        return null;
      }
      
      const baseline = {
        endpoint: result.rows[0].endpoint,
        avgResponseTime: result.rows[0].avg_response_time,
        medianResponseTime: result.rows[0].median_response_time,
        p90ResponseTime: result.rows[0].p90_response_time,
        p95ResponseTime: result.rows[0].p95_response_time,
        p99ResponseTime: result.rows[0].p99_response_time,
        errorRate: result.rows[0].error_rate,
        throughput: result.rows[0].throughput,
        sampleCount: result.rows[0].sample_count,
        stdDev: result.rows[0].std_dev,
        lastUpdated: result.rows[0].last_updated
      };
      
      // 缓存基准线
      try {
        await this.redis.set(cacheKey, JSON.stringify(baseline), 300);
      } catch (e) {
        logger.warn('Redis cache write failed', { error: e.message });
      }
      
      logger.debug('Baseline loaded from database', { endpoint });
      return baseline;
      
    } catch (e) {
      logger.error('Database query failed', { error: e.message });
      return null;
    }
  }

  /**
   * 分析性能变化
   * @private
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
    
    // 1. 平均响应时间分析
    const avgResponseTimeChange = this._calculateChange(
      current.avgResponseTime,
      baseline.avgResponseTime
    );
    
    if (avgResponseTimeChange > this.config.responseTimeThreshold) {
      regressions.push({
        metric: 'avgResponseTime',
        baseline: baseline.avgResponseTime,
        current: current.avgResponseTime,
        change: avgResponseTimeChange * 100,
        severity: this._getSeverity(avgResponseTimeChange, 0.5)
      });
    } else if (avgResponseTimeChange < -this.config.responseTimeThreshold) {
      improvements.push({
        metric: 'avgResponseTime',
        baseline: baseline.avgResponseTime,
        current: current.avgResponseTime,
        change: Math.abs(avgResponseTimeChange) * 100
      });
    }
    
    // 2. P95 响应时间分析（关键指标）
    const p95Change = this._calculateChange(
      current.p95ResponseTime,
      baseline.p95ResponseTime
    );
    
    if (p95Change > this.config.responseTimeThreshold) {
      regressions.push({
        metric: 'p95ResponseTime',
        baseline: baseline.p95ResponseTime,
        current: current.p95ResponseTime,
        change: p95Change * 100,
        severity: this._getSeverity(p95Change, 0.5)
      });
    } else if (p95Change < -this.config.responseTimeThreshold) {
      improvements.push({
        metric: 'p95ResponseTime',
        baseline: baseline.p95ResponseTime,
        current: current.p95ResponseTime,
        change: Math.abs(p95Change) * 100
      });
    }
    
    // 3. 错误率分析
    const errorRateChange = current.errorRate - baseline.errorRate;
    
    if (errorRateChange > this.config.errorRateThreshold) {
      regressions.push({
        metric: 'errorRate',
        baseline: baseline.errorRate,
        current: current.errorRate,
        change: errorRateChange * 100,
        severity: this._getSeverity(errorRateChange, 0.05, 'critical')
      });
    }
    
    // 4. 吞吐量分析
    const throughputChange = this._calculateChange(
      baseline.throughput,
      current.throughput,
      true // 吞吐量下降是退化
    );
    
    if (throughputChange > this.config.throughputThreshold) {
      regressions.push({
        metric: 'throughput',
        baseline: baseline.throughput,
        current: current.throughput,
        change: throughputChange * 100,
        severity: this._getSeverity(throughputChange, 0.3)
      });
    }
    
    // 5. 统计学显著性检验（t-test）
    const statisticalTest = this._performTTest(current, baseline);
    
    const analysis = {
      hasBaseline: true,
      isRegression: regressions.length > 0,
      regressions,
      improvements,
      statisticalTest,
      overallScore: this._calculateOverallScore(regressions, improvements),
      recommendation: this._generateRecommendation(regressions, statisticalTest)
    };
    
    logger.debug('Performance analysis completed', {
      regressions: regressions.length,
      improvements: improvements.length,
      overallScore: analysis.overallScore
    });
    
    return analysis;
  }

  /**
   * 计算变化百分比
   * @private
   */
  _calculateChange(current, baseline, reverse = false) {
    if (baseline === 0) return 0;
    const change = (current - baseline) / baseline;
    return reverse ? -change : change;
  }

  /**
   * 获取严重程度
   * @private
   */
  _getSeverity(value, threshold, criticalThreshold = 'critical') {
    if (value > (typeof criticalThreshold === 'number' ? criticalThreshold : 0.5)) {
      return 'critical';
    }
    if (value > threshold) {
      return 'high';
    }
    if (value > threshold * 0.5) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * 执行 t-test 显著性检验
   * @private
   */
  _performTTest(current, baseline) {
    // 简化版 t-test（假设样本足够大）
    const currentStdDev = current.stdDev || this._estimateStdDev(current);
    const baselineStdDev = baseline.stdDev || this._estimateStdDev(baseline);
    
    // 合并标准误差
    const pooledStdError = Math.sqrt(
      (currentStdDev * currentStdDev / current.samples) +
      (baselineStdDev * baselineStdDev / baseline.sampleCount)
    );
    
    if (pooledStdError === 0) {
      return {
        tValue: 0,
        isSignificant: false,
        pValue: '>=0.05',
        confidence: 0
      };
    }
    
    const tValue = (current.avgResponseTime - baseline.avgResponseTime) / pooledStdError;
    
    // 判断是否显著（t > 1.96 对应 p < 0.05）
    const isSignificant = Math.abs(tValue) > 1.96;
    
    return {
      tValue: tValue.toFixed(4),
      isSignificant,
      pValue: isSignificant ? '<0.05' : '>=0.05',
      confidence: isSignificant ? 95 : 0
    };
  }

  /**
   * 估算标准差（如果没有）
   * @private
   */
  _estimateStdDev(metrics) {
    // 使用 P90 和 P50 估算标准差
    const p90 = metrics.p90ResponseTime || metrics.p90_response_time || 0;
    const p50 = metrics.medianResponseTime || metrics.median_response_time || 0;
    return (p90 - p50) / 1.28; // P90 - P50 ≈ 1.28 * σ
  }

  /**
   * 计算总体得分
   * @private
   */
  _calculateOverallScore(regressions, improvements) {
    let score = 100;
    
    const severityScores = {
      critical: 40,
      high: 20,
      medium: 10,
      low: 5
    };
    
    for (const r of regressions) {
      score -= severityScores[r.severity] || 10;
    }
    
    // 改进加分
    score += improvements.length * 5;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 生成建议
   * @private
   */
  _generateRecommendation(regressions, statisticalTest) {
    if (regressions.length === 0) {
      return '性能测试通过，无性能退化';
    }
    
    const criticalRegressions = regressions.filter(r => r.severity === 'critical');
    if (criticalRegressions.length > 0) {
      return '发现严重性能退化，建议立即修复后再部署';
    }
    
    const highRegressions = regressions.filter(r => r.severity === 'high');
    if (highRegressions.length > 0) {
      return '发现显著性能退化，建议检查相关代码变更';
    }
    
    if (!statisticalTest.isSignificant) {
      return '性能变化未达统计显著性，可继续观察';
    }
    
    return '发现轻微性能退化，建议持续关注';
  }

  /**
   * 更新基准线
   * @private
   */
  async _updateBaseline(endpoint, metrics) {
    try {
      await this.db.query(`
        INSERT INTO api_performance_baselines
          (endpoint, avg_response_time, median_response_time, 
           p90_response_time, p95_response_time, p99_response_time,
           error_rate, throughput, sample_count, std_dev, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (endpoint) DO UPDATE SET
          avg_response_time = EXCLUDED.avg_response_time,
          median_response_time = EXCLUDED.median_response_time,
          p90_response_time = EXCLUDED.p90_response_time,
          p95_response_time = EXCLUDED.p95_response_time,
          p99_response_time = EXCLUDED.p99_response_time,
          error_rate = EXCLUDED.error_rate,
          throughput = EXCLUDED.throughput,
          sample_count = EXCLUDED.sample_count,
          std_dev = EXCLUDED.std_dev,
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
        metrics.samples,
        metrics.stdDev
      ]);
      
      // 清除缓存
      const cacheKey = `perf:baseline:${endpoint.replace(/\s+/g, ':')}`;
      try {
        await this.redis.del(cacheKey);
      } catch (e) {
        logger.warn('Redis cache clear failed', { error: e.message });
      }
      
    } catch (e) {
      logger.error('Failed to update baseline', { error: e.message });
    }
  }

  /**
   * 存储测试结果
   * @private
   */
  async _storeTestResult(endpoint, metrics, analysis) {
    try {
      const result = await this.db.query(`
        INSERT INTO api_performance_test_results
          (endpoint, test_type, metrics, analysis_result, passed, created_at)
        VALUES ($1, 'regression', $2, $3, $4, NOW())
        RETURNING id
      `, [
        endpoint,
        JSON.stringify(metrics),
        JSON.stringify(analysis),
        analysis.isRegression === false
      ]);
      
      return { id: result.rows[0].id };
      
    } catch (e) {
      logger.error('Failed to store test result', { error: e.message });
      return { id: `fallback-${Date.now()}` };
    }
  }

  /**
   * 批量运行多个端点的性能测试
   * @param {Array<string>} endpoints - 端点列表
   * @param {Object} config - 测试配置
   * @returns {Promise<Object>} 批量测试结果
   */
  async runBatchTests(endpoints, config = {}) {
    const startTime = Date.now();
    const results = [];
    
    logger.info('Starting batch performance regression tests', {
      endpoints: endpoints.length
    });
    
    for (const endpoint of endpoints) {
      try {
        const result = await this.runTest(endpoint, config);
        results.push(result);
      } catch (e) {
        results.push({
          endpoint,
          passed: false,
          error: e.message
        });
      }
    }
    
    const summary = {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      regressions: results.filter(r => r.analysis?.isRegression).length,
      duration: Date.now() - startTime
    };
    
    logger.info('Batch tests completed', summary);
    
    return {
      results,
      summary,
      report: this._generateBatchReport(results, summary)
    };
  }

  /**
   * 生成批量测试报告
   * @private
   */
  _generateBatchReport(results, summary) {
    const lines = [
      '# API 性能回归测试报告',
      '',
      `**测试时间**: ${new Date().toISOString()}`,
      `**总耗时**: ${summary.duration}ms`,
      `**测试结果**: ${summary.passed}/${summary.total} 通过`,
      '',
      '## 测试摘要',
      '',
      `- ✅ 通过: ${summary.passed}`,
      `- ❌ 失败: ${summary.failed}`,
      `- ⚠️ 性能退化: ${summary.regressions}`,
      '',
      '## 各端点详情',
      '',
      '| 端点 | 平均响应时间 | P95响应时间 | 错误率 | 结果 |',
      '|------|------------|-----------|--------|------|'
    ];
    
    for (const r of results) {
      const perf = r.performance || {};
      const status = r.passed ? '✅ 通过' : '❌ 失败';
      lines.push(
        `| ${r.endpoint} | ${perf.avgResponseTime?.toFixed(2) || '-'}ms | ` +
        `${perf.p95ResponseTime?.toFixed(2) || '-'}ms | ` +
        `${((perf.errorRate || 0) * 100).toFixed(2)}% | ${status} |`
      );
    }
    
    // 退化详情
    const regressions = results.filter(r => r.analysis?.regressions?.length > 0);
    if (regressions.length > 0) {
      lines.push('', '## 性能退化详情', '');
      
      for (const r of regressions) {
        lines.push(`### ${r.endpoint}`, '');
        for (const reg of r.analysis.regressions) {
          lines.push(
            `- **${reg.metric}**: ${reg.baseline?.toFixed(2) || '-'} → ${reg.current?.toFixed(2) || '-'} ` +
            `(+${reg.change?.toFixed(1)}%) [${reg.severity}]`
          );
        }
        lines.push(``, `建议: ${r.analysis.recommendation}`, '');
      }
    }
    
    return lines.join('\n');
  }

  // 统计辅助方法

  _average(values) {
    if (!values || values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  _median(values) {
    if (!values || values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  _percentile(values, p) {
    if (!values || values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, index)] || 0;
  }

  _standardDeviation(values) {
    if (!values || values.length === 0) return 0;
    const avg = this._average(values);
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(this._average(squareDiffs));
  }

  _calculateThroughput(results) {
    if (!results || results.length < 2) return 0;
    
    const times = results.map(r => r.responseTime);
    const totalTimeMs = times.reduce((a, b) => a + b, 0);
    
    // 请求/秒
    return totalTimeMs > 0 ? (results.length / totalTimeMs) * 1000 : 0;
  }
}

module.exports = PerformanceRegressionTester;