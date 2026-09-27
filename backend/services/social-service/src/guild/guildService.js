/**
 * 公会服务（REQ-00058）——替代原 src/guildService.js（引用不存在的 guilds.invite_code 列、成员数检查在事务外有竞态、
 * 审批/任命不校验目标所在公会）与原 routes/guild.js（db.query 未定义，所有接口 500）。
 *
 * 数据表见迁移 20260925_130200__e02_guilds_squads_voice.sql。所有写操作在事务内完成，
 * 并发加入用 SELECT … FOR UPDATE 锁公会行后再数人数；"一人一会"由唯一索引兜底。
 * 实时通知走 shared/social/socialEvents（Redis 频道 social:events → /ws/friends 推送）。
 */
'use strict';

const crypto = require('crypto');
const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const inventory = require('../../../../shared/inventory');
const socialEvents = require('../../../../shared/social/socialEvents');
const privacyRules = require('../../../../shared/social/privacyRules');
const relationship = require('../../../../shared/social/relationship');
const R = require('./guildRules');

const logger = createLogger('guild-service');
const { isUuid } = relationship;

const E = {
  NOT_FOUND: () => new AppError(2100, '公会不存在或已解散', 404),
  NOT_MEMBER: () => new AppError(2101, '你不是该公会成员', 403),
  ALREADY_IN_GUILD: () => new AppError(2102, '你已加入公会，请先退出当前公会', 409),
  NAME_TAKEN: () => new AppError(2103, '公会名称已被使用', 409),
  INSUFFICIENT_COINS: (n) => new AppError(2104, `金币不足（需要 ${n} 金币）`, 400),
  FULL: () => new AppError(2105, '公会成员已满', 409),
  LEVEL_TOO_LOW: (n) => new AppError(2106, `加入该公会需要训练师等级 ${n}`, 403),
  FORBIDDEN: () => new AppError(2107, '权限不足', 403),
  APPLICATION_NOT_FOUND: () => new AppError(2108, '申请不存在或已处理', 404),
  INVITATION_NOT_FOUND: () => new AppError(2109, '邀请不存在或已过期', 404),
  INVITE_REQUIRED: () => new AppError(2110, '该公会仅限邀请加入', 403),
  LEADER_MUST_TRANSFER: () => new AppError(2111, '会长需先转让职位（或在只剩自己时解散公会）', 409),
  TARGET_NOT_MEMBER: () => new AppError(2112, '目标用户不是本公会成员', 404),
  INVALID: (msg) => new AppError(2113, msg, 400),
  BUFF_LOCKED: (lv) => new AppError(2114, `公会达到 ${lv} 级后才能激活该增益`, 403),
  INSUFFICIENT_TREASURY: (n) => new AppError(2115, `公会资金不足（需要 ${n}）`, 400),
  INSUFFICIENT_ITEMS: () => new AppError(2116, '道具数量不足', 400),
  CLAIM_LIMIT: (n) => new AppError(2117, `今日领取已达上限（${n} 个）`, 429),
  STOCK_EMPTY: () => new AppError(2118, '仓库库存不足', 409),
  CHAT_RATE: () => new AppError(2119, '发言太快了，请稍后再试', 429),
  BLOCKED: () => new AppError(2120, '无法对该用户执行此操作', 403),
  ALREADY_APPLIED: () => new AppError(2121, '你已提交过申请，请等待审核', 409),
  TARGET_IN_GUILD: () => new AppError(2122, '对方已加入其他公会', 409),
  UNKNOWN_ITEM: () => new AppError(2123, '该道具不能存入公会仓库', 400),
  INVALID_CODE: () => new AppError(2124, '邀请码无效', 404),
  NOT_FOUND_EVENT: () => new AppError(2125, '活动不存在', 404),
};

const ITEM_ID_RE = /^[A-Z0-9_]{2,64}$/;
const NAME_CONSTRAINTS = new Set(['uq_guilds_name_active', 'guilds_name_key']);
const ONE_GUILD_CONSTRAINTS = new Set(['uq_guild_members_one_guild', 'guild_members_user_id_key', 'idx_guild_members_user_unique', 'one_guild_per_user', 'unique_guild_member', 'guild_members_guild_id_user_id_key']);

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 把唯一约束冲突翻译成业务错误；其他错误原样抛出 */
function mapUniqueError(err) {
  if (err && (err.code === '23505' || err.code === '23P01')) {
    if (NAME_CONSTRAINTS.has(err.constraint)) return E.NAME_TAKEN();
    if (ONE_GUILD_CONSTRAINTS.has(err.constraint)) return E.ALREADY_IN_GUILD();
    if (err.constraint === 'unique_pending_application') return E.ALREADY_APPLIED();
  }
  return err;
}

function guildView(g, { memberCount = null, viewerRole = null } = {}) {
  if (!g) return null;
  const isMember = !!viewerRole;
  const view = {
    id: g.id,
    guildKey: g.guild_key,
    name: g.name,
    description: g.description || '',
    badgeIcon: g.badge_icon || R.BADGE_ICONS[0],
    level: g.level,
    progress: R.levelProgress(g.experience || 0),
    maxMembers: g.max_members,
    memberCount: memberCount === null ? (g.member_count === undefined ? null : Number(g.member_count)) : memberCount,
    joinType: g.join_type,
    minLevel: g.min_level,
    status: g.status,
    stats: {
      totalContribution: g.total_contribution || 0,
      battlesWon: g.total_battles_won || 0,
      raidsCompleted: g.total_raids_completed || 0,
      tasksCompleted: g.total_tasks_completed || 0,
    },
    createdAt: g.created_at,
  };
  if (isMember) {
    view.myRole = viewerRole;
    view.myTitle = R.memberTitle(viewerRole, g.name);
    view.treasury = g.treasury || 0;
    if (R.can(viewerRole, 'invite')) view.inviteCode = g.invite_code;
  }
  return view;
}

class GuildService {
  constructor({ db = dbDefault, events = socialEvents, now = () => new Date() } = {}) {
    this.db = db;
    this.events = events;
    this.now = now;
  }

  tx(fn) { return this.db.transaction(fn); }

  // ── 查询辅助 ───────────────────────────────────────────────
  async membershipOf(q, userId, { lock = false } = {}) {
    const { rows: [m] } = await q.query(
      `SELECT gm.*, g.status AS guild_status FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
        WHERE gm.user_id = $1 AND g.status = 'active'${lock ? ' FOR UPDATE OF gm' : ''}`, [userId]);
    return m || null;
  }

  async requireMember(q, userId, guildId, { lock = false } = {}) {
    const m = await this.membershipOf(q, userId, { lock });
    if (!m || (guildId !== undefined && guildId !== null && Number(m.guild_id) !== Number(guildId))) throw E.NOT_MEMBER();
    return m;
  }

  async lockGuild(q, guildId) {
    const { rows: [g] } = await q.query(`SELECT * FROM guilds WHERE id = $1 AND status = 'active' FOR UPDATE`, [guildId]);
    if (!g) throw E.NOT_FOUND();
    return g;
  }

  async memberCount(q, guildId) {
    const { rows: [r] } = await q.query('SELECT COUNT(*)::int AS n FROM guild_members WHERE guild_id = $1', [guildId]);
    return r.n;
  }

  async memberIds(q, guildId) {
    const { rows } = await q.query('SELECT user_id FROM guild_members WHERE guild_id = $1', [guildId]);
    return rows.map((r) => r.user_id);
  }

