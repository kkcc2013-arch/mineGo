/**
 * REQ-00383：捕捉结果批处理与异步持久化
 *
 * 模式（环境变量 CATCH_PERSISTENCE_MODE）：
 *   sync（默认）：与改造前完全一致——投掷日志与奖励在请求内逐条写库。
 *   batch：
 *     1) 关键写仍同步且在同一个可串行化事务内：抢占野生精灵（is_caught 条件更新，保证一只只能被一人捕获）、
 *        创建精灵实例、关闭捕捉会话（E05 的成就触发器挂在这里）——不能异步：否则会重复捕获/响应里的实例 ID 不存在；
 *     2) 奖励类写（users.xp/stardust、candy_inventory、pokedex_entries、user_achievements）改为在同一事务里写一行
 *        catch_reward_outbox（事务提交 = 奖励已持久化，进程崩溃不丢），由批量 applier 按用户/物种聚合写入；
 *        applier 在一个事务里"条件更新 outbox 为 applied + 写聚合结果"，恰好一次；
 *     3) 投掷日志 catch_throws 预写到 Redis Stream（XADD，带预生成 UUID），批量 INSERT ... ON CONFLICT (id) DO NOTHING，
 *        提交后 XACK+XDEL；XADD 失败时回退同步 INSERT（不丢）。
 *   刷写：积压达到 CATCH_BATCH_SIZE（默认 50）或每 CATCH_BATCH_INTERVAL_MS（默认 500ms）；关停时 drain；
 *   失败：批写失败逐条重试隔离毒消息，指数退避；同一条失败 CATCH_BATCH_MAX_RETRIES（默认 3）次进死信表 catch_persist_failures。
 *
 * 取舍（写进需求实现记录）：
 *   - 不采用"先返回再写库"：抢占与实例创建必须同步，才能保证不重复捕获、响应中的 pokemonInstanceId 立即可用；
 *   - batch 模式下 XP/星尘/糖果/图鉴最多延迟一个刷写周期（默认 ≤0.5s）可见；
 *   - 投掷日志的持久性取决于 Redis 的 AOF 配置（Redis 丢数据时最多丢失未刷写的投掷审计日志，不涉及精灵与奖励）。
 *
 * 对齐（PARITY）：handleCatchBatched 必须与 index.js 的 handleCatch 写入相同的业务结果；
 *   tests/unit/catch-batch-persistence.test.js 会读取两份源码比对奖励常量、实例插入列与成就计数，漂移即失败。
 */
'use strict';

const os = require('os');
const crypto = require('crypto');
const { BatchFlusher } = require('../../../../shared/batch/BatchFlusher');
const { aggregateRewardRows, toUnnestParams } = require('./rewardAggregation');

// ── 奖励常量（PARITY：与 index.js handleCatch 一致）────────────────
const XP_BY_RATING = { NICE: 120, GREAT: 170, EXCELLENT: 200 };
const BASE_XP = 100;
const CURVE_XP = 10;
const SHINY_XP = 500;
const STARDUST = 100;
const CANDY = 3;
// 同步路径在事务里给 user_achievements('catch_total') +1；E05 合入后改由 catch_sessions 触发器计数，届时两处一起删除/置 false
const INCREMENT_CATCH_ACHIEVEMENT = true;

const THROW_STREAM = 'catch:wal:throws';
const THROW_GROUP = 'catch-throw-writers';

function config(env = process.env) {
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    mode: String(env.CATCH_PERSISTENCE_MODE || 'sync').toLowerCase() === 'batch' ? 'batch' : 'sync',
    batchSize: int(env.CATCH_BATCH_SIZE, 50),
    intervalMs: int(env.CATCH_BATCH_INTERVAL_MS, 500),
    maxRetries: int(env.CATCH_BATCH_MAX_RETRIES, 3),
    queueAlertLength: int(env.CATCH_BATCH_QUEUE_MAX_LENGTH, 10000),
    idleDrainMs: int(env.CATCH_BATCH_IDLE_DRAIN_MS, 30000),   // sync 模式下清理切换前遗留积压的周期
    claimIdleMs: int(env.CATCH_BATCH_CLAIM_IDLE_MS, 60000),   // 认领已死消费者未确认消息的空闲阈值
  };
}

