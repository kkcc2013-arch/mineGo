// pokemon-service/src/voiceDescriptionService.js
// REQ-00337：精灵详情语音描述生成器 —— 把精灵数据转换成适合屏幕阅读器/TTS 朗读的自然语言（中/英/日）
'use strict';

const LANGS = ['zh-CN', 'en-US', 'ja-JP'];

function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('en')) return 'en-US';
  if (l.startsWith('ja')) return 'ja-JP';
  return 'zh-CN';
}

// 18 种属性：名称 + 形状标识（REQ-00474 形状/图案辅助，颜色之外的第二信息通道）
const TYPE_INFO = {
  NORMAL:   { shape: '●', 'zh-CN': '一般', 'en-US': 'Normal',   'ja-JP': 'ノーマル' },
  FIRE:     { shape: '▲', 'zh-CN': '火',   'en-US': 'Fire',     'ja-JP': 'ほのお' },
  WATER:    { shape: '💧', 'zh-CN': '水',   'en-US': 'Water',    'ja-JP': 'みず' },
  GRASS:    { shape: '🍃', 'zh-CN': '草',   'en-US': 'Grass',    'ja-JP': 'くさ' },
  ELECTRIC: { shape: '⚡', 'zh-CN': '电',   'en-US': 'Electric', 'ja-JP': 'でんき' },
  ICE:      { shape: '◆', 'zh-CN': '冰',   'en-US': 'Ice',      'ja-JP': 'こおり' },
  FIGHTING: { shape: '👊', 'zh-CN': '格斗', 'en-US': 'Fighting', 'ja-JP': 'かくとう' },
  POISON:   { shape: '☠', 'zh-CN': '毒',   'en-US': 'Poison',   'ja-JP': 'どく' },
  GROUND:   { shape: '■', 'zh-CN': '地面', 'en-US': 'Ground',   'ja-JP': 'じめん' },
  FLYING:   { shape: '🪶', 'zh-CN': '飞行', 'en-US': 'Flying',   'ja-JP': 'ひこう' },
  PSYCHIC:  { shape: '👁', 'zh-CN': '超能力', 'en-US': 'Psychic', 'ja-JP': 'エスパー' },
  BUG:      { shape: '⬡', 'zh-CN': '虫',   'en-US': 'Bug',      'ja-JP': 'むし' },
  ROCK:     { shape: '⬠', 'zh-CN': '岩石', 'en-US': 'Rock',     'ja-JP': 'いわ' },
  GHOST:    { shape: '🌙', 'zh-CN': '幽灵', 'en-US': 'Ghost',    'ja-JP': 'ゴースト' },
  DRAGON:   { shape: '★', 'zh-CN': '龙',   'en-US': 'Dragon',   'ja-JP': 'ドラゴン' },
  DARK:     { shape: '🌑', 'zh-CN': '恶',   'en-US': 'Dark',     'ja-JP': 'あく' },
  STEEL:    { shape: '⚙', 'zh-CN': '钢',   'en-US': 'Steel',    'ja-JP': 'はがね' },
  FAIRY:    { shape: '♥', 'zh-CN': '妖精', 'en-US': 'Fairy',    'ja-JP': 'フェアリー' },
};

const RARITY = {
  COMMON:    { 'zh-CN': '常见', 'en-US': 'common',    'ja-JP': 'よく見かける' },
  UNCOMMON:  { 'zh-CN': '少见', 'en-US': 'uncommon',  'ja-JP': 'やや珍しい' },
  RARE:      { 'zh-CN': '稀有', 'en-US': 'rare',      'ja-JP': '珍しい' },
  EPIC:      { 'zh-CN': '史诗', 'en-US': 'epic',      'ja-JP': 'とても珍しい' },
  LEGENDARY: { 'zh-CN': '传说', 'en-US': 'legendary', 'ja-JP': '伝説の' },
};

