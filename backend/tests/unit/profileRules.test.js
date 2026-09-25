'use strict';

// REQ-00327 / REQ-00387：收藏家积分、隐私过滤、资料卡配置校验、SVG 卡片（纯函数）
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../../shared/profileRules');

test('收藏家积分按规则计算', () => {
  const { score, breakdown } = r.computeCollectorScore({
    uniqueSpecies: 40, shinyCount: 2, perfectIvCount: 1, pokedexCaught: 40, pokedexTotal: 151,
    achievementsByRarity: { common: 4, rare: 2, epic: 1, legendary: 1, unknown: 9 },
  });
  // 40×10 + 2×50 + 1×30 + floor(26.49%/10)=2 → 200 + (4×5 + 2×15 + 30 + 50)
  assert.deepEqual(breakdown, { species: 400, shiny: 100, perfectIv: 30, pokedexMilestones: 200, achievements: 130 });
  assert.equal(score, 860);
  assert.equal(r.computeCollectorScore({ pokedexCaught: 151, pokedexTotal: 151 }).breakdown.pokedexMilestones, 1000);
  assert.equal(r.computeCollectorScore({}).score, 0);
});

test('收藏家等级边界与进度', () => {
  assert.equal(r.collectorLevel(0).level, 1);
  assert.equal(r.collectorLevel(499).level, 1);
  assert.equal(r.collectorLevel(500).level, 2);
  assert.equal(r.collectorLevel(2000).name, '资深收藏家');
  assert.equal(r.collectorLevel(5000, 'en').name, 'Pokémon Scholar');
  const top = r.collectorLevel(12000, 'ja');
  assert.equal(top.level, 5); assert.equal(top.nextScore, null); assert.equal(top.progress, 1);
  assert.equal(r.collectorLevel(1250).progress, 0.5);
  assert.equal(r.featuredPokemonLimit(1), 3);
  assert.equal(r.featuredPokemonLimit(2), 5);
});

test('解锁条件', () => {
  const ctx = { level: 12, collectorLevel: 3, achievements: new Set(['shiny_hunter']) };
  assert.equal(r.meetsUnlock({}, ctx), true);
  assert.equal(r.meetsUnlock({ minLevel: 10 }, ctx), true);
  assert.equal(r.meetsUnlock({ minLevel: 20 }, ctx), false);
  assert.equal(r.meetsUnlock({ collectorLevel: 4 }, ctx), false);
  assert.equal(r.meetsUnlock({ achievementId: 'shiny_hunter' }, ctx), true);
  assert.equal(r.meetsUnlock({ achievementId: 'pokedex_151' }, ctx), false);
});

test('可见范围：本人/好友/公开/受限', () => {
  assert.equal(r.audienceFor({ isOwner: true, visibility: 'private' }), 'owner');
  assert.equal(r.audienceFor({ isFriend: true, visibility: 'private' }), 'restricted');
  assert.equal(r.audienceFor({ isFriend: false, visibility: 'friends' }), 'restricted');
  assert.equal(r.audienceFor({ isFriend: true, visibility: 'friends' }), 'full');
  assert.equal(r.audienceFor({ isFriend: false, visibility: 'public' }), 'public');
  assert.equal(r.audienceFor({ isFriend: true, visibility: 'public' }), 'full');
});

const FULL = {
  player: { id: 'u', nickname: 'Ash', level: 10, team: 'VALOR', lastActiveAt: '2026-09-25', collector: { level: 2, name: '收藏家', score: 600 } },
  signature: 'hi',
  stats: { pokemon: { totalCaught: 5 }, social: { friendsCount: 3, giftsSent: 9, giftsReceived: 2, tradesCompleted: 1 },
    exploration: { pokeStopsVisited: 7, kmWalked: 12.5, regionsExplored: 3, rareEncounters: 1 } },
  achievements: { unlocked: 4 }, badges: [{ id: 'first_catch' }], room: { id: 'r', isPublic: false },
  config: { visibility: 'public' }, views: { total: 3 },
};

