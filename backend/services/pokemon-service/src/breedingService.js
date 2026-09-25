/**
 * 精灵培育与孵化服务（REQ-00276）
 *
 * 原实现自建 pg Pool / ioredis 连接、路由挂在网关未代理的 /breeding，外部不可达。重写为：
 *   培育屋（breeding_centers，按槽位）→ 配对检查（蛋组）→ 开始培育（父母被占用、扣星尘、可用命运红线提升遗传率，
 *   开始时即生成基因集合写入 breeding_pairs.offspring_data）→ 到时领取得到精灵蛋（pokemon_eggs）→ 放入孵化器
 *   （记录当时的累计行走距离）→ 走够距离孵化出精灵（IV/技能/闪光按基因、世代 +1、写谱系与统计）
 * 规则见 growth/breedingRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem } = require('../../../shared/inventory');
const rules = require('./growth/breedingRules');
const { baseCp } = require('./growth/evolutionRules');
const { GrowthError, lockOwnedPokemon, assertIdle, assertUuid, occupy, release, spendCurrency } = require('./growth/common');

const OCCUPY = 'breeding';

async function ensureCenter(db, userId) {
  await db.query('INSERT INTO breeding_centers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows: [c] } = await db.query('SELECT * FROM breeding_centers WHERE user_id = $1', [userId]);
  return c;
}

async function parentInfo(db, p) {
  const { rows } = await db.query('SELECT egg_group_id FROM species_egg_groups WHERE species_id = $1', [p.species_id]);
  const { rows: [r] } = await db.query('SELECT pokemon_family_root($1) AS root', [p.species_id]);
  return { ...p, groups: rows.map((x) => Number(x.egg_group_id)), familyRoot: Number(r.root) };
}

async function learnsetOf(db, speciesId) {
  const { rows } = await db.query(
    `SELECT pm.move_id, m.category FROM pokemon_moves pm JOIN moves m ON m.id = pm.move_id
      WHERE pm.species_id = $1 AND pm.learn_method IN ('TM', 'LEVEL_UP', 'TUTOR')`, [speciesId]);
  return rows;
}

function presentPair(pr, now = new Date()) {
  const ready = pr.status === 'breeding' && new Date(pr.ready_at) <= now;
  return {
    pairId: pr.id, slotIndex: pr.slot_index, motherId: pr.parent1_pokemon_id, fatherId: pr.parent2_pokemon_id,
    status: ready ? 'ready' : pr.status, startedAt: pr.started_at, readyAt: pr.ready_at,
    remainingMinutes: pr.status === 'breeding' ? Math.max(0, Math.ceil((new Date(pr.ready_at) - now) / 60000)) : 0,
    offspringSpeciesId: pr.offspring_data && pr.offspring_data.speciesId,
  };
}

async function eggsOf(db, userId) {
  const { rows: [u] } = await db.query('SELECT total_distance_km FROM users WHERE id = $1', [userId]);
  const { rows } = await db.query(
    `SELECT e.*, ps.name_zh AS species_name FROM pokemon_eggs e JOIN pokemon_species ps ON ps.id = e.species_id
      WHERE e.user_id = $1 AND e.status <> 'hatched' ORDER BY e.created_at`, [userId]);
  return rows.map((e) => ({
    eggId: e.id, speciesId: e.species_id, rarity: e.rarity, status: e.status, incubator: e.incubator,
    generation: e.generation, createdAt: e.created_at, ...rules.hatchProgress(e, u ? u.total_distance_km : 0),
  }));
}

async function getCenter(userId) {
  const c = await ensureCenter({ query }, userId);
  const { rows } = await query(
    `SELECT * FROM breeding_pairs WHERE center_id = $1 AND status IN ('breeding', 'ready') ORDER BY slot_index`, [c.id]);
  return { centerId: c.id, slots: c.slots, usedSlots: rows.length, pairs: rows.map((r) => presentPair(r)), eggs: await eggsOf({ query }, userId) };
}

async function check(userId, { motherId, fatherId, useDestinyKnot } = {}) {
  assertUuid(motherId, 'motherId');
  assertUuid(fatherId, 'fatherId');
  const m = await lockOwnedPokemon({ query }, motherId, userId, { lock: false });
  const f = await lockOwnedPokemon({ query }, fatherId, userId, { lock: false });
  const mi = await parentInfo({ query }, m);
  const fi = await parentInfo({ query }, f);
  const comp = rules.compatibility(mi, fi);
  const out = { compatible: comp.ok, reason: comp.reason, sharedGroups: comp.sharedGroups || [], busy: [m, f].filter((p) => p.occupied_by || p.defending_gym_id).map((p) => p.id) };
  if (comp.ok) {
    const sid = rules.offspringSpecies(mi, fi);
    const { rows: [sp] } = await query('SELECT id, name_zh, rarity FROM pokemon_species WHERE id = $1', [sid]);
    Object.assign(out, {
      offspring: { speciesId: sp.id, name: sp.name_zh, rarity: sp.rarity, hatchKm: rules.hatchKm(sp.rarity) },
      breedingMinutes: rules.breedingMinutes(sp.rarity, [m, f]),
      cost: rules.breedingCost(sp.rarity),
      inheritance: rules.inheritancePreview(!!useDestinyKnot),
    });
  }
  return out;
}

async function start(userId, { motherId, fatherId, useDestinyKnot } = {}) {
  assertUuid(motherId, 'motherId');
  assertUuid(fatherId, 'fatherId');
  if (motherId === fatherId) throw new GrowthError('INVALID_PAIR', '不能与自己配对', 400);
  return transaction(async (client) => {
    const c = await ensureCenter(client, userId);
    await client.query('SELECT 1 FROM breeding_centers WHERE id = $1 FOR UPDATE', [c.id]);
    // 固定加锁顺序
    const [a, b] = [motherId, fatherId].sort();
    await client.query('SELECT 1 FROM pokemon_instances WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY id FOR UPDATE', [[a, b], userId]);
    const m = await lockOwnedPokemon(client, motherId, userId, { lock: false });
    const f = await lockOwnedPokemon(client, fatherId, userId, { lock: false });
    assertIdle(m, '培育');
    assertIdle(f, '培育');
    const mi = await parentInfo(client, m);
    const fi = await parentInfo(client, f);
    const comp = rules.compatibility(mi, fi);
    if (!comp.ok) throw new GrowthError('INCOMPATIBLE', comp.reason, 400);

    const { rows: used } = await client.query(
      "SELECT slot_index FROM breeding_pairs WHERE center_id = $1 AND status IN ('breeding', 'ready')", [c.id]);
    const taken = new Set(used.map((r) => r.slot_index));
    const slot = [...Array(c.slots).keys()].find((i) => !taken.has(i));
    if (slot == null) throw new GrowthError('NO_FREE_SLOT', `培育屋已满（${c.slots} 个槽位）`, 409);

    const sid = rules.offspringSpecies(mi, fi);
    const { rows: [sp] } = await client.query('SELECT id, name_zh, rarity FROM pokemon_species WHERE id = $1', [sid]);
    const cost = rules.breedingCost(sp.rarity);
    if (!(await spendCurrency(client, userId, 'stardust', cost.stardust))) throw new GrowthError('INSUFFICIENT_STARDUST', `星尘不足（需要 ${cost.stardust}）`, 400);
    if (useDestinyKnot && !(await consumeItem(client, userId, 'DESTINY_KNOT', 1))) throw new GrowthError('INSUFFICIENT_ITEMS', '没有命运红线', 400);

    const learnset = await learnsetOf(client, sid);
    const genes = rules.inheritGenes(m, f, { destinyKnot: !!useDestinyKnot, learnset: learnset.map((x) => x.move_id) });
    const minutes = rules.breedingMinutes(sp.rarity, [m, f]);
    const readyAt = new Date(Date.now() + minutes * 60000);
    await occupy(client, motherId, OCCUPY, readyAt);
    await occupy(client, fatherId, OCCUPY, readyAt);
    const data = { speciesId: sid, rarity: sp.rarity, genes, generation: Math.max(Number(m.generation || 0), Number(f.generation || 0)) + 1 };
    const { rows: [pr] } = await client.query(
      `INSERT INTO breeding_pairs (center_id, slot_index, parent1_pokemon_id, parent2_pokemon_id, status, started_at, ready_at, offspring_data)
       VALUES ($1, $2, $3, $4, 'breeding', NOW(), $5, $6) RETURNING *`,
      [c.id, slot, motherId, fatherId, readyAt, JSON.stringify(data)]);
    await client.query(
      `INSERT INTO breeding_stats (user_id, total_breeds, last_bred_at) VALUES ($1, 1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET total_breeds = breeding_stats.total_breeds + 1, last_bred_at = NOW(), updated_at = NOW()`, [userId]);
    return { ...presentPair(pr), offspring: { speciesId: sid, name: sp.name_zh, rarity: sp.rarity }, breedingMinutes: minutes, cost, destinyKnot: !!useDestinyKnot };
  });
}

async function lockPair(client, userId, pairId) {
  assertUuid(pairId, 'pairId');
  const { rows: [pr] } = await client.query(
    `SELECT bp.* FROM breeding_pairs bp JOIN breeding_centers bc ON bc.id = bp.center_id
      WHERE bp.id = $1 AND bc.user_id = $2 FOR UPDATE OF bp`, [pairId, userId]);
  if (!pr) throw new GrowthError('PAIR_NOT_FOUND', '培育记录不存在', 404);
  return pr;
}

async function collect(userId, pairId) {
  return transaction(async (client) => {
    const pr = await lockPair(client, userId, pairId);
    if (pr.status !== 'breeding' && pr.status !== 'ready') throw new GrowthError('ALREADY_FINISHED', '该培育已结束', 409);
    if (new Date(pr.ready_at) > new Date()) {
      throw new GrowthError('NOT_READY', `培育尚未完成（还需 ${Math.ceil((new Date(pr.ready_at) - Date.now()) / 60000)} 分钟）`, 400);
    }
    const d = pr.offspring_data;
    await release(client, pr.parent1_pokemon_id, OCCUPY);
    await release(client, pr.parent2_pokemon_id, OCCUPY);
    const { rows: [egg] } = await client.query(
      `INSERT INTO pokemon_eggs (user_id, pair_id, species_id, mother_id, father_id, gene_set, rarity, required_km, generation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, pr.id, d.speciesId, pr.parent1_pokemon_id, pr.parent2_pokemon_id, JSON.stringify(d.genes), d.rarity, rules.hatchKm(d.rarity), d.generation]);
    await client.query("UPDATE breeding_pairs SET status = 'collected', collected_at = NOW(), updated_at = NOW() WHERE id = $1", [pr.id]);
    return { pairId: pr.id, egg: { eggId: egg.id, speciesId: egg.species_id, rarity: egg.rarity, requiredKm: Number(egg.required_km) } };
  });
}

async function cancel(userId, pairId) {
  return transaction(async (client) => {
    const pr = await lockPair(client, userId, pairId);
    if (pr.status !== 'breeding' && pr.status !== 'ready') throw new GrowthError('ALREADY_FINISHED', '该培育已结束', 409);
    await client.query("UPDATE breeding_pairs SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [pr.id]);
    await release(client, pr.parent1_pokemon_id, OCCUPY);
    await release(client, pr.parent2_pokemon_id, OCCUPY);
    return { pairId: pr.id, cancelled: true, refunded: false };
  });
}

async function incubate(userId, eggId, { incubator = 'basic' } = {}) {
  assertUuid(eggId, 'eggId');
  const inc = rules.INCUBATORS[incubator];
  if (!inc) throw new GrowthError('INVALID_INCUBATOR', `未知的孵化器 ${incubator}`, 400);
  return transaction(async (client) => {
    const { rows: [egg] } = await client.query('SELECT * FROM pokemon_eggs WHERE id = $1 AND user_id = $2 FOR UPDATE', [eggId, userId]);
    if (!egg) throw new GrowthError('EGG_NOT_FOUND', '精灵蛋不存在', 404);
    if (egg.status !== 'unhatched') throw new GrowthError('ALREADY_INCUBATING', '精灵蛋已在孵化中或已孵化', 409);
    if (inc.item && !(await consumeItem(client, userId, inc.item, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `没有 ${inc.item}`, 400);
    const { rows: [u] } = await client.query('SELECT total_distance_km FROM users WHERE id = $1', [userId]);
    const { rows: [row] } = await client.query(
      `UPDATE pokemon_eggs SET status = 'incubating', incubator = $2, speed_multiplier = $3, distance_start_km = $4, incubated_at = NOW()
        WHERE id = $1 RETURNING *`, [egg.id, incubator, inc.multiplier, u.total_distance_km]);
    return { eggId: row.id, incubator, speedMultiplier: inc.multiplier, ...rules.hatchProgress(row, u.total_distance_km) };
  });
}

async function hatch(userId, eggId) {
  assertUuid(eggId, 'eggId');
  return transaction(async (client) => {
    const { rows: [egg] } = await client.query('SELECT * FROM pokemon_eggs WHERE id = $1 AND user_id = $2 FOR UPDATE', [eggId, userId]);
    if (!egg) throw new GrowthError('EGG_NOT_FOUND', '精灵蛋不存在', 404);
    if (egg.status === 'hatched') throw new GrowthError('ALREADY_HATCHED', '精灵蛋已孵化', 409);
    const { rows: [u] } = await client.query('SELECT total_distance_km FROM users WHERE id = $1', [userId]);
    const pr = rules.hatchProgress(egg, u.total_distance_km);
    if (!pr.ready) throw new GrowthError('NOT_READY', `还需行走 ${Math.max(0, Math.round((pr.requiredKm - pr.walkedKm) * 100) / 100)} km`, 400, pr);

    const g = egg.gene_set;
    const { rows: [sp] } = await client.query('SELECT * FROM pokemon_species WHERE id = $1', [egg.species_id]);
    const ivs = { attack: g.ivs.attack.value, defense: g.ivs.defense.value, hp: g.ivs.hp.value };
    const cp = baseCp(sp, ivs);
    const learnset = await learnsetOf(client, egg.species_id);
    const pick = (cat, inherited) => inherited || (learnset.filter((x) => x.category === cat).map((x) => x.move_id)[0]) || (cat === 'FAST' ? 'TACKLE' : 'STRUGGLE');
    const fast = pick('FAST', g.moves.fast.move);
    const charge = pick('CHARGE', g.moves.charge.move);
    const perfect = ivs.attack === 15 && ivs.defense === 15 && ivs.hp === 15;
    const { rows: [p] } = await client.query(
      `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny,
                                      is_perfect_iv, fast_move, charge_move, learned_fast_moves, learned_charge_moves, generation, origin)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10::text,$11::text,ARRAY[$10::text],ARRAY[$11::text],$12,'bred') RETURNING id`,
      [userId, egg.species_id, cp, Math.max(10, Math.floor(cp * 0.8)), ivs.attack, ivs.defense, ivs.hp, !!g.shiny, perfect, fast, charge, egg.generation]);
    const { rows: parents } = await client.query('SELECT id, species_id, nickname FROM pokemon_instances WHERE id = ANY($1::uuid[])', [[egg.mother_id, egg.father_id].filter(Boolean)]);
    const pm = parents.find((x) => x.id === egg.mother_id) || {};
    const pf = parents.find((x) => x.id === egg.father_id) || {};
    await client.query(
      `INSERT INTO pokemon_lineage (pokemon_id, parent1_id, parent1_species_id, parent1_nickname, parent2_id, parent2_species_id, parent2_nickname, bred_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, pm.id || null, pm.species_id || null, pm.nickname || null, pf.id || null, pf.species_id || null, pf.nickname || null, userId]);
    await client.query(
      `INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at, best_cp, has_shiny)
       VALUES ($1, $2, 1, 1, NOW(), $3, $4)
       ON CONFLICT (user_id, species_id) DO UPDATE SET caught_count = pokedex_entries.caught_count + 1,
         best_cp = GREATEST(COALESCE(pokedex_entries.best_cp, 0), EXCLUDED.best_cp), has_shiny = pokedex_entries.has_shiny OR EXCLUDED.has_shiny`,
      [userId, egg.species_id, cp, !!g.shiny]);
    await client.query(
      `INSERT INTO candy_inventory (user_id, species_id, amount) VALUES ($1, $2, 5)
       ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + EXCLUDED.amount`, [userId, egg.species_id]);
    await client.query("UPDATE pokemon_eggs SET status = 'hatched', hatched_at = NOW(), hatched_pokemon_id = $2 WHERE id = $1", [egg.id, p.id]);
    await client.query(
      `INSERT INTO breeding_stats (user_id, total_eggs_hatched, perfect_iv_breeds, shiny_breeds, last_hatched_at) VALUES ($1, 1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET total_eggs_hatched = breeding_stats.total_eggs_hatched + 1,
         perfect_iv_breeds = breeding_stats.perfect_iv_breeds + EXCLUDED.perfect_iv_breeds,
         shiny_breeds = breeding_stats.shiny_breeds + EXCLUDED.shiny_breeds, last_hatched_at = NOW(), updated_at = NOW()`,
      [userId, perfect ? 1 : 0, g.shiny ? 1 : 0]);
    return {
      pokemonId: p.id, speciesId: egg.species_id, name: sp.name_zh, cp, ivs, isShiny: !!g.shiny, generation: egg.generation,
      genes: g, moves: { fast, charge }, candy: 5,
    };
  });
}

async function lineage(userId, pokemonId, { depth = 3 } = {}) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const maxDepth = Math.min(5, Math.max(1, Number(depth) || 3));
  const node = async (id, d) => {
    const { rows: [l] } = await query(
      `SELECT l.*, s1.name_zh AS p1_name, s2.name_zh AS p2_name FROM pokemon_lineage l
         LEFT JOIN pokemon_species s1 ON s1.id = l.parent1_species_id LEFT JOIN pokemon_species s2 ON s2.id = l.parent2_species_id
        WHERE l.pokemon_id = $1 ORDER BY l.bred_at DESC LIMIT 1`, [id]);
    if (!l || d >= maxDepth) return null;
    return {
      bredAt: l.bred_at,
      mother: l.parent1_id || l.parent1_species_id ? { pokemonId: l.parent1_id, speciesId: l.parent1_species_id, name: l.parent1_nickname || l.p1_name, parents: l.parent1_id ? await node(l.parent1_id, d + 1) : null } : null,
      father: l.parent2_id || l.parent2_species_id ? { pokemonId: l.parent2_id, speciesId: l.parent2_species_id, name: l.parent2_nickname || l.p2_name, parents: l.parent2_id ? await node(l.parent2_id, d + 1) : null } : null,
    };
  };
  return { pokemonId: p.id, speciesId: Number(p.species_id), generation: Number(p.generation || 0), origin: p.origin, lineage: await node(p.id, 0) };
}

async function stats(userId) {
  const { rows: [s] } = await query('SELECT * FROM breeding_stats WHERE user_id = $1', [userId]);
  return s ? { totalBreeds: s.total_breeds, totalEggsHatched: s.total_eggs_hatched, perfectIvBreeds: s.perfect_iv_breeds, shinyBreeds: s.shiny_breeds, lastBredAt: s.last_bred_at, lastHatchedAt: s.last_hatched_at }
    : { totalBreeds: 0, totalEggsHatched: 0, perfectIvBreeds: 0, shinyBreeds: 0 };
}

async function eggs(userId) {
  return eggsOf({ query }, userId);
}

const MAX_SLOTS = 8;
/** 升级培育屋：+1 槽位，费用 5000 × (当前槽位 − 3) 金币 */
async function upgrade(userId) {
  return transaction(async (client) => {
    const c = await ensureCenter(client, userId);
    const { rows: [cur] } = await client.query('SELECT slots FROM breeding_centers WHERE id = $1 FOR UPDATE', [c.id]);
    if (cur.slots >= MAX_SLOTS) throw new GrowthError('MAX_LEVEL', '培育屋已达最大槽位', 400);
    const cost = 5000 * Math.max(1, cur.slots - 3);
    if (!(await spendCurrency(client, userId, 'coins', cost))) throw new GrowthError('INSUFFICIENT_FUNDS', `金币不足（需要 ${cost}）`, 400);
    const { rows: [u] } = await client.query('UPDATE breeding_centers SET slots = slots + 1, upgraded_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING slots', [c.id]);
    return { slots: u.slots, cost: { coins: cost } };
  });
}

module.exports = { getCenter, check, start, collect, cancel, incubate, hatch, lineage, stats, eggs, upgrade };
