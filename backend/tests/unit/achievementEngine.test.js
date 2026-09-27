'use strict';

// REQ-00076 / REQ-00106 / REQ-00261：成就引擎消费游戏事件 → 进度、完成、称号、站内消息（内存数据库替身）
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeGameDb, stubSharedModules } = require('./helpers/fakeGameDb');

stubSharedModules();
const engine = require('../../shared/achievementEngine');
const center = require('../../shared/notificationCenter');

const U = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

const ach = (id, type, target, extra = {}) => ({
  achievement_id: id, category: extra.category || 'catch', name: { zh: id, en: `${id}-en` }, description: { zh: '' },
  rarity: extra.rarity || 'common', points: extra.points || 10, is_hidden: !!extra.hidden,
  trigger_conditions: { type, target, ...(extra.filters ? { filters: extra.filters } : {}) },
  rewards: extra.rewards || { stardust: 100 }, prerequisite_achievement_id: extra.prereq || null, display_order: 0,
});

function makeDb() {
  engine.invalidateDefinitions();
  center.resetTemplateCache();
  return new FakeGameDb({
    achievements: [
      ach('first_catch', 'catch_count', 1),
      ach('catch_master_10', 'catch_count', 10),
      ach('shiny_hunter', 'shiny_catch', 1, { rewards: { stardust: 1, title: 'shiny_hunter' } }),
      ach('perfect_catch', 'catch_count', 1, { filters: { is_perfect_iv: true } }),
      ach('pokedex_2', 'catch_species', 2),
      ach('trainer_level_5', 'trainer_level', 5, { category: 'growth' }),
      ach('trainer_level_10', 'trainer_level', 10, { category: 'growth', rewards: { title: 'rising_star' } }),
      ach('hunter_2', 'achievements_unlocked', 2, { category: 'growth' }),
      ach('after_first', 'catch_count', 2, { prereq: 'first_catch' }),
      ach('pvp_win_1', 'battle_win', 1, { category: 'battle', filters: { battle_type: 'pvp' } }),
    ],
    titles: [
      { title_id: 'novice_trainer', name: { zh: '新手训练师' }, rarity: 'common', unlock_type: 'achievement', unlock_criteria: { achievement_id: 'first_catch' } },
      { title_id: 'shiny_hunter', name: { zh: '闪光猎人' }, rarity: 'legendary', unlock_type: 'achievement', unlock_criteria: { achievement_id: 'shiny_10' } },
      { title_id: 'rising_star', name: { zh: '新星训练师' }, rarity: 'rare', unlock_type: 'achievement', unlock_criteria: { achievement_id: 'trainer_level_10' } },
      { title_id: 'summer_champion', name: { zh: '夏日冠军' }, rarity: 'epic', unlock_type: 'event', unlock_criteria: { event_id: 'summer_2026' } },
    ],
    templates: [
      { template_key: 'achievement_unlock', category: 'reward', priority: 'high', language: 'zh-CN', title_template: '成就解锁', body_template: '恭喜解锁成就：{{achievement_name}}' },
      { template_key: 'achievement_unlock', category: 'reward', priority: 'high', language: 'en-US', title_template: 'Achievement Unlocked', body_template: 'Achievement unlocked: {{achievement_name}}' },
      { template_key: 'level_up', category: 'reward', priority: 'normal', language: 'zh-CN', title_template: '等级提升', body_template: '恭喜！你已升至 {{new_level}} 级' },
      { template_key: 'friend_request', category: 'social', priority: 'normal', language: 'zh-CN', title_template: '好友请求', body_template: '{{sender_name}} 想和你成为好友' },
    ],
    absolute: { catch_species: 1 },
  });
}

test('捕捉事件：首次捕捉完成、累计进度 +1、过滤条件不满足的不推进、解锁称号并发消息', async () => {
  const db = makeDb();
  db.addEvent(U, 'catch', { is_shiny: false, is_perfect_iv: false }, 'catch:s1');
  const r = await engine.processUserEvents(U, { db });
  assert.equal(r.processed, 1);
  assert.deepEqual(r.unlocked, ['first_catch']);
  assert.deepEqual(r.titles, ['novice_trainer']);
  assert.equal(db.userAch.get(`${U}:catch_master_10`).progress, 1);
  assert.equal(db.userAch.has(`${U}:perfect_catch`), false, 'is_perfect_iv 过滤不满足');
  assert.equal(db.userAch.has(`${U}:after_first`), true, '前置成就在同一轮完成后可以推进');
  assert.equal(db.userAch.get(`${U}:pokedex_2`).progress, 1, '图鉴种类取绝对值');
  const types = db.notifications.map((n) => n.type).sort();
  assert.deepEqual(types, ['reward.achievement_unlock', 'reward.title_unlock']);
  const achNote = db.notifications.find((n) => n.type === 'reward.achievement_unlock');
  assert.equal(achNote.body, '恭喜解锁成就：first_catch');
  assert.equal(achNote.params._i18n['en-US'].achievement_name, 'first_catch-en');
  assert.equal(db.events[0].processed, true);
  assert.equal(db.snapshots, 1);
  assert.ok(db.events.some((e) => e.event_type === 'achievement_unlocked' && !e.processed), '写入元成就事件');
});

