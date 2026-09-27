/**
 * REQ-00076: 成就系统（查询 / 领奖 / 排行榜 / 定义管理）
 *
 * 进度推进由游戏事件 outbox + backend/shared/achievementEngine.js 完成（捕捉、补给站、升级、好友、活动… 均由业务表触发器写事件）；
 * 本模块只负责对外接口。查询前会按需处理该玩家尚未处理的事件，保证接口看到的是最新进度。
 * 奖励：称号/装饰在完成时自动解锁；货币/经验/精灵球经 reward-service 的 rewardGrant.grantRewards 入账，
 *       道具经 shared/inventory.addItems 入账；user_achievements 行锁 + rewards_claimed 标记保证并发只领一次。
 */
'use strict';

const db = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const engine = require('../../../shared/achievementEngine');
const rules = require('../../../shared/achievementRules');
const titles = require('../../../shared/titles');
const profileCache = require('../../../shared/profileCache');
const { addItems } = require('../../../shared/inventory');
const { getRedis } = require('../../../shared/redis');
const { grantRewards } = require('../../reward-service/src/rewardGrant');

const logger = createLogger('achievement-service');

const ACHIEVEMENT_CATEGORIES = Object.freeze({
  CATCH: 'catch', BREED: 'breed', BATTLE: 'battle', SOCIAL: 'social', EXPLORE: 'explore',
  GROWTH: 'growth', COLLECTION: 'collection', EVENT: 'event',
});
const CATEGORY_LIST = Object.values(ACHIEVEMENT_CATEGORIES);
const CATEGORY_LABELS = {
  catch: { zh: '捕捉', en: 'Catch', ja: '捕獲', icon: '🎯' },
  breed: { zh: '培育', en: 'Breeding', ja: '育成', icon: '🥚' },
  battle: { zh: '战斗', en: 'Battle', ja: 'バトル', icon: '⚔️' },
  social: { zh: '社交', en: 'Social', ja: 'ソーシャル', icon: '🤝' },
  explore: { zh: '探索', en: 'Explore', ja: '探索', icon: '🧭' },
  growth: { zh: '成长', en: 'Growth', ja: '成長', icon: '📈' },
  collection: { zh: '收藏', en: 'Collection', ja: 'コレクション', icon: '🏛️' },
  event: { zh: '活动', en: 'Events', ja: 'イベント', icon: '🎉' },
};
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const ID_RE = /^[a-z0-9_]{3,50}$/;

function httpError(status, message, code) {
  const e = new Error(message);
  e.statusCode = status; e.code = code;
  return e;
}

// ── 视图 ──────────────────────────────────────────────────────
let titleNames = { at: 0, map: new Map() };
async function titleNameMap() {
  if (Date.now() - titleNames.at < 5 * 60 * 1000) return titleNames.map;
  const { rows } = await db.query('SELECT title_id, name, rarity FROM title_definitions');
  titleNames = { at: Date.now(), map: new Map(rows.map((r) => [r.title_id, r])) };
  return titleNames.map;
}

function rewardsView(rewards, lang, tmap) {
  const r = rules.splitRewards(rewards);
  const t = r.title && tmap.get(r.title);
  return {
    currencies: r.currencies, items: r.items,
    title: r.title ? { titleId: r.title, name: t ? rules.localize(t.name, lang) : r.title } : null,
    decoration: r.decoration,
  };
}

function achievementView(row, lang, tmap) {
  const target = rules.targetOf(row);
  const progress = Math.min(Number(row.progress) || 0, target);
  const completed = !!row.completed;
  return {
    achievementId: row.achievement_id,
    category: row.category,
    name: rules.localize(row.name, lang),
    description: rules.localize(row.description, lang),
    iconUrl: row.icon_url || null,
    rarity: row.rarity, points: row.points, isHidden: !!row.is_hidden,
    target, progress, percent: Math.round((progress / target) * 100),
    completed, completedAt: row.completed_at || null,
    rewardsClaimed: !!row.rewards_claimed, rewardsClaimedAt: row.rewards_claimed_at || null,
    claimable: completed && !row.rewards_claimed && rules.hasClaimableRewards(row.rewards),
    rewards: rewardsView(row.rewards, lang, tmap),
    prerequisite: row.prerequisite_achievement_id || null,
  };
}

const LIST_SQL = `
  SELECT a.achievement_id, a.category, a.name, a.description, a.icon_url, a.rarity, a.points, a.is_hidden, a.trigger_conditions,
         a.rewards, a.prerequisite_achievement_id, a.display_order,
         COALESCE(ua.progress, 0) AS progress, COALESCE(ua.completed, FALSE) AS completed, ua.completed_at,
         COALESCE(ua.rewards_claimed, FALSE) AS rewards_claimed, ua.rewards_claimed_at
    FROM achievements a
    LEFT JOIN user_achievements ua ON ua.achievement_id = a.achievement_id AND ua.user_id = $1
   WHERE a.is_active`;

