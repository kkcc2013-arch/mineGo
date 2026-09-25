#!/usr/bin/env node
/**
 * E01 好友接口延迟压测（经网关）：REQ-00048「API 响应 < 200ms (P95)」、REQ-00228「批量可见性检查 100 目标 < 100ms」、
 * REQ-00377「可见性计算 < 50ms」、REQ-00388「查询 < 100ms」。
 *
 * 准备：注册 2 个账号 A/B；经数据库给 A 造满 400 位好友（含友情点、待领礼物、待处理请求、动态、精灵）。
 * 压测：对每个接口以并发 CONCURRENCY 持续 DURATION_S 秒，统计 P50/P95/P99，与阈值比较后输出表格。
 *
 * 用法（需要运行中的服务与数据库；只在隔离 CI 栈上执行）：
 *   BASE_URL=http://127.0.0.1:8080 CONCURRENCY=10 DURATION_S=15 node scripts/bench-friends.js
 * 依赖 scripts/lib/smoke-helpers.js（读 .env 推导 REDIS_URL / DATABASE_URL）。
 */
'use strict';

const { call, newUser, getDb, getRedis } = require('./lib/smoke-helpers');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const DURATION_S = parseInt(process.env.DURATION_S || '15', 10);

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function bench(name, fn, thresholdMs) {
  const lat = [];
  let errors = 0;
  const until = Date.now() + DURATION_S * 1000;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < until) {
      const t = process.hrtime.bigint();
      const r = await fn().catch(() => ({ status: 0 }));
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (!(r.status >= 200 && r.status < 300)) errors++;
    }
  }));
  lat.sort((a, b) => a - b);
  const row = {
    name, n: lat.length, errors, qps: Math.round(lat.length / DURATION_S),
    p50: pct(lat, 50).toFixed(1), p95: pct(lat, 95).toFixed(1), p99: pct(lat, 99).toFixed(1),
    threshold: thresholdMs, pass: pct(lat, 95) < thresholdMs && errors === 0,
  };
  console.log(`${row.pass ? '✅' : '❌'} ${name.padEnd(34)} n=${row.n} err=${errors} qps=${row.qps} p50=${row.p50} p95=${row.p95} p99=${row.p99} (P95 < ${thresholdMs}ms)`);
  return row;
}

async function main() {
  const db = getDb();
  const A = await newUser('bna');
  const B = await newUser('bnb');
  console.log('准备数据：A 400 位好友…');
  const { rows: bulk } = await db.query(
    "INSERT INTO users (nickname, level, xp, last_active_at) SELECT 'benchf_' || i || '_' || floor(random()*1e6)::int, 1 + (i % 40), i * 100, NOW() - (i || ' minutes')::interval FROM generate_series(1, 399) i RETURNING id");
  const ids = [B.userId, ...bulk.map((r) => r.id)];
  await db.query(`
    INSERT INTO friends (user_id, friend_user_id, status, friendship_points, friendship_level, intimacy_level, last_interaction_at, accepted_at)
    SELECT $1, u, 'accepted', p, CASE WHEN p >= 2000 THEN 5 WHEN p >= 1000 THEN 4 WHEN p >= 500 THEN 3 WHEN p >= 100 THEN 2 ELSE 1 END, 1, NOW(), NOW()
      FROM (SELECT u, (random() * 3000)::int AS p FROM unnest($2::uuid[]) u) x
    UNION ALL
    SELECT u, $1, 'accepted', 0, 1, 1, NOW(), NOW() FROM unnest($2::uuid[]) u
    ON CONFLICT (user_id, friend_user_id) DO NOTHING`, [A.userId, ids]);
  await db.query(`
    INSERT INTO friend_gifts (sender_id, receiver_id, gift_type, status, items, sent_at)
    SELECT u, $1, 'standard', 'pending', '[{"type":"POKE_BALL","qty":2}]', NOW() FROM unnest($2::uuid[]) u LIMIT 50`, [A.userId, ids]);
  await db.query(`
    INSERT INTO friend_activities (user_id, activity_type, content)
    SELECT u, 'friend_add', '{"nickname":"bench"}' FROM unnest($1::uuid[]) u`, [ids]);
  const { rows: [pk] } = await db.query(`
    INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp)
    VALUES ($1, 1, 500, 10, 10, 10, 10, 10) RETURNING id`, [B.userId]);
  const targets = ids.slice(0, 100);

  const results = [];
  const t = A.token;
  results.push(await bench('GET /v1/friends（400 位好友）', () => call('GET', '/v1/friends?limit=400', { token: t }), 200));
  results.push(await bench('GET /v1/friends?sortBy=online', () => call('GET', '/v1/friends?sortBy=online&limit=50', { token: t }), 200));
  results.push(await bench('GET /v1/friends/:id（详情）', () => call('GET', `/v1/friends/${B.userId}`, { token: t }), 200));
  results.push(await bench('GET /v1/friends/leaderboard', () => call('GET', '/v1/friends/leaderboard?type=friendship&limit=50', { token: t }), 200));
  results.push(await bench('GET /v1/friends/leaderboard?type=level', () => call('GET', '/v1/friends/leaderboard?type=level&limit=50', { token: t }), 200));
  results.push(await bench('GET /v1/friends/gifts/pending', () => call('GET', '/v1/friends/gifts/pending', { token: t }), 200));
  results.push(await bench('GET /v1/friends/requests/pending', () => call('GET', '/v1/friends/requests/pending', { token: t }), 200));
  results.push(await bench('GET /v1/friends/search', () => call('GET', '/v1/friends/search?q=benchf_1', { token: t }), 200));
  results.push(await bench('POST /v1/privacy/check/batch（100）', () => call('POST', '/v1/privacy/check/batch', { token: t, body: { targetIds: targets } }), 100));
  results.push(await bench('GET /v1/pokemon/:id/visibility', () => call('GET', `/v1/pokemon/${pk.id}/visibility`, { token: t }), 50));
  results.push(await bench('GET /v1/friends/activities', () => call('GET', '/v1/friends/activities?limit=30', { token: t }), 100));
  results.push(await bench('GET /v1/friends/recommendations（缓存）', () => call('GET', '/v1/friends/recommendations', { token: t }), 100));
  results.push(await bench('GET /v1/friends/reminders', () => call('GET', '/v1/friends/reminders', { token: t }), 100));

  console.log('\n| 接口 | 请求数 | 错误 | QPS | P50 ms | P95 ms | P99 ms | 阈值 | 结果 |\n|---|---|---|---|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.name} | ${r.n} | ${r.errors} | ${r.qps} | ${r.p50} | ${r.p95} | ${r.p99} | <${r.threshold} | ${r.pass ? '✅' : '❌'} |`);

  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [bulk.map((r) => r.id)]).catch(() => {});
  (await getRedis()).disconnect();
  await db.end();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
