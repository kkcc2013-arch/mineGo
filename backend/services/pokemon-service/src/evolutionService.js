/**
 * 精灵进化服务（唯一实现）
 *
 * 所有进化入口都走这里：
 *   POST /pokemon/:id/evolution/execute   （routes/evolution.js，支持分支进化 targetSpeciesId）
 *   POST /pokemon/my/:id/evolve           （index.js，客户端旧接口，委托本服务）
 *   POST /pokemon/:id/evolve              （routes/friendship.js 的亲密度进化，委托本服务）
 *   合并进化 / 进化路径可视化复用 loadOptions / previewEvolution
 *
 * 原实现查询 pokemon_species 中不存在的列（image_url/name/types…）、写 user_items / users.experience 等不存在的表列，
 * 所有进化接口都 500；index.js 的简单进化无行锁、糖果扣减无条件（并发可重复扣糖或只进化一次扣两次）。
 * 规则与数值见 growth/evolutionRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem } = require('../../../shared/inventory');
const { createLogger } = require('../../../shared/logger');
const rules = require('./growth/evolutionRules');
const { GrowthError, lockOwnedPokemon, assertIdle, spendCandy, candyOf, assertUuid, occupiedBy } = require('./growth/common');

const logger = createLogger('evolution-service');

const ANIMATIONS = {
  standard: { duration: 3000, particles: 50, sound: 'standard_evolution' },
  special: { duration: 5000, particles: 100, sound: 'special_evolution' },
};

// 进化成功后的回调（成长轨迹里程碑等），由各模块注册，在同一事务内执行
const afterEvolveHooks = [];
function onEvolved(fn) { afterEvolveHooks.push(fn); }

function speciesOf(p) {
  return {
    id: Number(p.species_id),
    name_zh: p.species_name,
    type1: p.type1,
    type2: p.type2,
    rarity: p.rarity,
    base_attack: p.base_attack,
    base_defense: p.base_defense,
    base_hp: p.base_hp,
    candy_to_evolve: p.candy_to_evolve,
    evolves_to: p.evolves_to,
    evolves_with_item: p.evolves_with_item,
    evolution_level: p.evolution_level,
  };
}

async function loadRules(db, speciesId) {
  try {
    const { rows } = await db.query(
      `SELECT er.*, ei.name AS item_name
         FROM evolution_rules er
         LEFT JOIN evolution_items ei ON ei.id = er.required_item_id
        WHERE er.from_species_id = $1 AND er.is_active = TRUE
        ORDER BY er.branch_priority DESC NULLS LAST, er.id`,
      [speciesId],
    );
    return rows;
  } catch (err) {
    if (err.code === '42P01') return []; // 旧库没有 evolution_rules
    throw err;
  }
}

/** 某物种的进化选项（附目标物种行） */
async function loadOptions(db, fromSpecies) {
  const ruleRows = await loadRules(db, fromSpecies.id);
  const ids = [...new Set([fromSpecies.evolves_to, ...ruleRows.map((r) => r.to_species_id)].filter((x) => x != null).map(Number))];
  const speciesById = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `SELECT id, name_zh, name_en, type1, type2, rarity, base_attack, base_defense, base_hp,
              candy_to_evolve, evolves_to, sprite_url
         FROM pokemon_species WHERE id = ANY($1::int[])`, [ids]);
    for (const r of rows) speciesById.set(Number(r.id), r);
  }
  return rules.buildEvolutionOptions(fromSpecies, ruleRows, speciesById).map((o) => ({ ...o, target: speciesById.get(o.toSpeciesId) }));
}

async function loadContext(db, pokemon, options, { lockCandy = false } = {}) {
  const candy = await candyOf(db, pokemon.user_id, pokemon.species_id, { lock: lockCandy });
  const itemCodes = [...new Set(options.map((o) => o.requirements.item).filter(Boolean))];
  const items = {};
  if (itemCodes.length) {
    const { rows } = await db.query(
      `SELECT item_id, SUM(quantity)::int AS qty FROM player_inventory
        WHERE user_id = $1 AND item_id = ANY($2::text[]) GROUP BY item_id`, [pokemon.user_id, itemCodes]);
    for (const r of rows) items[r.item_id] = r.qty;
  }
  return {
    candy,
    items,
    level: Number(pokemon.level || 1),
    friendship: Number(pokemon.friendship ?? 70),
    phase: rules.dayPhase(),
    occupiedBy: occupiedBy(pokemon),
    defending: !!pokemon.defending_gym_id,
  };
}

