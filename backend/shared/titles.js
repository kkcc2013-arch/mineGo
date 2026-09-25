/**
 * 称号（REQ-00106）——数据访问与规则，user-service 路由、资料卡、排行榜、捕捉经验加成共用
 *
 * 解锁：成就完成时由成就引擎自动写入 user_titles（achievements.rewards.title 或 title_definitions.unlock_criteria.achievement_id）；
 *       活动称号在活动完成（领奖）时解锁；管理员可手动发放。玩家不能自行解锁。
 * 激活：每人最多一个激活称号（部分唯一索引 uq_user_titles_one_active + 行锁串行化）。
 * 限时：is_limited 称号带 expires_at，过期后不可激活、定时任务自动取消激活。
 * 加成：激活称号的 stat_bonuses；exp_bonus 已接入捕捉经验（catch-service），上限 50%。
 */
'use strict';

const { localize } = require('./achievementRules');

function defaultDb() { return require('./db'); }

const RARITY_ORDER = { common: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
const MAX_EXP_BONUS = 0.5;

function httpError(status, message, code) {
  const e = new Error(message);
  e.statusCode = status; e.code = code;
  return e;
}

function titleView(row, lang) {
  return {
    titleId: row.title_id,
    name: localize(row.name, lang),
    description: localize(row.description, lang),
    category: row.category, rarity: row.rarity, iconUrl: row.icon_url || null,
    statBonuses: row.stat_bonuses || {}, specialEffects: row.special_effects || {},
    unlockType: row.unlock_type, unlockCriteria: row.unlock_criteria || {},
    isLimited: !!row.is_limited, availableUntil: row.available_until || null,
  };
}

function ownedView(row, lang) {
  const expired = !!(row.expires_at && new Date(row.expires_at) <= new Date());
  return {
    ...titleView(row, lang),
    isActive: !!row.is_active && !expired, isFavorite: !!row.is_favorite,
    sourceType: row.source_type || null, sourceId: row.source_id || null,
    unlockedAt: row.unlocked_at, expiresAt: row.expires_at || null, expired,
  };
}

async function catalog({ lang, category, rarity, userId } = {}, q = defaultDb()) {
  const params = [];
  const where = ['td.is_active'];
  if (category) { params.push(category); where.push(`td.category = $${params.length}`); }
  if (rarity) { params.push(rarity); where.push(`td.rarity = $${params.length}`); }
  let owned = 'FALSE AS owned';
  if (userId) { params.push(userId); owned = `EXISTS (SELECT 1 FROM user_titles ut WHERE ut.user_id = $${params.length} AND ut.title_id = td.title_id) AS owned`; }
  const { rows } = await q.query(
    `SELECT td.*, ${owned} FROM title_definitions td WHERE ${where.join(' AND ')} ORDER BY td.display_order, td.title_id`, params);
  return rows.map((r) => ({ ...titleView(r, lang), owned: r.owned }));
}

async function getDefinition(titleId, lang, q = defaultDb()) {
  const { rows } = await q.query('SELECT * FROM title_definitions WHERE title_id = $1 AND is_active', [titleId]);
  return rows[0] ? titleView(rows[0], lang) : null;
}

async function listUserTitles(userId, { lang, category, rarity, includeExpired = false } = {}, q = defaultDb()) {
  const params = [userId];
  const where = ['ut.user_id = $1'];
  if (!includeExpired) where.push('(ut.expires_at IS NULL OR ut.expires_at > NOW())');
  if (category) { params.push(category); where.push(`td.category = $${params.length}`); }
  if (rarity) { params.push(rarity); where.push(`td.rarity = $${params.length}`); }
  const { rows } = await q.query(
    `SELECT td.*, ut.is_active, ut.is_favorite, ut.source_type, ut.source_id, ut.unlocked_at, ut.expires_at
       FROM user_titles ut JOIN title_definitions td ON td.title_id = ut.title_id
      WHERE ${where.join(' AND ')}
      ORDER BY ut.is_active DESC, ut.is_favorite DESC, ut.unlocked_at DESC`, params);
  return rows.map((r) => ownedView(r, lang));
}

async function getActiveTitle(userId, lang, q = defaultDb()) {
  const map = await getActiveTitles([userId], lang, q);
  return map.get(String(userId)) || null;
}

/** 批量查询激活称号（排行榜、资料卡） */
async function getActiveTitles(userIds, lang, q = defaultDb()) {
  const out = new Map();
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;
  const { rows } = await q.query(
    `SELECT ut.user_id, td.* FROM user_titles ut JOIN title_definitions td ON td.title_id = ut.title_id
      WHERE ut.user_id = ANY($1::uuid[]) AND ut.is_active AND (ut.expires_at IS NULL OR ut.expires_at > NOW())`, [ids]);
  for (const r of rows) {
    const v = titleView(r, lang);
    out.set(String(r.user_id), { titleId: v.titleId, name: v.name, rarity: v.rarity, specialEffects: v.specialEffects });
  }
  return out;
}

/** 激活称号；titleId 为 null 表示取消佩戴 */
async function activate(userId, titleId, q = defaultDb()) {
  return q.transaction(async (client) => {
    // 锁住该玩家全部称号行，串行化并发激活
    const { rows } = await client.query(
      'SELECT title_id, expires_at FROM user_titles WHERE user_id = $1 ORDER BY id FOR UPDATE', [userId]);
    if (titleId) {
      const t = rows.find((r) => r.title_id === titleId);
      if (!t) throw httpError(404, '未拥有该称号', 'TITLE_NOT_OWNED');
      if (t.expires_at && new Date(t.expires_at) <= new Date()) throw httpError(410, '称号已过期', 'TITLE_EXPIRED');
    }
    await client.query('UPDATE user_titles SET is_active = FALSE WHERE user_id = $1 AND is_active', [userId]);
    if (titleId) await client.query('UPDATE user_titles SET is_active = TRUE WHERE user_id = $1 AND title_id = $2', [userId, titleId]);
    return { activeTitleId: titleId || null };
  });
}

async function setFavorite(userId, titleId, isFavorite, q = defaultDb()) {
  const { rowCount } = await q.query(
    'UPDATE user_titles SET is_favorite = $3 WHERE user_id = $1 AND title_id = $2', [userId, titleId, !!isFavorite]);
  if (!rowCount) throw httpError(404, '未拥有该称号', 'TITLE_NOT_OWNED');
  return { titleId, isFavorite: !!isFavorite };
}

/** 管理员发放称号（活动/特殊称号） */
async function grant(userId, titleId, { sourceType = 'admin', sourceId = null } = {}, q = defaultDb()) {
  const { rows: [td] } = await q.query('SELECT * FROM title_definitions WHERE title_id = $1 AND is_active', [titleId]);
  if (!td) throw httpError(404, '称号不存在', 'TITLE_NOT_FOUND');
  if (td.available_until && new Date(td.available_until) <= new Date()) throw httpError(410, '称号已下架', 'TITLE_UNAVAILABLE');
  const { rows } = await q.query(
    `INSERT INTO user_titles (user_id, title_id, source_type, source_id, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN $6::timestamp END)
     ON CONFLICT (user_id, title_id) DO NOTHING RETURNING id`,
    [userId, titleId, sourceType, sourceId, !!td.is_limited, td.available_until]);
  return { granted: rows.length === 1, titleId };
}

async function getStatBonuses(userId, q = defaultDb()) {
  const { rows } = await q.query(
    `SELECT td.stat_bonuses FROM user_titles ut JOIN title_definitions td ON td.title_id = ut.title_id
      WHERE ut.user_id = $1 AND ut.is_active AND (ut.expires_at IS NULL OR ut.expires_at > NOW())`, [userId]);
  return (rows[0] && rows[0].stat_bonuses) || {};
}

/** 捕捉等经验加成系数（可在业务事务 client 中调用） */
async function expBonus(client, userId) {
  const b = await getStatBonuses(userId, client);
  const v = Number(b.exp_bonus);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_EXP_BONUS) : 0;
}

