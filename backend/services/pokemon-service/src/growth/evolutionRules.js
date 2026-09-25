/**
 * 进化规则与成长数值（纯函数，无 I/O，单元测试直接 require）
 *
 * 数据来源的约定（单一真相）：
 *   - pokemon_species（V1 结构）是主进化路径：evolves_to / candy_to_evolve / evolves_with_item / evolution_level；
 *   - evolution_rules 只补充"目标 ≠ species.evolves_to 且目标物种存在"的分支进化（如伊布 5 个形态），
 *     同一 (from, to) 以 species 列为准，规则忽略（规则表里 1→2 需 16 级这类数据来自正作，不适用本作的糖果进化）。
 *   - 分支进化的糖果消耗沿用起始物种的 candy_to_evolve。
 *
 * CP 一律按比例更新，保留强化次数、等级、觉醒等已有加成：
 *   baseCp(species, iv) = floor((A+ivA) * sqrt(D+ivD) * sqrt(H+ivH) / 10)   —— 与刷怪时的 CP 公式一致
 *   进化：cp × baseCp(新) / baseCp(旧)；升级：cp × lm(新) / lm(旧)，lm(L) = 1 + 0.02 × (L − 1)
 */
'use strict';

const MAX_FRIENDSHIP = 255;
const DAY_START_HOUR = 6;
const NIGHT_START_HOUR = 18;
const EVOLUTION_TRAINER_XP = 500;

function toInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

/** 物种在给定 IV 下的基础 CP（1 级、无强化） */
function baseCp(species, iv = {}) {
  const a = toInt(species.base_attack) + toInt(iv.attack ?? iv.iv_attack);
  const d = toInt(species.base_defense) + toInt(iv.defense ?? iv.iv_defense);
  const h = toInt(species.base_hp) + toInt(iv.hp ?? iv.iv_hp);
  return Math.max(10, Math.floor((a * Math.sqrt(Math.max(d, 1)) * Math.sqrt(Math.max(h, 1))) / 10));
}

/** 等级倍率：每级 +2% */
function levelMultiplier(level) {
  const l = Math.min(100, Math.max(1, toInt(level, 1)));
  return 1 + 0.02 * (l - 1);
}

/** 按比例缩放 CP（下限 10） */
function scaleCp(cp, fromFactor, toFactor) {
  if (!(fromFactor > 0)) return Math.max(10, toInt(cp, 10));
  return Math.max(10, Math.round(toInt(cp, 10) * (toFactor / fromFactor)));
}

function ivOf(pokemon) {
  return { attack: pokemon.iv_attack, defense: pokemon.iv_defense, hp: pokemon.iv_hp };
}

/** 进化后 CP / HP 预览 */
function previewEvolution(pokemon, fromSpecies, toSpecies) {
  const iv = ivOf(pokemon);
  const fromBase = baseCp(fromSpecies, iv);
  const toBase = baseCp(toSpecies, iv);
  const cp = scaleCp(pokemon.cp, fromBase, toBase);
  const hpMax = Math.max(10, Math.round(toInt(pokemon.hp_max, 10) * ((toInt(toSpecies.base_hp) + toInt(iv.hp)) / Math.max(1, toInt(fromSpecies.base_hp) + toInt(iv.hp)))));
  return {
    cp,
    hpMax,
    cpChange: cp - toInt(pokemon.cp),
    hpChange: hpMax - toInt(pokemon.hp_max),
    statsChange: {
      attack: toInt(toSpecies.base_attack) - toInt(fromSpecies.base_attack),
      defense: toInt(toSpecies.base_defense) - toInt(fromSpecies.base_defense),
      hp: toInt(toSpecies.base_hp) - toInt(fromSpecies.base_hp),
    },
    typesAdded: [toSpecies.type1, toSpecies.type2].filter((t) => t && t !== fromSpecies.type1 && t !== fromSpecies.type2),
    typesRemoved: [fromSpecies.type1, fromSpecies.type2].filter((t) => t && t !== toSpecies.type1 && t !== toSpecies.type2),
  };
}

