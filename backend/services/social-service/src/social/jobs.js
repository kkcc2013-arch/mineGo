/**
 * 好友系统定时任务（social-service 进程内，setInterval + PG 咨询锁保证多实例只跑一份）
 *
 * - 每 10 分钟：好友请求 7 天过期、礼物 30 天过期（非系统礼物退回赠送方）、联合任务到期判定
 * - 每小时：刷新全服社交排行榜物化视图；生日提醒；久未互动提醒；好友成就解锁提醒
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { createLogger } = require('../../../../shared/logger');
const socialEvents = require('../../../../shared/social/socialEvents');
const rules = require('../../../../shared/social/privacyRules');
const friendService = require('../friendService');
const jointMissionService = require('./jointMissionService');

const logger = createLogger('friend-jobs');
const timers = [];

async function withLock(db, name, fn) {
  return db.transaction(async (c) => {
    const { rows: [l] } = await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [`job:${name}`]);
    if (!l.ok) return { skipped: true };
    return fn(c);
  });
}

/** 过期好友请求与礼物；退回非系统礼物 */
async function expireRequestsAndGifts(db = dbDefault) {
  return withLock(db, 'friend-expire', async (c) => {
    const { rowCount: requests } = await c.query(`
      UPDATE friend_requests SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending' AND expires_at <= NOW()`);
    const { rows: gifts } = await c.query(`
      UPDATE friend_gifts SET status = 'expired'
       WHERE id IN (SELECT id FROM friend_gifts WHERE status = 'pending' AND expires_at <= NOW()
                     ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
      RETURNING id, from_user_id, gift_type, gift_id, quantity, items`);
    let refunded = 0;
    for (const g of gifts) {
      if (g.gift_type === 'standard' || !g.gift_type) continue;
      await friendService.creditGift(c, g.from_user_id, g);
      refunded++;
    }
    return { requests, gifts: gifts.length, refunded };
  });
}

async function refreshLeaderboard(db = dbDefault) {
  try {
    await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY friend_leaderboard');
  } catch (err) {
    // 首次刷新（未填充）不能 CONCURRENTLY
    await db.query('REFRESH MATERIALIZED VIEW friend_leaderboard');
  }
}

/** 今天过生日的好友 → 提醒（仅当寿星的资料对该好友可见；dedupe 每年一次） */
async function birthdayReminders(db = dbDefault) {
  const { rows } = await db.query(`
    SELECT b.id AS birthday_user, b.nickname, f.friend_user_id AS notify_user,
           f.permission_level, f.group_id, f.permission_overrides, to_jsonb(ps) AS privacy
      FROM users b
      JOIN friends f ON f.user_id = b.id AND f.status = 'accepted'
      LEFT JOIN privacy_settings ps ON ps.user_id = b.id
     WHERE b.birthday IS NOT NULL
       AND to_char(b.birthday, 'MM-DD') = to_char(NOW(), 'MM-DD')
     LIMIT 20000`);
  const year = new Date().getFullYear();
  let n = 0;
  for (const r of rows) {
    const rel = { isFriend: true, permissionLevel: r.permission_level, groupId: r.group_id, overrides: r.permission_overrides || {} };
    if (!rules.canView(rules.withDefaults(r.privacy), 'profile', rel)) continue;
    const created = await socialEvents.createReminder(db, {
      userId: r.notify_user, type: 'birthday', relatedUserId: r.birthday_user,
      content: { nickname: r.nickname }, dedupeKey: `birthday:${r.birthday_user}:${year}`,
    });
    if (created) n++;
  }
  return n;
}

/** 14 天未互动的好友 → 每周最多提醒 3 位 */
async function longTimeNoSeeReminders(db = dbDefault) {
  const { rows } = await db.query(`
    SELECT user_id, friend_user_id, nickname FROM (
      SELECT f.user_id, f.friend_user_id, u.nickname,
             ROW_NUMBER() OVER (PARTITION BY f.user_id ORDER BY f.friendship_points DESC) AS rk
        FROM friends f JOIN users u ON u.id = f.friend_user_id
       WHERE f.status = 'accepted' AND COALESCE(f.last_interaction_at, f.created_at) < NOW() - INTERVAL '14 days'
    ) x WHERE rk <= 3 LIMIT 50000`);
  const week = `${new Date().getUTCFullYear()}-${Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 604800000)}`;
  let n = 0;
  for (const r of rows) {
    const created = await socialEvents.createReminder(db, {
      userId: r.user_id, type: 'long_time_no_see', relatedUserId: r.friend_user_id,
      content: { nickname: r.nickname }, dedupeKey: `ltns:${r.friend_user_id}:${week}`,
    });
    if (created) n++;
  }
  return n;
}

