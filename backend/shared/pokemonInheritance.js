/**
 * 捕捉时自动应用传承池加成（REQ-00361，在调用方事务 client 中执行；catch-service 使用）
 * 规则见 shared/inheritanceRules.js
 */
'use strict';

const rules = require('./inheritanceRules');
const { baseCp } = require('./pokemonStats');

/**
 * @returns {Promise<null|object>} 应用了的加成；没有有效传承池（或加成全为 0）时返回 null
 */
async function applyInheritanceOnCatch(client, { userId, pokemonId }) {
  const { rows: [p] } = await client.query(
    `SELECT pi.id, pi.species_id, pi.cp, pi.hp_max, pi.iv_attack, pi.iv_defense, pi.iv_hp,
            ps.base_attack, ps.base_defense, ps.base_hp, pokemon_family_root(pi.species_id) AS root
       FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1 AND pi.user_id = $2 FOR UPDATE OF pi`, [pokemonId, userId]);
  if (!p) return null;
  const { rows: [pool] } = await client.query(
    `SELECT * FROM pokemon_inheritance_pool WHERE user_id = $1 AND species_id = $2 AND expires_at > NOW() FOR UPDATE`,
    [userId, p.root]);
  if (!pool) return null;
  const bonus = rules.inheritanceBonus(pool);
  if (!bonus.ivAttack && !bonus.ivDefense && !bonus.ivHp && !bonus.cpBonus) return null;

  const before = { attack: p.iv_attack, defense: p.iv_defense, hp: p.iv_hp };
  const after = rules.applyBonus(before, bonus);
  const ratio = baseCp(p, after) / baseCp(p, before);
  const cp = Math.max(10, Math.round(Number(p.cp) * ratio) + bonus.cpBonus);
  const hpMax = Math.max(10, Math.round(Number(p.hp_max) * ratio));
  await client.query(
    `UPDATE pokemon_instances SET iv_attack = $2, iv_defense = $3, iv_hp = $4, cp = $5, hp_max = $6, hp_current = $6,
            is_perfect_iv = ($2 = 15 AND $3 = 15 AND $4 = 15), updated_at = NOW() WHERE id = $1`,
    [p.id, after.attack, after.defense, after.hp, cp, hpMax]);
  await client.query('UPDATE pokemon_inheritance_pool SET inheritance_count = inheritance_count + 1, last_used_at = NOW() WHERE id = $1', [pool.id]);
  await client.query(
    `INSERT INTO pokemon_inheritance_records (user_id, pool_id, source_pokemon_id, target_pokemon_id, species_id,
                                              inherited_iv_attack, inherited_iv_defense, inherited_iv_hp, inherited_cp_bonus, rate, inheritance_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [userId, pool.id, pool.source_pokemon_id, p.id, p.root, after.attack - before.attack, after.defense - before.defense,
      after.hp - before.hp, bonus.cpBonus, bonus.rate, pool.inheritance_type]);
  return { poolId: pool.id, rate: bonus.rate, decay: bonus.decay, ivBefore: before, ivAfter: after, cpBonus: bonus.cpBonus, cpBefore: Number(p.cp), cpAfter: cp };
}

module.exports = { applyInheritanceOnCatch };
