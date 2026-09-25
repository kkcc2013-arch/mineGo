/**
 * 精灵体力系统服务（REQ-00172）
 *
 * 原实现使用不存在的 knex 风格 db('pokemon') 与 pokemon 表，所有体力接口 500。重写为：
 *   - 体力存于 pokemon_instances（max_stamina/current_stamina/last_stamina_update/fatigue_level），读时惰性换算自然恢复
 *   - 消耗/恢复在事务内锁行、条件扣减，写 stamina_history（训练营/特训在各自事务里调用 consumeStamina）
 *   - 恢复道具走 player_inventory（stamina_recovery_items.item_code 映射恢复量与冷却）
 *   - 休息站复用 recovery_stations（需在站点 100 米内，休息中精灵被占用，结束时按时长额外恢复）
 *   - 定时任务把自然恢复落库并刷新 fatigue_level
 * 数值规则见 growth/staminaRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { getJSON } = require('../../../shared/redis');
const { consumeItem } = require('../../../shared/inventory');
const { haversineDistance } = require('../../../shared/anti-cheat');
const rules = require('./growth/staminaRules');
const { GrowthError, lockOwnedPokemon, assertIdle, assertUuid, occupy, release } = require('./growth/common');

const REST_MAX_DISTANCE_M = 100;
const CONFIG_TTL_MS = 5 * 60 * 1000;
let configCache = { at: 0, costs: new Map() };

async function activityCost(db, activityType) {
  if (Date.now() - configCache.at > CONFIG_TTL_MS) {
    const { rows } = await db.query('SELECT activity_type, stamina_cost FROM stamina_config');
    configCache = { at: Date.now(), costs: new Map(rows.map((r) => [r.activity_type, Number(r.stamina_cost)])) };
  }
  return configCache.costs.get(activityType);
}

async function lockStaminaRow(client, pokemonId, userId) {
  const { rows: [row] } = await client.query(
    `SELECT id, max_stamina, current_stamina, last_stamina_update FROM pokemon_instances
      WHERE id = $1 AND user_id = $2 AND COALESCE(is_released, FALSE) = FALSE FOR UPDATE`, [pokemonId, userId]);
  if (!row) throw new GrowthError('POKEMON_NOT_FOUND', '精灵不存在', 404);
  return row;
}

/** 新的 last_stamina_update：满体力时从现在起算，否则保留不足一分钟的零头 */
function nextAnchor(row, eff, now) {
  if (eff.current >= eff.max || !row.last_stamina_update) return now;
  return new Date(new Date(row.last_stamina_update).getTime() + eff.wholeMinutes * 60000);
}

