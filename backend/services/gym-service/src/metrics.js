/**
 * REQ-00054: 道馆战斗系统 - Prometheus 指标
 * 创建时间: 2026-06-09 16:00
 */

const client = require('prom-client');

// 战斗开始计数器
const gymBattleStartTotal = new client.Counter({
  name: 'gym_battle_start_total',
  help: 'Total number of gym battles started',
  labelNames: ['gym_id', 'result']
});

// 战斗开始错误计数器
const gymBattleStartErrorTotal = new client.Counter({
  name: 'gym_battle_start_error_total',
  help: 'Total number of gym battle start errors'
});

// 战斗胜利计数器
const gymBattleWinTotal = new client.Counter({
  name: 'gym_battle_win_total',
  help: 'Total number of gym battles won',
  labelNames: ['gym_id']
});

// 战斗失败计数器
const gymBattleLoseTotal = new client.Counter({
  name: 'gym_battle_lose_total',
  help: 'Total number of gym battles lost',
  labelNames: ['gym_id']
});

// 战斗回合计数器
const gymBattleTurnTotal = new client.Counter({
  name: 'gym_battle_turn_total',
  help: 'Total number of battle turns executed'
});

// 战斗回合错误计数器
const gymBattleTurnErrorTotal = new client.Counter({
  name: 'gym_battle_turn_error_total',
  help: 'Total number of battle turn errors'
});

// 战斗持续时间直方图
const gymBattleDuration = new client.Histogram({
  name: 'gym_battle_duration_seconds',
  help: 'Duration of gym battles in seconds',
  buckets: [10, 30, 60, 120, 180, 300, 600, 900]
});

// 活跃战斗数量
const gymBattleActiveCount = new client.Gauge({
  name: 'gym_battle_active_count',
  help: 'Number of currently active gym battles'
});

// 战斗超时计数器
const gymBattleTimeoutTotal = new client.Counter({
  name: 'gym_battle_timeout_total',
  help: 'Total number of gym battles that timed out'
});

// 防守精灵数量
const pokemonDefendingCount = new client.Gauge({
  name: 'pokemon_defending_count',
  help: 'Total number of pokemon currently defending gyms',
  labelNames: ['team_id']
});

// 伤害统计直方图
const battleDamageHistogram = new client.Histogram({
  name: 'battle_damage_dealt',
  help: 'Distribution of damage dealt in battle turns',
  buckets: [10, 25, 50, 100, 200, 500, 1000, 2000]
});

// 属性克制效果统计
const typeEffectivenessCounter = new client.Counter({
  name: 'battle_type_effectiveness_total',
  help: 'Count of type effectiveness occurrences',
  labelNames: ['effectiveness'] // 'super_effective', 'not_very_effective', 'no_effect'
});

// 状态效果应用统计
const statusEffectCounter = new client.Counter({
  name: 'battle_status_effect_total',
  help: 'Count of status effects applied',
  labelNames: ['effect_type']
});

module.exports = {
  gymBattleStartTotal,
  gymBattleStartErrorTotal,
  gymBattleWinTotal,
  gymBattleLoseTotal,
  gymBattleTurnTotal,
  gymBattleTurnErrorTotal,
  gymBattleDuration,
  gymBattleActiveCount,
  gymBattleTimeoutTotal,
  pokemonDefendingCount,
  battleDamageHistogram,
  typeEffectivenessCounter,
  statusEffectCounter
};
