// 团战（Raid）：附近查询、加入、攻击（REST 与 WebSocket 共用）、频率限制、结算、刷新
//
// 修复（W1 遗留缺陷）：
//   - 原 handleRaidAttack 读取从未写入的 raid:<id> 缓存键，所有攻击被静默丢弃 → Boss HP 以数据库 raids.boss_hp_current
//     为准，行锁内原子扣减；
//   - 原实现使用客户端上报的伤害 → 伤害由服务端按攻击者出战精灵、技能表与属性克制计算，请求体中的 damage 被忽略；
//   - 原实现不校验攻击者是否参与 → 仅 raid_participants 中的玩家可攻击（403）；
//   - 攻击频率按技能 duration_ms（团战模式冷却取两者较大值）限制：Redis SET NX PX，过快返回 429；
//   - 网关 /v1/raids/nearby 原本命中 /raids/:id（把 nearby 当 UUID，500）→ 新增附近查询（PostGIS ST_DWithin）。
'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');
const repo = require('./repo');
const energyMod = require('./energy');
const cooldown = require('./cooldown');
const { buildRaidBoss, RAID_LEVELS } = require('./stats');
const { BattleError } = require('./engine');
const { getDeps } = require('./deps');
const battleMetrics = require('./metrics');

const logger = createLogger('raid');
const JOIN_RADIUS_M = Number(process.env.RAID_JOIN_RADIUS_M || 100);
const NEARBY_MAX_M = 20000;
const LEGENDARY = [144, 145, 146, 150, 151];
const pKey = (raidId, userId) => `raid:${raidId}:p:${userId}`;
const cdKey = (raidId, userId) => `raid:${raidId}:cd:${userId}`;
const bossCache = new Map();

let broadcaster = () => {};
function setBroadcaster(fn) { broadcaster = typeof fn === 'function' ? fn : () => {}; }

/** 状态推进：到点的 PENDING → ACTIVE，超时未击败 → EXPIRED */
async function refreshStatuses() {
  await query("UPDATE raids SET status = 'ACTIVE', updated_at = NOW() WHERE status = 'PENDING' AND starts_at <= NOW() AND ends_at > NOW()");
  await query("UPDATE raids SET status = 'EXPIRED', updated_at = NOW() WHERE status IN ('PENDING','ACTIVE') AND ends_at <= NOW()");
}

function raidView(r) {
  return {
    id: r.id, gymId: r.gym_id, gymName: r.gym_name, lat: r.lat !== undefined ? Number(r.lat) : undefined, lng: r.lng !== undefined ? Number(r.lng) : undefined,
    boss: { speciesId: r.boss_species_id, name: r.boss_name, types: [r.type1, r.type2].filter(Boolean).map((t) => String(t).toLowerCase()), cp: r.boss_cp, spriteUrl: r.sprite_url },
    level: r.raid_level, status: r.status, bossHpMax: r.boss_hp_max, bossHpCurrent: r.boss_hp_current,
    startsAt: r.starts_at, endsAt: r.ends_at, maxParticipants: r.max_participants,
    participantCount: r.participant_count !== undefined ? Number(r.participant_count) : undefined,
    distanceM: r.distance_m !== undefined && r.distance_m !== null ? Math.round(Number(r.distance_m)) : undefined,
  };
}

async function nearby(lat, lng, radius) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw new BattleError('BAD_LOCATION', 'lat/lng 无效', 400);
  const r = Math.max(50, Math.min(NEARBY_MAX_M, Number(radius) || 2000));
  await refreshStatuses();
  const { rows } = await query(`
    SELECT r.id, r.gym_id, g.name AS gym_name, g.lat, g.lng, r.boss_species_id, ps.name_zh AS boss_name,
           ps.type1::text AS type1, ps.type2::text AS type2, ps.sprite_url, r.boss_cp, r.boss_hp_max, r.boss_hp_current,
           r.raid_level, r.status::text AS status, r.starts_at, r.ends_at, r.max_participants,
           (SELECT COUNT(*) FROM raid_participants rp WHERE rp.raid_id = r.id) AS participant_count,
           ST_Distance(g.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
      FROM raids r
      JOIN gyms g ON g.id = r.gym_id
      JOIN pokemon_species ps ON ps.id = r.boss_species_id
     WHERE r.status IN ('PENDING', 'ACTIVE') AND r.ends_at > NOW() AND g.is_active
       AND ST_DWithin(g.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
     ORDER BY distance_m, r.ends_at
     LIMIT 50`, [la, ln, r]);
  return { raids: rows.map(raidView), radius: r };
}