/** 查询前把该玩家尚未处理的游戏事件处理掉（消费者正常时通常为空，开销一条查询） */
async function refresh(userId) {
  try { await engine.drainUser(userId); } catch (err) { logger.warn({ err: err.message, userId }, 'drain before query failed'); }
}

/**
 * 玩家成就列表：隐藏成就在解锁前不出现在列表中（只返回数量）
 * @param {{category?: string, status?: 'completed'|'in_progress'|'claimable'|'locked', lang?: string}} opts
 */
async function listForUser(userId, { category, status, lang } = {}) {
  if (category && !CATEGORY_LIST.includes(category)) throw httpError(400, 'category 无效', 'INVALID_CATEGORY');
  await refresh(userId);
  const params = [userId];
  let sql = `${LIST_SQL}`;
  if (category) { params.push(category); sql += ` AND a.category = $${params.length}`; }
  sql += ' ORDER BY a.category, a.display_order, a.points, a.achievement_id';
  const [{ rows }, tmap] = await Promise.all([db.query(sql, params), titleNameMap()]);
  let hiddenLocked = 0;
  const list = [];
  for (const r of rows) {
    if (r.is_hidden && !r.completed) { hiddenLocked++; continue; }
    const v = achievementView(r, lang, tmap);
    if (status === 'completed' && !v.completed) continue;
    if (status === 'in_progress' && (v.completed || v.progress === 0)) continue;
    if (status === 'locked' && v.completed) continue;
    if (status === 'claimable' && !v.claimable) continue;
    list.push(v);
  }
  return { achievements: list, hiddenLocked, total: list.length };
}

async function overview(userId, lang) {
  await refresh(userId);
  const [{ rows }, { rows: [snap] }, { rows: recent }] = await Promise.all([
    db.query(`${LIST_SQL} ORDER BY a.category`, [userId]),
    db.query('SELECT total_points, achievements_completed, last_updated FROM achievement_progress_snapshots WHERE user_id = $1', [userId]),
    db.query(`SELECT ua.achievement_id, a.name, a.rarity, a.points, ua.completed_at FROM user_achievements ua
                JOIN achievements a ON a.achievement_id = ua.achievement_id
               WHERE ua.user_id = $1 AND ua.completed ORDER BY ua.completed_at DESC LIMIT 5`, [userId]),
  ]);
  const byCategory = Object.fromEntries(CATEGORY_LIST.map((c) => [c, { completed: 0, total: 0, points: 0 }]));
  let completed = 0; let totalVisible = 0; let points = 0; let claimable = 0; let maxPoints = 0;
  for (const r of rows) {
    const c = byCategory[r.category] || (byCategory[r.category] = { completed: 0, total: 0, points: 0 });
    maxPoints += r.points;
    if (!r.is_hidden || r.completed) { c.total++; totalVisible++; }
    if (r.completed) {
      c.completed++; completed++; c.points += r.points; points += r.points;
      if (!r.rewards_claimed && rules.hasClaimableRewards(r.rewards)) claimable++;
    }
  }
  let rank = null;
  if (snap) {
    const { rows: [rk] } = await db.query(
      `SELECT COUNT(*)::int + 1 AS rank FROM achievement_progress_snapshots
        WHERE total_points > $1 OR (total_points = $1 AND achievements_completed > $2)`, [snap.total_points, snap.achievements_completed]);
    rank = rk.rank;
  }
  return {
    totalPoints: points, maxPoints, completed, total: totalVisible, totalIncludingHidden: rows.length,
    completionRate: totalVisible ? +(completed / totalVisible).toFixed(4) : 0,
    claimable, rank, byCategory,
    recent: recent.map((r) => ({ achievementId: r.achievement_id, name: rules.localize(r.name, lang), rarity: r.rarity, points: r.points, completedAt: r.completed_at })),
  };
}

