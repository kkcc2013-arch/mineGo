/**
 * PerformanceAnalyzer - 性能热点分析引擎
 * REQ-00502: 性能分析与深度优化框架设计
 * 
 * 功能：
 * - 自动聚合性能样本
 * - 分析性能瓶颈类型
 * - 生成优化建议
 */

const fs = require('fs').promises;
const path = require('path');

class PerformanceAnalyzer {
  constructor(options = {}) {
    this.storageDir = options.storageDir || '/tmp/perf-reports';
    this.reportIntervalMs = options.reportIntervalMs || 24 * 60 * 60 * 1000; // 24 小时
    this.analysisRules = this.initAnalysisRules();
  }

  /**
   * 初始化分析规则
   */
  initAnalysisRules() {
    return {
      // 慢查询阈值（ms）
      slowQueryThreshold: 100,
      
      // 慢 API 阈值（ms）
      slowApiThreshold: 500,
      
      // 慢缓存阈值（ms）
      slowCacheThreshold: 50,
      
      // 慢端点阈值（ms）
      slowEndpointThreshold: 500,
      
      // 高错误率阈值（%）
      highErrorRateThreshold: 5,
      
      // 低缓存命中率阈值（%）
      lowCacheHitRateThreshold: 80,
      
      // 数据库时间占比阈值（%）
      highDbRatioThreshold: 50,
      
      // API 时间占比阈值（%）
      highApiRatioThreshold: 30
    };
  }

  /**
   * 分析单个样本的性能瓶颈
   */
  analyzeSample(sample) {
    const analysis = {
      traceId: sample.traceId,
      endpoint: sample.endpoint,
      totalMs: sample.totalDurationMs,
      issues: [],
      bottlenecks: []
    };

    // 检查总耗时
    if (sample.totalDurationMs > this.analysisRules.slowEndpointThreshold) {
      analysis.issues.push({
        type: 'slow_endpoint',
        severity: this.getSeverity(sample.totalDurationMs),
        message: `端点响应时间过长 (${sample.totalDurationMs}ms)`,
        value: sample.totalDurationMs,
        threshold: this.analysisRules.slowEndpointThreshold
      });
    }

    // 分析各阶段耗时占比
    if (sample.phases.db.durationMs > 0) {
      const dbRatio = sample.phases.db.durationMs / sample.totalDurationMs;
      if (dbRatio > this.analysisRules.highDbRatioThreshold / 100) {
        analysis.bottlenecks.push({
          type: 'database',
          ratio: Math.round(dbRatio * 100),
          durationMs: sample.phases.db.durationMs,
          severity: this.getSeverity(sample.phases.db.durationMs)
        });
      }

      // 检查单个数据库操作
      for (const op of sample.phases.db.operations) {
        if (op.durationMs > this.analysisRules.slowQueryThreshold) {
          analysis.issues.push({
            type: 'slow_query',
            severity: this.getSeverity(op.durationMs),
            message: `数据库慢查询 (${op.operation} on ${op.table}: ${op.durationMs}ms)`,
            operation: op.operation,
            table: op.table,
            value: op.durationMs,
            threshold: this.analysisRules.slowQueryThreshold
          });
        }
      }
    }

    if (sample.phases.api.durationMs > 0) {
      const apiRatio = sample.phases.api.durationMs / sample.totalDurationMs;
      if (apiRatio > this.analysisRules.highApiRatioThreshold / 100) {
        analysis.bottlenecks.push({
          type: 'external_api',
          ratio: Math.round(apiRatio * 100),
          durationMs: sample.phases.api.durationMs,
          severity: this.getSeverity(sample.phases.api.durationMs)
        });
      }

      // 检查单个 API 调用
      for (const op of sample.phases.api.operations) {
        if (op.durationMs > this.analysisRules.slowApiThreshold) {
          analysis.issues.push({
            type: 'slow_api_call',
            severity: this.getSeverity(op.durationMs),
            message: `外部 API 调用缓慢 (${op.targetService}: ${op.durationMs}ms)`,
            targetService: op.targetService,
            value: op.durationMs,
            threshold: this.analysisRules.slowApiThreshold
          });
        }
      }
    }

    if (sample.phases.cache.durationMs > 0) {
      for (const op of sample.phases.cache.operations) {
        if (op.durationMs > this.analysisRules.slowCacheThreshold) {
          analysis.issues.push({
            type: 'slow_cache_op',
            severity: this.getSeverity(op.durationMs),
            message: `缓存操作缓慢 (${op.operation}: ${op.durationMs}ms)`,
            operation: op.operation,
            value: op.durationMs,
            threshold: this.analysisRules.slowCacheThreshold
          });
        }
      }
    }

    return analysis;
  }

