/**
 * 精灵体力与疲劳（REQ-00172，纯函数）
 *
 * - 自然恢复：每分钟 1 点，按 last_stamina_update 惰性计算（读时换算，不依赖定时任务的及时性）；
 *   定时任务只负责把换算结果落库（保持 fatigue_level 列准确），并保留不足一分钟的零头
 * - 休息站：在自然恢复之外额外每分钟 5 × 站点倍率
 * - 疲劳等级按体力百分比：fresh ≥80%、normal ≥50%、tired ≥20%、exhausted <20%
 */
'use strict';

const NATURAL_RECOVERY_PER_MIN = 1;
const REST_BASE_PER_MIN = 5;
const MAX_REST_MINUTES = 8 * 60;

const FATIGUE_LEVELS = Object.freeze({
  fresh: { min: 80, battleBonus: 1.0, catchBonus: 1.0, expBonus: 1.0, label: '精力充沛', color: '#4CAF50' },
  normal: { min: 50, battleBonus: 1.0, catchBonus: 1.0, expBonus: 1.0, label: '状态正常', color: '#8BC34A' },
  tired: { min: 20, battleBonus: 0.85, catchBonus: 0.9, expBonus: 0.95, label: '有些疲惫', color: '#FF9800' },
  exhausted: { min: 0, battleBonus: 0.6, catchBonus: 0.7, expBonus: 0.8, label: '精疲力竭', color: '#F44336' },
});

function fatigueLevel(current, max) {
  const m = Math.max(1, Number(max) || 100);
  const pct = (Math.max(0, Number(current) || 0) / m) * 100;
  if (pct >= FATIGUE_LEVELS.fresh.min) return 'fresh';
  if (pct >= FATIGUE_LEVELS.normal.min) return 'normal';
  if (pct >= FATIGUE_LEVELS.tired.min) return 'tired';
  return 'exhausted';
}

/**
 * 惰性换算当前体力
 * @param {{max_stamina, current_stamina, last_stamina_update}} row
 * @returns {{ current, max, recovered, wholeMinutes }}
 */
function effectiveStamina(row, now = new Date()) {
  const max = Math.max(1, Number(row.max_stamina) || 100);
  const stored = Math.min(max, Math.max(0, Number(row.current_stamina ?? max)));
  const last = row.last_stamina_update ? new Date(row.last_stamina_update) : now;
  const wholeMinutes = Math.max(0, Math.floor((now - last) / 60000));
  const recovered = Math.min(max - stored, wholeMinutes * NATURAL_RECOVERY_PER_MIN);
  return { current: stored + recovered, max, recovered, wholeMinutes };
}

function status(row, now = new Date()) {
  const eff = effectiveStamina(row, now);
  const level = fatigueLevel(eff.current, eff.max);
  const fx = FATIGUE_LEVELS[level];
  const missing = eff.max - eff.current;
  return {
    currentStamina: eff.current,
    maxStamina: eff.max,
    staminaPercentage: Math.round((eff.current / eff.max) * 100),
    fatigueLevel: level,
    fatigueLabel: fx.label,
    fatigueColor: fx.color,
    effects: { battleBonus: fx.battleBonus, catchBonus: fx.catchBonus, expBonus: fx.expBonus },
    isLowStamina: eff.current < eff.max * 0.3,
    naturalRecoveryPerMinute: NATURAL_RECOVERY_PER_MIN,
    minutesToFull: missing > 0 ? Math.ceil(missing / NATURAL_RECOVERY_PER_MIN) : 0,
  };
}

/** 休息站额外恢复量 */
function restRecovery(minutes, stationMultiplier = 1) {
  const m = Math.min(MAX_REST_MINUTES, Math.max(0, Math.floor(Number(minutes) || 0)));
  return Math.floor(m * REST_BASE_PER_MIN * Math.max(0, Number(stationMultiplier) || 1));
}

/** 疲劳对经验的倍率（注册给 shared/pokemonExperience） */
function expMultiplier(row, now = new Date()) {
  const eff = effectiveStamina(row, now);
  return FATIGUE_LEVELS[fatigueLevel(eff.current, eff.max)].expBonus;
}

module.exports = {
  NATURAL_RECOVERY_PER_MIN,
  REST_BASE_PER_MIN,
  MAX_REST_MINUTES,
  FATIGUE_LEVELS,
  fatigueLevel,
  effectiveStamina,
  status,
  restRecovery,
  expMultiplier,
};