async function writeStamina(client, row, eff, newCurrent, anchor, { userId, activityType, source, metadata }) {
  const level = rules.fatigueLevel(newCurrent, eff.max);
  await client.query(
    `UPDATE pokemon_instances SET current_stamina = $2, last_stamina_update = $3, fatigue_level = $4, updated_at = NOW()
      WHERE id = $1`, [row.id, newCurrent, anchor, level]);
  await client.query(
    `INSERT INTO stamina_history (user_id, pokemon_id, activity_type, stamina_change, stamina_before, stamina_after, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, row.id, activityType, newCurrent - eff.current, eff.current, newCurrent, source, JSON.stringify(metadata || {})]);
  return level;
}

/**
 * 消耗体力（在调用方事务中）；不足抛 400 INSUFFICIENT_STAMINA
 * @param {object} a { pokemonId, userId, activityType, amount?, metadata? }
 */
async function consumeStamina(client, a) {
  const cost = a.amount != null ? Math.trunc(Number(a.amount)) : await activityCost(client, a.activityType);
  if (cost == null) throw new GrowthError('INVALID_ACTIVITY', `未知的活动类型 ${a.activityType}`, 400);
  const row = await lockStaminaRow(client, a.pokemonId, a.userId);
  const now = new Date();
  const eff = rules.effectiveStamina(row, now);
  if (eff.current < cost) {
    throw new GrowthError('INSUFFICIENT_STAMINA', `体力不足（需要 ${cost}，当前 ${eff.current}）`, 400,
      { currentStamina: eff.current, required: cost });
  }
  const after = eff.current - cost;
  const level = await writeStamina(client, row, eff, after, nextAnchor(row, eff, now),
    { userId: a.userId, activityType: a.activityType, source: 'activity', metadata: a.metadata });
  return { activityType: a.activityType, consumed: cost, staminaBefore: eff.current, staminaAfter: after, maxStamina: eff.max, fatigueLevel: level, effects: rules.FATIGUE_LEVELS[level] };
}

/** 恢复体力（在调用方事务中），返回实际恢复量 */
async function recoverStamina(client, a) {
  const row = await lockStaminaRow(client, a.pokemonId, a.userId);
  const now = new Date();
  const eff = rules.effectiveStamina(row, now);
  const after = Math.min(eff.max, eff.current + Math.max(0, Math.trunc(Number(a.amount) || 0)));
  const anchor = nextAnchor(row, { ...eff, current: after }, now);
  const level = await writeStamina(client, row, eff, after, anchor,
    { userId: a.userId, activityType: 'recovery', source: a.source, metadata: a.metadata });
  return { recovered: after - eff.current, staminaBefore: eff.current, staminaAfter: after, maxStamina: eff.max, fatigueLevel: level };
}

async function restingInfo(db, pokemonId) {
  const { rows: [r] } = await db.query(
    `SELECT rr.id, rr.station_id AS "stationId", rr.rate_multiplier::float AS "rateMultiplier", rr.started_at AS "startedAt"
       FROM rest_records rr WHERE rr.pokemon_id = $1 AND rr.ended_at IS NULL`, [pokemonId]);
  return r || null;
}

async function getStatus(pokemonId, userId) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const s = rules.status(p);
  const rest = await restingInfo({ query }, pokemonId);
  if (rest) {
    const minutes = (Date.now() - new Date(rest.startedAt).getTime()) / 60000;
    rest.projectedRecovery = rules.restRecovery(minutes, rest.rateMultiplier);
  }
  return { pokemonId: p.id, ...s, resting: rest };
}

async function getBatch(ids, userId) {
  if (!Array.isArray(ids) || !ids.length) throw new GrowthError('INVALID_PARAM', 'pokemonIds 必须是非空数组', 400);
  if (ids.length > 200) throw new GrowthError('INVALID_PARAM', '一次最多查询 200 只精灵', 400);
  ids.forEach((id) => assertUuid(id));
  const { rows } = await query(
    `SELECT id, max_stamina, current_stamina, last_stamina_update FROM pokemon_instances
      WHERE id = ANY($1::uuid[]) AND user_id = $2 AND COALESCE(is_released, FALSE) = FALSE`, [ids, userId]);
  const now = new Date();
  return rows.map((r) => ({ pokemonId: r.id, ...rules.status(r, now) }));
}

async function consume(pokemonId, userId, activityType) {
  assertUuid(pokemonId);
  if (!activityType || typeof activityType !== 'string') throw new GrowthError('INVALID_ACTIVITY', 'activityType 必填', 400);
  return transaction((client) => consumeStamina(client, { pokemonId, userId, activityType }));
}

async function useItem(pokemonId, userId, itemId) {
  assertUuid(pokemonId);
  const { rows: [item] } = await query(
    `SELECT item_code, item_name, stamina_amount, cooldown_seconds FROM stamina_recovery_items WHERE item_code = $1`, [itemId]);
  if (!item) throw new GrowthError('INVALID_ITEM', `不是体力恢复道具：${itemId}`, 400);
  return transaction(async (client) => {
    const row = await lockStaminaRow(client, pokemonId, userId);
    const eff = rules.effectiveStamina(row);
    if (eff.current >= eff.max) throw new GrowthError('STAMINA_FULL', '体力已满，无需使用道具', 400);
    if (item.cooldown_seconds > 0) {
      const { rows: [last] } = await client.query(
        `SELECT created_at FROM stamina_history WHERE pokemon_id = $1 AND source = $2
            AND created_at > NOW() - make_interval(secs => $3) ORDER BY created_at DESC LIMIT 1`,
        [pokemonId, `item:${item.item_code}`, item.cooldown_seconds]);
      if (last) {
        const remain = Math.ceil(item.cooldown_seconds - (Date.now() - new Date(last.created_at).getTime()) / 1000);
        throw new GrowthError('ITEM_COOLDOWN', `${item.item_name} 冷却中，还需 ${Math.max(1, remain)} 秒`, 409, { remainingSeconds: remain });
      }
    }
    if (!(await consumeItem(client, userId, item.item_code, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `${item.item_name} 数量不足`, 400);
    const r = await recoverStamina(client, { pokemonId, userId, amount: item.stamina_amount, source: `item:${item.item_code}`, metadata: { itemId: item.item_code } });
    return { ...r, itemId: item.item_code, itemName: item.item_name, cooldownSeconds: item.cooldown_seconds };
  });
}

async function nearbyStations(lat, lng, radius = 2000) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
    throw new GrowthError('INVALID_PARAM', 'lat/lng 无效', 400);
  }
  const r = Math.min(10000, Math.max(50, Number(radius) || 2000));
  const { rows } = await query(
    `SELECT id, name, type, level, recovery_speed_multiplier::float AS "rateMultiplier",
            ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
            ROUND(ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography))::int AS "distanceM"
       FROM recovery_stations
      WHERE status = 'active' AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
      ORDER BY "distanceM" LIMIT 20`, [la, ln, r]);
  return rows.map((s) => ({ ...s, recoveryPerMinute: rules.REST_BASE_PER_MIN * s.rateMultiplier }));
}

async function startRest(pokemonId, userId, stationId) {
  assertUuid(pokemonId);
  const sid = Number(stationId);
  if (!Number.isInteger(sid) || sid <= 0) throw new GrowthError('INVALID_PARAM', 'stationId 无效', 400);
  const { rows: [st] } = await query(
    `SELECT id, name, recovery_speed_multiplier::float AS m, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM recovery_stations WHERE id = $1 AND status = 'active'`, [sid]);
  if (!st) throw new GrowthError('STATION_NOT_FOUND', '休息站不存在或未开放', 404);
  const pos = await getJSON(`player:pos:${userId}`);
  if (!pos) throw new GrowthError('LOCATION_REQUIRED', '请先上报当前位置', 400);
  const dist = haversineDistance(Number(pos.lat), Number(pos.lng), Number(st.lat), Number(st.lng));
  if (!(dist <= REST_MAX_DISTANCE_M)) throw new GrowthError('TOO_FAR', `距离休息站太远（需在 ${REST_MAX_DISTANCE_M} 米内，当前 ${Math.round(dist)} 米）`, 400);
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    assertIdle(p, '休息');
    await occupy(client, pokemonId, 'resting');
    const { rows: [rec] } = await client.query(
      `INSERT INTO rest_records (user_id, pokemon_id, station_id, rate_multiplier) VALUES ($1, $2, $3, $4)
       RETURNING id, started_at AS "startedAt"`, [userId, pokemonId, sid, st.m]);
    return { restId: rec.id, stationId: sid, stationName: st.name, startedAt: rec.startedAt, recoveryPerMinute: rules.REST_BASE_PER_MIN * st.m, maxMinutes: rules.MAX_REST_MINUTES };
  });
}

async function endRest(pokemonId, userId) {
  assertUuid(pokemonId);
  return transaction(async (client) => {
    await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [rest] } = await client.query(
      `SELECT id, rate_multiplier::float AS m, started_at FROM rest_records
        WHERE pokemon_id = $1 AND user_id = $2 AND ended_at IS NULL FOR UPDATE`, [pokemonId, userId]);
    if (!rest) throw new GrowthError('NOT_RESTING', '精灵没有在休息', 400);
    const minutes = Math.floor((Date.now() - new Date(rest.started_at).getTime()) / 60000);
    const extra = rules.restRecovery(minutes, rest.m);
    await release(client, pokemonId, 'resting');
    const r = await recoverStamina(client, { pokemonId, userId, amount: extra, source: 'rest_station', metadata: { restId: rest.id, minutes } });
    await client.query('UPDATE rest_records SET ended_at = NOW(), stamina_recovered = $2 WHERE id = $1', [rest.id, r.recovered]);
    // 休息结束同时恢复羁绊技能 PP（REQ-00151）
    await require('./bondSkillService').restorePp(client, pokemonId);
    return { restId: rest.id, minutes, ...r, bondSkillPpRestored: true };
  });
}

async function history(pokemonId, userId, { limit = 20 } = {}) {
  await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const { rows } = await query(
    `SELECT activity_type AS "activityType", stamina_change AS change, stamina_before AS before, stamina_after AS after,
            source, metadata, created_at AS "createdAt"
       FROM stamina_history WHERE pokemon_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [pokemonId, lim]);
  return rows;
}

