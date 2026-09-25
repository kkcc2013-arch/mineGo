/**
 * 精灵培育与基因遗传规则（REQ-00276，纯函数，随机数可注入便于测试）
 *
 * 配对：两只不同的、空闲的精灵；蛋组有交集即可配对，"未发现"组不能培育，百变怪（蛋组 13）可与任何可培育精灵配对；
 *       未配置蛋组的物种只能与同家族（家族根相同）配对
 * 后代物种：母方（非百变怪一方）所在家族的根物种
 * 基因遗传（IV 攻/防/HP 三项）：
 *   - 每项以遗传率（基础 50%，命运红线 80%）从父母继承，否则随机 0~15
 *   - 继承时显性规则：60% 取父母中较高的值（显性），40% 随机取一方（隐性表达）
 *   - 变异：5% 概率随机一项 +3（上限 15）
 * 技能：父母的招式在后代可学技能表中时 60% 继承；特征：父母任一闪光时闪光率 1/64，否则 1/512
 * 培育时间 = 30 分钟 × 稀有度系数 × (1 + 父母平均 IV/45 × 0.5)；费用 = 500 星尘 × 稀有度系数
 * 孵化：按玩家服务端累计行走距离（users.total_distance_km，位置上报时带速度反作弊）计算，孵化器加速
 */
'use strict';

const UNDISCOVERED = 12;
const DITTO_GROUP = 13;
const BASE_INHERIT = 0.5;
const DESTINY_KNOT_INHERIT = 0.8;
const DOMINANT_RATE = 0.6;
const MUTATION_RATE = 0.05;
const MOVE_INHERIT_RATE = 0.6;
const IV_KEYS = ['attack', 'defense', 'hp'];

const RARITY_FACTOR = Object.freeze({ COMMON: 1, UNCOMMON: 1.5, RARE: 2, EPIC: 3, LEGENDARY: 5 });
const HATCH_KM = Object.freeze({ COMMON: 2, UNCOMMON: 5, RARE: 7, EPIC: 10, LEGENDARY: 12 });
const INCUBATORS = Object.freeze({ basic: { multiplier: 1, item: null }, INCUBATOR_SUPER: { multiplier: 1.5, item: 'INCUBATOR_SUPER' }, INCUBATOR_ULTRA: { multiplier: 2, item: 'INCUBATOR_ULTRA' } });

/**
 * 能否配对
 * @param {object} a { speciesId, groups: number[], familyRoot, occupied, isEgg }
 */
function compatibility(a, b) {
  if (!a || !b) return { ok: false, reason: '精灵不存在' };
  if (a.id && a.id === b.id) return { ok: false, reason: '不能与自己配对' };
  const ga = a.groups || [];
  const gb = b.groups || [];
  if (ga.includes(UNDISCOVERED) || gb.includes(UNDISCOVERED)) return { ok: false, reason: '"未发现"蛋组的精灵不能培育' };
  const dittoA = ga.includes(DITTO_GROUP);
  const dittoB = gb.includes(DITTO_GROUP);
  if (dittoA && dittoB) return { ok: false, reason: '两只百变怪不能培育' };
  if (dittoA || dittoB) return { ok: true, reason: 'ditto' };
  if (ga.length && gb.length) {
    const shared = ga.filter((g) => gb.includes(g));
    return shared.length ? { ok: true, reason: 'egg_group', sharedGroups: shared } : { ok: false, reason: '蛋组不同，无法配对' };
  }
  if (a.familyRoot != null && a.familyRoot === b.familyRoot) return { ok: true, reason: 'same_family' };
  return { ok: false, reason: '蛋组不同，无法配对' };
}

/** 后代物种：非百变怪的母方所在家族根 */
function offspringSpecies(mother, father) {
  const motherIsDitto = (mother.groups || []).includes(DITTO_GROUP);
  return motherIsDitto ? father.familyRoot : mother.familyRoot;
}

