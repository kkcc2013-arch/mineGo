/**
 * 成就引擎（游戏事件 outbox 消费者）——REQ-00076 / REQ-00106 / REQ-00261
 *
 * 业务表触发器（见 database/migrations/20260925_130000__e05_achievement_title_core.sql）把事件写入 achievement_events
 * 并 pg_notify('pmg_game_events', userId)。本模块：
 *   - processUserEvents(userId)：在一个事务里锁定（SKIP LOCKED）该玩家未处理事件，逐条（SAVEPOINT 隔离）推进成就进度，
 *     完成时解锁称号/装饰并生成站内消息，最后标记事件已处理。多个消费者并发也不会重复处理同一事件；
 *     进度更新是单条 upsert（ON CONFLICT … WHERE NOT completed），并发完成同一成就只会判定一次。
 *   - startConsumer()：LISTEN 实时处理 + 定时兜底扫描 + 过期数据清理（user-service 启动）。
 *   - recordEvent()：JS 侧业务（收藏室等）写事件。
 */
'use strict';

const rules = require('./achievementRules');
const notificationCenter = require('./notificationCenter');
const profileCache = require('./profileCache');
const { createLogger } = require('./logger');

const logger = createLogger('achievement-engine');
const MAX_ATTEMPTS = 5;
const BATCH = 200;
const DEFS_TTL_MS = 60 * 1000;
const SCORE_EVENTS = new Set(['catch', 'egg_hatched', 'trade_completed']);

// ── 指标 ──────────────────────────────────────────────────────
let M = null;
function metrics() {
  if (M) return M;
  try {
    const promClient = require('prom-client');
    const { register } = require('./metrics');
    const get = (name, Ctor, opts) => register.getSingleMetric(name) || new Ctor({ name, registers: [register], ...opts });
    M = {
      events: get('minego_game_events_processed_total', promClient.Counter, { help: '已处理的游戏事件', labelNames: ['type', 'status'] }),
      unlocked: get('minego_achievements_unlocked_total', promClient.Counter, { help: '成就解锁数', labelNames: ['category', 'rarity'] }),
      titles: get('minego_titles_unlocked_total', promClient.Counter, { help: '称号解锁数', labelNames: ['source'] }),
      latency: get('minego_achievement_processing_seconds', promClient.Histogram, {
        help: '单次处理某玩家待处理事件的耗时', buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2] }),
      lag: get('minego_game_event_lag_seconds', promClient.Histogram, {
        help: '事件写入到处理完成的延迟', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] }),
    };
  } catch {
    const noop = { inc() {}, observe() {} };
    M = { events: noop, unlocked: noop, titles: noop, latency: noop, lag: noop };
  }
  return M;
}

function defaultDb() { return require('./db'); }

// ── 成就定义缓存 ──────────────────────────────────────────────
let defsCache = { at: 0, list: [], byMetric: new Map(), byId: new Map() };
async function loadDefinitions(q, { force = false } = {}) {
  if (!force && defsCache.at && Date.now() - defsCache.at < DEFS_TTL_MS) return defsCache;
  const { rows } = await q.query(
    `SELECT achievement_id, category, name, description, icon_url, rarity, points, is_hidden, trigger_conditions, rewards,
            prerequisite_achievement_id, display_order
       FROM achievements WHERE is_active ORDER BY category, display_order, points, achievement_id`);
  const byMetric = new Map();
  const byId = new Map();
  for (const d of rows) {
    d.trigger_conditions = d.trigger_conditions || {};
    d.rewards = d.rewards || {};
    byId.set(d.achievement_id, d);
    const t = d.trigger_conditions.type;
    if (!t) continue;
    if (!byMetric.has(t)) byMetric.set(t, []);
    byMetric.get(t).push(d);
  }
  defsCache = { at: Date.now(), list: rows, byMetric, byId };
  return defsCache;
}
function invalidateDefinitions() { defsCache.at = 0; }

