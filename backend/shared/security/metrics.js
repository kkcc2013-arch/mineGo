// backend/shared/security/metrics.js
// E17 安全指标：懒加载 prom-client 与共享注册表（shared/metrics.register），
// 宿主机没有 node_modules / 单测环境下返回空实现，调用方无需判断。
'use strict';

const NOOP = { inc() {}, dec() {}, set() {}, observe() {}, labels() { return NOOP; }, startTimer() { return () => 0; } };

let prom = null;
let registry = null;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    prom = require('prom-client');
    registry = require('../metrics').register;
  } catch {
    prom = null;
    registry = null;
  }
}

function make(Type, cfg) {
  load();
  if (!prom || !registry) return NOOP;
  const existing = registry.getSingleMetric(cfg.name);
  if (existing) return existing;
  try {
    return new prom[Type]({ ...cfg, registers: [registry] });
  } catch {
    return NOOP;
  }
}

const cache = new Map();
function lazy(Type, cfg) {
  return {
    get m() {
      if (!cache.has(cfg.name)) cache.set(cfg.name, make(Type, cfg));
      return cache.get(cfg.name);
    },
    inc(labels, v) { try { labels && typeof labels === 'object' ? this.m.inc(labels, v === undefined ? 1 : v) : this.m.inc(labels === undefined ? 1 : labels); } catch { /* 标签不匹配等 */ } },
    set(labels, v) { try { v === undefined ? this.m.set(labels) : this.m.set(labels, v); } catch { /* ignore */ } },
    observe(labels, v) { try { v === undefined ? this.m.observe(labels) : this.m.observe(labels, v); } catch { /* ignore */ } },
  };
}

const M = {
  // 请求签名（REQ-00363/00548）
  signatureVerification: lazy('Counter', { name: 'signature_verification_total', help: 'Request signature verifications', labelNames: ['result', 'level', 'mode'] }),
  signatureLatency: lazy('Histogram', { name: 'signature_verification_duration_ms', help: 'Signature verification latency (ms)', labelNames: ['level'], buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25] }),
  replayAttack: lazy('Counter', { name: 'replay_attack_total', help: 'Rejected/flagged replayed nonces', labelNames: ['mode'] }),
  nonceStore: lazy('Counter', { name: 'signature_nonce_store_total', help: 'Nonce store operations', labelNames: ['backend', 'result'] }),

  // 二次验证（REQ-00561 的 5 个指标）
  secondaryAuthTriggered: lazy('Counter', { name: 'minego_secondary_auth_triggered_total', help: 'Secondary authentication triggered', labelNames: ['risk_level', 'operation', 'mode'] }),
  secondaryAuthSuccess: lazy('Counter', { name: 'minego_secondary_auth_success_total', help: 'Secondary authentication success', labelNames: ['auth_method', 'operation'] }),
  secondaryAuthFailed: lazy('Counter', { name: 'minego_secondary_auth_failed_total', help: 'Secondary authentication failures', labelNames: ['auth_method', 'operation', 'error'] }),
  riskScore: lazy('Histogram', { name: 'minego_risk_score_distribution', help: 'Risk score distribution (0-1)', labelNames: ['source'], buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] }),
  sensitiveBlocked: lazy('Counter', { name: 'minego_sensitive_action_blocked_total', help: 'Sensitive actions blocked', labelNames: ['operation', 'reason'] }),

  // 会话 / 登录
  sessionAnomaly: lazy('Counter', { name: 'session_anomaly_total', help: 'Session anomalies detected', labelNames: ['type', 'action'] }),
  loginRisk: lazy('Counter', { name: 'login_risk_decisions_total', help: 'Login risk decisions', labelNames: ['level', 'action', 'mode'] }),

  // 威胁 / 事件 / 响应
  securityEvents: lazy('Counter', { name: 'security_events_total', help: 'Normalized security events', labelNames: ['type', 'severity'] }),
  correlationMatches: lazy('Counter', { name: 'security_correlation_matches_total', help: 'Correlation rule matches', labelNames: ['rule', 'level'] }),
  threatDetected: lazy('Counter', { name: 'minego_threat_detected_total', help: 'Threats detected at gateway', labelNames: ['level'] }),
  threatLatency: lazy('Histogram', { name: 'minego_threat_model_inference_latency_ms', help: 'Threat scoring latency (ms)', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] }),
  responseActions: lazy('Counter', { name: 'minego_threat_response_actions_total', help: 'Automated response actions', labelNames: ['action', 'mode', 'result'] }),
  alertsAggregated: lazy('Counter', { name: 'security_alerts_total', help: 'Security alerts (emitted vs suppressed by aggregation)', labelNames: ['result'] }),

  // 注入 / 参数校验
  injectionDetected: lazy('Counter', { name: 'injection_detected_total', help: 'Injection payloads detected', labelNames: ['type', 'mode'] }),
  validationFailed: lazy('Counter', { name: 'request_validation_failed_total', help: 'Request validation failures', labelNames: ['route'] }),

  // 限流绕过
  bypassDetections: lazy('Counter', { name: 'rate_limit_bypass_detections_total', help: 'Rate limit bypass detections', labelNames: ['dimension'] }),
  bypassPenalties: lazy('Gauge', { name: 'rate_limit_coordinated_rules_active', help: 'Active bypass penalties (per instance)' }),

  // 脱敏 / 泄露
  leakageDetected: lazy('Counter', { name: 'secret_leakage_detected_total', help: 'Secrets detected in logs/responses', labelNames: ['type', 'severity', 'source'] }),

  // 截图审核
  contentAudit: lazy('Counter', { name: 'screenshot_audit_total', help: 'Screenshot content audits', labelNames: ['result', 'cached'] }),
  contentAuditLatency: lazy('Histogram', { name: 'screenshot_audit_duration_ms', help: 'Screenshot audit latency (ms)', buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000] }),

  // WebSocket
  wsIntegrity: lazy('Counter', { name: 'ws_message_integrity_total', help: 'WebSocket message integrity checks', labelNames: ['result', 'mode'] }),
};

module.exports = M;
module.exports.NOOP = NOOP;