async function detail(userId, achievementId, lang) {
  if (!ID_RE.test(achievementId)) throw httpError(400, '成就 ID 无效', 'INVALID_ACHIEVEMENT_ID');
  await refresh(userId);
  const [{ rows }, tmap] = await Promise.all([db.query(`${LIST_SQL} AND a.achievement_id = $2`, [userId, achievementId]), titleNameMap()]);
  const r = rows[0];
  if (!r || (r.is_hidden && !r.completed)) throw httpError(404, '成就不存在', 'ACHIEVEMENT_NOT_FOUND');
  const { rows: [stat] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE completed)::int AS completed_players, (SELECT COUNT(*)::int FROM users) AS players
       FROM user_achievements WHERE achievement_id = $1`, [achievementId]);
  return { ...achievementView(r, lang, tmap),
    globalCompletionRate: stat.players ? +(stat.completed_players / stat.players).toFixed(4) : 0 };
}

/** 领取成就奖励：行锁 + rewards_claimed 标记，并发请求只有一个成功 */
async function claim(userId, achievementId) {
  if (!ID_RE.test(achievementId)) throw httpError(400, '成就 ID 无效', 'INVALID_ACHIEVEMENT_ID');
  const result = await db.transaction(async (client) => {
    const { rows: [ua] } = await client.query(
      `SELECT ua.completed, ua.rewards_claimed, a.rewards, a.name, a.points
         FROM user_achievements ua JOIN achievements a ON a.achievement_id = ua.achievement_id
        WHERE ua.user_id = $1 AND ua.achievement_id = $2 FOR UPDATE OF ua`, [userId, achievementId]);
    if (!ua || !ua.completed) throw httpError(400, '成就尚未完成', 'ACHIEVEMENT_NOT_COMPLETED');
    if (ua.rewards_claimed) throw httpError(409, '奖励已领取', 'REWARD_ALREADY_CLAIMED');
    const r = rules.splitRewards(ua.rewards);
    const granted = await grantRewards(client, userId, r.currencies);
    const items = r.items.length ? await addItems(client, userId, r.items) : { credited: [], skipped: [] };
    await client.query(
      `UPDATE user_achievements SET rewards_claimed = TRUE, rewards_claimed_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND achievement_id = $2`, [userId, achievementId]);
    if (granted.unsupported.length || items.skipped.length) {
      logger.warn({ userId, achievementId, unsupported: granted.unsupported, skipped: items.skipped }, 'achievement reward partially unsupported');
    }
    return {
      achievementId, granted: granted.granted, items: items.credited,
      skipped: [...granted.unsupported, ...items.skipped], level: granted.level,
    };
  });
  await profileCache.bump(userId);
  return result;
}

async function claimAll(userId) {
  const { rows } = await db.query(
    `SELECT ua.achievement_id, a.rewards FROM user_achievements ua JOIN achievements a ON a.achievement_id = ua.achievement_id
      WHERE ua.user_id = $1 AND ua.completed AND NOT ua.rewards_claimed ORDER BY ua.completed_at`, [userId]);
  const claimed = [];
  for (const r of rows) {
    if (!rules.hasClaimableRewards(r.rewards)) continue;
    try { claimed.push(await claim(userId, r.achievement_id)); } catch (err) {
      if (err.statusCode !== 409) throw err; // 并发下已被其他请求领取
    }
  }
  return { claimed: claimed.length, results: claimed };
}

/** 成就点数排行榜（缓存 60 秒）；附带激活称号 */
async function leaderboard({ limit = 50, offset = 0, lang, userId } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const off = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 10000);
  const l = rules.normalizeLang(lang);
  const key = `ach:leaderboard:${n}:${off}:${l}`;
  let board = null;
  try { const raw = await getRedis().get(key); if (raw) board = JSON.parse(raw); } catch { /* 缓存不可用 */ }
  if (!board) {
    const { rows } = await db.query(
      `SELECT s.user_id, u.nickname, u.avatar_url, u.level, u.team, s.total_points, s.achievements_completed
         FROM achievement_progress_snapshots s JOIN users u ON u.id = s.user_id
        WHERE NOT COALESCE(u.is_banned, FALSE) AND s.achievements_completed > 0
        ORDER BY s.total_points DESC, s.achievements_completed DESC, s.last_updated ASC
        LIMIT ${n} OFFSET ${off}`);
    const active = await titles.getActiveTitles(rows.map((r) => r.user_id), l);
    board = rows.map((r, i) => ({
      rank: off + i + 1, userId: r.user_id, nickname: r.nickname, avatarUrl: r.avatar_url, level: r.level, team: r.team,
      totalPoints: r.total_points, achievementsCompleted: r.achievements_completed, activeTitle: active.get(String(r.user_id)) || null,
    }));
    try { await getRedis().setex(key, 60, JSON.stringify(board)); } catch { /* 忽略 */ }
  }
  let me = null;
  if (userId) {
    const { rows: [s] } = await db.query('SELECT total_points, achievements_completed FROM achievement_progress_snapshots WHERE user_id = $1', [userId]);
    if (s) {
      const { rows: [rk] } = await db.query(
        `SELECT COUNT(*)::int + 1 AS rank FROM achievement_progress_snapshots
          WHERE total_points > $1 OR (total_points = $1 AND achievements_completed > $2)`, [s.total_points, s.achievements_completed]);
      me = { rank: rk.rank, totalPoints: s.total_points, achievementsCompleted: s.achievements_completed };
    }
  }
  return { leaderboard: board, me };
}

// ── 定义管理（管理员） ────────────────────────────────────────
function validateDefinition(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || b.achievementId !== undefined) {
    if (!ID_RE.test(String(b.achievementId || ''))) throw httpError(400, 'achievementId 只能包含小写字母、数字、下划线（3~50）', 'VALIDATION');
    out.achievement_id = b.achievementId;
  }
  if (!partial || b.category !== undefined) {
    if (!CATEGORY_LIST.includes(b.category)) throw httpError(400, `category 必须是 ${CATEGORY_LIST.join('/')}`, 'VALIDATION');
    out.category = b.category;
  }
  for (const k of ['name', 'description']) {
    if (!partial || b[k] !== undefined) {
      const v = b[k];
      if (!v || typeof v !== 'object' || !v.zh) throw httpError(400, `${k} 必须包含 zh（可选 en/ja）`, 'VALIDATION');
      out[k] = JSON.stringify(v);
    }
  }
  if (!partial || b.rarity !== undefined) {
    if (!RARITIES.includes(b.rarity)) throw httpError(400, `rarity 必须是 ${RARITIES.join('/')}`, 'VALIDATION');
    out.rarity = b.rarity;
  }
  if (b.points !== undefined || !partial) {
    const p = Number(b.points ?? 10);
    if (!Number.isInteger(p) || p < 0 || p > 10000) throw httpError(400, 'points 应为 0~10000 的整数', 'VALIDATION');
    out.points = p;
  }
  if (!partial || b.triggerConditions !== undefined) {
    const t = b.triggerConditions;
    if (!t || !rules.KNOWN_METRICS.includes(t.type)) throw httpError(400, `triggerConditions.type 必须是 ${rules.KNOWN_METRICS.join('/')}`, 'VALIDATION');
    if (!Number.isInteger(t.target) || t.target < 1) throw httpError(400, 'triggerConditions.target 应为正整数', 'VALIDATION');
    out.trigger_conditions = JSON.stringify(t);
  }
  if (!partial || b.rewards !== undefined) {
    if (!b.rewards || typeof b.rewards !== 'object' || Array.isArray(b.rewards)) throw httpError(400, 'rewards 必须是对象', 'VALIDATION');
    out.rewards = JSON.stringify(b.rewards);
  }
  if (b.isHidden !== undefined) out.is_hidden = !!b.isHidden;
  if (b.iconUrl !== undefined) out.icon_url = b.iconUrl ? String(b.iconUrl).slice(0, 500) : null;
  if (b.displayOrder !== undefined) out.display_order = Number(b.displayOrder) || 0;
  if (b.isActive !== undefined) out.is_active = !!b.isActive;
  if (b.prerequisiteAchievementId !== undefined) out.prerequisite_achievement_id = b.prerequisiteAchievementId || null;
  return out;
}

async function adminList() {
  const { rows } = await db.query(
    `SELECT a.*, (SELECT COUNT(*)::int FROM user_achievements ua WHERE ua.achievement_id = a.achievement_id AND ua.completed) AS completed_count
       FROM achievements a ORDER BY a.category, a.display_order, a.achievement_id`);
  return rows;
}

async function adminCreate(body) {
  const d = validateDefinition(body);
  const cols = Object.keys(d);
  try {
    const { rows } = await db.query(
      `INSERT INTO achievements (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      cols.map((c) => d[c]));
    engine.invalidateDefinitions();
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw httpError(409, '成就 ID 已存在', 'ACHIEVEMENT_EXISTS');
    if (err.code === '23503') throw httpError(400, '前置成就不存在', 'VALIDATION');
    throw err;
  }
}

async function adminUpdate(achievementId, body) {
  if (!ID_RE.test(achievementId)) throw httpError(400, '成就 ID 无效', 'INVALID_ACHIEVEMENT_ID');
  const d = validateDefinition(body, { partial: true });
  delete d.achievement_id;
  const cols = Object.keys(d);
  if (!cols.length) throw httpError(400, '没有可更新的字段', 'VALIDATION');
  const { rows } = await db.query(
    `UPDATE achievements SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW()
      WHERE achievement_id = $1 RETURNING *`, [achievementId, ...cols.map((c) => d[c])]);
  if (!rows.length) throw httpError(404, '成就不存在', 'ACHIEVEMENT_NOT_FOUND');
  engine.invalidateDefinitions();
  return rows[0];
}

/** 删除 = 下线（保留玩家已获得记录） */
async function adminDeactivate(achievementId) {
  return adminUpdate(achievementId, { isActive: false });
}

module.exports = {
  ACHIEVEMENT_CATEGORIES, CATEGORY_LIST, CATEGORY_LABELS,
  listForUser, overview, detail, claim, claimAll, leaderboard,
  adminList, adminCreate, adminUpdate, adminDeactivate, validateDefinition, achievementView,
};