/** evolution_rules 的道具名（'water_stone' / 'Water Stone'）→ items.item_id（'WATER_STONE'） */
function normalizeItemCode(name) {
  if (!name) return null;
  return String(name).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/** 游戏时区的昼夜（6:00–17:59 为白天） */
function dayPhase(at = new Date(), tz = process.env.GAME_TIMEZONE || 'Asia/Shanghai') {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? 'day' : 'night';
}

/**
 * 某物种的全部进化选项
 * @param {object} fromSpecies pokemon_species 行
 * @param {Array} rules 以 fromSpecies.id 为起点的 evolution_rules 行（可含 item_name 连接列）
 * @param {Map<number, object>} speciesById 目标物种（只返回存在的目标）
 */
function buildEvolutionOptions(fromSpecies, rules = [], speciesById = new Map()) {
  const options = [];
  const candy = toInt(fromSpecies.candy_to_evolve, 0);
  const primary = fromSpecies.evolves_to != null ? toInt(fromSpecies.evolves_to) : null;
  if (primary && speciesById.has(primary)) {
    options.push({
      toSpeciesId: primary,
      source: 'species',
      evolutionType: fromSpecies.evolves_with_item ? 'item' : (fromSpecies.evolution_level ? 'level' : 'candy'),
      hidden: false,
      hint: null,
      requirements: {
        candy,
        item: normalizeItemCode(fromSpecies.evolves_with_item),
        minLevel: fromSpecies.evolution_level ? toInt(fromSpecies.evolution_level) : null,
        friendship: null,
        time: null,
        trade: false,
      },
    });
  }
  for (const r of rules) {
    const to = toInt(r.to_species_id);
    if (r.is_active === false || to === primary || !speciesById.has(to)) continue;
    if (options.some((o) => o.toSpeciesId === to)) continue;
    const cond = (r.conditions && typeof r.conditions === 'object') ? r.conditions : {};
    const item = normalizeItemCode(cond.item_name || cond.item || r.item_name);
    options.push({
      toSpeciesId: to,
      source: 'rule',
      ruleId: r.id,
      evolutionType: r.requires_trade || r.evolution_type === 'trade' ? 'trade'
        : (cond.friendship ? 'friendship' : (item ? 'item' : (r.evolution_type || 'candy'))),
      hidden: !!r.is_hidden,
      hint: r.is_hidden ? { zh: r.hint_zh || null, en: r.hint_en || null, ja: r.hint_ja || null } : null,
      branchGroup: r.branch_group || null,
      requirements: {
        candy: toInt(cond.candy, candy),
        item,
        minLevel: r.min_level ? toInt(r.min_level) : null,
        friendship: cond.friendship ? toInt(cond.friendship) : null,
        time: cond.time === 'day' || cond.time === 'night' ? cond.time : null,
        trade: !!(r.requires_trade || r.evolution_type === 'trade'),
      },
    });
  }
  return options;
}

/**
 * 评估进化条件
 * @param {object} req option.requirements
 * @param {object} ctx { candy, items: {CODE: qty}, level, friendship, phase, occupiedBy, defending }
 */
function evaluateRequirements(req, ctx = {}) {
  const checks = [];
  const add = (type, required, current, met, message) => checks.push({ type, required, current, met, message });
  if (req.candy > 0) {
    const have = toInt(ctx.candy);
    add('candy', req.candy, have, have >= req.candy, have >= req.candy ? null : `糖果不足（需要 ${req.candy}，当前 ${have}）`);
  }
  if (req.item) {
    const have = toInt((ctx.items || {})[req.item]);
    add('item', req.item, have, have >= 1, have >= 1 ? null : `需要道具 ${req.item}`);
  }
  if (req.minLevel) {
    const lv = toInt(ctx.level, 1);
    add('level', req.minLevel, lv, lv >= req.minLevel, lv >= req.minLevel ? null : `需要精灵等级 ${req.minLevel}（当前 ${lv}）`);
  }
  if (req.friendship) {
    const f = toInt(ctx.friendship);
    add('friendship', req.friendship, f, f >= req.friendship, f >= req.friendship ? null : `需要亲密度 ${req.friendship}（当前 ${f}）`);
  }
  if (req.time) {
    const phase = ctx.phase || dayPhase();
    add('time', req.time, phase, phase === req.time, phase === req.time ? null : `需要在${req.time === 'day' ? '白天' : '夜晚'}进化`);
  }
  if (req.trade) {
    add('trade', true, false, false, '需要通过交换完成进化');
  }
  if (ctx.occupiedBy) {
    add('idle', 'idle', ctx.occupiedBy, false, `精灵正在${ctx.occupiedBy}中，无法进化`);
  }
  if (ctx.defending) {
    add('idle', 'idle', 'gym', false, '精灵正在驻守道馆，无法进化');
  }
  return { met: checks.every((c) => c.met), checks };
}

/** 多条可进化路径时的推荐：CP 提升最多者 */
function recommend(options) {
  const ok = options.filter((o) => o.met);
  if (!ok.length) return null;
  const best = ok.slice().sort((a, b) => (b.preview?.cpChange || 0) - (a.preview?.cpChange || 0))[0];
  return { toSpeciesId: best.toSpeciesId, reason: ok.length === 1 ? 'ONLY_ONE_PATH' : 'MAX_CP_GAIN' };
}

module.exports = {
  MAX_FRIENDSHIP,
  EVOLUTION_TRAINER_XP,
  baseCp,
  levelMultiplier,
  scaleCp,
  previewEvolution,
  normalizeItemCode,
  dayPhase,
  buildEvolutionOptions,
  evaluateRequirements,
  recommend,
};
