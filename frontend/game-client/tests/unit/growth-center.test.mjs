// Epic E07 精灵成长页：进化树渲染（使用后端同一套进化树构建逻辑）单元测试
//   node --test frontend/game-client/tests/unit/growth-center.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { GrowthCenter } from '../../src/growth/GrowthCenter.js';

const require = createRequire(import.meta.url);
const tree = require('../../../../backend/services/pokemon-service/src/growth/evolutionTree.js');

const sp = (id, name, t1, extra = {}) => ({ id, name_zh: name, name_en: name, type1: t1, base_attack: 100, base_defense: 100, base_hp: 100, ...extra });
const graph = tree.indexGraph(
  [sp(133, '伊布', 'NORMAL', { candy_to_evolve: 25 }), sp(134, '水伊布', 'WATER'), sp(135, '雷伊布', 'ELECTRIC'), sp(196, '太阳伊布', 'PSYCHIC'),
    sp(1, '妙蛙种子', 'GRASS', { candy_to_evolve: 25, evolves_to: 2 }), sp(2, '妙蛙草', 'GRASS', { candy_to_evolve: 100, evolves_to: 3 }), sp(3, '妙蛙花', 'GRASS')],
  [{ id: 8, from_species_id: 133, to_species_id: 134, conditions: { item_name: 'water_stone' }, is_active: true },
    { id: 9, from_species_id: 133, to_species_id: 135, conditions: { item_name: 'thunder_stone' }, is_active: true },
    { id: 11, from_species_id: 133, to_species_id: 196, conditions: { friendship: 220, time: 'day' }, is_active: true, is_hidden: true, hint_zh: '<阳光>' }],
);
const gc = new GrowthCenter({ api: {} });
const count = (s, re) => (s.match(re) || []).length;

test('三段进化：3 个节点、2 条边、当前物种高亮', () => {
  const svg = gc.renderTree(tree.buildTree(graph, 2, {}));
  assert.equal(count(svg, /<circle/g), 3);
  assert.equal(count(svg, /<line/g), 2);
  assert.equal(count(svg, /gr-node focus/g), 1);
});

test('分支进化：每个分支一条边，隐藏路径为虚线且名称打码、提示转义', () => {
  const svg = gc.renderTree(tree.buildTree(graph, 133, {}));
  assert.equal(count(svg, /<line/g), 3);
  assert.equal(count(svg, /gr-edge hidden/g), 1);
  assert.ok(svg.includes('？？？'));
  assert.ok(svg.includes('&lt;阳光&gt;'), '提示文本需转义');
  assert.ok(!svg.includes('<阳光>'));
});

test('空树不渲染', () => {
  assert.equal(gc.renderTree(null), '');
});
