// backend/gateway/src/routes/tracing.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - 追踪查询 API
'use strict';

const express = require('express');
const router = express.Router();

// Tempo/Jaeger 服务地址
const TEMPO_URL = process.env.TEMPO_URL || 'http://tempo:3200';
const JAEGER_URL = process.env.JAEGER_URL || 'http://jaeger:16686';

/**
 * 获取单个 trace 详情
 * GET /api/tracing/traces/:traceId
 */
router.get('/traces/:traceId', async (req, res) => {
  const { traceId } = req.params;

  if (!traceId || traceId.length < 16) {
    return res.status(400).json({ error: 'Invalid trace ID' });
  }

  try {
    // 尝试从 Tempo 获取
    const tempoResponse = await fetch(`${TEMPO_URL}/api/traces/${traceId}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (tempoResponse.ok) {
      const trace = await tempoResponse.json();
      return res.json({
        source: 'tempo',
        traceId,
        data: trace,
      });
    }

    // 降级到 Jaeger
    const jaegerResponse = await fetch(`${JAEGER_URL}/api/traces/${traceId}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (jaegerResponse.ok) {
      const trace = await jaegerResponse.json();
      return res.json({
        source: 'jaeger',
        traceId,
        data: trace,
      });
    }

    return res.status(404).json({ 
      error: 'Trace not found',
      traceId,
    });
  } catch (error) {
    console.error('[TracingAPI] Error fetching trace:', error.message);
    return res.status(503).json({ 
      error: 'Tracing service unavailable',
      message: error.message,
    });
  }
});

/**
 * 搜索 traces
 * GET /api/tracing/traces
 * Query params: service, operation, start, end, limit, minDuration, maxDuration
 */
router.get('/traces', async (req, res) => {
  const {
    service,
    operation,
    start,
    end,
    limit = 20,
    minDuration,
    maxDuration,
    tags,
  } = req.query;

  try {
    // 构建 Tempo 搜索查询
    const searchParams = new URLSearchParams();
    
    if (service) searchParams.set('service', service);
    if (operation) searchParams.set('operation', operation);
    if (start) searchParams.set('start', start);
    if (end) searchParams.set('end', end);
    if (limit) searchParams.set('limit', Math.min(parseInt(limit, 10), 100));
    if (minDuration) searchParams.set('minDuration', minDuration);
    if (maxDuration) searchParams.set('maxDuration', maxDuration);
    if (tags) searchParams.set('tags', tags);

    const response = await fetch(`${TEMPO_URL}/api/search?${searchParams}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Tempo returned ${response.status}`);
    }

    const results = await response.json();
    
    res.json({
      source: 'tempo',
      query: { service, operation, start, end, limit, minDuration, maxDuration },
      results,
    });
  } catch (error) {
    console.error('[TracingAPI] Error searching traces:', error.message);
    res.status(503).json({ 
      error: 'Tracing search failed',
      message: error.message,
    });
  }
});

/**
 * 获取服务依赖图
 * GET /api/tracing/dependencies
 */
router.get('/dependencies', async (req, res) => {
  const { lookback = '24h' } = req.query;

  try {
    // 尝试从 Jaeger 获取依赖图（Tempo 不直接提供）
    const response = await fetch(`${JAEGER_URL}/api/dependencies?endTs=${Date.now()}&lookback=${lookback}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const deps = await response.json();
      return res.json({
        source: 'jaeger',
        lookback,
        dependencies: deps.data || [],
      });
    }

    // 如果 Jaeger 不可用，返回静态服务依赖
    const staticDeps = getStaticDependencies();
    res.json({
      source: 'static',
      lookback,
      dependencies: staticDeps,
    });
  } catch (error) {
    console.error('[TracingAPI] Error fetching dependencies:', error.message);
    
    // 返回静态依赖图
    const staticDeps = getStaticDependencies();
    res.json({
      source: 'static',
      lookback,
      dependencies: staticDeps,
      warning: 'Jaeger unavailable, using static dependencies',
    });
  }
});

/**
 * 获取服务列表
 * GET /api/tracing/services
 */
router.get('/services', async (req, res) => {
  try {
    const response = await fetch(`${JAEGER_URL}/api/services`, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return res.json({
        source: 'jaeger',
        services: data.data || [],
      });
    }

    // 返回静态服务列表
    res.json({
      source: 'static',
      services: getStaticServices(),
    });
  } catch (error) {
    res.json({
      source: 'static',
      services: getStaticServices(),
    });
  }
});

/**
 * 获取服务的操作列表
 * GET /api/tracing/services/:service/operations
 */
router.get('/services/:service/operations', async (req, res) => {
  const { service } = req.params;

  try {
    const response = await fetch(`${JAEGER_URL}/api/services/${encodeURIComponent(service)}/operations`, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return res.json({
        source: 'jaeger',
        service,
        operations: data.data || [],
      });
    }

    res.status(404).json({ error: 'Service not found' });
  } catch (error) {
    res.status(503).json({ error: 'Failed to fetch operations' });
  }
});

/**
 * 追踪统计摘要
 * GET /api/tracing/stats
 */
router.get('/stats', async (req, res) => {
  const { service, timeRange = '1h' } = req.query;

  // 计算时间范围
  const now = Date.now();
  const rangeMs = parseTimeRange(timeRange);
  const start = now - rangeMs;

  try {
    // 尝试从 Tempo 获取统计
    const searchParams = new URLSearchParams({
      start: start.toString(),
      end: now.toString(),
      limit: '1000',
    });
    
    if (service) searchParams.set('service', service);

    const response = await fetch(`${TEMPO_URL}/api/search?${searchParams}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const results = await response.json();
      const stats = calculateStats(results);
      
      return res.json({
        source: 'tempo',
        timeRange,
        service: service || 'all',
        ...stats,
      });
    }

    res.json({
      source: 'unavailable',
      timeRange,
      message: 'Tracing backend not available',
    });
  } catch (error) {
    res.status(503).json({ 
      error: 'Failed to get stats',
      message: error.message,
    });
  }
});

