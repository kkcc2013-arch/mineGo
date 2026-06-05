// shared/tracing.js - OpenTelemetry 分布式追踪初始化
'use strict';

const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { trace } = require('@opentelemetry/api');

let provider = null;
let isInitialized = false;

/**
 * 初始化 OpenTelemetry 追踪
 * @param {string} serviceName - 服务名称
 * @param {object} options - 配置选项
 * @returns {NodeTracerProvider} Tracer provider
 */
function initTracing(serviceName, options = {}) {
  if (isInitialized) {
    console.warn('[Tracing] Already initialized, skipping...');
    return provider;
  }

  const jaegerEndpoint = process.env.JAEGER_ENDPOINT || 
                         options.jaegerEndpoint || 
                         'http://jaeger-collector:14268/api/traces';

  const samplingRate = parseFloat(process.env.TRACE_SAMPLING_RATE || '1.0');

  console.log(`[Tracing] Initializing tracing for ${serviceName}`);
  console.log(`[Tracing] Jaeger endpoint: ${jaegerEndpoint}`);
  console.log(`[Tracing] Sampling rate: ${samplingRate}`);

  // 创建 tracer provider
  provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    }),
  });

  // 创建 Jaeger exporter
  const jaegerExporter = new JaegerExporter({
    endpoint: jaegerEndpoint,
  });

  // 添加 span processor（批量发送）
  provider.addSpanProcessor(
    new BatchSpanProcessor(jaegerExporter, {
      maxExportBatchSize: 100,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 30000,
    })
  );

  // 注册为全局 provider
  provider.register();

  isInitialized = true;
  console.log(`[Tracing] Tracing initialized successfully for ${serviceName}`);

  return provider;
}

/**
 * 获取 tracer 实例
 * @param {string} name - Tracer 名称
 * @returns {Tracer} Tracer 实例
 */
function getTracer(name = 'mineGo') {
  return trace.getTracer(name);
}

/**
 * 关闭追踪（优雅关闭）
 */
async function shutdownTracing() {
  if (provider) {
    console.log('[Tracing] Shutting down tracing...');
    await provider.shutdown();
    isInitialized = false;
    console.log('[Tracing] Tracing shutdown complete');
  }
}

/**
 * 检查追踪是否已初始化
 * @returns {boolean}
 */
function isTracingInitialized() {
  return isInitialized;
}

module.exports = {
  initTracing,
  getTracer,
  shutdownTracing,
  isTracingInitialized,
};
