/**
 * 精灵进化路径可视化服务（REQ-00355）
 *
 * 原实现依赖空的 evolution_paths 表与不存在的列，/pokemon/species/:id/evolution-chain 500。
 * 现在进化树直接由 pokemon_species + evolution_rules 计算（与进化服务同一套规则，单一真相），
 * 结果按物种缓存在进程内 5 分钟；玩家维度只叠加"是否已发现"（图鉴已捕获）用于隐藏路径打码。
 */
'use strict';

const { query } = require('../../../shared/db');
const tree = require('./growth/evolutionTree');
const evolutionService = require('./evolutionService');
const { GrowthError } = require('./growth/common');

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, graph: null, itemNames: {} };

async function loadGraph() {
  if (cache.graph && Date.now() - cache.at < CACHE_MS) return cache;
  const { rows: species } = await query('SELECT * FROM pokemon_species ORDER BY id');
  let rules = [];
  try {
    ({ rows: rules } = await query(
      `SELECT er.*, ei.name AS item_name FROM evolution_rules er
         LEFT JOIN evolution_items ei ON ei.id = er.required_item_id
        WHERE er.is_active = TRUE`));
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  const { rows: items } = await query("SELECT item_id, name_zh, name_en, name_ja FROM items WHERE category = 'evolution'");
  const itemNames = {};
  for (const i of items) itemNames[i.item_id] = { zh: i.name_zh, en: i.name_en, ja: i.name_ja || i.name_en };
  cache = { at: Date.now(), graph: tree.indexGraph(species, rules), itemNames };
  return cache;
}

async function discoveredBy(userId) {
  if (!userId) return new Set();
  const { rows } = await query('SELECT species_id FROM pokedex_entries WHERE user_id = $1 AND caught_count > 0', [userId]);
  return new Set(rows.map((r) => Number(r.species_id)));
}

function parseSpeciesId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 32767) throw new GrowthError('INVALID_SPECIES', '无效的物种 ID', 400);
  return n;
}

/** 某物种所在家族的完整进化树 */
async function getChain(speciesId, { userId, lang } = {}) {
  const id = parseSpeciesId(speciesId);
  const { graph, itemNames } = await loadGraph();
  const t = tree.buildTree(graph, id, { discovered: await discoveredBy(userId), itemNames, lang });
  if (!t) throw new GrowthError('SPECIES_NOT_FOUND', '物种不存在', 404);
  return { ...t, preEvolutions: tree.ancestors(graph, id), lang: tree.lang2(lang) };
}

async function getChains(speciesIds, opts = {}) {
  if (!Array.isArray(speciesIds) || !speciesIds.length || speciesIds.length > 20) {
    throw new GrowthError('INVALID_PARAM', 'speciesIds 必须是 1~20 个物种 ID', 400);
  }
  const out = {};
  for (const s of speciesIds) out[s] = await getChain(s, opts).catch((err) => ({ error: err.code || 'ERROR', message: err.message }));
  return out;
}

async function getPreEvolutions(speciesId) {
  const id = parseSpeciesId(speciesId);
  const { graph } = await loadGraph();
  if (!graph.byId.has(id)) throw new GrowthError('SPECIES_NOT_FOUND', '物种不存在', 404);
  return { speciesId: id, rootSpeciesId: tree.rootOf(graph, id), chain: tree.ancestors(graph, id) };
}

/** 精灵实例的进化预览（进化前后属性对比 + 条件满足情况） */
async function getPreview(pokemonId, userId, targetSpeciesId) {
  const check = await evolutionService.checkEvolution(pokemonId, userId);
  const target = targetSpeciesId != null && targetSpeciesId !== '' ? parseSpeciesId(targetSpeciesId) : null;
  const visible = check.options.filter((o) => o.toSpeciesId);
  const option = target ? visible.find((o) => o.toSpeciesId === target) : (visible.find((o) => o.met) || visible[0]);
  if (!option) {
    throw new GrowthError(target ? 'INVALID_EVOLUTION_PATH' : 'NO_EVOLUTION_AVAILABLE', target ? '无效的进化路径' : '该精灵无法进化', 400);
  }
  return {
    pokemon: check.pokemon,
    target: { speciesId: option.toSpeciesId, name: option.toSpeciesName, types: option.types, rarity: option.rarity },
    evolutionType: option.evolutionType,
    requirements: option.requirements,
    checks: option.checks,
    canEvolve: option.met,
    comparison: {
      cp: { before: check.pokemon.cp, after: option.preview.cp, change: option.preview.cpChange },
      hpMax: { change: option.preview.hpChange, after: option.preview.hpMax },
      baseStats: option.preview.statsChange,
      typesAdded: option.preview.typesAdded,
      typesRemoved: option.preview.typesRemoved,
    },
  };
}

async function getRecommended(pokemonId, userId) {
  const check = await evolutionService.checkEvolution(pokemonId, userId);
  const rec = check.recommendation;
  return {
    pokemon: check.pokemon,
    recommendation: rec ? { ...rec, option: check.options.find((o) => o.toSpeciesId === rec.toSpeciesId) } : null,
    reason: rec ? rec.reason : (check.reason || 'CONDITIONS_NOT_MET'),
    alternatives: check.options.filter((o) => o.toSpeciesId && (!rec || o.toSpeciesId !== rec.toSpeciesId))
      .map((o) => ({ toSpeciesId: o.toSpeciesId, name: o.toSpeciesName, met: o.met, cpChange: o.preview && o.preview.cpChange })),
  };
}

function evolutionTypes(lang) {
  const l = tree.lang2(lang);
  return Object.entries(tree.TYPE_LABELS).map(([type, labels]) => ({ type, label: labels[l], labels }));
}

function invalidate() { cache = { at: 0, graph: null, itemNames: {} }; }

module.exports = { getChain, getChains, getPreEvolutions, getPreview, getRecommended, evolutionTypes, invalidate };