  /**
   * 根据耗时值获取严重级别
   */
  getSeverity(durationMs) {
    if (durationMs > 2000) return 'critical';
    if (durationMs > 1000) return 'high';
    if (durationMs > 500) return 'medium';
    return 'low';
  }

  /**
   * 批量分析样本
   */
  analyzeSamples(samples) {
    const results = {
      totalSamples: samples.length,
      endpointAnalysis: {},
      bottleneckDistribution: {
        database: 0,
        external_api: 0,
        cache: 0,
        business_logic: 0,
        unknown: 0
      },
      issueDistribution: {},
      criticalIssues: [],
      recommendations: []
    };

    for (const sample of samples) {
      const analysis = this.analyzeSample(sample);
      const endpointKey = sample.endpoint;

      // 按端点聚合
      if (!results.endpointAnalysis[endpointKey]) {
        results.endpointAnalysis[endpointKey] = {
          count: 0,
          totalMs: 0,
          avgMs: 0,
          maxMs: 0,
          issues: [],
          bottlenecks: []
        };
      }

      const ep = results.endpointAnalysis[endpointKey];
      ep.count++;
      ep.totalMs += sample.totalDurationMs;
      ep.maxMs = Math.max(ep.maxMs, sample.totalDurationMs);
      ep.avgMs = Math.round(ep.totalMs / ep.count);

      // 聚合问题
      for (const issue of analysis.issues) {
        ep.issues.push(issue);

        // 统计问题分布
        results.issueDistribution[issue.type] = 
          (results.issueDistribution[issue.type] || 0) + 1;

        // 收集严重问题
        if (issue.severity === 'critical') {
          results.criticalIssues.push({
            endpoint: sample.endpoint,
            traceId: sample.traceId,
            issue
          });
        }
      }

      // 统计瓶颈分布
      const primaryBottleneck = analysis.bottlenecks[0]?.type || 'unknown';
      results.bottleneckDistribution[primaryBottleneck]++;
    }

    // 计算平均值
    for (const key of Object.keys(results.endpointAnalysis)) {
      const ep = results.endpointAnalysis[key];
      ep.avgMs = Math.round(ep.totalMs / ep.count);
    }

    // 生成优化建议
    results.recommendations = this.generateRecommendations(results);

    return results;
  }