function breedingMinutes(rarity, parents) {
  const f = RARITY_FACTOR[String(rarity || 'COMMON').toUpperCase()] || 1;
  const ivs = parents.flatMap((p) => IV_KEYS.map((k) => Number(p[`iv_${k}`]) || 0));
  const avg = ivs.length ? ivs.reduce((a, b) => a + b, 0) / (ivs.length / 3) : 0; // 平均每只的 IV 总和（0~45）
  return Math.round(30 * f * (1 + (avg / 45) * 0.5));
}

function breedingCost(rarity) {
  return { stardust: Math.round(500 * (RARITY_FACTOR[String(rarity || 'COMMON').toUpperCase()] || 1)) };
}

/**
 * 生成基因集合
 * @param {object} mother { iv_attack, iv_defense, iv_hp, fast_move, charge_move, is_shiny }
 * @param {object} father 同上
 * @param {object} opts { destinyKnot, learnset: string[], rand }
 */
function inheritGenes(mother, father, opts = {}) {
  const rand = opts.rand || Math.random;
  const rate = opts.destinyKnot ? DESTINY_KNOT_INHERIT : BASE_INHERIT;
  const ivs = {};
  for (const k of IV_KEYS) {
    const m = Number(mother[`iv_${k}`]) || 0;
    const f = Number(father[`iv_${k}`]) || 0;
    if (rand() < rate) {
      if (rand() < DOMINANT_RATE) ivs[k] = { value: Math.max(m, f), from: m >= f ? 'mother' : 'father', expression: 'dominant' };
      else {
        const fromMother = rand() < 0.5;
        ivs[k] = { value: fromMother ? m : f, from: fromMother ? 'mother' : 'father', expression: 'recessive' };
      }
    } else {
      ivs[k] = { value: Math.min(15, Math.floor(rand() * 16)), from: 'random', expression: 'random' };
    }
  }
  let mutation = null;
  if (rand() < MUTATION_RATE) {
    const k = IV_KEYS[Math.min(2, Math.floor(rand() * 3))];
    const before = ivs[k].value;
    ivs[k] = { ...ivs[k], value: Math.min(15, before + 3), mutated: true };
    mutation = { stat: k, before, after: ivs[k].value };
  }
  const learnset = new Set(opts.learnset || []);
  const pickMove = (key) => {
    const candidates = [mother[key], father[key]].filter((mv) => mv && learnset.has(mv));
    if (candidates.length && rand() < MOVE_INHERIT_RATE) return { move: candidates[Math.floor(rand() * candidates.length) % candidates.length], inherited: true };
    return { move: null, inherited: false };
  };
  const shinyRate = mother.is_shiny || father.is_shiny ? 1 / 64 : 1 / 512;
  return {
    ivs,
    moves: { fast: pickMove('fast_move'), charge: pickMove('charge_move') },
    shiny: rand() < shinyRate,
    shinyRate,
    mutation,
    inheritanceRate: rate,
  };
}

function hatchKm(rarity) {
  return HATCH_KM[String(rarity || 'COMMON').toUpperCase()] || 2;
}

/** 孵化进度（km） */
function hatchProgress(egg, totalDistanceKm) {
  if (egg.distance_start_km == null) return { walkedKm: 0, requiredKm: Number(egg.required_km), percent: 0, ready: false, incubating: false };
  const walked = Math.max(0, (Number(totalDistanceKm) - Number(egg.distance_start_km)) * (Number(egg.speed_multiplier) || 1));
  const req = Number(egg.required_km);
  return { walkedKm: Math.round(walked * 100) / 100, requiredKm: req, percent: Math.min(100, Math.round((walked / req) * 1000) / 10), ready: walked >= req, incubating: true };
}

/** 继承概率预览（给 /check 用） */
function inheritancePreview(destinyKnot) {
  return {
    ivInheritanceRate: destinyKnot ? DESTINY_KNOT_INHERIT : BASE_INHERIT,
    dominantRate: DOMINANT_RATE,
    mutationRate: MUTATION_RATE,
    moveInheritanceRate: MOVE_INHERIT_RATE,
  };
}

module.exports = {
  UNDISCOVERED, DITTO_GROUP, IV_KEYS, RARITY_FACTOR, HATCH_KM, INCUBATORS,
  compatibility, offspringSpecies, breedingMinutes, breedingCost, inheritGenes, hatchKm, hatchProgress, inheritancePreview,
};
