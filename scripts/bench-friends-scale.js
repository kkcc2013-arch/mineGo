#!/usr/bin/env node
/**
 * REQ-00048「支持 50 万用户的好友关系存储」容量验证（只在隔离 CI 数据库执行）
 *
 * 1. 造数：USERS（默认 500000）个用户（昵称 scale_*、随机位置/等级/生日），每人约 FRIENDS_PER_USER（默认 20）位好友
 *    （friends 双向两行 → 默认约 1000 万行），另给 1 个“重度用户”造满 400 位好友与 50 条待处理请求。
 *    批量写入期间临时禁用 friends 的用户触发器（CDC 通知/旧表同步），写完后一次性回填 friendships 并恢复触发器。
 * 2. 测量：表/索引体积；对重度用户与普通用户执行好友列表、好友数、待处理请求、关系批量查询（100 目标）、
 *    排行榜、推荐候选等核心 SQL 的 EXPLAIN (ANALYZE, BUFFERS) 执行时间；REFRESH MATERIALIZED VIEW 耗时。
 * 3. 清理：--cleanup 删除 scale_* 用户（级联删除好友关系）。
 *
 * 用法：
 *   DATABASE_URL=postgres://.../pmg_ci_6 node scripts/bench-friends-scale.js            # 造数 + 测量
 *   DATABASE_URL=... node scripts/bench-friends-scale.js --measure-only                  # 只测量
 *   DATABASE_URL=... node scripts/bench-friends-scale.js --cleanup                       # 清理
 * 安全：数据库名必须包含 "ci"，或显式设置 ALLOW_SCALE_SEED=1。
 */
'use strict';

const path = require('path');
const { DATABASE_URL } = require('./lib/smoke-helpers');

const { Pool } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));

const USERS = parseInt(process.env.USERS || '500000', 10);
const FRIENDS_PER_USER = parseInt(process.env.FRIENDS_PER_USER || '20', 10);
const BATCH = 50000;

const dbName = new URL(DATABASE_URL).pathname.slice(1);
if (!/ci/i.test(dbName) && process.env.ALLOW_SCALE_SEED !== '1') {
  console.error(`拒绝在数据库 ${dbName} 上执行（仅用于隔离 CI 库；确需执行请设置 ALLOW_SCALE_SEED=1）`);
  process.exit(2);
}

// 单连接：造数用到会话级临时表 scale_ids
const pool = new Pool({ connectionString: process.env.DATABASE_URL || DATABASE_URL, max: 1, statement_timeout: 0 });
const q = (sql, params) => pool.query(sql, params);
const t0 = () => process.hrtime.bigint();
const ms = (s) => (Number(process.hrtime.bigint() - s) / 1e6).toFixed(1);

