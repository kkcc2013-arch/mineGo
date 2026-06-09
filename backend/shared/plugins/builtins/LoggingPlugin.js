const { IPlugin } = require('../IPlugin');
const logger = require('../../logger');

/**
 * 日志插件 - 结构化请求日志
 */
class LoggingPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'logging',
      version: '1.0.0',
      description: '结构化请求日志中间件',
      author: 'mineGo Team',
      dependencies: [],
      priority: 30,
      category: 'monitoring',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        logBody: { type: 'boolean' },
        logResponse: { type: 'boolean' },
        skipPaths: { type: 'array' },
        slowThresholdMs: { type: 'number' },
      },
      required: [],
    };
  }

  static get defaultConfig() {
    return {
      logBody: false,
      logResponse: false,
      skipPaths: ['/health', '/metrics', '/favicon.ico'],
      slowThresholdMs: 1000,
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'logging' });
    this.logger.info({ config }, 'Logging plugin initialized');
  }

  async start(context) {
    this.logger.info('Logging plugin started');
  }

  async stop(context) {
    this.logger.info('Logging plugin stopped');
  }

  async healthCheck() {
    return {
      status: 'healthy',
      details: {
        logBody: this.config.logBody,
        slowThresholdMs: this.config.slowThresholdMs,
      },
    };
  }

  getMiddleware() {
    return (req, res, next) => {
      const start = Date.now();
      
      // 跳过指定路径
      if (this.config.skipPaths.includes(req.path)) {
        return next();
      }

      // 请求日志
      const reqLog = {
        method: req.method,
        path: req.path,
        query: req.query,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      };

      if (this.config.logBody && req.body && Object.keys(req.body).length > 0) {
        // 敏感字段脱敏
        const sanitized = { ...req.body };
        if (sanitized.password) sanitized.password = '***';
        if (sanitized.token) sanitized.token = '***';
        reqLog.body = sanitized;
      }

      this.logger.info(reqLog, 'Request received');

      // 响应日志
      const originalEnd = res.end;
      res.end = function(...args) {
        const duration = Date.now() - start;
        
        const resLog = {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
          slow: duration > this.config.slowThresholdMs,
        };

        if (res.statusCode >= 400) {
          this.logger.error(resLog, 'Request failed');
        } else if (duration > this.config.slowThresholdMs) {
          this.logger.warn(resLog, 'Slow request');
        } else {
          this.logger.info(resLog, 'Request completed');
        }

        originalEnd.apply(res, args);
      }.bind(this);

      next();
    };
  }
}

module.exports = LoggingPlugin;
