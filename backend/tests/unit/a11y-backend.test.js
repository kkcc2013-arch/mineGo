// tests/unit/a11y-backend.test.js
// Epic E21：直接测试真实模块 —— user-service 偏好校验（userPreferences）与 pokemon-service 语音描述生成器
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../../services/user-service/src/services/userPreferences');
const voice = require('../../services/pokemon-service/src/voiceDescriptionService');

test('偏好：namespace 校验', () => {
  assert.equal(prefs.validateNamespace('a11y'), 'a11y');
  assert.throws(() => prefs.validateNamespace('A11Y'), prefs.PreferenceValidationError);
  assert.throws(() => prefs.validateNamespace('x'), prefs.PreferenceValidationError);
  assert.throws(() => prefs.validateNamespace('../etc'), prefs.PreferenceValidationError);
});

test('偏好：非对象/超长/原型污染被拒绝', () => {
  assert.throws(() => prefs.validatePreferences('a11y', null), /JSON 对象/);
  assert.throws(() => prefs.validatePreferences('a11y', [1, 2]), /JSON 对象/);
  assert.throws(() => prefs.validatePreferences('ui', { s: 'x'.repeat(300) }), /字符串过长/);
  assert.throws(() => prefs.validatePreferences('ui', JSON.parse('{"__proto__":{"a":1}}')), /非法字段名/);
  const big = {};
  for (let i = 0; i < 60; i++) big['k' + i] = { v: 'y'.repeat(250), w: 'z'.repeat(250), u: 'q'.repeat(250) };
  assert.throws(() => prefs.validatePreferences('ui', big), /超过/);
});

test('偏好：a11y 丢弃未知分组，保留已知分组', () => {
  const { prefs: out } = prefs.validatePreferences('a11y', { color: { mode: 'protanopia' }, evil: { x: 1 } });
  assert.deepEqual(out, { color: { mode: 'protanopia' } });
});

test('偏好：节奏倍率白名单（REQ-00263 后端校验）与慢速标记', () => {
  const r = prefs.validatePreferences('a11y', { pace: { catch: 0.5, battle: 1, ui: 0.75 } });
  assert.equal(r.flags.slowMode, true);
  assert.equal(prefs.validatePreferences('a11y', { pace: { catch: 1.5 } }).flags.slowMode, false);
  assert.throws(() => prefs.validatePreferences('a11y', { pace: { catch: 0.1 } }), /pace.catch/);
  assert.throws(() => prefs.validatePreferences('a11y', { pace: { ui: 3 } }), /pace.ui/);
  assert.throws(() => prefs.validatePreferences('a11y', { pace: 1 }), /pace 必须是对象/);
});

test('偏好：触觉强度 0-200、按键时长 0 或 100-3000', () => {
  assert.doesNotThrow(() => prefs.validatePreferences('a11y', { haptics: { intensity: 200 } }));
  assert.throws(() => prefs.validatePreferences('a11y', { haptics: { intensity: 250 } }), /haptics/);
  assert.doesNotThrow(() => prefs.validatePreferences('a11y', { motor: { holdMs: 0 } }));
  assert.doesNotThrow(() => prefs.validatePreferences('a11y', { motor: { holdMs: 3000 } }));
  assert.throws(() => prefs.validatePreferences('a11y', { motor: { holdMs: 50 } }), /holdMs/);
});

test('偏好：其他 namespace 只做结构校验', () => {
  const r = prefs.validatePreferences('ui-layout', { a: [1, 2, 3], b: { c: true } });
  assert.deepEqual(r.prefs, { a: [1, 2, 3], b: { c: true } });
});

const BULBASAUR = {
  id: 1, name_zh: '妙蛙种子', name_en: 'Bulbasaur', name_ja: 'フシギダネ',
  description_zh: '背上有一颗种子', description_en: 'A strange seed was planted on its back', description_ja: null,
  type1: 'GRASS', type2: 'POISON', rarity: 'UNCOMMON', base_attack: 118, base_defense: 111, base_hp: 128, evolves_to: 2,
  evo_to_name_zh: '妙蛙草', evo_to_name_en: 'Ivysaur', evo_to_name_ja: 'フシギソウ',
};

test('语音描述：中文包含名称/属性/稀有度/外观/能力/进化', () => {
  const d = voice.buildVoiceDescription(BULBASAUR, { lang: 'zh-CN', wildCp: 350 });
  assert.equal(d.lang, 'zh-CN');
  const keys = d.sections.map((s) => s.key);
  assert.deepEqual(keys, ['name', 'types', 'rarity', 'appearance', 'stats', 'instance', 'evolution']);
  assert.match(d.text, /妙蛙种子/);
  assert.match(d.text, /草、毒属性/);
  assert.match(d.text, /可以进化为妙蛙草/);
  assert.match(d.text, /CP 350/);
  assert.deepEqual(d.types.map((t) => t.shape), ['🍃', '☠']);
});

test('语音描述：英文/日文，最终形态与个体信息', () => {
  const en = voice.buildVoiceDescription({ ...BULBASAUR, evolves_to: null, evo_to_name_zh: null, evo_to_name_en: null, evo_to_name_ja: null, evo_from_name_zh: '妙蛙草', evo_from_name_en: 'Ivysaur' },
    { lang: 'en', instance: { cp: 900, hp_current: 50, hp_max: 80, iv_attack: 15, iv_defense: 15, iv_hp: 15, is_shiny: true, fast_move: 'VINE_WHIP', charge_move: 'SLUDGE_BOMB' } });
  assert.equal(en.lang, 'en-US');
  assert.match(en.text, /Bulbasaur/);
  assert.match(en.text, /Grass and Poison type/);
  assert.match(en.text, /IV 100 percent, shiny/);
  assert.match(en.text, /Evolves from Ivysaur, This is the final evolution/);
  assert.match(en.text, /VINE_WHIP/);
  const ja = voice.buildVoiceDescription(BULBASAUR, { lang: 'ja-JP' });
  assert.match(ja.text, /フシギダネ/);
  assert.match(ja.text, /くさ・どくタイプ/);
  assert.ok(!ja.sections.find((s) => s.key === 'appearance'), '无日文描述时省略外观');
});

test('语音描述：18 种属性都有形状与三语名称', () => {
  assert.equal(Object.keys(voice.TYPE_INFO).length, 18);
  const shapes = new Set();
  for (const [k, v] of Object.entries(voice.TYPE_INFO)) {
    assert.ok(v.shape && v['zh-CN'] && v['en-US'] && v['ja-JP'], k);
    shapes.add(v.shape);
  }
  assert.equal(shapes.size, 18, '形状两两不同');
});
