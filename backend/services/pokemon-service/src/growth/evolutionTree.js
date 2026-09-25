/**
 * 进化路径可视化（REQ-00355，纯函数）
 *
 * 由 pokemon_species + evolution_rules（与进化服务同一套规则，见 evolutionRules.buildEvolutionOptions）构建进化家族树：
 *   - 反向追溯到家族根物种，再正向展开所有分支
 *   - 每条边带进化类型、条件、多语言条件描述、隐藏标记与提示
 *   - 节点带阶段（stage）与布局坐标（x 按分支均分，y 按阶段），前端直接画树
 *   - 隐藏路径：玩家未发现（图鉴未捕获）目标时，目标节点打码但保留提示
 */
'use strict';

const { buildEvolutionOptions } = require('./evolutionRules');

const LANGS = ['zh', 'en', 'ja'];

const TYPE_LABELS = Object.freeze({
  candy: { zh: '糖果进化', en: 'Candy', ja: 'アメ進化' },
  item: { zh: '道具进化', en: 'Item', ja: 'どうぐ進化' },
  level: { zh: '等级进化', en: 'Level', ja: 'レベル進化' },
  friendship: { zh: '亲密度进化', en: 'Friendship', ja: 'なつき進化' },
  time: { zh: '时间进化', en: 'Time of day', ja: '時間帯進化' },
  location: { zh: '地点进化', en: 'Location', ja: '場所進化' },
  trade: { zh: '交换进化', en: 'Trade', ja: '通信交換進化' },
  special: { zh: '特殊进化', en: 'Special', ja: '特殊進化' },
  merge: { zh: '合并进化', en: 'Merge', ja: '合体進化' },
});

const TIME_TEXT = { day: { zh: '白天', en: 'during the day', ja: '昼' }, night: { zh: '夜晚', en: 'at night', ja: '夜' } };

function lang2(lang) {
  const l = String(lang || 'zh').toLowerCase();
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ja')) return 'ja';
  return 'zh';
}

/**
 * 条件的多语言描述
 * @param {object} req requirements
 * @param {object} itemNames { CODE: { zh, en, ja } }
 */
function describeRequirements(req, itemNames = {}) {
  const out = {};
  for (const l of LANGS) {
    const parts = [];
    if (req.candy) parts.push({ zh: `糖果 ×${req.candy}`, en: `${req.candy} candies`, ja: `アメ ×${req.candy}` }[l]);
    if (req.item) {
      const n = (itemNames[req.item] && itemNames[req.item][l]) || req.item;
      parts.push({ zh: `使用${n}`, en: `use ${n}`, ja: `${n}を使う` }[l]);
    }
    if (req.minLevel) parts.push({ zh: `等级 ≥ ${req.minLevel}`, en: `level ${req.minLevel}+`, ja: `レベル${req.minLevel}以上` }[l]);
    if (req.friendship) parts.push({ zh: `亲密度 ≥ ${req.friendship}`, en: `friendship ${req.friendship}+`, ja: `なつき度${req.friendship}以上` }[l]);
    if (req.time) parts.push({ zh: `在${TIME_TEXT[req.time].zh}`, en: TIME_TEXT[req.time].en, ja: `${TIME_TEXT[req.time].ja}に` }[l]);
    if (req.trade) parts.push({ zh: '通过交换', en: 'via trade', ja: '通信交換で' }[l]);
    out[l] = parts.join(l === 'en' ? ', ' : '，') || { zh: '无条件', en: 'no requirement', ja: '条件なし' }[l];
  }
  return out;
}

/** 父子关系索引：childId → [{ parentId, option }]，parentId → options */
function indexGraph(speciesList, rulesList) {
  const byId = new Map(speciesList.map((s) => [Number(s.id), s]));
  const rulesByFrom = new Map();
  for (const r of rulesList) {
    const k = Number(r.from_species_id);
    if (!rulesByFrom.has(k)) rulesByFrom.set(k, []);
    rulesByFrom.get(k).push(r);
  }
  const children = new Map();
  const parents = new Map();
  for (const s of speciesList) {
    const opts = buildEvolutionOptions(s, rulesByFrom.get(Number(s.id)) || [], byId);
    children.set(Number(s.id), opts);
    for (const o of opts) {
      if (!parents.has(o.toSpeciesId)) parents.set(o.toSpeciesId, []);
      parents.get(o.toSpeciesId).push({ parentId: Number(s.id), option: o });
    }
  }
  return { byId, children, parents };
}

