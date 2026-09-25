/**
 * E07 精灵成长：进化规则（纯函数）单元测试
 *   node --test tests/unit/growth-evolution.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/evolutionRules');

const bulbasaur = { id: 1, name_zh: '妙蛙种子', type1: 'GRASS', type2: 'POISON', base_attack: 118, base_defense: 111, base_hp: 128, candy_to_evolve: 25, evolves_to: 2 };
const ivysaur = { id: 2, name_zh: '妙蛙草', type1: 'GRASS', type2: 'POISON', base_attack: 151, base_defense: 143, base_hp: 155, candy_to_evolve: 100, evolves_to: 3 };
const eevee = { id: 133, name_zh: '伊布', type1: 'NORMAL', base_attack: 104, base_defense: 114, base_hp: 146, candy_to_evolve: 25, evolves_to: null };
const vaporeon = { id: 134, name_zh: '水伊布', type1: 'WATER', base_attack: 205, base_defense: 161, base_hp: 277 };
const espeon = { id: 196, name_zh: '太阳伊布', type1: 'PSYCHIC', base_attack: 261, base_defense: 175, base_hp: 163 };
const umbreon = { id: 197, name_zh: '月亮伊布', type1: 'DARK', base_attack: 126, base_defense: 240, base_hp: 216 };
const pikachu = { id: 25, type1: 'ELECTRIC', base_attack: 112, base_defense: 96, base_hp: 111, candy_to_evolve: 50, evolves_to: 26, evolves_with_item: 'thunder stone' };
const raichu = { id: 26, type1: 'ELECTRIC', base_attack: 193, base_defense: 151, base_hp: 155 };

const eeveeRules = [
  { id: 8, from_species_id: 133, to_species_id: 134, evolution_type: 'item', conditions: { item_name: 'water_stone' }, is_active: true },
  { id: 9, from_species_id: 133, to_species_id: 135, evolution_type: 'item', conditions: { item_name: 'thunder_stone' }, is_active: true },
  { id: 11, from_species_id: 133, to_species_id: 196, evolution_type: 'condition', conditions: { time: 'day', friendship: 220 }, is_active: true, is_hidden: true, hint_zh: '阳光' },
  { id: 12, from_species_id: 133, to_species_id: 197, evolution_type: 'condition', conditions: { time: 'night', friendship: 220 }, is_active: true, is_hidden: true },
  { id: 99, from_species_id: 133, to_species_id: 999, evolution_type: 'level', min_level: 10, is_active: true }, // 目标物种不存在
];

test('baseCp 与刷怪 CP 公式一致', () => {
  const iv = { attack: 10, defense: 10, hp: 10 };
  const expected = Math.floor(((118 + 10) * Math.sqrt(111 + 10) * Math.sqrt(128 + 10)) / 10);
  assert.equal(rules.baseCp(bulbasaur, iv), expected);
  assert.equal(rules.baseCp({ base_attack: 0, base_defense: 0, base_hp: 0 }, {}), 10, '下限 10');
});

test('进化 CP 按比例缩放，保留强化/等级加成', () => {
  const iv = { iv_attack: 15, iv_defense: 15, iv_hp: 15 };
  const base = rules.baseCp(bulbasaur, { attack: 15, defense: 15, hp: 15 });
  const powered = { ...iv, cp: Math.round(base * 1.5), hp_max: 120 };
  const pv = rules.previewEvolution(powered, bulbasaur, ivysaur);
  const expectedTarget = rules.baseCp(ivysaur, { attack: 15, defense: 15, hp: 15 });
  assert.ok(Math.abs(pv.cp - Math.round(expectedTarget * 1.5)) <= 1, `cp=${pv.cp}`);
  assert.ok(pv.cp > powered.cp);
  assert.equal(pv.cpChange, pv.cp - powered.cp);
  assert.ok(pv.hpMax > 120);
});

test('等级倍率：每级 +2%，1 级为 1，范围夹在 1..100', () => {
  assert.equal(rules.levelMultiplier(1), 1);
  assert.equal(rules.levelMultiplier(51), 2);
  assert.equal(rules.levelMultiplier(0), 1);
  assert.equal(rules.levelMultiplier(500), rules.levelMultiplier(100));
  assert.equal(rules.scaleCp(1000, rules.levelMultiplier(1), rules.levelMultiplier(11)), 1200);
});

test('主路径来自 species 列；同一对 (from,to) 的规则被忽略', () => {
  const byId = new Map([[2, ivysaur]]);
  const opts = rules.buildEvolutionOptions(bulbasaur, [
    { id: 1, from_species_id: 1, to_species_id: 2, evolution_type: 'level', min_level: 16, is_active: true },
  ], byId);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].source, 'species');
  assert.equal(opts[0].requirements.candy, 25);
  assert.equal(opts[0].requirements.minLevel, null, '正作的 16 级规则不适用糖果进化');
});

test('道具进化：species.evolves_with_item 归一化为 items.item_id', () => {
  const opts = rules.buildEvolutionOptions(pikachu, [], new Map([[26, raichu]]));
  assert.equal(opts[0].requirements.item, 'THUNDER_STONE');
  assert.equal(opts[0].evolutionType, 'item');
});

test('分支进化：只保留目标物种存在的规则，隐藏路径带提示', () => {
  const byId = new Map([[134, vaporeon], [196, espeon], [197, umbreon]]);
  const opts = rules.buildEvolutionOptions(eevee, eeveeRules, byId);
  assert.deepEqual(opts.map((o) => o.toSpeciesId), [134, 196, 197]);
  const water = opts.find((o) => o.toSpeciesId === 134);
  assert.equal(water.requirements.item, 'WATER_STONE');
  assert.equal(water.requirements.candy, 25, '分支沿用起始物种糖果数');
  const sun = opts.find((o) => o.toSpeciesId === 196);
  assert.equal(sun.hidden, true);
  assert.equal(sun.hint.zh, '阳光');
  assert.equal(sun.requirements.friendship, 220);
  assert.equal(sun.requirements.time, 'day');
  assert.equal(sun.evolutionType, 'friendship');
});

test('条件评估：糖果/道具/等级/亲密度/昼夜/占用', () => {
  const req = { candy: 25, item: 'WATER_STONE', minLevel: 10, friendship: 220, time: 'day', trade: false };
  const all = rules.evaluateRequirements(req, { candy: 30, items: { WATER_STONE: 1 }, level: 12, friendship: 230, phase: 'day' });
  assert.equal(all.met, true);
  assert.equal(all.checks.length, 5);

  const none = rules.evaluateRequirements(req, { candy: 24, items: {}, level: 9, friendship: 219, phase: 'night' });
  assert.equal(none.met, false);
  assert.deepEqual(none.checks.filter((c) => !c.met).map((c) => c.type), ['candy', 'item', 'level', 'friendship', 'time']);
  assert.match(none.checks[0].message, /糖果不足/);

  const busy = rules.evaluateRequirements({ candy: 0 }, { occupiedBy: '训练营训练' });
  assert.equal(busy.met, false);
  const gym = rules.evaluateRequirements({ candy: 0 }, { defending: true });
  assert.equal(gym.met, false);
  const trade = rules.evaluateRequirements({ candy: 0, trade: true }, {});
  assert.equal(trade.met, false, '交换进化不能直接执行');
});

test('昼夜按游戏时区计算', () => {
  // 2026-09-25 03:00Z = 上海 11:00（白天）；2026-09-25 13:00Z = 上海 21:00（夜晚）
  assert.equal(rules.dayPhase(new Date('2026-09-25T03:00:00Z'), 'Asia/Shanghai'), 'day');
  assert.equal(rules.dayPhase(new Date('2026-09-25T13:00:00Z'), 'Asia/Shanghai'), 'night');
  assert.equal(rules.dayPhase(new Date('2026-09-24T22:00:00Z'), 'Asia/Shanghai'), 'day', '06:00 为白天');
  assert.equal(rules.dayPhase(new Date('2026-09-25T10:00:00Z'), 'Asia/Shanghai'), 'night', '18:00 为夜晚');
});

test('推荐：CP 提升最多的可进化路径', () => {
  const rec = rules.recommend([
    { toSpeciesId: 134, met: true, preview: { cpChange: 800 } },
    { toSpeciesId: 136, met: true, preview: { cpChange: 900 } },
    { toSpeciesId: 196, met: false, preview: { cpChange: 2000 } },
  ]);
  assert.deepEqual(rec, { toSpeciesId: 136, reason: 'MAX_CP_GAIN' });
  assert.equal(rules.recommend([{ toSpeciesId: 1, met: false }]), null);
});
