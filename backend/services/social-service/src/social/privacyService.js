/**
 * REQ-00228：社交隐私设置与好友权限管理
 *
 * - privacy_settings：10 类数据可见性（public/friends/close_friends/family/custom/private）+ 行为开关
 * - friend_groups：自定义分组（名称/颜色/图标/权限级别），好友加入分组即继承分组权限级别
 * - friends 行上的 permission_level / permission_overrides：单个好友的权限分级与覆盖
 * - blocked_users：拉黑后自动解除好友、撤销双方待处理申请、屏蔽精灵好友关系、终止联合任务
 * - 所有设置变更写 audit_logs；设置不缓存（主键查询），并经 WebSocket 推送给本人其他设备与好友，实时生效
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const socialEvents = require('../../../../shared/social/socialEvents');
const rules = require('../../../../shared/social/privacyRules');
const relationship = require('../../../../shared/social/relationship');
const friendService = require('../friendService');

const MAX_GROUPS = 20;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const bad = (msg) => new AppError(1001, msg, 400);

class PrivacyService {
  constructor({ db = dbDefault, events = socialEvents, friends = friendService } = {}) {
    this.db = db;
    this.events = events;
    this.friends = friends;
  }

  async getSettings(userId) {
    const s = await relationship.getPrivacySettings(this.db, userId);
    return { ...s, dataTypes: Object.keys(rules.DATA_TYPES), levels: rules.VISIBILITY_LEVELS };
  }

  async updateSettings(userId, patch, req = null) {
    const { value, errors } = rules.sanitizeSettingsPatch(patch);
    if (errors.length) throw bad(errors.join('；'));
    if (value.custom_groups) {
      const ids = [...new Set(Object.values(value.custom_groups).flat())];
      if (ids.length) {
        const { rows } = await this.db.query(
          'SELECT id FROM friend_groups WHERE user_id = $1 AND id = ANY($2::int[])', [userId, ids]);
        if (rows.length !== ids.length) throw bad('custom_groups 中包含不属于你的分组');
      }
    }
    const cols = Object.keys(value);
    const result = await this.db.transaction(async (c) => {
      const { rows: [old] } = await c.query('SELECT * FROM privacy_settings WHERE user_id = $1 FOR UPDATE', [userId]);
      const vals = cols.map((k) => (k === 'custom_groups' ? JSON.stringify(value[k]) : value[k]));
      const { rows: [row] } = await c.query(`
        INSERT INTO privacy_settings (user_id, ${cols.join(', ')}, version, updated_at)
        VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, 1, NOW())
        ON CONFLICT (user_id) DO UPDATE
           SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(', ')},
               version = privacy_settings.version + 1, updated_at = NOW()
        RETURNING *`, [userId, ...vals]);
      const before = rules.withDefaults(old);
      const changed = {};
      for (const k of cols) {
        if (JSON.stringify(before[k]) !== JSON.stringify(row[k])) changed[k] = { from: before[k], to: row[k] };
      }
      await this.friends.audit(c, userId, 'privacy_settings_changed', userId, { changed, version: row.version }, req);
      return { row, changed };
    });
    const settings = rules.withDefaults(result.row);
    settings.version = result.row.version;
    await this.events.publish([userId], 'privacy_updated', { settings, changed: Object.keys(result.changed) });
    const { rows: friendRows } = await this.db.query(
      "SELECT friend_user_id FROM friends WHERE user_id = $1 AND status = 'accepted'", [userId]);
    if (friendRows.length) {
      await this.events.publish(friendRows.map((r) => r.friend_user_id), 'friend_privacy_changed', { friendId: userId });
    }
    return settings;
  }

  async checkVisibility(viewerId, targetId, dataType) {
    if (!rules.DATA_TYPES[dataType]) throw bad(`dataType 必须是 ${Object.keys(rules.DATA_TYPES).join('/')}`);
    if (!relationship.isUuid(targetId)) throw bad('targetId 必须是有效的用户 ID');
    const [settings, rel] = await Promise.all([
      relationship.getPrivacySettings(this.db, targetId),
      relationship.getRelationship(this.db, viewerId, targetId),
    ]);
    return { targetId, dataType, canView: rules.canView(settings, dataType, rel) };
  }

  /** 批量可见性检查：3 条查询（关系、隐私设置）+ 内存计算 */
  async batchCheck(viewerId, targetIds, dataTypes) {
    if (!Array.isArray(targetIds) || !targetIds.length) throw bad('targetIds 必须是非空数组');
    if (targetIds.length > 200) throw bad('targetIds 最多 200 个');
    const types = Array.isArray(dataTypes) && dataTypes.length ? dataTypes : Object.keys(rules.DATA_TYPES);
    const unknown = types.filter((t) => !rules.DATA_TYPES[t]);
    if (unknown.length) throw bad(`未知 dataType: ${unknown.join(',')}`);
    const ids = targetIds.filter(relationship.isUuid);
    const [rels, settings] = await Promise.all([
      relationship.getRelationships(this.db, viewerId, ids),
      relationship.getPrivacySettingsMany(this.db, ids),
    ]);
    const results = {};
    for (const id of targetIds) {
      const rel = id === viewerId ? relationship.emptyRelationship(viewerId, id) : rels.get(id);
      results[id] = rel ? rules.visibilityMap(settings.get(id), rel, types) : Object.fromEntries(types.map((t) => [t, false]));
    }
    return { results, dataTypes: types };
  }

  // ── 分组 ─────────────────────────────────────────────────
  async listGroups(userId) {
    const { rows } = await this.db.query(`
      SELECT g.id, g.name, g.permission_level, g.color, g.icon, g.sort_order, g.created_at,
             (SELECT COUNT(*)::int FROM friends f WHERE f.user_id = g.user_id AND f.group_id = g.id AND f.status = 'accepted') AS member_count
        FROM friend_groups g WHERE g.user_id = $1 ORDER BY g.sort_order, g.id`, [userId]);
    return rows;
  }

  _groupFields(body, partial) {
    const out = {};
    if (body.name !== undefined || !partial) {
      const name = String(body.name || '').trim();
      if (!name || name.length > 50) throw bad('分组名称必填，最多 50 个字符');
      out.name = name;
    }
    if (body.permissionLevel !== undefined || body.permission_level !== undefined) {
      const lvl = body.permissionLevel ?? body.permission_level;
      if (!rules.PERMISSION_LEVELS.includes(lvl)) throw bad(`permissionLevel 必须是 ${rules.PERMISSION_LEVELS.join('/')}`);
      out.permission_level = lvl;
    }
    if (body.color !== undefined) {
      if (!COLOR_RE.test(body.color)) throw bad('color 必须是 #RRGGBB');
      out.color = body.color;
    }
    if (body.icon !== undefined) out.icon = body.icon === null ? null : String(body.icon).slice(0, 50);
    if (body.sortOrder !== undefined || body.sort_order !== undefined) {
      const so = parseInt(body.sortOrder ?? body.sort_order, 10);
      if (!Number.isInteger(so)) throw bad('sortOrder 必须是整数');
      out.sort_order = so;
    }
    return out;
  }

  async createGroup(userId, body, req = null) {
    const f = this._groupFields(body || {}, false);
    return this.db.transaction(async (c) => {
      const { rows: [cnt] } = await c.query('SELECT COUNT(*)::int AS n FROM friend_groups WHERE user_id = $1', [userId]);
      if (cnt.n >= MAX_GROUPS) throw bad(`最多创建 ${MAX_GROUPS} 个分组`);
      let row;
      try {
        ({ rows: [row] } = await c.query(`
          INSERT INTO friend_groups (user_id, name, permission_level, color, icon, sort_order)
          VALUES ($1, $2, COALESCE($3, 'regular'), COALESCE($4, '#4CAF50'), $5, COALESCE($6, 0))
          RETURNING *`, [userId, f.name, f.permission_level || null, f.color || null, f.icon || null, f.sort_order ?? null]));
      } catch (err) {
        if (err.code === '23505') throw new AppError(1009, '分组名称已存在', 409);
        throw err;
      }
      await this.friends.audit(c, userId, 'friend_group_created', String(row.id), { name: row.name, permission_level: row.permission_level }, req);
      return row;
    });
  }

  async updateGroup(userId, groupId, body, req = null) {
    const f = this._groupFields(body || {}, true);
    const keys = Object.keys(f);
    if (!keys.length) throw bad('没有可更新的字段');
    const row = await this.db.transaction(async (c) => {
      let updated;
      try {
        ({ rows: [updated] } = await c.query(`
          UPDATE friend_groups SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW()
           WHERE id = $1 AND user_id = $2 RETURNING *`, [parseInt(groupId, 10), userId, ...keys.map((k) => f[k])]));
      } catch (err) {
        if (err.code === '23505') throw new AppError(1009, '分组名称已存在', 409);
        throw err;
      }
      if (!updated) throw new AppError(1004, '分组不存在', 404);
      if (f.permission_level) {
        await c.query(`UPDATE friends SET permission_level = $3, updated_at = NOW()
                        WHERE user_id = $1 AND group_id = $2`, [userId, updated.id, f.permission_level]);
      }
      await this.friends.audit(c, userId, 'friend_group_updated', String(updated.id), f, req);
      return updated;
    });
    if (f.permission_level) await this._notifyGroupMembers(userId, row.id);
    return row;
  }

  async deleteGroup(userId, groupId, req = null) {
    return this.db.transaction(async (c) => {
      const { rows } = await c.query('DELETE FROM friend_groups WHERE id = $1 AND user_id = $2 RETURNING id, name',
        [parseInt(groupId, 10), userId]);
      if (!rows.length) throw new AppError(1004, '分组不存在', 404);
      await this.friends.audit(c, userId, 'friend_group_deleted', String(rows[0].id), { name: rows[0].name }, req);
      return { success: true };
    });
  }

  async _notifyGroupMembers(userId, groupId) {
    const { rows } = await this.db.query(
      "SELECT friend_user_id FROM friends WHERE user_id = $1 AND group_id = $2 AND status = 'accepted'", [userId, groupId]);
    if (rows.length) await this.events.publish(rows.map((r) => r.friend_user_id), 'friend_privacy_changed', { friendId: userId });
  }

  /**
   * 设置单个好友的权限级别/分组/权限覆盖/备注/标签/收藏
   */
  async updateFriendPermissions(userId, friendId, body = {}, req = null) {
    if (!relationship.isUuid(friendId)) throw bad('friendId 无效');
    const sets = {};
    if (body.groupId !== undefined || body.group_id !== undefined) {
      const gid = body.groupId ?? body.group_id;
      if (gid === null) sets.group_id = null;
      else {
        const { rows: [g] } = await this.db.query(
          'SELECT id, permission_level FROM friend_groups WHERE id = $1 AND user_id = $2', [parseInt(gid, 10), userId]);
        if (!g) throw bad('分组不存在');
        sets.group_id = g.id;
        if (body.permissionLevel === undefined && body.permission_level === undefined) sets.permission_level = g.permission_level;
      }
    }
    const lvl = body.permissionLevel ?? body.permission_level;
    if (lvl !== undefined) {
      if (!rules.PERMISSION_LEVELS.includes(lvl)) throw bad(`permissionLevel 必须是 ${rules.PERMISSION_LEVELS.join('/')}`);
      sets.permission_level = lvl;
    }
    if (body.overrides !== undefined) {
      if (!body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) throw bad('overrides 必须是对象');
      const o = {};
      for (const [k, v] of Object.entries(body.overrides)) {
        if (!rules.DATA_TYPES[k]) throw bad(`overrides 中未知数据类型 ${k}`);
        if (v !== null && typeof v !== 'boolean') throw bad(`overrides.${k} 必须是布尔值或 null`);
        if (v !== null) o[k] = v;
      }
      sets.permission_overrides = JSON.stringify(o);
    }
    if (body.nickname !== undefined) sets.nickname = body.nickname === null ? null : String(body.nickname).slice(0, 50);
    if (body.notes !== undefined) sets.notes = body.notes === null ? null : String(body.notes).slice(0, 500);
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) throw bad('tags 必须是数组');
      sets.tags = body.tags.slice(0, 10).map((t) => String(t).slice(0, 20));
    }
    if (body.favorite !== undefined) {
      if (typeof body.favorite !== 'boolean') throw bad('favorite 必须是布尔值');
      sets.favorite = body.favorite;
    }
    const keys = Object.keys(sets);
    if (!keys.length) throw bad('没有可更新的字段');
    const row = await this.db.transaction(async (c) => {
      const { rows: [r] } = await c.query(`
        UPDATE friends SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW()
         WHERE user_id = $1 AND friend_user_id = $2 AND status = 'accepted'
        RETURNING friend_user_id, permission_level, group_id, permission_overrides, nickname, notes, tags, favorite`,
      [userId, friendId, ...keys.map((k) => sets[k])]);
      if (!r) throw new AppError(2006, '你们还不是好友', 400);
      const privacyRelevant = ['permission_level', 'group_id', 'permission_overrides'].filter((k) => k in sets);
      if (privacyRelevant.length) {
        await this.friends.audit(c, userId, 'friend_permissions_changed', friendId,
          Object.fromEntries(privacyRelevant.map((k) => [k, sets[k]])), req);
      }
      return r;
    });
    if ('permission_level' in sets || 'group_id' in sets || 'permission_overrides' in sets) {
      await this.events.publish([friendId], 'friend_privacy_changed', { friendId: userId });
    }
    return row;
  }

  // ── 黑名单 ─────────────────────────────────────────────────
  async block(userId, targetId, reason = null, req = null) {
    if (!relationship.isUuid(targetId)) throw bad('userId 无效');
    if (targetId === userId) throw bad('不能拉黑自己');
    const res = await this.db.transaction(async (c) => {
      const { rows: [t] } = await c.query('SELECT id FROM users WHERE id = $1', [targetId]);
      if (!t) throw new AppError(2001, '用户不存在', 404);
      await this.friends.lockUsers(c, [userId, targetId]);
      await c.query(`
        INSERT INTO blocked_users (user_id, blocked_user_id, reason) VALUES ($1, $2, $3)
        ON CONFLICT (user_id, blocked_user_id) DO UPDATE SET reason = COALESCE(EXCLUDED.reason, blocked_users.reason)`,
      [userId, targetId, reason ? String(reason).slice(0, 200) : null]);
      const { rowCount: removed } = await c.query(`
        DELETE FROM friends WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)`,
      [userId, targetId]);
      const { rowCount: cancelled } = await c.query(`
        UPDATE friend_requests SET status = 'cancelled', updated_at = NOW()
         WHERE status = 'pending' AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
      [userId, targetId]);
      await c.query(`
        UPDATE pokemon_friendships SET status = 'blocked', responded_at = NOW()
         WHERE status IN ('pending', 'accepted')
           AND ((requester_user_id = $1 AND addressee_user_id = $2) OR (requester_user_id = $2 AND addressee_user_id = $1))`,
      [userId, targetId]);
      const [a, b] = [userId, targetId].sort();
      await c.query(`UPDATE joint_mission_progress SET status = 'failed'
                      WHERE user1_id = $1 AND user2_id = $2 AND status = 'in_progress'`, [a, b]);
      await this.friends.audit(c, userId, 'user_blocked', targetId,
        { reason: reason || null, friendship_removed: removed > 0, requests_cancelled: cancelled }, req);
      return { friendshipRemoved: removed > 0, requestsCancelled: cancelled };
    });
    if (res.friendshipRemoved) {
      await this.friends.bumpLeaderboardVersion([userId, targetId]);
      await this.events.publish([targetId], 'friend_removed', { friendId: userId });
      await this.events.publish([userId], 'friend_removed', { friendId: targetId });
    }
    await this.events.publish([userId], 'user_blocked', { userId: targetId });
    return { success: true, blocked: true, ...res };
  }

  async unblock(userId, targetId, req = null) {
    if (!relationship.isUuid(targetId)) throw bad('userId 无效');
    return this.db.transaction(async (c) => {
      const { rowCount } = await c.query('DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2', [userId, targetId]);
      if (!rowCount) throw new AppError(1004, '该用户不在黑名单中', 404);
      await this.friends.audit(c, userId, 'user_unblocked', targetId, {}, req);
      return { success: true, blocked: false };
    });
  }

  async listBlocked(userId) {
    const { rows } = await this.db.query(`
      SELECT b.blocked_user_id AS user_id, u.nickname, u.avatar_url, b.reason, b.created_at
        FROM blocked_users b JOIN users u ON u.id = b.blocked_user_id
       WHERE b.user_id = $1 ORDER BY b.created_at DESC`, [userId]);
    return rows;
  }

  async auditLog(userId, limit = 50) {
    const { rows } = await this.db.query(`
      SELECT id, action, entity_id AS target, details, created_at
        FROM audit_logs WHERE user_id = $1 AND entity_type = 'social'
       ORDER BY created_at DESC LIMIT $2`, [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]);
    return rows;
  }
}

const instance = new PrivacyService();
module.exports = instance;
module.exports.PrivacyService = PrivacyService;
