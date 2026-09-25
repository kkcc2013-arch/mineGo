// shared/logger.js - 结构化日志模块
'use strict';
const pino = require('pino');
const { context, trace } = require('@opentelemetry/api');
const traceContext = require('./traceContext');

/**
 * 创建结构化日志实例
 * @param {string} serviceName - 服务名称
 * @returns {pino.Logger} Pino 日志实例
 */
function createLogger(serviceName) {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { 
      service: serviceName,
      pid: process.pid,
    },
    // REQ-00042：JSON Lines 字段 level / service / timestamp / trace_id
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    // 请求内的每条日志自动带上 trace_id / request_id；请求之外（定时任务、消费者）有活动 span 时取 span 的 trace id
    mixin() {
      const ctx = traceContext.current();
      if (ctx) return { trace_id: ctx.traceId, request_id: ctx.requestId };
      const traceId = traceContext.activeTraceId();
      return traceId ? { trace_id: traceId } : {};
    },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => {
        // 移除默认的 hostname，保留 service 和 pid
        const { hostname, ...rest } = bindings;
        return rest;
      }
    },
    // 生产环境使用 JSON，开发环境使用 pretty
    transport: isProduction ? undefined : {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        timestampKey: 'timestamp',
        ignore: 'pid',
      }
    },
    // 红action字段（敏感信息）
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token'],
      censor: '[REDACTED]'
    }
  });

  return logger;
}

/**
 * 创建子日志器（带预设上下文）
 * @param {pino.Logger} logger - 父日志器
 * @param {object} context - 预设上下文
 * @returns {pino.Logger} 子日志器
 */
function childLogger(logger, context) {
  return logger.child(context);
}

/**
 * Express 中间件：请求日志
 * @param {pino.Logger} logger - 日志实例
 */
function requestLogger(logger) {
  return (req, res, next) => {
    const startTime = Date.now();
    const rawReqId = req.headers['x-request-id'];
    const reqId = (typeof rawReqId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(rawReqId)) ? rawReqId : `req-${Date.now()}`;
    
    // 将 reqId 注入到 request 对象
    req.reqId = reqId;
    
    // 获取当前追踪上下文
    const span = trace.getSpan(context.active());
    const spanContext = span ? span.spanContext() : null;

    // REQ-00042: trace id 优先取上游（网关）传入的值，其次 OTel span，最后本地生成
    const traceId = traceContext.traceIdFromHeaders(req.headers) || (spanContext && spanContext.traceId) || traceContext.newTraceId();
    req.traceId = traceId;
    if (!res.headersSent) res.setHeader('X-Trace-Id', traceId);
    
    // 构建基础日志信息
    const logData = {
      reqId,
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
    };
    
    // 自动注入追踪信息
    if (spanContext) {
      logData.traceId = spanContext.traceId;
      logData.spanId = spanContext.spanId;
    }
    
    logData.trace_id = traceId;

    // 记录请求开始
    logger.info(logData, 'Request started');
    
    // 记录请求结束
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const level = res.statusCode >= 400 ? 'warn' : 'info';
      
      const finishLogData = {
        reqId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        contentLength: res.getHeader('content-length'),
      };
      
      // 自动注入追踪信息
      if (spanContext) {
        finishLogData.traceId = spanContext.traceId;
        finishLogData.spanId = spanContext.spanId;
      }
      
      finishLogData.trace_id = traceId;
      logger[level](finishLogData, 'Request completed');
    });
    
    // 后续中间件与业务处理在该追踪上下文内执行
    traceContext.als.run({ traceId, requestId: reqId }, next);
  };
}

const defaultLogger = createLogger('app');

module.exports = {
  createLogger,
  childLogger,
  requestLogger,
  logger: defaultLogger, // 兼容 `const { logger } = require('shared/logger')` 的写法
  child: defaultLogger.child.bind(defaultLogger),
  info: defaultLogger.info.bind(defaultLogger),
  error: defaultLogger.error.bind(defaultLogger),
  warn: defaultLogger.warn.bind(defaultLogger),
  debug: defaultLogger.debug.bind(defaultLogger),
  trace: defaultLogger.trace.bind(defaultLogger),
  fatal: defaultLogger.fatal.bind(defaultLogger),
};