/** 好友近 2 小时解锁的成就 → 提醒（受 achievements_visibility 约束，dedupe 每个成就一次） */
async function achievementReminders(db = dbDefault) {
  const { rows } = await db.query(`
    SELECT ua.user_id AS achiever, u.nickname, ua.achievement_id, a.name,
           f.friend_user_id AS notify_user, f.permission_level, f.group_id, f.permission_overrides,
           to_jsonb(ps) AS privacy
      FROM user_achievements ua
      JOIN users u ON u.id = ua.user_id
      JOIN friends f ON f.user_id = ua.user_id AND f.status = 'accepted'
      LEFT JOIN achievements a ON a.achievement_id = ua.achievement_id
      LEFT JOIN privacy_settings ps ON ps.user_id = ua.user_id
     WHERE COALESCE(ua.completed_at, ua.unlocked_at) > NOW() - INTERVAL '2 hours'
     LIMIT 20000`);
  let n = 0;
  for (const r of rows) {
    const rel = { isFriend: true, permissionLevel: r.permission_level, groupId: r.group_id, overrides: r.permission_overrides || {} };
    if (!rules.canView(rules.withDefaults(r.privacy), 'achievements', rel)) continue;
    const created = await socialEvents.createReminder(db, {
      userId: r.notify_user, type: 'achievement_unlocked', relatedUserId: r.achiever,
      content: { nickname: r.nickname, achievementId: r.achievement_id, name: r.name },
      dedupeKey: `ach:${r.achiever}:${r.achievement_id}`,
    });
    if (created) n++;
  }
  return n;
}

async function runFrequent(db = dbDefault) {
  const out = {};
  try { out.expire = await expireRequestsAndGifts(db); } catch (err) { logger.error({ err: err.message }, 'expire job failed'); }
  try { out.missions = await jointMissionService.expireStale(); } catch (err) { logger.error({ err: err.message }, 'mission expire failed'); }
  try { out.achievements = await achievementReminders(db); } catch (err) { logger.error({ err: err.message }, 'achievement reminders failed'); }
  return out;
}

async function runHourly(db = dbDefault) {
  const out = {};
  try { await refreshLeaderboard(db); out.leaderboard = true; } catch (err) { logger.error({ err: err.message }, 'leaderboard refresh failed'); }
  try { out.birthdays = await birthdayReminders(db); } catch (err) { logger.error({ err: err.message }, 'birthday reminders failed'); }
  try { out.longTimeNoSee = await longTimeNoSeeReminders(db); } catch (err) { logger.error({ err: err.message }, 'ltns reminders failed'); }
  return out;
}

function startFriendJobs() {
  if (process.env.NODE_ENV === 'test' || process.env.FRIEND_JOBS_DISABLED === 'true') return;
  const t0 = setTimeout(() => { runFrequent().catch(() => {}); runHourly().catch(() => {}); }, 15000);
  const t1 = setInterval(() => runFrequent().catch(() => {}), 10 * 60 * 1000);
  const t2 = setInterval(() => runHourly().catch(() => {}), 60 * 60 * 1000);
  for (const t of [t0, t1, t2]) { if (t.unref) t.unref(); timers.push(t); }
  logger.info('friend jobs started');
}

function stopFriendJobs() {
  while (timers.length) { const t = timers.pop(); clearTimeout(t); clearInterval(t); }
}

module.exports = {
  startFriendJobs, stopFriendJobs, runFrequent, runHourly,
  expireRequestsAndGifts, refreshLeaderboard, birthdayReminders, longTimeNoSeeReminders, achievementReminders,
};
