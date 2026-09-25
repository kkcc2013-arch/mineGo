/**
 * REQ-00048 / REQ-00388：好友服务核心
 *
 * 权威表：friends（双向两行）、friend_requests、friend_gifts、friend_interactions（见迁移 20260925_100600）。
 * - 好友码 12 位数字（users.friend_code，插入触发器生成，旧用户懒生成）
 * - 申请 7 天过期；同一对用户只有一条 pending；对方已向我发起时再发起即自动成为好友
 * - 好友上限 400、待处理申请上限 50（发送方 outgoing 与接收方 incoming 各 50），在事务内按用户加咨询锁检查
 * - 礼物：每日 50 个、30 天过期、按亲密度等级解锁礼物类型；领取原子（并发只成功一次）
 * - 友情点同时驱动友情等级（1-5）与亲密度等级（1-10），升级经 WebSocket 推送并写入提醒
 * - 隐私：拉黑/不接受申请/不接受礼物、在线状态等按对方隐私设置过滤
 */
'use strict';

const dbDefault = require('../../../shared/db');
const { AppError } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const inventory = require('../../../shared/inventory');
const socialEvents = require('../../../shared/social/socialEvents');
const levels = require('../../../shared/social/friendshipLevels');
const privacyRules = require('../../../shared/social/privacyRules');
const relationship = require('../../../shared/social/relationship');
const m = require('./social/metrics');

const logger = createLogger('friend-service');

const DEFAULT_CONFIG = Object.freeze({
  max_friends: 400,
  max_pending_requests: 50,
  max_daily_gifts: 50,
  request_expire_days: 7,
  gift_expire_days: 30,
  online_threshold_minutes: 5,
  away_threshold_minutes: 60,
});
const CONFIG_TTL_MS = 60 * 1000;

const ERR = {
  VALIDATION: (msg) => new AppError(1001, msg, 400),
  USER_NOT_FOUND: () => new AppError(2001, '用户不存在', 404),
  ALREADY_FRIENDS: () => new AppError(2002, '你们已经是好友了', 409),
  FRIEND_LIMIT: (n) => new AppError(2003, `好友数量已达上限（${n}）`, 400),
  PENDING_LIMIT: (n) => new AppError(2004, `待处理的好友请求已达上限（${n}）`, 400),
  REQUEST_NOT_FOUND: () => new AppError(2005, '好友请求不存在或已处理', 404),
  NOT_FRIENDS: () => new AppError(2006, '你们还不是好友', 400),
  INSUFFICIENT_ITEM: () => new AppError(2007, '道具数量不足', 400),
  INSUFFICIENT_CANDY: () => new AppError(2008, '糖果数量不足', 400),
  DAILY_GIFT_LIMIT: (n) => new AppError(2009, `今日礼物已达上限（${n}）`, 429),
  GIFT_NOT_FOUND: () => new AppError(2010, '礼物不存在或已领取', 404),
  INVALID_FRIEND_CODE: () => new AppError(2011, '无效的好友码', 404),
  CANNOT_ADD_SELF: () => new AppError(2012, '不能添加自己为好友', 400),
  TARGET_FRIEND_LIMIT: (n) => new AppError(2013, `对方好友数量已达上限（${n}）`, 400),
  REQUEST_PENDING: () => new AppError(2014, '已发送过好友请求，等待对方处理', 409),
  REQUEST_EXPIRED: () => new AppError(2015, '好友请求已过期', 410),
  INSUFFICIENT_CURRENCY: () => new AppError(2016, '余额不足', 400),
  PRIVACY_REJECTED: (msg) => new AppError(2017, msg || '对方的隐私设置不允许该操作', 403),
  GIFT_LOCKED: (lvl) => new AppError(2018, `亲密度达到 ${lvl} 级后才能赠送该礼物`, 403),
  GIFT_EXPIRED: () => new AppError(2019, '礼物已过期', 410),
  GIFT_TODAY: () => new AppError(2020, '今天已经给这位好友送过礼物包了', 429),
  TARGET_PENDING_LIMIT: (n) => new AppError(2021, `对方待处理的好友请求已达上限（${n}）`, 400),
  GIFT_TYPE_LIMIT: (n) => new AppError(2022, `该礼物今日赠送已达上限（${n}）`, 429),
};

const isUuid = relationship.isUuid;

/** 规范化好友码：去掉空格/短横线，12 位数字 */
function normalizeFriendCode(code) {
  if (code === null || code === undefined) return null;
  const s = String(code).replace(/[\s-]/g, '');
  return /^\d{12}$/.test(s) ? s : null;
}
const formatFriendCode = (c) => (c ? `${c.slice(0, 4)} ${c.slice(4, 8)} ${c.slice(8, 12)}` : null);

/** 合并同类道具 */
function mergeItems(items) {
  const map = new Map();
  for (const it of items) map.set(it.type, (map.get(it.type) || 0) + it.qty);
  return [...map].map(([type, qty]) => ({ type, qty }));
}

/**
 * 系统礼物包内容（与宝可梦 GO 相同：友情等级越高内容越好，可能含 7 公里蛋）
 * @param {number} friendshipLevel 1-5
 * @param {Function} rng
 */
