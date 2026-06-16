// backend/shared/tracingMiddleware.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - Express 中间件
'use strict';

let traceApi = null;
let contextApi = null;
let propagationApi = null;
let semanticAttributes = null;
let tracer = null;

// 初始化 OpenTelemetry API（延迟加载）
async function initTracingApi() {
  if (tracer) return true;
  
  try {
    traceApi = (await import('@opentelemetry/api')).trace;
    contextApi = (await import('@opentelemetry/api')).context;
    propagationApi = (await import('@opentelemetry/api')).propagation;
    semanticAttributes = (await import('@opentelemetry/semantic-conventions')).SemanticAttributes;
    tracer = traceApi.getTracer('mineGo-http', '1.0.0');
    return true;
  } catch (error) {
    // OpenTelemetry 未安装，使用降级模式
    return false;
  }
}

// 同步获取 tracer（用于已初始化场景）
function getTracer() {
  return tracer;
}

/**
 * Express 追踪中间件
 * @param {string} serviceName - 服务名称
 * @returns {Function} Express 中间件
 */
function tracingMiddleware(serviceName) {
  // 标记是否已初始化
  let apiReady = false;
  
  // 异步初始化（不阻塞请求）
  initTracingApi().then(ready => {
    apiReady = ready;
  });

  return async (req, res, next) => {
    // 降级模式：直接跳过
    if (!apiReady || !tracer) {
      // 生成简单的 trace ID 用于日志关联
      req.traceId = generateSimpleTraceId();
      res.setHeader('X-Trace-Id', req.traceId);
      return next();
    }

    try {
      // 从请求头提取 trace context（跨服务传递）
      const ctx = propagationApi.extract(contextApi.active(), req.headers);
      
      // 创建 span 名称
      const routePath = req.route?.path || req.path;
      const spanName = `${req.method} ${routePath}`;
      
      // 创建 span
      const span = tracer.startSpan(spanName, {
        kind: traceApi.SpanKind.SERVER,
        attributes: {
          [semanticAttributes.HTTP_METHOD]: req.method,
          [semanticAttributes.HTTP_URL]: req.originalUrl,
          [semanticAttributes.HTTP_ROUTE]: routePath,
          [semanticAttributes.HTTP_TARGET]: req.path,
          'http.request.headers.x-request-id': req.headers['x-request-id'],
          'http.request.headers.x-forwarded-for': req.headers['x-forwarded-for'],
          'user.id': req.user?.id || null,
          'user.role': req.user?.role || null,
          'service.name': serviceName,
        },
      }, ctx);

      // 设置 trace context 到 request
      req.span = span;
      req.traceId = span.spanContext().traceId;
      req.spanContext = span.spanContext();

      // 设置响应头（便于前端调试和日志关联）
      res.setHeader('X-Trace-Id', span.spanContext().traceId);

      // 记录请求体大小
      if (req.headers['content-length']) {
        span.setAttribute('http.request.size', parseInt(req.headers['content-length'], 10));
      }

      // 响应结束时结束 span
      const originalEnd = res.end;
      res.end = function(chunk, encoding) {
        // 记录响应信息
        span.setAttributes({
          [semanticAttributes.HTTP_STATUS_CODE]: res.statusCode,
          'http.response.size': res.get('content-length') ? parseInt(res.get('content-length'), 10) : 0,
        });

        // 设置状态
        if (res.statusCode >= 500) {
          span.setStatus({ code: traceApi.SpanStatusCode.ERROR, message: 'Server Error' });
        } else if (res.statusCode >= 400) {
          span.setStatus({ code: traceApi.SpanStatusCode.ERROR, message: 'Client Error' });
        } else {
          span.setStatus({ code: traceApi.SpanStatusCode.OK });
        }

        span.end();
        return originalEnd.call(this, chunk, encoding);
      };

      // 在 trace context 中执行后续中间件
      await contextApi.with(traceApi.setSpan(contextApi.active(), span), next);
    } catch (error) {
      console.error('[TracingMiddleware] Error:', error.message);
      req.traceId = generateSimpleTraceId();
      res.setHeader('X-Trace-Id', req.traceId);
      next();
    }
  };
}

/**
 * 数据库查询追踪包装器
 * @param {string} operation - 操作类型 (SELECT/INSERT/UPDATE/DELETE)
 * @param {string} table - 表名
 * @param {Function} queryFn - 查询函数
 * @returns {Promise<any>} 查询结果
 */
async function traceDbQuery(operation, table, queryFn) {
  if (!tracer) {
    return queryFn();
  }

  const span = tracer.startSpan(`db.${operation}`, {
    kind: traceApi.SpanKind.CLIENT,
    attributes: {
      [semanticAttributes.DB_SYSTEM]: 'postgresql',
      [semanticAttributes.DB_OPERATION]: operation,
      [semanticAttributes.DB_SQL_TABLE]: table,
    },
  });

  return contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
    const startTime = Date.now();
    try {
      const result = await queryFn();
      const duration = Date.now() - startTime;
      
      span.setAttributes({
        'db.rows_affected': result?.rowCount || result?.length || 0,
        'db.duration_ms': duration,
      });
      span.setStatus({ code: traceApi.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: traceApi.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * HTTP 客户端追踪包装器（服务间调用）
 * @param {string} url - 请求 URL
 * @param {Object} options - fetch 选项
 * @returns {Promise<Response>} 响应
 */
async function tracedFetch(url, options = {}) {
  if (!tracer) {
    return fetch(url, options);
  }

  const method = options.method || 'GET';
  const span = tracer.startSpan(`http.client ${method} ${url}`, {
    kind: traceApi.SpanKind.CLIENT,
    attributes: {
      [semanticAttributes.HTTP_URL]: url,
      [semanticAttributes.HTTP_METHOD]: method,
    },
  });

  // 注入 trace context 到请求头
  const headers = { ...options.headers };
  propagationApi.inject(contextApi.active(), headers);

  return contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
    try {
      const response = await fetch(url, { ...options, headers });
      span.setAttributes({
        [semanticAttributes.HTTP_STATUS_CODE]: response.status,
      });
      span.setStatus({
        code: response.status < 400 ? traceApi.SpanStatusCode.OK : traceApi.SpanStatusCode.ERROR,
      });
      return response;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: traceApi.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Redis 操作追踪包装器
 * @param {string} operation - 操作类型
 * @param {string} key - Redis key
 * @param {Function} opFn - 操作函数
 * @returns {Promise<any>} 操作结果
 */
async function traceRedisOperation(operation, key, opFn) {
  if (!tracer) {
    return opFn();
  }

  const span = tracer.startSpan(`redis.${operation}`, {
    kind: traceApi.SpanKind.CLIENT,
    attributes: {
      'db.system': 'redis',
      'db.operation': operation,
      'db.redis.key': key,
    },
  });

  return contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
    try {
      const result = await opFn();
      span.setStatus({ code: traceApi.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: traceApi.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * 创建子 span
 * @param {string} name - span 名称
 * @param {Object} attributes - 属性
 * @returns {Object} span
 */
function startChildSpan(name, attributes = {}) {
  if (!tracer) return null;

  const span = tracer.startSpan(name, {
    attributes,
  });

  return span;
}

/**
 * 生成简单的 trace ID（降级模式）
 */
function generateSimpleTraceId() {
  const timestamp = Date.now().toString(16);
  const random = Math.random().toString(16).slice(2, 18);
  return `${timestamp}-${random}`;
}

module.exports = {
  tracingMiddleware,
  traceDbQuery,
  tracedFetch,
  traceRedisOperation,
  startChildSpan,
  getTracer,
  initTracingApi,
};