function rootOf(graph, speciesId) {
  let cur = Number(speciesId);
  const seen = new Set([cur]);
  for (;;) {
    const ps = graph.parents.get(cur);
    if (!ps || !ps.length) return cur;
    const next = ps.map((p) => p.parentId).sort((a, b) => a - b)[0];
    if (seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

function nodeOf(s) {
  return { speciesId: Number(s.id), name: s.name_zh, nameEn: s.name_en, nameJa: s.name_ja || null, types: [s.type1, s.type2].filter(Boolean),
    rarity: s.rarity, spriteUrl: s.sprite_url || null, baseStats: { attack: s.base_attack, defense: s.base_defense, hp: s.base_hp } };
}

/**
 * 构建家族进化树
 * @param {object} graph indexGraph 结果
 * @param {number} speciesId 任意家族成员
 * @param {object} opts { discovered: Set<number>, itemNames, lang, focusSpeciesId }
 */
function buildTree(graph, speciesId, opts = {}) {
  const id = Number(speciesId);
  if (!graph.byId.has(id)) return null;
  const discovered = opts.discovered || new Set();
  const lang = lang2(opts.lang);
  const rootId = rootOf(graph, id);
  const nodes = [];
  const edges = [];
  const visit = (sid, stage, visible, path) => {
    const s = graph.byId.get(sid);
    const node = { ...nodeOf(s), stage, focus: sid === id, discovered: visible };
    if (!visible) Object.assign(node, { speciesId: null, name: '？？？', nameEn: '???', nameJa: '？？？', types: [], spriteUrl: null, baseStats: null });
    nodes.push(node);
    const kids = [];
    for (const o of graph.children.get(sid) || []) {
      if (path.has(o.toSpeciesId)) continue; // 防环
      const target = graph.byId.get(o.toSpeciesId);
      const targetVisible = visible && (!o.hidden || discovered.has(o.toSpeciesId));
      const desc = describeRequirements(o.requirements, opts.itemNames);
      const statChanges = {
        attack: target.base_attack - s.base_attack,
        defense: target.base_defense - s.base_defense,
        hp: target.base_hp - s.base_hp,
        typesAdded: [target.type1, target.type2].filter((t) => t && t !== s.type1 && t !== s.type2),
        typesRemoved: [s.type1, s.type2].filter((t) => t && t !== target.type1 && t !== target.type2),
      };
      const edge = {
        from: node.speciesId,
        to: targetVisible ? o.toSpeciesId : null,
        evolutionType: o.evolutionType,
        typeLabel: (TYPE_LABELS[o.evolutionType] || TYPE_LABELS.special)[lang],
        requirements: targetVisible ? o.requirements : null,
        conditionText: targetVisible ? desc[lang] : null,
        descriptions: targetVisible ? desc : null,
        statChanges: targetVisible ? statChanges : null,
        hidden: o.hidden,
        hint: o.hidden ? (o.hint && (o.hint[lang] || o.hint.zh)) || null : null,
      };
      edges.push(edge);
      const child = visit(o.toSpeciesId, stage + 1, targetVisible, new Set([...path, o.toSpeciesId]));
      kids.push({ edge, node: child });
    }
    node.childCount = kids.length;
    return node;
  };
  visit(rootId, 1, true, new Set([rootId]));
  layout(nodes, edges);
  return {
    rootSpeciesId: rootId,
    focusSpeciesId: id,
    stages: Math.max(...nodes.map((n) => n.stage)),
    nodes,
    edges,
    hasBranches: [...new Set(edges.map((e) => e.from))].some((f) => edges.filter((e) => e.from === f).length > 1),
    hiddenCount: edges.filter((e) => e.hidden).length,
  };
}

/** 布局：每个阶段一行，按节点出现顺序在 [0,1] 等分 */
function layout(nodes) {
  const byStage = new Map();
  for (const n of nodes) {
    if (!byStage.has(n.stage)) byStage.set(n.stage, []);
    byStage.get(n.stage).push(n);
  }
  const maxStage = Math.max(...byStage.keys());
  for (const [stage, list] of byStage) {
    list.forEach((n, i) => {
      n.position = { x: Math.round(((i + 1) / (list.length + 1)) * 1000) / 1000, y: maxStage > 1 ? Math.round(((stage - 1) / (maxStage - 1)) * 1000) / 1000 : 0 };
    });
  }
}

/** 反向追溯：从当前物种到家族根的前身链（根在前） */
function ancestors(graph, speciesId) {
  const chain = [];
  let cur = Number(speciesId);
  const seen = new Set([cur]);
  for (;;) {
    const ps = graph.parents.get(cur);
    if (!ps || !ps.length) break;
    const p = ps.slice().sort((a, b) => a.parentId - b.parentId)[0];
    if (seen.has(p.parentId)) break;
    seen.add(p.parentId);
    chain.unshift({ ...nodeOf(graph.byId.get(p.parentId)), evolvesTo: cur, evolutionType: p.option.evolutionType, requirements: p.option.requirements });
    cur = p.parentId;
  }
  return chain;
}

module.exports = { TYPE_LABELS, describeRequirements, indexGraph, rootOf, buildTree, ancestors, lang2 };
