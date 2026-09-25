/**
 * 精灵专项特训服务（REQ-00612）
 *
 * 六项训练属性（攻击/防御/速度/暴击/闪避/能量）、训练场地（按训练师等级解锁、对口属性加成、按小时收金币）、
 * 训练道具（player_inventory）、并行训练队列（VIP 扩容）、每日次数、训练后冷却、技能熟练度（威力/命中/暴击/特效）、
 * 训练成就（达成即发放奖励）。开始特训时消耗道具 + 家族糖果 + 金币 + 体力，精灵被占用（不能战斗/进化）。
 * 规则见 growth/specialTrainingRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem, addItems } = require('../../../shared/inventory');
const { gameDate } = require('../../../shared/gameTime');
const rules = require('./growth/specialTrainingRules');
const { consumeStamina } = require('./staminaService');
const {
  GrowthError, lockOwnedPokemon, assertIdle, assertUuid, occupy, release, spendCurrency, spendCandy, addCandy,
} = require('./growth/common');

const OCCUPY = 'special_training';

async function attributeLevels(db, pokemonId) {
  const { rows } = await db.query('SELECT attribute, points FROM pokemon_training_attributes WHERE pokemon_instance_id = $1', [pokemonId]);
  const points = Object.fromEntries(rows.map((r) => [r.attribute, Number(r.points)]));
  const levels = Object.fromEntries(Object.keys(rules.ATTRIBUTES).map((a) => [a, rules.levelOf(a, points[a] || 0)]));
  return { points, levels };
}

function presentTraining(t, now = new Date()) {
  if (!t) return null;
  const remain = Math.max(0, Math.ceil((new Date(t.ends_at) - now) / 1000));
  return {
    trainingId: t.id, pokemonId: t.pokemon_id, attribute: t.attribute, facilityId: t.facility_id, status: t.status,
    startedAt: t.started_at, endsAt: t.ends_at, remainingSeconds: t.status === 'training' ? remain : 0,
    ready: t.status === 'training' && remain === 0, expectedPoints: t.expected_points, successRate: Number(t.success_rate),
    pointsGained: t.points_gained, success: t.success, cost: t.cost,
  };
}

async function status(pokemonId, userId) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const { points, levels } = await attributeLevels({ query }, pokemonId);
  const { rows: mastery } = await query(
    `SELECT move_id, power, accuracy, critical_chance, mastery_exp, unlocked_effects FROM pokemon_skill_mastery
      WHERE pokemon_instance_id = $1 ORDER BY move_id`, [pokemonId]);
  const { rows: sessions } = await query(
    `SELECT * FROM special_training_sessions WHERE pokemon_id = $1 ORDER BY started_at DESC LIMIT 10`, [pokemonId]);
  const current = sessions.find((s) => s.status === 'training');
  return {
    pokemonId: p.id,
    attributes: Object.fromEntries(Object.entries(rules.ATTRIBUTES).map(([k, a]) => [k, {
      name: a.name, level: levels[k], maxLevel: a.maxLevel, points: points[k] || 0,
      nextLevelPoints: levels[k] < a.maxLevel ? (levels[k] + 1) * rules.POINTS_PER_LEVEL : null,
      effect: `${a.effect}+${Math.round(levels[k] * a.perLevel * 1000) / 1000}`,
    }])),
    bonuses: rules.attributeBonuses(levels),
    skillMastery: mastery.map((m) => ({ moveId: m.move_id, power: m.power, accuracy: m.accuracy, criticalChance: m.critical_chance,
      masteryExp: m.mastery_exp, bonuses: rules.masteryBonuses(m) })),
    currentTraining: presentTraining(current),
    trainingHistory: sessions.filter((s) => s.status !== 'training').map((s) => presentTraining(s)),
  };
}

async function facilities(userId) {
  const { rows: [u] } = await query('SELECT level FROM users WHERE id = $1', [userId]);
  const { rows: unlocked } = await query('SELECT facility_id, unlocked_at FROM user_training_facilities WHERE user_id = $1', [userId]);
  const byId = new Map(unlocked.map((r) => [r.facility_id, r.unlocked_at]));
  return Object.entries(rules.FACILITIES).map(([id, f]) => ({
    facilityId: id, name: f.name, boostAttribute: f.boostAttribute, multiplier: f.multiplier, costPerHour: { coins: f.coinsPerHour },
    unlockRequirement: { trainerLevel: f.trainerLevel }, unlocked: (u ? u.level : 1) >= f.trainerLevel, firstUsedAt: byId.get(id) || null,
  }));
}

async function start(pokemonId, userId, body = {}) {
  assertUuid(pokemonId);
  const attribute = String(body.trainingType || body.attribute || '');
  if (!rules.ATTRIBUTES[attribute]) throw new GrowthError('INVALID_ATTRIBUTE', `未知的训练属性 ${attribute}`, 400);
  const facilityId = body.facilityId || 'basic';
  if (!rules.FACILITIES[facilityId]) throw new GrowthError('INVALID_FACILITY', `未知的训练场地 ${facilityId}`, 400);
  const accel = body.useAccelerator ? (typeof body.useAccelerator === 'string' ? body.useAccelerator : 'TRAINING_ACCELERATOR_1H') : null;
  if (accel && !rules.ACCELERATORS[accel]) throw new GrowthError('INVALID_ITEM', `不是训练加速道具：${accel}`, 400);

  return transaction(async (client) => {
    // 加锁顺序统一为 精灵行 → 用户行（与进化/训练营一致，避免死锁）；用户行串行化同一玩家的并发开训（队列容量/每日次数）
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [u] } = await client.query('SELECT level, vip_level FROM users WHERE id = $1 FOR UPDATE', [userId]);
    assertIdle(p, '特训');
    const pl = rules.plan(attribute, facilityId, { trainerLevel: u.level, goldenApple: !!body.useGoldenApple });
    if (pl.locked) throw new GrowthError('FACILITY_LOCKED', pl.lockedReason, 403);

    const { levels } = await attributeLevels(client, pokemonId);
    if (levels[attribute] >= rules.ATTRIBUTES[attribute].maxLevel) throw new GrowthError('ATTRIBUTE_MAXED', '该属性已满级', 400);

    const { rows: [q] } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'training')::int AS active,
              COUNT(*) FILTER (WHERE started_at >= $2::date)::int AS today
         FROM special_training_sessions WHERE user_id = $1`, [userId, gameDate()]);
    const cap = rules.queueCapacity(u.vip_level);
    if (q.active >= cap) throw new GrowthError('QUEUE_FULL', `训练队列已满（${cap}）`, 409, { max: cap });
    const limit = rules.dailyLimit(u.vip_level);
    if (q.today >= limit) throw new GrowthError('DAILY_LIMIT', `今日特训次数已用完（${limit}）`, 409);
    const { rows: [cool] } = await client.query(
      `SELECT completed_at FROM special_training_sessions WHERE pokemon_id = $1 AND status = 'completed'
          AND completed_at > NOW() - make_interval(mins => $2) ORDER BY completed_at DESC LIMIT 1`, [pokemonId, rules.COOLDOWN_MINUTES]);
    if (cool) throw new GrowthError('TRAINING_COOLDOWN', '精灵刚完成特训，需要休息 60 分钟', 409, { since: cool.completed_at });

    if (!(await consumeItem(client, userId, pl.cost.item, pl.cost.itemQty))) throw new GrowthError('INSUFFICIENT_ITEMS', `需要训练道具 ${pl.cost.item}`, 400);
    if (body.useGoldenApple && !(await consumeItem(client, userId, 'TRAIN_GOLDEN_APPLE', 1))) throw new GrowthError('INSUFFICIENT_ITEMS', '没有金苹果', 400);
    if (!(await spendCandy(client, userId, p.species_id, pl.cost.candy))) throw new GrowthError('INSUFFICIENT_CANDY', `糖果不足（需要 ${pl.cost.candy}）`, 400);
    if (!(await spendCurrency(client, userId, 'coins', pl.cost.coins))) throw new GrowthError('INSUFFICIENT_FUNDS', `金币不足（需要 ${pl.cost.coins}）`, 400);
    const stamina = await consumeStamina(client, { pokemonId, userId, activityType: 'special_training', metadata: { attribute, facilityId } });

    let endsAt = new Date(Date.now() + pl.durationMinutes * 60000);
    if (accel) {
      if (!(await consumeItem(client, userId, accel, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `没有 ${accel}`, 400);
      endsAt = rules.acceleratedEnd(endsAt, rules.ACCELERATORS[accel]);
    }
    await occupy(client, pokemonId, OCCUPY, endsAt);
    await client.query(
      `INSERT INTO user_training_facilities (user_id, facility_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, facilityId]);
    const cost = { [pl.cost.item]: pl.cost.itemQty, candy: pl.cost.candy, coins: pl.cost.coins, ...(body.useGoldenApple ? { TRAIN_GOLDEN_APPLE: 1 } : {}), ...(accel ? { [accel]: 1 } : {}) };
    const { rows: [t] } = await client.query(
      `INSERT INTO special_training_sessions (user_id, pokemon_id, attribute, facility_id, ends_at, expected_points, success_rate, cost, accelerated_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, pokemonId, attribute, facilityId, endsAt, pl.points, pl.successRate, JSON.stringify(cost), accel ? rules.ACCELERATORS[accel] : 0]);
    return { ...presentTraining(t), estimatedEndAt: t.ends_at, cost, stamina, queue: { used: q.active + 1, max: cap } };
  });
}

async function lockSession(client, userId, trainingId, pokemonId) {
  assertUuid(trainingId, 'trainingId');
  const { rows: [t] } = await client.query(
    `SELECT * FROM special_training_sessions WHERE id = $1 AND user_id = $2 ${pokemonId ? 'AND pokemon_id = $3' : ''} FOR UPDATE`,
    pokemonId ? [trainingId, userId, pokemonId] : [trainingId, userId]);
  if (!t) throw new GrowthError('TRAINING_NOT_FOUND', '特训不存在', 404);
  return t;
}

async function userStats(client, userId, pokemonId) {
  const { rows: [s] } = await client.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - started_at)) / 3600), 0)::float AS hours
       FROM special_training_sessions WHERE user_id = $1 AND status = 'completed'`, [userId]);
  const { levels } = await attributeLevels(client, pokemonId);
  const { rows: [m] } = await client.query(
    `SELECT COALESCE(MAX(m.mastery_exp), 0)::int AS mx FROM pokemon_skill_mastery m
       JOIN pokemon_instances pi ON pi.id = m.pokemon_instance_id WHERE pi.user_id = $1`, [userId]);
  return { completedSessions: s.n, totalHours: s.hours, levels, maxMasteryExp: m.mx };
}

async function grantAchievements(client, userId, pokemon) {
  const { rows } = await client.query('SELECT achievement_id FROM special_training_achievements WHERE user_id = $1', [userId]);
  const fresh = rules.newAchievements(await userStats(client, userId, pokemon.id), new Set(rows.map((r) => r.achievement_id)));
  const granted = [];
  for (const a of fresh) {
    const { rowCount } = await client.query(
      `INSERT INTO special_training_achievements (user_id, achievement_id, rewards) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, a.id, JSON.stringify(a.reward)]);
    if (!rowCount) continue;
    if (a.reward.candy) await addCandy(client, userId, pokemon.species_id, a.reward.candy);
    if (a.reward.items) await addItems(client, userId, a.reward.items);
    if (a.reward.coins) await client.query('UPDATE users SET coins = coins + $2 WHERE id = $1', [userId, a.reward.coins]);
    granted.push({ id: a.id, name: a.name, reward: a.reward });
  }
  return granted;
}

async function complete(pokemonId, trainingId, userId, { rand } = {}) {
  assertUuid(pokemonId);
  return transaction(async (client) => {
    const t = await lockSession(client, userId, trainingId, pokemonId);
    if (t.status !== 'training') throw new GrowthError('ALREADY_FINISHED', '该特训已结束', 409);
    if (new Date(t.ends_at) > new Date()) {
      throw new GrowthError('NOT_READY', `特训尚未完成（还需 ${Math.ceil((new Date(t.ends_at) - Date.now()) / 60000)} 分钟）`, 400);
    }
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    const r = rules.resolve(Number(t.expected_points), Number(t.success_rate), rand == null ? Math.random() : rand);
    const { points } = await attributeLevels(client, pokemonId);
    const applied = rules.applyPoints(t.attribute, points[t.attribute] || 0, r.points);
    await client.query(
      `INSERT INTO pokemon_training_attributes (pokemon_instance_id, attribute, points, level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pokemon_instance_id, attribute) DO UPDATE SET points = EXCLUDED.points, level = EXCLUDED.level, updated_at = NOW()`,
      [pokemonId, t.attribute, applied.pointsAfter, applied.levelAfter]);
    await client.query(
      `UPDATE special_training_sessions SET status = 'completed', completed_at = NOW(), success = $2, points_gained = $3 WHERE id = $1`,
      [t.id, r.success, applied.pointsAfter - applied.pointsBefore]);
    await release(client, pokemonId, OCCUPY);
    const achievements = await grantAchievements(client, userId, p);
    return {
      trainingId: t.id, success: r.success, attribute: t.attribute,
      attributeGain: { [t.attribute]: applied.levelAfter - applied.levelBefore },
      pointsGained: applied.pointsAfter - applied.pointsBefore, newLevel: applied.levelAfter, newPoints: applied.pointsAfter,
      achievements,
    };
  });
}

async function cancel(pokemonId, trainingId, userId) {
  assertUuid(pokemonId);
  return transaction(async (client) => {
    const t = await lockSession(client, userId, trainingId, pokemonId);
    if (t.status !== 'training') throw new GrowthError('ALREADY_FINISHED', '该特训已结束', 409);
    await client.query("UPDATE special_training_sessions SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [t.id]);
    await release(client, pokemonId, OCCUPY);
    return { trainingId: t.id, cancelled: true, refunded: false };
  });
}

async function useItem(userId, { itemId, trainingId }) {
  const minutes = rules.ACCELERATORS[itemId];
  if (!minutes) throw new GrowthError('INVALID_ITEM', `不是训练加速道具：${itemId}`, 400);
  return transaction(async (client) => {
    const t = await lockSession(client, userId, trainingId);
    if (t.status !== 'training') throw new GrowthError('ALREADY_FINISHED', '该特训已结束', 409);
    if (new Date(t.ends_at) <= new Date()) throw new GrowthError('ALREADY_READY', '特训已可领取，无需加速', 400);
    if (!(await consumeItem(client, userId, itemId, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `没有 ${itemId}`, 400);
    const endsAt = rules.acceleratedEnd(t.ends_at, minutes);
    const { rows: [row] } = await client.query(
      `UPDATE special_training_sessions SET ends_at = $2, accelerated_minutes = accelerated_minutes + $3 WHERE id = $1 RETURNING *`,
      [t.id, endsAt, minutes]);
    await client.query('UPDATE pokemon_instances SET occupied_until = $2 WHERE id = $1 AND occupied_by = $3', [t.pokemon_id, endsAt, OCCUPY]);
    return presentTraining(row);
  });
}

async function queue(userId) {
  const { rows: [u] } = await query('SELECT vip_level FROM users WHERE id = $1', [userId]);
  const { rows } = await query(
    `SELECT s.*, pi.nickname, ps.name_zh AS species_name FROM special_training_sessions s
       JOIN pokemon_instances pi ON pi.id = s.pokemon_id JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE s.user_id = $1 AND s.status = 'training' ORDER BY s.ends_at`, [userId]);
  const { rows: [d] } = await query(
    'SELECT COUNT(*)::int AS n FROM special_training_sessions WHERE user_id = $1 AND started_at >= $2::date', [userId, gameDate()]);
  return {
    slots: { used: rows.length, max: rules.queueCapacity(u ? u.vip_level : 0) },
    daily: { used: d.n, max: rules.dailyLimit(u ? u.vip_level : 0) },
    queue: rows.map((r) => ({ ...presentTraining(r), pokemonName: r.nickname || r.species_name, remaining: presentTraining(r).remainingSeconds })),
  };
}

async function items(userId) {
  const { rows } = await query(
    `SELECT i.item_id AS "itemId", i.name_zh AS name, i.description_zh AS effect, i.rarity, i.shop_price AS price, i.is_premium AS premium,
            COALESCE(pi.qty, 0)::int AS owned
       FROM items i LEFT JOIN (SELECT item_id, SUM(quantity) AS qty FROM player_inventory WHERE user_id = $1 GROUP BY item_id) pi
         ON pi.item_id = i.item_id
      WHERE i.category = 'special_training' ORDER BY i.shop_price NULLS LAST, i.item_id`, [userId]);
  return rows;
}

async function buy(userId, { itemId, quantity = 1 }) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new GrowthError('INVALID_PARAM', 'quantity 必须是 1~99', 400);
  return transaction(async (client) => {
    const { rows: [it] } = await client.query(
      `SELECT item_id, shop_price, is_premium FROM items WHERE item_id = $1 AND category = 'special_training'`, [itemId]);
    if (!it) throw new GrowthError('INVALID_ITEM', `不是训练道具：${itemId}`, 400);
    if (it.is_premium || !(Number(it.shop_price) > 0)) throw new GrowthError('NOT_FOR_SALE', '该道具不在商店出售', 400);
    const total = Number(it.shop_price) * qty;
    if (!(await spendCurrency(client, userId, 'coins', total))) throw new GrowthError('INSUFFICIENT_FUNDS', `金币不足（需要 ${total}）`, 400);
    await addItems(client, userId, [{ type: itemId, qty }]);
    return { itemId, quantity: qty, cost: { coins: total } };
  });
}

async function knownMove(p, moveId) {
  const known = new Set([p.fast_move, p.charge_move, ...(p.learned_fast_moves || []), ...(p.learned_charge_moves || [])].filter(Boolean));
  return known.has(moveId);
}

async function trainSkill(pokemonId, moveId, userId, body = {}) {
  assertUuid(pokemonId);
  if (!/^[A-Z0-9_]{1,32}$/.test(String(moveId || ''))) throw new GrowthError('INVALID_PARAM', '无效的技能 ID', 400);
  const manual = !!body.useManual;
  const dimension = body.dimension || 'power';
  if (!manual && !rules.MASTERY[dimension]) throw new GrowthError('INVALID_DIMENSION', `未知的熟练度维度 ${dimension}`, 400);
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    if (!(await knownMove(p, moveId))) throw new GrowthError('MOVE_NOT_LEARNED', '精灵没有学会这个技能', 400);
    const { rows: [cur] } = await client.query(
      'SELECT power, accuracy, critical_chance, mastery_exp FROM pokemon_skill_mastery WHERE pokemon_instance_id = $1 AND move_id = $2 FOR UPDATE',
      [pokemonId, moveId]);
    const next = rules.masteryTrain(cur || {}, dimension, { manual });
    if (next.maxed) throw new GrowthError('MASTERY_MAXED', '该维度已满级', 400);
    if (manual) {
      if (!(await consumeItem(client, userId, 'TRAIN_MASTERY_MANUAL', 1))) throw new GrowthError('INSUFFICIENT_ITEMS', '没有熟练度手册', 400);
    } else {
      const cost = rules.MASTERY[dimension].cost;
      if (cost.candy && !(await spendCandy(client, userId, p.species_id, cost.candy))) throw new GrowthError('INSUFFICIENT_CANDY', `糖果不足（需要 ${cost.candy}）`, 400);
      if (cost.item && !(await consumeItem(client, userId, cost.item, cost.qty))) throw new GrowthError('INSUFFICIENT_ITEMS', `需要 ${cost.item} ×${cost.qty}`, 400);
    }
    await client.query(
      `INSERT INTO pokemon_skill_mastery (pokemon_instance_id, move_id, power, accuracy, critical_chance, mastery_exp, unlocked_effects)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pokemon_instance_id, move_id) DO UPDATE SET power = EXCLUDED.power, accuracy = EXCLUDED.accuracy,
         critical_chance = EXCLUDED.critical_chance, mastery_exp = EXCLUDED.mastery_exp, unlocked_effects = EXCLUDED.unlocked_effects,
         updated_at = NOW()`,
      [pokemonId, moveId, next.power, next.accuracy, next.critical_chance, next.mastery_exp,
        JSON.stringify(rules.masteryBonuses(next).effects)]);
    const achievements = await grantAchievements(client, userId, p);
    return {
      moveId, dimension: manual ? 'mastery_exp' : dimension,
      masteryGain: manual ? { mastery_exp: next.mastery_exp - ((cur && cur.mastery_exp) || 0) } : { [dimension]: 1 },
      mastery: { power: next.power, accuracy: next.accuracy, criticalChance: next.critical_chance, masteryExp: next.mastery_exp },
      unlockedEffect: next.unlockedEffects[0] || null,
      bonuses: rules.masteryBonuses(next),
      achievements,
    };
  });
}

/** 战斗中使用技能获得熟练度经验（供战斗服务在自己的事务中调用） */
async function addMasteryExp(client, pokemonId, moveId, amount = 1) {
  await client.query(
    `INSERT INTO pokemon_skill_mastery (pokemon_instance_id, move_id, mastery_exp) VALUES ($1, $2, LEAST(100, $3::int))
     ON CONFLICT (pokemon_instance_id, move_id) DO UPDATE SET mastery_exp = LEAST(100, pokemon_skill_mastery.mastery_exp + $3::int), updated_at = NOW()`,
    [pokemonId, moveId, amount]);
}

async function achievements(userId) {
  const { rows } = await query('SELECT achievement_id, achieved_at, rewards FROM special_training_achievements WHERE user_id = $1', [userId]);
  const got = new Map(rows.map((r) => [r.achievement_id, r]));
  return rules.ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, reward: a.reward, achieved: got.has(a.id), achievedAt: got.has(a.id) ? got.get(a.id).achieved_at : null }));
}

/** 战斗档案用：训练属性加成 */
async function battleBonuses(db, pokemonId) {
  const { levels } = await attributeLevels(db, pokemonId);
  return { levels, bonuses: rules.attributeBonuses(levels) };
}

module.exports = { status, facilities, start, complete, cancel, useItem, queue, items, buy, trainSkill, addMasteryExp, achievements, battleBonuses };
