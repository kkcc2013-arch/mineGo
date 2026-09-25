/**
 * REQ-00042: 请求级追踪上下文（AsyncLocalStorage）
 *
 * 网关为每个请求生成/透传 trace id（W3C 兼容的 32 位 hex），通过 x-trace-id / traceparent 头传给下游；
 * 各服务在 requestLogger 中把 trace id 放进 AsyncLocalStorage，logger 的 mixin 自动给
 * 这次请求内产生的每一条日志加上 trace_id / request_id 字段——业务代码无需改动。
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const als = new AsyncLocalStorage();
let otelApi = null;
try { otelApi = require('@opentelemetry/api'); } catch { otelApi = null; }
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const LOOSE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function newSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

/** 从请求头提取 trace id：traceparent > x-trace-id；非法值丢弃（防日志注入） */
function traceIdFromHeaders(headers = {}) {
  const tp = headers.traceparent;
  if (typeof tp === 'string') {
    const parts = tp.split('-');
    if (parts.length >= 4 && TRACE_ID_RE.test(parts[1]) && !/^0+$/.test(parts[1])) return parts[1].toLowerCase();
  }
  const x = headers['x-trace-id'];
  if (typeof x === 'string') {
    const compact = x.replace(/-/g, '');
    if (TRACE_ID_RE.test(compact)) return compact.toLowerCase();
    if (LOOSE_ID_RE.test(x)) return x;
  }
  return null;
}

function traceparent(traceId, spanId) {
  return TRACE_ID_RE.test(traceId) ? `00-${traceId}-${spanId}-01` : undefined;
}

/**
 * OpenTelemetry 当前活动 span 的 trace id（shared/tracing.js 未启用时返回 null）。
 * 启用追踪后，HTTP 自动埋点会用自己的 traceparent 覆盖出站请求头，
 * 因此网关必须以它为准，日志里的 trace_id 才能与 Jaeger 中的链路对上。
 */
function activeTraceId() {
  const span = otelApi && otelApi.trace.getActiveSpan();
  const id = span && span.spanContext().traceId;
  return id && TRACE_ID_RE.test(id) && !/^0+$/.test(id) ? id : null;
}

function current() {
  return als.getStore() || null;
}

module.exports = { als, current, activeTraceId, newTraceId, newSpanId, traceIdFromHeaders, traceparent };
