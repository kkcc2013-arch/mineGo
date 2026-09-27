/**
 * 收藏室规则（纯函数，无 I/O）——REQ-00359 / REQ-00403
 *
 * 等级：经验阈值 [0,100,250,500,1000,2000,4000,8000,15000,30000]（REQ-00359 §5）
 * 容量（合并两份需求）：展示精灵 20 + 5×(等级-1)，上限 50（REQ-00403"最多 50 只"）；装饰 10 + 5×(等级-1)，上限 60
 * 经验来源（按"原因+对象"去重）：摆放装饰 5（每种物品一次）、展示精灵 10（每只一次）、访客到访 3（每人每天一次）、
 *   被点赞 15（每人一次）、被留言 10（每人每天一次）
 * 布局：网格坐标，装饰按宽高占格（旋转 90/270 时宽高互换）；地面类装饰（floor）单独一层，其余装饰与精灵同层不可重叠
 */
'use strict';

const LEVEL_THRESHOLDS = Object.freeze([0, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000]);
const MAX_LEVEL = LEVEL_THRESHOLDS.length;
const EXP_TABLE = Object.freeze({
  decoration_placed: 5, pokemon_displayed: 10, visitor_came: 3, visitor_liked: 15, visitor_commented: 10,
});
const LEVEL_REWARD_ITEMS = Object.freeze({ 3: 'level_3_reward', 5: 'level_5_reward', 7: 'level_7_reward', 10: 'level_10_reward' });
const PEDESTAL_MIN_LEVEL = Object.freeze({ basic: 1, bronze: 2, silver: 4, gold: 6, diamond: 8 });
const DISPLAY_MODES = Object.freeze(['idle', 'walk', 'pose', 'battle', 'shiny', 'card', '3d']);
const ROTATIONS = Object.freeze([0, 90, 180, 270]);
const MAX_POKEMON = 50;
const CUSTOM_BACKGROUND_MIN_LEVEL = 5;
const GRID_LIMITS = Object.freeze({ minW: 6, maxW: 20, minH: 6, maxH: 16 });
const DEFAULT_GRID = Object.freeze({ width: 10, height: 8 });

function levelForExp(exp) {
  const e = Math.max(0, Number(exp) || 0);
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) if (e >= LEVEL_THRESHOLDS[i]) return i + 1;
  return 1;
}

function levelInfo(exp) {
  const level = levelForExp(exp);
  const next = level < MAX_LEVEL ? LEVEL_THRESHOLDS[level] : null;
  const cur = LEVEL_THRESHOLDS[level - 1];
  return {
    level, experience: Number(exp) || 0, currentLevelExp: cur, nextLevelExp: next,
    progress: next == null ? 1 : +(((Number(exp) || 0) - cur) / (next - cur)).toFixed(4),
  };
}

function capacity(level) {
  const l = Math.min(Math.max(1, Number(level) || 1), MAX_LEVEL);
  return { pokemon: Math.min(MAX_POKEMON, 20 + 5 * (l - 1)), decorations: Math.min(60, 10 + 5 * (l - 1)) };
}

/** 升级跨越的等级奖励物品 */
function levelRewards(fromLevel, toLevel) {
  const out = [];
  for (let l = fromLevel + 1; l <= toLevel; l++) if (LEVEL_REWARD_ITEMS[l]) out.push({ level: l, itemCode: LEVEL_REWARD_ITEMS[l] });
  return out;
}

/**
 * 解锁条件判断
 * @param {object} cond  {roomLevel?, achievementId?, collectorLevel?}
 * @param {{roomLevel:number, achievements?:Set<string>, collectorLevel?:number}} ctx
 */
function meetsCondition(cond, ctx) {
  const c = cond && typeof cond === 'object' ? cond : {};
  if (c.roomLevel && (ctx.roomLevel || 1) < Number(c.roomLevel)) return false;
  if (c.achievementId && !(ctx.achievements && ctx.achievements.has(c.achievementId))) return false;
  if (c.collectorLevel && (ctx.collectorLevel || 1) < Number(c.collectorLevel)) return false;
  return true;
}

/** 主题/背景是否可用：满足条件（非付费）或已购买 */
function isUnlocked(def, ctx, purchased = new Set()) {
  if (!def) return false;
  if (def.is_premium) return purchased.has(def.id);
  return meetsCondition(def.unlock_condition, ctx);
}

