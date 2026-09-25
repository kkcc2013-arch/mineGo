/**
 * 好友/社交业务指标（Prometheus，注册到 shared/metrics 的独立注册表，经 /metrics 暴露）
 */
'use strict';

const promClient = require('prom-client');
const { register } = require('../../../../shared/metrics');

function once(Type, opts) {
  return register.getSingleMetric(opts.name) || new Type({ ...opts, registers: [register] });
}

const friendRequests = once(promClient.Counter, {
  name: 'minego_friend_requests_total',
  help: 'Friend request operations',
  labelNames: ['action', 'result'],
});
const friendGifts = once(promClient.Counter, {
  name: 'minego_friend_gifts_total',
  help: 'Friend gift operations',
  labelNames: ['action', 'gift_type', 'result'],
});
const friendshipPoints = once(promClient.Counter, {
  name: 'minego_friendship_points_total',
  help: 'Friendship points granted',
  labelNames: ['interaction'],
});
const friendshipLevelUps = once(promClient.Counter, {
  name: 'minego_friendship_level_ups_total',
  help: 'Friendship / intimacy level ups',
  labelNames: ['kind'],
});
const socialOpDuration = once(promClient.Histogram, {
  name: 'minego_social_operation_duration_seconds',
  help: 'Social service operation duration',
  labelNames: ['op'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1],
});
const wsConnections = once(promClient.Gauge, {
  name: 'minego_social_ws_connections',
  help: 'Active /ws/friends connections on this instance',
});
const wsMessages = once(promClient.Counter, {
  name: 'minego_social_ws_messages_total',
  help: 'Social WebSocket messages pushed',
  labelNames: ['type'],
});

/** 计时包装：timed('op', async () => ...) */
async function timed(op, fn) {
  const end = socialOpDuration.startTimer({ op });
  try { return await fn(); } finally { end(); }
}

module.exports = {
  friendRequests, friendGifts, friendshipPoints, friendshipLevelUps, socialOpDuration,
  wsConnections, wsMessages, timed,
};
