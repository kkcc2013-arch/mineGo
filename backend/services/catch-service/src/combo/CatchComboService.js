/**
 * REQ-00369：捕捉连击 —— 数据访问与奖励发放
 *
 * 一致性与幂等：
 *   - 每次捕捉会话（catch_sessions.id）最多记一次连击事件：catch_combo_events.session_id 主键，
 *     INSERT ... ON CONFLICT DO NOTHING 抢占成功才更新连击/发奖（同一事务，失败整体回滚）；
 *   - catch_combos 行 SELECT ... FOR UPDATE 串行化同一玩家的并发捕捉；
 *   - 连击在捕捉事务提交之后记录：连击失败只影响连击本身，不影响捕捉结果（调用方 try/catch）。
 * 缓存：
 *   - catch:combo:{userId}（状态，24h）、catch:combo:lb（最高连击 ZSET，排行榜实时更新）。
 * 依赖全部可注入（单测用假实现，不需要 pg/ioredis）。
 */
'use strict';

const rules = require('./comboRules');

const STATUS_KEY = (userId) => `catch:combo:${userId}`;
const LB_KEY = 'catch:combo:lb';
const TIER_TTL_MS = 60_000;
const SHIELD_ITEM = 'COMBO_SHIELD';

function lazyDefaults() {
  const db = require('../../../../shared/db');
  const { getRedis } = require('../../../../shared/redis');
  const inventory = require('../../../../shared/inventory');
  return {
    query: db.query,
    transaction: db.transaction,
    redis: () => getRedis(),
    addItems: inventory.addItems,
    consumeItem: inventory.consumeItem,
  };
}

class CatchComboService {
  /**
   * @param {object} [deps]
   * @param {Function} deps.query          (sql, params) => { rows }
   * @param {Function} deps.transaction    (fn(client)) => result
   * @param {Function} deps.redis          () => ioredis 兼容客户端（可为 null：不用缓存）
   * @param {Function} deps.addItems       (client, userId, [{type, qty}])
   * @param {Function} deps.consumeItem    (client, userId, itemId, qty) => boolean
   * @param {Function} [deps.onMilestone]  ({ userId, milestone, maxCombo }) => void（通知）
   * @param {Function} [deps.now]          () => Date
   * @param {object}   [deps.logger]
   * @param {object}   [deps.config]       覆盖 comboRules.DEFAULT_CONFIG
   */
  constructor(deps = {}) {
    const d = { ...(deps.query ? {} : lazyDefaults()), ...deps };
    this.query = d.query;
    this.transaction = d.transaction;
    this.redis = d.redis || (() => null);
    this.addItems = d.addItems;
    this.consumeItem = d.consumeItem;
    this.onMilestone = d.onMilestone || null;
    this.now = d.now || (() => new Date());
    this.logger = d.logger || console;
    this.config = { ...rules.DEFAULT_CONFIG, ...(d.config || {}) };
    if (process.env.COMBO_TIMEOUT_MINUTES && !(d.config && d.config.timeoutMinutes)) {
      const m = Number(process.env.COMBO_TIMEOUT_MINUTES);
      if (Number.isFinite(m) && m > 0) this.config.timeoutMinutes = m;
    }
    this._tiers = null;
    this._tiersAt = 0;
  }

  // ── 配置 ────────────────────────────────────────────────────
  async getTiers(force = false) {
    if (!force && this._tiers && Date.now() - this._tiersAt < TIER_TTL_MS) return this._tiers;
    try {
      const { rows } = await this.query(
        `SELECT combo_threshold, reward_type, reward_amount, bonus_multiplier, special_rewards
           FROM catch_combo_rewards WHERE is_active = TRUE ORDER BY combo_threshold`);
      this._tiers = rows.length ? rules.normalizeTiers(rows) : rules.normalizeTiers(rules.DEFAULT_REWARD_TIERS);
    } catch (err) {
      this.logger.warn && this.logger.warn({ err: err.message }, 'load combo tiers failed, using defaults');
      this._tiers = rules.normalizeTiers(rules.DEFAULT_REWARD_TIERS);
    }
    this._tiersAt = Date.now();
    return this._tiers;
  }

