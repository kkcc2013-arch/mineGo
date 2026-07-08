/**
 * PerformanceSampler - 性能采样中间件核心模块
 * REQ-00502: 性能分析与深度优化框架设计
 * 
 * 功能：
 * - 按配置比例对请求进行采样
 * - 记录全链路各阶段耗时（数据库、缓存、外部API）
 * - 自动生成性能热点分析报告
 */

const { v4: uuidv4 } = require('uuid');
const { Client: PrometheusClient } = require('prom-client');

class PerformanceSampler {
  constructor(options = {}) {
    this.samplingRate = options.samplingRate || 0.05; // 默认 5% 采样率
    this.maxSamples = options.maxSamples || 1000; // 最大样本数
    this.sampleWindowMs = options.sampleWindowMs || 60000; // 采样窗口 1 分钟
    this.samples = [];
    this.stats = {
      totalRequests: 0,
      sampledRequests: 0,
      dbTimeMs: 0,
      cacheTimeMs: 0,
      apiTimeMs: 0,
      totalProcessingTimeMs: 0
    };
    
    // Prometheus 指标
    this.initPrometheusMetrics();
    
    // 启动定期清理
    this.startCleanupTimer();
  }

  initPrometheusMetrics() {
    this.metrics = {
      // 请求总耗时
      requestDuration: new PrometheusClient.Histogram({
        name: 'perf_request_duration_ms',
        help: 'Request processing duration in milliseconds',
        labelNames: ['service', 'endpoint', 'method', 'status'],
        buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000]
      }),
      
      // 数据库耗时
      dbDuration: new PrometheusClient.Histogram({
        name: 'perf_db_duration_ms',
        help: 'Database operation duration in milliseconds',
        labelNames: ['service', 'operation', 'table'],
        buckets: [1, 5, 10, 50, 100, 200, 500]
      }),
      
      // 缓存耗时
      cacheDuration: new PrometheusClient.Histogram({
        name: 'perf_cache_duration_ms',
        help: 'Cache operation duration in milliseconds',
        labelNames: ['service', 'operation', 'hit'],
        buckets: [0.5, 1, 2, 5, 10, 20, 50]
      }),
      
      // 外部 API 耗时
      apiDuration: new PrometheusClient.Histogram({
        name: 'perf_api_duration_ms',
        help: 'External API call duration in milliseconds',
        labelNames: ['service', 'target_service', 'endpoint'],
        buckets: [5, 10, 50, 100, 200, 500, 1000, 2000]
      }),
      
      // 热点统计
      hotspotCount: new PrometheusClient.Counter({
        name: 'perf_hotspot_count',
        help: 'Number of identified performance hotspots',
        labelNames: ['service', 'endpoint', 'type']
      })
    };
  }

  /**
   * 判断是否需要采样当前请求
   */
  shouldSample() {
    this.stats.totalRequests++;
    const sample = Math.random() < this.samplingRate;
    if (sample) {
      this.stats.sampledRequests++;
    }
    return sample;
  }

  /**
   * 开始采样，创建采样追踪对象
   */
  startSampling(req) {
    const traceId = uuidv4();
    const sample = {
      traceId,
      startTime: Date.now(),
      service: req.serviceName || 'unknown',
      endpoint: req.path || req.originalUrl || 'unknown',
      method: req.method || 'GET',
      userId: req.user?.id || null,
      phases: {
        auth: { startTime: null, endTime: null, durationMs: 0 },
        validation: { startTime: null, endTime: null, durationMs: 0 },
        db: { startTime: null, endTime: null, durationMs: 0, operations: [] },
        cache: { startTime: null, endTime: null, durationMs: 0, operations: [] },
        api: { startTime: null, endTime: null, durationMs: 0, operations: [] },
        business: { startTime: null, endTime: null, durationMs: 0 },
        response: { startTime: null, endTime: null, durationMs: 0 }
      },
      statusCode: null,
      error: null
    };
    
    return sample;
  }

  /**
   * 记录阶段开始
   */
  startPhase(sample, phaseName) {
    if (sample && sample.phases[phaseName]) {
      sample.phases[phaseName].startTime = Date.now();
    }
  }

  /**
   * 记录阶段结束
   */
  endPhase(sample, phaseName) {
    if (sample && sample.phases[phaseName]) {
      sample.phases[phaseName].endTime = Date.now();
      sample.phases[phaseName].durationMs = 
        sample.phases[phaseName].endTime - sample.phases[phaseName].startTime;
    }
  }

  /**
   * 记录数据库操作
   */
  recordDbOperation(sample, operation, table, durationMs, query) {
    if (!sample) return;
    
    this.stats.dbTimeMs += durationMs;
    sample.phases.db.operations.push({
      operation,
      table,
      durationMs,
      query: query?.substring(0, 200) // 限制长度
    });
    
    this.metrics.dbDuration.observe(
      { service: sample.service, operation, table },
      durationMs
    );
  }

  /**
   * 记录缓存操作
   */
  recordCacheOperation(sample, operation, key, durationMs, hit) {
    if (!sample) return;
    
    this.stats.cacheTimeMs += durationMs;
    sample.phases.cache.operations.push({
      operation,
      key: key?.substring(0, 100),
      durationMs,
      hit
    });
    
    this.metrics.cacheDuration.observe(
      { service: sample.service, operation, hit: hit ? 'true' : 'false' },
      durationMs
    );
  }

  /**
   * 记录外部 API 调用
   */
  recordApiCall(sample, targetService, endpoint, durationMs, statusCode) {
    if (!sample) return;
    
    this.stats.apiTimeMs += durationMs;
    sample.phases.api.operations.push({
      targetService,
      endpoint,
      durationMs,
      statusCode
    });
    
    this.metrics.apiDuration.observe(
      { service: sample.service, target_service: targetService, endpoint },
      durationMs
    );
  }

  /**
   * 结束采样，提交样本
   */
  endSampling(sample, statusCode, error = null) {
    if (!sample) return;
    
    sample.endTime = Date.now();
    sample.totalDurationMs = sample.endTime - sample.startTime;
    sample.statusCode = statusCode;
    sample.error = error;
    
    // 更新统计
    this.stats.totalProcessingTimeMs += sample.totalDurationMs;
    
    // Prometheus 指标
    this.metrics.requestDuration.observe(
      { service: sample.service, endpoint: sample.endpoint, method: sample.method, status: statusCode },
      sample.totalDurationMs
    );
    
    // 保存样本
    this.samples.push(sample);
    
    // 超过限制时清理旧样本
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * 分析性能热点
   */
  analyzeHotspots() {
    const hotspots = [];
    
    // 按端点聚合
    const endpointStats = {};
    for (const sample of this.samples) {
      const key = `${sample.service}:${sample.endpoint}`;
      if (!endpointStats[key]) {
        endpointStats[key] = {
          count: 0,
          totalMs: 0,
          dbMs: 0,
          cacheMs: 0,
          apiMs: 0,
          errors: 0
        };
      }
      endpointStats[key].count++;
      endpointStats[key].totalMs += sample.totalDurationMs;
      endpointStats[key].dbMs += sample.phases.db.durationMs;
      endpointStats[key].cacheMs += sample.phases.cache.durationMs;
      endpointStats[key].apiMs += sample.phases.api.durationMs;
      if (sample.error) endpointStats[key].errors++;
    }
    
    // 计算平均值并识别热点（P95 > 500ms）
    for (const [key, stats] of Object.entries(endpointStats)) {
      const avgMs = stats.totalMs / stats.count;
      const avgDbMs = stats.dbMs / stats.count;
      const avgCacheMs = stats.cacheMs / stats.count;
      const avgApiMs = stats.apiMs / stats.count;
      
      if (avgMs > 500) {
        // 确定瓶颈类型
        let bottleneckType = 'unknown';
        if (avgDbMs > avgMs * 0.5) bottleneckType = 'database';
        else if (avgApiMs > avgMs * 0.3) bottleneckType = 'external_api';
        else if (avgCacheMs > avgMs * 0.2) bottleneckType = 'cache';
        else bottleneckType = 'business_logic';
        
        hotspots.push({
          endpoint: key,
          avgMs: Math.round(avgMs),
          bottleneckType,
          dbMs: Math.round(avgDbMs),
          cacheMs: Math.round(avgCacheMs),
          apiMs: Math.round(avgApiMs),
          errorRate: Math.round((stats.errors / stats.count) * 100),
          sampleCount: stats.count
        });
        
        // Prometheus 热点计数
        const [service, endpoint] = key.split(':');
        this.metrics.hotspotCount.inc({ service, endpoint, type: bottleneckType });
      }
    }
    
    // 按平均耗时排序
    hotspots.sort((a, b) => b.avgMs - a.avgMs);
    
    return hotspots;
  }

  /**
   * 生成性能报告
   */
  generateReport() {
    const hotspots = this.analyzeHotspots();
    const now = new Date();
    
    const report = {
      generatedAt: now.toISOString(),
      samplingRate: this.samplingRate,
      stats: {
        totalRequests: this.stats.totalRequests,
        sampledRequests: this.stats.sampledRequests,
        actualSamplingRate: this.stats.totalRequests > 0 
          ? (this.stats.sampledRequests / this.stats.totalRequests * 100).toFixed(2) + '%' 
          : '0%',
        avgProcessingTimeMs: this.stats.sampledRequests > 0 
          ? Math.round(this.stats.totalProcessingTimeMs / this.stats.sampledRequests) 
          : 0,
        avgDbTimeMs: this.stats.sampledRequests > 0 
          ? Math.round(this.stats.dbTimeMs / this.stats.sampledRequests) 
          : 0,
        avgCacheTimeMs: this.stats.sampledRequests > 0 
          ? Math.round(this.stats.cacheTimeMs / this.stats.sampledRequests) 
          : 0,
        avgApiTimeMs: this.stats.sampledRequests > 0 
          ? Math.round(this.stats.apiTimeMs / this.stats.sampledRequests) 
          : 0
      },
      hotspots,
      topSlowOperations: this.getTopSlowOperations(),
      recommendations: this.generateRecommendations(hotspots)
    };
    
    return report;
  }

  /**
   * 获取最慢的操作详情
   */
  getTopSlowOperations() {
    const operations = [];
    
    for (const sample of this.samples) {
      // 数据库慢查询
      for (const op of sample.phases.db.operations) {
        if (op.durationMs > 100) {
          operations.push({
            type: 'db',
            service: sample.service,
            endpoint: sample.endpoint,
            operation: op.operation,
            table: op.table,
            durationMs: op.durationMs,
            traceId: sample.traceId
          });
        }
      }
      
      // API 慢调用
      for (const op of sample.phases.api.operations) {
        if (op.durationMs > 500) {
          operations.push({
            type: 'api',
            service: sample.service,
            endpoint: sample.endpoint,
            targetService: op.targetService,
            durationMs: op.durationMs,
            traceId: sample.traceId
          });
        }
      }
    }
    
    // 按耗时排序，取前 20
    operations.sort((a, b) => b.durationMs - a.durationMs);
    return operations.slice(0, 20);
  }

  /**
   * 生成优化建议
   */
  generateRecommendations(hotspots) {
    const recommendations = [];
    
    for (const hotspot of hotspots) {
      if (hotspot.bottleneckType === 'database') {
        recommendations.push({
          endpoint: hotspot.endpoint,
          issue: `数据库操作耗时过高（平均 ${hotspot.dbMs}ms）`,
          suggestions: [
            '检查是否存在慢查询，考虑添加索引',
            '评估查询复杂度，考虑简化或拆分',
            '检查数据库连接池配置',
            '考虑使用缓存减少数据库访问'
          ]
        });
      } else if (hotspot.bottleneckType === 'external_api') {
        recommendations.push({
          endpoint: hotspot.endpoint,
          issue: `外部 API 调用耗时过高（平均 ${hotspot.apiMs}ms）`,
          suggestions: [
            '检查目标服务性能',
            '考虑增加超时和熔断机制',
            '评估是否可以并行调用',
            '考虑缓存 API 响应结果'
          ]
        });
      } else if (hotspot.bottleneckType === 'cache') {
        recommendations.push({
          endpoint: hotspot.endpoint,
          issue: `缓存操作耗时异常（平均 ${hotspot.cacheMs}ms）`,
          suggestions: [
            '检查 Redis 连接状态',
            '评估缓存键设计是否合理',
            '检查是否存在缓存穿透',
            '考虑本地缓存作为二级缓存'
          ]
        });
      } else if (hotspot.bottleneckType === 'business_logic') {
        recommendations.push({
          endpoint: hotspot.endpoint,
          issue: `业务逻辑耗时过高（平均 ${hotspot.avgMs}ms）`,
          suggestions: [
            '检查是否存在 CPU 密集型计算',
            '考虑异步处理耗时操作',
            '评估是否可以预计算或缓存结果',
            '检查是否存在循环中的重复计算'
          ]
        });
      }
    }
    
    return recommendations;
  }

  /**
   * 定期清理旧样本
   */
  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      this.samples = this.samples.filter(s => now - s.startTime < this.sampleWindowMs);
    }, this.sampleWindowMs);
  }

  /**
   * 更新采样率
   */
  setSamplingRate(rate) {
    if (rate >= 0 && rate <= 1) {
      this.samplingRate = rate;
      console.log(`Performance sampling rate updated to ${(rate * 100).toFixed(2)}%`);
    }
  }

  /**
   * 获取 Prometheus 指标
   */
  getMetrics() {
    return PrometheusClient.register.metrics();
  }

  /**
   * 清空统计数据
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      sampledRequests: 0,
      dbTimeMs: 0,
      cacheTimeMs: 0,
      apiTimeMs: 0,
      totalProcessingTimeMs: 0
    };
    this.samples = [];
  }
}

// 单例模式
let instance = null;

function getPerformanceSampler(options = {}) {
  if (!instance) {
    instance = new PerformanceSampler(options);
  }
  return instance;
}

module.exports = {
  PerformanceSampler,
  getPerformanceSampler
};