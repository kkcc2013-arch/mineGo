// 战斗伤害计算 + 预计算缓存（REQ-00192 / REQ-00362，REQ-00146 公式）
//
// 公式（Pokemon GO 风格）：damage = floor(0.5 * power * atk/def * STAB * type * weather * random * crit * extra) + 1
//   - 属性克制使用 GO 倍率：克制 1.6、抵抗 0.625、免疫 0.390625（主系列的 0 倍在 GO 中为双重抵抗）
//   - STAB 1.2、天气加成 1.2、暴击 1.5、随机 0.85~1.0
//
// 三层缓存：
//   1. 属性克制矩阵：18x18 = 324 种组合在模块加载时预计算（命中率 100%）
//   2. 技能系数（power*STAB*type*weather）：warmup() 按「技能 × 攻方是否同属性 × 守方属性组合 × 天气」预计算
//   3. 对局基础伤害（与随机/暴击无关的确定部分）：L1 进程内 LRU（上限 10000 条）+ L2 Redis（TTL 1 小时，写后异步落盘，
//      新实例启动时从 L2 预热）。键由攻防数值、属性、技能威力/属性、天气组成（内容寻址）：
//      精灵强化/进化/换技能后键立即变化，旧条目不会再被命中，无需等待失效。
'use strict';

const { TYPE_CHART } = require('../../../../shared/typeChart');
const { WEATHER_BOOST_MAP } = require('../../../../shared/damageCalculator');
const battleMetrics = require('./metrics');

const TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];
const GO_MULTIPLIER = { 2: 1.6, 1: 1, 0.5: 0.625, 0: 0.390625 };
const STAB = 1.2;
const WEATHER_BONUS = 1.2;
const CRIT_MULTIPLIER = 1.5;
const WEATHERS = Object.keys(WEATHER_BOOST_MAP);

// ── 1. 属性克制矩阵预计算 ───────────────────────────────────────
const TYPE_MATRIX = {};
for (const atk of TYPES) {
  TYPE_MATRIX[atk] = {};
  for (const def of TYPES) {
    const raw = TYPE_CHART[atk] && TYPE_CHART[atk][def] !== undefined ? TYPE_CHART[atk][def] : 1;
    TYPE_MATRIX[atk][def] = GO_MULTIPLIER[raw] !== undefined ? GO_MULTIPLIER[raw] : raw;
  }
}

const norm = (t) => (t ? String(t).toLowerCase() : null);

function isWeatherBoosted(moveType, weather) {
  const list = WEATHER_BOOST_MAP[norm(weather)];
  return !!(list && list.includes(norm(moveType)));
}

function effectivenessText(mult) {
  if (mult > 1.01) return '效果拔群！';
  if (mult < 0.5) return '几乎没有效果……';
  if (mult < 0.99) return '效果不太好……';
  return '';
}

/** 简单 LRU（Map 保持插入顺序，命中时移到末尾） */
class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

class DamageService {
  /**
   * @param {object} opts
   * @param {number} [opts.l1Max=10000]  L1 条目上限（REQ-00362：1 万条内存 < 100MB）
   * @param {object} [opts.redis]        ioredis 客户端（可选，L2）
   * @param {number} [opts.redisTtlSec=3600]
   */
  constructor(opts = {}) {
    this.l1 = new Lru(opts.l1Max || 10000);
    this.coef = new Map();
    this.redis = opts.redis || null;
    this.redisTtlSec = opts.redisTtlSec || 3600;
    this.redisPrefix = opts.redisPrefix || 'battle:dmg:';
    this.counters = { typeHit: 0, typeMiss: 0, coefHit: 0, coefMiss: 0, l1Hit: 0, l1Miss: 0, l2Loaded: 0, calcs: 0 };
    this.warmedUpAt = null;
    this.warmupMs = null;
    this.pendingL2 = new Map();
  }

  /** 属性克制倍率（双属性相乘）。矩阵覆盖全部 18x18，未知属性按 1 计 */
  typeMultiplier(moveType, defenderTypes) {
    const atk = TYPE_MATRIX[norm(moveType)];
    let mult = 1;
    for (const d of defenderTypes || []) {
      const v = atk && atk[norm(d)];
      if (v === undefined) { this.counters.typeMiss++; continue; }
      this.counters.typeHit++;
      mult *= v;
    }
    return mult;
  }

  coefficientKey(move, stab, defenderTypes, weather) {
    return `${move.id}|${move.power}|${norm(move.type)}|${stab ? 1 : 0}|${(defenderTypes || []).map(norm).sort().join('/')}|${norm(weather) || 'clear'}`;
  }