  /** 运营更新档位：整表替换（事务内），返回新档位 */
  async replaceTiers(input, adminId) {
    const v = rules.validateTierInput(input);
    if (!v.ok) { const e = new Error(v.errors.join('; ')); e.httpStatus = 400; e.code = 1001; throw e; }
    await this.transaction(async (client) => {
      await client.query('UPDATE catch_combo_rewards SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE');
      for (const t of v.tiers) {
        await client.query(
          `INSERT INTO catch_combo_rewards (combo_threshold, reward_type, reward_amount, bonus_multiplier, special_rewards, is_active, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6, NOW())
           ON CONFLICT (combo_threshold) DO UPDATE SET reward_type = EXCLUDED.reward_type, reward_amount = EXCLUDED.reward_amount,
             bonus_multiplier = EXCLUDED.bonus_multiplier, special_rewards = EXCLUDED.special_rewards, is_active = TRUE,
             updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [t.threshold, t.rewardType, t.rewardAmount, t.bonusMultiplier, JSON.stringify(t.specialRewards), adminId || null]);
      }
    });
    this._tiers = null;
    return this.getTiers(true);
  }

  // ── 状态 ────────────────────────────────────────────────────
  async _lockState(client, userId) {
    await client.query(
      'INSERT INTO catch_combos (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const { rows } = await client.query('SELECT * FROM catch_combos WHERE user_id = $1 FOR UPDATE', [userId]);
    return rules.normalizeState(rows[0]);
  }

  async _saveState(client, userId, state) {
    const r = rules.toRow(state);
    await client.query(
      `UPDATE catch_combos SET current_combo = $2, max_combo = $3, combo_started_at = $4, last_catch_time = $5,
              protection_charges = $6, protected_until = $7, pokemon_ids = $8::uuid[], combo_rewards = $9::jsonb, updated_at = NOW()
        WHERE user_id = $1`,
      [userId, r.current_combo, r.max_combo, r.combo_started_at, r.last_catch_time, r.protection_charges,
        r.protected_until, r.pokemon_ids.filter(isUuid), JSON.stringify(r.combo_rewards || {})]);
  }

  async _archive(client, userId, archived) {
    if (!archived || !archived.comboCount) return;
    await client.query(
      `INSERT INTO catch_combo_history (user_id, combo_count, pokemon_ids, total_rewards, started_at, ended_at, end_reason)
       VALUES ($1, $2, $3::uuid[], $4::jsonb, $5, $6, $7)`,
      [userId, archived.comboCount, (archived.pokemonIds || []).filter(isUuid), JSON.stringify(archived.totalRewards || {}),
        archived.startedAt || archived.endedAt, archived.endedAt, archived.endReason]);
  }

  async _grant(client, userId, rewards) {
    const sets = [];
    const params = [userId];
    if (rewards.xp > 0) { params.push(rewards.xp); sets.push(`xp = xp + $${params.length}`); }
    if (rewards.coins > 0) { params.push(rewards.coins); sets.push(`coins = coins + $${params.length}`); }
    if (rewards.premiumCoins > 0) { params.push(rewards.premiumCoins); sets.push(`premium_coins = premium_coins + $${params.length}`); }
    if (sets.length) await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    const items = (rewards.items || []).map((x) => ({ type: x.item, qty: x.amount }));
    if (items.length && this.addItems) {
      const r = await this.addItems(client, userId, items);
      return r && r.skipped ? r.skipped : [];
    }
    return [];
  }

  async _cache(userId, state) {
    const redis = this.redis();
    if (!redis) return;
    try {
      const st = rules.effectiveStatus(state, this.now(), this.config);
      await redis.set(STATUS_KEY(userId), JSON.stringify(st), 'EX', 86400);
      if (st.maxCombo > 0) await redis.zadd(LB_KEY, st.maxCombo, String(userId));
    } catch (err) {
      this.logger.warn && this.logger.warn({ err: err.message }, 'combo cache update failed');
    }
  }

  /**
   * 捕捉成功后调用
   * @returns {Promise<object>} { duplicate, currentCombo, maxCombo, isNewRecord, rewards, milestone, expiresAt, restarted, previousCombo }
   */
  async recordCatchSuccess(userId, { sessionId, pokemonInstanceId, speciesId } = {}) {
    if (!sessionId) throw new Error('sessionId required');
    const tiers = await this.getTiers();
    const now = this.now();
    const out = await this.transaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO catch_combo_events (session_id, user_id, event_type, species_id, created_at)
         VALUES ($1, $2, 'success', $3, $4) ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
        [sessionId, userId, speciesId || null, now]);
      if (!ins.rows.length) {
        const { rows } = await client.query('SELECT * FROM catch_combos WHERE user_id = $1', [userId]);
        return { duplicate: true, state: rules.normalizeState(rows[0]) };
      }
      const state = await this._lockState(client, userId);
      const r = rules.applyCatchSuccess(state, { now, pokemonId: pokemonInstanceId }, tiers, this.config);
      if (r.archived) await this._archive(client, userId, r.archived);
      const skipped = await this._grant(client, userId, r.rewards);
      await this._saveState(client, userId, r.state);
      await client.query(
        'UPDATE catch_combo_events SET combo_after = $2, rewards = $3::jsonb WHERE session_id = $1',
        [sessionId, r.combo, JSON.stringify(r.rewards)]);
      return { duplicate: false, state: r.state, r, skipped };
    });

    await this._cache(userId, out.state);
    const st = rules.effectiveStatus(out.state, now, this.config);
    if (out.duplicate) return { duplicate: true, ...st };
    const { r } = out;
    if (r.rewards.milestone && this.onMilestone) {
      Promise.resolve().then(() => this.onMilestone({ userId, milestone: r.rewards.milestone, maxCombo: st.maxCombo }))
        .catch((err) => this.logger.warn && this.logger.warn({ err: err.message }, 'combo milestone notify failed'));
    }
    return {
      duplicate: false,
      ...st,
      previousCombo: r.previousCombo,
      restarted: r.restarted,
      isNewRecord: r.isNewRecord,
      rewards: {
        xp: r.rewards.xp, coins: r.rewards.coins, premiumCoins: r.rewards.premiumCoins,
        items: r.rewards.items.filter((x) => !(out.skipped || []).some((s) => s.type === x.item)),
        tier: r.rewards.tier, multiplier: r.rewards.multiplier,
      },
      milestone: r.rewards.milestone,
    };
  }

  /**
   * 捕捉失败（FLED）/ 手动重置
   * @param {{ sessionId?: string, reason?: string, force?: boolean }} opts
   */
  async recordCatchFailure(userId, { sessionId, reason = 'failed', force = false } = {}) {
    const now = this.now();
    const out = await this.transaction(async (client) => {
      if (sessionId) {
        const ins = await client.query(
          `INSERT INTO catch_combo_events (session_id, user_id, event_type, created_at)
           VALUES ($1, $2, 'failure', $3) ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
          [sessionId, userId, now]);
        if (!ins.rows.length) {
          const { rows } = await client.query('SELECT * FROM catch_combos WHERE user_id = $1', [userId]);
          return { duplicate: true, state: rules.normalizeState(rows[0]), r: null };
        }
      }
      const state = await this._lockState(client, userId);
      const r = rules.applyCatchFailure(state, { now, reason, force }, this.config);
      if (r.archived) await this._archive(client, userId, r.archived);
      if (r.broken || r.protectedUsed) await this._saveState(client, userId, r.state);
      if (sessionId) {
        await client.query('UPDATE catch_combo_events SET combo_after = $2 WHERE session_id = $1', [sessionId, r.state.currentCombo]);
      }
      return { duplicate: false, state: r.state, r };
    });
    await this._cache(userId, out.state);
    const st = rules.effectiveStatus(out.state, now, this.config);
    if (out.duplicate) return { duplicate: true, broken: false, protectedUsed: false, ...st };
    return { duplicate: false, broken: out.r.broken, protectedUsed: out.r.protectedUsed, previousCombo: out.r.previousCombo, reason, ...st };
  }

