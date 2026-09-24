#!/usr/bin/env node
/**
 * 评审遗留功能缺陷（W1-B）回归冒烟：经网关验证
 *   活动系统（列表/详情/参与/领奖入账/管理员创建-暂停-恢复-取消、并发领奖只成功一次、非法 ID 返回 400）
 *   训练师等级（经验增长自动升级、升级奖励查询与并发领取只成功一次）
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-w1-defects.js
 * 依赖 scripts/lib/smoke-helpers.js（读 .env 推导 REDIS_URL / DATABASE_URL）
 */
'use strict';

const { record, call, newUser, makeAdmin, finish, getDb } = require('./lib/smoke-helpers');

async function testEvents() {
  const player = await newUser('evt');
  const admin = await makeAdmin(await newUser('adm'));

  const list = await call('GET', '/v1/events', { token: player.token });
  record('活动：列表 /v1/events', list.status === 200 && Array.isArray(list.body.events), `status=${list.status}`);
  const anon = await call('GET', '/v1/events');
  record('活动：未登录访问被网关拒绝', anon.status === 401, `status=${anon.status}`);

  const badId = await call('GET', '/v1/events/active', { token: player.token });
  record('活动：非法活动 ID 返回 400（不是 500）', badId.status === 400, `status=${badId.status}`);

  const now = Date.now();
  const payload = {
    eventKey: `smoke-${now}`, title: '冒烟测试活动', description: 'W1-B 回归', eventType: 'double_xp',
    startTime: new Date(now - 60e3).toISOString(), endTime: new Date(now + 3600e3).toISOString(),
    rewards: [{ type: 'stardust', amount: 100 }],
  };
  const denied = await call('POST', '/v1/events', { token: player.token, body: payload });
  record('活动：普通玩家不能创建活动', denied.status === 403, `status=${denied.status}`);

  const created = await call('POST', '/v1/events', { token: admin.token, body: payload });
  const ev = created.body && created.body.event;
  record('活动：管理员创建活动', created.status === 201 && ev && ev.id, `status=${created.status} ${created.status !== 201 ? JSON.stringify(created.body).slice(0, 160) : ''}`);
  if (!ev) return;

  const resumed = await call('POST', `/v1/events/${ev.id}/resume`, { token: admin.token });
  record('活动：管理员上线（resume）', resumed.status === 200, `status=${resumed.status}`);

  const detail = await call('GET', `/v1/events/${ev.id}`, { token: player.token });
  record('活动：详情', detail.status === 200 && detail.body.event && detail.body.event.status === 'active', `status=${detail.status} state=${detail.body.event && detail.body.event.status}`);

  const joins = await Promise.all([1, 2, 3].map(() => call('POST', `/v1/events/${ev.id}/join`, { token: player.token })));
  record('活动：参与（并发重复参与不报错）', joins.every((j) => j.status === 200), `statuses=${joins.map((j) => j.status)}`);

  const mine = await call('GET', '/v1/events', { token: player.token });
  const joined = (mine.body.events || []).find((e) => e.id === ev.id);
  record('活动：列表中显示本人参与状态', joined && joined.participation_status === 'active', `participation=${joined && joined.participation_status}`);

  const before = (await getDb().query('SELECT stardust FROM users WHERE id = $1', [player.userId])).rows[0];
  const claims = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/v1/events/${ev.id}/claim`, { token: player.token })));
  const ok = claims.filter((c) => c.status === 200).length;
  record('活动：并发领奖只成功一次', ok === 1, `success=${ok} statuses=${claims.map((c) => c.status)}`);
  const after = (await getDb().query('SELECT stardust FROM users WHERE id = $1', [player.userId])).rows[0];
  record('活动：奖励实际入账（星尘 +100，且只入账一次）', after.stardust - before.stardust === 100, `Δstardust=${after.stardust - before.stardust}`);

  const paused = await call('POST', `/v1/events/${ev.id}/pause`, { token: admin.token });
  const afterPause = await call('GET', '/v1/events', { token: player.token });
  record('活动：暂停后不在活跃列表', paused.status === 200 && !(afterPause.body.events || []).some((e) => e.id === ev.id), `status=${paused.status}`);

  const cantPause = await call('POST', `/v1/events/${ev.id}/cancel`, { token: player.token });
  record('活动：普通玩家不能取消活动', cantPause.status === 403, `status=${cantPause.status}`);
  const cancelled = await call('POST', `/v1/events/${ev.id}/cancel`, { token: admin.token });
  const afterCancel = await call('GET', `/v1/events/${ev.id}`, { token: admin.token });
  record('活动：管理员取消', cancelled.status === 200 && afterCancel.body.event && afterCancel.body.event.status === 'cancelled', `status=${cancelled.status}`);
}

async function testTrainerLevel() {
  const u = await newUser('lvl');
  const db = getDb();
  const start = (await db.query('SELECT level, pokeball_count FROM users WHERE id = $1', [u.userId])).rows[0];
  // 测试夹具：直接加经验（等价于多次捕捉/签到），升级由数据库触发器换算
  await db.query('UPDATE users SET xp = xp + 12000 WHERE id = $1', [u.userId]);
  const info = await call('GET', '/v1/rewards/level-ups', { token: u.token });
  const d = info.data || {};
  record('等级：经验增长后自动升级（12000 经验 → 5 级）', info.status === 200 && d.level === 5, `status=${info.status} level=${d.level}`);
  record('等级：返回升级记录与下一级所需经验', (d.unclaimed || []).length === 1 && d.nextLevelXp === 15000, `unclaimed=${(d.unclaimed || []).length} next=${d.nextLevelXp}`);
  const claims = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/rewards/level-ups/claim', { token: u.token })));
  const ok = claims.filter((c) => c.status === 200).length;
  record('等级：升级奖励并发领取只成功一次', ok === 1, `statuses=${claims.map((c) => c.status)}`);
  const end = (await db.query('SELECT pokeball_count FROM users WHERE id = $1', [u.userId])).rows[0];
  record('等级：升级奖励入账（2~5 级精灵球 15+15+15+20=65）', end.pokeball_count - start.pokeball_count === 65, `Δpokeballs=${end.pokeball_count - start.pokeball_count}`);
  const me = await call('GET', '/v1/users/me', { token: u.token });
  const lvl = me.data && (me.data.level ?? (me.data.user && me.data.user.level));
  record('等级：个人信息中的等级同步更新', lvl === 5, `level=${lvl}`);
}

(async () => {
  await testEvents();
  await testTrainerLevel();
  await finish();
})().catch(async (e) => {
  record('执行异常', false, e.message);
  await finish();
});
