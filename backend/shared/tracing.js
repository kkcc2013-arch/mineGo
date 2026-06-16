// backend/shared/tracing.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - OpenTelemetry SDK 初始化
'use strict';

let sdk = null;
let isInitialized = false;

/**
 * 初始化 OpenTelemetry SDK
 * @param {string} serviceName - 服务名称
 * @param {string} serviceVersion - 服务版本
 * @returns {Promise<Object>} SDK 实例
 */
async function initTracing(serviceName, serviceVersion = '1.0.0') {
  if (isInitialized) {
    console.log(`[Tracing] Already initialized, skipping for ${serviceName}`);
    return sdk;
  }

  // 检查是否启用追踪
  const tracingEnabled = process.env.OTEL_ENABLED !== 'false';
  if (!tracingEnabled) {
    console.log(`[Tracing] Tracing disabled for ${serviceName}`);
    return null;
  }

  try {
    // 动态导入 OpenTelemetry 模块（可选依赖）
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-grpc');
    const { Resource } = await import('@opentelemetry/resources');
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');
    const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
    
    // Trace 导出器
    const traceExporter = new OTLPTraceExporter({
      url: otlpEndpoint,
    });

    // Metric 导出器
    const metricExporter = new OTLPMetricExporter({
      url: otlpEndpoint,
    });

    // 创建 SDK
    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
        'service.namespace': 'mineGo',
      }),
      traceExporter,
      metricExporter,
      spanProcessors: [
        new BatchSpanProcessor(traceExporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
        }),
      ],
    });

    // 启动 SDK
    await sdk.start();
    isInitialized = true;
    
    console.log(`[Tracing] OpenTelemetry initialized for ${serviceName}@${serviceVersion}`);
    console.log(`[Tracing] OTLP Endpoint: ${otlpEndpoint}`);
    
    return sdk;
  } catch (error) {
    // OpenTelemetry 模块未安装时降级处理
    console.warn(`[Tracing] OpenTelemetry not available, tracing disabled: ${error.message}`);
    return null;
  }
}

/**
 * 关闭 SDK
 */
async function shutdownTracing() {
  if (sdk) {
    try {
      await sdk.shutdown();
      console.log('[Tracing] OpenTelemetry SDK shutdown complete');
    } catch (error) {
      console.error('[Tracing] Error during shutdown:', error.message);
    }
    sdk = null;
    isInitialized = false;
  }
}

/**
 * 获取追踪状态
 */
function getTracingStatus() {
  return {
    initialized: isInitialized,
    enabled: process.env.OTEL_ENABLED !== 'false',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
  };
}

// 进程信号处理
process.on('SIGTERM', shutdownTracing);
process.on('SIGINT', shutdownTracing);

module.exports = {
  initTracing,
  shutdownTracing,
  getTracingStatus,
};