function computeCatchRewards(session, throwRating, isCurve) {
  const baseXp = XP_BY_RATING[throwRating] || BASE_XP;
  const xp = baseXp + (isCurve ? CURVE_XP : 0) + (session.isShiny ? SHINY_XP : 0);
  return { xp, stardust: STARDUST, candy: CANDY };
}

// ── 投掷日志：Redis Stream 源 ──────────────────────────────────────
function createThrowWalSource({ redis, stream = THROW_STREAM, group = THROW_GROUP, consumer, claimIdleMs = 60000, logger }) {
  const me = consumer || `${os.hostname()}:${process.pid}`;
  let groupReady = false;
  let lastClaimAt = 0;
  const parse = (fields) => {
    const i = fields.indexOf('d');
    return i >= 0 ? JSON.parse(fields[i + 1]) : null;
  };
  async function ensureGroup() {
    if (groupReady) return;
    try { await redis().xgroup('CREATE', stream, group, '0', 'MKSTREAM'); }
    catch (err) { if (!/BUSYGROUP/.test(String(err && err.message))) throw err; }
    groupReady = true;
  }
  async function claimAbandoned(max) {
    // 认领已退出消费者（旧进程）长时间未确认的消息；XPENDING + XCLAIM 兼容 Redis 5+
    const now = Date.now();
    if (now - lastClaimAt < Math.min(claimIdleMs, 30000)) return;
    lastClaimAt = now;
    const pend = await redis().xpending(stream, group, '-', '+', max);
    const ids = (pend || []).filter((p) => p[1] !== me && Number(p[2]) >= claimIdleMs).map((p) => p[0]);
    if (ids.length) {
      await redis().xclaim(stream, group, me, claimIdleMs, ...ids);
      logger && logger.warn({ count: ids.length }, 'claimed abandoned catch throw WAL entries');
    }
  }
  return {
    consumer: me,
    async append(record) {
      await ensureGroup();
      return redis().xadd(stream, '*', 'd', JSON.stringify(record));
    },
    async read(max) {
      await ensureGroup();
      await claimAbandoned(max).catch((err) => logger && logger.warn({ err: err.message }, 'WAL claim failed'));
      // 先读自己已投递未确认的（上次失败待重试 / 刚认领的），再读新消息
      let res = await redis().xreadgroup('GROUP', group, me, 'COUNT', max, 'STREAMS', stream, '0');
      let list = res && res[0] && res[0][1] ? res[0][1].filter((e) => e[1]) : [];
      if (!list.length) {
        res = await redis().xreadgroup('GROUP', group, me, 'COUNT', max, 'STREAMS', stream, '>');
        list = res && res[0] && res[0][1] ? res[0][1] : [];
      }
      const out = [];
      for (const [id, fields] of list) {
        let payload = null;
        try { payload = parse(fields); } catch { payload = null; }
        if (payload) out.push({ id, payload });
        else { await redis().xack(stream, group, id); await redis().xdel(stream, id); } // 损坏的消息直接丢弃确认
      }
      return out;
    },
    async ack(ids) {
      if (!ids.length) return;
      await redis().xack(stream, group, ...ids);
      await redis().xdel(stream, ...ids);
    },
    async size() {
      const [len, pend] = await Promise.all([redis().xlen(stream), redis().xpending(stream, group).catch(() => null)]);
      return { length: Number(len || 0), pending: pend ? Number(pend[0] || 0) : 0 };
    },
  };
}

// ── 投掷日志：批量 INSERT ───────────────────────────────────────────
const THROW_INSERT_SQL = `
  INSERT INTO catch_throws (id, session_id, ball_type, throw_rating, is_curve, berry_used, catch_prob, success, thrown_at)
  SELECT t.id, t.session_id, t.ball_type::ball_type_enum, t.throw_rating::throw_rating_enum, t.is_curve, t.berry_used, t.catch_prob, t.success, t.thrown_at
    FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::numeric[], $8::boolean[], $9::timestamptz[])
      AS t(id, session_id, ball_type, throw_rating, is_curve, berry_used, catch_prob, success, thrown_at)
  ON CONFLICT (id) DO NOTHING`;