function describeOption(o, pokemon, ctx, discovered) {
  const evaluation = rules.evaluateRequirements(o.requirements, ctx);
  const visible = !o.hidden || evaluation.met || discovered.has(o.toSpeciesId);
  const preview = rules.previewEvolution(pokemon, speciesOf(pokemon), o.target);
  return {
    toSpeciesId: visible ? o.toSpeciesId : null,
    toSpeciesName: visible ? o.target.name_zh : '？？？',
    toSpeciesNameEn: visible ? o.target.name_en : '???',
    types: visible ? [o.target.type1, o.target.type2].filter(Boolean) : [],
    rarity: visible ? o.target.rarity : null,
    spriteUrl: visible ? o.target.sprite_url : null,
    evolutionType: o.evolutionType,
    source: o.source,
    hidden: o.hidden,
    discovered: visible,
    hint: o.hint,
    requirements: o.requirements,
    checks: evaluation.checks,
    met: evaluation.met,
    preview: visible ? preview : null,
  };
}

/**
 * 检查精灵能否进化（所有路径与缺失条件）
 */
async function checkEvolution(pokemonId, userId) {
  assertUuid(pokemonId);
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const options = await loadOptions({ query }, speciesOf(p));
  const ctx = await loadContext({ query }, p, options);
  const { rows: seen } = await query(
    'SELECT species_id FROM pokedex_entries WHERE user_id = $1 AND caught_count > 0', [userId]);
  const discovered = new Set(seen.map((r) => Number(r.species_id)));
  const described = options.map((o) => describeOption(o, p, ctx, discovered));
  return {
    pokemon: {
      id: p.id, speciesId: Number(p.species_id), speciesName: p.species_name, cp: p.cp,
      level: Number(p.level || 1), friendship: ctx.friendship, candy: ctx.candy,
      occupiedBy: ctx.occupiedBy, defendingGym: ctx.defending,
    },
    eligible: described.some((d) => d.met),
    reason: options.length === 0 ? 'NO_EVOLUTION_AVAILABLE' : (described.some((d) => d.met) ? null : 'CONDITIONS_NOT_MET'),
    phase: ctx.phase,
    options: described,
    recommendation: rules.recommend(described.map((d) => ({ ...d, preview: d.preview || {} })).filter((d) => d.toSpeciesId)),
  };
}

/**
 * 执行进化（事务：精灵行锁 → 条件复核 → 原子扣糖/道具 → 更新实例 → 历史/图鉴/训练师经验）
 * @param {object} [opts] { targetSpeciesId, source }
 */
