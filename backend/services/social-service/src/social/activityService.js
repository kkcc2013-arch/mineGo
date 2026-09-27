/**
 * REQ-00388：好友动态流与互动提醒中心
 *
 * 动态流合并三类来源（按好友的隐私设置逐个过滤）：
 *   - friend_activities：加好友、收礼、友情升级、联合任务完成等（activity_visibility）
 *   - pokemon_instances：好友近 7 天捕捉记录（pokemon_collection_visibility；闪光需 pokemon_shinies_visibility）
 *   - user_achievements：好友近 7 天解锁的成就（achievements_visibility）
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const rules = require('../../../../shared/social/privacyRules');
const pokemonPrivacy = require('../../../../shared/social/pokemonPrivacyStore');
const friendService = require('../friendService');

class ActivityService {
  constructor({ db = dbDefault, friends = friendService } = {}) {
    this.db = db;
    this.friends = friends;
  }

  /** 我的好友及其对我的可见性 */
  async friendVisibility(userId) {
    const { rows } = await this.db.query(`
      SELECT f.friend_user_id AS id, u.nickname, u.avatar_url,
             r.permission_level, r.group_id, r.permission_overrides, to_jsonb(ps) AS privacy
        FROM friends f
        JOIN users u ON u.id = f.friend_user_id
        LEFT JOIN friends r ON r.user_id = f.friend_user_id AND r.friend_user_id = f.user_id
        LEFT JOIN privacy_settings ps ON ps.user_id = f.friend_user_id
       WHERE f.user_id = $1 AND f.status = 'accepted'`, [userId]);
    return rows.map((r) => {
      const s = rules.withDefaults(r.privacy);
      const rel = { isFriend: true, permissionLevel: r.permission_level || 'regular', groupId: r.group_id, overrides: r.permission_overrides || {} };
      return {
        id: r.id, nickname: r.nickname, avatar_url: r.avatar_url,
        vis: rules.visibilityMap(s, rel, ['activity', 'pokemon_collection', 'pokemon_shinies', 'achievements']),
      };
    });
  }

  async getFeed(userId, { limit = 30, before = null } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const beforeTs = before ? new Date(before) : new Date(Date.now() + 60000);
    if (Number.isNaN(beforeTs.getTime())) throw new AppError(1001, 'before 必须是时间', 400);
    const friends = await this.friendVisibility(userId);
    const byId = new Map(friends.map((f) => [f.id, f]));
    const idsWith = (k) => friends.filter((f) => f.vis[k]).map((f) => f.id);
    const actIds = idsWith('activity');
    const catchIds = idsWith('pokemon_collection');
    const achIds = idsWith('achievements');

    const [acts, catches, achs] = await Promise.all([
      actIds.length ? this.db.query(`
        SELECT a.id, a.user_id, a.activity_type, a.content, a.like_count, a.comment_count, a.created_at,
               EXISTS (SELECT 1 FROM friend_activity_likes l WHERE l.activity_id = a.id AND l.user_id = $4) AS liked
          FROM friend_activities a
         WHERE a.user_id = ANY($1::uuid[]) AND a.visibility IN ('public', 'friends') AND a.created_at < $2
         ORDER BY a.created_at DESC LIMIT $3`, [actIds, beforeTs, lim, userId]) : { rows: [] },
      catchIds.length ? this.db.query(`
        SELECT p.id, p.user_id, p.species_id, p.nickname, p.cp, p.is_shiny, p.caught_at, p.power_up_count,
               p.iv_attack, p.iv_defense, p.iv_hp, s.name_zh, s.sprite_url, s.sprite_shiny_url
          FROM pokemon_instances p JOIN pokemon_species s ON s.id = p.species_id
         WHERE p.user_id = ANY($1::uuid[]) AND p.caught_at > NOW() - INTERVAL '7 days' AND p.caught_at < $2
           AND NOT COALESCE(p.is_deleted, false)
         ORDER BY p.caught_at DESC LIMIT $3`, [catchIds, beforeTs, lim]) : { rows: [] },
      achIds.length ? this.db.query(`
        SELECT ua.user_id, ua.achievement_id, COALESCE(ua.completed_at, ua.unlocked_at) AS at,
               a.name, a.rarity, a.icon_url
          FROM user_achievements ua LEFT JOIN achievements a ON a.achievement_id = ua.achievement_id
         WHERE ua.user_id = ANY($1::uuid[])
           AND COALESCE(ua.completed_at, ua.unlocked_at) > NOW() - INTERVAL '7 days'
           AND COALESCE(ua.completed_at, ua.unlocked_at) < $2
         ORDER BY at DESC LIMIT $3`, [achIds, beforeTs, lim]) : { rows: [] },
    ]);

    // 捕捉记录逐只按精灵隐私过滤（hidden 不出现，CP 等按可见性返回）
    const catchViews = await pokemonPrivacy.visibleViews(this.db, userId, catches.rows);
    const who = (id) => ({ id, nickname: byId.get(id)?.nickname, avatar_url: byId.get(id)?.avatar_url });
    const items = [
      ...acts.rows.map((a) => ({
        id: `act:${a.id}`, activityId: Number(a.id), type: a.activity_type, user: who(a.user_id),
        content: a.content, likeCount: a.like_count, liked: a.liked, likable: true, createdAt: a.created_at,
      })),
      ...catches.rows.map((p, i) => ({ p, v: catchViews[i] })).filter((x) => x.v).map(({ p, v }) => ({
        id: `catch:${p.id}`, type: 'catch_pokemon', user: who(p.user_id), likable: false, createdAt: p.caught_at,
        content: {
          pokemonId: p.id, speciesId: p.species_id, name: p.name_zh, cp: v.cp, sprite_url: v.appearance.sprite_url,
          is_shiny: v.appearance.is_shiny,
        },
      })),
      ...achs.rows.map((a) => ({
        id: `ach:${a.user_id}:${a.achievement_id}`, type: 'achievement_unlock', user: who(a.user_id), likable: false,
        createdAt: a.at, content: { achievementId: a.achievement_id, name: a.name, rarity: a.rarity, icon_url: a.icon_url },
      })),
    ].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, lim);
    return {
      items,
      nextBefore: items.length === lim ? items[items.length - 1].createdAt : null,
    };
  }

  /** 点赞好友动态（每条只能点一次；首次点赞计一次 like_post 互动，每天每对好友计分一次） */
  async like(userId, activityId) {
    const id = parseInt(activityId, 10);
    if (!Number.isInteger(id)) throw new AppError(1001, 'activityId 无效', 400);
    const { rows: [a] } = await this.db.query(`
      SELECT a.id, a.user_id FROM friend_activities a
       WHERE a.id = $1 AND (a.user_id = $2 OR EXISTS (
         SELECT 1 FROM friends f WHERE f.user_id = $2 AND f.friend_user_id = a.user_id AND f.status = 'accepted'))`,
    [id, userId]);
    if (!a) throw new AppError(1004, '动态不存在', 404);
    const liked = await this.db.transaction(async (c) => {
      const { rowCount } = await c.query(
        'INSERT INTO friend_activity_likes (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
      if (rowCount) await c.query('UPDATE friend_activities SET like_count = like_count + 1 WHERE id = $1', [id]);
      return rowCount > 0;
    });
    if (liked && a.user_id !== userId) await this.friends.recordInteraction(userId, a.user_id, 'like_post', { activityId: id });
    const { rows: [cnt] } = await this.db.query('SELECT like_count FROM friend_activities WHERE id = $1', [id]);
    return { success: true, liked: true, newlyLiked: liked, likeCount: cnt.like_count };
  }

  // ── 提醒中心 ────────────────────────────────────────────────
  async listReminders(userId, { unreadOnly = false, limit = 50 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const { rows } = await this.db.query(`
      SELECT r.id, r.reminder_type, r.related_user_id, u.nickname AS related_nickname, r.content, r.is_read, r.created_at
        FROM interaction_reminders r LEFT JOIN users u ON u.id = r.related_user_id
       WHERE r.user_id = $1 ${unreadOnly ? 'AND NOT r.is_read' : ''}
       ORDER BY r.created_at DESC LIMIT $2`, [userId, lim]);
    const { rows: [c] } = await this.db.query(
      'SELECT COUNT(*)::int AS n FROM interaction_reminders WHERE user_id = $1 AND NOT is_read', [userId]);
    return { reminders: rows, unread: c.n };
  }

  async markRemindersRead(userId, ids = null) {
    let res;
    if (Array.isArray(ids) && ids.length) {
      res = await this.db.query(
        'UPDATE interaction_reminders SET is_read = true WHERE user_id = $1 AND id = ANY($2::bigint[]) AND NOT is_read',
        [userId, ids.map((x) => parseInt(x, 10)).filter(Number.isInteger)]);
    } else {
      res = await this.db.query('UPDATE interaction_reminders SET is_read = true WHERE user_id = $1 AND NOT is_read', [userId]);
    }
    return { success: true, updated: res.rowCount };
  }
}

const instance = new ActivityService();
module.exports = instance;
module.exports.ActivityService = ActivityService;