  /** 使用连击保护道具（消耗 1 个 COMBO_SHIELD） */
  async useProtection(userId, itemId = SHIELD_ITEM) {
    if (itemId !== SHIELD_ITEM) { const e = new Error('该道具不能用于连击保护'); e.httpStatus = 400; e.code = 3202; throw e; }
    const now = this.now();
    const out = await this.transaction(async (client) => {
      const state = await this._lockState(client, userId);
      const r = rules.applyProtection(state, { now }, this.config);
      if (!r.applied) { const e = new Error('连击保护次数已达上限'); e.httpStatus = 409; e.code = 3203; throw e; }
      const ok = await this.consumeItem(client, userId, SHIELD_ITEM, 1);
      if (!ok) { const e = new Error('连击保护道具不足'); e.httpStatus = 400; e.code = 3201; throw e; }
      await this._saveState(client, userId, r.state);
      return r.state;
    });
    await this._cache(userId, out);
    return { protected: true, ...rules.effectiveStatus(out, now, this.config) };
  }

  /** 查询状态（优先缓存）。已超时的连击在这里归档（写历史并清零），保证"30 分钟无捕捉自动重置"跨设备一致 */
  async getStatus(userId) {
    const redis = this.redis();
    if (redis) {
      try {
        const cached = await redis.get(STATUS_KEY(userId));
        if (cached) {
          const st = JSON.parse(cached);
          const stillValid = !st.expiresAt || new Date(st.expiresAt).getTime() > this.now().getTime();
          if (stillValid) return { ...st, cached: true };
        }
      } catch { /* fall through */ }
    }
    const { rows } = await this.query('SELECT * FROM catch_combos WHERE user_id = $1', [userId]);
    let state = rules.normalizeState(rows[0]);
    if (rules.isExpired(state, this.now(), this.config)) {
      const res = await this.recordCatchFailure(userId, { reason: 'timeout', force: true });
      return { ...res, cached: false };
    }
    await this._cache(userId, state);
    return { ...rules.effectiveStatus(state, this.now(), this.config), cached: false };
  }