test('隐私过滤：公开资料隐藏社交明细/位置统计/私密收藏室/访客记录', () => {
  const pub = r.filterProfile(FULL, 'public');
  assert.deepEqual(pub.stats.social, { friendsCount: 3 });
  assert.deepEqual(pub.stats.exploration, { pokeStopsVisited: 7 });
  assert.equal(pub.player.lastActiveAt, undefined);
  assert.equal(pub.room, undefined);
  assert.equal(pub.views, undefined); assert.equal(pub.config, undefined);
  assert.equal(pub.badges.length, 1);
  assert.equal(FULL.stats.social.giftsSent, 9, '不修改入参');
});

test('隐私过滤：受限只保留基本信息；好友看到完整统计但看不到访客记录', () => {
  const res = r.filterProfile(FULL, 'restricted');
  assert.equal(res.restricted, true);
  assert.equal(res.stats, undefined); assert.equal(res.signature, undefined);
  assert.equal(res.player.nickname, 'Ash'); assert.equal(res.player.lastActiveAt, undefined);
  const full = r.filterProfile(FULL, 'full');
  assert.equal(full.stats.social.giftsSent, 9);
  assert.equal(full.views, undefined);
  assert.equal(r.filterProfile(FULL, 'owner').views.total, 3);
});

test('资料卡配置校验', () => {
  assert.equal(r.validateProfilePatch({}).ok, false);
  assert.equal(r.validateProfilePatch({ signature: 'x'.repeat(101) }).ok, false);
  assert.equal(r.validateProfilePatch({ visibility: 'everyone' }).ok, false);
  assert.equal(r.validateProfilePatch({ selectedBadges: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] }).ok, false);
  assert.equal(r.validateProfilePatch({ selectedBadges: ['DROP TABLE'] }).ok, false);
  const four = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  assert.equal(r.validateProfilePatch({ selectedPokemon: four }, { featuredLimit: 3 }).ok, false);
  assert.equal(r.validateProfilePatch({ selectedPokemon: four }, { featuredLimit: 5 }).ok, true);
  assert.equal(r.validateProfilePatch({ selectedPokemon: ['not-a-uuid'] }).ok, false);
  const ok = r.validateProfilePatch({ signature: ' <b>你好</b> ', visibility: 'friends', selectedBadges: ['first_catch', 'first_catch'],
    avatarFrameId: 'leaf', statsLayout: { order: ['battle', 'pokemon', 'hacker'], hidden: ['social'] } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.signature, 'b你好/b');
  assert.deepEqual(ok.value.selected_badges, ['first_catch']);
  assert.deepEqual(ok.value.stats_layout, { order: ['battle', 'pokemon'], hidden: ['social'] });
});

test('SVG 卡片：包含昵称/等级/称号/统计，并转义用户输入', () => {
  const svg = r.renderCardSvg({
    player: { nickname: 'A<&>"B', level: 23, team: 'MYSTIC', title: { name: '新星<训练师>' }, collector: { name: '收藏家', score: 600 },
      theme: { style: { from: '#000000', to: 'javascript:alert(1)' } }, frame: { style: { border: '#FFD700' } } },
    stats: { pokemon: { totalCaught: 12, uniqueSpecies: 8, shinyCount: 1 } }, achievements: { unlocked: 6 },
    badges: [{ icon: '🎯' }], signature: '</svg><script>',
  }, { lang: 'en', shareUrl: 'https://x/p/abc' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('A&lt;&amp;&gt;&quot;B'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('javascript:'), '非法颜色回退默认值');
  assert.ok(svg.includes('新星&lt;训练师&gt;'));
  assert.ok(svg.includes('>12<') && svg.includes('Achievements'));
  assert.ok(svg.includes('#1E88E5'), '队伍颜色');
});