  async officerIds(q, guildId, minRank = 2) {
    const roles = Object.entries(R.RANK).filter(([, r]) => r >= minRank).map(([k]) => k);
    const { rows } = await q.query('SELECT user_id FROM guild_members WHERE guild_id = $1 AND role = ANY($2::text[])', [guildId, roles]);
    return rows.map((r) => r.user_id);
  }

  async systemMessage(q, guildId, content) {
    const { rows: [msg] } = await q.query(
      `INSERT INTO guild_chat_messages (guild_id, user_id, message_type, content) VALUES ($1, NULL, 'system', $2)
       RETURNING id, message_type, content, created_at`, [guildId, content]);
    return msg;
  }

  /** 在事务提交后推送（失败只记日志） */
  notify(userIds, type, payload) {
    return this.events.publish(userIds, type, payload).catch((err) => logger.warn({ err: err.message, type }, 'guild notify failed'));
  }

  /** 插入成员并维护 users.guild_id（调用方已锁公会行并检查容量） */
  async insertMember(q, guildId, userId, role = 'member') {
    try {
      await q.query(`INSERT INTO guild_members (guild_id, user_id, role, contribution_week) VALUES ($1, $2, $3, $4::date)`,
        [guildId, userId, role, R.weekStart(this.now())]);
    } catch (err) { throw mapUniqueError(err); }
    await q.query('UPDATE users SET guild_id = $1 WHERE id = $2', [guildId, userId]);
    await q.query('UPDATE guilds SET last_active_at = NOW(), updated_at = NOW() WHERE id = $1', [guildId]);
  }