const T = {
  'zh-CN': {
    sep: '。', list: '、',
    label: { name: '名称', types: '属性', rarity: '稀有度', appearance: '外观', stats: '能力', instance: '个体', moves: '技能', evolution: '进化' },
    name: (n, id) => `${n}，图鉴编号 ${id}`,
    types: (ts) => `${ts.join('、')}属性`,
    rarity: (r) => `${r}精灵`,
    level: { high: '很高', mid: '中等', low: '较低' },
    stats: (a, d, h) => `攻击 ${a.v}（${a.l}），防御 ${d.v}（${d.l}），体力 ${h.v}（${h.l}）`,
    instance: (i) => `战斗力 CP ${i.cp}${i.hp ? `，HP ${i.hp.cur}/${i.hp.max}` : ''}${i.iv !== null ? `，个体值 ${i.iv}%` : ''}${i.shiny ? '，闪光个体' : ''}`,
    moves: (f, c) => `技能：${[f, c].filter(Boolean).join('、')}`,
    evoTo: (n) => `可以进化为${n}`,
    evoFrom: (n) => `由${n}进化而来`,
    evoFinal: '这是最终进化形态',
    wild: (cp) => `野生，CP ${cp}`,
  },
  'en-US': {
    sep: '. ', list: ', ',
    label: { name: 'Name', types: 'Type', rarity: 'Rarity', appearance: 'Appearance', stats: 'Stats', instance: 'Individual', moves: 'Moves', evolution: 'Evolution' },
    name: (n, id) => `${n}, Pokédex number ${id}`,
    types: (ts) => `${ts.join(' and ')} type`,
    rarity: (r) => `A ${r} Pokémon`,
    level: { high: 'high', mid: 'medium', low: 'low' },
    stats: (a, d, h) => `Attack ${a.v} (${a.l}), Defense ${d.v} (${d.l}), Stamina ${h.v} (${h.l})`,
    instance: (i) => `Combat power ${i.cp}${i.hp ? `, HP ${i.hp.cur} of ${i.hp.max}` : ''}${i.iv !== null ? `, IV ${i.iv} percent` : ''}${i.shiny ? ', shiny' : ''}`,
    moves: (f, c) => `Moves: ${[f, c].filter(Boolean).join(', ')}`,
    evoTo: (n) => `Evolves into ${n}`,
    evoFrom: (n) => `Evolves from ${n}`,
    evoFinal: 'This is the final evolution',
    wild: (cp) => `Wild, CP ${cp}`,
  },
  'ja-JP': {
    sep: '。', list: '、',
    label: { name: '名前', types: 'タイプ', rarity: 'レア度', appearance: '見た目', stats: '能力', instance: '個体', moves: 'わざ', evolution: '進化' },
    name: (n, id) => `${n}、図鑑番号 ${id}`,
    types: (ts) => `${ts.join('・')}タイプ`,
    rarity: (r) => `${r}ポケモン`,
    level: { high: '高い', mid: '普通', low: '低い' },
    stats: (a, d, h) => `こうげき ${a.v}（${a.l}）、ぼうぎょ ${d.v}（${d.l}）、HP ${h.v}（${h.l}）`,
    instance: (i) => `CP ${i.cp}${i.hp ? `、HP ${i.hp.cur}/${i.hp.max}` : ''}${i.iv !== null ? `、個体値 ${i.iv}%` : ''}${i.shiny ? '、色違い' : ''}`,
    moves: (f, c) => `わざ：${[f, c].filter(Boolean).join('、')}`,
    evoTo: (n) => `${n}に進化する`,
    evoFrom: (n) => `${n}から進化する`,
    evoFinal: '最終進化形です',
    wild: (cp) => `野生、CP ${cp}`,
  },
};

function statLevel(v, lang) {
  const n = Number(v) || 0;
  const k = n >= 200 ? 'high' : n >= 130 ? 'mid' : 'low';
  return { v: n, l: T[lang].level[k] };
}

function localizedName(row, lang, prefix = '') {
  if (!row) return null;
  const pick = (k) => row[`${prefix}${k}`];
  if (lang === 'en-US') return pick('name_en') || pick('name_zh');
  if (lang === 'ja-JP') return pick('name_ja') || pick('name_en') || pick('name_zh');
  return pick('name_zh') || pick('name_en');
}

function localizedDescription(row, lang) {
  if (lang === 'en-US') return row.description_en || null;
  if (lang === 'ja-JP') return row.description_ja || null;
  return row.description_zh || null;
}