/** 物品占格（旋转 90/270 宽高互换） */
function footprint(item, pos) {
  const rot = Number(pos.rotation) || 0;
  const w = rot === 90 || rot === 270 ? item.height : item.width;
  const h = rot === 90 || rot === 270 ? item.width : item.height;
  return { x: Number(pos.x), y: Number(pos.y), w: Math.max(1, w || 1), h: Math.max(1, h || 1) };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function layerOf(entry) { return entry.category === 'floor' ? 'floor' : 'object'; }

/**
 * 校验一次摆放：坐标整数、在网格内、同层不重叠
 * @param {{width:number,height:number,category?:string}} item   精灵传 {width:1,height:1,category:'pokemon'}
 * @param {{x:number,y:number,rotation?:number}} pos
 * @param {{width:number,height:number}} grid
 * @param {Array<{key:string,x:number,y:number,w:number,h:number,layer:string}>} occupied  其他已摆放物（不含自身）
 */
function validatePlacement(item, pos, grid, occupied = []) {
  if (!Number.isInteger(Number(pos.x)) || !Number.isInteger(Number(pos.y))) return { ok: false, error: '坐标必须是整数' };
  if (pos.rotation !== undefined && !ROTATIONS.includes(Number(pos.rotation))) return { ok: false, error: 'rotation 只能是 0/90/180/270' };
  const fp = footprint(item, pos);
  const g = grid || DEFAULT_GRID;
  if (fp.x < 0 || fp.y < 0 || fp.x + fp.w > g.width || fp.y + fp.h > g.height) return { ok: false, error: '超出收藏室范围' };
  const layer = layerOf(item);
  const hit = occupied.find((o) => o.layer === layer && overlaps(fp, o));
  if (hit) return { ok: false, error: '该位置已被占用', conflict: hit.key };
  return { ok: true, footprint: { ...fp, layer } };
}

/** 校验整体布局（批量拖拽保存）：逐个放入，任一失败即返回 */
function validateLayout(entries, grid) {
  const placed = [];
  for (const e of entries) {
    const r = validatePlacement(e.item, e.pos, grid, placed);
    if (!r.ok) return { ok: false, error: `${e.key}: ${r.error}`, key: e.key };
    placed.push({ key: e.key, ...r.footprint });
  }
  return { ok: true, placed };
}

function clampScale(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(2, Math.max(0.5, n)) * 100) / 100;
}

const HTTPS_URL = /^https:\/\/[^\s"'<>]{4,490}$/i;
const ID = /^[a-z0-9_]{2,50}$/;

/**
 * 校验收藏室设置更新
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateRoomPatch(body, { level = 1 } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.roomName !== undefined) {
    const name = String(b.roomName).replace(/[<>]/g, '').trim();
    if (name.length < 1 || name.length > 40) return { ok: false, error: 'roomName 长度应为 1~40' };
    out.room_name = name;
  }
  if (b.themeId !== undefined) {
    if (!ID.test(String(b.themeId))) return { ok: false, error: 'themeId 无效' };
    out.theme_id = String(b.themeId);
  }
  if (b.backgroundId !== undefined) {
    if (!ID.test(String(b.backgroundId))) return { ok: false, error: 'backgroundId 无效' };
    out.background_id = String(b.backgroundId);
  }
  if (b.backgroundImageUrl !== undefined) {
    if (b.backgroundImageUrl === null || b.backgroundImageUrl === '') out.background_image_url = null;
    else {
      if (level < CUSTOM_BACKGROUND_MIN_LEVEL) return { ok: false, error: `收藏室 ${CUSTOM_BACKGROUND_MIN_LEVEL} 级后才能使用自定义背景` };
      if (!HTTPS_URL.test(String(b.backgroundImageUrl))) return { ok: false, error: 'backgroundImageUrl 必须是 https 地址' };
      out.background_image_url = String(b.backgroundImageUrl);
    }
  }
  if (b.isPublic !== undefined) {
    if (typeof b.isPublic !== 'boolean') return { ok: false, error: 'isPublic 必须是布尔值' };
    out.is_public = b.isPublic;
  }
  if (b.layoutConfig !== undefined) {
    const gs = b.layoutConfig && b.layoutConfig.gridSize;
    const w = Number(gs && gs.width); const h = Number(gs && gs.height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < GRID_LIMITS.minW || w > GRID_LIMITS.maxW || h < GRID_LIMITS.minH || h > GRID_LIMITS.maxH) {
      return { ok: false, error: `gridSize 宽 ${GRID_LIMITS.minW}~${GRID_LIMITS.maxW}、高 ${GRID_LIMITS.minH}~${GRID_LIMITS.maxH}` };
    }
    out.layout_config = { gridSize: { width: w, height: h } };
  }
  if (!Object.keys(out).length) return { ok: false, error: '没有可更新的字段' };
  return { ok: true, value: out };
}

function sanitizeComment(content) {
  // eslint-disable-next-line no-control-regex
  const s = String(content == null ? '' : content).replace(/[<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!s) return { ok: false, error: '留言不能为空' };
  if (s.length > 200) return { ok: false, error: '留言最多 200 字' };
  return { ok: true, value: s };
}

function pedestalAllowed(type, level) {
  const min = PEDESTAL_MIN_LEVEL[type];
  return min !== undefined && (Number(level) || 1) >= min;
}

/** 稀有度分布 { COMMON: n, … } */
function rarityDistribution(rows) {
  const out = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
  for (const r of rows || []) {
    const k = String(r.rarity || 'COMMON').toUpperCase();
    out[k] = (out[k] || 0) + (Number(r.count) || 1);
  }
  return out;
}

module.exports = {
  LEVEL_THRESHOLDS, MAX_LEVEL, EXP_TABLE, LEVEL_REWARD_ITEMS, PEDESTAL_MIN_LEVEL, DISPLAY_MODES, ROTATIONS, MAX_POKEMON,
  CUSTOM_BACKGROUND_MIN_LEVEL, GRID_LIMITS, DEFAULT_GRID,
  levelForExp, levelInfo, capacity, levelRewards, meetsCondition, isUnlocked, footprint, overlaps, layerOf,
  validatePlacement, validateLayout, clampScale, validateRoomPatch, sanitizeComment, pedestalAllowed, rarityDistribution,
};
