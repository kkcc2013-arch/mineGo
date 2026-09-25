/**
 * 精灵训练营服务（REQ-00370）
 *
 * 原实现查询不存在的 user_pokemon 表、扣 users.gold（不存在）且不校验扣费结果，训练营接口全部 500；
 * 且 training_slots 的 (user, camp, slot_index) 唯一约束让同一槽位训练过一次后再也不能使用。重写为：
 *   - 首次访问自动开通三类训练营；开始训练在事务内：锁精灵（空闲）→ 课程/等级/每日次数校验 → 原子扣费 →
 *     消耗训练体力（体力系统）→ 按疲劳定评级 → 占用精灵 → 写槽位
 *   - 进度读时计算（精确到分钟）；到点由定时任务标记 ready 并写站内通知（notification_history）
 *   - 领取奖励：经验走统一经验入账（含活动/幸运蛋等倍率）、亲密度（上限 255）、技能营从可学技能中学会一个新招式
 *   - 加速道具走 player_inventory；取消训练不退费；升级扩容；训练报告即训练历史
 * 规则见 growth/trainingCampRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem, addItems } = require('../../../shared/inventory');
const { gameDate } = require('../../../shared/gameTime');
const { grantPokemonExperience } = require('../../../shared/pokemonExperience');
const rules = require('./growth/trainingCampRules');
const { consumeStamina } = require('./staminaService');
const { GrowthError, lockOwnedPokemon, assertIdle, assertUuid, occupy, release, spendCurrency } = require('./growth/common');

const OCCUPY = 'training_camp';

function parseId(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GrowthError('INVALID_PARAM', `无效的 ${field}`, 400);
  return n;
}

async function ensureCamps(db, userId) {
  await db.query(
    `INSERT INTO user_training_camps (user_id, camp_id, level, capacity)
     SELECT $1, tc.id, 1, tc.base_capacity FROM training_camps tc
     ON CONFLICT (user_id, camp_id) DO NOTHING`, [userId]);
}

function presentSlot(s, now = new Date()) {
  const pr = rules.progress(s.started_at, s.ends_at, now);
  return {
    slotId: s.id,
    campId: s.camp_id,
    slotIndex: s.slot_index,
    pokemonId: s.pokemon_id,
    pokemonName: s.nickname || s.species_name || null,
    courseId: s.course_id,
    courseName: s.course_name || null,
    status: s.status === 'training' && pr.ready ? 'ready' : s.status,
    startedAt: s.started_at,
    endsAt: s.ends_at,
    progressPercent: s.status === 'completed' ? 100 : pr.percent,
    remainingMinutes: s.status === 'training' || s.status === 'ready' ? pr.remainingMinutes : 0,
    rating: s.rating,
    expectedExp: s.expected_exp,
    expectedFriendship: s.expected_friendship,
    boostType: s.boost_type,
  };
}

async function activeSlots(db, userId, campId) {
  const { rows } = await db.query(
    `SELECT ts.*, c.name AS course_name, pi.nickname, ps.name_zh AS species_name
       FROM training_slots ts
       JOIN training_courses c ON c.id = ts.course_id
       JOIN pokemon_instances pi ON pi.id = ts.pokemon_id
       JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE ts.user_id = $1 AND ($2::int IS NULL OR ts.camp_id = $2) AND ts.status IN ('training', 'ready')
      ORDER BY ts.camp_id, ts.slot_index`, [userId, campId == null ? null : campId]);
  return rows;
}

async function getCamps(userId) {
  await ensureCamps({ query }, userId);
  const { rows } = await query(
    `SELECT utc.camp_id, utc.level, utc.capacity, tc.name, tc.type, tc.description, tc.max_level, tc.capacity_per_level
       FROM user_training_camps utc JOIN training_camps tc ON tc.id = utc.camp_id
      WHERE utc.user_id = $1 ORDER BY tc.id`, [userId]);
  const slots = await activeSlots({ query }, userId, null);
  const now = new Date();
  return rows.map((c) => {
    const mine = slots.filter((s) => s.camp_id === c.camp_id).map((s) => presentSlot(s, now));
    return {
      campId: c.camp_id, name: c.name, type: c.type, description: c.description, level: c.level, maxLevel: c.max_level,
      capacity: c.capacity, usedSlots: mine.length, availableSlots: Math.max(0, c.capacity - mine.length),
      upgradeCost: c.level < c.max_level ? { currency: 'coins', amount: rules.upgradeCost(c.level) } : null,
      slots: mine,
    };
  });
}

async function getCourses(userId, campId) {
  const cid = parseId(campId, 'campId');
  await ensureCamps({ query }, userId);
  const { rows: [camp] } = await query('SELECT level FROM user_training_camps WHERE user_id = $1 AND camp_id = $2', [userId, cid]);
  if (!camp) throw new GrowthError('CAMP_NOT_FOUND', '训练营不存在', 404);
  const { rows } = await query('SELECT * FROM training_courses WHERE camp_id = $1 ORDER BY required_camp_level, id', [cid]);
  return rows.map((c) => {
    const exp = rules.expectedRewards(c, camp.level, 1);
    return {
      courseId: c.id, name: c.name, description: c.description, durationMinutes: c.duration_minutes,
      cost: rules.costOf(c), requiredCampLevel: c.required_camp_level, unlocked: camp.level >= (c.required_camp_level || 1),
      minPokemonLevel: c.min_pokemon_level, maxPokemonLevel: c.max_pokemon_level, dailyLimit: c.daily_limit || 0,
      baseRewards: exp, isPremium: c.is_premium,
    };
  });
}

async function start(userId, body = {}) {
  const campId = parseId(body.campId, 'campId');
  const courseId = parseId(body.courseId, 'courseId');
  const pokemonId = assertUuid(body.pokemonId);
  return transaction(async (client) => {
    await ensureCamps(client, userId);
    const { rows: [camp] } = await client.query(
      `SELECT utc.*, tc.type FROM user_training_camps utc JOIN training_camps tc ON tc.id = utc.camp_id
        WHERE utc.user_id = $1 AND utc.camp_id = $2 FOR UPDATE OF utc`, [userId, campId]);
    if (!camp) throw new GrowthError('CAMP_NOT_FOUND', '训练营不存在', 404);
    const { rows: [course] } = await client.query('SELECT * FROM training_courses WHERE id = $1 AND camp_id = $2', [courseId, campId]);
    if (!course) throw new GrowthError('COURSE_NOT_FOUND', '课程不存在', 404);

    const p = await lockOwnedPokemon(client, pokemonId, userId);
    assertIdle(p, '参加训练');
    const bad = rules.courseCheck(course, { campLevel: camp.level, pokemonLevel: p.level || 1 });
    if (bad) throw new GrowthError('COURSE_LOCKED', bad, 400);

    const used = await activeSlots(client, userId, campId);
    const taken = new Set(used.map((s) => s.slot_index));
    let slotIndex = body.slotIndex != null ? Number(body.slotIndex) : [...Array(camp.capacity).keys()].find((i) => !taken.has(i));
    if (slotIndex == null || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= camp.capacity) {
      throw new GrowthError('NO_FREE_SLOT', `训练营槽位已满（${camp.capacity} 个）`, 409);
    }
    if (taken.has(slotIndex)) throw new GrowthError('SLOT_OCCUPIED', '该槽位正在使用中', 409);

    if (course.daily_limit > 0) {
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM training_slots WHERE user_id = $1 AND course_id = $2 AND started_at >= $3::date`,
        [userId, courseId, gameDate()]);
      if (n >= course.daily_limit) throw new GrowthError('DAILY_LIMIT', `该课程今日次数已用完（${course.daily_limit}）`, 409);
    }

    const cost = rules.costOf(course);
    if (cost && !(await spendCurrency(client, userId, cost.currency, cost.amount))) {
      throw new GrowthError('INSUFFICIENT_FUNDS', `${cost.currency} 不足（需要 ${cost.amount}）`, 400);
    }
    const stamina = await consumeStamina(client, { pokemonId, userId, activityType: 'training', metadata: { campId, courseId } });
    const rating = rules.ratingFor(stamina.fatigueLevel);
    const reward = rules.expectedRewards(course, camp.level, rating.multiplier);
    const endsAt = new Date(Date.now() + Number(course.duration_minutes) * 60000);
    await occupy(client, pokemonId, OCCUPY, endsAt);
    const { rows: [slot] } = await client.query(
      `INSERT INTO training_slots (user_id, camp_id, slot_index, pokemon_id, course_id, status, started_at, ends_at,
                                   expected_exp, expected_friendship, rating)
       VALUES ($1, $2, $3, $4, $5, 'training', NOW(), $6, $7, $8, $9) RETURNING *`,
      [userId, campId, slotIndex, pokemonId, courseId, endsAt, reward.exp, reward.friendship, rating.rating]);
    return { ...presentSlot({ ...slot, course_name: course.name }), campType: camp.type, cost, stamina, ratingMultiplier: rating.multiplier };
  });
}

async function lockSlot(client, userId, slotId) {
  assertUuid(slotId, 'slotId');
  const { rows: [s] } = await client.query(
    `SELECT ts.*, tc.type AS camp_type, c.name AS course_name, c.duration_minutes, c.cost_type, c.cost_amount
       FROM training_slots ts JOIN training_camps tc ON tc.id = ts.camp_id JOIN training_courses c ON c.id = ts.course_id
      WHERE ts.id = $1 AND ts.user_id = $2 FOR UPDATE OF ts`, [slotId, userId]);
  if (!s) throw new GrowthError('SLOT_NOT_FOUND', '训练不存在', 404);
  return s;
}

async function getSlot(userId, slotId) {
  assertUuid(slotId, 'slotId');
  const { rows: [s] } = await query(
    `SELECT ts.*, c.name AS course_name FROM training_slots ts JOIN training_courses c ON c.id = ts.course_id
      WHERE ts.id = $1 AND ts.user_id = $2`, [slotId, userId]);
  if (!s) throw new GrowthError('SLOT_NOT_FOUND', '训练不存在', 404);
  return presentSlot(s);
}

async function learnMove(client, pokemonId) {
  const { rows: [p] } = await client.query(
    'SELECT species_id, learned_fast_moves, learned_charge_moves FROM pokemon_instances WHERE id = $1', [pokemonId]);
  const { rows: learnset } = await client.query(
    `SELECT pm.move_id, m.category, m.name_zh FROM pokemon_moves pm JOIN moves m ON m.id = pm.move_id
      WHERE pm.species_id = $1 AND pm.learn_method IN ('TM', 'LEVEL_UP', 'TUTOR')`, [p.species_id]);
  const move = rules.pickNewMove(learnset, p.learned_fast_moves, p.learned_charge_moves);
  if (!move) return null;
  const col = move.category === 'FAST' ? 'learned_fast_moves' : 'learned_charge_moves';
  await client.query(`UPDATE pokemon_instances SET ${col} = array_append(COALESCE(${col}, '{}'), $2::text) WHERE id = $1`, [pokemonId, move.move_id]);
  return { moveId: move.move_id, name: move.name_zh, category: move.category };
}

async function complete(userId, slotId) {
  return transaction(async (client) => {
    const s = await lockSlot(client, userId, slotId);
    if (s.status === 'completed' || s.status === 'cancelled') throw new GrowthError('ALREADY_FINISHED', '该训练已结束', 409);
    const pr = rules.progress(s.started_at, s.ends_at);
    if (!pr.ready) throw new GrowthError('NOT_READY', `训练尚未完成（还需 ${pr.remainingMinutes} 分钟）`, 400, { remainingMinutes: pr.remainingMinutes });

    await release(client, s.pokemon_id, OCCUPY);
    let growth = null;
    if (s.expected_exp > 0) {
      growth = await grantPokemonExperience(client, {
        userId, pokemonId: s.pokemon_id, baseAmount: s.expected_exp * (s.boost_type === 'TRAINING_EXP_DOUBLE' ? 2 : 1),
        sourceType: 'training_camp', sourceId: s.id, metadata: { campId: s.camp_id, courseId: s.course_id, rating: s.rating },
      });
    }
    let friendship = null;
    if (s.expected_friendship > 0) {
      const { rows: [f] } = await client.query(
        `UPDATE pokemon_instances SET friendship = LEAST(255, COALESCE(friendship, 70) + $2), friendship_updated_at = NOW()
          WHERE id = $1 RETURNING friendship`, [s.pokemon_id, s.expected_friendship]);
      friendship = { gained: s.expected_friendship, current: f.friendship };
    }
    const move = s.camp_type === 'skill' ? await learnMove(client, s.pokemon_id) : null;
    // 觉醒材料获取途径（REQ-00245）：每完成一次训练营训练掉落 1 个觉醒碎片
    const { credited: drops } = await addItems(client, userId, [{ type: 'AWAKENING_SHARD', qty: 1 }]);
    const actualExp = growth ? growth.gainedExp : 0;
    await client.query(
      `UPDATE training_slots SET status = 'completed', completed_at = NOW(), actual_exp = $2, actual_friendship = $3,
              skill_learned = $4, updated_at = NOW() WHERE id = $1`,
      [s.id, actualExp, s.expected_friendship || 0, !!move]);
    await client.query(
      `INSERT INTO training_reports (user_id, slot_id, pokemon_id, camp_type, course_name, duration_minutes, exp_gained,
                                     friendship_gained, skill_learned_name, cost_type, cost_amount, rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userId, s.id, s.pokemon_id, s.camp_type, s.course_name, Math.max(1, Math.round((new Date(s.ends_at) - new Date(s.started_at)) / 60000)),
        actualExp, s.expected_friendship || 0, move ? move.name || move.moveId : null, s.cost_type, s.cost_amount || 0, s.rating || 'normal']);
    return { slotId: s.id, pokemonId: s.pokemon_id, rating: s.rating, rewards: { exp: actualExp, friendship, skillLearned: move, items: drops }, growth };
  });
}

async function boost(userId, slotId, itemId) {
  const b = rules.BOOSTS[itemId];
  if (!b) throw new GrowthError('INVALID_ITEM', `不是训练加速道具：${itemId}`, 400);
  return transaction(async (client) => {
    const s = await lockSlot(client, userId, slotId);
    if (s.status !== 'training' && s.status !== 'ready') throw new GrowthError('ALREADY_FINISHED', '该训练已结束', 409);
    if (s.boost_type) throw new GrowthError('BOOST_ALREADY_USED', '该训练已使用过加速道具', 409);
    if (b.kind === 'time' && rules.progress(s.started_at, s.ends_at).ready) throw new GrowthError('ALREADY_READY', '训练已完成，无需加速', 400);
    if (!(await consumeItem(client, userId, itemId, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `${b.name}道具不足`, 400);
    const endsAt = rules.boostedEnd(s.ends_at, b);
    const { rows: [row] } = await client.query(
      `UPDATE training_slots SET ends_at = $2, boost_used = TRUE, boost_type = $3, boost_ends_at = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [s.id, endsAt, itemId]);
    await client.query('UPDATE pokemon_instances SET occupied_until = $2 WHERE id = $1 AND occupied_by = $3', [s.pokemon_id, endsAt, OCCUPY]);
    return { ...presentSlot({ ...row, course_name: s.course_name }), boost: { itemId, effect: b.name } };
  });
}

async function cancel(userId, slotId) {
  return transaction(async (client) => {
    const s = await lockSlot(client, userId, slotId);
    if (s.status !== 'training' && s.status !== 'ready') throw new GrowthError('ALREADY_FINISHED', '该训练已结束', 409);
    await client.query("UPDATE training_slots SET status = 'cancelled', completed_at = NOW(), updated_at = NOW() WHERE id = $1", [s.id]);
    await release(client, s.pokemon_id, OCCUPY);
    return { slotId: s.id, cancelled: true, refunded: false };
  });
}

async function upgrade(userId, campId) {
  const cid = parseId(campId, 'campId');
  return transaction(async (client) => {
    await ensureCamps(client, userId);
    const { rows: [c] } = await client.query(
      `SELECT utc.*, tc.max_level, tc.capacity_per_level FROM user_training_camps utc JOIN training_camps tc ON tc.id = utc.camp_id
        WHERE utc.user_id = $1 AND utc.camp_id = $2 FOR UPDATE OF utc`, [userId, cid]);
    if (!c) throw new GrowthError('CAMP_NOT_FOUND', '训练营不存在', 404);
    if (c.level >= c.max_level) throw new GrowthError('MAX_LEVEL', '训练营已满级', 400);
    const cost = rules.upgradeCost(c.level);
    if (!(await spendCurrency(client, userId, 'coins', cost))) throw new GrowthError('INSUFFICIENT_FUNDS', `金币不足（需要 ${cost}）`, 400);
    const { rows: [u] } = await client.query(
      `UPDATE user_training_camps SET level = level + 1, capacity = capacity + $2, upgraded_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING level, capacity`, [c.id, c.capacity_per_level || 1]);
    return { campId: cid, level: u.level, capacity: u.capacity, cost: { currency: 'coins', amount: cost } };
  });
}

async function history(userId, { limit = 20, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);
  const { rows } = await query(
    `SELECT tr.id, tr.slot_id AS "slotId", tr.pokemon_id AS "pokemonId", tr.camp_type AS "campType", tr.course_name AS "courseName",
            tr.duration_minutes AS "durationMinutes", tr.exp_gained AS "expGained", tr.friendship_gained AS "friendshipGained",
            tr.skill_learned_name AS "skillLearned", tr.cost_type AS "costType", tr.cost_amount AS "costAmount", tr.rating,
            tr.completed_at AS "completedAt"
       FROM training_reports tr WHERE tr.user_id = $1 ORDER BY tr.completed_at DESC LIMIT $2 OFFSET $3`, [userId, lim, off]);
  return { items: rows, limit: lim, offset: off };
}

/** 定时任务：到点的训练标记 ready 并发站内通知 */
async function markReady() {
  const { rows } = await query(
    `UPDATE training_slots SET status = 'ready', updated_at = NOW()
      WHERE status = 'training' AND ends_at <= NOW()
      RETURNING id, user_id, pokemon_id, course_id`);
  if (rows.length) {
    try {
      await query(
        `INSERT INTO notification_history (user_id, type, data)
         SELECT (x->>'user_id')::uuid, 'training_complete', x FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(rows.map((r) => ({ ...r, message: '训练已完成，快去领取奖励吧' })))]);
    } catch (err) {
      if (err.code !== '42P01') throw err; // 没有消息中心表时只更新状态
    }
  }
  return rows.length;
}

module.exports = { getCamps, getCourses, start, getSlot, complete, boost, cancel, upgrade, history, markReady };
