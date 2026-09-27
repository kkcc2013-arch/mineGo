'use strict';

// REQ-00359 / REQ-00403：收藏室等级、容量、摆放校验、设置校验（纯函数）
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../../services/pokemon-service/src/collectionRoom/roomRules');

test('经验 → 等级（阈值 0/100/250/…/30000）', () => {
  assert.equal(r.levelForExp(0), 1);
  assert.equal(r.levelForExp(99), 1);
  assert.equal(r.levelForExp(100), 2);
  assert.equal(r.levelForExp(14999), 8);
  assert.equal(r.levelForExp(30000), 10);
  assert.equal(r.levelForExp(999999), 10);
  const info = r.levelInfo(175);
  assert.equal(info.level, 2); assert.equal(info.nextLevelExp, 250); assert.equal(info.progress, 0.5);
  assert.equal(r.levelInfo(30000).nextLevelExp, null);
});

test('容量：展示精灵 20 起每级 +5，上限 50；装饰 10 起每级 +5，上限 60', () => {
  assert.deepEqual(r.capacity(1), { pokemon: 20, decorations: 10 });
  assert.deepEqual(r.capacity(3), { pokemon: 30, decorations: 20 });
  assert.equal(r.capacity(7).pokemon, 50);
  assert.equal(r.capacity(10).pokemon, 50);
  assert.equal(r.capacity(10).decorations, 55);
});

test('升级奖励：跨越的等级奖励物品', () => {
  assert.deepEqual(r.levelRewards(1, 2), []);
  assert.deepEqual(r.levelRewards(2, 5).map((x) => x.itemCode), ['level_3_reward', 'level_5_reward']);
  assert.deepEqual(r.levelRewards(9, 10).map((x) => x.level), [10]);
});

test('主题/背景解锁：等级/成就条件；付费项只看是否已购买', () => {
  const ctx = { roomLevel: 5, achievements: new Set(['first_catch']) };
  assert.equal(r.isUnlocked({ id: 'ocean', unlock_condition: { roomLevel: 5 } }, ctx), true);
  assert.equal(r.isUnlocked({ id: 'cyber', unlock_condition: { roomLevel: 7 } }, ctx), false);
  assert.equal(r.isUnlocked({ id: 'x', unlock_condition: { achievementId: 'first_catch' } }, ctx), true);
  assert.equal(r.isUnlocked({ id: 'sakura', is_premium: true, unlock_condition: {} }, ctx), false);
  assert.equal(r.isUnlocked({ id: 'sakura', is_premium: true, unlock_condition: {} }, ctx, new Set(['sakura'])), true);
});

test('摆放：边界、旋转宽高互换、同层重叠、地面层与物体层可叠放', () => {
  const grid = { width: 10, height: 8 };
  const sofa = { width: 2, height: 1, category: 'furniture' };
  assert.equal(r.validatePlacement(sofa, { x: 9, y: 0 }, grid).ok, false, '横放超出右边界');
  assert.equal(r.validatePlacement(sofa, { x: 9, y: 0, rotation: 90 }, grid).ok, true, '竖放占 1×2');
  assert.equal(r.validatePlacement(sofa, { x: 0, y: 7, rotation: 90 }, grid).ok, false, '竖放超出下边界');
  assert.equal(r.validatePlacement(sofa, { x: 1.5, y: 0 }, grid).ok, false, '非整数');
  assert.equal(r.validatePlacement(sofa, { x: 0, y: 0, rotation: 45 }, grid).ok, false, '非法角度');
  const occ = [{ key: 'p:1', x: 3, y: 3, w: 1, h: 1, layer: 'object' }];
  const hit = r.validatePlacement(sofa, { x: 2, y: 3 }, grid, occ);
  assert.equal(hit.ok, false); assert.equal(hit.conflict, 'p:1');
  const carpet = { width: 3, height: 2, category: 'floor' };
  assert.equal(r.validatePlacement(carpet, { x: 2, y: 2 }, grid, occ).ok, true, '地毯可以铺在精灵下面');
  const floorOcc = [{ key: 'd:c', x: 2, y: 2, w: 3, h: 2, layer: 'floor' }];
  assert.equal(r.validatePlacement(carpet, { x: 4, y: 3 }, grid, floorOcc).ok, false, '地面层之间不可重叠');
});

test('批量布局：整体校验，交换位置可以通过', () => {
  const grid = { width: 4, height: 4 };
  const one = { width: 1, height: 1, category: 'pokemon' };
  const ok = r.validateLayout([{ key: 'p:a', item: one, pos: { x: 1, y: 1 } }, { key: 'p:b', item: one, pos: { x: 0, y: 0 } }], grid);
  assert.equal(ok.ok, true);
  const bad = r.validateLayout([{ key: 'p:a', item: one, pos: { x: 1, y: 1 } }, { key: 'p:b', item: one, pos: { x: 1, y: 1 } }], grid);
  assert.equal(bad.ok, false); assert.equal(bad.key, 'p:b');
});

test('收藏室设置校验：名称、主题 ID、自定义背景需 5 级且 https、网格范围', () => {
  assert.equal(r.validateRoomPatch({}).ok, false);
  assert.equal(r.validateRoomPatch({ roomName: '' }).ok, false);
  assert.equal(r.validateRoomPatch({ roomName: 'x'.repeat(41) }).ok, false);
  assert.equal(r.validateRoomPatch({ themeId: '../etc' }).ok, false);
  assert.equal(r.validateRoomPatch({ backgroundImageUrl: 'https://img.example.com/a.png' }, { level: 4 }).ok, false);
  assert.equal(r.validateRoomPatch({ backgroundImageUrl: 'http://img.example.com/a.png' }, { level: 5 }).ok, false);
  assert.equal(r.validateRoomPatch({ backgroundImageUrl: 'https://img.example.com/a.png' }, { level: 5 }).ok, true);
  assert.equal(r.validateRoomPatch({ backgroundImageUrl: null }, { level: 1 }).value.background_image_url, null);
  assert.equal(r.validateRoomPatch({ layoutConfig: { gridSize: { width: 30, height: 8 } } }).ok, false);
  const ok = r.validateRoomPatch({ roomName: ' <我的>展馆 ', isPublic: false, layoutConfig: { gridSize: { width: 12, height: 10 } } });
  assert.deepEqual(ok.value, { room_name: '我的展馆', is_public: false, layout_config: { gridSize: { width: 12, height: 10 } } });
  assert.equal(r.validateRoomPatch({ isPublic: 'yes' }).ok, false);
});

test('留言清理、展示台等级、缩放、稀有度分布', () => {
  assert.equal(r.sanitizeComment('   ').ok, false);
  assert.equal(r.sanitizeComment('x'.repeat(201)).ok, false);
  assert.equal(r.sanitizeComment(' <img>好看！ ').value, 'img好看！');
  assert.equal(r.pedestalAllowed('basic', 1), true);
  assert.equal(r.pedestalAllowed('gold', 5), false);
  assert.equal(r.pedestalAllowed('gold', 6), true);
  assert.equal(r.pedestalAllowed('rainbow', 10), false);
  assert.equal(r.clampScale(5), 2); assert.equal(r.clampScale(0.1), 0.5); assert.equal(r.clampScale('abc'), 1);
  assert.deepEqual(r.rarityDistribution([{ rarity: 'RARE', count: 2 }, { rarity: 'common', count: 1 }]),
    { COMMON: 1, UNCOMMON: 0, RARE: 2, EPIC: 0, LEGENDARY: 0 });
});
