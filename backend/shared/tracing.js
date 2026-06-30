// backend/shared/tracing.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - OpenTelemetry SDK 初始化
'use strict';
const { createLogger } = require('./logger');
const logger = createLogger('tracing');

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
    logger.info({ module: 'Tracing] Already initialized, skipping for ${serviceName}' }, 'Tracing] Already initialized, skipping for ${serviceName} message');;
    return sdk;
  }

  // 检查是否启用追踪
  const tracingEnabled = process.env.OTEL_ENABLED !== 'false';
  if (!tracingEnabled) {
    logger.info({ module: 'Tracing] Tracing disabled for ${serviceName}' }, 'Tracing] Tracing disabled for ${serviceName} message');;
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
    
    logger.info({ module: 'Tracing] OpenTelemetry initialized for ${serviceName}@${serviceVersion}' }, 'Tracing] OpenTelemetry initialized for ${serviceName}@${serviceVersion} message');;
    logger.info({ module: 'Tracing] OTLP Endpoint: ${otlpEndpoint}' }, 'Tracing] OTLP Endpoint: ${otlpEndpoint} message');;
    
    return sdk;
  } catch (error) {
    // OpenTelemetry 模块未安装时降级处理
    logger.warn({ module: 'Tracing] OpenTelemetry not available, tracing disabled: ${error.message}' }, 'Tracing] OpenTelemetry not available, tracing disabled: ${error.message} warning');;
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
      logger.info({ module: 'Tracing] OpenTelemetry SDK shutdown complete' }, 'Tracing] OpenTelemetry SDK shutdown complete message');;
    } catch (error) {
      logger.error({ module: 'Tracing] Error during shutdown', error: error.message.message }, 'Tracing] Error during shutdown error');;
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