/** 过期称号取消激活（定时任务） */
async function expireTitles(q = defaultDb()) {
  const { rowCount } = await q.query(
    `UPDATE user_titles SET is_active = FALSE WHERE is_active AND expires_at IS NOT NULL AND expires_at <= NOW()`);
  return { deactivated: rowCount };
}

async function stats(userId, q = defaultDb()) {
  const { rows: [s] } = await q.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE td.rarity = 'rare')::int AS rare,
            COUNT(*) FILTER (WHERE td.rarity = 'epic')::int AS epic,
            COUNT(*) FILTER (WHERE td.rarity = 'legendary')::int AS legendary,
            COUNT(*) FILTER (WHERE td.rarity = 'mythic')::int AS mythic,
            MAX(ut.title_id) FILTER (WHERE ut.is_active) AS active_title_id
       FROM user_titles ut JOIN title_definitions td ON td.title_id = ut.title_id
      WHERE ut.user_id = $1 AND (ut.expires_at IS NULL OR ut.expires_at > NOW())`, [userId]);
  const { rows: [all] } = await q.query('SELECT COUNT(*)::int AS n FROM title_definitions WHERE is_active');
  return { ...s, available: all.n };
}

async function leaderboard({ limit = 50, lang } = {}, q = defaultDb()) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const { rows } = await q.query(
    `SELECT ut.user_id, u.nickname, u.level, COUNT(*)::int AS total_titles,
            SUM(CASE td.rarity WHEN 'mythic' THEN 5 WHEN 'legendary' THEN 4 WHEN 'epic' THEN 3 WHEN 'rare' THEN 2 ELSE 1 END)::int AS score
       FROM user_titles ut JOIN title_definitions td ON td.title_id = ut.title_id JOIN users u ON u.id = ut.user_id
      WHERE (ut.expires_at IS NULL OR ut.expires_at > NOW()) AND NOT COALESCE(u.is_banned, FALSE)
      GROUP BY ut.user_id, u.nickname, u.level ORDER BY score DESC, total_titles DESC LIMIT ${n}`);
  const active = await getActiveTitles(rows.map((r) => r.user_id), lang, q);
  return rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, nickname: r.nickname, level: r.level,
    totalTitles: r.total_titles, score: r.score, activeTitle: active.get(String(r.user_id)) || null }));
}

module.exports = {
  RARITY_ORDER, MAX_EXP_BONUS, catalog, getDefinition, listUserTitles, getActiveTitle, getActiveTitles, activate, setFavorite,
  grant, getStatBonuses, expBonus, expireTitles, stats, leaderboard, titleView,
};