function throwParams(rows) {
  return [
    rows.map((r) => r.id), rows.map((r) => r.sessionId), rows.map((r) => r.ballType), rows.map((r) => r.throwRating),
    rows.map((r) => !!r.isCurve), rows.map((r) => r.berryUsed || 'NONE'), rows.map((r) => Number(r.catchProb)),
    rows.map((r) => !!r.success), rows.map((r) => r.thrownAt || new Date().toISOString()),
  ];
}

function createThrowSink({ query }) {
  return { async write(payloads) { await query(THROW_INSERT_SQL, throwParams(payloads)); } };
}

// ── 奖励 outbox：数据库源 + 恰好一次 applier ─────────────────────────
function createOutboxSource({ query }) {
  return {
    async read(max) {
      const { rows } = await query(
        `SELECT id, session_id, user_id, species_id, xp, stardust, candy, cp, is_shiny, count_achievement, caught_at
           FROM catch_reward_outbox WHERE status = 'pending' ORDER BY id LIMIT $1`, [max]);
      return rows.map((r) => ({ id: String(r.id), payload: r }));
    },
    async ack() { /* applier 已在同一事务内把行标记为 applied */ },
    async size() {
      const { rows } = await query(
        `SELECT (SELECT COUNT(*)::int FROM catch_reward_outbox WHERE status = 'pending') AS pending,
                (SELECT COUNT(*)::int FROM catch_reward_outbox WHERE status = 'dead') AS dead,
                (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int FROM catch_reward_outbox WHERE status = 'pending') AS oldest_pending_sec`);
      return rows[0] || { pending: 0, dead: 0, oldest_pending_sec: null };
    },
  };
}

function createOutboxApplier({ transaction }) {
  return {
    async write(payloads) {
      const ids = payloads.map((p) => Number(p.id));
      await transaction(async (client) => {
        // 条件更新 = 认领：已被其他实例应用过的行不会返回，因此不会重复发奖
        const { rows } = await client.query(
          `UPDATE catch_reward_outbox SET status = 'applied', applied_at = NOW(), attempts = attempts + 1
            WHERE id = ANY($1::bigint[]) AND status = 'pending'
            RETURNING id, user_id, species_id, xp, stardust, candy, cp, is_shiny, count_achievement, caught_at`, [ids]);
        if (!rows.length) return;
        const p = toUnnestParams(aggregateRewardRows(rows));
        if (p.users[0].length) {
          await client.query(
            `UPDATE users u SET xp = u.xp + v.xp, stardust = u.stardust + v.stardust
               FROM UNNEST($1::uuid[], $2::bigint[], $3::int[]) AS v(user_id, xp, stardust)
              WHERE u.id = v.user_id`, p.users);
        }
        if (p.candy[0].length) {
          await client.query(
            `INSERT INTO candy_inventory (user_id, species_id, amount)
             SELECT * FROM UNNEST($1::uuid[], $2::smallint[], $3::int[])
             ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + EXCLUDED.amount`, p.candy);
        }
        if (p.pokedex[0].length) {
          await client.query(
            `INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at, best_cp, has_shiny)
             SELECT v.user_id, v.species_id, 1, v.n, v.first_at, v.best_cp, v.shiny
               FROM UNNEST($1::uuid[], $2::smallint[], $3::int[], $4::int[], $5::boolean[], $6::timestamptz[])
                 AS v(user_id, species_id, n, best_cp, shiny, first_at)
             ON CONFLICT (user_id, species_id) DO UPDATE SET
               caught_count = pokedex_entries.caught_count + EXCLUDED.caught_count,
               best_cp = GREATEST(pokedex_entries.best_cp, EXCLUDED.best_cp),
               has_shiny = pokedex_entries.has_shiny OR EXCLUDED.has_shiny`, p.pokedex);
        }
        if (p.achievements[0].length) {
          await client.query(
            `INSERT INTO user_achievements (user_id, achievement_id, current_value, updated_at)
             SELECT v.user_id, 'catch_total', v.n, NOW() FROM UNNEST($1::uuid[], $2::int[]) AS v(user_id, n)
             ON CONFLICT (user_id, achievement_id) DO UPDATE SET
               current_value = user_achievements.current_value + EXCLUDED.current_value, updated_at = NOW()`, p.achievements);
        }
      });
    },
  };
}

