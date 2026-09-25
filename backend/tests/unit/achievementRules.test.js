'use strict';

// REQ-00076 / REQ-00106：成就规则（纯函数）
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../shared/achievementRules');

test('捕捉事件派生捕捉次数、图鉴种类，闪光时额外计闪光', () => {
  const plain = rules.deriveMetrics('catch', { is_shiny: false });
  assert.deepEqual(plain.map((m) => `${m.metric}:${m.mode}`), ['catch_count:inc', 'catch_species:abs']);
  const shiny = rules.deriveMetrics('catch', { is_shiny: true });
  assert.ok(shiny.some((m) => m.metric === 'shiny_catch' && m.mode === 'inc'));
});

test('升级事件取绝对等级；道馆胜利同时计胜场与攻克；PvP 胜利带 battle_type', () => {
  const [lvl] = rules.deriveMetrics('level_up', { toLevel: 12, fromLevel: 9 });
  assert.equal(lvl.metric, 'trainer_level'); assert.equal(lvl.mode, 'set'); assert.equal(lvl.value, 12);
  const win = rules.deriveMetrics('gym_battle', { result: 'WIN' }).map((m) => m.metric);
  assert.deepEqual(win, ['gym_battle', 'battle_win', 'gym_conquer']);
  const lose = rules.deriveMetrics('gym_battle', { result: 'LOSE' }).map((m) => m.metric);
  assert.deepEqual(lose, ['gym_battle']);
  const [pvp] = rules.deriveMetrics('pvp_win', {});
  assert.equal(pvp.data.battle_type, 'pvp');
});

test('未知事件不派生指标', () => {
  assert.deepEqual(rules.deriveMetrics('nope', {}), []);
});

test('filters：布尔/等值/数组/区间匹配', () => {
  assert.equal(rules.matchFilters(undefined, {}), true);
  assert.equal(rules.matchFilters({ battle_type: 'pvp' }, { battle_type: 'pvp' }), true);
  assert.equal(rules.matchFilters({ battle_type: 'pvp' }, { battle_type: 'gym' }), false);
  assert.equal(rules.matchFilters({ is_perfect_iv: true }, { is_perfect_iv: false }), false);
  assert.equal(rules.matchFilters({ is_night: true }, { is_night: true }), true);
  assert.equal(rules.matchFilters({ type: ['FIRE', 'WATER'] }, { type: 'WATER' }), true);
  assert.equal(rules.matchFilters({ cp: { min: 1000 } }, { cp: 999 }), false);
  assert.equal(rules.matchFilters({ cp: { min: 1000, max: 2000 } }, { cp: 1500 }), true);
});

test('进度：累加封顶 target；绝对值只升不降', () => {
  assert.deepEqual(rules.nextProgress(8, 10, { mode: 'inc', value: 1 }), { progress: 9, completed: false });
  assert.deepEqual(rules.nextProgress(9, 10, { mode: 'inc', value: 5 }), { progress: 10, completed: true });
  assert.deepEqual(rules.nextProgress(7, 10, { mode: 'set', value: 3 }), { progress: 7, completed: false });
  assert.deepEqual(rules.nextProgress(0, 5, { mode: 'set', value: 12 }), { progress: 5, completed: true });
  assert.equal(rules.targetOf({ trigger_conditions: { target: 0 } }), 1);
  assert.equal(rules.targetOf({ trigger_conditions: { target: 100 } }), 100);
});

test('奖励拆分：货币走 grantRewards、道具规范化为背包 ID、称号/装饰不计入可领取', () => {
  const r = rules.splitRewards({ coins: 1000, stardust: 50, title: 'x', decoration: 'y',
    items: [{ item_id: 'great_ball', count: 20 }, { item_id: 'RARE_CANDY', count: 3 }, { item_id: '', count: 1 }] });
  assert.deepEqual(r.currencies, { coins: 1000, stardust: 50 });
  assert.deepEqual(r.items, [{ type: 'GREAT_BALL', qty: 20 }, { type: 'RARE_CANDY', qty: 3 }]);
  assert.equal(r.title, 'x'); assert.equal(r.decoration, 'y');
  assert.equal(rules.hasClaimableRewards({ title: 'only_title' }), false);
  assert.equal(rules.hasClaimableRewards({ pokeballs: 20 }), true);
});

test('多语言：按语言取名称，缺失回退中文', () => {
  const name = { zh: '捕捉大师', en: 'Catch Master', ja: '捕獲マスター' };
  assert.equal(rules.localize(name, 'en-US'), 'Catch Master');
  assert.equal(rules.localize(name, 'ja'), '捕獲マスター');
  assert.equal(rules.localize({ zh: '只有中文' }, 'en'), '只有中文');
  assert.equal(rules.localize('{"zh":"字符串 JSON"}', 'zh-CN'), '字符串 JSON');
  assert.equal(rules.normalizeLang('en-GB'), 'en-US');
  assert.equal(rules.normalizeLang(undefined), 'zh-CN');
});

test('事件消息：升级/好友请求/礼物/被点赞，带去重键；其他事件不发', () => {
  const names = new Map([['u2', '小智']]);
  const lvl = rules.eventNotification('level_up', { levelUpId: 7, fromLevel: 4, toLevel: 5 }, names);
  assert.equal(lvl.type, 'reward.level_up'); assert.equal(lvl.params.new_level, 5); assert.equal(lvl.dedupeKey, 'lvl:7');
  const fr = rules.eventNotification('friend_request_received', { requestId: 3, fromUserId: 'u2' }, names);
  assert.equal(fr.category, 'social'); assert.equal(fr.params.sender_name, '小智'); assert.equal(fr.dedupeKey, 'freq:3');
  const gift = rules.eventNotification('gift_received', { giftId: 'g1', fromUserId: 'unknown' }, names);
  assert.equal(gift.params.sender_name, '训练师');
  assert.equal(rules.eventNotification('room_liked', { roomId: 'r' }, names), null);
  assert.equal(rules.eventNotification('catch', {}, names), null);
});

test('成就/称号消息', () => {
  const n = rules.achievementNotification({ achievement_id: 'first_catch', name: { zh: '初次捕捉' }, rarity: 'common', points: 10, rewards: { coins: 100 } });
  assert.equal(n.params.achievement_name, '初次捕捉'); assert.equal(n.data.claimable, true); assert.equal(n.dedupeKey, 'ach:first_catch');
  const t = rules.titleNotification({ title_id: 'rising_star', name: { zh: '新星训练师' }, rarity: 'rare' });
  assert.equal(t.params.title_name, '新星训练师');
});

test('每个事件映射到的指标都在 KNOWN_METRICS 中', () => {
  for (const type of Object.keys(rules.EVENT_METRICS)) {
    for (const m of rules.deriveMetrics(type, { is_shiny: true, is_lucky: true, is_perfect_iv: true, result: 'WIN', toLevel: 2 })) {
      assert.ok(rules.KNOWN_METRICS.includes(m.metric), `${type} → ${m.metric}`);
    }
  }
});

test('referencedUserIds 收集事件里的其他玩家', () => {
  const ids = rules.referencedUserIds([{ event_data: { fromUserId: 'a' } }, { event_data: { partnerId: 'b', friendId: 'a' } }]);
  assert.deepEqual(ids.sort(), ['a', 'b']);
});
