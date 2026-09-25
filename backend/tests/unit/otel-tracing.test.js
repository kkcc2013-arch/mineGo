// REQ-00042：tracing 启用条件、导出地址、采样率与 trace id 对齐（不依赖服务、不需要安装 OTel 包）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TRACING = path.resolve(__dirname, '../../shared/tracing.js');
const ENV_KEYS = ['OTEL_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'JAEGER_ENDPOINT', 'OTEL_TRACES_SAMPLER_ARG', 'NODE_ENV'];

function fresh(env) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[TRACING];
  const mod = require(TRACING);
  return { mod, restore: () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}

test('未配置导出地址时不启用，且不加载任何 OTel 包', () => {
  const { mod, restore } = fresh({});
  try {
    assert.strictEqual(mod.initTracing('t-svc'), null);
    assert.deepStrictEqual(mod.getTracingStatus(), { enabled: false, reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set', initialized: false, endpoint: '' });
  } finally { restore(); }
});

test('OTEL_ENABLED=false 优先于导出地址', () => {
  const { mod, restore } = fresh({ OTEL_ENABLED: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
  try {
    assert.strictEqual(mod.initTracing('t-svc'), null);
    assert.strictEqual(mod.getTracingStatus().reason, 'OTEL_ENABLED=false');
  } finally { restore(); }
});

test('导出地址：基础地址拼 /v1/traces，TRACES_ENDPOINT 按原样，兼容 JAEGER_ENDPOINT', () => {
  let r = fresh({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318/' });
  try { assert.strictEqual(r.mod._internal.otlpTracesUrl(), 'http://jaeger:4318/v1/traces'); } finally { r.restore(); }
  r = fresh({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://c:4318/custom/traces', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://ignored:4318' });
  try { assert.strictEqual(r.mod._internal.otlpTracesUrl(), 'http://c:4318/custom/traces'); } finally { r.restore(); }
  r = fresh({ JAEGER_ENDPOINT: 'http://jaeger:4318' });
  try { assert.strictEqual(r.mod._internal.otlpTracesUrl(), 'http://jaeger:4318/v1/traces'); } finally { r.restore(); }
});

test('采样率：开发 100%、生产 10%，可用 OTEL_TRACES_SAMPLER_ARG 覆盖，非法值回退默认', () => {
  let r = fresh({});
  try { assert.strictEqual(r.mod._internal.samplingRatio(), 1); } finally { r.restore(); }
  r = fresh({ NODE_ENV: 'production' });
  try { assert.strictEqual(r.mod._internal.samplingRatio(), 0.1); } finally { r.restore(); }
  r = fresh({ NODE_ENV: 'production', OTEL_TRACES_SAMPLER_ARG: '0.25' });
  try { assert.strictEqual(r.mod._internal.samplingRatio(), 0.25); } finally { r.restore(); }
  r = fresh({ OTEL_TRACES_SAMPLER_ARG: '7' });
  try { assert.strictEqual(r.mod._internal.samplingRatio(), 1); } finally { r.restore(); }
});

test('traceContext.activeTraceId：无活动 span 时为 null（网关回退到请求头/新生成）', () => {
  const tc = require('../../shared/traceContext');
  assert.strictEqual(tc.activeTraceId(), null);
  const id = tc.traceIdFromHeaders({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
  assert.strictEqual(id, '4bf92f3577b34da6a3ce929d0e0e4736');
});