// ── 死信 ────────────────────────────────────────────────────────
function createDeadLetter({ query, kind }) {
  return async (entry, err, attempts) => {
    if (kind === 'reward') {
      await query(`UPDATE catch_reward_outbox SET status = 'dead', last_error = $2, attempts = $3 WHERE id = $1 AND status = 'pending'`,
        [Number(entry.id), String(err && err.message || err).slice(0, 1000), attempts]);
    }
    await query(
      `INSERT INTO catch_persist_failures (kind, entry_id, payload, error, attempts) VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [kind, String(entry.id), JSON.stringify(entry.payload || {}), String(err && err.message || err).slice(0, 1000), attempts]);
  };
}

// ── 运行时（catch-service 进程内单例）─────────────────────────────────
let runtime = null;

function metricsHooks(kind) {
  try {
    const m = require('../../../../shared/metrics');
    if (!metricsHooks.cache) {
      metricsHooks.cache = {
        flushed: m.counter('catch_batch_flushed_total', 'REQ-00383 批量持久化写入条数', ['kind']),
        failed: m.counter('catch_batch_retry_total', 'REQ-00383 批量持久化失败待重试条数', ['kind']),
        dead: m.counter('catch_batch_dead_letter_total', 'REQ-00383 进入死信的条数', ['kind']),
        latency: m.histogram('catch_batch_flush_duration_ms', 'REQ-00383 单次批量刷写耗时（ms）', ['kind'], [5, 10, 25, 50, 100, 250, 500, 1000, 2500]),
        queue: m.gauge('catch_batch_queue_length', 'REQ-00383 待持久化积压（throws=Stream 长度，rewards=outbox pending）', ['kind']),
        lag: m.gauge('catch_batch_processing_latency_seconds', 'REQ-00383 最老未应用奖励的等待时长（秒）', ['kind']),
      };
    }
    const c = metricsHooks.cache;
    return {
      onFlush: ({ written, failed, deadLettered, ms }) => {
        if (written) c.flushed.inc({ kind }, written);
        if (failed) c.failed.inc({ kind }, failed);
        if (deadLettered) c.dead.inc({ kind }, deadLettered);
        c.latency.observe({ kind }, ms);
      },
      gauges: c,
    };
  } catch {
    return null;
  }
}

/**
 * 启动（catch-service postInit 调用）。sync 模式也启动低频清理，保证从 batch 切回 sync 时遗留积压仍会被写入。
 */
function startCatchPersistence({ logger } = {}) {
  if (runtime) return runtime;
  const cfg = config();
  const db = require('../../../../shared/db');
  const { getRedis } = require('../../../../shared/redis');
  const log = logger || { info() {}, warn() {}, error() {} };
  const interval = cfg.mode === 'batch' ? cfg.intervalMs : cfg.idleDrainMs;

  const walSource = createThrowWalSource({ redis: getRedis, claimIdleMs: cfg.claimIdleMs, logger: log });
  const outboxSource = createOutboxSource({ query: db.query });
  const tm = metricsHooks('throws');
  const rm = metricsHooks('rewards');
  const throwFlusher = new BatchFlusher({
    name: 'catch-throws', source: walSource, sink: createThrowSink({ query: db.query }),
    maxBatch: cfg.batchSize, intervalMs: interval, maxRetries: cfg.maxRetries,
    deadLetter: createDeadLetter({ query: db.query, kind: 'throw' }), logger: log, metrics: tm,
  });
  const rewardFlusher = new BatchFlusher({
    name: 'catch-rewards', source: outboxSource, sink: createOutboxApplier({ transaction: db.transaction }),
    maxBatch: cfg.batchSize, intervalMs: interval, maxRetries: cfg.maxRetries,
    deadLetter: createDeadLetter({ query: db.query, kind: 'reward' }), logger: log, metrics: rm,
  });
  throwFlusher.start();
  rewardFlusher.start();

  // 积压监控（队列长度告警阈值 CATCH_BATCH_QUEUE_MAX_LENGTH）
  let lastCleanup = Date.now();
  const monitor = setInterval(async () => {
    try {
      const s = await status();
      if (tm && tm.gauges) {
        tm.gauges.queue.set({ kind: 'throws' }, s.throws.length || 0);
        tm.gauges.queue.set({ kind: 'rewards' }, s.rewards.pending || 0);
        tm.gauges.lag.set({ kind: 'rewards' }, s.rewards.oldest_pending_sec || 0);
      }
      // 已应用的 outbox 行保留 7 天（一致性核对/审计），之后清理（多实例用 Redis 锁只做一次）
      if (Date.now() - lastCleanup > 3600_000) {
        lastCleanup = Date.now();
        const locked = await getRedis().set('lock:catch:outbox-cleanup', process.pid, 'EX', 3000, 'NX');
        if (locked) {
          await db.query(`DELETE FROM catch_reward_outbox WHERE status = 'applied' AND applied_at < NOW() - INTERVAL '7 days'`);
        }
      }
      if ((s.throws.length || 0) > cfg.queueAlertLength || (s.rewards.pending || 0) > cfg.queueAlertLength) {
        log.error({ throws: s.throws, rewards: s.rewards }, 'catch batch persistence backlog above threshold');
      }
    } catch (err) { log.warn({ err: err.message }, 'catch persistence monitor failed'); }
  }, 15000);
  if (monitor.unref) monitor.unref();

  async function status() {
    const [throws, rewards] = await Promise.all([
      walSource.size().catch((e) => ({ error: e.message })),
      outboxSource.size().catch((e) => ({ error: e.message })),
    ]);
    return { mode: cfg.mode, config: cfg, throws, rewards, flushers: { throws: throwFlusher.getStats(), rewards: rewardFlusher.getStats() } };
  }

  runtime = {
    cfg, walSource, throwFlusher, rewardFlusher, status, log,
    async stop() {
      clearInterval(monitor);
      const [a, b] = await Promise.all([
        throwFlusher.stop({ drain: true, timeoutMs: 4000 }),
        rewardFlusher.stop({ drain: true, timeoutMs: 4000 }),
      ]);
      log.info({ throws: a, rewards: b }, 'catch batch persistence drained on shutdown');
    },
  };
  log.info({ mode: cfg.mode, batchSize: cfg.batchSize, intervalMs: interval }, 'catch persistence started');
  return runtime;
}

function isBatchMode() { return (runtime ? runtime.cfg.mode : config().mode) === 'batch'; }

/**
 * 记录一次投掷（替代 index.js 里直接 INSERT catch_throws）
 * sync：与原 SQL 相同；batch：XADD 预写，失败回退同步写。
 */
async function recordThrow(row) {
  const db = require('../../../../shared/db');
  const syncInsert = () => db.query(
    `INSERT INTO catch_throws (session_id,ball_type,throw_rating,is_curve,berry_used,catch_prob,success)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.sessionId, row.ballType, row.throwRating, row.isCurve || false, row.berryUsed || 'NONE', row.catchProb, !!row.success]);
  if (!isBatchMode() || !runtime) return syncInsert();
  const rec = { ...row, id: crypto.randomUUID(), isCurve: !!row.isCurve, berryUsed: row.berryUsed || 'NONE', success: !!row.success, thrownAt: new Date().toISOString() };
  try {
    await runtime.walSource.append(rec);
    runtime.throwFlusher.notify(1);
  } catch (err) {
    runtime.log.warn({ err: err.message }, 'catch throw WAL append failed, writing synchronously');
    await syncInsert();
  }
}

