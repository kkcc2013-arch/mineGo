/**
 * E07 精灵成长：进化路径可视化（进化树构建 / 反向追溯 / 隐藏路径 / 多语言条件）单元测试
 *   node --test tests/unit/growth-evolution-tree.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tree = require('../../services/pokemon-service/src/growth/evolutionTree');

const sp = (id, name, t1, atk, def, hp, extra = {}) => ({ id, name_zh: name, name_en: name, type1: t1, base_attack: atk, base_defense: def, base_hp: hp, rarity: 'COMMON', ...extra });
const species = [
  sp(1, '妙蛙种子', 'GRASS', 118, 111, 128, { type2: 'POISON', candy_to_evolve: 25, evolves_to: 2 }),
  sp(2, '妙蛙草', 'GRASS', 151, 143, 155, { type2: 'POISON', candy_to_evolve: 100, evolves_to: 3 }),
  sp(3, '妙蛙花', 'GRASS', 198, 189, 190, { type2: 'POISON' }),
  sp(133, '伊布', 'NORMAL', 104, 114, 146, { candy_to_evolve: 25 }),
  sp(134, '水伊布', 'WATER', 205, 161, 277),
  sp(196, '太阳伊布', 'PSYCHIC', 261, 175, 163),
  sp(25, '皮卡丘', 'ELECTRIC', 112, 96, 111, { candy_to_evolve: 50, evolves_to: 26, evolves_with_item: 'THUNDER_STONE' }),
  sp(26, '雷丘', 'ELECTRIC', 193, 151, 155),
  sp(132, '百变怪', 'NORMAL', 91, 91, 134),
];
const rules = [
  { id: 1, from_species_id: 1, to_species_id: 2, evolution_type: 'level', min_level: 16, is_active: true },
  { id: 8, from_species_id: 133, to_species_id: 134, evolution_type: 'item', conditions: { item_name: 'water_stone' }, is_active: true },
  { id: 11, from_species_id: 133, to_species_id: 196, evolution_type: 'condition', conditions: { time: 'day', friendship: 220 }, is_active: true, is_hidden: true, hint_zh: '阳光下', hint_en: 'under the sun' },
];
const itemNames = { WATER_STONE: { zh: '水之石', en: 'Water Stone', ja: 'みずのいし' }, THUNDER_STONE: { zh: '雷之石', en: 'Thunder Stone', ja: 'かみなりのいし' } };
const graph = tree.indexGraph(species, rules);

test('三段进化：从任意成员展开到家族根，阶段与布局', () => {
  const t = tree.buildTree(graph, 2, { itemNames });
  assert.equal(t.rootSpeciesId, 1);
  assert.equal(t.focusSpeciesId, 2);
  assert.equal(t.stages, 3);
  assert.deepEqual(t.nodes.map((n) => [n.speciesId, n.stage]), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(t.nodes.find((n) => n.speciesId === 2).focus, true);
  assert.deepEqual(t.nodes.map((n) => n.position.y), [0, 0.5, 1]);
  assert.equal(t.edges.length, 2);
  assert.equal(t.edges[0].conditionText, '糖果 ×25', '主路径以 species 为准，忽略正作 16 级规则');
  assert.equal(t.edges[0].statChanges.attack, 33);
  assert.equal(t.hasBranches, false);
});

test('分支 + 隐藏路径：未发现时目标打码、保留提示；发现后显示', () => {
  const t = tree.buildTree(graph, 133, { itemNames });
  assert.equal(t.hasBranches, true);
  assert.equal(t.hiddenCount, 1);
  const hiddenEdge = t.edges.find((e) => e.hidden);
  assert.equal(hiddenEdge.to, null);
  assert.equal(hiddenEdge.requirements, null);
  assert.equal(hiddenEdge.hint, '阳光下');
  assert.ok(t.nodes.some((n) => n.name === '？？？' && n.speciesId === null));
  const stages2 = t.nodes.filter((n) => n.stage === 2).map((n) => n.position.x);
  assert.deepEqual(stages2, [0.333, 0.667], '同阶段节点横向均分');

  const seen = tree.buildTree(graph, 133, { itemNames, discovered: new Set([196]), lang: 'en' });
  const edge = seen.edges.find((e) => e.to === 196);
  assert.equal(edge.conditionText, '25 candies, friendship 220+, during the day');
  assert.equal(edge.hint, 'under the sun');
  assert.equal(edge.typeLabel, 'Friendship');
  assert.equal(edge.statChanges.typesAdded[0], 'PSYCHIC');
});

test('多语言条件描述（道具名本地化）', () => {
  const d = tree.describeRequirements({ candy: 50, item: 'THUNDER_STONE' }, itemNames);
  assert.equal(d.zh, '糖果 ×50，使用雷之石');
  assert.equal(d.en, '50 candies, use Thunder Stone');
  assert.equal(d.ja, 'アメ ×50，かみなりのいしを使う');
  assert.equal(tree.describeRequirements({}, {}).en, 'no requirement');
  assert.equal(tree.describeRequirements({ trade: true, minLevel: 30 }, {}).zh, '等级 ≥ 30，通过交换');
});

test('反向追溯前身链（根在前）', () => {
  assert.deepEqual(tree.ancestors(graph, 3).map((n) => n.speciesId), [1, 2]);
  assert.equal(tree.ancestors(graph, 3)[1].evolvesTo, 3);
  assert.deepEqual(tree.ancestors(graph, 196).map((n) => n.speciesId), [133]);
  assert.deepEqual(tree.ancestors(graph, 1), []);
});

test('无进化物种与不存在物种', () => {
  const t = tree.buildTree(graph, 132, {});
  assert.equal(t.nodes.length, 1);
  assert.equal(t.edges.length, 0);
  assert.equal(t.stages, 1);
  assert.equal(tree.buildTree(graph, 999, {}), null);
  assert.equal(tree.lang2('en-US'), 'en');
  assert.equal(tree.lang2('ja-JP'), 'ja');
  assert.equal(tree.lang2(undefined), 'zh');
});