  async getHistory(userId, limit = 20) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const { rows } = await this.query(
      `SELECT id, combo_count, total_rewards, started_at, ended_at, end_reason, cardinality(pokemon_ids) AS pokemon_count
         FROM catch_combo_history WHERE user_id = $1 ORDER BY ended_at DESC LIMIT $2`, [userId, n]);
    return rows.map((r) => ({
      id: r.id, comboCount: r.combo_count, totalRewards: r.total_rewards, startedAt: r.started_at,
      endedAt: r.ended_at, endReason: r.end_reason, pokemonCount: Number(r.pokemon_count || 0),
    }));
  }

  /** 排行榜：Redis ZSET 实时；ZSET 为空（Redis 重启）时从库重建 */
  async getLeaderboard(limit = 100, viewerId = null) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
    const redis = this.redis();
    let pairs = null;
    if (redis) {
      try {
        let raw = await redis.zrevrange(LB_KEY, 0, n - 1, 'WITHSCORES');
        if (!raw || raw.length === 0) {
          const { rows } = await this.query(
            'SELECT user_id, max_combo FROM catch_combos WHERE max_combo > 0 ORDER BY max_combo DESC LIMIT 1000');
          if (rows.length) {
            const args = [];
            for (const r of rows) args.push(r.max_combo, String(r.user_id));
            await redis.zadd(LB_KEY, ...args);
            raw = await redis.zrevrange(LB_KEY, 0, n - 1, 'WITHSCORES');
          }
        }
        pairs = [];
        for (let i = 0; i < (raw || []).length; i += 2) pairs.push({ userId: raw[i], maxCombo: Number(raw[i + 1]) });
      } catch (err) {
        this.logger.warn && this.logger.warn({ err: err.message }, 'combo leaderboard redis failed, using db');
        pairs = null;
      }
    }
    if (!pairs) {
      const { rows } = await this.query(
        'SELECT user_id, max_combo FROM catch_combos WHERE max_combo > 0 ORDER BY max_combo DESC, updated_at ASC LIMIT $1', [n]);
      pairs = rows.map((r) => ({ userId: String(r.user_id), maxCombo: Number(r.max_combo) }));
    }
    const ids = pairs.map((p) => p.userId).filter(isUuid);
    const names = new Map();
    if (ids.length) {
      const { rows } = await this.query(
        `SELECT u.id, u.nickname, u.avatar_url, cc.current_combo, cc.last_catch_time
           FROM users u LEFT JOIN catch_combos cc ON cc.user_id = u.id WHERE u.id = ANY($1::uuid[])`, [ids]);
      for (const r of rows) names.set(String(r.id), r);
    }
    const now = this.now();
    const entries = pairs.filter((p) => names.has(p.userId)).map((p, i) => {
      const u = names.get(p.userId);
      const st = rules.effectiveStatus({ currentCombo: u.current_combo, maxCombo: p.maxCombo, lastCatchTime: u.last_catch_time }, now, this.config);
      return { rank: i + 1, userId: p.userId, nickname: u.nickname, avatarUrl: u.avatar_url, maxCombo: p.maxCombo, currentCombo: st.currentCombo };
    });
    let me = null;
    if (viewerId) {
      me = entries.find((e) => e.userId === String(viewerId)) || null;
      if (!me && redis) {
        try {
          const rank = await redis.zrevrank(LB_KEY, String(viewerId));
          const score = await redis.zscore(LB_KEY, String(viewerId));
          if (rank !== null && rank !== undefined) me = { rank: Number(rank) + 1, userId: String(viewerId), maxCombo: Number(score) };
        } catch { /* ignore */ }
      }
    }
    return { entries, me };
  }
}

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

let singleton = null;
function getComboService(deps) {
  if (!singleton) singleton = new CatchComboService(deps);
  return singleton;
}

module.exports = { CatchComboService, getComboService, STATUS_KEY, LB_KEY, SHIELD_ITEM };
