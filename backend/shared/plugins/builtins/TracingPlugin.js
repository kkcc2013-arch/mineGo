const { IPlugin } = require('../IPlugin');
const { context, trace, propagation } = require('@opentelemetry/api');

/**
 * 链路追踪插件 - OpenTelemetry 集成
 */
class TracingPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'tracing',
      version: '1.0.0',
      description: '分布式链路追踪中间件，OpenTelemetry 集成',
      author: 'mineGo Team',
      dependencies: [],
      priority: 5, // 最高优先级（追踪应最早执行）
      category: 'monitoring',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        serviceName: { type: 'string' },
        sampleRate: { type: 'number' },
        jaegerEndpoint: { type: 'string' },
      },
      required: ['serviceName'],
    };
  }

  static get defaultConfig() {
    return {
      serviceName: process.env.SERVICE_NAME || 'mineGo-service',
      sampleRate: 1.0,
      jaegerEndpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'tracing' });
    this.tracer = null;
    
    this.logger.info({ config }, 'Tracing plugin initialized');
  }

  async start(context) {
    try {
      // 获取全局 tracer
      this.tracer = trace.getTracer(this.config.serviceName);
      this.logger.info('Tracing plugin started');
    } catch (err) {
      this.logger.error({ err }, 'Tracing plugin start failed');
    }
  }

  async stop(context) {
    this.logger.info('Tracing plugin stopped');
  }

  async healthCheck() {
    return {
      status: this.tracer ? 'healthy' : 'degraded',
      details: {
        serviceName: this.config.serviceName,
        sampleRate: this.config.sampleRate,
      },
    };
  }

  getMiddleware() {
    return (req, res, next) => {
      if (!this.tracer) {
        return next();
      }

      // 从请求头提取 trace context
      const incomingContext = propagation.extract(context.active(), req.headers);
      
      // 创建 span
      const spanName = `${req.method} ${req.route?.path || req.path}`;
      const span = this.tracer.startSpan(spanName, {
        kind: 1, // SERVER
        attributes: {
          'http.method': req.method,
          'http.url': req.originalUrl,
          'http.route': req.route?.path || req.path,
          'http.host': req.get('host'),
          'http.scheme': req.protocol,
          'http.user_agent': req.get('user-agent'),
          'http.request_content_length': req.get('content-length'),
        },
      }, incomingContext);

      // 设置当前 context
      const currentContext = trace.setSpan(incomingContext, span);
      
      // 将 trace ID 添加到请求对象
      req.traceId = span.spanContext().traceId;
      req.span = span;

      // 响应结束时关闭 span
      res.on('finish', () => {
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_content_length': res.get('content-length'),
        });

        if (res.statusCode >= 400) {
          span.setStatus({ code: 2 }); // ERROR
        }

        span.end();
      });

      // 在当前 context 中执行后续中间件
      context.with(currentContext, next);
    };
  }
}

module.exports = TracingPlugin;