  /** 技能系数 = power * STAB * 克制 * 天气 */
  coefficient(move, attackerTypes, defenderTypes, weather) {
    const stab = (attackerTypes || []).map(norm).includes(norm(move.type));
    const key = this.coefficientKey(move, stab, defenderTypes, weather);
    let c = this.coef.get(key);
    if (c) { this.counters.coefHit++; return c; }
    this.counters.coefMiss++;
    const typeMult = this.typeMultiplier(move.type, defenderTypes);
    const weatherBoosted = isWeatherBoosted(move.type, weather);
    c = {
      value: (move.power || 0) * (stab ? STAB : 1) * typeMult * (weatherBoosted ? WEATHER_BONUS : 1),
      stab, typeMult, weatherBoosted,
    };
    this.coef.set(key, c);
    return c;
  }

  matchupKey(attacker, defender, move, weather) {
    const r = (x) => Math.round(Number(x) * 100) / 100;
    return `${r(attacker.attack)}:${(attacker.types || []).join('/')}>${r(defender.defense)}:${(defender.types || []).join('/')}|${move.id}:${move.power}:${norm(move.type)}|${norm(weather) || 'clear'}`;
  }

  /**
   * 确定性基础伤害（不含随机与暴击）。返回 { base, typeMult, stab, weatherBoosted, cached }
   */
  baseDamage(attacker, defender, move, weather) {
    const key = this.matchupKey(attacker, defender, move, weather);
    const hit = this.l1.get(key);
    if (hit) { this.counters.l1Hit++; return { ...hit, cached: true }; }
    this.counters.l1Miss++;
    const c = this.coefficient(move, attacker.types, defender.types, weather);
    const atk = Math.max(1, Number(attacker.attack) || 1);
    const def = Math.max(1, Number(defender.defense) || 1);
    const entry = { base: 0.5 * c.value * (atk / def), typeMult: c.typeMult, stab: c.stab, weatherBoosted: c.weatherBoosted };
    this.l1.set(key, entry);
    this.writeBehind(key, entry);
    return { ...entry, cached: false };
  }

  /**
   * 计算一次攻击的最终伤害
   * @param {object} ctx { rng, weather, critBoostPct, multiplier, ignoreDefensePct, attackFactor }
   */
  compute(attacker, defender, move, ctx = {}) {
    const t0 = process.hrtime.bigint();
    const rng = ctx.rng || Math.random;
    let b = this.baseDamage(attacker, defender, move, ctx.weather);
    if (ctx.ignoreDefensePct) {
      // 无视部分防御：等价于防御按比例降低，不进缓存
      const f = 1 / Math.max(0.1, 1 - ctx.ignoreDefensePct / 100);
      b = { ...b, base: b.base * f };
    }
    const critChance = Math.min(1, ((move.critPct || 0) + (ctx.critBoostPct || 0)) / 100);
    const isCrit = critChance > 0 && rng() < critChance;
    const random = 0.85 + rng() * 0.15;
    const extra = (ctx.multiplier || 1) * (ctx.attackFactor || 1);
    const damage = (move.power || 0) > 0 ? Math.max(1, Math.floor(b.base * random * (isCrit ? CRIT_MULTIPLIER : 1) * extra) + 1) : 0;
    this.counters.calcs++;
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    try { battleMetrics.damageCalcDuration.observe({ cached: String(b.cached) }, secs); } catch { /* 指标不可用不影响战斗 */ }
    return {
      damage, isCrit, random,
      effectiveness: b.typeMult, effectivenessText: effectivenessText(b.typeMult),
      stab: b.stab, weatherBoosted: b.weatherBoosted, cached: b.cached,
    };
  }

  /** 不含随机的期望伤害（AI / 推荐 / 预测使用） */
  expected(attacker, defender, move, weather) {
    if (!(move.power > 0)) return 0;
    const b = this.baseDamage(attacker, defender, move, weather);
    return Math.floor(b.base * 0.925) + 1;
  }