/**
 * batch 模式的捕捉成功处理（PARITY：与 index.js handleCatch 同样的抢占/实例/会话写入与奖励数值）
 * @param {{ userId, session, throwRating, isCurve, sessionId, logger, afterCommit }} ctx
 *        afterCommit(result) 由调用方执行缓存失效/事件发布等提交后副作用
 */
async function handleCatchBatched({ userId, session, throwRating, isCurve, sessionId, logger }) {
  const { transactionSerializable } = require('../../../../shared/transactionManager');
  const { AppError } = require('../../../../shared/auth');
  let titles = null;
  try { titles = require('../../../../shared/titles'); } catch { titles = null; } // E05 称号经验加成（合入后自动对齐）
  const base = computeCatchRewards(session, throwRating, isCurve);
  let xp = base.xp;
  const { stardust, candy } = base;

  const result = await transactionSerializable(async (client) => {
    const claimed = await client.query({
      name: 'claim_wild_pokemon_caught',
      text: 'UPDATE wild_pokemon SET is_caught=true, caught_by=$1 WHERE id=$2 AND is_caught=false',
      values: [userId, session.wildId],
    });
    if (claimed.rowCount === 0) throw new AppError(3001, '精灵已消失或被捕获', 409);

    if (titles && typeof titles.expBonus === 'function') {
      xp = Math.round(base.xp * (1 + await titles.expBonus(client, userId)));
    }

    const { rows: learnset } = await client.query(`
      SELECT move_id, m.category
      FROM pokemon_moves pm
      JOIN moves m ON pm.move_id = m.id
      WHERE pm.species_id = $1 AND pm.learn_method IN ('TM', 'LEVEL_UP')
    `, [session.speciesId]);
    const fastMoves = learnset.filter((m) => m.category === 'FAST');
    const chargeMoves = learnset.filter((m) => m.category === 'CHARGE');
    const randomFast = fastMoves.length ? fastMoves[Math.floor(Math.random() * fastMoves.length)].move_id : 'TACKLE';
    const randomCharge = chargeMoves.length ? chargeMoves[Math.floor(Math.random() * chargeMoves.length)].move_id : 'STRUGGLE';

    const { rows: [instance] } = await client.query(`
      INSERT INTO pokemon_instances
        (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
         is_shiny, is_lucky, is_zero_iv, is_perfect_iv, caught_lat, caught_lng, fast_move, charge_move,
         learned_fast_moves, learned_charge_moves)
      SELECT $1,$2,$3,$4,$4,$5,$6,$7,$8,false,$9,$10,
             (SELECT last_lat FROM users WHERE id=$1),
             (SELECT last_lng FROM users WHERE id=$1),
             $11::text, $12::text, ARRAY[$11::text], ARRAY[$12::text]
      RETURNING id
    `, [userId, session.speciesId, session.cp, Math.floor(session.cp * 0.8),
      session.iv_attack, session.iv_defense, session.iv_hp, session.isShiny,
      session.isZeroIv || false, session.isPerfectIv || false, randomFast, randomCharge]);

    await client.query(`
      UPDATE catch_sessions SET ended_at=NOW(), result='CAUGHT', balls_used=$2,
        instance_id=$3, xp_earned=$4, stardust_earned=$5, candy_earned=$6
      WHERE id=$1
    `, [sessionId, session.ballsThrown, instance.id, xp, stardust, candy]);

    // 奖励写入 outbox（与抢占/实例同事务提交；applier 聚合写 users/candy/pokedex/成就）
    await client.query(`
      INSERT INTO catch_reward_outbox (session_id, user_id, species_id, xp, stardust, candy, cp, is_shiny, count_achievement, caught_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (session_id) DO NOTHING
    `, [sessionId, userId, session.speciesId, xp, stardust, candy, session.cp, !!session.isShiny, INCREMENT_CATCH_ACHIEVEMENT]);

    return {
      pokemonInstanceId: instance.id,
      pokemon: {
        speciesId: session.speciesId,
        name: session.name_zh,
        cp: session.cp,
        isShiny: session.isShiny,
        iv: { attack: session.iv_attack, defense: session.iv_defense, hp: session.iv_hp },
      },
      rewards: { xp, stardust, candy },
    };
  });

  if (runtime) runtime.rewardFlusher.notify(1);

  // 提交后副作用（与 handleCatch 相同）
  const pokemonInstanceId = result.pokemonInstanceId;
  setImmediate(async () => {
    try {
      const { getAbilityIntegration } = require('../abilityIntegration');
      await getAbilityIntegration().assignAbilitiesOnCatch(pokemonInstanceId, session.speciesId, {
        isEventSpawn: session.weatherBoosted === 'EVENT',
      });
    } catch (err) {
      logger && logger.error({ err, pokemonInstanceId, speciesId: session.speciesId }, 'Failed to assign abilities');
    }
  });
  const { getRedis } = require('../../../../shared/redis');
  const redis = getRedis();
  Promise.all([redis.zrem('geo:wild_pokemon', String(session.wildId)), redis.del(`wild:${session.wildId}`)])
    .catch((err) => logger && logger.error({ err, wildId: session.wildId }, 'Failed to invalidate wild pokemon cache'));
  const { publishCatchSuccess } = require('../eventProducers');
  publishCatchSuccess(userId, result.pokemon, result.rewards, sessionId)
    .catch((err) => logger && logger.error({ err }, 'Failed to publish catch success event'));

  return result;
}