// ── 绝对值指标 ────────────────────────────────────────────────
const ABSOLUTE_METRICS = {
  catch_species: 'SELECT COUNT(*)::int AS v FROM pokedex_entries WHERE user_id = $1 AND caught_count > 0',
  friend_count: `SELECT GREATEST(
      (SELECT COUNT(*) FROM friendships WHERE user_a = $1 OR user_b = $1),
      (SELECT COUNT(*) FROM friends WHERE user_id = $1 AND (status IS NULL OR status IN ('accepted', 'active'))))::int AS v`,
  room_pokemon: `SELECT COUNT(*)::int AS v FROM collection_room_pokemon p JOIN collection_rooms r ON r.id = p.room_id WHERE r.user_id = $1`,
  room_shiny: `SELECT COUNT(*)::int AS v FROM collection_room_pokemon p JOIN collection_rooms r ON r.id = p.room_id
                 JOIN pokemon_instances pi ON pi.id = p.pokemon_instance_id WHERE r.user_id = $1 AND pi.is_shiny`,
  room_decorations: `SELECT COUNT(*)::int AS v FROM room_decorations d JOIN collection_rooms r ON r.id = d.room_id WHERE r.user_id = $1`,
  room_likes: 'SELECT COALESCE(MAX(like_count), 0)::int AS v FROM collection_rooms WHERE user_id = $1',
  achievements_unlocked: 'SELECT COUNT(*)::int AS v FROM user_achievements WHERE user_id = $1 AND completed',
  distance_traveled: 'SELECT FLOOR(COALESCE(total_distance_km, 0))::int AS v FROM users WHERE id = $1',
};

async function resolveAbsolute(client, userId, metric) {
  const sql = ABSOLUTE_METRICS[metric];
  if (!sql) return null;
  const { rows } = await client.query(sql, [userId]);
  return rows[0] ? Number(rows[0].v) : 0;
}

// ── 进度推进 ──────────────────────────────────────────────────
/**
 * 单条 upsert 推进进度；返回本次是否"刚完成"（已完成的行不再更新，因此并发下只会有一次返回 true）
 */
async function advance(client, userId, def, value, isIncrement) {
  const target = rules.targetOf(def);
  const { rows } = await client.query(
    `INSERT INTO user_achievements AS ua (user_id, achievement_id, progress, target, completed, completed_at, updated_at)
     VALUES ($1, $2, LEAST($3::int, $4::int), $4::int, $3::int >= $4::int, CASE WHEN $3::int >= $4::int THEN NOW() END, NOW())
     ON CONFLICT (user_id, achievement_id) DO UPDATE SET
       progress = LEAST($4::int, CASE WHEN $5::boolean THEN COALESCE(ua.progress, 0) + $3::int ELSE GREATEST(COALESCE(ua.progress, 0), $3::int) END),
       target = $4::int,
       completed = (CASE WHEN $5::boolean THEN COALESCE(ua.progress, 0) + $3::int ELSE GREATEST(COALESCE(ua.progress, 0), $3::int) END) >= $4::int,
       completed_at = CASE WHEN (CASE WHEN $5::boolean THEN COALESCE(ua.progress, 0) + $3::int ELSE GREATEST(COALESCE(ua.progress, 0), $3::int) END) >= $4::int
                           THEN NOW() END,
       updated_at = NOW()
     WHERE NOT COALESCE(ua.completed, FALSE)
     RETURNING completed`,
    [userId, def.achievement_id, Math.floor(value), target, !!isIncrement],
  );
  return rows.length === 1 && rows[0].completed === true;
}

async function prerequisiteDone(ctx, achievementId) {
  if (!ctx.completedCache) ctx.completedCache = new Map();
  if (ctx.completedCache.has(achievementId)) return ctx.completedCache.get(achievementId);
  const { rows } = await ctx.client.query(
    'SELECT completed FROM user_achievements WHERE user_id = $1 AND achievement_id = $2', [ctx.userId, achievementId]);
  const done = !!(rows[0] && rows[0].completed);
  ctx.completedCache.set(achievementId, done);
  return done;
}