async function loadRaid(raidId) {
  if (!repo.isUuid(raidId)) throw new BattleError('INVALID_ID', 'Raid ID 无效', 400);
  const { rows: [r] } = await query(`
    SELECT r.*, r.status::text AS status, g.name AS gym_name, g.lat, g.lng, ps.name_zh AS boss_name, ps.type1::text AS type1, ps.type2::text AS type2,
           ps.sprite_url, ps.base_attack, ps.base_defense, ps.base_hp,
           (SELECT COUNT(*) FROM raid_participants rp WHERE rp.raid_id = r.id) AS participant_count
      FROM raids r JOIN gyms g ON g.id = r.gym_id JOIN pokemon_species ps ON ps.id = r.boss_species_id
     WHERE r.id = $1`, [raidId]);
  if (!r) throw new BattleError('RAID_NOT_FOUND', 'Raid 不存在', 404);
  return r;
}

async function getRaid(raidId, userId) {
  await refreshStatuses();
  const r = await loadRaid(raidId);
  const view = raidView(r);
  const { rows: [me] } = await query('SELECT damage_dealt, attacks, team_pokemon_ids, active_pokemon_id, xp_reward, stardust_reward FROM raid_participants WHERE raid_id = $1 AND user_id = $2', [raidId, userId]);
  view.me = me ? { joined: true, damageDealt: me.damage_dealt, attacks: me.attacks, team: me.team_pokemon_ids, activePokemonId: me.active_pokemon_id, rewards: me.xp_reward !== null ? { xp: me.xp_reward, stardust: me.stardust_reward } : null } : { joined: false };
  const boss = await bossFor(r);
  view.boss.moves = boss.moves.map((m) => ({ id: m.id, name: m.name, type: m.type, category: m.category }));
  view.boss.weakTo = require('./ai').weaknesses(boss.types).slice(0, 4);
  return view;
}

async function bossFor(r) {
  const key = `${r.boss_species_id}:${r.raid_level}`;
  if (bossCache.has(key)) return bossCache.get(key);
  const moves = await repo.getMoves();
  const learn = (await repo.getLearnsets([r.boss_species_id])).get(Number(r.boss_species_id)) || [];
  const boss = buildRaidBoss({ id: r.boss_species_id, name_zh: r.boss_name, type1: r.type1, type2: r.type2, base_attack: r.base_attack, base_defense: r.base_defense, base_hp: r.base_hp }, r.raid_level, moves, learn);
  bossCache.set(key, boss);
  return boss;
}

/** 参与者出战精灵快照（加入/换精灵时写入 Redis，攻击时读取，避免每次攻击查库） */
async function writeParticipantState(raidId, userId, pokemonRow, prev = null, ttlSec = 3600) {
  const [c] = await repo.toCombatants([pokemonRow]);
  const st = {
    pokemonId: c.pokemonId, combatant: c,
    energy: prev ? Math.min(c.maxEnergy, prev.energy) : 0,
    history: [], seq: prev ? prev.seq : 0, comboState: prev ? prev.comboState : { count: 0, lastTriggered: {} },
    comboMastery: prev && prev.comboMastery ? prev.comboMastery : await repo.getComboMastery(userId).catch(() => ({})),
    trainerLevel: prev && prev.trainerLevel ? prev.trainerLevel : Number((await repo.getUser(userId).catch(() => ({ level: 1 }))).level) || 1,
  };
  await getRedis().set(pKey(raidId, userId), JSON.stringify(st), 'EX', Math.max(60, ttlSec));
  return st;
}