/**
 * 补偿：把死信重新投入处理（管理员触发）。奖励死信恢复为 pending 由 applier 重做（仍是恰好一次）；
 * 投掷死信直接用批量 INSERT（ON CONFLICT DO NOTHING，重复执行无副作用）。
 */
async function retryDeadLetters({ limit = 500 } = {}) {
  const db = require('../../../../shared/db');
  const n = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  const rewards = await db.query(
    `UPDATE catch_reward_outbox SET status = 'pending', attempts = 0, last_error = NULL
      WHERE id IN (SELECT id FROM catch_reward_outbox WHERE status = 'dead' ORDER BY id LIMIT $1) RETURNING id`, [n]);
  const { rows: throwRows } = await db.query(
    `SELECT id, payload FROM catch_persist_failures WHERE kind = 'throw' AND resolved_at IS NULL ORDER BY id LIMIT $1`, [n]);
  let throwsRetried = 0;
  if (throwRows.length) {
    await db.query(THROW_INSERT_SQL, throwParams(throwRows.map((r) => r.payload)));
    throwsRetried = throwRows.length;
  }
  await db.query(
    `UPDATE catch_persist_failures SET resolved_at = NOW()
      WHERE resolved_at IS NULL AND (id = ANY($1::bigint[]) OR (kind = 'reward' AND entry_id = ANY($2::text[])))`,
    [throwRows.map((r) => r.id), rewards.rows.map((r) => String(r.id))]);
  if (runtime) runtime.rewardFlusher.notify(runtime.cfg.batchSize);
  return { rewardsRequeued: rewards.rowCount || rewards.rows.length, throwsRetried };
}

async function getPersistenceStatus() {
  if (!runtime) return { mode: config().mode, started: false };
  return { started: true, ...(await runtime.status()) };
}

async function stopCatchPersistence() {
  if (!runtime) return;
  const r = runtime;
  runtime = null;
  await r.stop();
}

module.exports = {
  // 运行时
  startCatchPersistence, stopCatchPersistence, getPersistenceStatus, isBatchMode, recordThrow, handleCatchBatched, retryDeadLetters,
  // 可测试的组件
  config, computeCatchRewards, createThrowWalSource, createThrowSink, createOutboxSource, createOutboxApplier, createDeadLetter,
  throwParams, THROW_INSERT_SQL, THROW_STREAM, THROW_GROUP,
  // 对齐常量（parity 测试读取）
  XP_BY_RATING, BASE_XP, CURVE_XP, SHINY_XP, STARDUST, CANDY, INCREMENT_CATCH_ACHIEVEMENT,
};