/**
 * 按条件解锁称号并发消息；where 中 $1=userId、$2=来源类型、$3=来源 ID，extra 参数从 $4 开始
 */
async function unlockTitles(ctx, where, extra, sourceType, sourceId) {
  const client = ctx.client;
  const { rows: titleRows } = await client.query(
    `INSERT INTO user_titles (user_id, title_id, source_type, source_id, source_achievement_id, expires_at)
     SELECT $1, td.title_id, $2::varchar, $3::varchar, CASE WHEN $2::text = 'achievement' THEN $3::varchar END,
            CASE WHEN td.is_limited THEN td.available_until END
       FROM title_definitions td
      WHERE td.is_active AND ${where} AND (td.available_until IS NULL OR td.available_until > NOW())
     ON CONFLICT (user_id, title_id) DO NOTHING
     RETURNING title_id`, [ctx.userId, sourceType, String(sourceId), ...extra]);
  if (!titleRows.length) return;
  const { rows: tds } = await client.query(
    'SELECT title_id, name, rarity FROM title_definitions WHERE title_id = ANY($1::text[])', [titleRows.map((t) => t.title_id)]);
  for (const t of tds) {
    ctx.titles.push(t.title_id);
    const note = rules.titleNotification(t);
    note.params._i18n = { 'en-US': { title_name: rules.localize(t.name, 'en-US') }, 'ja-JP': { title_name: rules.localize(t.name, 'ja-JP') } };
    await notificationCenter.notify(client, ctx.userId, note);
  }
}

/** 发放装饰物品（成就/活动奖励）并通知；物品不存在时跳过 */
async function grantDecoration(ctx, itemCode, source, dedupeKey, sourceRef) {
  const client = ctx.client;
  const { rows: [item] } = await client.query('SELECT id, name_i18n FROM decoration_items WHERE item_code = $1', [itemCode]);
  if (!item) return false;
  await client.query(
    `INSERT INTO user_decorations (user_id, item_id, quantity, obtained_from) VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_decorations.quantity + 1`, [ctx.userId, item.id, source]);
  await notificationCenter.notify(client, ctx.userId, {
    type: 'reward.decoration_unlock', templateKey: 'decoration_unlocked', category: 'reward', priority: 'low',
    params: { item_name: rules.localize(item.name_i18n, 'zh-CN'), _i18n: {
      'en-US': { item_name: rules.localize(item.name_i18n, 'en-US') }, 'ja-JP': { item_name: rules.localize(item.name_i18n, 'ja-JP') } } },
    data: { itemCode, source, sourceRef }, actionUrl: '/collection-room', dedupeKey,
  });
  return true;
}

/** 完成后：自动解锁称号、装饰，生成成就/称号消息 */
async function onCompleted(ctx, def) {
  const client = ctx.client;
  ctx.unlocked.push(def);
  if (ctx.completedCache) ctx.completedCache.set(def.achievement_id, true);
  const r = rules.splitRewards(def.rewards);

  await unlockTitles(ctx, `(td.title_id = $4::text OR (td.unlock_type = 'achievement' AND td.unlock_criteria->>'achievement_id' = $3))`,
    [r.title], 'achievement', def.achievement_id);

  if (r.decoration) await grantDecoration(ctx, r.decoration, 'achievement', `deco:${def.achievement_id}`, def.achievement_id);

  const note = rules.achievementNotification(def);
  note.params._i18n = { 'en-US': { achievement_name: rules.localize(def.name, 'en-US') }, 'ja-JP': { achievement_name: rules.localize(def.name, 'ja-JP') } };
  await notificationCenter.notify(client, ctx.userId, note);
}

