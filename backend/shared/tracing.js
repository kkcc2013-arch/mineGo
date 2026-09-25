// backend/shared/tracing.js
// REQ-00042（重构 REQ-00148 的初始化代码）：OpenTelemetry 链路追踪
//
// 用法：服务入口文件的第一条语句
//   require('../../../shared/tracing').initTracing('user-service');
// 必须早于 express / http / pg / ioredis / redis / kafkajs 被 require，自动埋点才能生效。
//
// 启用条件：设置了 OTEL_EXPORTER_OTLP_ENDPOINT（如 http://127.0.0.1:4318；Jaeger v2 原生接收 OTLP/HTTP），
//           或兼容旧变量 JAEGER_ENDPOINT；OTEL_ENABLED=false 强制关闭。
// 采样：OTEL_TRACES_SAMPLER_ARG（0~1），默认开发 1.0、生产 0.1；ParentBased——上游已决定采样则跟随，保证整条链路完整。
// 依赖缺失或初始化失败只告警，不影响服务启动（追踪是可观测性增强，不能成为可用性风险）。
//
// 原实现用 @opentelemetry/sdk-node + Resource 类 + JaegerExporter：前两者在 OTel JS 2.x 中已移除/改名，
// Jaeger 专用导出器已废弃（Jaeger 直接接收 OTLP），且原文件从未被任何服务加载。
'use strict';

let provider = null;
let status = { enabled: false, reason: 'not initialized' };

function warn(msg, extra = {}) {
  // 这里不用 shared/logger：logger 依赖 pino 等模块，初始化阶段尽量少 require
  process.stderr.write(`${JSON.stringify({ level: 'warn', time: new Date().toISOString(), module: 'tracing', msg, ...extra })}\n`);
}

function otlpTracesUrl() {
  const base = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    || process.env.JAEGER_ENDPOINT;
  if (!base) return null;
  // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 按规范是完整地址；其余为基础地址，需拼 /v1/traces
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return base;
  return `${base.replace(/\/+$/, '')}/v1/traces`;
}

function samplingRatio() {
  const raw = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

/**
 * 初始化追踪。重复调用无副作用。
 * @param {string} serviceName
 * @param {string} [serviceVersion]
 * @returns {object|null} TracerProvider（未启用时为 null）
 */
function initTracing(serviceName, serviceVersion = process.env.APP_VERSION || '1.0.0') {
  if (provider) return provider;
  if (process.env.OTEL_ENABLED === 'false') {
    status = { enabled: false, reason: 'OTEL_ENABLED=false' };
    return null;
  }
  const url = otlpTracesUrl();
  if (!url) {
    status = { enabled: false, reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set' };
    return null;
  }

  try {
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
    const { registerInstrumentations } = require('@opentelemetry/instrumentation');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
    const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
    const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis');
    const { KafkaJsInstrumentation } = require('@opentelemetry/instrumentation-kafkajs');

    const ratio = samplingRatio();
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
        'deployment.environment.name': process.env.NODE_ENV || 'development',
        'service.instance.id': `${require('os').hostname()}:${process.pid}`,
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
    });
    // 注册全局 TracerProvider、AsyncLocalStorage 上下文管理器与 W3C traceparent 传播器
    provider.register();

    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [
        new HttpInstrumentation({
          // 健康检查与指标抓取不产生 trace（量大且无诊断价值）
          ignoreIncomingRequestHook: (req) => /^\/(health|metrics|ready|live)(\/|\?|$)/.test(req.url || ''),
        }),
        new ExpressInstrumentation(),
        new PgInstrumentation({ enhancedDatabaseReporting: false }), // 不记录 SQL 参数（可能含个人信息）
        new IORedisInstrumentation(),
        new RedisInstrumentation(),
        new KafkaJsInstrumentation(),
      ],
    });

    status = { enabled: true, serviceName, endpoint: url, samplingRatio: ratio };
    return provider;
  } catch (err) {
    provider = null;
    status = { enabled: false, reason: `init failed: ${err.message}` };
    warn('OpenTelemetry init failed; tracing disabled', { service: serviceName, err: err.message });
    return null;
  }
}

/** 刷新并关闭导出器（优雅退出时调用；BatchSpanProcessor 平时每 5 秒自动导出） */
async function shutdownTracing() {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch (err) {
    warn('OpenTelemetry shutdown failed', { err: err.message });
  } finally {
    provider = null;
    status = { enabled: false, reason: 'shut down' };
  }
}

/** 兼容 REQ-00148 的返回结构（initialized / enabled / endpoint），另附 reason、samplingRatio 等 */
function getTracingStatus() {
  return { ...status, initialized: !!provider, enabled: status.enabled, endpoint: otlpTracesUrl() || '' };
}

module.exports = {
  initTracing,
  shutdownTracing,
  getTracingStatus,
  _internal: { otlpTracesUrl, samplingRatio },
};