test('元成就：解锁数达到目标（下一轮处理）', async () => {
  const db = makeDb();
  db.addEvent(U, 'level_up', { levelUpId: 1, fromLevel: 1, toLevel: 5, rewards: {} }, 'lvl:1');
  db.addEvent(U, 'catch', {}, 'catch:s2');
  const total = await engine.drainUser(U, { db });
  assert.ok(total.unlocked.includes('trainer_level_5'));
  assert.ok(total.unlocked.includes('first_catch'));
  assert.ok(total.unlocked.includes('hunter_2'), '解锁 2 个后元成就完成');
});

test('升级事件：等级成就按绝对值推进，跨级一次完成多个；生成等级提升消息；称号来自奖励', async () => {
  const db = makeDb();
  db.addEvent(U, 'level_up', { levelUpId: 9, fromLevel: 1, toLevel: 10, rewards: { pokeballs: 65 } }, 'lvl:9');
  const r = await engine.processUserEvents(U, { db });
  assert.deepEqual(r.unlocked.sort(), ['trainer_level_10', 'trainer_level_5']);
  assert.deepEqual(r.titles, ['rising_star']);
  const lvl = db.notifications.find((n) => n.type === 'reward.level_up');
  assert.equal(lvl.body, '恭喜！你已升至 10 级');
  assert.equal(lvl.dedupe_key, 'lvl:9');
});

test('已完成的成就不会再次完成（并发/重复事件只判定一次）', async () => {
  const db = makeDb();
  db.addEvent(U, 'catch', {}, 'catch:a');
  await engine.processUserEvents(U, { db });
  db.addEvent(U, 'catch', {}, 'catch:b');
  const r2 = await engine.processUserEvents(U, { db });
  assert.equal(r2.unlocked.includes('first_catch'), false);
  assert.equal(db.notifications.filter((n) => n.dedupe_key === 'ach:first_catch').length, 1);
  assert.equal(db.userAch.get(`${U}:catch_master_10`).progress, 2);
});

test('闪光捕捉通过奖励里的 title 解锁称号；PvP 胜利只推进带 pvp 过滤的成就', async () => {
  const db = makeDb();
  db.addEvent(U, 'catch', { is_shiny: true }, 'catch:shiny');
  db.addEvent(U, 'pvp_win', { battleId: 'b1' }, 'pvp:b1');
  const r = await engine.processUserEvents(U, { db });
  assert.ok(r.unlocked.includes('shiny_hunter'));
  assert.ok(r.titles.includes('shiny_hunter'));
  assert.ok(r.unlocked.includes('pvp_win_1'));
});

test('好友请求事件生成社交消息（昵称来自用户表）；关闭社交分类后不生成', async () => {
  const db = makeDb();
  db.addEvent(U, 'friend_request_received', { requestId: 5, fromUserId: FRIEND }, 'freq:5');
  await engine.processUserEvents(U, { db });
  const n = db.notifications.find((x) => x.type === 'social.friend_request');
  assert.equal(n.body, `nick-${FRIEND} 想和你成为好友`);

  const db2 = makeDb();
  db2.prefs[U] = { user_id: U, notification_types: { social: false } };
  db2.addEvent(U, 'friend_request_received', { requestId: 6, fromUserId: FRIEND }, 'freq:6');
  await engine.processUserEvents(U, { db: db2 });
  assert.equal(db2.notifications.length, 0);
  assert.equal(db2.events[0].processed, true, '被偏好过滤的事件同样标记已处理');
});

test('活动完成解锁活动称号', async () => {
  const db = makeDb();
  db.addEvent(U, 'event_completed', { eventId: 3, eventKey: 'summer_2026' }, 'ec:3');
  const r = await engine.processUserEvents(U, { db });
  assert.deepEqual(r.titles, ['summer_champion']);
  assert.equal(db.userTitles[0].source_type, 'event');
});

test('单个事件失败只回滚该事件（SAVEPOINT），记录错误并在多次失败后放弃', async () => {
  const db = makeDb();
  const orig = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/INSERT INTO user_achievements AS ua/.test(sql) && params[1] === 'catch_master_10') throw new Error('boom');
    return orig(sql, params);
  };
  db.addEvent(U, 'catch', {}, 'catch:x');
  db.addEvent(U, 'level_up', { levelUpId: 2, fromLevel: 1, toLevel: 5 }, 'lvl:2');
  const r = await engine.processUserEvents(U, { db });
  assert.equal(r.processed, 1); assert.equal(r.failed, 1);
  const bad = db.events.find((e) => e.dedupe_key === 'catch:x');
  assert.equal(bad.processed, false); assert.equal(bad.last_error, 'boom');
  for (let i = 0; i < engine.MAX_ATTEMPTS; i++) await engine.processUserEvents(U, { db });
  assert.equal(bad.processed, true, `失败 ${engine.MAX_ATTEMPTS} 次后不再重试`);
});

test('grantProgress（管理员补发）完成时同样解锁称号与发消息', async () => {
  const db = makeDb();
  const r = await engine.grantProgress(U, 'first_catch', 1, { db });
  assert.equal(r.completedNow, true);
  assert.ok(db.userTitles.some((t) => t.title_id === 'novice_trainer'));
  assert.equal(await engine.grantProgress(U, 'no_such', 1, { db }), null);
});
