// 战斗相关 Prometheus 指标（注册到 shared/metrics 的独立 registry，/metrics 端点可见）。
// 取已注册同名指标，避免模块被多次 require（测试 / 热加载）时重复注册抛错。
// prom-client 不可用时（如宿主机直接跑纯逻辑单测、未安装依赖）退化为空操作指标，不影响战斗逻辑。
'use strict';

let shared = null;
try {
  shared = require('../../../../shared/metrics');
} catch {
  shared = null;
}

const NOOP = { inc() {}, dec() {}, set() {}, observe() {}, startTimer() { return () => 0; } };

function once(Type, name, help, labelNames = [], extra = {}) {
  if (!shared) return NOOP;
  const existing = shared.register.getSingleMetric(name);
  if (existing) return existing;
  return new Type({ name, help, labelNames, registers: [shared.register], ...extra });
}

const { Counter, Gauge, Histogram } = shared ? shared.promClient : {};

module.exports = {
  battlesStarted: once(Counter, 'minego_battle_started_total', '开始的战斗数', ['type']),
  battlesFinished: once(Counter, 'minego_battle_finished_total', '结束的战斗数', ['type', 'result']),
  turnDuration: once(Histogram, 'minego_battle_turn_duration_seconds', '战斗回合服务端处理耗时', ['type'],
    { buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] }),
  damageCache: once(Counter, 'minego_battle_damage_cache_requests_total', '伤害缓存请求（layer=type|coef|l1|l2）', ['layer', 'result']),
  damageCalcDuration: once(Histogram, 'minego_battle_damage_calc_seconds', '单次伤害计算耗时', ['cached'],
    { buckets: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.05] }),
  damageCacheEntries: once(Gauge, 'minego_battle_damage_cache_entries', '伤害缓存条目数', ['layer']),
  combosTriggered: once(Counter, 'minego_battle_combos_total', '触发的连击', ['chain', 'quality', 'mode']),
  cooldownRejects: once(Counter, 'minego_battle_move_rejected_total', '因冷却/能量/频率被拒绝的技能', ['reason', 'mode']),
  raidAttacks: once(Counter, 'minego_raid_attacks_total', '团战攻击', ['result']),
  aiRequests: once(Counter, 'minego_battle_ai_requests_total', 'AI 策略助手请求', ['type', 'variant', 'cache']),
  aiLatency: once(Histogram, 'minego_battle_ai_latency_seconds', 'AI 策略助手耗时', ['type'],
    { buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 3] }),
  replaysRecorded: once(Counter, 'minego_battle_replays_recorded_total', '录制的回放', ['type']),
  replayViews: once(Counter, 'minego_battle_replay_views_total', '回放观看', ['via']),
  leagueMatches: once(Counter, 'minego_league_matches_total', '联赛对局', ['result', 'opponent']),
  clientFps: once(Histogram, 'minego_client_battle_fps', '客户端上报的战斗平均帧率', ['tier'],
    { buckets: [15, 20, 25, 30, 40, 45, 50, 55, 60] }),
};
