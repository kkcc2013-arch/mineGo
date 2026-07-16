// backend/shared/risk-engine/risk-metrics.js - 风控引擎 Prometheus 指标
'use strict';

const promClient = require('prom-client');

/**
 * 风控引擎 Prometheus 指标定义
 */

const metrics = {
  eventsProcessed: new promClient.Counter({
    name: 'risk_control_events_processed_total',
    help: 'Total number of events processed by risk control engine',
    labelNames: ['event_type', 'result']
  }),
  
  cheatingDetected: new promClient.Counter({
    name: 'risk_control_cheating_detected_total',
    help: 'Total number of cheating incidents detected',
    labelNames: ['type', 'severity']
  }),
  
  actionTaken: new promClient.Counter({
    name: 'risk_control_actions_taken_total',
    help: 'Total number of actions taken against cheaters',
    labelNames: ['action_type']
  }),
  
  processingLatency: new promClient.Histogram({
    name: 'risk_control_processing_latency_seconds',
    help: 'Latency of risk control processing',
    labelNames: ['event_type'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
  }),
  
  ruleHits: new promClient.Counter({
    name: 'risk_control_rule_hits_total',
    help: 'Total number of rule hits',
    labelNames: ['rule_id', 'rule_name']
  })
};

module.exports = {
  metrics
};