async function config() {
  const { rows: costs } = await query('SELECT activity_type AS "activityType", stamina_cost AS cost, description FROM stamina_config ORDER BY id');
  const { rows: items } = await query(
    `SELECT item_code AS "itemId", item_name AS name, stamina_amount AS amount, cooldown_seconds AS "cooldownSeconds", rarity
       FROM stamina_recovery_items WHERE item_code IS NOT NULL ORDER BY stamina_amount`);
  return {
    activityCosts: costs,
    recoveryItems: items,
    fatigueLevels: rules.FATIGUE_LEVELS,
    naturalRecoveryPerMinute: rules.NATURAL_RECOVERY_PER_MIN,
    restRecoveryPerMinute: rules.REST_BASE_PER_MIN,
  };
}

/** 自然恢复落库（定时任务）：保留不足一分钟的零头，只处理未满的精灵 */
async function naturalRecoveryTick() {
  const { rowCount } = await query(
    `WITH due AS (
       SELECT id, max_stamina,
              LEAST(max_stamina, current_stamina + FLOOR(EXTRACT(EPOCH FROM (NOW() - last_stamina_update)) / 60)::int * $1) AS cur,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - last_stamina_update)) / 60)::int AS mins
         FROM pokemon_instances
        WHERE current_stamina < max_stamina AND last_stamina_update < NOW() - INTERVAL '1 minute'
          AND COALESCE(is_released, FALSE) = FALSE
        LIMIT 5000
     )
     UPDATE pokemon_instances pi
        SET current_stamina = due.cur,
            last_stamina_update = CASE WHEN due.cur >= due.max_stamina THEN NOW()
                                       ELSE pi.last_stamina_update + make_interval(mins => due.mins) END,
            fatigue_level = CASE WHEN due.cur * 100 >= due.max_stamina * 80 THEN 'fresh'
                                 WHEN due.cur * 100 >= due.max_stamina * 50 THEN 'normal'
                                 WHEN due.cur * 100 >= due.max_stamina * 20 THEN 'tired'
                                 ELSE 'exhausted' END
       FROM due WHERE pi.id = due.id`, [rules.NATURAL_RECOVERY_PER_MIN]);
  return rowCount;
}

module.exports = {
  consumeStamina,
  recoverStamina,
  getStatus,
  getBatch,
  consume,
  useItem,
  nearbyStations,
  startRest,
  endRest,
  history,
  config,
  naturalRecoveryTick,
};