async function seed() {
  const { rows: [{ n: existing }] } = await q("SELECT COUNT(*)::int AS n FROM users WHERE nickname LIKE 'scale\\_%'");
  if (existing >= USERS) { console.log(`已有 ${existing} 个 scale 用户，跳过造数`); return; }
  console.log(`造 ${USERS - existing} 个用户…`);
  let s = t0();
  for (let from = existing + 1; from <= USERS; from += BATCH) {
    const to = Math.min(USERS, from + BATCH - 1);
    await q(`
      INSERT INTO users (nickname, level, xp, last_lat, last_lng, last_active_at, birthday)
      SELECT 'scale_' || i, 1 + (i % 40), (i % 40) * 10000,
             31.0 + random() * 0.5, 121.2 + random() * 0.5,
             NOW() - (random() * 14 || ' days')::interval,
             DATE '1990-01-01' + (i % 7300)
        FROM generate_series($1::int, $2::int) i`, [from, to]);
    process.stdout.write(`  users ${to}/${USERS}\r`);
  }
  console.log(`\n用户写入 ${ms(s)}ms`);

  await q('CREATE TEMP TABLE IF NOT EXISTS scale_ids AS SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM users WHERE nickname LIKE \'scale\\_%\'');
  await q('CREATE INDEX IF NOT EXISTS scale_ids_n ON scale_ids(n)');
  const { rows: [{ total }] } = await q('SELECT COUNT(*)::int AS total FROM scale_ids');

  console.log(`造好友关系（每人约 ${FRIENDS_PER_USER} 位，双向两行）…`);
  s = t0();
  await q('ALTER TABLE friends DISABLE TRIGGER USER');
  try {
    const half = Math.max(1, Math.floor(FRIENDS_PER_USER / 2));
    for (let k = 1; k <= half; k++) {
      const step = 7919 * k;
      for (let from = 1; from <= total; from += BATCH) {
        await q(`
          INSERT INTO friends (user_id, friend_user_id, status, friendship_points, friendship_level, intimacy_level,
                               last_interaction_at, accepted_at, created_at)
          SELECT x.a, x.b, 'accepted', x.p,
                 CASE WHEN x.p >= 2000 THEN 5 WHEN x.p >= 1000 THEN 4 WHEN x.p >= 500 THEN 3 WHEN x.p >= 100 THEN 2 ELSE 1 END,
                 1, NOW() - (random() * 30 || ' days')::interval, NOW(), NOW()
            FROM (
              SELECT a.id AS a, b.id AS b, (random() * 3000)::int AS p
                FROM scale_ids a JOIN scale_ids b ON b.n = ((a.n + $3::bigint) % $4::bigint) + 1
               WHERE a.n BETWEEN $1 AND $2
              UNION ALL
              SELECT b.id, a.id, 0
                FROM scale_ids a JOIN scale_ids b ON b.n = ((a.n + $3::bigint) % $4::bigint) + 1
               WHERE a.n BETWEEN $1 AND $2
            ) x WHERE x.a <> x.b
          ON CONFLICT (user_id, friend_user_id) DO NOTHING`, [from, Math.min(total, from + BATCH - 1), step, total]);
      }
      process.stdout.write(`  round ${k}/${half}\r`);
    }
    // 重度用户：满 400 位好友 + 50 条待处理请求
    await q(`
      WITH heavy AS (SELECT id FROM scale_ids WHERE n = 1), others AS (SELECT id FROM scale_ids WHERE n BETWEEN 2 AND 401)
      INSERT INTO friends (user_id, friend_user_id, status, friendship_points, accepted_at)
      SELECT h.id, o.id, 'accepted', (random() * 3000)::int, NOW() FROM heavy h, others o
      UNION ALL SELECT o.id, h.id, 'accepted', 0, NOW() FROM heavy h, others o
      ON CONFLICT (user_id, friend_user_id) DO NOTHING`);
    await q(`
      INSERT INTO friend_requests (from_user_id, to_user_id, status, expires_at)
      SELECT o.id, h.id, 'pending', NOW() + INTERVAL '7 days'
        FROM (SELECT id FROM scale_ids WHERE n = 1) h, (SELECT id FROM scale_ids WHERE n BETWEEN 500 AND 549) o
      ON CONFLICT DO NOTHING`);
  } finally {
    await q('ALTER TABLE friends ENABLE TRIGGER USER');
  }
  console.log(`\n好友关系写入 ${ms(s)}ms`);
  s = t0();
  await q(`
    INSERT INTO friendships (user_a, user_b, level, friendship_points, friendship_level, last_interaction_at)
    SELECT f.user_id, f.friend_user_id, 'GOOD', f.friendship_points, LEAST(GREATEST(f.friendship_level, 1), 5), COALESCE(f.last_interaction_at, NOW())
      FROM friends f JOIN scale_ids s ON s.id = f.user_id
     WHERE f.user_id < f.friend_user_id
    ON CONFLICT (user_a, user_b) DO NOTHING`);
  console.log(`旧表 friendships 回填 ${ms(s)}ms`);
  await q('ANALYZE users; ANALYZE friends; ANALYZE friend_requests; ANALYZE friendships');
}

async function explain(label, sql, params) {
  const { rows } = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = rows[0]['QUERY PLAN'][0];
  const exec = plan['Execution Time'];
  console.log(`| ${label} | ${exec.toFixed(2)} | ${plan['Planning Time'].toFixed(2)} | ${plan.Plan['Node Type']} |`);
  return exec;
}

