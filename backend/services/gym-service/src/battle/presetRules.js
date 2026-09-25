// 自定义连招预设的纯规则（REQ-00143）：每只精灵最多 5 套、每套 2-5 步、步骤延迟 0-3000ms、执行条件。不依赖数据库。
'use strict';

const { BattleError } = require('./engine');

const MAX_PRESETS = 5;
const MIN_STEPS = 2;
const MAX_STEPS = 5;
const CONDITIONS = ['energy_gte', 'target_hp_lte_pct', 'self_hp_gte_pct'];

function validateSteps(steps, moveIds) {
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new BattleError('BAD_STEPS', `连招需要 ${MIN_STEPS}-${MAX_STEPS} 个技能步骤`, 400);
  }
  return steps.map((s, i) => {
    if (!s || !moveIds.includes(s.moveId)) throw new BattleError('BAD_STEPS', `第 ${i + 1} 步技能不是该精灵已掌握的技能`, 400);
    const delayMs = Math.max(0, Math.min(3000, Number(s.delayMs) || 0));
    let condition = null;
    if (s.condition) {
      if (!CONDITIONS.includes(s.condition.type)) throw new BattleError('BAD_STEPS', `第 ${i + 1} 步条件类型无效`, 400);
      condition = { type: s.condition.type, value: Number(s.condition.value) || 0 };
    }
    return { moveId: s.moveId, delayMs, condition };
  });
}

function conditionOk(cond, att, def) {
  if (!cond) return true;
  if (cond.type === 'energy_gte') return att.energy >= cond.value;
  if (cond.type === 'target_hp_lte_pct') return (def.hp / def.maxHp) * 100 <= cond.value;
  if (cond.type === 'self_hp_gte_pct') return (att.hp / att.maxHp) * 100 >= cond.value;
  return true;
}

module.exports = { MAX_PRESETS, MIN_STEPS, MAX_STEPS, CONDITIONS, validateSteps, conditionOk };