async function join(userId, raidId, body = {}) {
  await refreshStatuses();
  const r = await loadRaid(raidId);
  if (r.status !== 'ACTIVE' || new Date(r.ends_at) <= new Date()) throw new BattleError('RAID_NOT_ACTIVE', 'Raid 未开始或已结束', 409);
  if (r.boss_hp_current <= 0) throw new BattleError('RAID_NOT_ACTIVE', 'Boss 已被击败', 409);
  await repo.assertNear(userId, r.lat, r.lng, JOIN_RADIUS_M, '团战道馆');

  let rows;
  if (Array.isArray(body.pokemonIds) && body.pokemonIds.length) {
    const ids = body.pokemonIds;
    if (ids.length > 6 || !ids.every(repo.isUuid) || new Set(ids).size !== ids.length) throw new BattleError('BAD_TEAM', '请选择 1-6 只不重复的精灵', 400);
    rows = await repo.getOwnedPokemon(userId, ids);
    if (rows.length !== ids.length) throw new BattleError('POKEMON_UNAVAILABLE', '部分精灵不存在或不属于你', 400);
    if (rows.some((x) => x.defending_gym_id)) throw new BattleError('POKEMON_DEFENDING', '驻守道馆中的精灵不能出战', 400);
  } else {
    rows = await repo.getTopPokemon(userId, 6);
    if (!rows.length) throw new BattleError('NO_POKEMON', '没有可出战的精灵', 400);
  }
  const teamIds = rows.map((x) => x.id);

  const joined = await transaction(async (client) => {
    const { rows: [lock] } = await client.query('SELECT max_participants FROM raids WHERE id = $1 FOR UPDATE', [raidId]);
    const { rows: [mine] } = await client.query('SELECT id FROM raid_participants WHERE raid_id = $1 AND user_id = $2', [raidId, userId]);
    if (!mine) {
      const { rows: [cnt] } = await client.query('SELECT COUNT(*)::int AS n FROM raid_participants WHERE raid_id = $1', [raidId]);
      if (cnt.n >= lock.max_participants) throw new BattleError('RAID_FULL', 'Raid 人数已满', 400);
    }
    await client.query(`INSERT INTO raid_participants (raid_id, user_id, team_pokemon_ids, active_pokemon_id)
        VALUES ($1,$2,$3::uuid[],$4)
        ON CONFLICT (raid_id, user_id) DO UPDATE SET team_pokemon_ids = EXCLUDED.team_pokemon_ids, active_pokemon_id = EXCLUDED.active_pokemon_id`,
    [raidId, userId, teamIds, teamIds[0]]);
    return !mine;
  });
  const ttl = Math.floor((new Date(r.ends_at).getTime() - Date.now()) / 1000) + 600;
  await writeParticipantState(raidId, userId, rows[0], null, ttl);
  broadcaster(raidId, { type: 'PLAYER_JOINED', userId, participants: Number(r.participant_count) + (joined ? 1 : 0) });
  const boss = await bossFor(r);
  return {
    raidId, joined, bossSpeciesId: r.boss_species_id, bossName: r.boss_name, bossHpMax: r.boss_hp_max, bossHpCurrent: r.boss_hp_current,
    raidLevel: r.raid_level, endsAt: r.ends_at, ballsGranted: 6,
    team: rows.map((x) => ({ pokemonId: x.id, name: x.nickname || x.name_zh, cp: x.cp })),
    activePokemonId: teamIds[0],
    bossWeakTo: require('./ai').weaknesses(boss.types).slice(0, 4),
  };
}

async function participantState(raidId, userId) {
  const raw = await getRedis().get(pKey(raidId, userId));
  return raw ? JSON.parse(raw) : null;
}

