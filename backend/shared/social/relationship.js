/**
 * 社交关系查询（REQ-00228 / REQ-00377）
 *
 * 关系以数据所有者（owner）视角计算：owner 的好友行（friends.user_id = owner, friend_user_id = viewer）
 * 上保存了 owner 给 viewer 的权限级别、分组和权限覆盖。
 * 所有函数接收 queryable（pg Pool/Client 或 shared/db 的 { query }），便于在事务内复用。
 */
'use strict';

const { withDefaults } = require('./privacyRules');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function emptyRelationship(viewerId, ownerId) {
  return {
    viewerId,
    ownerId,
    isOwner: !!viewerId && viewerId === ownerId,
    isFriend: false,
    blocked: false,
    blockedByOwner: false,
    blockedByViewer: false,
    friendshipLevel: 0,
    intimacyLevel: 0,
    friendshipPoints: 0,
    permissionLevel: null,
    groupId: null,
    overrides: {},
  };
}

/**
 * 批量获取 viewer 相对多个 owner 的关系
 * @returns {Promise<Map<string, object>>}
 */
async function getRelationships(q, viewerId, ownerIds) {
  const ids = [...new Set((ownerIds || []).filter(isUuid))];
  const map = new Map();
  for (const id of ids) map.set(id, emptyRelationship(viewerId, id));
  if (!ids.length || !isUuid(viewerId)) return map;

  const { rows } = await q.query(`
    SELECT o.id AS owner_id,
           f.friendship_level, f.intimacy_level, f.friendship_points, f.permission_level,
           f.group_id, f.permission_overrides,
           EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = o.id AND b.blocked_user_id = $1) AS blocked_by_owner,
           EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = $1 AND b.blocked_user_id = o.id) AS blocked_by_viewer
      FROM unnest($2::uuid[]) AS o(id)
      LEFT JOIN friends f ON f.user_id = o.id AND f.friend_user_id = $1 AND f.status = 'accepted'
  `, [viewerId, ids]);

  for (const r of rows) {
    const rel = map.get(r.owner_id);
    if (!rel) continue;
    rel.blockedByOwner = r.blocked_by_owner;
    rel.blockedByViewer = r.blocked_by_viewer;
    rel.blocked = !rel.isOwner && (r.blocked_by_owner || r.blocked_by_viewer);
    if (r.friendship_level != null && !rel.isOwner) {
      rel.isFriend = true;
      rel.friendshipLevel = Number(r.friendship_level) || 1;
      rel.intimacyLevel = Number(r.intimacy_level) || 1;
      rel.friendshipPoints = Number(r.friendship_points) || 0;
      rel.permissionLevel = r.permission_level || 'regular';
      rel.groupId = r.group_id;
      rel.overrides = r.permission_overrides || {};
    }
  }
  return map;
}

async function getRelationship(q, viewerId, ownerId) {
  if (viewerId && viewerId === ownerId) return emptyRelationship(viewerId, ownerId);
  const map = await getRelationships(q, viewerId, [ownerId]);
  return map.get(ownerId) || emptyRelationship(viewerId, ownerId);
}

/** 批量读取隐私设置（合并默认值） */
async function getPrivacySettingsMany(q, userIds) {
  const ids = [...new Set((userIds || []).filter(isUuid))];
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await q.query('SELECT * FROM privacy_settings WHERE user_id = ANY($1::uuid[])', [ids]);
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  for (const id of ids) map.set(id, withDefaults(byId.get(id)));
  return map;
}

async function getPrivacySettings(q, userId) {
  const map = await getPrivacySettingsMany(q, [userId]);
  return map.get(userId) || withDefaults(null);
}

/** 是否存在任一方向的拉黑 */
async function isBlockedEitherWay(q, a, b) {
  const { rows } = await q.query(`
    SELECT 1 FROM blocked_users
     WHERE (user_id = $1 AND blocked_user_id = $2) OR (user_id = $2 AND blocked_user_id = $1)
     LIMIT 1`, [a, b]);
  return rows.length > 0;
}

module.exports = {
  isUuid,
  emptyRelationship,
  getRelationships,
  getRelationship,
  getPrivacySettings,
  getPrivacySettingsMany,
  isBlockedEitherWay,
};
