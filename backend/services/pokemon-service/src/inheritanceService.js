/**
 * 精灵传承服务（REQ-00361）
 *
 *   放生并传承：锁精灵（空闲、非收藏、未锁定）→ 可选消耗传承石 → 软删除（is_released，背包计数触发器同步）→
 *     返还 1 颗家族糖果 + 100 星尘 → 按家族根物种写入/合并传承池（有效期重置 30 天）
 *   捕捉时自动继承在 catch-service 里调用 shared/pokemonInheritance（同一套规则 shared/inheritanceRules）
 *   传承池查询（含衰减后的当前加成预览）、传承记录、统计、对已有传承池使用传承石、过期清理
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem } = require('../../../shared/inventory');
const rules = require('../../../shared/inheritanceRules');
const { GrowthError, lockOwnedPokemon, assertIdle, addCandy } = require('./growth/common');

const RELEASE_REWARD = { candy: 1, stardust: 100 };

function presentPool(p, now = new Date()) {
  const bonus = rules.inheritanceBonus(p, now);
  return {
    poolId: p.id, speciesId: p.species_id, speciesName: p.species_name || null,
    sourcePokemonId: p.source_pokemon_id, sourceNickname: p.source_nickname,
    pool: { ivAttack: Number(p.iv_attack_bonus), ivDefense: Number(p.iv_defense_bonus), ivHp: Number(p.iv_hp_bonus), cpBonus: p.cp_base_bonus },
    inheritanceRate: Number(p.inheritance_rate), inheritanceType: p.inheritance_type, itemUsed: p.item_used,
    inheritanceCount: p.inheritance_count, sourceFriendshipLevel: p.source_friendship_level, sourceLevel: p.source_level,
    createdAt: p.created_at, refreshedAt: p.refreshed_at, expiresAt: p.expires_at,
    expired: new Date(p.expires_at) <= now,
    currentBonus: bonus,
  };
}

async function releaseWithInheritance(pokemonId, userId, { inherit = true, inheritanceItem } = {}) {
  if (inheritanceItem && !rules.STONES[inheritanceItem]) throw new GrowthError('INVALID_ITEM', `不是传承道具：${inheritanceItem}`, 400);
  if (inheritanceItem && !inherit) throw new GrowthError('INVALID_PARAM', '不传承时不能使用传承石', 400);
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    assertIdle(p, '放生');
    if (p.is_favorite || p.is_favorited) throw new GrowthError('POKEMON_FAVORITE', '收藏的精灵不能放生', 400);
    if (p.is_locked) throw new GrowthError('POKEMON_LOCKED', '已锁定的精灵不能放生', 400);
    if (inheritanceItem && !(await consumeItem(client, userId, inheritanceItem, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `没有 ${inheritanceItem}`, 400);

    await client.query('UPDATE pokemon_instances SET is_released = TRUE, released_at = NOW(), updated_at = NOW() WHERE id = $1', [p.id]);
    await addCandy(client, userId, p.species_id, RELEASE_REWARD.candy);
    await client.query('UPDATE users SET stardust = stardust + $2 WHERE id = $1', [userId, RELEASE_REWARD.stardust]);

    let pool = null;
    if (inherit) {
      const { rows: [r] } = await client.query('SELECT pokemon_family_root($1) AS root', [p.species_id]);
      const { rows: [old] } = await client.query(
        'SELECT * FROM pokemon_inheritance_pool WHERE user_id = $1 AND species_id = $2 AND expires_at > NOW() FOR UPDATE', [userId, r.root]);
      const merged = rules.mergePool(old, rules.poolFromPokemon(p, inheritanceItem));
      const { rows: [row] } = await client.query(
        `INSERT INTO pokemon_inheritance_pool (user_id, species_id, source_pokemon_id, source_nickname, iv_attack_bonus, iv_defense_bonus,
                                               iv_hp_bonus, cp_base_bonus, inheritance_rate, inheritance_type, item_used,
                                               source_level, source_friendship_level, refreshed_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(), NOW() + make_interval(days => $14))
         ON CONFLICT (user_id, species_id) DO UPDATE SET
           source_pokemon_id = EXCLUDED.source_pokemon_id, source_nickname = EXCLUDED.source_nickname,
           iv_attack_bonus = EXCLUDED.iv_attack_bonus, iv_defense_bonus = EXCLUDED.iv_defense_bonus, iv_hp_bonus = EXCLUDED.iv_hp_bonus,
           cp_base_bonus = EXCLUDED.cp_base_bonus, inheritance_rate = EXCLUDED.inheritance_rate, inheritance_type = EXCLUDED.inheritance_type,
           item_used = CASE WHEN pokemon_inheritance_pool.expires_at > NOW()
                            THEN COALESCE(EXCLUDED.item_used, pokemon_inheritance_pool.item_used) ELSE EXCLUDED.item_used END,
           source_level = EXCLUDED.source_level, source_friendship_level = EXCLUDED.source_friendship_level,
           inheritance_count = CASE WHEN pokemon_inheritance_pool.expires_at > NOW() THEN pokemon_inheritance_pool.inheritance_count ELSE 0 END,
           refreshed_at = NOW(), expires_at = EXCLUDED.expires_at
         RETURNING *`,
        [userId, r.root, p.id, p.nickname || p.species_name, merged.iv_attack_bonus, merged.iv_defense_bonus, merged.iv_hp_bonus,
          merged.cp_base_bonus, merged.inheritance_rate, merged.inheritance_type, inheritanceItem || null,
          merged.source_level, merged.source_friendship_level, rules.POOL_DAYS]);
      pool = presentPool(row);
    }
    return { released: true, pokemonId: p.id, rewards: { ...RELEASE_REWARD }, inherited: !!inherit, pool };
  });
}

async function pools(userId) {
  const { rows } = await query(
    `SELECT p.*, s.name_zh AS species_name FROM pokemon_inheritance_pool p JOIN pokemon_species s ON s.id = p.species_id
      WHERE p.user_id = $1 AND p.expires_at > NOW() ORDER BY p.expires_at`, [userId]);
  return rows.map((r) => presentPool(r));
}

async function poolFor(userId, speciesId) {
  const sid = Number(speciesId);
  if (!Number.isInteger(sid) || sid <= 0) throw new GrowthError('INVALID_SPECIES', '无效的物种 ID', 400);
  const { rows: [p] } = await query(
    `SELECT p.*, s.name_zh AS species_name FROM pokemon_inheritance_pool p JOIN pokemon_species s ON s.id = p.species_id
      WHERE p.user_id = $1 AND p.species_id = pokemon_family_root($2)`, [userId, sid]);
  if (!p) throw new GrowthError('POOL_NOT_FOUND', '该物种没有传承池', 404);
  return presentPool(p);
}

async function records(userId, { limit = 20, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const { rows } = await query(
    `SELECT r.id, r.pool_id AS "poolId", r.source_pokemon_id AS "sourcePokemonId", r.target_pokemon_id AS "targetPokemonId",
            r.species_id AS "speciesId", s.name_zh AS "speciesName", r.inherited_iv_attack AS "ivAttack", r.inherited_iv_defense AS "ivDefense",
            r.inherited_iv_hp AS "ivHp", r.inherited_cp_bonus AS "cpBonus", r.rate::float AS rate, r.inheritance_type AS type, r.created_at AS "createdAt"
       FROM pokemon_inheritance_records r LEFT JOIN pokemon_species s ON s.id = r.species_id
      WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [userId, lim, Math.max(0, Number(offset) || 0)]);
  return { items: rows, limit: lim };
}

async function stats(userId) {
  const { rows: [s] } = await query(
    `SELECT (SELECT COUNT(*)::int FROM pokemon_inheritance_pool WHERE user_id = $1 AND expires_at > NOW()) AS "activePools",
            COUNT(r.id)::int AS "totalInheritances",
            COALESCE(SUM(r.inherited_iv_attack + r.inherited_iv_defense + r.inherited_iv_hp), 0)::int AS "totalIvInherited",
            COALESCE(SUM(r.inherited_cp_bonus), 0)::int AS "totalCpInherited",
            COUNT(*) FILTER (WHERE r.inheritance_type = 'perfect')::int AS "perfectInheritances"
       FROM pokemon_inheritance_records r WHERE r.user_id = $1`, [userId]);
  return s;
}

/** 对已有传承池使用传承石：提高传承率（完美传承石 = 100%），每个池只能用一次 */
async function useItem(userId, { speciesId, itemId }) {
  const stone = rules.STONES[itemId];
  if (!stone) throw new GrowthError('INVALID_ITEM', `不是传承道具：${itemId}`, 400);
  return transaction(async (client) => {
    const { rows: [p] } = await client.query(
      `SELECT * FROM pokemon_inheritance_pool WHERE user_id = $1 AND species_id = pokemon_family_root($2) AND expires_at > NOW() FOR UPDATE`,
      [userId, Number(speciesId)]);
    if (!p) throw new GrowthError('POOL_NOT_FOUND', '该物种没有有效的传承池', 404);
    if (p.item_used) throw new GrowthError('ITEM_ALREADY_USED', `该传承池已使用过 ${p.item_used}`, 409);
    if (!(await consumeItem(client, userId, itemId, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `没有 ${itemId}`, 400);
    const rate = stone.perfect ? 1 : Math.min(rules.MAX_RATE, Number(p.inheritance_rate) + stone.bonus);
    const { rows: [row] } = await client.query(
      `UPDATE pokemon_inheritance_pool SET inheritance_rate = GREATEST(inheritance_rate, $2), inheritance_type = $3, item_used = $4
        WHERE id = $1 RETURNING *`, [p.id, rate, stone.type, itemId]);
    return presentPool(row);
  });
}

/** 过期传承池清理（定时任务） */
async function purgeExpired() {
  const { rowCount } = await query("DELETE FROM pokemon_inheritance_pool WHERE expires_at < NOW() - INTERVAL '1 day'");
  return rowCount;
}

module.exports = { releaseWithInheritance, pools, poolFor, records, stats, useItem, purgeExpired, RELEASE_REWARD };
