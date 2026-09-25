/**
 * 精灵数据可见性规则引擎（REQ-00377）——纯函数
 *
 * 精灵隐私等级：public / friends / private / hidden
 * 访问层级（accessTier）：
 *   owner    主人：全部数据
 *   none     看不到（hidden、任一方向拉黑）
 *   basic    仅基础外观（id、种类、昵称、外观）
 *   detailed 按 show_* 开关逐项放行（public 对所有人；friends 对好友等级 ≥ friend_level_threshold 的好友）
 * 另外叠加用户级设置（REQ-00228）：pokemon_stats_visibility 不可见时去掉 CP/等级/IV，
 * pokemon_shinies_visibility 不可见时不暴露是否闪光。
 * 战斗视图：battle_anonymous 时非主人只看到种类与外观，完整数据仅用于服务端战斗计算。
 */
'use strict';

const POKEMON_VISIBILITY = Object.freeze(['public', 'friends', 'private', 'hidden']);
const ATTRIBUTE_FLAGS = Object.freeze(['show_cp', 'show_level', 'show_skills', 'show_iv', 'show_nature', 'show_moves']);

const DEFAULT_POKEMON_PRIVACY = Object.freeze({
  overall_visibility: 'friends',
  show_cp: true,
  show_level: true,
  show_skills: false,
  show_iv: false,
  show_nature: true,
  show_moves: false,
  friend_level_threshold: 1,
  battle_anonymous: false,
});

const NATURES = Object.freeze([
  '勤奋', '怕寂寞', '勇敢', '固执', '顽皮', '大胆', '坦率', '悠闲', '淘气', '乐天',
  '胆小', '急躁', '认真', '爽朗', '天真', '内敛', '慢吞吞', '冷静', '害羞', '马虎',
  '温和', '温顺', '自大', '慎重', '浮躁',
]);

/** 用户默认配置（user_privacy_defaults 行）→ 精灵隐私配置 */
function defaultsToPrivacy(d) {
  if (!d) return { ...DEFAULT_POKEMON_PRIVACY };
  return {
    overall_visibility: d.default_pokemon_visibility || DEFAULT_POKEMON_PRIVACY.overall_visibility,
    show_cp: d.default_show_cp ?? DEFAULT_POKEMON_PRIVACY.show_cp,
    show_level: d.default_show_level ?? DEFAULT_POKEMON_PRIVACY.show_level,
    show_skills: d.default_show_skills ?? DEFAULT_POKEMON_PRIVACY.show_skills,
    show_iv: d.default_show_iv ?? DEFAULT_POKEMON_PRIVACY.show_iv,
    show_nature: d.default_show_nature ?? DEFAULT_POKEMON_PRIVACY.show_nature,
    show_moves: d.default_show_moves ?? DEFAULT_POKEMON_PRIVACY.show_moves,
    friend_level_threshold: d.default_friend_level_threshold ?? DEFAULT_POKEMON_PRIVACY.friend_level_threshold,
    battle_anonymous: d.default_battle_anonymous ?? DEFAULT_POKEMON_PRIVACY.battle_anonymous,
  };
}

/** 生效配置：精灵自身配置 > 主人默认配置 > 系统默认 */
function resolvePrivacy(pokemonRow, userDefaultsRow) {
  const base = defaultsToPrivacy(userDefaultsRow);
  if (!pokemonRow) return { ...base, source: userDefaultsRow ? 'user_default' : 'system_default' };
  const out = { ...base, source: 'pokemon' };
  for (const k of Object.keys(DEFAULT_POKEMON_PRIVACY)) {
    if (pokemonRow[k] !== undefined && pokemonRow[k] !== null) out[k] = pokemonRow[k];
  }
  return out;
}

/** 校验精灵隐私补丁（PUT /pokemon/:id/privacy、批量设置） */
function sanitizePokemonPrivacy(patch) {
  const value = {};
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value, errors: ['settings 必须是对象'] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'overall_visibility') {
      if (!POKEMON_VISIBILITY.includes(v)) errors.push(`overall_visibility 取值必须是 ${POKEMON_VISIBILITY.join('/')}`);
      else value[k] = v;
    } else if (ATTRIBUTE_FLAGS.includes(k) || k === 'battle_anonymous') {
      if (typeof v !== 'boolean') errors.push(`${k} 必须是布尔值`);
      else value[k] = v;
    } else if (k === 'friend_level_threshold') {
      if (!Number.isInteger(v) || v < 1 || v > 5) errors.push('friend_level_threshold 必须是 1-5 的整数');
      else value[k] = v;
    } else {
      errors.push(`不支持的设置项 ${k}`);
    }
  }
  if (!errors.length && !Object.keys(value).length) errors.push('没有可更新的设置项');
  return { value, errors };
}

function accessTier(privacy, rel) {
  if (rel && rel.isOwner) return 'owner';
  if (!rel || rel.blocked) return 'none';
  const p = privacy || DEFAULT_POKEMON_PRIVACY;
  switch (p.overall_visibility) {
    case 'hidden': return 'none';
    case 'private': return 'basic';
    case 'public': return 'detailed';
    case 'friends':
    default:
      if (rel.isFriend && (rel.friendshipLevel || 0) >= (p.friend_level_threshold || 1)) return 'detailed';
      return 'basic';
  }
}