function typeLabels(species, lang) {
  return [species.type1, species.type2].filter(Boolean).map((t) => {
    const info = TYPE_INFO[t] || { shape: '●' };
    return { type: t, shape: info.shape, label: info[lang] || t };
  });
}

function ivPercent(instance) {
  if (!instance) return null;
  const a = Number(instance.iv_attack), d = Number(instance.iv_defense), h = Number(instance.iv_hp);
  if ([a, d, h].some((x) => !Number.isFinite(x))) return null;
  return Math.round(((a + d + h) * 100) / 45);
}

/**
 * 生成精灵语音描述
 * @param {object} species pokemon_species 行（可带 evo_to_name_* / evo_from_name_* 字段）
 * @param {object} [opts] { lang, instance, wildCp }
 */
function buildVoiceDescription(species, opts = {}) {
  if (!species) throw new Error('species required');
  const lang = normalizeLang(opts.lang);
  const t = T[lang];
  const name = localizedName(species, lang) || `#${species.id}`;
  const types = typeLabels(species, lang);
  const sections = [];
  const push = (key, text) => { if (text) sections.push({ key, label: t.label[key], text }); };

  push('name', t.name(name, species.id));
  if (types.length) push('types', t.types(types.map((x) => x.label)));
  if (species.rarity && RARITY[species.rarity]) push('rarity', t.rarity(RARITY[species.rarity][lang]));
  push('appearance', localizedDescription(species, lang));
  if (species.base_attack !== undefined && species.base_attack !== null) {
    push('stats', t.stats(statLevel(species.base_attack, lang), statLevel(species.base_defense, lang), statLevel(species.base_hp, lang)));
  }
  const inst = opts.instance;
  if (inst) {
    push('instance', t.instance({
      cp: inst.cp,
      hp: inst.hp_max ? { cur: inst.hp_current ?? inst.hp_max, max: inst.hp_max } : null,
      iv: ivPercent(inst),
      shiny: !!inst.is_shiny,
    }));
    if (inst.fast_move || inst.charge_move) push('moves', t.moves(inst.fast_move, inst.charge_move));
  } else if (opts.wildCp) {
    push('instance', t.wild(opts.wildCp));
  }
  const evo = [];
  const fromName = localizedName(species, lang, 'evo_from_');
  const toName = localizedName(species, lang, 'evo_to_');
  if (fromName) evo.push(t.evoFrom(fromName));
  if (toName) evo.push(t.evoTo(toName));
  else if (species.evolves_to === null || species.evolves_to === undefined) {
    if (fromName) evo.push(t.evoFinal);
  }
  if (evo.length) push('evolution', evo.join(t.list));

  const summaryParts = sections.filter((s) => ['name', 'types', 'rarity'].includes(s.key)).map((s) => s.text);
  return {
    speciesId: species.id,
    lang,
    name,
    types,
    summary: summaryParts.join(t.sep),
    sections,
    text: sections.map((s) => s.text).join(t.sep) + (lang === 'en-US' ? '.' : '。'),
  };
}

// SQL：精灵 + 进化前/后名称（用于进化路径描述）
const SPECIES_SQL = `
  SELECT s.id, s.name_zh, s.name_en, s.name_ja, s.description_zh, s.description_en, s.description_ja,
         s.type1, s.type2, s.rarity, s.base_attack, s.base_defense, s.base_hp, s.evolves_to,
         e.name_zh AS evo_to_name_zh, e.name_en AS evo_to_name_en, e.name_ja AS evo_to_name_ja,
         p.name_zh AS evo_from_name_zh, p.name_en AS evo_from_name_en, p.name_ja AS evo_from_name_ja
    FROM pokemon_species s
    LEFT JOIN pokemon_species e ON e.id = s.evolves_to
    LEFT JOIN LATERAL (
      SELECT name_zh, name_en, name_ja FROM pokemon_species WHERE evolves_to = s.id ORDER BY id LIMIT 1
    ) p ON TRUE`;

module.exports = { buildVoiceDescription, normalizeLang, TYPE_INFO, LANGS, SPECIES_SQL };