  async removeMember(q, guildId, userId) {
    await q.query('DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    await q.query('UPDATE users SET guild_id = NULL WHERE id = $1 AND guild_id = $2', [userId, guildId]);
  }

  /** 公会加经验并在跨级时更新等级与成员上限；返回 { level, levelUp } */
  async addGuildExp(q, guildId, exp) {
    if (!(exp > 0)) return { levelUp: false };
    const { rows: [g] } = await q.query(
      `UPDATE guilds SET experience = experience + $2, last_active_at = NOW(), updated_at = NOW() WHERE id = $1
       RETURNING experience, level`, [guildId, Math.floor(exp)]);
    if (!g) return { levelUp: false };
    const lv = R.levelForExperience(g.experience);
    if (lv !== g.level) {
      await q.query('UPDATE guilds SET level = $2, max_members = GREATEST(max_members, $3) WHERE id = $1', [guildId, lv, R.maxMembersForLevel(lv)]);
    }
    return { level: lv, levelUp: lv > g.level };
  }

  /** 成员加贡献（每周贡献跨周懒重置） */
  async addContribution(q, guildId, userId, amount) {
    const n = Math.max(0, Math.floor(amount));
    if (!n) return;
    await q.query(`
      UPDATE guild_members
         SET contribution = contribution + $3,
             weekly_contribution = CASE WHEN contribution_week = $4::date THEN weekly_contribution + $3 ELSE $3 END,
             contribution_week = $4::date, last_contribution_at = NOW(), last_active_at = NOW()
       WHERE guild_id = $1 AND user_id = $2`, [guildId, userId, n, R.weekStart(this.now())]);
    await q.query('UPDATE guilds SET total_contribution = total_contribution + $2 WHERE id = $1', [guildId, n]);
  }

  // ── 公会本身 ───────────────────────────────────────────────
  async getMine(userId) {
    const m = await this.membershipOf(this.db, userId);
    if (!m) return { guild: null };
    const { rows: [g] } = await this.db.query('SELECT * FROM guilds WHERE id = $1', [m.guild_id]);
    const count = await this.memberCount(this.db, m.guild_id);
    const buffs = await this.activeBuffs(m.guild_id);
    return {
      guild: guildView(g, { memberCount: count, viewerRole: m.role }),
      membership: {
        role: m.role, contribution: m.contribution,
        weeklyContribution: m.contribution_week && R.weekStart(new Date(m.contribution_week)) === R.weekStart(this.now()) ? m.weekly_contribution : 0,
        joinedAt: m.joined_at, showOnline: m.show_online !== false,
        permissions: Object.keys(R.PERMISSIONS).filter((a) => R.can(m.role, a)),
      },
      buffs,
    };
  }

  async get(guildId, viewerId) {
    if (!Number.isInteger(Number(guildId))) throw E.NOT_FOUND();
    const { rows: [g] } = await this.db.query(
      `SELECT g.*, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id)::int AS member_count
         FROM guilds g WHERE g.id = $1 AND g.status = 'active'`, [guildId]);
    if (!g) throw E.NOT_FOUND();
    const m = viewerId ? await this.membershipOf(this.db, viewerId) : null;
    const role = m && Number(m.guild_id) === Number(g.id) ? m.role : null;
    return guildView(g, { viewerRole: role });
  }

  async create(userId, input) {
    const { value, errors } = R.validateGuildInput(input);
    if (errors.length) throw E.INVALID(errors.join('；'));
    const guild = await this.tx(async (c) => {
      if (await this.membershipOf(c, userId)) throw E.ALREADY_IN_GUILD();
      const { rows: [nameHit] } = await c.query(
        `SELECT 1 FROM guilds WHERE lower(name) = lower($1) AND status <> 'disbanded'`, [value.name]);
      if (nameHit) throw E.NAME_TAKEN();
      const { rowCount } = await c.query(
        'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1', [R.CREATE_COST_COINS, userId]);
      if (!rowCount) throw E.INSUFFICIENT_COINS(R.CREATE_COST_COINS);
      let g;
      try {
        ({ rows: [g] } = await c.query(`
          INSERT INTO guilds (guild_key, name, description, badge_icon, join_type, min_level, invite_code, created_by,
                              level, experience, max_members, treasury, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0, $9, 0, 'active') RETURNING *`,
        [`G-${randomCode(8)}`, value.name, value.description || '', value.badgeIcon, value.joinType, value.minLevel,
          randomCode(8), userId, R.maxMembersForLevel(1)]));
      } catch (err) { throw mapUniqueError(err); }
      await this.insertMember(c, g.id, userId, 'leader');
      await this.systemMessage(c, g.id, `公会「${g.name}」成立了！`);
      return g;
    });
    logger.info({ guildId: guild.id, userId }, 'guild created');
    return guildView(guild, { memberCount: 1, viewerRole: 'leader' });
  }

  async search({ q, joinType, page = 1, limit = 20 } = {}) {
    const where = [`g.status = 'active'`];
    const params = [];
    if (q && String(q).trim()) {
      params.push(`%${escapeLike(String(q).trim().slice(0, 30))}%`);
      where.push(`(g.name ILIKE $${params.length} OR g.guild_key = upper($${params.length}))`);
    }
    if (joinType && R.JOIN_TYPES.includes(joinType)) { params.push(joinType); where.push(`g.join_type = $${params.length}`); }
    const lim = Math.max(1, Math.min(50, Number(limit) || 20));
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;
    const { rows: [{ n: total }] } = await this.db.query(`SELECT COUNT(*)::int AS n FROM guilds g WHERE ${where.join(' AND ')}`, params);
    const { rows } = await this.db.query(`
      SELECT g.*, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id)::int AS member_count
        FROM guilds g WHERE ${where.join(' AND ')}
       ORDER BY g.level DESC, g.experience DESC, g.id
       LIMIT ${lim} OFFSET ${off}`, params);
    return { guilds: rows.map((g) => guildView(g)), total, page: Math.floor(off / lim) + 1, pageSize: lim };
  }

  /** 排行榜：by=level（等级+经验）或 weekly（本周贡献） */
  async leaderboard({ by = 'level', limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    if (by === 'weekly') {
      const { rows } = await this.db.query(`
        SELECT g.id, g.name, g.badge_icon, g.level,
               COALESCE(SUM(gm.weekly_contribution) FILTER (WHERE gm.contribution_week = $1::date), 0)::int AS score,
               COUNT(gm.user_id)::int AS member_count
          FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id = g.id
         WHERE g.status = 'active'
         GROUP BY g.id ORDER BY score DESC, g.level DESC, g.id LIMIT $2`, [R.weekStart(this.now()), lim]);
      return { by, entries: rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, badgeIcon: r.badge_icon, level: r.level, score: r.score, memberCount: r.member_count })) };
    }
    const { rows } = await this.db.query(`
      SELECT g.id, g.name, g.badge_icon, g.level, g.experience,
             (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id)::int AS member_count
        FROM guilds g WHERE g.status = 'active'
       ORDER BY g.level DESC, g.experience DESC, g.id LIMIT $1`, [lim]);
    return { by: 'level', entries: rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, badgeIcon: r.badge_icon, level: r.level, score: r.experience, memberCount: r.member_count })) };
  }

  async updateSettings(actorId, guildId, patch) {
    const { value, errors } = R.validateGuildInput(patch, { partial: true });
    if (errors.length) throw E.INVALID(errors.join('；'));
    const g = await this.tx(async (c) => {
      const m = await this.requireMember(c, actorId, guildId);
      if (!R.can(m.role, 'edit_settings')) throw E.FORBIDDEN();
      await this.lockGuild(c, guildId);
      if (value.name) {
        const { rows: [hit] } = await c.query(
          `SELECT 1 FROM guilds WHERE lower(name) = lower($1) AND status <> 'disbanded' AND id <> $2`, [value.name, guildId]);
        if (hit) throw E.NAME_TAKEN();
      }
      const cols = { name: 'name', description: 'description', joinType: 'join_type', minLevel: 'min_level', badgeIcon: 'badge_icon' };
      const sets = [];
      const params = [guildId];
      for (const [k, col] of Object.entries(cols)) {
        if (value[k] === undefined) continue;
        params.push(value[k]);
        sets.push(`${col} = $${params.length}`);
      }
      try {
        const { rows: [row] } = await c.query(`UPDATE guilds SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, params);
        return { row, role: m.role };
      } catch (err) { throw mapUniqueError(err); }
    });
    return guildView(g.row, { viewerRole: g.role });
  }

  async regenerateInviteCode(actorId, guildId) {
    return this.tx(async (c) => {
      const m = await this.requireMember(c, actorId, guildId);
      if (!R.can(m.role, 'regenerate_invite_code')) throw E.FORBIDDEN();
      const code = randomCode(8);
      await c.query('UPDATE guilds SET invite_code = $2, updated_at = NOW() WHERE id = $1', [guildId, code]);
      return { inviteCode: code };
    });
  }

  // ── 加入 / 申请 / 邀请 ─────────────────────────────────────
  /** 加入前的通用检查（已锁公会行）：不在其他公会、等级、容量 */
  async assertCanEnter(c, g, userId, { checkLevel = true } = {}) {
    if (await this.membershipOf(c, userId)) throw E.ALREADY_IN_GUILD();
    if (checkLevel) {
      const { rows: [u] } = await c.query('SELECT level FROM users WHERE id = $1', [userId]);
      if (!u) throw E.INVALID('用户不存在');
      if ((u.level || 1) < (g.min_level || 1)) throw E.LEVEL_TOO_LOW(g.min_level);
    }
    if (await this.memberCount(c, g.id) >= g.max_members) throw E.FULL();
  }

  /**
   * 加入公会：public 直接加入；apply 提交申请；invite_only 需要有效邀请（有邀请时直接接受）
   * @returns {{ status: 'joined'|'applied', guildId, applicationId? }}
   */
  async join(userId, guildId, { message } = {}) {
    const res = await this.tx(async (c) => {
      const g = await this.lockGuild(c, guildId);
      if (g.join_type === 'invite_only') {
        const { rows: [inv] } = await c.query(`
          SELECT id FROM guild_invitations WHERE guild_id = $1 AND invitee_id = $2 AND status = 'pending'
             AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE`, [g.id, userId]);
        if (!inv) throw E.INVITE_REQUIRED();
        await this.assertCanEnter(c, g, userId);
        await c.query(`UPDATE guild_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [inv.id]);
        await this.insertMember(c, g.id, userId);
        return { status: 'joined', guild: g };
      }
      await this.assertCanEnter(c, g, userId);
      if (g.join_type === 'public') {
        await this.insertMember(c, g.id, userId);
        return { status: 'joined', guild: g };
      }
      const text = R.cleanText(message || '', 200);
      let app;
      try {
        ({ rows: [app] } = await c.query(
          `INSERT INTO guild_applications (guild_id, user_id, application_text, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
          [g.id, userId, text || null]));
      } catch (err) { throw mapUniqueError(err); }
      return { status: 'applied', guild: g, applicationId: app.id };
    });
    if (res.status === 'joined') await this.afterJoin(res.guild, userId);
    else this.notify(await this.officerIds(this.db, res.guild.id), 'guild_application', { guildId: res.guild.id, applicationId: res.applicationId });
    return { status: res.status, guildId: res.guild.id, applicationId: res.applicationId };
  }

  async afterJoin(g, userId) {
    const { rows: [u] } = await this.db.query('SELECT nickname FROM users WHERE id = $1', [userId]);
    const msg = await this.systemMessage(this.db, g.id, `${u ? u.nickname : '新成员'} 加入了公会`);
    this.notify(await this.memberIds(this.db, g.id), 'guild_member_joined', { guildId: g.id, userId, message: msg });
  }

  async joinByCode(userId, code) {
    const c0 = R.normalizeInviteCode(code);
    if (!c0) throw E.INVALID_CODE();
    const { rows: [hit] } = await this.db.query(`SELECT id FROM guilds WHERE invite_code = $1 AND status = 'active'`, [c0]);
    if (!hit) throw E.INVALID_CODE();
    const g = await this.tx(async (c) => {
      const locked = await this.lockGuild(c, hit.id);
      if (locked.invite_code !== c0) throw E.INVALID_CODE(); // 并发重置了邀请码
      await this.assertCanEnter(c, locked, userId);
      await this.insertMember(c, locked.id, userId);
      return locked;
    });
    await this.afterJoin(g, userId);
    return { status: 'joined', guildId: g.id };
  }

  async listApplications(actorId, guildId) {
    const m = await this.requireMember(this.db, actorId, guildId);
    if (!R.can(m.role, 'view_applications')) throw E.FORBIDDEN();
    const { rows } = await this.db.query(`
      SELECT a.id, a.user_id, a.application_text, a.created_at, u.nickname, u.level, u.avatar_url, u.team
        FROM guild_applications a JOIN users u ON u.id = a.user_id
       WHERE a.guild_id = $1 AND a.status = 'pending' ORDER BY a.created_at LIMIT 100`, [guildId]);
    return { applications: rows };
  }

  async reviewApplication(actorId, guildId, applicationId, approve, note) {
    const res = await this.tx(async (c) => {
      const m = await this.requireMember(c, actorId, guildId);
      if (!R.can(m.role, 'review_applications')) throw E.FORBIDDEN();
      const { rows: [app] } = await c.query(
        `SELECT * FROM guild_applications WHERE id = $1 AND guild_id = $2 AND status = 'pending' FOR UPDATE`, [applicationId, guildId]);
      if (!app) throw E.APPLICATION_NOT_FOUND();
      const g = await this.lockGuild(c, guildId);
      let status = approve ? 'approved' : 'rejected';
      if (approve) {
        if (await this.membershipOf(c, app.user_id)) status = 'withdrawn'; // 申请人已加入其他公会
        else {
          if (await this.memberCount(c, g.id) >= g.max_members) throw E.FULL();
          await this.insertMember(c, g.id, app.user_id);
        }
      }
      await c.query(`UPDATE guild_applications SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4 WHERE id = $1`,
        [app.id, status, actorId, R.cleanText(note || '', 200) || null]);
      return { status, userId: app.user_id, guild: g };
    });
    if (res.status === 'withdrawn') throw E.TARGET_IN_GUILD();
    this.notify([res.userId], 'guild_application_reviewed', { guildId: res.guild.id, guildName: res.guild.name, approved: res.status === 'approved' });
    if (res.status === 'approved') await this.afterJoin(res.guild, res.userId);
    return { status: res.status };
  }

  async withdrawApplication(userId, guildId) {
    const { rowCount } = await this.db.query(
      `UPDATE guild_applications SET status = 'withdrawn' WHERE guild_id = $1 AND user_id = $2 AND status = 'pending'`, [guildId, userId]);
    if (!rowCount) throw E.APPLICATION_NOT_FOUND();
    return { withdrawn: true };
  }

  async invite(actorId, guildId, inviteeId) {
    if (!isUuid(inviteeId)) throw E.INVALID('userId 必须是有效的用户 ID');
    if (inviteeId === actorId) throw E.INVALID('不能邀请自己');
    const res = await this.tx(async (c) => {
      const m = await this.requireMember(c, actorId, guildId);
      if (!R.can(m.role, 'invite')) throw E.FORBIDDEN();
      const g = await this.lockGuild(c, guildId);
      const { rows: [u] } = await c.query('SELECT id FROM users WHERE id = $1', [inviteeId]);
      if (!u) throw E.INVALID('用户不存在');
      if (await relationship.isBlockedEitherWay(c, actorId, inviteeId)) throw E.BLOCKED();
      if (await this.membershipOf(c, inviteeId)) throw E.TARGET_IN_GUILD();
      const { rows: [inv] } = await c.query(`
        INSERT INTO guild_invitations (guild_id, inviter_id, invitee_id, status, expires_at)
        VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '7 days')
        ON CONFLICT (guild_id, invitee_id) WHERE status = 'pending'
        DO UPDATE SET inviter_id = EXCLUDED.inviter_id, expires_at = EXCLUDED.expires_at, created_at = NOW()
        RETURNING id, expires_at`, [g.id, actorId, inviteeId]);
      const { rows: [me] } = await c.query('SELECT nickname FROM users WHERE id = $1', [actorId]);
      return { inv, g, inviter: me ? me.nickname : '' };
    });
    this.notify([inviteeId], 'guild_invite', { invitationId: res.inv.id, guildId: res.g.id, guildName: res.g.name, from: { id: actorId, nickname: res.inviter } });
    return { invitationId: res.inv.id, expiresAt: res.inv.expires_at };
  }

  async myInvitations(userId) {
    const { rows } = await this.db.query(`
      SELECT i.id, i.guild_id, i.created_at, i.expires_at, g.name AS guild_name, g.level, g.badge_icon, u.nickname AS inviter_nickname
        FROM guild_invitations i JOIN guilds g ON g.id = i.guild_id AND g.status = 'active'
        LEFT JOIN users u ON u.id = i.inviter_id
       WHERE i.invitee_id = $1 AND i.status = 'pending' AND (i.expires_at IS NULL OR i.expires_at > NOW())
       ORDER BY i.created_at DESC LIMIT 50`, [userId]);
    return { invitations: rows };
  }

  async respondInvitation(userId, invitationId, accept) {
    const res = await this.tx(async (c) => {
      const { rows: [inv] } = await c.query(`
        SELECT * FROM guild_invitations WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE`, [invitationId, userId]);
      if (!inv) throw E.INVITATION_NOT_FOUND();
      if (!accept) {
        await c.query(`UPDATE guild_invitations SET status = 'declined', responded_at = NOW() WHERE id = $1`, [inv.id]);
        return { status: 'declined' };
      }
      const g = await this.lockGuild(c, inv.guild_id);
      await this.assertCanEnter(c, g, userId, { checkLevel: false }); // 被邀请不受最低等级限制
      await c.query(`UPDATE guild_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [inv.id]);
      await this.insertMember(c, g.id, userId);
      return { status: 'joined', guild: g };
    });
    if (res.status === 'joined') await this.afterJoin(res.guild, userId);
    return { status: res.status, guildId: res.guild ? res.guild.id : undefined };
  }

  // ── 成员管理 ───────────────────────────────────────────────
  async members(viewerId, guildId, { page = 1, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;
    const { rows: [g] } = await this.db.query(`SELECT id, name FROM guilds WHERE id = $1 AND status = 'active'`, [guildId]);
    if (!g) throw E.NOT_FOUND();
    const viewer = viewerId ? await this.membershipOf(this.db, viewerId) : null;
    const viewerIsMember = !!viewer && Number(viewer.guild_id) === Number(g.id);
    const week = R.weekStart(this.now());
    const { rows: [{ n: total }] } = await this.db.query('SELECT COUNT(*)::int AS n FROM guild_members WHERE guild_id = $1', [g.id]);
    const { rows } = await this.db.query(`
      SELECT gm.user_id, gm.role, gm.contribution, gm.joined_at, gm.battles_participated, gm.raids_participated, gm.show_online,
             CASE WHEN gm.contribution_week = $2::date THEN gm.weekly_contribution ELSE 0 END AS weekly_contribution,
             u.nickname, u.avatar_url, u.level, u.team, u.last_active_at
        FROM guild_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.guild_id = $1
       ORDER BY CASE gm.role WHEN 'leader' THEN 0 WHEN 'co_leader' THEN 1 WHEN 'elder' THEN 2 ELSE 3 END,
                gm.contribution DESC, gm.joined_at, gm.user_id
       LIMIT ${lim} OFFSET ${off}`, [g.id, week]);

    let online = new Map();
    if (viewerIsMember && rows.length) online = await this.onlineStatuses(viewerId, rows);
    return {
      members: rows.map((r) => ({
        userId: r.user_id, nickname: r.nickname, avatarUrl: r.avatar_url, level: r.level, team: r.team,
        role: r.role, roleLabel: R.ROLE_LABEL[r.role] || R.ROLE_LABEL.member, title: R.memberTitle(r.role, g.name),
        contribution: r.contribution, weeklyContribution: r.weekly_contribution,
        battlesParticipated: r.battles_participated || 0, raidsParticipated: r.raids_participated || 0,
        joinedAt: r.joined_at,
        ...(viewerIsMember ? { onlineStatus: online.get(r.user_id) || 'hidden' } : {}),
      })),
      total, page: Math.floor(off / lim) + 1, pageSize: lim,
    };
  }

  /**
   * 公会成员之间的在线状态：成员开启了 show_online（默认开启）即向公会成员显示；
   * 关闭时按个人隐私设置 online_status_visibility 判断；任一方向拉黑一律隐藏。
   */
  async onlineStatuses(viewerId, rows) {
    const ids = rows.map((r) => r.user_id);
    const [rels, settings] = await Promise.all([
      relationship.getRelationships(this.db, viewerId, ids),
      relationship.getPrivacySettingsMany(this.db, ids),
    ]);
    const out = new Map();
    for (const r of rows) {
      const rel = rels.get(r.user_id) || relationship.emptyRelationship(viewerId, r.user_id);
      const visible = !rel.blocked && (rel.isOwner || r.show_online !== false || privacyRules.canView(settings.get(r.user_id), 'online_status', rel));
      out.set(r.user_id, visible ? privacyRules.onlineStatus(r.last_active_at) : 'hidden');
    }
    return out;
  }

  async setShowOnline(userId, show) {
    if (typeof show !== 'boolean') throw E.INVALID('showOnline 必须是布尔值');
    const m = await this.requireMember(this.db, userId);
    await this.db.query('UPDATE guild_members SET show_online = $3 WHERE guild_id = $1 AND user_id = $2', [m.guild_id, userId, show]);
    return { showOnline: show };
  }

  async leave(userId) {
    const res = await this.tx(async (c) => {
      const m = await this.membershipOf(c, userId, { lock: true });
      if (!m) throw E.NOT_MEMBER();
      if (m.role === 'leader') {
        if (await this.memberCount(c, m.guild_id) > 1) throw E.LEADER_MUST_TRANSFER();
        await this.disbandTx(c, m.guild_id);
        return { disbanded: true, guildId: m.guild_id };
      }
      await this.lockGuild(c, m.guild_id);
      await this.removeMember(c, m.guild_id, userId);
      const { rows: [u] } = await c.query('SELECT nickname FROM users WHERE id = $1', [userId]);
      await this.systemMessage(c, m.guild_id, `${u ? u.nickname : '成员'} 离开了公会`);
      return { disbanded: false, guildId: m.guild_id };
    });
    if (!res.disbanded) this.notify(await this.memberIds(this.db, res.guildId), 'guild_member_left', { guildId: res.guildId, userId });
    return { left: true, disbanded: res.disbanded };
  }

  async kick(actorId, guildId, targetId) {
    if (!isUuid(targetId)) throw E.INVALID('userId 必须是有效的用户 ID');
    await this.tx(async (c) => {
      const actor = await this.requireMember(c, actorId, guildId);
      await this.lockGuild(c, guildId);
      const { rows: [t] } = await c.query('SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, targetId]);
      if (!t) throw E.TARGET_NOT_MEMBER();
      if (!R.canKick(actor.role, t.role)) throw E.FORBIDDEN();
      await this.removeMember(c, guildId, targetId);
      await this.systemMessage(c, guildId, '一名成员被移出了公会');
    });
    this.notify([targetId], 'guild_kicked', { guildId: Number(guildId) });
    this.notify(await this.memberIds(this.db, guildId), 'guild_member_left', { guildId: Number(guildId), userId: targetId, kicked: true });
    return { kicked: true };
  }

  async setRole(actorId, guildId, targetId, role) {
    if (!isUuid(targetId)) throw E.INVALID('userId 必须是有效的用户 ID');
    if (!['co_leader', 'elder', 'member'].includes(role)) throw E.INVALID('role 必须是 co_leader/elder/member');
    await this.tx(async (c) => {
      const actor = await this.requireMember(c, actorId, guildId);
      const { rows: [t] } = await c.query('SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, targetId]);
      if (!t) throw E.TARGET_NOT_MEMBER();
      if (!R.canSetRole(actor.role, t.role, role)) throw E.FORBIDDEN();
      await c.query('UPDATE guild_members SET role = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, targetId, role]);
    });
    this.notify([targetId], 'guild_role_changed', { guildId: Number(guildId), role, roleLabel: R.ROLE_LABEL[role] });
    return { userId: targetId, role };
  }

  async transferLeadership(actorId, guildId, targetId) {
    if (!isUuid(targetId) || targetId === actorId) throw E.INVALID('目标用户无效');
    await this.tx(async (c) => {
      const actor = await this.requireMember(c, actorId, guildId, { lock: true });
      if (!R.can(actor.role, 'transfer')) throw E.FORBIDDEN();
      const { rows: [t] } = await c.query('SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, targetId]);
      if (!t) throw E.TARGET_NOT_MEMBER();
      await c.query(`UPDATE guild_members SET role = 'co_leader' WHERE guild_id = $1 AND user_id = $2`, [guildId, actorId]);
      await c.query(`UPDATE guild_members SET role = 'leader' WHERE guild_id = $1 AND user_id = $2`, [guildId, targetId]);
      await this.systemMessage(c, guildId, '会长职位已转让');
    });
    this.notify(await this.memberIds(this.db, guildId), 'guild_leader_changed', { guildId: Number(guildId), leaderId: targetId });
    return { leaderId: targetId };
  }

  async disbandTx(c, guildId) {
    await c.query(`UPDATE guilds SET status = 'disbanded', disbanded_at = NOW(), invite_code = NULL, updated_at = NOW() WHERE id = $1`, [guildId]);
    await c.query('UPDATE users SET guild_id = NULL WHERE guild_id = $1', [guildId]);
    await c.query('DELETE FROM guild_members WHERE guild_id = $1', [guildId]);
    await c.query(`UPDATE guild_applications SET status = 'withdrawn' WHERE guild_id = $1 AND status = 'pending'`, [guildId]);
    await c.query(`UPDATE guild_invitations SET status = 'expired' WHERE guild_id = $1 AND status = 'pending'`, [guildId]);
    await c.query(`UPDATE squads SET guild_id = NULL, join_policy = CASE WHEN join_policy = 'guild' THEN 'invite' ELSE join_policy END
                    WHERE guild_id = $1 AND status <> 'disbanded'`, [guildId]);
  }

  async disband(actorId, guildId) {
    const ids = await this.tx(async (c) => {
      const m = await this.requireMember(c, actorId, guildId, { lock: true });
      if (!R.can(m.role, 'disband')) throw E.FORBIDDEN();
      await this.lockGuild(c, guildId);
      const members = await this.memberIds(c, guildId);
      await this.disbandTx(c, guildId);
      return members;
    });
    this.notify(ids, 'guild_disbanded', { guildId: Number(guildId) });
    logger.info({ guildId, actorId }, 'guild disbanded');
    return { disbanded: true };
  }

  // ── 资源：金库、仓库、增益 ─────────────────────────────────
  async donateCoins(userId, amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 10 || n > R.MAX_DONATION_COINS) throw E.INVALID(`捐赠金额必须是 10–${R.MAX_DONATION_COINS} 的整数`);
    const res = await this.tx(async (c) => {
      const m = await this.requireMember(c, userId, undefined, { lock: true });
      const { rowCount } = await c.query('UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1', [n, userId]);
      if (!rowCount) throw E.INSUFFICIENT_COINS(n);
      const contribution = R.contributionForCoins(n);
      await c.query('UPDATE guilds SET treasury = treasury + $2 WHERE id = $1', [m.guild_id, n]);
      await c.query('UPDATE guild_members SET total_donated = total_donated + $3 WHERE guild_id = $1 AND user_id = $2', [m.guild_id, userId, n]);
      await c.query(`INSERT INTO guild_donations (guild_id, user_id, donation_type, amount, contribution_gained) VALUES ($1, $2, 'coins', $3, $4)`,
        [m.guild_id, userId, n, contribution]);
      await this.addContribution(c, m.guild_id, userId, contribution);
      const lv = await this.addGuildExp(c, m.guild_id, contribution);
      return { guildId: m.guild_id, contribution, ...lv };
    });
    if (res.levelUp) this.notify(await this.memberIds(this.db, res.guildId), 'guild_level_up', { guildId: res.guildId, level: res.level });
    this.refreshTasks(res.guildId).catch((err) => logger.warn({ err: err.message }, 'task refresh failed'));
    return { donated: n, contribution: res.contribution, levelUp: !!res.levelUp, level: res.level };
  }

  async itemStock(userId) {
    const m = await this.requireMember(this.db, userId);
    const { rows } = await this.db.query(
      'SELECT item_id, quantity, updated_at FROM guild_item_stock WHERE guild_id = $1 AND quantity > 0 ORDER BY item_id', [m.guild_id]);
    const claimed = await this.claimedToday(this.db, m.guild_id, userId);
    return { items: rows.map((r) => ({ itemId: r.item_id, quantity: r.quantity })), claimedToday: claimed, dailyLimit: R.dailyClaimLimit(m.role) };
  }

  async claimedToday(q, guildId, userId) {
    const { rows: [r] } = await q.query(`
      SELECT COALESCE(SUM(quantity), 0)::int AS n FROM guild_item_log
       WHERE guild_id = $1 AND user_id = $2 AND action = 'claim' AND created_at >= date_trunc('day', NOW())`, [guildId, userId]);
    return r.n;
  }

  async donateItems(userId, itemId, quantity) {
    const qty = Number(quantity);
    if (!ITEM_ID_RE.test(String(itemId || ''))) throw E.UNKNOWN_ITEM();
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw E.INVALID('数量必须是 1–100 的整数');
    const res = await this.tx(async (c) => {
      const m = await this.requireMember(c, userId, undefined, { lock: true });
      if (!(await inventory.consumeItem(c, userId, itemId, qty))) throw E.INSUFFICIENT_ITEMS();
      await c.query(`
        INSERT INTO guild_item_stock (guild_id, item_id, quantity) VALUES ($1, $2, $3)
        ON CONFLICT (guild_id, item_id) DO UPDATE SET quantity = guild_item_stock.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [m.guild_id, itemId, qty]);
      await c.query(`INSERT INTO guild_item_log (guild_id, user_id, item_id, quantity, action) VALUES ($1, $2, $3, $4, 'donate')`,
        [m.guild_id, userId, itemId, qty]);
      await c.query(`INSERT INTO guild_donations (guild_id, user_id, donation_type, amount, contribution_gained) VALUES ($1, $2, 'items', $3, $3)`,
        [m.guild_id, userId, qty]);
      await this.addContribution(c, m.guild_id, userId, qty);
      const lv = await this.addGuildExp(c, m.guild_id, qty);
      return { guildId: m.guild_id, ...lv };
    });
    if (res.levelUp) this.notify(await this.memberIds(this.db, res.guildId), 'guild_level_up', { guildId: res.guildId, level: res.level });
    return { itemId, donated: qty, contribution: qty };
  }

  async claimItems(userId, itemId, quantity) {
    const qty = Number(quantity);
    if (!ITEM_ID_RE.test(String(itemId || ''))) throw E.UNKNOWN_ITEM();
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw E.INVALID('数量必须是 1–50 的整数');
    return this.tx(async (c) => {
      const m = await this.requireMember(c, userId, undefined, { lock: true });
      const limit = R.dailyClaimLimit(m.role);
      const used = await this.claimedToday(c, m.guild_id, userId);
      if (used + qty > limit) throw E.CLAIM_LIMIT(limit);
      const { rowCount } = await c.query(
        `UPDATE guild_item_stock SET quantity = quantity - $3, updated_at = NOW() WHERE guild_id = $1 AND item_id = $2 AND quantity >= $3`,
        [m.guild_id, itemId, qty]);
      if (!rowCount) throw E.STOCK_EMPTY();
      const { credited, skipped } = await inventory.addItems(c, userId, [{ type: itemId, qty }]);
      if (skipped.length || !credited.length) throw E.UNKNOWN_ITEM();
      await c.query(`INSERT INTO guild_item_log (guild_id, user_id, item_id, quantity, action) VALUES ($1, $2, $3, $4, 'claim')`,
        [m.guild_id, userId, itemId, qty]);
      return { itemId, claimed: qty, claimedToday: used + qty, dailyLimit: limit };
    });
  }

  async activeBuffs(guildId) {
    const { rows } = await this.db.query(`
      SELECT buff_type, buff_value, activated_at, expires_at FROM guild_buffs
       WHERE guild_id = $1 AND expires_at > NOW() ORDER BY expires_at`, [guildId]);
    return rows.map((r) => ({ type: r.buff_type, value: Number(r.buff_value), label: (R.BUFFS[r.buff_type] || {}).label || r.buff_type, activatedAt: r.activated_at, expiresAt: r.expires_at }));
  }

  async buffCatalog(userId) {
    const m = await this.requireMember(this.db, userId);
    const { rows: [g] } = await this.db.query('SELECT level, treasury FROM guilds WHERE id = $1', [m.guild_id]);
    return {
      level: g.level, treasury: g.treasury,
      catalog: Object.entries(R.BUFFS).map(([type, b]) => ({ type, ...b, unlocked: g.level >= b.unlockLevel })),
      active: await this.activeBuffs(m.guild_id),
      canActivate: R.can(m.role, 'activate_buff'),
    };
  }

  async activateBuff(actorId, buffType) {
    const b = R.BUFFS[buffType];
    if (!b) throw E.INVALID('未知的增益类型');
    const res = await this.tx(async (c) => {
      const m = await this.requireMember(c, actorId);
      if (!R.can(m.role, 'activate_buff')) throw E.FORBIDDEN();
      const g = await this.lockGuild(c, m.guild_id);
      if (g.level < b.unlockLevel) throw E.BUFF_LOCKED(b.unlockLevel);
      if ((g.treasury || 0) < b.cost) throw E.INSUFFICIENT_TREASURY(b.cost);
      await c.query('UPDATE guilds SET treasury = treasury - $2 WHERE id = $1', [g.id, b.cost]);
      // 仍在生效时从原到期时间顺延
      const { rows: [row] } = await c.query(`
        INSERT INTO guild_buffs (guild_id, buff_type, buff_value, duration_hours, activated_at, expires_at, cost)
        VALUES ($1, $2, $3, $4, NOW(), NOW() + make_interval(hours => $4), $5)
        ON CONFLICT (guild_id, buff_type) DO UPDATE SET
          buff_value = EXCLUDED.buff_value, duration_hours = EXCLUDED.duration_hours, cost = EXCLUDED.cost,
          activated_at = CASE WHEN guild_buffs.expires_at > NOW() THEN guild_buffs.activated_at ELSE NOW() END,
          expires_at = GREATEST(guild_buffs.expires_at, NOW()) + make_interval(hours => EXCLUDED.duration_hours)
        RETURNING expires_at`, [g.id, buffType, b.value, b.hours, b.cost]);
      await this.systemMessage(c, g.id, `公会增益「${b.label}」已激活`);
      return { guildId: g.id, expiresAt: row.expires_at };
    });
    this.notify(await this.memberIds(this.db, res.guildId), 'guild_buff_activated', { guildId: res.guildId, type: buffType, label: b.label, expiresAt: res.expiresAt });
    return { type: buffType, expiresAt: res.expiresAt };
  }

  // ── 每周任务 ───────────────────────────────────────────────
  async ensureWeeklyTasks(q, guildId, level) {
    for (const t of R.weeklyTaskInstances(level, this.now())) {
      await q.query(`
        INSERT INTO guild_tasks (guild_id, task_key, title, description, task_type, requirement, rewards, task_period,
                                 current_progress, target_progress, contribution_reward, starts_at, ends_at, is_completed)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'weekly', 0, $8, 0, $9, $10, FALSE)
        ON CONFLICT (guild_id, task_key, starts_at) DO NOTHING`,
      [guildId, t.taskKey, t.title, t.description, t.taskType, JSON.stringify({ target: t.target }), JSON.stringify(t.rewards), t.target, t.startsAt, t.endsAt]);
    }
  }

  async taskProgress(q, guildId, task) {
    const win = [guildId, task.starts_at, task.ends_at];
    let sql;
    switch (task.task_type) {
      case 'catch':
        sql = `SELECT COUNT(*)::int AS n FROM pokemon_instances pi JOIN guild_members gm ON gm.user_id = pi.user_id AND gm.guild_id = $1
                WHERE pi.caught_at >= $2 AND pi.caught_at < $3`;
        break;
      case 'raid':
        sql = `SELECT COUNT(*)::int AS n FROM squad_battles WHERE guild_id = $1 AND source = 'raid' AND outcome = 'won' AND ended_at >= $2 AND ended_at < $3`;
        break;
      case 'battle':
        sql = `SELECT COUNT(*)::int AS n FROM squad_battles WHERE guild_id = $1 AND source IN ('raid', 'gym') AND outcome = 'won' AND ended_at >= $2 AND ended_at < $3`;
        break;
      case 'donate':
        sql = `SELECT COALESCE(SUM(amount), 0)::int AS n FROM guild_donations WHERE guild_id = $1 AND donation_type = 'coins' AND created_at >= $2 AND created_at < $3`;
        break;
      default:
        return task.current_progress || 0;
    }
    const { rows: [r] } = await q.query(sql, win);
    return r.n;
  }

  /** 重新统计本周任务进度；新达成的任务在事务内原子标记完成并发放公会经验/资金 */
  async refreshTasks(guildId) {
    const { rows: [g] } = await this.db.query(`SELECT id, level FROM guilds WHERE id = $1 AND status = 'active'`, [guildId]);
    if (!g) return [];
    await this.ensureWeeklyTasks(this.db, g.id, g.level);
    const { rows: tasks } = await this.db.query(
      `SELECT * FROM guild_tasks WHERE guild_id = $1 AND starts_at <= NOW() AND ends_at > NOW() ORDER BY id`, [g.id]);
    const completed = [];
    for (const t of tasks) {
      const progress = await this.taskProgress(this.db, g.id, t);
      if (progress !== t.current_progress) {
        await this.db.query('UPDATE guild_tasks SET current_progress = $2 WHERE id = $1', [t.id, progress]);
        t.current_progress = progress;
      }
      if (!t.is_completed && progress >= t.target_progress) {
        const done = await this.tx(async (c) => {
          const { rows: [row] } = await c.query(
            'UPDATE guild_tasks SET is_completed = TRUE, completed_at = NOW() WHERE id = $1 AND NOT is_completed RETURNING rewards', [t.id]);
          if (!row) return null;
          const rw = row.rewards || {};
          if (rw.treasury > 0) await c.query('UPDATE guilds SET treasury = treasury + $2 WHERE id = $1', [g.id, rw.treasury]);
          await c.query('UPDATE guilds SET total_tasks_completed = total_tasks_completed + 1 WHERE id = $1', [g.id]);
          const lv = await this.addGuildExp(c, g.id, rw.guildExp || 0);
          await this.systemMessage(c, g.id, `公会任务「${t.title}」完成！`);
          return lv;
        });
        if (done) {
          t.is_completed = true;
          completed.push(t.task_key);
          this.notify(await this.memberIds(this.db, g.id), 'guild_task_completed', { guildId: g.id, taskKey: t.task_key, title: t.title, levelUp: done.levelUp, level: done.level });
        }
      }
    }
    return tasks.map((t) => ({
      id: t.id, key: t.task_key, type: t.task_type, title: t.title, description: t.description,
      progress: t.current_progress, target: t.target_progress, completed: !!t.is_completed,
      rewards: t.rewards, endsAt: t.ends_at, justCompleted: completed.includes(t.task_key),
    }));
  }

  async tasks(userId) {
    const m = await this.requireMember(this.db, userId);
    return { tasks: await this.refreshTasks(m.guild_id) };
  }

  // ── 聊天 / 公告 / 日历 / 战报 ───────────────────────────────
  async sendChat(userId, content) {
    const text = R.sanitizeChat(content);
    if (!text) throw E.INVALID('消息内容不能为空');
    const m = await this.requireMember(this.db, userId);
    const { rows: [last] } = await this.db.query(
      `SELECT created_at FROM guild_chat_messages WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [m.guild_id, userId]);
    if (last && Date.now() - new Date(last.created_at).getTime() < 1000) throw E.CHAT_RATE();
    const { rows: [msg] } = await this.db.query(`
      INSERT INTO guild_chat_messages (guild_id, user_id, message_type, content) VALUES ($1, $2, 'text', $3)
      RETURNING id, user_id, message_type, content, created_at`, [m.guild_id, userId, text]);
    const { rows: [u] } = await this.db.query('SELECT nickname FROM users WHERE id = $1', [userId]);
    const out = { ...msg, nickname: u ? u.nickname : null };
    this.notify(await this.memberIds(this.db, m.guild_id), 'guild_chat', { guildId: m.guild_id, message: out });
    return out;
  }

  async chatHistory(userId, { before, limit = 50 } = {}) {
    const m = await this.requireMember(this.db, userId);
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const params = [m.guild_id];
    let cond = '';
    if (before !== undefined && before !== null && before !== '') {
      if (!Number.isInteger(Number(before))) throw E.INVALID('before 必须是消息 ID');
      params.push(Number(before));
      cond = ` AND m.id < $${params.length}`;
    }
    const { rows } = await this.db.query(`
      SELECT m.id, m.user_id, m.message_type, m.content, m.created_at, u.nickname
        FROM guild_chat_messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.guild_id = $1${cond} ORDER BY m.id DESC LIMIT ${lim}`, params);
    // 对拉黑了的发言者只显示占位
    const blocked = new Set();
    const others = [...new Set(rows.map((r) => r.user_id).filter((id) => id && id !== userId))];
    if (others.length) {
      const { rows: b } = await this.db.query(`
        SELECT CASE WHEN user_id = $1 THEN blocked_user_id ELSE user_id END AS other FROM blocked_users
         WHERE (user_id = $1 AND blocked_user_id = ANY($2::uuid[])) OR (blocked_user_id = $1 AND user_id = ANY($2::uuid[]))`, [userId, others]);
      for (const r of b) blocked.add(r.other);
    }
    const messages = rows.reverse().map((r) => (blocked.has(r.user_id) ? { ...r, content: '（已屏蔽的消息）', nickname: null } : r));
    return { messages, nextBefore: rows.length === lim ? rows[rows.length - 1].id : null };
  }

  async announcements(userId) {
    const m = await this.requireMember(this.db, userId);
    const { rows } = await this.db.query(`
      SELECT a.id, a.title, a.content, a.is_pinned, a.created_at, a.expires_at, u.nickname AS author
        FROM guild_announcements a LEFT JOIN users u ON u.id = a.author_id
       WHERE a.guild_id = $1 AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 50`, [m.guild_id]);
    return { announcements: rows, canManage: R.can(m.role, 'announce') };
  }

  async createAnnouncement(userId, { title, content, pinned = false, expiresInDays } = {}) {
    const t = R.cleanText(title || '', 60);
    const body = R.cleanText(content || '', 2000);
    if (!t || !body) throw E.INVALID('标题和内容不能为空');
    const days = expiresInDays === undefined || expiresInDays === null ? null : Number(expiresInDays);
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 90)) throw E.INVALID('expiresInDays 必须是 1–90 的整数');
    const m = await this.requireMember(this.db, userId);
    if (!R.can(m.role, 'announce')) throw E.FORBIDDEN();
    const { rows: [a] } = await this.db.query(`
      INSERT INTO guild_announcements (guild_id, author_id, title, content, is_pinned, expires_at)
      VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $6::int) END)
      RETURNING id, title, content, is_pinned, created_at, expires_at`, [m.guild_id, userId, t, body, !!pinned, days]);
    this.notify(await this.memberIds(this.db, m.guild_id), 'guild_announcement', { guildId: m.guild_id, id: a.id, title: a.title });
    return a;
  }

  async deleteAnnouncement(userId, id) {
    const m = await this.requireMember(this.db, userId);
    if (!R.can(m.role, 'announce')) throw E.FORBIDDEN();
    const { rowCount } = await this.db.query('DELETE FROM guild_announcements WHERE id = $1 AND guild_id = $2', [id, m.guild_id]);
    if (!rowCount) throw new AppError(2126, '公告不存在', 404);
    return { deleted: true };
  }

  async events(userId) {
    const m = await this.requireMember(this.db, userId);
    const { rows } = await this.db.query(`
      SELECT e.id, e.event_type, e.title, e.description, e.location, e.starts_at, e.ends_at, e.created_by, u.nickname AS creator
        FROM guild_events e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.guild_id = $1 AND COALESCE(e.ends_at, e.starts_at + INTERVAL '2 hours') > NOW()
       ORDER BY e.starts_at LIMIT 50`, [m.guild_id]);
    return { events: rows, canManage: R.can(m.role, 'manage_events') };
  }

  async createEvent(userId, input = {}) {
    const title = R.cleanText(input.title || '', 60);
    if (!title) throw E.INVALID('活动标题不能为空');
    const type = ['raid', 'meetup', 'battle', 'community_day', 'other'].includes(input.eventType) ? input.eventType : 'other';
    const starts = new Date(input.startsAt);
    const ends = input.endsAt ? new Date(input.endsAt) : null;
    if (Number.isNaN(starts.getTime())) throw E.INVALID('startsAt 必须是有效时间');
    if (starts.getTime() < Date.now() - 3600000 || starts.getTime() > Date.now() + 90 * 86400000) throw E.INVALID('活动时间须在未来 90 天内');
    if (ends && (Number.isNaN(ends.getTime()) || ends < starts)) throw E.INVALID('endsAt 必须晚于 startsAt');
    const m = await this.requireMember(this.db, userId);
    if (!R.can(m.role, 'manage_events')) throw E.FORBIDDEN();
    const { rows: [e] } = await this.db.query(`
      INSERT INTO guild_events (guild_id, created_by, event_type, title, description, location, starts_at, ends_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [m.guild_id, userId, type, title, R.cleanText(input.description || '', 500) || null, R.cleanText(input.location || '', 200) || null, starts, ends]);
    this.notify(await this.memberIds(this.db, m.guild_id), 'guild_event_created', { guildId: m.guild_id, id: e.id, title: e.title, startsAt: e.starts_at });
    return e;
  }

  async deleteEvent(userId, id) {
    const m = await this.requireMember(this.db, userId);
    const { rows: [e] } = await this.db.query('SELECT created_by FROM guild_events WHERE id = $1 AND guild_id = $2', [id, m.guild_id]);
    if (!e) throw E.NOT_FOUND_EVENT();
    if (e.created_by !== userId && !R.can(m.role, 'kick')) throw E.FORBIDDEN();
    await this.db.query('DELETE FROM guild_events WHERE id = $1', [id]);
    return { deleted: true };
  }

  /** 公会战报：公会小队的最近战绩（含参战成员与贡献） */
  async battleReports(userId, { limit = 20 } = {}) {
    const m = await this.requireMember(this.db, userId);
    const lim = Math.max(1, Math.min(50, Number(limit) || 20));
    const { rows } = await this.db.query(`
      SELECT b.id, b.source, b.battle_ref, b.outcome, b.ended_at, b.duration_seconds, b.total_score, b.details,
             s.name AS squad_name,
             COALESCE(json_agg(json_build_object('userId', bm.user_id, 'nickname', u.nickname, 'score', bm.score, 'isMvp', bm.is_mvp)
                      ORDER BY bm.score DESC) FILTER (WHERE bm.user_id IS NOT NULL), '[]') AS members
        FROM squad_battles b
        LEFT JOIN squads s ON s.id = b.squad_id
        LEFT JOIN squad_battle_members bm ON bm.battle_id = b.id
        LEFT JOIN users u ON u.id = bm.user_id
       WHERE b.guild_id = $1
       GROUP BY b.id, s.name ORDER BY b.ended_at DESC LIMIT ${lim}`, [m.guild_id]);
    const { rows: [sum] } = await this.db.query(`
      SELECT COUNT(*)::int AS battles, COUNT(*) FILTER (WHERE outcome = 'won')::int AS wins,
             COUNT(*) FILTER (WHERE source = 'raid' AND outcome = 'won')::int AS raid_wins
        FROM squad_battles WHERE guild_id = $1`, [m.guild_id]);
    return { reports: rows, summary: { battles: sum.battles, wins: sum.wins, raidWins: sum.raid_wins, winRate: sum.battles ? Math.round((sum.wins / sum.battles) * 1000) / 10 : 0 } };
  }

  /**
   * 小队战绩计入公会（由 squad/battleIngest 在同一事务内调用）：成员贡献、参战次数、公会经验与统计
   * @param {import('pg').PoolClient} c
   * @param {number} guildId
   * @param {{ source, outcome, members: Array<{userId, contribution}> }} battle
   */
  async applySquadBattle(c, guildId, battle) {
    const { rows: [g] } = await c.query(`SELECT id FROM guilds WHERE id = $1 AND status = 'active' FOR UPDATE`, [guildId]);
    if (!g) return { applied: false };
    let total = 0;
    for (const mem of battle.members) {
      const { rowCount } = await c.query(`
        UPDATE guild_members SET battles_participated = battles_participated + 1,
               raids_participated = raids_participated + CASE WHEN $3 = 'raid' THEN 1 ELSE 0 END
         WHERE guild_id = $1 AND user_id = $2`, [guildId, mem.userId, battle.source]);
      if (!rowCount) continue; // 已不在公会的成员不计贡献
      await this.addContribution(c, guildId, mem.userId, mem.contribution);
      total += mem.contribution;
    }
    if (battle.outcome === 'won') {
      await c.query(`UPDATE guilds SET total_battles_won = total_battles_won + 1,
                            total_raids_completed = total_raids_completed + CASE WHEN $2 = 'raid' THEN 1 ELSE 0 END WHERE id = $1`,
      [guildId, battle.source]);
    }
    const lv = await this.addGuildExp(c, guildId, total);
    return { applied: true, contribution: total, ...lv };
  }
}

const guildService = new GuildService();
module.exports = guildService;
module.exports.GuildService = GuildService;
module.exports.guildView = guildView;
module.exports.mapUniqueError = mapUniqueError;
module.exports.errors = E;
