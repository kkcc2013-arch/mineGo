/**
 * 精灵合并进化服务（REQ-00390）
 *
 * 预览：校验选择 + 成功率构成 + 可能产出；执行（事务）：按 ID 顺序锁定全部参与精灵 → 复核 → 扣道具（含可选幸运符）→
 * 掷成功/变异 → 参与精灵软删除（is_released，背包计数触发器同步）→ 成功则创建产出精灵（origin=merged，等级/IV 由配方与
 * 输入决定、图鉴、家族糖果）→ 写合并记录。配方在 merge_recipes（多语言名称），历史与统计来自 merge_records。
 * 规则见 growth/mergeRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem } = require('../../../shared/inventory');
const engine = require('../../../shared/ExperienceEngine');
const { baseCp } = require('../../../shared/pokemonStats');
const rules = require('./growth/mergeRules');
const { GrowthError, assertUuid, addCandy } = require('./growth/common');

function lang2(lang) {
  const l = String(lang || 'zh').toLowerCase();
  return l.startsWith('en') ? 'en' : (l.startsWith('ja') ? 'ja' : 'zh');
}

function presentRecipe(r, lang) {
  const l = lang2(lang);
  const pick = (o) => (o && (o[l] || o.zh || o.en)) || null;
  return {
    recipeId: r.id, code: r.recipe_code, name: pick(r.name_i18n), description: pick(r.description_i18n),
    requiredPokemon: r.required_pokemon, requiredItems: r.required_items || [],
    output: { speciesId: r.output_pokemon_id, name: r.output_name || null, minLevel: r.output_min_level, levelVariance: r.output_level_variance },
    variant: r.variant_pokemon_id ? { speciesId: r.variant_pokemon_id, name: r.variant_name || null, rate: Number(r.variant_rate) } : null,
    baseSuccessRate: Number(r.base_success_rate), unlockConditions: r.unlock_conditions || {},
  };
}

async function loadRecipe(db, recipeId) {
  const id = Number(recipeId);
  if (!Number.isInteger(id) || id <= 0) throw new GrowthError('INVALID_PARAM', '无效的 recipeId', 400);
  const { rows: [r] } = await db.query(
    `SELECT r.*, o.name_zh AS output_name, v.name_zh AS variant_name FROM merge_recipes r
       JOIN pokemon_species o ON o.id = r.output_pokemon_id LEFT JOIN pokemon_species v ON v.id = r.variant_pokemon_id
      WHERE r.id = $1 AND r.is_active`, [id]);
  if (!r) throw new GrowthError('RECIPE_NOT_FOUND', '合并配方不存在', 404);
  return r;
}

async function recipes(userId, { lang } = {}) {
  const { rows } = await query(
    `SELECT r.*, o.name_zh AS output_name, v.name_zh AS variant_name FROM merge_recipes r
       JOIN pokemon_species o ON o.id = r.output_pokemon_id LEFT JOIN pokemon_species v ON v.id = r.variant_pokemon_id
      WHERE r.is_active ORDER BY r.id`);
  const { rows: owned } = await query(
    `SELECT species_id, COUNT(*)::int AS n FROM pokemon_instances
      WHERE user_id = $1 AND COALESCE(is_released, FALSE) = FALSE AND NOT COALESCE(is_favorite, FALSE) AND occupied_by IS NULL
      GROUP BY species_id`, [userId]);
  const { rows: [u] } = await query('SELECT level FROM users WHERE id = $1', [userId]);
  const counts = Object.fromEntries(owned.map((o) => [o.species_id, o.n]));
  return rows.map((r) => ({ ...presentRecipe(r, lang), availability: rules.availability(r, counts, u ? u.level : 1) }));
}

async function loadPokemons(db, ids, userId, { lock = false } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) throw new GrowthError('INVALID_PARAM', 'pokemonIds 必须是 1~20 个精灵 ID', 400);
  ids.forEach((id) => assertUuid(id));
  if (lock) {
    await db.query('SELECT 1 FROM pokemon_instances WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY id FOR UPDATE', [[...new Set(ids)], userId]);
  }
  const { rows } = await db.query(
    `SELECT pi.*, ps.name_zh AS species_name FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = ANY($1::uuid[]) AND pi.user_id = $2 AND COALESCE(pi.is_released, FALSE) = FALSE`, [[...new Set(ids)], userId]);
  if (rows.length !== new Set(ids).size) throw new GrowthError('POKEMON_NOT_FOUND', '部分精灵不存在或不属于你', 404);
  // 保持调用方顺序（重复 ID 也保留，交给 validateSelection 报错）
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id));
}

async function preview(userId, { recipeId, pokemonIds, useLuckyCharm, lang } = {}) {
  const r = await loadRecipe({ query }, recipeId);
  const pokemons = await loadPokemons({ query }, pokemonIds, userId);
  const v = rules.validateSelection(r, pokemons);
  const { rows: [u] } = await query('SELECT level FROM users WHERE id = $1', [userId]);
  const avail = rules.availability(r, {}, u ? u.level : 1);
  const items = [];
  for (const it of r.required_items || []) {
    const { rows: [q] } = await query(
      'SELECT COALESCE(SUM(quantity), 0)::int AS q FROM player_inventory WHERE user_id = $1 AND item_id = $2', [userId, it.item_id]);
    items.push({ itemId: it.item_id, need: it.count, have: q.q, met: q.q >= it.count });
  }
  return {
    recipe: presentRecipe(r, lang),
    valid: v.ok && !avail.locked && items.every((i) => i.met),
    errors: [...v.errors, ...(avail.locked ? [avail.lockedReason] : []), ...items.filter((i) => !i.met).map((i) => `道具不足：${i.itemId} ×${i.need}`)],
    items,
    successRate: rules.successRate(r, pokemons, { luckyCharm: !!useLuckyCharm }),
    consumes: pokemons.map((p) => ({ id: p.id, speciesId: p.species_id, name: p.nickname || p.species_name, cp: p.cp, level: p.level })),
    warning: '合并失败时参与的精灵同样会被消耗',
  };
}

async function execute(userId, { recipeId, pokemonIds, useLuckyCharm, lang } = {}, { rand } = {}) {
  return transaction(async (client) => {
    const r = await loadRecipe(client, recipeId);
    const { rows: [u] } = await client.query('SELECT level FROM users WHERE id = $1', [userId]);
    const avail = rules.availability(r, {}, u ? u.level : 1);
    if (avail.locked) throw new GrowthError('RECIPE_LOCKED', avail.lockedReason, 403);
    const pokemons = await loadPokemons(client, pokemonIds, userId, { lock: true });
    const v = rules.validateSelection(r, pokemons);
    if (!v.ok) throw new GrowthError('INVALID_SELECTION', v.errors[0], 400, { errors: v.errors });
    for (const it of r.required_items || []) {
      if (!(await consumeItem(client, userId, it.item_id, it.count))) throw new GrowthError('INSUFFICIENT_ITEMS', `道具不足：${it.item_id} ×${it.count}`, 400);
    }
    if (useLuckyCharm && !(await consumeItem(client, userId, 'MERGE_LUCKY_CHARM', 1))) throw new GrowthError('INSUFFICIENT_ITEMS', '没有幸运符', 400);

    const rate = rules.successRate(r, pokemons, { luckyCharm: !!useLuckyCharm });
    const rnd = rand || Math.random;
    const outcome = rules.roll(rate.total, r.variant_rate, rnd);
    await client.query(
      'UPDATE pokemon_instances SET is_released = TRUE, released_at = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[])', [pokemons.map((p) => p.id)]);

    let output = null;
    if (outcome.success) {
      const speciesId = outcome.variant && r.variant_pokemon_id ? r.variant_pokemon_id : r.output_pokemon_id;
      const { rows: [sp] } = await client.query('SELECT * FROM pokemon_species WHERE id = $1', [speciesId]);
      const stats = rules.outputStats(r, pokemons, rnd);
      const level = Math.min(stats.level, engine.levelCap(u ? u.level : 1)); // 不超过训练师等级决定的精灵等级上限
      const cp = Math.max(10, Math.round(baseCp(sp, stats.ivs) * engine.levelMultiplier(level)));
      const { rows: moves } = await client.query(
        `SELECT pm.move_id, m.category FROM pokemon_moves pm JOIN moves m ON m.id = pm.move_id WHERE pm.species_id = $1 ORDER BY pm.move_id`, [speciesId]);
      const fast = (moves.find((m) => m.category === 'FAST') || {}).move_id || 'TACKLE';
      const charge = (moves.find((m) => m.category === 'CHARGE') || {}).move_id || 'STRUGGLE';
      const { rows: [p] } = await client.query(
        `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, level, experience,
                                        is_perfect_iv, fast_move, charge_move, learned_fast_moves, learned_charge_moves, origin)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11::text,$12::text,ARRAY[$11::text],ARRAY[$12::text],'merged') RETURNING id`,
        [userId, speciesId, cp, Math.max(10, Math.floor(cp * 0.8)), stats.ivs.attack, stats.ivs.defense, stats.ivs.hp, level,
          engine.expForLevel(level, sp.growth_rate || 'medium_fast'),
          stats.ivs.attack === 15 && stats.ivs.defense === 15 && stats.ivs.hp === 15, fast, charge]);
      await client.query(
        `INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at, best_cp)
         VALUES ($1, $2, 1, 1, NOW(), $3)
         ON CONFLICT (user_id, species_id) DO UPDATE SET caught_count = pokedex_entries.caught_count + 1,
           best_cp = GREATEST(COALESCE(pokedex_entries.best_cp, 0), EXCLUDED.best_cp)`, [userId, speciesId, cp]);
      await addCandy(client, userId, speciesId, 3);
      output = { pokemonId: p.id, speciesId, name: sp.name_zh, cp, level, ivs: stats.ivs, isVariant: outcome.variant };
    }
    const { rows: [rec] } = await client.query(
      `INSERT INTO merge_records (user_id, recipe_id, input_pokemon, input_items, output_pokemon_instance_id, output_pokemon_id,
                                  output_level, is_variant, success, lucky_bonus, success_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, merged_at`,
      [userId, r.id, JSON.stringify(pokemons.map((p) => ({ pokemon_instance_id: p.id, species_id: p.species_id, level: p.level, cp: p.cp }))),
        JSON.stringify([...(r.required_items || []), ...(useLuckyCharm ? [{ item_id: 'MERGE_LUCKY_CHARM', count: 1 }] : [])]),
        output ? output.pokemonId : null, output ? output.speciesId : null, output ? output.level : null,
        !!(output && output.isVariant), outcome.success, rate.lucky, rate.total]);
    return {
      recordId: rec.id, recipe: presentRecipe(r, lang), success: outcome.success, isVariant: !!(output && output.isVariant),
      successRate: rate, consumed: pokemons.map((p) => p.id), output,
      animation: outcome.success ? (output.isVariant ? 'merge_variant' : 'merge_success') : 'merge_fail',
    };
  });
}

async function history(userId, { limit = 20, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const { rows } = await query(
    `SELECT m.id, m.recipe_id AS "recipeId", r.recipe_code AS "recipeCode", m.input_pokemon AS "inputPokemon", m.input_items AS "inputItems",
            m.output_pokemon_instance_id AS "outputPokemonId", m.output_pokemon_id AS "outputSpeciesId", s.name_zh AS "outputName",
            m.output_level AS "outputLevel", m.is_variant AS "isVariant", m.success, m.success_rate::float AS "successRate", m.merged_at AS "mergedAt"
       FROM merge_records m LEFT JOIN merge_recipes r ON r.id = m.recipe_id LEFT JOIN pokemon_species s ON s.id = m.output_pokemon_id
      WHERE m.user_id = $1 ORDER BY m.merged_at DESC, m.id DESC LIMIT $2 OFFSET $3`, [userId, lim, Math.max(0, Number(offset) || 0)]);
  return { items: rows, limit: lim };
}

async function stats(userId) {
  const { rows: [s] } = await query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE success)::int AS successes, COUNT(*) FILTER (WHERE is_variant)::int AS variants,
            COALESCE(SUM(jsonb_array_length(input_pokemon)), 0)::int AS "pokemonConsumed"
       FROM merge_records WHERE user_id = $1`, [userId]);
  const { rows: byRecipe } = await query(
    `SELECT r.recipe_code AS code, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE m.success)::int AS successes
       FROM merge_records m JOIN merge_recipes r ON r.id = m.recipe_id WHERE m.user_id = $1 GROUP BY r.recipe_code ORDER BY total DESC`, [userId]);
  return { ...s, successRate: s.total ? Math.round((s.successes / s.total) * 1000) / 10 : 0, byRecipe };
}

module.exports = { recipes, preview, execute, history, stats };