async function switchPokemon(userId, raidId, pokemonId) {
  if (!repo.isUuid(raidId) || !repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', 'ID 无效', 400);
  const { rows: [p] } = await query('SELECT team_pokemon_ids FROM raid_participants WHERE raid_id = $1 AND user_id = $2', [raidId, userId]);
  if (!p) throw new BattleError('NOT_PARTICIPANT', '你没有参加这场 Raid', 403);
  if (!(p.team_pokemon_ids || []).includes(pokemonId)) throw new BattleError('NOT_IN_TEAM', '该精灵不在你的团战队伍中', 400);
  const rows = await repo.getOwnedPokemon(userId, [pokemonId]);
  if (!rows.length) throw new BattleError('POKEMON_UNAVAILABLE', '精灵不可用', 400);
  await query('UPDATE raid_participants SET active_pokemon_id = $3 WHERE raid_id = $1 AND user_id = $2', [raidId, userId, pokemonId]);
  const prev = await participantState(raidId, userId);
  const st = await writeParticipantState(raidId, userId, rows[0], prev);
  return { activePokemonId: pokemonId, energy: st.energy };
}

/**
 * 攻击 Boss。客户端只能指定技能（及可选的队内精灵），伤害一律服务端计算。
 * @returns {{damage, bossHpRemaining, ...}}
 */
async function attack(userId, raidId, { moveId, pokemonId } = {}) {
  if (!repo.isUuid(raidId)) throw new BattleError('INVALID_ID', 'Raid ID 无效', 400);
  const { rows: [p] } = await query(`
    SELECT rp.id, rp.team_pokemon_ids, rp.active_pokemon_id, r.status::text AS status, r.ends_at, r.boss_hp_current, r.raid_level, r.boss_species_id,
           ps.name_zh AS boss_name, ps.type1::text AS type1, ps.type2::text AS type2, ps.base_attack, ps.base_defense, ps.base_hp
      FROM raid_participants rp JOIN raids r ON r.id = rp.raid_id JOIN pokemon_species ps ON ps.id = r.boss_species_id
     WHERE rp.raid_id = $1 AND rp.user_id = $2`, [raidId, userId]);
  if (!p) {
    battleMetrics.raidAttacks.inc({ result: 'not_participant' });
    throw new BattleError('NOT_PARTICIPANT', '只有参加 Raid 的玩家才能攻击', 403);
  }
  if (p.status !== 'ACTIVE' || new Date(p.ends_at) <= new Date() || p.boss_hp_current <= 0) {
    battleMetrics.raidAttacks.inc({ result: 'inactive' });
    throw new BattleError('RAID_NOT_ACTIVE', 'Raid 未在进行中', 409);
  }
  if (pokemonId && pokemonId !== p.active_pokemon_id) await switchPokemon(userId, raidId, pokemonId);
  let st = await participantState(raidId, userId);
  if (!st || (p.active_pokemon_id && st.pokemonId !== (pokemonId || p.active_pokemon_id))) {
    const rows = await repo.getOwnedPokemon(userId, [pokemonId || p.active_pokemon_id || (p.team_pokemon_ids || [])[0]].filter(Boolean));
    if (!rows.length) throw new BattleError('POKEMON_UNAVAILABLE', '出战精灵不可用', 400);
    st = await writeParticipantState(raidId, userId, rows[0], st);
  }
  const att = st.combatant;
  att.energy = st.energy;
  const move = att.moves.find((m) => m.id === moveId);
  if (!move) {
    battleMetrics.raidAttacks.inc({ result: 'invalid_move' });
    throw new BattleError('INVALID_MOVE', '出战精灵没有这个技能', 400);
  }
  if (move.category === 'CHARGE' && att.energy < move.energyCost) {
    battleMetrics.cooldownRejects.inc({ reason: 'INSUFFICIENT_ENERGY', mode: 'RAID' });
    throw new BattleError('INSUFFICIENT_ENERGY', `能量不足（需要 ${move.energyCost}，当前 ${att.energy}）`, 400, { need: move.energyCost, have: att.energy });
  }

  // 频率限制：上一次技能的出手时长 / 冷却结束前不能再次攻击（多实例共享，原子占位）
  const cd = cooldown.effectiveCooldown(move, { mode: 'RAID', mastery: (att.mastery || {})[move.id], speed: att.speed, equipment: att.equipment });
  const intervalMs = Math.max(move.durationMs || 500, cd.effectiveMs);
  const r = getRedis();
  const ok = await r.set(cdKey(raidId, userId), moveId, 'PX', intervalMs, 'NX');
  if (!ok) {
    const left = await r.pttl(cdKey(raidId, userId));
    battleMetrics.raidAttacks.inc({ result: 'rate_limited' });
    battleMetrics.cooldownRejects.inc({ reason: 'RATE_LIMIT', mode: 'RAID' });
    throw new BattleError('ATTACK_TOO_FAST', '攻击过快，请等待技能动作结束', 429, { retryAfterMs: Math.max(0, left) });
  }

  const deps = await getDeps();
  const boss = await bossFor({ ...p, boss_species_id: p.boss_species_id });
  const now = Date.now();
  const combo = deps.combos.detect(st.history, move.id, { now, seq: st.seq, attackerTypes: att.types, trainerLevel: st.trainerLevel || 1, lastTriggered: st.comboState.lastTriggered, masteryCounts: st.comboMastery || {} });
  const dmg = deps.damage.compute(att, boss, move, {
    rng: Math.random, weather: process.env.BATTLE_WEATHER || null,
    multiplier: combo ? combo.multiplier : 1, critBoostPct: combo ? combo.effects.critBoostPct : 0, ignoreDefensePct: combo ? combo.effects.ignoreDefensePct : 0,
  });

  const { rows: [upd] } = await query(`
    WITH prev AS (SELECT id, boss_hp_current FROM raids WHERE id = $1 AND status = 'ACTIVE' AND ends_at > NOW() AND boss_hp_current > 0 FOR UPDATE)
    UPDATE raids r SET boss_hp_current = GREATEST(0, prev.boss_hp_current - $2), updated_at = NOW()
      FROM prev WHERE r.id = prev.id
    RETURNING r.boss_hp_current AS hp, r.boss_hp_max AS hp_max, prev.boss_hp_current AS before`, [raidId, dmg.damage]);
  if (!upd) {
    await r.del(cdKey(raidId, userId));
    throw new BattleError('RAID_NOT_ACTIVE', 'Boss 已被击败或 Raid 已结束', 409);
  }
  const dealt = upd.before - upd.hp;
  await query('UPDATE raid_participants SET damage_dealt = damage_dealt + $3, attacks = attacks + 1, last_attack_at = NOW() WHERE raid_id = $1 AND user_id = $2', [raidId, userId, dealt]);

  // 能量与连击状态
  energyMod.applyMoveEnergy(att, move);
  st.energy = att.energy;
  if (combo) {
    st.comboState.count += 1;
    st.comboState.lastTriggered[combo.chain.chainId] = st.seq;
    st.history = [];
    if (combo.effects.energyRefund) st.energy = Math.min(att.maxEnergy, st.energy + combo.effects.energyRefund);
    await query(`INSERT INTO combo_records (user_id, chain_id, pokemon_id, battle_type, quality, damage_dealt, combo_points_earned, battle_id)
       VALUES ($1,$2,$3,'raid',$4,$5,$6,$7)`, [userId, combo.chain.chainId, att.pokemonId, combo.quality, dealt, combo.chain.comboPoints, raidId]).catch(() => {});
    battleMetrics.combosTriggered.inc({ chain: combo.chain.chainId, quality: combo.quality, mode: 'RAID' });
  } else {
    st.history.push({ moveId: move.id, at: now, seq: st.seq });
    if (st.history.length > 8) st.history.shift();
  }
  st.seq += 1;
  await r.set(pKey(raidId, userId), JSON.stringify({ ...st, combatant: { ...att, energy: st.energy } }), 'KEEPTTL');
  battleMetrics.raidAttacks.inc({ result: 'hit' });

  const defeated = upd.hp <= 0;
  const out = {
    raidId, attackerId: userId, pokemonId: att.pokemonId, moveId: move.id, moveName: move.name, damage: dealt,
    rawDamage: dmg.damage, effectiveness: dmg.effectiveness, effectivenessText: dmg.effectivenessText, isCritical: dmg.isCrit,
    bossHpRemaining: upd.hp, bossHpMax: upd.hp_max, energy: st.energy, nextAttackInMs: intervalMs,
    combo: combo ? { chainId: combo.chain.chainId, name: combo.chain.name, quality: combo.quality, multiplier: combo.multiplier } : null,
    bossDefeated: defeated,
  };
  broadcaster(raidId, { type: 'RAID_ATTACK', attackerId: userId, damage: dealt, moveId: move.id, isCritical: dmg.isCrit, combo: out.combo, bossHpRemaining: upd.hp, bossDefeated: defeated });
  if (defeated) {
    out.settlement = await settle(raidId);
    broadcaster(raidId, { type: 'RAID_COMPLETED', raidId, rewards: out.settlement && out.settlement.participants });
  }
  return out;
}

/** 击败 Boss 后结算（幂等：只有把状态从 ACTIVE 改为 COMPLETED 的那次调用发奖） */
async function settle(raidId) {
  return transaction(async (client) => {
    const { rows: [r] } = await client.query(`UPDATE raids SET status = 'COMPLETED', completed_at = NOW(), settled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'ACTIVE' AND boss_hp_current = 0 RETURNING raid_level, boss_hp_max`, [raidId]);
    if (!r) return null;
    const lv = RAID_LEVELS[r.raid_level] || RAID_LEVELS[1];
    const { rows: ps } = await client.query('SELECT user_id, damage_dealt, attacks FROM raid_participants WHERE raid_id = $1 FOR UPDATE', [raidId]);
    const participants = [];
    for (const x of ps) {
      if (!(x.attacks > 0)) continue; // 只加入不出手的玩家不发奖
      const share = Math.min(1, x.damage_dealt / Math.max(1, r.boss_hp_max));
      const xp = lv.xp + Math.floor(lv.xp * 0.5 * share);
      const stardust = lv.stardust + Math.floor(lv.stardust * 0.5 * share);
      await client.query('UPDATE raid_participants SET xp_reward = $3, stardust_reward = $4, rewarded_at = NOW() WHERE raid_id = $1 AND user_id = $2', [raidId, x.user_id, xp, stardust]);
      await client.query('UPDATE users SET xp = xp + $2, stardust = stardust + $3, updated_at = NOW() WHERE id = $1', [x.user_id, xp, stardust]);
      participants.push({ userId: x.user_id, damage: x.damage_dealt, share: Number(share.toFixed(3)), xp, stardust });
    }
    logger.info({ raidId, participants: participants.length }, 'raid settled');
    return { raidId, level: r.raid_level, participants: participants.sort((a, b) => b.damage - a.damage) };
  });
}

async function result(raidId, userId) {
  const r = await loadRaid(raidId);
  const { rows } = await query(`SELECT rp.user_id, u.nickname, rp.damage_dealt, rp.attacks, rp.xp_reward, rp.stardust_reward
      FROM raid_participants rp JOIN users u ON u.id = rp.user_id WHERE rp.raid_id = $1 ORDER BY rp.damage_dealt DESC`, [raidId]);
  return {
    raid: raidView(r),
    participants: rows.map((x, i) => ({ rank: i + 1, userId: x.user_id, nickname: x.nickname, damage: x.damage_dealt, attacks: x.attacks, rewards: x.xp_reward !== null ? { xp: x.xp_reward, stardust: x.stardust_reward } : null, me: x.user_id === userId })),
  };
}

function pickLevel() {
  const x = crypto.randomInt(0, 100);
  return x < 40 ? 1 : x < 65 ? 2 : x < 85 ? 3 : x < 95 ? 4 : 5;
}

async function pickBossSpecies(level) {
  let sql;
  if (level >= 5) sql = `SELECT id FROM pokemon_species WHERE id = ANY($1::int[]) ORDER BY random() LIMIT 1`;
  else if (level >= 3) sql = `SELECT id FROM pokemon_species WHERE evolves_to IS NULL AND NOT (id = ANY($1::int[])) ORDER BY random() LIMIT 1`;
  else sql = `SELECT id FROM pokemon_species WHERE evolves_to IS NOT NULL AND NOT (id = ANY($1::int[])) ORDER BY random() LIMIT 1`;
  const { rows: [s] } = await query(sql, [LEGENDARY]);
  if (s) return s.id;
  const { rows: [any] } = await query('SELECT id FROM pokemon_species ORDER BY random() LIMIT 1');
  return any && any.id;
}

/**
 * 生成团战（管理员接口 / 自动刷新共用）。同一道馆同时只能有一场未结束的 Raid。
 */
async function spawn({ gymId, speciesId, level, startsInMin = 0, durationMin } = {}) {
  if (!repo.isUuid(gymId)) throw new BattleError('INVALID_ID', '道馆 ID 无效', 400);
  const lvl = Math.max(1, Math.min(5, Number(level) || pickLevel()));
  const sid = Number(speciesId) || await pickBossSpecies(lvl);
  const { rows: [sp] } = await query('SELECT id, name_zh, type1::text AS type1, type2::text AS type2, base_attack, base_defense, base_hp FROM pokemon_species WHERE id = $1', [sid]);
  if (!sp) throw new BattleError('SPECIES_NOT_FOUND', 'Boss 精灵不存在', 400);
  const lv = RAID_LEVELS[lvl];
  const boss = buildRaidBoss(sp, lvl, await repo.getMoves());
  const minutes = Math.max(5, Math.min(180, Number(durationMin) || lv.minutes));
  const startIn = Math.max(0, Math.min(60, Number(startsInMin) || 0));
  await refreshStatuses();
  const { rows: [raid] } = await query(`
    INSERT INTO raids (gym_id, boss_species_id, boss_cp, boss_hp_max, boss_hp_current, raid_level, status, starts_at, ends_at)
    SELECT $1, $2, $3, $4, $4, $5, CASE WHEN $6::int = 0 THEN 'ACTIVE'::raid_status_enum ELSE 'PENDING'::raid_status_enum END,
           NOW() + make_interval(mins => $6::int), NOW() + make_interval(mins => $6::int + $7::int)
     WHERE EXISTS (SELECT 1 FROM gyms WHERE id = $1 AND is_active)
       AND NOT EXISTS (SELECT 1 FROM raids WHERE gym_id = $1 AND status IN ('PENDING','ACTIVE') AND ends_at > NOW())
    RETURNING id, status::text AS status, starts_at, ends_at`, [gymId, sid, boss.cp, lv.hp, lvl, startIn, minutes]);
  if (!raid) throw new BattleError('RAID_EXISTS', '道馆不存在或已有进行中的 Raid', 409);
  return { raidId: raid.id, gymId, bossSpeciesId: sid, bossName: sp.name_zh, level: lvl, bossCp: boss.cp, bossHp: lv.hp, status: raid.status, startsAt: raid.starts_at, endsAt: raid.ends_at };
}

let spawnTimer = null;
/** 自动刷新：每隔一段时间为没有团战的活跃道馆按概率生成 Raid（RAID_AUTO_SPAWN=false 关闭） */
function startScheduler() {
  if (spawnTimer || process.env.RAID_AUTO_SPAWN === 'false') return;
  const interval = Number(process.env.RAID_SPAWN_INTERVAL_MS || 10 * 60 * 1000);
  const chance = Number(process.env.RAID_SPAWN_CHANCE || 0.15);
  spawnTimer = setInterval(async () => {
    try {
      await refreshStatuses();
      const { rows } = await query(`SELECT g.id FROM gyms g WHERE g.is_active
          AND NOT EXISTS (SELECT 1 FROM raids r WHERE r.gym_id = g.id AND r.status IN ('PENDING','ACTIVE') AND r.ends_at > NOW())
          ORDER BY random() LIMIT 200`);
      for (const g of rows) {
        if (Math.random() < chance) await spawn({ gymId: g.id, startsInMin: crypto.randomInt(0, 10) }).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err }, 'raid scheduler tick failed');
    }
  }, interval);
  spawnTimer.unref();
}

module.exports = { nearby, getRaid, join, attack, switchPokemon, settle, result, spawn, startScheduler, refreshStatuses, setBroadcaster, participantState, JOIN_RADIUS_M };
