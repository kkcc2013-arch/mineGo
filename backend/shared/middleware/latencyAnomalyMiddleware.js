/**
 * REQ-00599: API 响应延迟异常检测中间件
 * 自动监控所有 API 请求的延迟并检测异常
 */

const logger = require('../logger');
const { LatencyBaselineCalculator, LatencyAnomalyDetector } = require('../latencyBaselineCalculator');
const { metrics } = require('../metrics');

/**
 * 延迟异常检测中间件
 */
class LatencyAnomalyMiddleware {
  constructor(options = {}) {
    this.detector = new LatencyAnomalyDetector({
      windowSize: options.windowSize || 3600, // 1 小时窗口
      consecutiveThreshold: options.consecutiveThreshold || 3,
      anomalyWindow: options.anomalyWindow || 300000, // 5 分钟
      alertCooldown: options.alertCooldown || 600000, // 10 分钟冷却
      thresholdMultiplier: options.thresholdMultiplier || 3
    });
    
    this.excludePaths = options.excludePaths || [
      '/health',
      '/metrics',
      '/favicon.ico'
    ];
    
    this.slowThreshold = options.slowThreshold || 5000; // 5 秒以上认为慢请求
    this.alertHandlers = [];
    
    // 注册默认告警处理器
    this.detector.on('alert', (alert) => {
      this.handleAlert(alert);
    });
    
    this.isStarted = false;
  }

  /**
   * 启动中间件
   */
  start() {
    if (this.isStarted) {
      return;
    }
    
    this.detector.start();
    this.isStarted = true;
    
    logger.info('Latency anomaly middleware started', {
      excludePaths: this.excludePaths,
      slowThreshold: this.slowThreshold
    });
  }

  /**
   * 停止中间件
   */
  stop() {
    if (!this.isStarted) {
      return;
    }
    
    this.detector.stop();
    this.isStarted = false;
    
    logger.info('Latency anomaly middleware stopped');
  }

  /**
   * 添加告警处理器
   * @param {Function} handler - 告警处理函数
   */
  addAlertHandler(handler) {
    this.alertHandlers.push(handler);
  }

  /**
   * 处理告警
   * @param {Object} alert - 告警对象
   */
  async handleAlert(alert) {
    logger.warn('Latency anomaly alert triggered', alert);
    
    // 调用所有告警处理器
    for (const handler of this.alertHandlers) {
      try {
        await handler(alert);
      } catch (error) {
        logger.error('Alert handler failed', {
          error: error.message,
          alert
        });
      }
    }
  }

  /**
   * Express 中间件
   */
  middleware() {
    return (req, res, next) => {
      // 排除特定路径
      if (this.excludePaths.some(path => req.path.startsWith(path))) {
        return next();
      }
      
      const startTime = Date.now();
      const endpoint = this.normalizeEndpoint(req.method, req.path);
      
      // 监听响应完成事件
      res.on('finish', () => {
        const latency = Date.now() - startTime;
        
        // 检测延迟异常
        const result = this.detector.detect(endpoint, latency);
        
        // 记录请求指标
        metrics.timing('http_request_duration_ms', latency, {
          method: req.method,
          endpoint,
          status_code: res.statusCode
        });
        
        // 慢请求日志
        if (latency > this.slowThreshold) {
          logger.warn('Slow request detected', {
            method: req.method,
            endpoint,
            latency,
            statusCode: res.statusCode,
            userAgent: req.get('user-agent'),
            ip: req.ip
          });
          
          metrics.increment('slow_requests_total', 1, {
            method: req.method,
            endpoint
          });
        }
        
        // 异常检测结果记录
        if (result.isAnomaly) {
          logger.warn('Request latency anomaly', {
            method: req.method,
            endpoint,
            latency,
            baseline: result.baseline,
            deviation: result.deviation
          });
        }
      });
      
      next();
    };
  }

  /**
   * 标准化端点名称
   * @param {string} method - HTTP 方法
   * @param {string} path - 请求路径
   * @returns {string} 标准化的端点名称
   */
  normalizeEndpoint(method, path) {
    // 替换路径参数为占位符
    // 例如：/api/users/123 -> /api/users/:id
    const normalized = path
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9]{24}/gi, '/:id') // MongoDB ObjectId
      .replace(/\/[a-f0-9-]{36}/gi, '/:uuid'); // UUID
    
    return `${method} ${normalized}`;
  }

  /**
   * 获取所有端点的状态
   */
  getStatus() {
    return {
      isRunning: this.isStarted,
      endpoints: this.detector.getAllAnomalyStatuses(),
      summary: {
        totalEndpoints: this.detector.calculator.baselines.size,
        activeAnomalies: this.detector.anomalyCounts.size
      }
    };
  }

  /**
   * 获取单个端点的状态
   * @param {string} method - HTTP 方法
   * @param {string} path - 请求路径
   */
  getEndpointStatus(method, path) {
    const endpoint = this.normalizeEndpoint(method, path);
    return this.detector.getAnomalyStatus(endpoint);
  }
}

/**
 * 创建中间件实例
 */
function createLatencyAnomalyMiddleware(options = {}) {
  const middleware = new LatencyAnomalyMiddleware(options);
  middleware.start();
  return middleware;
}

module.exports = {
  LatencyAnomalyMiddleware,
  createLatencyAnomalyMiddleware
};