  /**
   * 生成优化建议
   */
  generateRecommendations(analysisResults) {
    const recommendations = [];

    // 数据库瓶颈建议
    if (analysisResults.bottleneckDistribution.database > analysisResults.totalSamples * 0.3) {
      recommendations.push({
        priority: 'high',
        category: 'database',
        issue: '数据库操作是主要性能瓶颈',
        suggestions: [
          '检查并优化慢查询索引',
          '评估数据库连接池配置',
          '考虑使用查询缓存',
          '检查是否存在 N+1 查询问题',
          '评估是否需要分库分表'
        ]
      });
    }

    // API 瓶颈建议
    if (analysisResults.bottleneckDistribution.external_api > analysisResults.totalSamples * 0.2) {
      recommendations.push({
        priority: 'high',
        category: 'external_api',
        issue: '外部 API 调用影响性能',
        suggestions: [
          '增加 API 调用的熔断机制',
          '并行化多个 API 调用',
          '缓存 API 响应结果',
          '评估 API 调用必要性',
          '检查 API 超时配置'
        ]
      });
    }

    // 缓存相关建议
    if (analysisResults.issueDistribution.slow_cache_op > analysisResults.totalSamples * 0.1) {
      recommendations.push({
        priority: 'medium',
        category: 'cache',
        issue: '缓存操作响应缓慢',
        suggestions: [
          '检查 Redis 服务器状态',
          '评估缓存键设计',
          '考虑使用本地缓存',
          '检查网络延迟',
          '评估 Redis 配置参数'
        ]
      });
    }

    // 针对具体端点的建议
    for (const [endpoint, ep] of Object.entries(analysisResults.endpointAnalysis)) {
      if (ep.avgMs > 1000) {
        recommendations.push({
          priority: 'high',
          category: 'endpoint',
          endpoint,
          issue: `端点 ${endpoint} 平均响应时间过长 (${ep.avgMs}ms)`,
          suggestions: [
            '分析端点业务逻辑复杂度',
            '检查是否存在不必要的计算',
            '考虑异步处理耗时操作',
            '评估是否可以预计算结果'
          ]
        });
      }
    }

    return recommendations;
  }

  /**
   * 保存分析报告
   */
  async saveReport(report) {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      
      const filename = `perf-report-${new Date().toISOString().split('T')[0]}.json`;
      const filepath = path.join(this.storageDir, filename);
      
      await fs.writeFile(filepath, JSON.stringify(report, null, 2));
      
      return filepath;
    } catch (error) {
      console.error('Failed to save performance report:', error);
      throw error;
    }
  }

  /**
   * 读取历史报告
   */
  async loadHistoryReports(days = 7) {
    try {
      const files = await fs.readdir(this.storageDir);
      const reports = [];
      
      for (const file of files) {
        if (file.startsWith('perf-report-') && file.endsWith('.json')) {
          const filepath = path.join(this.storageDir, file);
          const content = await fs.readFile(filepath, 'utf8');
          reports.push(JSON.parse(content));
        }
      }
      
      // 按时间排序，取最近 days 天
      reports.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
      
      return reports.slice(0, days);
    } catch (error) {
      console.error('Failed to load history reports:', error);
      return [];
    }
  }

  /**
   * 性能趋势分析
   */
  async analyzeTrend(days = 7) {
    const history = await this.loadHistoryReports(days);
    
    if (history.length < 2) {
      return { trend: 'insufficient_data', message: '历史数据不足，无法分析趋势' };
    }

    const trend = {
      avgResponseTime: [],
      errorRate: [],
      cacheHitRate: [],
      topHotspots: []
    };

    for (const report of history) {
      trend.avgResponseTime.push({
        date: report.generatedAt?.split('T')[0],
        value: report.stats?.avgProcessingTimeMs || 0
      });

      // 计算错误率趋势
      const errorCount = report.hotspots?.reduce((sum, h) => sum + h.errorRate, 0) || 0;
      trend.errorRate.push({
        date: report.generatedAt?.split('T')[0],
        value: errorCount / (report.stats?.sampledRequests || 1) * 100
      });

      // 收集热点端点
      if (report.hotspots) {
        trend.topHotspots.push(...report.hotspots.slice(0, 5));
      }
    }

    // 计算趋势方向
    const recentAvg = trend.avgResponseTime.slice(-3).reduce((sum, t) => sum + t.value, 0) / 3;
    const olderAvg = trend.avgResponseTime.slice(0, 3).reduce((sum, t) => sum + t.value, 0) / 3;
    
    trend.trendDirection = recentAvg > olderAvg ? 'degrading' : 'improving';
    trend.trendPercentage = Math.round((recentAvg - olderAvg) / olderAvg * 100);
    
    return trend;
  }
}

module.exports = { PerformanceAnalyzer };