function generateStandardGift(friendshipLevel = 1, rng = Math.random) {
  const lvl = Math.min(5, Math.max(1, Number(friendshipLevel) || 1));
  const items = [{ type: 'POKE_BALL', qty: 2 + Math.floor(rng() * 3) }];
  if (rng() < 0.4) items.push({ type: 'STARDUST', qty: 100 });
  if (rng() < 0.3) items.push({ type: 'RAZZ_BERRY', qty: 1 });
  if (lvl >= 3) {
    items.push({ type: 'GREAT_BALL', qty: 1 });
    if (rng() < 0.3) items.push({ type: 'STARDUST', qty: 200 });
  }
  if (lvl >= 4 && rng() < 0.15) items.push({ type: 'ULTRA_BALL', qty: 1 });
  if (rng() < 0.1 + 0.02 * lvl) items.push({ type: 'EGG_7KM', qty: 1 });
  return mergeItems(items);
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

class FriendService {
  constructor({ db = dbDefault, events = socialEvents, redisFactory } = {}) {
    this.db = db;
    this.events = events;
    this.redisFactory = redisFactory || (() => require('../../../shared/redis').getRedis());
    this._config = null;
    this._configAt = 0;
    this._giftTypes = null;
    this._giftTypesAt = 0;
  }

  // ── 配置 ────────────────────────────────────────────────────
  async getConfig() {
    if (this._config && Date.now() - this._configAt < CONFIG_TTL_MS) return this._config;
    const cfg = { ...DEFAULT_CONFIG };
    try {
      const { rows } = await this.db.query('SELECT key, value FROM friend_system_config');
      for (const r of rows) if (r.key in cfg && Number.isFinite(Number(r.value))) cfg[r.key] = Number(r.value);
    } catch (err) {
      logger.warn({ err: err.message }, 'friend_system_config unavailable, using defaults');
    }
    this._config = cfg;
    this._configAt = Date.now();
    return cfg;
  }

  async getGiftTypes() {
    if (this._giftTypes && Date.now() - this._giftTypesAt < CONFIG_TTL_MS) return this._giftTypes;
    const { rows } = await this.db.query(`
      SELECT code, name, description, gift_type, item_id, rarity, required_intimacy_level, daily_limit,
             max_quantity, friendship_points, is_seasonal, season_start, season_end
        FROM gift_types WHERE is_active ORDER BY required_intimacy_level, id`);
    this._giftTypes = rows;
    this._giftTypesAt = Date.now();
    return rows;
  }

  async lockUsers(client, ids) {
    for (const id of [...new Set(ids)].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`friend:${id}`]);
    }
  }

  async countFriends(q, userId) {
    const { rows } = await q.query(
      "SELECT COUNT(*)::int AS n FROM friends WHERE user_id = $1 AND status = 'accepted'", [userId]);
    return rows[0].n;
  }

  // ── 好友码 / 搜索 ──────────────────────────────────────────
  async getFriendCode(userId) {
    let { rows } = await this.db.query('SELECT friend_code, nickname FROM users WHERE id = $1', [userId]);
    if (!rows.length) throw ERR.USER_NOT_FOUND();
    let code = rows[0].friend_code;
    if (!normalizeFriendCode(code)) {
      ({ rows } = await this.db.query(
        'UPDATE users SET friend_code = gen_friend_code() WHERE id = $1 RETURNING friend_code', [userId]));
      code = rows[0].friend_code;
    }
    return { friendCode: code, formatted: formatFriendCode(code), nickname: rows[0].nickname };
  }

  async findUserByFriendCode(code) {
    const normalized = normalizeFriendCode(code);
    if (!normalized) throw ERR.INVALID_FRIEND_CODE();
    const { rows } = await this.db.query(
      'SELECT id, nickname, avatar_url, level, team FROM users WHERE friend_code = $1 AND deleted_at IS NULL',
      [normalized]);
    if (!rows.length) throw ERR.INVALID_FRIEND_CODE();
    return rows[0];
  }

  /**
   * 按昵称模糊搜索或好友码精确查找（好友码不受 searchable 限制）；排除自己、拉黑关系、关闭搜索的用户
   */
  async searchUsers(userId, rawQuery, limit = 20) {
    const q = String(rawQuery || '').trim();
    if (q.length < 2) throw ERR.VALIDATION('搜索关键词至少2个字符');
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const code = normalizeFriendCode(q);
    const params = [userId];
    let where;
    if (code) {
      params.push(code);
      where = 'u.friend_code = $2';
    } else {
      params.push(`%${escapeLike(q)}%`);
      where = "u.nickname ILIKE $2 AND COALESCE(ps.searchable, true)";
    }
    params.push(lim);
    const { rows } = await this.db.query(`
      SELECT u.id, u.nickname, u.avatar_url, u.level, u.team,
             EXISTS (SELECT 1 FROM friends f WHERE f.user_id = $1 AND f.friend_user_id = u.id AND f.status = 'accepted') AS is_friend,
             (SELECT CASE WHEN r.from_user_id = $1 THEN 'outgoing' ELSE 'incoming' END
                FROM friend_requests r
               WHERE r.status = 'pending' AND r.expires_at > NOW()
                 AND ((r.from_user_id = $1 AND r.to_user_id = u.id) OR (r.from_user_id = u.id AND r.to_user_id = $1))
               LIMIT 1) AS request_status,
             COALESCE(ps.allow_friend_requests, true) AS accepts_requests
        FROM users u
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       WHERE ${where}
         AND u.id <> $1 AND u.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM blocked_users b
                          WHERE (b.user_id = $1 AND b.blocked_user_id = u.id) OR (b.user_id = u.id AND b.blocked_user_id = $1))
       ORDER BY (u.nickname ILIKE $2) DESC, u.level DESC NULLS LAST
       LIMIT $3`, params);
    return rows;
  }

  // ── 好友请求 ─────────────────────────────────────────────────
  async sendFriendRequest(fromUserId, toUserId, { message = '', source = 'search' } = {}) {
    if (!isUuid(toUserId)) throw ERR.VALIDATION('toUserId 必须是有效的用户 ID');
    if (fromUserId === toUserId) throw ERR.CANNOT_ADD_SELF();
    const msg = String(message || '').slice(0, 200);
    const src = ['search', 'code', 'recommendation', 'nearby', 'qr'].includes(source) ? source : 'search';
    const cfg = await this.getConfig();

    let outcome;
    try {
      outcome = await m.timed('friend_request', () => this.db.transaction(async (c) => {
        await this.lockUsers(c, [fromUserId, toUserId]);
        const { rows: users } = await c.query(
          'SELECT id, nickname FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [[fromUserId, toUserId]]);
        const target = users.find((u) => u.id === toUserId);
        const me = users.find((u) => u.id === fromUserId);
        if (!target || !me) throw ERR.USER_NOT_FOUND();

        if (await relationship.isBlockedEitherWay(c, fromUserId, toUserId)) {
          throw ERR.PRIVACY_REJECTED('无法向该用户发送好友请求');
        }
        const privacy = await relationship.getPrivacySettings(c, toUserId);
        if (!privacy.allow_friend_requests) throw ERR.PRIVACY_REJECTED('对方不接受好友请求');

        const { rows: fr } = await c.query(
          "SELECT 1 FROM friends WHERE user_id = $1 AND friend_user_id = $2 AND status = 'accepted'", [fromUserId, toUserId]);
        if (fr.length) throw ERR.ALREADY_FRIENDS();

        await c.query(`
          UPDATE friend_requests SET status = 'expired', updated_at = NOW()
           WHERE status = 'pending' AND expires_at <= NOW()
             AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
        [fromUserId, toUserId]);

        const { rows: reverse } = await c.query(
          "SELECT id FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'",
          [toUserId, fromUserId]);
        if (reverse.length) return { autoAcceptId: reverse[0].id };

        const [myCount, theirCount] = [await this.countFriends(c, fromUserId), await this.countFriends(c, toUserId)];
        if (myCount >= cfg.max_friends) throw ERR.FRIEND_LIMIT(cfg.max_friends);
        if (theirCount >= cfg.max_friends) throw ERR.TARGET_FRIEND_LIMIT(cfg.max_friends);

        const { rows: [pend] } = await c.query(`
          SELECT COUNT(*) FILTER (WHERE from_user_id = $1)::int AS outgoing,
                 COUNT(*) FILTER (WHERE to_user_id = $2)::int AS incoming
            FROM friend_requests
           WHERE status = 'pending' AND expires_at > NOW() AND (from_user_id = $1 OR to_user_id = $2)`,
        [fromUserId, toUserId]);
        if (pend.outgoing >= cfg.max_pending_requests) throw ERR.PENDING_LIMIT(cfg.max_pending_requests);
        if (pend.incoming >= cfg.max_pending_requests) throw ERR.TARGET_PENDING_LIMIT(cfg.max_pending_requests);

        const { rows: ins } = await c.query(`
          INSERT INTO friend_requests (from_user_id, to_user_id, message, status, expires_at, source, created_at, updated_at)
          VALUES ($1, $2, $3, 'pending', NOW() + make_interval(days => $4::int), $5, NOW(), NOW())
          ON CONFLICT (from_user_id, to_user_id) DO UPDATE
             SET message = EXCLUDED.message, status = 'pending', expires_at = EXCLUDED.expires_at,
                 source = EXCLUDED.source, created_at = NOW(), updated_at = NOW(), reviewed_at = NULL, review_notes = NULL
           WHERE friend_requests.status <> 'pending'
          RETURNING id, expires_at, created_at`,
        [fromUserId, toUserId, msg, cfg.request_expire_days, src]);
        if (!ins.length) throw ERR.REQUEST_PENDING();
        return { request: ins[0], me };
      }));
    } catch (err) {
      m.friendRequests.inc({ action: 'send', result: err.code ? String(err.code) : 'error' });
      throw err;
    }

    if (outcome.autoAcceptId) {
      const accepted = await this.acceptFriendRequest(fromUserId, outcome.autoAcceptId);
      return { ...accepted, autoAccepted: true };
    }

    m.friendRequests.inc({ action: 'send', result: 'ok' });
    const { request, me } = outcome;
    const payload = {
      requestId: request.id,
      from: { id: fromUserId, nickname: me.nickname },
      message: msg,
      expiresAt: request.expires_at,
    };
    await this.events.publish([toUserId], 'friend_request_received', payload);
    await this.events.createReminder(this.db, {
      userId: toUserId, type: 'friend_request', relatedUserId: fromUserId,
      content: { requestId: request.id, nickname: me.nickname, message: msg },
      dedupeKey: `friend_request:${request.id}:${new Date(request.created_at).getTime()}`,
    });
    logger.info({ fromUserId, toUserId, requestId: request.id }, 'Friend request sent');
    return { success: true, requestId: request.id, status: 'pending', expiresAt: request.expires_at };
  }

  async addFriendByCode(userId, friendCode, message = '') {
    const target = await this.findUserByFriendCode(friendCode);
    if (target.id === userId) throw ERR.CANNOT_ADD_SELF();
    return this.sendFriendRequest(userId, target.id, { message: message || '通过好友码添加', source: 'code' });
  }

  async acceptFriendRequest(userId, requestId) {
    const id = parseInt(requestId, 10);
    if (!Number.isInteger(id) || id <= 0) throw ERR.REQUEST_NOT_FOUND();
    const cfg = await this.getConfig();

    const result = await m.timed('friend_accept', () => this.db.transaction(async (c) => {
      const { rows: [req] } = await c.query(
        'SELECT * FROM friend_requests WHERE id = $1 AND to_user_id = $2', [id, userId]);
      if (!req) throw ERR.REQUEST_NOT_FOUND();
      await this.lockUsers(c, [req.from_user_id, req.to_user_id]);
      const { rows: [cur] } = await c.query('SELECT status, expires_at FROM friend_requests WHERE id = $1 FOR UPDATE', [id]);
      if (cur.status !== 'pending') throw ERR.REQUEST_NOT_FOUND();
      if (new Date(cur.expires_at).getTime() <= Date.now()) {
        await c.query("UPDATE friend_requests SET status = 'expired', updated_at = NOW() WHERE id = $1", [id]);
        return { expired: true };
      }
      if (await relationship.isBlockedEitherWay(c, req.from_user_id, req.to_user_id)) throw ERR.REQUEST_NOT_FOUND();

      const { rows: exists } = await c.query(
        "SELECT 1 FROM friends WHERE user_id = $1 AND friend_user_id = $2 AND status = 'accepted'",
        [req.to_user_id, req.from_user_id]);
      if (!exists.length) {
        if (await this.countFriends(c, req.to_user_id) >= cfg.max_friends) throw ERR.FRIEND_LIMIT(cfg.max_friends);
        if (await this.countFriends(c, req.from_user_id) >= cfg.max_friends) throw ERR.TARGET_FRIEND_LIMIT(cfg.max_friends);
      }

      await c.query(`
        INSERT INTO friends (user_id, friend_user_id, status, friendship_level, friendship_points, intimacy_level,
                             accepted_at, created_at, updated_at, last_interaction_at)
        VALUES ($1, $2, 'accepted', 1, 0, 1, NOW(), NOW(), NOW(), NOW()),
               ($2, $1, 'accepted', 1, 0, 1, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (user_id, friend_user_id) DO UPDATE SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()`,
      [req.from_user_id, req.to_user_id]);
      await c.query(`
        UPDATE friend_requests SET status = 'accepted', reviewed_at = NOW(), updated_at = NOW()
         WHERE status = 'pending'
           AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
      [req.from_user_id, req.to_user_id]);

      const { rows: people } = await c.query(
        'SELECT id, nickname, avatar_url, level FROM users WHERE id = ANY($1::uuid[])', [[req.from_user_id, req.to_user_id]]);
      const byId = new Map(people.map((p) => [p.id, p]));
      await c.query(`
        INSERT INTO friend_activities (user_id, activity_type, content, visibility)
        VALUES ($1, 'friend_add', $3, 'friends'), ($2, 'friend_add', $4, 'friends')`,
      [req.from_user_id, req.to_user_id,
        JSON.stringify({ friendId: req.to_user_id, nickname: byId.get(req.to_user_id)?.nickname }),
        JSON.stringify({ friendId: req.from_user_id, nickname: byId.get(req.from_user_id)?.nickname })]);
      return { req, requester: byId.get(req.from_user_id), accepter: byId.get(req.to_user_id) };
    }));

    if (result.expired) {
      m.friendRequests.inc({ action: 'accept', result: 'expired' });
      throw ERR.REQUEST_EXPIRED();
    }
    m.friendRequests.inc({ action: 'accept', result: 'ok' });
    const { req, requester, accepter } = result;
    await this.bumpLeaderboardVersion([req.from_user_id, req.to_user_id]);
    await this.events.publish([req.from_user_id], 'friend_request_accepted', {
      requestId: id, friend: { id: accepter.id, nickname: accepter.nickname },
    });
    await this.events.publish([req.to_user_id], 'friend_added', {
      friend: { id: requester.id, nickname: requester.nickname },
    });
    await this.events.createReminder(this.db, {
      userId: req.from_user_id, type: 'friend_accepted', relatedUserId: req.to_user_id,
      content: { nickname: accepter.nickname }, dedupeKey: `friend_accepted:${id}`,
    });
    logger.info({ requestId: id, from: req.from_user_id, to: req.to_user_id }, 'Friend request accepted');
    return {
      success: true,
      friend: { id: requester.id, nickname: requester.nickname, avatar_url: requester.avatar_url, level: requester.level },
      friendshipLevel: 1,
      intimacyLevel: 1,
      message: '已成为好友',
    };
  }

  /** 拒绝（通知对方）或忽略（静默） */
  async rejectFriendRequest(userId, requestId, { ignore = false, notes = null } = {}) {
    const id = parseInt(requestId, 10);
    if (!Number.isInteger(id)) throw ERR.REQUEST_NOT_FOUND();
    const status = ignore ? 'ignored' : 'rejected';
    const { rows } = await this.db.query(`
      UPDATE friend_requests SET status = $3, reviewed_at = NOW(), review_notes = $4, updated_at = NOW()
       WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
      RETURNING from_user_id`, [id, userId, status, notes ? String(notes).slice(0, 200) : null]);
    if (!rows.length) throw ERR.REQUEST_NOT_FOUND();
    m.friendRequests.inc({ action: status, result: 'ok' });
    if (!ignore) await this.events.publish([rows[0].from_user_id], 'friend_request_rejected', { requestId: id });
    return { success: true, status, message: ignore ? '已忽略请求' : '已拒绝请求' };
  }

  async cancelFriendRequest(userId, requestId) {
    const id = parseInt(requestId, 10);
    const { rows } = await this.db.query(`
      UPDATE friend_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND from_user_id = $2 AND status = 'pending' RETURNING to_user_id`, [id, userId]);
    if (!rows.length) throw ERR.REQUEST_NOT_FOUND();
    m.friendRequests.inc({ action: 'cancel', result: 'ok' });
    await this.events.publish([rows[0].to_user_id], 'friend_request_cancelled', { requestId: id });
    return { success: true, status: 'cancelled' };
  }

  async getPendingRequests(userId, { page = 1, limit = 20 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const { rows } = await this.db.query(`
      SELECT fr.id, fr.message, fr.source, fr.created_at, fr.expires_at,
             u.id AS from_user_id, u.nickname, u.avatar_url, u.level, u.team,
             COUNT(*) OVER()::int AS total
        FROM friend_requests fr
        JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending' AND fr.expires_at > NOW()
       ORDER BY fr.created_at DESC
       LIMIT $2 OFFSET $3`, [userId, lim, off]);
    const total = rows.length ? rows[0].total : 0;
    return { requests: rows.map(({ total: _t, ...r }) => r), total };
  }

  async getSentRequests(userId) {
    const { rows } = await this.db.query(`
      SELECT fr.id, fr.message, fr.status, fr.created_at, fr.expires_at,
             u.id AS to_user_id, u.nickname, u.avatar_url, u.level
        FROM friend_requests fr
        JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = $1 AND fr.status = 'pending' AND fr.expires_at > NOW()
       ORDER BY fr.created_at DESC`, [userId]);
    return rows;
  }

  // ── 好友列表 / 详情 ─────────────────────────────────────────
  _friendRel(row) {
    // row.their_* 为好友（数据所有者）给我的权限
    return {
      isOwner: false,
      isFriend: true,
      blocked: false,
      permissionLevel: row.their_permission_level || 'regular',
      groupId: row.their_group_id,
      overrides: row.their_overrides || {},
      friendshipLevel: row.friendship_level,
    };
  }

  async getFriendList(userId, { page = 1, limit = 50, sortBy = 'last_interaction', groupId = null, favorite = false } = {}) {
    const cfg = await this.getConfig();
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 400);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const orderMap = {
      last_interaction: 'f.last_interaction_at DESC NULLS LAST, f.id',
      friendship_level: 'f.friendship_points DESC, f.id',
      intimacy: 'f.friendship_points DESC, f.id',
      name: 'COALESCE(f.nickname, u.nickname) ASC, f.id',
      level: 'u.level DESC NULLS LAST, f.id',
      recent: 'f.created_at DESC, f.id',
      favorite: 'f.favorite DESC, f.friendship_points DESC, f.id',
    };
    const inMemorySort = sortBy === 'online';
    const orderBy = orderMap[sortBy] || orderMap.last_interaction;
    const params = [userId];
    const conds = ["f.user_id = $1", "f.status = 'accepted'"];
    if (groupId) { params.push(parseInt(groupId, 10)); conds.push(`f.group_id = $${params.length}`); }
    if (favorite === true || favorite === 'true') conds.push('f.favorite');
    let limitSql = '';
    if (!inMemorySort) {
      params.push(lim, (pg - 1) * lim);
      limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }
    const { rows } = await this.db.query(`
      SELECT u.id, u.nickname, u.avatar_url, u.level, u.team, u.last_active_at,
             f.friendship_level, f.friendship_points, f.intimacy_level, f.last_interaction_at,
             f.created_at AS friends_since, f.nickname AS remark, f.notes, f.tags, f.favorite,
             f.group_id, f.permission_level,
             r.permission_level AS their_permission_level, r.group_id AS their_group_id,
             r.permission_overrides AS their_overrides,
             to_jsonb(ps) AS their_privacy,
             (SELECT COUNT(*)::int FROM friend_gifts g
               WHERE g.to_user_id = $1 AND g.from_user_id = u.id AND g.status = 'pending' AND g.expires_at > NOW()
                 AND NOT g.is_anonymous) AS pending_gifts,
             EXISTS (SELECT 1 FROM friend_gifts g
                      WHERE g.from_user_id = $1 AND g.to_user_id = u.id AND g.gift_type = 'standard'
                        AND g.sent_at >= date_trunc('day', NOW())) AS gifted_today,
             COUNT(*) OVER()::int AS total
        FROM friends f
        JOIN users u ON u.id = f.friend_user_id
        LEFT JOIN friends r ON r.user_id = f.friend_user_id AND r.friend_user_id = f.user_id
        LEFT JOIN privacy_settings ps ON ps.user_id = f.friend_user_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ${orderBy}
       ${limitSql}`, params);

    const thresholds = { onlineMinutes: cfg.online_threshold_minutes, awayMinutes: cfg.away_threshold_minutes };
    let friends = rows.map((r) => {
      const settings = privacyRules.withDefaults(r.their_privacy);
      const rel = this._friendRel(r);
      const onlineVisible = privacyRules.canView(settings, 'online_status', rel);
      const fp = levels.friendshipProgress(r.friendship_points);
      const ip = levels.intimacyProgress(r.friendship_points);
      return {
        id: r.id,
        nickname: r.nickname,
        remark: r.remark,
        avatar_url: r.avatar_url,
        level: r.level,
        team: r.team,
        friendship_level: fp.level,
        friendship_level_name: fp.name,
        friendship_points: r.friendship_points,
        points_to_next_level: fp.pointsToNext,
        intimacy_level: ip.level,
        intimacy_level_name: ip.name,
        last_interaction_at: r.last_interaction_at,
        friends_since: r.friends_since,
        favorite: r.favorite,
        group_id: r.group_id,
        permission_level: r.permission_level,
        tags: r.tags || [],
        online_status: onlineVisible ? privacyRules.onlineStatus(r.last_active_at, thresholds) : 'hidden',
        last_active_at: onlineVisible ? r.last_active_at : null,
        pending_gifts: r.pending_gifts,
        can_send_gift: !r.gifted_today && settings.allow_gifts,
      };
    });
    let total = rows.length ? rows[0].total : 0;
    if (inMemorySort) {
      const rank = { online: 0, away: 1, offline: 2, hidden: 3 };
      friends.sort((a, b) => rank[a.online_status] - rank[b.online_status] || String(a.nickname).localeCompare(String(b.nickname)));
      total = friends.length;
      friends = friends.slice((pg - 1) * lim, pg * lim);
    }
    return {
      friends,
      pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) },
      limits: { maxFriends: cfg.max_friends },
    };
  }

  /** 好友详情（按对方隐私设置过滤）；查看会记一次 visit_profile 互动（每天一次计分） */
  async getFriendDetail(userId, friendId) {
    if (!isUuid(friendId)) throw ERR.NOT_FRIENDS();
    const cfg = await this.getConfig();
    const { rows: [r] } = await this.db.query(`
      SELECT u.id, u.nickname, u.avatar_url, u.level, u.xp, u.team, u.friend_code, u.last_active_at,
             u.last_lat, u.last_lng, to_char(u.birthday, 'MM-DD') AS birthday_md, u.total_distance_km,
             f.friendship_level, f.friendship_points, f.intimacy_level, f.last_interaction_at,
             f.created_at AS friends_since, f.nickname AS remark, f.notes, f.tags, f.favorite, f.group_id,
             f.permission_level, f.permission_overrides, f.interaction_count,
             r.permission_level AS their_permission_level, r.group_id AS their_group_id,
             r.permission_overrides AS their_overrides,
             to_jsonb(ps) AS their_privacy,
             (SELECT COUNT(*)::int FROM pokemon_instances p WHERE p.user_id = u.id AND NOT COALESCE(p.is_released, false)) AS pokemon_count,
             (SELECT COUNT(*)::int FROM user_achievements a WHERE a.user_id = u.id AND (a.completed OR a.unlocked_at IS NOT NULL)) AS achievement_count,
             (SELECT COUNT(*)::int FROM friends ff WHERE ff.user_id = u.id AND ff.status = 'accepted') AS friend_count
        FROM friends f
        JOIN users u ON u.id = f.friend_user_id
        LEFT JOIN friends r ON r.user_id = f.friend_user_id AND r.friend_user_id = f.user_id
        LEFT JOIN privacy_settings ps ON ps.user_id = f.friend_user_id
       WHERE f.user_id = $1 AND f.friend_user_id = $2 AND f.status = 'accepted'`, [userId, friendId]);
    if (!r) throw ERR.NOT_FRIENDS();

    const settings = privacyRules.withDefaults(r.their_privacy);
    const rel = this._friendRel(r);
    const vis = privacyRules.visibilityMap(settings, rel);
    const { rows: stats } = await this.db.query(`
      SELECT interaction_type, COUNT(*)::int AS count, SUM(friendship_points_earned)::int AS points
        FROM friend_interactions
       WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)
       GROUP BY interaction_type`, [userId, friendId]);

    this.recordInteraction(userId, friendId, 'visit_profile').catch(() => {});

    const thresholds = { onlineMinutes: cfg.online_threshold_minutes, awayMinutes: cfg.away_threshold_minutes };
    return {
      id: r.id,
      nickname: r.nickname,
      remark: r.remark,
      notes: r.notes,
      tags: r.tags || [],
      favorite: r.favorite,
      group_id: r.group_id,
      permission_level: r.permission_level,
      permission_overrides: r.permission_overrides || {},
      avatar_url: r.avatar_url,
      team: r.team,
      friend_code: formatFriendCode(r.friend_code),
      level: vis.profile ? r.level : null,
      xp: vis.profile ? Number(r.xp) : null,
      total_distance_km: vis.profile ? Number(r.total_distance_km) : null,
      birthday: vis.profile ? r.birthday_md : null,
      online_status: vis.online_status ? privacyRules.onlineStatus(r.last_active_at, thresholds) : 'hidden',
      last_active_at: vis.online_status ? r.last_active_at : null,
      location: vis.location && r.last_lat != null ? { lat: Number(r.last_lat), lng: Number(r.last_lng) } : null,
      pokemon_count: vis.pokemon_collection ? r.pokemon_count : null,
      achievement_count: vis.achievements ? r.achievement_count : null,
      friend_count: vis.friend_list ? r.friend_count : null,
      friendship: levels.friendshipProgress(r.friendship_points),
      intimacy: levels.intimacyProgress(r.friendship_points),
      friends_since: r.friends_since,
      last_interaction_at: r.last_interaction_at,
      interaction_count: r.interaction_count,
      interactions: stats,
      visibility: vis,
    };
  }

  async removeFriend(userId, friendId, { audit = true, reason = 'remove' } = {}) {
    if (!isUuid(friendId)) throw ERR.NOT_FRIENDS();
    const removed = await this.db.transaction(async (c) => {
      const { rows } = await c.query(`
        DELETE FROM friends
         WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)
        RETURNING id`, [userId, friendId]);
      if (!rows.length) return false;
      const [a, b] = [userId, friendId].sort();
      await c.query(`
        UPDATE joint_mission_progress SET status = 'failed'
         WHERE user1_id = $1 AND user2_id = $2 AND status = 'in_progress'`, [a, b]);
      if (audit) await this.audit(c, userId, 'friend_removed', friendId, { reason });
      return true;
    });
    if (!removed) throw ERR.NOT_FRIENDS();
    await this.bumpLeaderboardVersion([userId, friendId]);
    await this.events.publish([friendId], 'friend_removed', { friendId: userId });
    await this.events.publish([userId], 'friend_removed', { friendId });
    return { success: true, message: '已删除好友' };
  }

  // ── 友情点 / 互动 ───────────────────────────────────────────
  /**
   * 给一对好友加友情点（在调用方事务中），返回升级信息；非好友返回 null
   */
  async addFriendshipPoints(c, a, b, points, interactionType, metadata = {}) {
    const pts = Math.max(0, Math.floor(points));
    const { rows } = await c.query(`
      UPDATE friends SET friendship_points = friendship_points + $3, last_interaction_at = NOW(),
                         interaction_count = interaction_count + 1, updated_at = NOW()
       WHERE ((user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)) AND status = 'accepted'
      RETURNING friendship_points`, [a, b, pts]);
    if (!rows.length) return null;
    const after = Number(rows[0].friendship_points);
    const before = after - pts;
    const fl = levels.friendshipLevelFor(after);
    const il = levels.intimacyLevelFor(after);
    await c.query(`
      UPDATE friends SET friendship_level = $3, intimacy_level = $4
       WHERE ((user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1))
         AND (friendship_level IS DISTINCT FROM $3 OR intimacy_level IS DISTINCT FROM $4)`, [a, b, fl, il]);
    await c.query(`
      INSERT INTO friend_interactions (user_id, friend_user_id, interaction_type, metadata, friendship_points_earned)
      VALUES ($1, $2, $3, $4, $5)`, [a, b, interactionType, JSON.stringify(metadata || {}), pts]);
    m.friendshipPoints.inc({ interaction: interactionType }, pts);
    return { a, b, before, after, points: pts, levelUps: levels.detectLevelUps(before, after) };
  }

  /** 事务提交后：推送升级通知、写提醒与动态 */
  async emitLevelUps(res) {
    if (!res) return;
    await this.bumpLeaderboardVersion([res.a, res.b]);
    const { friendship, intimacy } = res.levelUps;
    if (!friendship && !intimacy) return;
    const { rows } = await this.db.query('SELECT id, nickname FROM users WHERE id = ANY($1::uuid[])', [[res.a, res.b]]);
    const nick = new Map(rows.map((r) => [r.id, r.nickname]));
    for (const [me, other] of [[res.a, res.b], [res.b, res.a]]) {
      if (friendship) {
        m.friendshipLevelUps.inc({ kind: 'friendship' });
        const info = levels.FRIENDSHIP_LEVELS[friendship.to - 1];
        await this.events.publish([me], 'friendship_level_up', {
          friendId: other, nickname: nick.get(other), level: friendship.to, name: info.name, points: res.after,
        });
        await this.events.createReminder(this.db, {
          userId: me, type: 'intimacy_level_up', relatedUserId: other,
          content: { kind: 'friendship', level: friendship.to, name: info.name, nickname: nick.get(other) },
          dedupeKey: `friendship_lvl:${[res.a, res.b].sort().join(':')}:${friendship.to}`,
        });
      }
      if (intimacy) {
        m.friendshipLevelUps.inc({ kind: 'intimacy' });
        const info = levels.INTIMACY_LEVELS[intimacy.to - 1];
        await this.events.publish([me], 'intimacy_level_up', {
          friendId: other, nickname: nick.get(other), level: intimacy.to, name: info.name, points: res.after,
        });
        if (!friendship) {
          await this.events.createReminder(this.db, {
            userId: me, type: 'intimacy_level_up', relatedUserId: other,
            content: { kind: 'intimacy', level: intimacy.to, name: info.name, nickname: nick.get(other) },
            dedupeKey: `intimacy_lvl:${[res.a, res.b].sort().join(':')}:${intimacy.to}`,
          });
        }
      }
    }
    if (friendship) {
      await this.db.query(`
        INSERT INTO friend_activities (user_id, activity_type, content, visibility)
        VALUES ($1, 'friendship_level_up', $3, 'friends'), ($2, 'friendship_level_up', $4, 'friends')`,
      [res.a, res.b,
        JSON.stringify({ friendId: res.b, nickname: nick.get(res.b), level: friendship.to }),
        JSON.stringify({ friendId: res.a, nickname: nick.get(res.a), level: friendship.to })]).catch(() => {});
    }
  }

  /**
   * 服务端确认的互动计分（交易完成、查看资料、点赞动态、联合任务…）。低价值互动每天每对好友只计一次。
   */
  async recordInteraction(userId, friendId, type, metadata = {}, points = null) {
    const pts = points !== null ? points : (levels.INTERACTION_POINTS[type] || 0);
    const res = await this.db.transaction(async (c) => {
      if (levels.DAILY_ONCE_INTERACTIONS.includes(type)) {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`interaction:${userId}:${friendId}:${type}`]);
        const { rows } = await c.query(`
          SELECT 1 FROM friend_interactions
           WHERE user_id = $1 AND friend_user_id = $2 AND interaction_type = $3 AND created_at >= date_trunc('day', NOW())
           LIMIT 1`, [userId, friendId, type]);
        if (rows.length) return { skipped: true };
      }
      return this.addFriendshipPoints(c, userId, friendId, pts, type, metadata);
    });
    if (res && !res.skipped) await this.emitLevelUps(res);
    return res;
  }

  // ── 礼物 ─────────────────────────────────────────────────────
  async giftQuota(q, userId) {
    const cfg = await this.getConfig();
    const { rows: [r] } = await q.query(`
      SELECT COUNT(*)::int AS n FROM friend_gifts WHERE from_user_id = $1 AND sent_at >= date_trunc('day', NOW())`, [userId]);
    return { sentToday: r.n, limit: cfg.max_daily_gifts, remaining: Math.max(0, cfg.max_daily_gifts - r.n) };
  }

  async sendGift(fromUserId, toUserId, data = {}) {
    if (!isUuid(toUserId)) throw ERR.NOT_FRIENDS();
    if (fromUserId === toUserId) throw ERR.VALIDATION('不能给自己送礼物');
    const giftType = data.giftType || 'standard';
    const types = await this.getGiftTypes();
    const gt = types.find((t) => t.code === giftType);
    if (!gt) throw ERR.VALIDATION(`giftType 必须是: ${types.map((t) => t.code).join(', ')}`);
    const quantity = gt.gift_type === 'standard' || gt.gift_type === 'pokemon_egg' ? 1 : parseInt(data.quantity ?? 1, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > gt.max_quantity) {
      throw ERR.VALIDATION(`quantity 必须是 1-${gt.max_quantity} 的整数`);
    }
    let giftId = null;
    if (gt.gift_type === 'item') {
      giftId = String(data.giftId || '').toUpperCase();
      if (!/^[A-Z0-9_]{2,50}$/.test(giftId) || giftId === 'EGG_7KM') throw ERR.VALIDATION('giftId 必须是背包中的道具 ID');
    } else if (gt.gift_type === 'candy') {
      giftId = parseInt(data.giftId, 10);
      if (!Number.isInteger(giftId) || giftId <= 0) throw ERR.VALIDATION('赠送糖果需要 giftId=精灵种类 ID');
    }
    const message = data.message ? String(data.message).slice(0, 200) : null;
    const wrapping = data.wrapping ? String(data.wrapping).slice(0, 30) : null;
    const anonymous = data.anonymous === true;
    const cfg = await this.getConfig();

    let gift;
    try {
      gift = await m.timed('gift_send', () => this.db.transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gift:${fromUserId}`]);
        const { rows: [f] } = await c.query(`
          SELECT friendship_level, intimacy_level FROM friends
           WHERE user_id = $1 AND friend_user_id = $2 AND status = 'accepted'`, [fromUserId, toUserId]);
        if (!f) throw ERR.NOT_FRIENDS();
        const privacy = await relationship.getPrivacySettings(c, toUserId);
        if (!privacy.allow_gifts) throw ERR.PRIVACY_REJECTED('对方暂不接收礼物');
        if ((f.intimacy_level || 1) < gt.required_intimacy_level) throw ERR.GIFT_LOCKED(gt.required_intimacy_level);

        const quota = await this.giftQuota(c, fromUserId);
        if (quota.remaining <= 0) throw ERR.DAILY_GIFT_LIMIT(cfg.max_daily_gifts);
        if (gt.daily_limit) {
          const { rows: [n] } = await c.query(`
            SELECT COUNT(*)::int AS n FROM friend_gifts
             WHERE from_user_id = $1 AND gift_type = $2 AND sent_at >= date_trunc('day', NOW())`, [fromUserId, gt.code]);
          if (n.n >= gt.daily_limit) throw ERR.GIFT_TYPE_LIMIT(gt.daily_limit);
        }

        let items = [];
        let giftName = gt.name;
        switch (gt.gift_type) {
          case 'standard': {
            const { rows: today } = await c.query(`
              SELECT 1 FROM friend_gifts WHERE from_user_id = $1 AND to_user_id = $2 AND gift_type = 'standard'
                 AND sent_at >= date_trunc('day', NOW()) LIMIT 1`, [fromUserId, toUserId]);
            if (today.length) throw ERR.GIFT_TODAY();
            items = generateStandardGift(f.friendship_level);
            break;
          }
          case 'item': {
            const { rows: known } = await c.query(
              'SELECT COALESCE(name_zh, name, item_id) AS name FROM items WHERE item_id = $1', [giftId]);
            if (!known.length && !inventory.BALL_COLUMNS[giftId]) throw ERR.VALIDATION('未知道具');
            if (!(await inventory.consumeItem(c, fromUserId, giftId, quantity))) throw ERR.INSUFFICIENT_ITEM();
            giftName = known[0]?.name || giftId;
            items = [{ type: giftId, qty: quantity }];
            break;
          }
          case 'candy': {
            const { rowCount } = await c.query(`
              UPDATE candy_inventory SET amount = amount - $3, updated_at = NOW()
               WHERE user_id = $1 AND species_id = $2 AND amount >= $3`, [fromUserId, giftId, quantity]);
            if (!rowCount) throw ERR.INSUFFICIENT_CANDY();
            items = [{ type: 'CANDY', speciesId: giftId, qty: quantity }];
            break;
          }
          case 'stardust':
          case 'coins': {
            const col = gt.gift_type === 'stardust' ? 'stardust' : 'coins';
            const { rowCount } = await c.query(
              `UPDATE users SET ${col} = ${col} - $2 WHERE id = $1 AND ${col} >= $2`, [fromUserId, quantity]);
            if (!rowCount) throw ERR.INSUFFICIENT_CURRENCY();
            items = [{ type: col.toUpperCase(), qty: quantity }];
            break;
          }
          case 'pokemon_egg': {
            if (!(await inventory.consumeItem(c, fromUserId, 'EGG_7KM', 1))) throw ERR.INSUFFICIENT_ITEM();
            giftId = 'EGG_7KM';
            items = [{ type: 'EGG_7KM', qty: 1 }];
            break;
          }
          default: throw ERR.VALIDATION('不支持的礼物类型');
        }

        const { rows: [g] } = await c.query(`
          INSERT INTO friend_gifts (sender_id, receiver_id, from_user_id, to_user_id, gift_type, gift_id, gift_name,
                                    quantity, items, status, friendship_points, message, wrapping, is_anonymous,
                                    sent_at, expires_at)
          VALUES ($1, $2, $1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, NOW(), NOW() + make_interval(days => $12::int))
          RETURNING id, sent_at, expires_at`,
        [fromUserId, toUserId, gt.code, giftId === null ? null : String(giftId), giftName, quantity, JSON.stringify(items),
          gt.friendship_points, message, wrapping, anonymous, cfg.gift_expire_days]);
        await c.query(`
          INSERT INTO friend_interactions (user_id, friend_user_id, interaction_type, metadata, friendship_points_earned)
          VALUES ($1, $2, 'gift_send', $3, 0)`, [fromUserId, toUserId, JSON.stringify({ giftId: g.id, giftType: gt.code })]);
        await c.query(`
          UPDATE friends SET last_interaction_at = NOW()
           WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)`, [fromUserId, toUserId]);
        const { rows: [me] } = await c.query('SELECT nickname FROM users WHERE id = $1', [fromUserId]);
        return { ...g, giftName, sender: me.nickname, remaining: quota.remaining - 1 };
      }));
    } catch (err) {
      m.friendGifts.inc({ action: 'send', gift_type: giftType, result: err.code ? String(err.code) : 'error' });
      throw err;
    }
    m.friendGifts.inc({ action: 'send', gift_type: giftType, result: 'ok' });

    const payload = {
      giftId: gift.id, giftType, giftName: gift.giftName, message,
      from: anonymous ? null : { id: fromUserId, nickname: gift.sender }, expiresAt: gift.expires_at,
    };
    await this.events.publish([toUserId], 'gift_received', payload);
    await this.events.createReminder(this.db, {
      userId: toUserId, type: 'gift_received', relatedUserId: anonymous ? null : fromUserId,
      content: { giftId: gift.id, giftType, giftName: gift.giftName, nickname: anonymous ? '神秘好友' : gift.sender },
      dedupeKey: `gift:${gift.id}`,
    });
    return {
      success: true,
      giftId: gift.id,
      giftType,
      expiresAt: gift.expires_at,
      remainingToday: gift.remaining,
      message: '礼物已发送',
    };
  }

  async getPendingGifts(userId, { page = 1, limit = 20 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const { rows } = await this.db.query(`
      SELECT g.id, g.gift_type, g.gift_name, g.quantity, g.message, g.wrapping, g.is_anonymous,
             g.sent_at, g.expires_at, g.friendship_points,
             CASE WHEN g.is_anonymous THEN NULL ELSE g.from_user_id END AS from_user_id,
             CASE WHEN g.is_anonymous THEN '神秘好友' ELSE u.nickname END AS from_nickname,
             CASE WHEN g.is_anonymous THEN NULL ELSE u.avatar_url END AS from_avatar,
             COUNT(*) OVER()::int AS total
        FROM friend_gifts g
        JOIN users u ON u.id = g.from_user_id
       WHERE g.to_user_id = $1 AND g.status = 'pending' AND g.expires_at > NOW()
       ORDER BY g.sent_at DESC
       LIMIT $2 OFFSET $3`, [userId, lim, off]);
    const total = rows.length ? rows[0].total : 0;
    const quota = await this.giftQuota(this.db, userId);
    return {
      gifts: rows.map(({ total: _t, ...g }) => g),
      pagination: { page: Math.floor(off / lim) + 1, limit: lim, total, totalPages: Math.ceil(total / lim) },
      quota,
    };
  }

  async getSentGifts(userId, { limit = 50 } = {}) {
    const { rows } = await this.db.query(`
      SELECT g.id, g.to_user_id, u.nickname AS to_nickname, g.gift_type, g.gift_name, g.quantity, g.status,
             g.sent_at, g.claimed_at, g.expires_at, g.is_anonymous
        FROM friend_gifts g JOIN users u ON u.id = g.to_user_id
       WHERE g.from_user_id = $1 ORDER BY g.sent_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]);
    return { gifts: rows, quota: await this.giftQuota(this.db, userId) };
  }

  /** 把礼物内容入账到 userId（事务内） */
  async creditGift(c, userId, gift) {
    const items = Array.isArray(gift.items) ? gift.items : JSON.parse(gift.items || '[]');
    const credited = [];
    switch (gift.gift_type) {
      case 'candy': {
        await c.query(`
          INSERT INTO candy_inventory (user_id, species_id, amount, updated_at) VALUES ($1, $2, $3, NOW())
          ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + EXCLUDED.amount, updated_at = NOW()`,
        [userId, parseInt(gift.gift_id, 10), gift.quantity]);
        credited.push({ type: 'CANDY', speciesId: parseInt(gift.gift_id, 10), qty: gift.quantity });
        break;
      }
      case 'stardust':
      case 'coins': {
        const col = gift.gift_type === 'stardust' ? 'stardust' : 'coins';
        await c.query(`UPDATE users SET ${col} = ${col} + $2 WHERE id = $1`, [userId, gift.quantity]);
        credited.push({ type: col.toUpperCase(), qty: gift.quantity });
        break;
      }
      default: {
        // standard / item / pokemon_egg / 旧版礼物（items 数组）
        const dust = items.filter((i) => i.type === 'STARDUST').reduce((s, i) => s + (Number(i.qty) || 0), 0);
        if (dust > 0) {
          await c.query('UPDATE users SET stardust = stardust + $2 WHERE id = $1', [userId, dust]);
          credited.push({ type: 'STARDUST', qty: dust });
        }
        const rest = items.filter((i) => i.type !== 'STARDUST' && i.type !== 'CANDY');
        if (rest.length) {
          const r = await inventory.addItems(c, userId, rest);
          credited.push(...r.credited);
        }
      }
    }
    return credited;
  }

  /** 领取礼物：UPDATE ... WHERE status='pending' 原子抢占，并发只成功一次 */
  async claimGift(userId, giftId) {
    if (!isUuid(String(giftId))) throw ERR.GIFT_NOT_FOUND();
    const result = await m.timed('gift_claim', () => this.db.transaction(async (c) => {
      const { rows: [gift] } = await c.query(`
        UPDATE friend_gifts SET status = 'claimed', claimed_at = NOW()
         WHERE id = $1 AND to_user_id = $2 AND status = 'pending' AND expires_at > NOW()
        RETURNING *`, [giftId, userId]);
      if (!gift) {
        const { rows: [g] } = await c.query(
          'SELECT status, expires_at FROM friend_gifts WHERE id = $1 AND to_user_id = $2', [giftId, userId]);
        if (g && g.status === 'pending' && new Date(g.expires_at).getTime() <= Date.now()) return { expired: true };
        return { notFound: true };
      }
      const credited = await this.creditGift(c, userId, gift);
      const points = Number(gift.friendship_points) || levels.INTERACTION_POINTS.gift_received;
      const lvl = await this.addFriendshipPoints(c, gift.from_user_id, userId, points, 'gift_received',
        { giftId: gift.id, giftType: gift.gift_type });
      await c.query(`
        INSERT INTO friend_activities (user_id, activity_type, content, visibility)
        VALUES ($1, 'gift_receive', $2, 'friends')`,
      [userId, JSON.stringify({ giftType: gift.gift_type, giftName: gift.gift_name, anonymous: gift.is_anonymous })]);
      return { gift, credited, lvl, points: lvl ? points : 0 };
    }));
    if (result.expired) { m.friendGifts.inc({ action: 'claim', gift_type: 'n/a', result: 'expired' }); throw ERR.GIFT_EXPIRED(); }
    if (result.notFound) { m.friendGifts.inc({ action: 'claim', gift_type: 'n/a', result: 'not_found' }); throw ERR.GIFT_NOT_FOUND(); }
    m.friendGifts.inc({ action: 'claim', gift_type: result.gift.gift_type, result: 'ok' });
    await this.emitLevelUps(result.lvl);
    await this.events.publish([result.gift.from_user_id], 'gift_claimed', {
      giftId: result.gift.id, byUserId: userId, pointsEarned: result.points,
    });
    return {
      success: true,
      giftId: result.gift.id,
      giftType: result.gift.gift_type,
      giftName: result.gift.gift_name,
      items: result.credited,
      pointsEarned: result.points,
      friendship: result.lvl ? levels.friendshipProgress(result.lvl.after) : null,
      levelUp: result.lvl ? result.lvl.levelUps : null,
    };
  }

  async claimAllGifts(userId) {
    const { rows } = await this.db.query(`
      SELECT id FROM friend_gifts WHERE to_user_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY sent_at LIMIT 100`, [userId]);
    const results = [];
    const errors = [];
    for (const { id } of rows) {
      try { results.push(await this.claimGift(userId, id)); } catch (err) { errors.push({ giftId: id, error: err.message }); }
    }
    return { claimed: results.length, failed: errors.length, results, errors };
  }

  // ── 排行榜 ─────────────────────────────────────────────────
  async bumpLeaderboardVersion(userIds) {
    try {
      const r = this.redisFactory();
      await Promise.all(userIds.map((id) => r.incr(`friend_lb_v:${id}`)));
    } catch { /* Redis 不可用时依赖 TTL */ }
  }

  /**
   * type: friendship（与我的友情点）| level（训练师等级，含自己）| xp | catches（本周捕捉，含自己）| global（全服社交榜）
   */
  async getFriendLeaderboard(userId, type = 'friendship', limit = 10) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const allowed = ['friendship', 'level', 'xp', 'catches', 'global'];
    if (!allowed.includes(type)) throw ERR.VALIDATION(`type 必须是 ${allowed.join('/')}`);
    let redis = null;
    let key = null;
    try {
      redis = this.redisFactory();
      const v = type === 'global' ? 'g' : ((await redis.get(`friend_lb_v:${userId}`)) || '0');
      key = type === 'global' ? `friend_lb:global:${lim}` : `friend_lb:${userId}:${v}:${type}:${lim}`;
      const cached = await redis.get(key);
      if (cached) return { ...JSON.parse(cached), cached: true };
    } catch { redis = null; }

    let rows;
    if (type === 'global') {
      ({ rows } = await this.db.query(`
        SELECT fl.user_id AS id, u.nickname, u.avatar_url, u.level, fl.friend_count,
               fl.total_friendship_points AS score, fl.refreshed_at
          FROM friend_leaderboard fl
          JOIN users u ON u.id = fl.user_id AND u.deleted_at IS NULL
          LEFT JOIN privacy_settings ps ON ps.user_id = fl.user_id
         WHERE COALESCE(ps.profile_visibility, 'public') = 'public'
         ORDER BY fl.total_friendship_points DESC, fl.user_id
         LIMIT $1`, [lim]));
    } else if (type === 'friendship') {
      ({ rows } = await this.db.query(`
        SELECT u.id, u.nickname, u.avatar_url, u.level, f.friendship_level, f.intimacy_level,
               f.friendship_points AS score
          FROM friends f JOIN users u ON u.id = f.friend_user_id
         WHERE f.user_id = $1 AND f.status = 'accepted'
         ORDER BY f.friendship_points DESC, f.last_interaction_at DESC NULLS LAST, u.id
         LIMIT $2`, [userId, lim]));
    } else {
      const scoreSql = {
        level: 'u.level::bigint * 1000000000 + u.xp',
        xp: 'u.xp',
        catches: `(SELECT COUNT(*) FROM pokemon_instances p WHERE p.user_id = u.id AND p.caught_at >= date_trunc('week', NOW()))`,
      }[type];
      const visibleType = type === 'catches' ? 'pokemon_collection' : 'profile';
      const { rows: cand } = await this.db.query(`
        SELECT u.id, u.nickname, u.avatar_url, u.level, u.xp, (${scoreSql})::bigint AS score,
               (u.id = $1) AS is_me,
               r.permission_level AS their_permission_level, r.group_id AS their_group_id,
               r.permission_overrides AS their_overrides, to_jsonb(ps) AS their_privacy
          FROM users u
          LEFT JOIN friends r ON r.user_id = u.id AND r.friend_user_id = $1 AND r.status = 'accepted'
          LEFT JOIN privacy_settings ps ON ps.user_id = u.id
         WHERE u.id = $1 OR u.id IN (SELECT friend_user_id FROM friends WHERE user_id = $1 AND status = 'accepted')`,
      [userId]);
      rows = cand
        .filter((r) => r.is_me || privacyRules.canView(privacyRules.withDefaults(r.their_privacy), visibleType, this._friendRel(r)))
        .map((r) => ({ id: r.id, nickname: r.nickname, avatar_url: r.avatar_url, level: r.level, score: Number(r.score), is_me: r.is_me }))
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
        .slice(0, lim);
    }
    const out = {
      type,
      entries: rows.map((r, i) => ({ rank: i + 1, ...r, score: Number(r.score) })),
      generatedAt: new Date().toISOString(),
    };
    if (redis && key) redis.setex(key, type === 'global' ? 300 : 60, JSON.stringify(out)).catch(() => {});
    return out;
  }

  // ── 在线状态 ───────────────────────────────────────────────
  /**
   * 刷新在线时间（30 秒内重复调用不写库）；从离线/离开变为在线时通知允许查看在线状态的好友
   */
  async touchPresence(userId) {
    const cfg = await this.getConfig();
    const { rows } = await this.db.query(`
      UPDATE users u SET last_active_at = NOW()
        FROM (SELECT id, last_active_at AS prev FROM users WHERE id = $1) p
       WHERE u.id = p.id AND (p.prev IS NULL OR p.prev < NOW() - INTERVAL '30 seconds')
      RETURNING p.prev`, [userId]);
    if (!rows.length) return { updated: false };
    const prev = rows[0].prev;
    const cameOnline = !prev || Date.now() - new Date(prev).getTime() > cfg.online_threshold_minutes * 60000;
    if (cameOnline) this.notifyFriendsOnline(userId).catch((err) => logger.warn({ err: err.message }, 'notify online failed'));
    return { updated: true, cameOnline };
  }

  async notifyFriendsOnline(userId) {
    const { rows } = await this.db.query(`
      SELECT f.friend_user_id AS id, f.permission_level, f.group_id, f.permission_overrides,
             me.nickname AS my_nickname, to_jsonb(myps) AS my_privacy,
             COALESCE(theirps.notify_friend_online, true) AS wants
        FROM friends f
        JOIN users me ON me.id = f.user_id
        LEFT JOIN privacy_settings myps ON myps.user_id = f.user_id
        LEFT JOIN privacy_settings theirps ON theirps.user_id = f.friend_user_id
       WHERE f.user_id = $1 AND f.status = 'accepted'`, [userId]);
    if (!rows.length) return 0;
    const settings = privacyRules.withDefaults(rows[0].my_privacy);
    const hour = new Date().toISOString().slice(0, 13);
    let n = 0;
    for (const r of rows) {
      if (!r.wants) continue;
      const rel = { isFriend: true, permissionLevel: r.permission_level, groupId: r.group_id, overrides: r.permission_overrides || {} };
      if (!privacyRules.canView(settings, 'online_status', rel)) continue;
      await this.events.publish([r.id], 'friend_online', { friendId: userId, nickname: r.my_nickname });
      await this.events.createReminder(this.db, {
        userId: r.id, type: 'friend_online', relatedUserId: userId,
        content: { nickname: r.my_nickname }, dedupeKey: `online:${userId}:${hour}`,
      });
      n++;
    }
    return n;
  }

  // ── 审计 ──────────────────────────────────────────────────
  async audit(q, userId, action, targetId, details = {}, req = null) {
    try {
      await q.query(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, service, ip_address, user_agent)
        VALUES ($1, $2, 'social', $3, $4, 'social-service', $5, $6)`,
      [userId, action, targetId ? String(targetId) : null, JSON.stringify(details),
        req && req.ip && /^[0-9a-f.:]+$/i.test(req.ip) ? req.ip : null,
        req ? String(req.headers['user-agent'] || '').slice(0, 300) : null]);
    } catch (err) {
      logger.warn({ err: err.message, action }, 'audit log failed');
    }
  }
}

const instance = new FriendService();
module.exports = instance;
module.exports.FriendService = FriendService;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.ERR = ERR;
module.exports.normalizeFriendCode = normalizeFriendCode;
module.exports.formatFriendCode = formatFriendCode;
module.exports.generateStandardGift = generateStandardGift;
module.exports.mergeItems = mergeItems;