async function measure() {
  const { rows: [heavy] } = await q("SELECT id FROM users WHERE nickname = 'scale_1'");
  const { rows: [normal] } = await q("SELECT id FROM users WHERE nickname = 'scale_250000' OR nickname = 'scale_1000' ORDER BY nickname DESC LIMIT 1");
  if (!heavy) { console.error('没有 scale 数据，先执行造数'); return; }
  const { rows: sizes } = await q(`
    SELECT relname, n_live_tup::bigint AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS total
      FROM pg_stat_user_tables WHERE relname IN ('users', 'friends', 'friendships', 'friend_requests', 'friend_gifts')
     ORDER BY relname`);
  console.log('\n| 表 | 行数 | 含索引体积 |\n|---|---|---|');
  for (const r of sizes) console.log(`| ${r.relname} | ${r.rows} | ${r.total} |`);

  console.log('\n| 查询 | 执行 ms | 规划 ms | 顶层节点 |\n|---|---|---|---|');
  const listSql = `
    SELECT u.id, u.nickname, f.friendship_points, to_jsonb(ps) AS p
      FROM friends f JOIN users u ON u.id = f.friend_user_id
      LEFT JOIN friends r ON r.user_id = f.friend_user_id AND r.friend_user_id = f.user_id
      LEFT JOIN privacy_settings ps ON ps.user_id = f.friend_user_id
     WHERE f.user_id = $1 AND f.status = 'accepted'
     ORDER BY f.last_interaction_at DESC NULLS LAST LIMIT 400`;
  await explain('好友列表（重度用户 400 位）', listSql, [heavy.id]);
  await explain('好友列表（普通用户）', listSql, [normal.id]);
  await explain('好友数（上限检查）', "SELECT COUNT(*) FROM friends WHERE user_id = $1 AND status = 'accepted'", [heavy.id]);
  await explain('待处理请求（上限检查）', "SELECT COUNT(*) FROM friend_requests WHERE to_user_id = $1 AND status = 'pending' AND expires_at > NOW()", [heavy.id]);
  await explain('好友排行（按友情点）', "SELECT friend_user_id FROM friends WHERE user_id = $1 AND status = 'accepted' ORDER BY friendship_points DESC LIMIT 50", [heavy.id]);
  const { rows: t100 } = await q('SELECT friend_user_id FROM friends WHERE user_id = $1 LIMIT 100', [heavy.id]);
  await explain('关系批量查询（100 目标）', `
    SELECT o.id, f.permission_level,
           EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = o.id AND b.blocked_user_id = $1)
      FROM unnest($2::uuid[]) o(id)
      LEFT JOIN friends f ON f.user_id = o.id AND f.friend_user_id = $1 AND f.status = 'accepted'`, [normal.id, t100.map((r) => r.friend_user_id)]);
  await explain('共同好友候选（推荐）', `
    SELECT f2.friend_user_id, COUNT(*) FROM friends f1 JOIN friends f2 ON f2.user_id = f1.friend_user_id AND f2.status = 'accepted'
     WHERE f1.user_id = $1 AND f1.status = 'accepted' GROUP BY f2.friend_user_id ORDER BY COUNT(*) DESC LIMIT 100`, [normal.id]);
  await explain('附近候选（5km 范围，推荐）', `
    SELECT id FROM users WHERE last_lat BETWEEN 31.2 AND 31.29 AND last_lng BETWEEN 121.4 AND 121.5
       AND COALESCE(last_active_at, last_login_at) > NOW() - INTERVAL '7 days' LIMIT 100`, []);
  await explain('按好友码查找', 'SELECT id FROM users WHERE friend_code = (SELECT friend_code FROM users WHERE id = $1)', [normal.id]);
  const s = t0();
  try { await q('REFRESH MATERIALIZED VIEW CONCURRENTLY friend_leaderboard'); } catch { await q('REFRESH MATERIALIZED VIEW friend_leaderboard'); }
  console.log(`\n全服社交排行榜物化视图刷新：${ms(s)}ms`);
  await explain('全服社交榜 Top 100', 'SELECT user_id FROM friend_leaderboard ORDER BY total_friendship_points DESC LIMIT 100', []);
}

async function cleanup() {
  const s = t0();
  await q("DELETE FROM friendships fs USING users u WHERE u.nickname LIKE 'scale\\_%' AND (fs.user_a = u.id OR fs.user_b = u.id)");
  await q('ALTER TABLE friends DISABLE TRIGGER USER');
  try {
    await q("DELETE FROM friends f USING users u WHERE u.nickname LIKE 'scale\\_%' AND f.user_id = u.id");
  } finally {
    await q('ALTER TABLE friends ENABLE TRIGGER USER');
  }
  const { rowCount } = await q("DELETE FROM users WHERE nickname LIKE 'scale\\_%'");
  console.log(`已清理 ${rowCount} 个 scale 用户，用时 ${ms(s)}ms`);
}

(async () => {
  try {
    if (process.argv.includes('--cleanup')) await cleanup();
    else {
      if (!process.argv.includes('--measure-only')) await seed();
      await measure();
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
