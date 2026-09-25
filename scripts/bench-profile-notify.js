#!/usr/bin/env node
/**
 * E05/E13 接口延迟压测（经网关）：成就查询/总览、称号、资料卡（缓存命中与未命中）、收藏室详情与访问、消息列表/未读数，
 * 以及成就事件处理延迟（写入游戏事件 → 成就完成）与消息生成吞吐（批量写 notifications）。
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 CONCURRENCY=20 REQUESTS=400 node scripts/bench-profile-notify.js
 * 注意：网关全局限流 200 次/分钟/IP，压测前把 CI 栈网关的限流调高（或直连服务端口 BENCH_DIRECT=1，端口 = 网关 + 偏移）。
 * 输出每个接口的 p50/p95/p99（毫秒），对照需求：成就查询 < 100ms、称号查询 < 50ms、资料卡缓存命中 < 200ms、
 * 收藏室 API P95 < 200ms/500ms、通知中心 API P95 < 500ms。
 */
'use strict';

const { call, newUser, getDb, finish, record } = require('./lib/smoke-helpers');

const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const REQUESTS = Number(process.env.REQUESTS || 400);

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
}

async function bench(name, fn, limitP95) {
  const times = []; let errors = 0; let i = 0;
  async function worker() {
    while (i < REQUESTS) {
      i++;
      const t0 = process.hrtime.bigint();
      try { const r = await fn(); if (r.status >= 400) errors++; } catch { errors++; }
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (Date.now() - t0) / 1000;
  const p95 = pct(times, 95);
  record(`${name} p50=${pct(times, 50).toFixed(1)} p95=${p95.toFixed(1)} p99=${pct(times, 99).toFixed(1)}ms qps=${(times.length / secs).toFixed(0)} errors=${errors}`,
    errors === 0 && (!limitP95 || p95 < limitP95));
}

async function main() {
  const u = await newUser('bch');
  const v = await newUser('bcv');
  await getDb().query('UPDATE users SET xp = xp + 45000 WHERE id = $1', [u.userId]);
  await call('GET', '/v1/achievements/my', { token: u.token }); // 触发事件处理
  await call('GET', '/v1/collection-room', { token: u.token });

  await bench('GET /v1/achievements/my', () => call('GET', '/v1/achievements/my', { token: u.token }), 100);
  await bench('GET /v1/achievements/my/progress', () => call('GET', '/v1/achievements/my/progress', { token: u.token }), 100);
  await bench('GET /v1/users/me/titles', () => call('GET', '/v1/users/me/titles', { token: u.token }), 50);
  await bench(`GET /v1/users/:id/profile（缓存命中）`, () => call('GET', `/v1/users/${u.userId}/profile`, { token: v.token }), 200);
  await bench('GET /v1/collection-room/users/:id', () => call('GET', `/v1/collection-room/users/${u.userId}`, { token: v.token }), 200);
  await bench('GET /v1/notifications', () => call('GET', '/v1/notifications?limit=20', { token: u.token }), 500);
  await bench('GET /v1/notifications/unread-count', () => call('GET', '/v1/notifications/unread-count', { token: u.token }), 500);

  // 事件处理延迟：直接写游戏事件（等价于业务触发器），测到成就完成的时间
  const db = getDb();
  const w = await newUser('bce');
  const t0 = Date.now();
  await db.query(`SELECT game_event_emit($1, 'catch', '{"is_shiny": false}'::jsonb, NULL)`, [w.userId]);
  let done = false;
  while (!done && Date.now() - t0 < 10000) {
    const { rows } = await db.query(`SELECT completed FROM user_achievements WHERE user_id = $1 AND achievement_id = 'first_catch'`, [w.userId]);
    done = !!(rows[0] && rows[0].completed);
    if (!done) await new Promise((r) => setTimeout(r, 20));
  }
  record(`事件 → 成就完成延迟 ${Date.now() - t0}ms（LISTEN 实时消费）`, done);

  // 消息生成吞吐：批量写 notifications（每条触发 pg_notify 与分发）
  const N = Number(process.env.NOTIFY_BATCH || 5000);
  const t1 = Date.now();
  await db.query(
    `INSERT INTO notifications (user_id, type, category, priority, title, body)
     SELECT $1, 'system.announcement', 'system', 'low', '压测', 'bench ' || g FROM generate_series(1, $2) g`, [w.userId, N]);
  const secs = (Date.now() - t1) / 1000;
  record(`批量生成站内消息 ${N} 条 ${secs.toFixed(2)}s（${(N / secs).toFixed(0)} 条/秒）`, true);
}

main().catch((err) => record('压测脚本异常', false, err.stack)).finally(finish);
