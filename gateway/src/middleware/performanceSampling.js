/**
 * Performance Sampling Middleware
 * REQ-00502: 性能分析与深度优化框架设计
 * 
 * 用于 Gateway 层的性能采样拦截器
 */

const { getPerformanceSampler } = require('../../backend/shared/PerformanceSampler');

/**
 * 性能采样中间件
 * @param {Object} options - 配置选项
 * @param {number} options.samplingRate - 采样率 (0-1)
 */
function performanceSamplingMiddleware(options = {}) {
  const sampler = getPerformanceSampler({
    samplingRate: options.samplingRate || 0.05,
    maxSamples: options.maxSamples || 1000,
    sampleWindowMs: options.sampleWindowMs || 60000
  });

  return async (req, res, next) => {
    // 判断是否需要采样
    if (!sampler.shouldSample()) {
      return next();
    }

    // 创建采样追踪对象
    const sample = sampler.startSampling({
      serviceName: 'gateway',
      path: req.path,
      originalUrl: req.originalUrl,
      method: req.method,
      user: req.user
    });

    // 将 sampler 和 sample 附加到 request 对象
    req._perfSampler = sampler;
    req._perfSample = sample;

    // 记录认证阶段
    sampler.startPhase(sample, 'auth');

    // 拦截 res.json 和 res.send 来记录响应阶段
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = (body) => {
      sampler.startPhase(sample, 'response');
      return originalJson(body);
    };

    res.send = (body) => {
      sampler.startPhase(sample, 'response');
      return originalSend(body);
    };

    // 监听响应完成
    res.on('finish', () => {
      sampler.endPhase(sample, 'response');
      sampler.endSampling(sample, res.statusCode);
    });

    // 监听错误
    res.on('error', (error) => {
      sampler.endSampling(sample, res.statusCode || 500, error.message);
    });

    next();
  };
}

/**
 * 数据库操作追踪中间件
 */
function dbTrackingMiddleware() {
  return async (req, res, next) => {
    if (!req._perfSampler || !req._perfSample) {
      return next();
    }

    const sampler = req._perfSampler;
    const sample = req._perfSample;

    // 开始数据库阶段
    sampler.startPhase(sample, 'db');

    next();

    // 在响应时结束数据库阶段
    res.on('finish', () => {
      sampler.endPhase(sample, 'db');
    });
  };
}

/**
 * 缓存操作追踪中间件
 */
function cacheTrackingMiddleware() {
  return async (req, res, next) => {
    if (!req._perfSampler || !req._perfSample) {
      return next();
    }

    const sampler = req._perfSampler;
    const sample = req._perfSample;

    sampler.startPhase(sample, 'cache');

    next();

    res.on('finish', () => {
      sampler.endPhase(sample, 'cache');
    });
  };
}

/**
 * API 调用追踪中间件
 */
function apiTrackingMiddleware() {
  return async (req, res, next) => {
    if (!req._perfSampler || !req._perfSample) {
      return next();
    }

    const sampler = req._perfSampler;
    const sample = req._perfSample;

    sampler.startPhase(sample, 'api');

    next();

    res.on('finish', () => {
      sampler.endPhase(sample, 'api');
    });
  };
}

/**
 * 性能报告路由
 */
function setupPerformanceRoutes(app, sampler) {
  // 获取性能报告
  app.get('/admin/performance/report', (req, res) => {
    const report = sampler.generateReport();
    res.json(report);
  });

  // 获取热点分析
  app.get('/admin/performance/hotspots', (req, res) => {
    const hotspots = sampler.analyzeHotspots();
    res.json({ hotspots, count: hotspots.length });
  });

  // 更新采样率
  app.post('/admin/performance/sampling-rate', (req, res) => {
    const { rate } = req.body;
    
    if (typeof rate !== 'number' || rate < 0 || rate > 1) {
      return res.status(400).json({ error: 'Invalid sampling rate (must be 0-1)' });
    }

    sampler.setSamplingRate(rate);
    res.json({ 
      message: 'Sampling rate updated',
      samplingRate: rate,
      samplingRatePercent: (rate * 100).toFixed(2) + '%'
    });
  });

  // 获取 Prometheus 指标
  app.get('/metrics/performance', async (req, res) => {
    try {
      const metrics = await sampler.getMetrics();
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 清空统计数据
  app.post('/admin/performance/reset', (req, res) => {
    sampler.resetStats();
    res.json({ message: 'Performance stats reset successfully' });
  });
}

module.exports = {
  performanceSamplingMiddleware,
  dbTrackingMiddleware,
  cacheTrackingMiddleware,
  apiTrackingMiddleware,
  setupPerformanceRoutes
};