/**
 * 健康检查
 * GET /api/tracing/health
 */
router.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    backends: {},
  };

  // 检查 Tempo
  try {
    const tempoResp = await fetch(`${TEMPO_URL}/ready`, { 
      signal: AbortSignal.timeout(2000),
    });
    health.backends.tempo = tempoResp.ok ? 'healthy' : 'unhealthy';
  } catch {
    health.backends.tempo = 'unreachable';
  }

  // 检查 Jaeger
  try {
    const jaegerResp = await fetch(`${JAEGER_URL}/api/services`, { 
      signal: AbortSignal.timeout(2000),
    });
    health.backends.jaeger = jaegerResp.ok ? 'healthy' : 'unhealthy';
  } catch {
    health.backends.jaeger = 'unreachable';
  }

  // 整体状态
  if (health.backends.tempo === 'unreachable' && health.backends.jaeger === 'unreachable') {
    health.status = 'degraded';
  }

  res.json(health);
});

// ============ 辅助函数 ============

/**
 * 获取静态服务列表
 */
function getStaticServices() {
  return [
    'gateway',
    'user-service',
    'pokemon-service',
    'location-service',
    'catch-service',
    'gym-service',
    'social-service',
    'reward-service',
    'payment-service',
  ];
}

/**
 * 获取静态服务依赖图
 */
function getStaticDependencies() {
  return [
    { parent: 'gateway', child: 'user-service', callCount: 1000 },
    { parent: 'gateway', child: 'pokemon-service', callCount: 800 },
    { parent: 'gateway', child: 'location-service', callCount: 600 },
    { parent: 'gateway', child: 'catch-service', callCount: 500 },
    { parent: 'gateway', child: 'gym-service', callCount: 400 },
    { parent: 'gateway', child: 'social-service', callCount: 300 },
    { parent: 'gateway', child: 'reward-service', callCount: 350 },
    { parent: 'gateway', child: 'payment-service', callCount: 100 },
    { parent: 'catch-service', child: 'pokemon-service', callCount: 500 },
    { parent: 'catch-service', child: 'location-service', callCount: 500 },
    { parent: 'catch-service', child: 'user-service', callCount: 500 },
    { parent: 'gym-service', child: 'pokemon-service', callCount: 400 },
    { parent: 'gym-service', child: 'user-service', callCount: 400 },
    { parent: 'social-service', child: 'user-service', callCount: 300 },
    { parent: 'social-service', child: 'pokemon-service', callCount: 200 },
    { parent: 'reward-service', child: 'user-service', callCount: 350 },
    { parent: 'payment-service', child: 'user-service', callCount: 100 },
  ];
}

/**
 * 解析时间范围
 */
function parseTimeRange(range) {
  const units = {
    'm': 60 * 1000,
    'h': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000,
  };

  const match = range.match(/^(\d+)([mhdw])$/);
  if (match) {
    return parseInt(match[1], 10) * units[match[2]];
  }
  
  return 60 * 60 * 1000; // 默认 1 小时
}

/**
 * 计算统计信息
 */
function calculateStats(results) {
  const traces = results.traces || [];
  
  if (traces.length === 0) {
    return {
      totalTraces: 0,
      errorRate: 0,
      avgDuration: 0,
      p50Duration: 0,
      p95Duration: 0,
      p99Duration: 0,
    };
  }

  const durations = traces
    .map(t => t.durationMs || 0)
    .sort((a, b) => a - b);

  const errorCount = traces.filter(t => t.status === 'error').length;

  return {
    totalTraces: traces.length,
    errorRate: (errorCount / traces.length * 100).toFixed(2),
    avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    p50Duration: durations[Math.floor(durations.length * 0.5)] || 0,
    p95Duration: durations[Math.floor(durations.length * 0.95)] || 0,
    p99Duration: durations[Math.floor(durations.length * 0.99)] || 0,
  };
}

module.exports = router;