async function evolve(pokemonId, userId, opts = {}) {
  assertUuid(pokemonId);
  const targetSpeciesId = opts.targetSpeciesId != null && opts.targetSpeciesId !== '' ? Number(opts.targetSpeciesId) : null;
  if (targetSpeciesId != null && !Number.isInteger(targetSpeciesId)) {
    throw new GrowthError('INVALID_TARGET', '无效的目标物种', 400);
  }

  const result = await transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    assertIdle(p, '进化');
    const fromSpecies = speciesOf(p);
    const options = await loadOptions(client, fromSpecies);
    if (!options.length) throw new GrowthError('NO_EVOLUTION_AVAILABLE', '该精灵无法进化', 400);

    let option;
    if (targetSpeciesId != null) {
      option = options.find((o) => o.toSpeciesId === targetSpeciesId);
      if (!option) throw new GrowthError('INVALID_EVOLUTION_PATH', '无效的进化路径', 400);
    } else if (options.length === 1) {
      option = options[0];
    } else {
      option = options.find((o) => o.source === 'species');
      if (!option) {
        throw new GrowthError('TARGET_REQUIRED', '该精灵有多条进化路径，请指定目标物种', 400,
          { targets: options.filter((o) => !o.hidden).map((o) => o.toSpeciesId) });
      }
    }

    const ctx = await loadContext(client, p, [option], { lockCandy: true });
    const evaluation = rules.evaluateRequirements(option.requirements, ctx);
    if (!evaluation.met) {
      const firstMissing = evaluation.checks.find((c) => !c.met);
      const code = firstMissing && firstMissing.type === 'candy' ? 'INSUFFICIENT_CANDY'
        : (firstMissing && firstMissing.type === 'item' ? 'INSUFFICIENT_ITEMS' : 'EVOLUTION_CONDITIONS_NOT_MET');
      throw new GrowthError(code, firstMissing ? firstMissing.message : '未满足进化条件', 400, { checks: evaluation.checks });
    }

    const req = option.requirements;
    if (!(await spendCandy(client, userId, p.species_id, req.candy))) {
      throw new GrowthError('INSUFFICIENT_CANDY', `糖果不足（需要 ${req.candy}）`, 400);
    }
    if (req.item && !(await consumeItem(client, userId, req.item, 1))) {
      throw new GrowthError('INSUFFICIENT_ITEMS', `需要道具 ${req.item}`, 400);
    }

    const target = option.target;
    const preview = rules.previewEvolution(p, fromSpecies, target);
    const before = { speciesId: fromSpecies.id, speciesName: fromSpecies.name_zh, cp: p.cp, hpMax: p.hp_max, level: Number(p.level || 1) };
    const after = { speciesId: target.id, speciesName: target.name_zh, cp: preview.cp, hpMax: preview.hpMax, level: before.level };

    await client.query(
      `UPDATE pokemon_instances
          SET species_id = $2, cp = $3, hp_max = $4, hp_current = $4, updated_at = NOW()
        WHERE id = $1`,
      [p.id, target.id, preview.cp, preview.hpMax]);

    const evolutionType = option.evolutionType;
    await client.query(
      `INSERT INTO evolution_history
         (user_id, pokemon_instance_id, from_species_id, to_species_id, evolution_type,
          before_cp, before_level, before_stats, after_cp, after_level, after_stats, candy_cost, item_used, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [userId, p.id, fromSpecies.id, target.id, evolutionType,
        before.cp, before.level, JSON.stringify(before), after.cp, after.level, JSON.stringify(after),
        req.candy || 0, req.item || null, opts.source || 'evolve']);

    await client.query(
      `INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at, best_cp, has_shiny)
       VALUES ($1, $2, 1, 1, NOW(), $3, $4)
       ON CONFLICT (user_id, species_id) DO UPDATE SET
         caught_count = pokedex_entries.caught_count + 1,
         first_caught_at = COALESCE(pokedex_entries.first_caught_at, NOW()),
         best_cp = GREATEST(COALESCE(pokedex_entries.best_cp, 0), EXCLUDED.best_cp),
         has_shiny = pokedex_entries.has_shiny OR EXCLUDED.has_shiny`,
      [userId, target.id, preview.cp, !!p.is_shiny]);

    // 训练师经验（等级由数据库触发器换算）
    await client.query('UPDATE users SET xp = xp + $2, updated_at = NOW() WHERE id = $1', [userId, rules.EVOLUTION_TRAINER_XP]);

    const evolved = { pokemon: p, fromSpecies, toSpecies: target, before, after, evolutionType, option };
    for (const hook of afterEvolveHooks) await hook(client, evolved);

    return {
      pokemonId: p.id,
      fromSpecies: { id: fromSpecies.id, name: fromSpecies.name_zh },
      toSpecies: { id: target.id, name: target.name_zh, nameEn: target.name_en, types: [target.type1, target.type2].filter(Boolean), rarity: target.rarity, spriteUrl: target.sprite_url },
      before,
      after,
      cpChange: after.cp - before.cp,
      candyCost: req.candy || 0,
      itemUsed: req.item || null,
      evolutionType,
      trainerXp: rules.EVOLUTION_TRAINER_XP,
      animation: option.hidden || option.source === 'rule' ? ANIMATIONS.special : ANIMATIONS.standard,
    };
  });

  logger.info({ userId, pokemonId, from: result.fromSpecies.id, to: result.toSpecies.id }, 'pokemon evolved');
  return result;
}

async function getHistory(userId, { limit = 20, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);
  const { rows } = await query(
    `SELECT eh.id, eh.pokemon_instance_id AS "pokemonId", eh.from_species_id AS "fromSpeciesId", f.name_zh AS "fromSpeciesName",
            eh.to_species_id AS "toSpeciesId", t.name_zh AS "toSpeciesName", eh.evolution_type AS "evolutionType",
            eh.before_cp AS "beforeCp", eh.after_cp AS "afterCp", eh.candy_cost AS "candyCost", eh.item_used AS "itemUsed",
            eh.source, eh.created_at AS "createdAt"
       FROM evolution_history eh
       LEFT JOIN pokemon_species f ON f.id = eh.from_species_id
       LEFT JOIN pokemon_species t ON t.id = eh.to_species_id
      WHERE eh.user_id = $1
      ORDER BY eh.created_at DESC, eh.id DESC
      LIMIT $2 OFFSET $3`, [userId, lim, off]);
  const { rows: [{ total }] } = await query('SELECT COUNT(*)::int AS total FROM evolution_history WHERE user_id = $1', [userId]);
  return { history: rows, total, limit: lim, offset: off };
}

module.exports = { checkEvolution, evolve, getHistory, loadOptions, speciesOf, onEvolved, ANIMATIONS };
