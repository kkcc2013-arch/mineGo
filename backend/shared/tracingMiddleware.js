// shared/tracingMiddleware.js - Express 追踪中间件
'use strict';

const { context, trace, propagation } = require('@opentelemetry/api');
const { getTracer } = require('./tracing');

/**
 * Express 中间件：自动为每个请求创建 span
 * @param {string} serviceName - 服务名称
 * @returns {Function} Express 中间件
 */
function tracingMiddleware(serviceName) {
  const tracer = getTracer(serviceName);

  return (req, res, next) => {
    // 从请求头提取上游追踪上下文
    const incomingContext = propagation.extract(context.active(), req.headers);

    // 创建 span 名称
    const routePath = req.route?.path || req.path;
    const spanName = `${req.method} ${routePath}`;

    // 启动 span
    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': req.method,
        'http.url': req.originalUrl || req.url,
        'http.target': req.path,
        'http.host': req.get('host') || 'unknown',
        'http.scheme': req.protocol || 'http',
        'http.user_agent': req.get('user-agent') || 'unknown',
        'http.request_content_length': req.get('content-length') || 0,
        'net.transport': 'IP.TCP',
      },
    }, incomingContext);

    // 将 span 设置为当前 active span
    const spanContext = context.with(trace.setSpan(context.active(), span), () => {
      // 监听响应完成事件
      res.on('finish', () => {
        // 设置响应属性
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_content_length': parseInt(res.get('content-length') || '0', 10),
        });

        // 标记错误状态
        if (res.statusCode >= 400) {
          span.setStatus({
            code: res.statusCode >= 500 ? 2 : 1, // 2=Error, 1=Warning
            message: `HTTP ${res.statusCode}`,
          });
          span.setAttribute('http.error', true);
        } else {
          span.setStatus({ code: 0 }); // 0=Ok
        }

        // 结束 span
        span.end();
      });

      // 将追踪信息注入到请求对象（方便后续使用）
      req.span = span;
      req.traceId = span.spanContext().traceId;

      // 继续处理请求
      next();
    });
  };
}

/**
 * 注入追踪上下文到请求头（用于服务间调用）
 * @param {object} headers - 请求头对象
 * @returns {object} 注入追踪上下文后的请求头
 */
function injectTraceContext(headers = {}) {
  const currentContext = context.active();
  propagation.inject(currentContext, headers);
  return headers;
}

/**
 * 创建子 span（用于追踪内部操作）
 * @param {string} name - Span 名称
 * @param {object} attributes - Span 属性
 * @returns {Span} Span 实例
 */
function startChildSpan(name, attributes = {}) {
  const currentSpan = trace.getSpan(context.active());
  if (!currentSpan) {
    return null;
  }

  const tracer = getTracer();
  const span = tracer.startSpan(name, {
    attributes,
  });

  return span;
}

/**
 * 追踪异步操作的辅助函数
 * @param {string} name - Span 名称
 * @param {Function} fn - 要执行的函数
 * @param {object} attributes - Span 属性
 * @returns {Promise<any>} 函数执行结果
 */
async function traceAsync(name, fn, attributes = {}) {
  const span = startChildSpan(name, attributes);
  
  try {
    const result = await fn();
    if (span) {
      span.setStatus({ code: 0 });
      span.end();
    }
    return result;
  } catch (error) {
    if (span) {
      span.setStatus({ code: 2, message: error.message });
      span.recordException(error);
      span.end();
    }
    throw error;
  }
}

module.exports = {
  tracingMiddleware,
  injectTraceContext,
  startChildSpan,
  traceAsync,
};