async function applyEvent(ctx, ev) {
  const data = ev.event_data || {};
  for (const m of rules.deriveMetrics(ev.event_type, data)) {
    const defs = ctx.defs.byMetric.get(m.metric);
    if (!defs || !defs.length) continue;
    let value = m.value;
    if (m.mode === 'abs') value = await resolveAbsolute(ctx.client, ctx.userId, m.metric);
    if (!(Number(value) > 0)) continue;
    for (const def of defs) {
      if (!rules.matchFilters(def.trigger_conditions.filters, m.data)) continue;
      if (def.prerequisite_achievement_id && !(await prerequisiteDone(ctx, def.prerequisite_achievement_id))) continue;
      if (await advance(ctx.client, ctx.userId, def, value, m.mode === 'inc')) await onCompleted(ctx, def);
    }
  }
  // 活动称号：活动完成（领奖）时解锁 unlock_type = 'event' 且 event_id 匹配的称号
  if (ev.event_type === 'event_completed' && data.eventKey) {
    await unlockTitles(ctx, `td.unlock_type = 'event' AND td.unlock_criteria->>'event_id' = $3`, [], 'event', String(data.eventKey));
  }
  // 活动装饰奖励：events.rewards 中 {"type": "decoration", "item": "<item_code>"}（奖励服务的 grantRewards 不认识该类型，这里补发）
  if (ev.event_type === 'event_completed' && data.eventId) {
    const { rows: [e] } = await ctx.client.query('SELECT rewards FROM events WHERE id = $1', [data.eventId]);
    for (const r of Array.isArray(e && e.rewards) ? e.rewards : []) {
      if (r && r.type === 'decoration' && (r.item || r.itemCode)) {
        const code = String(r.item || r.itemCode);
        // 同一活动同一物品只发一次（dedupe 在消息上；这里再用事件 dedupe 保证）
        const { rowCount } = await ctx.client.query(
          `INSERT INTO achievement_events (user_id, event_type, event_data, processed, processed_at, dedupe_key)
           VALUES ($1, 'decoration_granted', $2, TRUE, NOW(), $3) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
          [ctx.userId, JSON.stringify({ itemCode: code, eventId: data.eventId }), `deco:event:${data.eventId}:${code}:${ctx.userId}`]);
        if (rowCount) await grantDecoration(ctx, code, 'event', `deco:event:${data.eventId}:${code}`, data.eventId);
      }
    }
  }
  const note = rules.eventNotification(ev.event_type, data, ctx.names, ev.id);
  if (note) await notificationCenter.notify(ctx.client, ctx.userId, note);
}

async function loadNames(client, ids) {
  const names = new Map();
  if (!ids.length) return names;
  const { rows } = await client.query('SELECT id, nickname FROM users WHERE id = ANY($1::uuid[])', [ids]);
  for (const r of rows) names.set(String(r.id), r.nickname || '训练师');
  return names;
}

/**
 * 处理某玩家的待处理事件
 * @returns {Promise<{processed: number, failed: number, unlocked: string[], titles: string[]}>}
 */
async function processUserEvents(userId, { db = defaultDb(), limit = BATCH } = {}) {
  const t0 = process.hrtime.bigint();
  const out = await db.transaction(async (client) => {
    const { rows: events } = await client.query(
      `SELECT id, event_type, event_data, attempts, created_at FROM achievement_events
        WHERE user_id = $1 AND NOT processed ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [userId, limit]);
    if (!events.length) return { processed: 0, failed: 0, unlocked: [], titles: [], events: [] };
    const ctx = {
      client, userId, defs: await loadDefinitions(client), unlocked: [], titles: [],
      names: await loadNames(client, rules.referencedUserIds(events)),
    };
    const done = [];
    const failed = [];
    for (const ev of events) {
      await client.query('SAVEPOINT game_event');
      try {
        await applyEvent(ctx, ev);
        await client.query('RELEASE SAVEPOINT game_event');
        done.push(ev);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT game_event');
        failed.push({ ev, err });
        logger.warn({ err: err.message, eventId: ev.id, type: ev.event_type, userId }, 'game event failed');
      }
    }
    if (done.length) {
      await client.query(
        `UPDATE achievement_events SET processed = TRUE, processed_at = NOW(), attempts = attempts + 1, last_error = NULL
          WHERE id = ANY($1::int[])`, [done.map((e) => e.id)]);
    }
    for (const { ev, err } of failed) {
      await client.query(
        `UPDATE achievement_events SET attempts = attempts + 1, last_error = $2,
                processed = (attempts + 1 >= $3), processed_at = CASE WHEN attempts + 1 >= $3 THEN NOW() END
          WHERE id = $1`, [ev.id, String(err.message).slice(0, 500), MAX_ATTEMPTS]);
    }
    if (ctx.unlocked.length) {
      await client.query('SELECT achievement_refresh_snapshot($1)', [userId]);
      // 元成就（解锁 N 个成就）在下一轮处理
      await client.query(`SELECT game_event_emit($1, 'achievement_unlocked', $2::jsonb, NULL)`,
        [userId, JSON.stringify({ ids: ctx.unlocked.map((d) => d.achievement_id) })]);
    }
    return { processed: done.length, failed: failed.length, unlocked: ctx.unlocked, titles: ctx.titles, events: done };
  });

  const m = metrics();
  m.latency.observe(Number(process.hrtime.bigint() - t0) / 1e9);
  for (const ev of out.events) {
    m.events.inc({ type: ev.event_type, status: 'ok' });
    if (ev.created_at) m.lag.observe(Math.max(0, (Date.now() - new Date(ev.created_at).getTime()) / 1000));
  }
  if (out.failed) m.events.inc({ type: 'any', status: 'error' }, out.failed);
  for (const d of out.unlocked) m.unlocked.inc({ category: d.category, rarity: d.rarity });
  if (out.titles.length) m.titles.inc({ source: 'achievement' }, out.titles.length);
  if (out.processed) await profileCache.bump(userId);
  // 收藏家积分（REQ-00327 排行榜）：影响积分的事件处理后刷新（失败不影响事件处理）
  if (out.unlocked.length || out.events.some((e) => SCORE_EVENTS.has(e.event_type))) {
    try { await require('./profileStats').refreshCollectorScore(userId, db); } catch (err) {
      logger.warn({ err: err.message, userId }, 'refresh collector score failed');
    }
  }
  return { processed: out.processed, failed: out.failed, unlocked: out.unlocked.map((d) => d.achievement_id), titles: out.titles };
}

/** 处理直到没有待处理事件（含本轮产生的元成就事件），用于接口按需刷新 */
async function drainUser(userId, { db = defaultDb(), rounds = 3 } = {}) {
  const total = { processed: 0, unlocked: [], titles: [] };
  for (let i = 0; i < rounds; i++) {
    const r = await processUserEvents(userId, { db });
    total.processed += r.processed;
    total.unlocked.push(...r.unlocked);
    total.titles.push(...r.titles);
    if (!r.processed) break;
  }
  return total;
}

/** 兜底扫描：处理所有有待处理事件的玩家 */
async function processPendingUsers({ db = defaultDb(), maxUsers = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT user_id FROM achievement_events WHERE NOT processed GROUP BY user_id ORDER BY MIN(id) LIMIT $1`, [maxUsers]);
  let processed = 0;
  for (const r of rows) {
    try { processed += (await processUserEvents(r.user_id, { db })).processed; } catch (err) {
      logger.error({ err: err.message, userId: r.user_id }, 'process pending user failed');
    }
  }
  return { users: rows.length, processed };
}

/**
 * 管理/运维：直接给某成就加进度（完成时同样解锁称号、发消息）
 * @returns {Promise<null|{progress:number,target:number,completed:boolean,completedNow:boolean}>}
 */
async function grantProgress(userId, achievementId, amount = 1, { db = defaultDb() } = {}) {
  const res = await db.transaction(async (client) => {
    const defs = await loadDefinitions(client);
    const def = defs.byId.get(achievementId);
    if (!def) return null;
    const ctx = { client, userId, defs, unlocked: [], titles: [], names: new Map() };
    const completedNow = await advance(client, userId, def, Math.max(1, Math.floor(amount)), true);
    if (completedNow) {
      await onCompleted(ctx, def);
      await client.query('SELECT achievement_refresh_snapshot($1)', [userId]);
      await client.query(`SELECT game_event_emit($1, 'achievement_unlocked', $2::jsonb, NULL)`,
        [userId, JSON.stringify({ ids: [achievementId] })]);
    }
    const { rows: [ua] } = await client.query(
      'SELECT progress, target, completed FROM user_achievements WHERE user_id = $1 AND achievement_id = $2', [userId, achievementId]);
    return { ...ua, completedNow };
  });
  if (res) await profileCache.bump(userId);
  return res;
}

/** JS 侧业务写事件（与业务同一事务） */
async function recordEvent(q, userId, type, data = {}, dedupeKey = null) {
  await q.query('SELECT game_event_emit($1, $2, $3::jsonb, $4)', [userId, type, JSON.stringify(data), dedupeKey]);
}

/**
 * 启动消费者：LISTEN pmg_game_events 实时处理；intervalMs 兜底扫描；每小时清理 30 天前已处理事件与过期消息
 */
function startConsumer({ db = defaultDb(), intervalMs = 10000, cleanupEveryMs = 3600 * 1000 } = {}) {
  let stopped = false;
  let listener = null;
  const pending = new Set();
  let draining = false;
  let lastCleanup = 0;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.size && !stopped) {
        const users = [...pending];
        pending.clear();
        for (const u of users) {
          try { await processUserEvents(u, { db }); } catch (err) { logger.error({ err: err.message, userId: u }, 'process events failed'); }
        }
      }
    } finally { draining = false; }
  }

  async function listen() {
    if (stopped) return;
    try {
      listener = await db.getPool().connect();
      listener.on('notification', (msg) => {
        if (msg.channel === 'pmg_game_events' && msg.payload) { pending.add(msg.payload); setImmediate(drain); }
      });
      listener.on('error', (err) => { logger.warn({ err: err.message }, 'game event listener error, reconnecting'); reconnect(); });
      await listener.query('LISTEN pmg_game_events');
      logger.info('game event consumer listening');
    } catch (err) {
      logger.warn({ err: err.message }, 'game event listener connect failed, retry in 5s');
      reconnect();
    }
  }
  function reconnect() {
    if (listener) { try { listener.release(true); } catch { /* 已释放 */ } listener = null; }
    if (!stopped) setTimeout(listen, 5000).unref();
  }

  const timer = setInterval(async () => {
    try {
      await processPendingUsers({ db });
      if (Date.now() - lastCleanup > cleanupEveryMs) {
        lastCleanup = Date.now();
        await db.query(`DELETE FROM achievement_events WHERE id IN (
          SELECT id FROM achievement_events WHERE processed AND processed_at < NOW() - INTERVAL '30 days' LIMIT 5000)`);
        await notificationCenter.cleanupExpired(db);
      }
    } catch (err) { logger.error({ err: err.message }, 'game event sweep failed'); }
  }, intervalMs);
  timer.unref();
  listen();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (listener) { listener.query('UNLISTEN *').catch(() => {}).finally(() => { try { listener.release(); } catch { /* ignore */ } }); }
    },
    kick(userId) { pending.add(userId); setImmediate(drain); },
  };
}

module.exports = {
  loadDefinitions, invalidateDefinitions, processUserEvents, drainUser, processPendingUsers, recordEvent, startConsumer, grantProgress,
  advance, ABSOLUTE_METRICS, MAX_ATTEMPTS,
};
