/**
 * 社交隐私规则（REQ-00228）——纯函数，social-service / pokemon-service 共用
 *
 * 可见性级别：public（所有人）/ friends（好友）/ close_friends（密友及家人）/ family（仅家人）/
 *             custom（指定好友分组）/ private（仅自己）
 * 好友权限级别：regular < close_friends < family，由数据所有者在自己的好友行（friends.user_id = 所有者）上设置；
 * 所有者还可对单个好友设置权限覆盖（friends.permission_overrides，如 {"location": true}），优先于级别判断。
 * 黑名单（任一方向）一律不可见。
 */
'use strict';

const VISIBILITY_LEVELS = Object.freeze(['public', 'friends', 'close_friends', 'family', 'custom', 'private']);
const PERMISSION_LEVELS = Object.freeze(['regular', 'close_friends', 'family']);
const PERMISSION_RANK = Object.freeze({ regular: 1, close_friends: 2, family: 3 });
const REQUIRED_RANK = Object.freeze({ friends: 1, close_friends: 2, family: 3 });

/** 数据类型 → privacy_settings 列 */
const DATA_TYPES = Object.freeze({
  profile: 'profile_visibility',
  online_status: 'online_status_visibility',
  location: 'location_visibility',
  pokemon_collection: 'pokemon_collection_visibility',
  pokemon_stats: 'pokemon_stats_visibility',
  pokemon_shinies: 'pokemon_shinies_visibility',
  friend_list: 'friend_list_visibility',
  battle_history: 'battle_history_visibility',
  achievements: 'achievements_visibility',
  activity: 'activity_visibility',
});

const BOOLEAN_SETTINGS = Object.freeze([
  'allow_friend_requests', 'allow_trade_requests', 'allow_battle_requests', 'allow_gifts',
  'allow_location_sharing', 'searchable', 'notify_friend_online',
]);

const DEFAULT_PRIVACY = Object.freeze({
  profile_visibility: 'public',
  online_status_visibility: 'friends',
  location_visibility: 'close_friends',
  pokemon_collection_visibility: 'friends',
  pokemon_stats_visibility: 'friends',
  pokemon_shinies_visibility: 'close_friends',
  friend_list_visibility: 'friends',
  battle_history_visibility: 'friends',
  achievements_visibility: 'public',
  activity_visibility: 'friends',
  custom_groups: {},
  allow_friend_requests: true,
  allow_trade_requests: true,
  allow_battle_requests: true,
  allow_gifts: true,
  allow_location_sharing: false,
  searchable: true,
  notify_friend_online: true,
  version: 0,
});

/** 合并数据库行与默认值（行缺失时即默认设置） */
function withDefaults(row) {
  const out = { ...DEFAULT_PRIVACY };
  if (row) {
    for (const k of Object.keys(DEFAULT_PRIVACY)) {
      if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
    }
    if (row.updated_at) out.updated_at = row.updated_at;
  }
  if (!out.custom_groups || typeof out.custom_groups !== 'object') out.custom_groups = {};
  return out;
}

/**
 * 校验并清洗隐私设置补丁，返回 { value, errors }
 * custom_groups: { <dataType>: [groupId, ...] }，仅对取值为 custom 的数据类型生效
 */
function sanitizeSettingsPatch(patch) {
  const value = {};
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { value, errors: ['请求体必须是对象'] };
  }
  const columns = new Set(Object.values(DATA_TYPES));
  for (const [k, v] of Object.entries(patch)) {
    if (columns.has(k)) {
      if (!VISIBILITY_LEVELS.includes(v)) errors.push(`${k} 取值必须是 ${VISIBILITY_LEVELS.join('/')}`);
      else value[k] = v;
    } else if (BOOLEAN_SETTINGS.includes(k)) {
      if (typeof v !== 'boolean') errors.push(`${k} 必须是布尔值`);
      else value[k] = v;
    } else if (k === 'custom_groups') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('custom_groups 必须是对象'); continue; }
      const groups = {};
      for (const [dt, ids] of Object.entries(v)) {
        if (!DATA_TYPES[dt]) { errors.push(`custom_groups 中未知数据类型 ${dt}`); continue; }
        if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
          errors.push(`custom_groups.${dt} 必须是分组 ID 数组`); continue;
        }
        groups[dt] = [...new Set(ids)].slice(0, 20);
      }
      value.custom_groups = groups;
    } else {
      errors.push(`不支持的设置项 ${k}`);
    }
  }
  if (!errors.length && !Object.keys(value).length) errors.push('没有可更新的设置项');
  return { value, errors };
}

/**
 * 判断 viewer 能否查看 owner 的某类数据
 * @param {object} settings  owner 的隐私设置（withDefaults 之后）
 * @param {string} dataType  DATA_TYPES 的键
 * @param {object} rel       getRelationship 返回：{ isOwner, isFriend, blocked, permissionLevel, groupId, overrides }
 */
function canView(settings, dataType, rel) {
  if (!DATA_TYPES[dataType]) throw new Error(`unknown dataType ${dataType}`);
  if (!rel) return false;
  if (rel.isOwner) return true;
  if (rel.blocked) return false;
  const s = settings || DEFAULT_PRIVACY;
  if (dataType === 'location' && !s.allow_location_sharing) return false;

  const override = rel.isFriend && rel.overrides ? rel.overrides[dataType] : undefined;
  if (typeof override === 'boolean') return override;

  const level = s[DATA_TYPES[dataType]] || DEFAULT_PRIVACY[DATA_TYPES[dataType]];
  switch (level) {
    case 'public': return true;
    case 'private': return false;
    case 'custom': {
      const groups = (s.custom_groups && s.custom_groups[dataType]) || [];
      return !!rel.isFriend && rel.groupId != null && groups.includes(Number(rel.groupId));
    }
    default: {
      if (!rel.isFriend) return false;
      const rank = PERMISSION_RANK[rel.permissionLevel] || PERMISSION_RANK.regular;
      return rank >= (REQUIRED_RANK[level] || 1);
    }
  }
}

/** 一次计算多个数据类型的可见性 */
function visibilityMap(settings, rel, dataTypes = Object.keys(DATA_TYPES)) {
  const out = {};
  for (const dt of dataTypes) out[dt] = canView(settings, dt, rel);
  return out;
}

/** 在线状态：online（阈值内）/ away / offline */
function onlineStatus(lastActiveAt, { onlineMinutes = 5, awayMinutes = 60, now = Date.now() } = {}) {
  if (!lastActiveAt) return 'offline';
  const t = lastActiveAt instanceof Date ? lastActiveAt.getTime() : new Date(lastActiveAt).getTime();
  if (!Number.isFinite(t)) return 'offline';
  const mins = (now - t) / 60000;
  if (mins <= onlineMinutes) return 'online';
  if (mins <= awayMinutes) return 'away';
  return 'offline';
}

module.exports = {
  VISIBILITY_LEVELS,
  PERMISSION_LEVELS,
  PERMISSION_RANK,
  DATA_TYPES,
  BOOLEAN_SETTINGS,
  DEFAULT_PRIVACY,
  withDefaults,
  sanitizeSettingsPatch,
  canView,
  visibilityMap,
  onlineStatus,
};