  /**
   * 预热：属性矩阵已在加载时计算；这里预计算技能系数并从 Redis L2 载入热点对局
   * @param {Array} moves  规范化技能列表
   * @param {Array<string[]>} typeCombos  守方属性组合（来自 species 表）
   */
  async warmup(moves = [], typeCombos = [], { weathers = WEATHERS, loadL2 = true, l2Limit = 5000 } = {}) {
    const t0 = Date.now();
    const combos = typeCombos.length ? typeCombos : TYPES.map((t) => [t]);
    for (const move of moves) {
      if (!(move.power > 0)) continue;
      for (const defTypes of combos) {
        for (const weather of weathers) {
          for (const stab of [true, false]) {
            const attackerTypes = stab ? [move.type] : [];
            this.coefficient(move, attackerTypes, defTypes, weather);
          }
        }
      }
    }
    // 预热本身产生的系数未命中不计入命中率统计（属性查询全部落在预计算矩阵上，保留计数）
    this.counters.coefMiss = 0;
    if (loadL2 && this.redis) {
      try {
        let cursor = '0';
        let loaded = 0;
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.redisPrefix}*`, 'COUNT', 500);
          cursor = next;
          if (keys.length) {
            const vals = await this.redis.mget(keys);
            keys.forEach((k, i) => {
              if (!vals[i]) return;
              try { this.l1.set(k.slice(this.redisPrefix.length), JSON.parse(vals[i])); loaded++; } catch { /* 忽略坏条目 */ }
            });
          }
        } while (cursor !== '0' && loaded < l2Limit);
        this.counters.l2Loaded += loaded;
      } catch { /* Redis 不可用时只用 L1 */ }
    }
    this.warmedUpAt = new Date().toISOString();
    this.warmupMs = Date.now() - t0;
    this.refreshGauges();
    return { coefficients: this.coef.size, l1: this.l1.size, ms: this.warmupMs };
  }

  writeBehind(key, entry) {
    if (!this.redis) return;
    this.pendingL2.set(key, entry);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushL2().catch(() => {}), 200);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  async flushL2() {
    this.flushTimer = null;
    if (!this.redis || this.pendingL2.size === 0) return 0;
    const batch = [...this.pendingL2.entries()];
    this.pendingL2.clear();
    const pipe = this.redis.pipeline();
    for (const [k, v] of batch) pipe.set(this.redisPrefix + k, JSON.stringify(v), 'EX', this.redisTtlSec);
    await pipe.exec();
    this.refreshGauges();
    return batch.length;
  }

  /** 手动刷新：清空 L1/系数缓存，并删除 Redis L2 */
  async invalidate({ l2 = true } = {}) {
    this.l1.clear();
    this.coef.clear();
    this.pendingL2.clear();
    let deleted = 0;
    if (l2 && this.redis) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.redisPrefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) deleted += await this.redis.del(...keys);
      } while (cursor !== '0');
    }
    this.refreshGauges();
    return { deleted };
  }

  refreshGauges() {
    try {
      battleMetrics.damageCacheEntries.set({ layer: 'l1' }, this.l1.size);
      battleMetrics.damageCacheEntries.set({ layer: 'coef' }, this.coef.size);
    } catch { /* ignore */ }
  }

  stats() {
    const c = this.counters;
    const rate = (h, m) => (h + m ? Number((h / (h + m)).toFixed(4)) : null);
    // 粗略内存估算：每条 L1 约 键长*2 + 120 字节对象开销
    let l1Bytes = 0;
    for (const k of this.l1.map.keys()) l1Bytes += k.length * 2 + 120;
    return {
      typeMatrixSize: TYPES.length * TYPES.length,
      typeHitRate: rate(c.typeHit, c.typeMiss),
      coefficientEntries: this.coef.size,
      coefficientHitRate: rate(c.coefHit, c.coefMiss),
      l1Entries: this.l1.size,
      l1Max: this.l1.max,
      l1HitRate: rate(c.l1Hit, c.l1Miss),
      l1MemoryBytesEstimate: l1Bytes,
      l2LoadedOnWarmup: c.l2Loaded,
      l2TtlSec: this.redisTtlSec,
      calculations: c.calcs,
      counters: { ...c },
      warmedUpAt: this.warmedUpAt,
      warmupMs: this.warmupMs,
    };
  }

  /** 把计数器增量推到 Prometheus（由调用方周期性调用） */
  exportCounters() {
    const c = this.counters;
    const last = this.lastExported || {};
    const pairs = [['type', 'hit', 'typeHit'], ['type', 'miss', 'typeMiss'], ['coef', 'hit', 'coefHit'],
      ['coef', 'miss', 'coefMiss'], ['l1', 'hit', 'l1Hit'], ['l1', 'miss', 'l1Miss']];
    for (const [layer, result, key] of pairs) {
      const delta = c[key] - (last[key] || 0);
      if (delta > 0) battleMetrics.damageCache.inc({ layer, result }, delta);
    }
    this.lastExported = { ...c };
    this.refreshGauges();
  }
}

module.exports = {
  DamageService, TYPE_MATRIX, TYPES, isWeatherBoosted, effectivenessText,
  STAB, WEATHER_BONUS, CRIT_MULTIPLIER, WEATHERS,
};
