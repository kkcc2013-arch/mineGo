/**
 * 精灵隐私配置读取与批量可见性计算（REQ-00377）
 * 供 pokemon-service（精灵可见性/收藏）、gym-service（道馆守护者战斗视图）、social-service（好友对战）共用。
 */
'use strict';

const engine = require('./visibilityEngine');
const rules = require('./privacyRules');
const relationship = require('./relationship');

/** 读取一批精灵的生效隐私配置：Map<pokemonId, privacy> */
async function loadPrivacy(q, pokemons) {
  const ids = [...new Set(pokemons.map((p) => p.id).filter(Boolean))];
  const owners = [...new Set(pokemons.map((p) => p.user_id).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const [{ rows: own }, { rows: defs }] = await Promise.all([
    q.query('SELECT * FROM pokemon_privacy_settings WHERE pokemon_id = ANY($1::uuid[])', [ids]),
    owners.length
      ? q.query('SELECT * FROM user_privacy_defaults WHERE user_id = ANY($1::uuid[])', [owners])
      : Promise.resolve({ rows: [] }),
  ]);
  const byPokemon = new Map(own.map((r) => [r.pokemon_id, r]));
  const byOwner = new Map(defs.map((r) => [r.user_id, r]));
  for (const p of pokemons) map.set(p.id, engine.resolvePrivacy(byPokemon.get(p.id), byOwner.get(p.user_id)));
  return map;
}

/**
 * 对一批（可能属于不同主人的）精灵按 viewer 计算可见数据；不可见的返回 null
 */
async function visibleViews(q, viewerId, pokemons) {
  if (!pokemons.length) return [];
  const owners = [...new Set(pokemons.map((p) => p.user_id))];
  const [privacy, rels, settings] = await Promise.all([
    loadPrivacy(q, pokemons),
    relationship.getRelationships(q, viewerId, owners.filter((o) => o !== viewerId)),
    relationship.getPrivacySettingsMany(q, owners),
  ]);
  return pokemons.map((p) => {
    const rel = p.user_id === viewerId ? relationship.emptyRelationship(viewerId, p.user_id) : rels.get(p.user_id);
    const s = settings.get(p.user_id) || rules.withDefaults(null);
    return engine.applyVisibility(p, privacy.get(p.id), rel, {
      statsVisible: rules.canView(s, 'pokemon_stats', rel),
      shiniesVisible: rules.canView(s, 'pokemon_shinies', rel),
    });
  });
}

/** 战斗展示视图（匿名模式只给外观） */
async function battleViews(q, viewerId, pokemons) {
  if (!pokemons.length) return [];
  const owners = [...new Set(pokemons.map((p) => p.user_id))];
  const [privacy, rels] = await Promise.all([
    loadPrivacy(q, pokemons),
    relationship.getRelationships(q, viewerId, owners.filter((o) => o !== viewerId)),
  ]);
  return pokemons.map((p) => {
    const rel = p.user_id === viewerId ? relationship.emptyRelationship(viewerId, p.user_id) : rels.get(p.user_id);
    return engine.battleView(p, privacy.get(p.id), rel);
  });
}

module.exports = { loadPrivacy, visibleViews, battleViews };