function natureOf(pokemon) {
  if (pokemon.nature) return pokemon.nature;
  const s = String(pokemon.id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return NATURES[h % NATURES.length];
}

function levelOf(pokemon) {
  if (pokemon.level != null) return Number(pokemon.level);
  return 1 + (Number(pokemon.power_up_count) || 0) * 0.5;
}

function ivOf(pokemon) {
  const a = Number(pokemon.iv_attack); const d = Number(pokemon.iv_defense); const h = Number(pokemon.iv_hp);
  if (![a, d, h].every(Number.isFinite)) return null;
  return { attack: a, defense: d, stamina: h, percent: Math.round(((a + d + h) * 1000) / 45) / 10 };
}

function basicView(pokemon, opts = {}) {
  return {
    id: pokemon.id,
    species_id: pokemon.species_id,
    nickname: pokemon.nickname || null,
    name: pokemon.name_zh || pokemon.name || null,
    appearance: {
      species_id: pokemon.species_id,
      sprite_url: (opts.showShiny && pokemon.is_shiny && pokemon.sprite_shiny_url) || pokemon.sprite_url || null,
      is_shiny: opts.showShiny ? !!pokemon.is_shiny : null,
    },
  };
}

function fullView(pokemon) {
  return {
    ...basicView(pokemon, { showShiny: true }),
    owner_id: pokemon.user_id,
    cp: pokemon.cp,
    level: levelOf(pokemon),
    iv: ivOf(pokemon),
    nature: natureOf(pokemon),
    moves: { fast: pokemon.fast_move || null, charge: pokemon.charge_move || null },
    skills: {
      fast: pokemon.learned_fast_moves || [],
      charge: pokemon.learned_charge_moves || [],
    },
    hp_max: pokemon.hp_max ?? null,
    caught_at: pokemon.caught_at || null,
  };
}

/**
 * 按隐私配置与关系计算可见数据
 * @param {object} pokemon    pokemon_instances（可 JOIN species）行
 * @param {object} privacy    resolvePrivacy 结果
 * @param {object} rel        关系（shared/social/relationship）
 * @param {object} opts       { statsVisible=true, shiniesVisible=true }（来自用户级隐私设置）
 * @returns {object|null}     null 表示不可见
 */
function applyVisibility(pokemon, privacy, rel, opts = {}) {
  const tier = accessTier(privacy, rel);
  if (tier === 'owner') return { ...fullView(pokemon), visibility: 'owner', privacy: pick(privacy) };
  if (tier === 'none') return null;
  const statsVisible = opts.statsVisible !== false;
  const shiniesVisible = opts.shiniesVisible !== false;
  const out = { ...basicView(pokemon, { showShiny: shiniesVisible }), visibility: tier };
  const restricted = [];
  const add = (flag, key, value, isStat) => {
    if (tier === 'detailed' && privacy[flag] && (!isStat || statsVisible)) out[key] = value;
    else { out[key] = null; restricted.push(key); }
  };
  add('show_cp', 'cp', pokemon.cp, true);
  add('show_level', 'level', levelOf(pokemon), true);
  add('show_iv', 'iv', ivOf(pokemon), true);
  add('show_nature', 'nature', natureOf(pokemon), false);
  add('show_moves', 'moves', { fast: pokemon.fast_move || null, charge: pokemon.charge_move || null }, false);
  add('show_skills', 'skills', { fast: pokemon.learned_fast_moves || [], charge: pokemon.learned_charge_moves || [] }, false);
  out.restricted = restricted;
  return out;
}

/**
 * 战斗展示视图：匿名模式下非主人只看到种类与外观（战斗计算仍使用服务端完整数据）
 */
function battleView(pokemon, privacy, rel) {
  if (rel && rel.isOwner) return { ...fullView(pokemon), anonymous: false };
  if (privacy && privacy.battle_anonymous) {
    return {
      id: pokemon.id,
      species_id: pokemon.species_id,
      appearance: { species_id: pokemon.species_id, sprite_url: pokemon.sprite_url || null },
      anonymous: true,
      cp: null,
      nickname: null,
    };
  }
  return {
    id: pokemon.id,
    species_id: pokemon.species_id,
    nickname: pokemon.nickname || null,
    cp: pokemon.cp,
    anonymous: false,
  };
}

function pick(privacy) {
  const out = {};
  for (const k of Object.keys(DEFAULT_POKEMON_PRIVACY)) out[k] = privacy[k];
  if (privacy.source) out.source = privacy.source;
  return out;
}

module.exports = {
  POKEMON_VISIBILITY,
  ATTRIBUTE_FLAGS,
  DEFAULT_POKEMON_PRIVACY,
  NATURES,
  defaultsToPrivacy,
  resolvePrivacy,
  sanitizePokemonPrivacy,
  accessTier,
  applyVisibility,
  battleView,
  basicView,
  fullView,
  levelOf,
  ivOf,
  natureOf,
};
