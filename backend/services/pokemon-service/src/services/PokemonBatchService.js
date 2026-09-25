/**
 * REQ-00350：精灵详情批量查询与数据聚合
 *
 * - getBatchDetails(ids, { userId, include, cacheStrategy, timeout })：一次最多 100 个 id；
 *   只用 1 个数据库连接：1 条主查询（与 GET /pokemon/my/:id 同形态）+ 每个 include 1 条查询
 *   include：skills（技能库）/ equipment（已装备）/ effects（疲劳、体力、HP 状态）/ battle（战斗统计）/ history（亲密度日志）
 * - 部分 include 查询失败 → 其余结果照常返回（metadata.partial + failedIncludes），不在表里的 id 进 errors
 * - 缓存：Redis pkdetail:u:<uid>:v<用户缓存版本>:<id>:<include>，TTL 30s；用户经网关的任意写操作使版本 +1
 *   （与网关读缓存共用 cache:ver:<uid>），旧条目立即不可见
 * - cacheStrategy：prefer（默认，读缓存 + 回源）/ bypass（不读缓存，写回）/ only（只读缓存）
 * - getDetail(id)：单个详情经 RequestCoalescer 在 50ms 窗口内与同一用户的其它详情请求合并成一次查询
 * - prefetch(userId, ids)：列表页返回后预取前 N 个详情；命中率统计 pkprefetch:stats
 */
'use strict';

const promClient = require('prom-client');
const { RequestCoalescer } = require('../../../../shared/apiStandards/requestCoalescer');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INCLUDES = ['skills', 'equipment', 'effects', 'battle', 'history'];
const MAX_IDS = 100;

const DETAIL_SQL = `
  SELECT pi.*, ps.name_zh, ps.name_en, ps.type1, ps.type2,
         ps.sprite_url, ps.sprite_shiny_url, ps.description_zh,
         ps.base_attack, ps.base_defense, ps.base_hp,
         ps.candy_to_evolve, ps.evolves_to,
         COALESCE(ci.amount,0) AS candy_count
  FROM pokemon_instances pi
  JOIN pokemon_species ps ON ps.id = pi.species_id
  LEFT JOIN candy_inventory ci ON ci.user_id=pi.user_id AND ci.species_id=pi.species_id
  WHERE pi.id = ANY($1::uuid[]) AND pi.user_id=$2`;

function metric(register, Type, cfg) {
  return register.getSingleMetric(cfg.name) || new Type({ ...cfg, registers: [register] });
}

class BatchValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.httpStatus = 400;
    this.code = 1001;
    this.details = details;
  }
}

class PokemonBatchService {
  /**
   * @param {object} deps { query, getClient, redis, logger, register, cacheTTL, windowMs }
   */
  constructor({ query, getClient, redis = null, logger = null, register = null, cacheTTL = 30, windowMs = 50 } = {}) {
    this.query = query;
    this.getClient = getClient;
    this.redis = redis;
    this.logger = logger;
    this.cacheTTL = cacheTTL;
    const reg = register || promClient.register;
    this.metrics = {
      requests: metric(reg, promClient.Counter, { name: 'pokemon_batch_query_total', help: 'Batch detail queries', labelNames: ['result'] }),
      duration: metric(reg, promClient.Histogram, { name: 'pokemon_batch_query_duration_seconds', help: 'Batch detail query duration', buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1] }),
      size: metric(reg, promClient.Histogram, { name: 'pokemon_batch_query_size', help: 'Ids per batch query', buckets: [1, 5, 10, 20, 50, 100] }),
      cache: metric(reg, promClient.Counter, { name: 'pokemon_batch_cache_total', help: 'Batch detail cache lookups', labelNames: ['result'] }),
      dbQueries: metric(reg, promClient.Counter, { name: 'pokemon_batch_db_queries_total', help: 'DB queries issued by batch detail service' }),
      coalesced: metric(reg, promClient.Counter, { name: 'pokemon_detail_coalesced_requests_total', help: 'Detail requests merged into a shared query (50ms window)' }),
      prefetch: metric(reg, promClient.Counter, { name: 'pokemon_prefetch_total', help: 'Prefetch outcomes', labelNames: ['result'] }),
    };
    this.coalescer = new RequestCoalescer({
      windowMs,
      maxBatch: MAX_IDS,
      batchFn: (userId, ids) => this.loadBase(ids, userId),
      onFlush: ({ requests }) => { if (requests > 1) this.metrics.coalesced.inc(requests - 1); },
    });
  }

  static validate(ids, include = []) {
    if (!Array.isArray(ids) || ids.length === 0) throw new BatchValidationError('ids 必须是非空数组');
    if (ids.length > MAX_IDS) throw new BatchValidationError(`ids 最多 ${MAX_IDS} 个`, { max: MAX_IDS, actual: ids.length });
    const invalid = ids.filter((x) => typeof x !== 'string' || !UUID_RE.test(x));
    if (invalid.length) throw new BatchValidationError('ids 必须是 UUID', { invalid: invalid.slice(0, 10) });
    const inc = Array.isArray(include) ? include : String(include || '').split(',').filter(Boolean);
    const badInc = inc.filter((x) => !INCLUDES.includes(x));
    if (badInc.length) throw new BatchValidationError(`include 只能是 ${INCLUDES.join('/')}`, { invalid: badInc });
    return { ids: [...new Set(ids.map((x) => x.toLowerCase()))], include: [...new Set(inc)].sort() };
  }

  async _userVersion(userId) {
    if (!this.redis) return '0';
    try { return (await this.redis.get(`cache:ver:${userId}`)) || '0'; } catch { return null; }
  }

  _key(userId, ver, id, include) {
    return `pkdetail:u:${userId}:v${ver}:${id}:${include.length ? include.join('+') : 'base'}`;
  }

  async _mget(keys) {
    if (!this.redis || !keys.length) return keys.map(() => null);
    try { return await this.redis.mget(...keys); } catch { return keys.map(() => null); }
  }

  async _mset(entries) {
    if (!this.redis || !entries.length) return;
    try {
      const p = this.redis.pipeline();
      for (const [k, v] of entries) p.set(k, JSON.stringify(v), 'EX', this.cacheTTL);
      await p.exec();
    } catch { /* 缓存失败不影响结果 */ }
  }

  /** 主查询：ids → Map(id → row)（只返回属于该用户的精灵） */
  async loadBase(ids, userId, client = null) {
    const run = client ? (sql, p) => client.query(sql, p) : this.query;
    this.metrics.dbQueries.inc();
    const { rows } = await run(DETAIL_SQL, [ids, userId]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async _loadIncludes(client, rows, userId, include) {
    const ids = rows.map((r) => r.id);
    const out = {};
    const failed = [];
    let queries = 0;
    const q = async (name, sql, params) => {
      this.metrics.dbQueries.inc();
      queries++;
      try {
        return (await client.query(sql, params)).rows;
      } catch (err) {
        failed.push(name);
        if (this.logger) this.logger.warn({ err: err.message, include: name }, 'batch include query failed');
        return null;
      }
    };
    if (include.includes('skills')) {
      const moveIds = new Set();
      for (const r of rows) {
        for (const m of [r.fast_move, r.charge_move, ...(r.learned_fast_moves || []), ...(r.learned_charge_moves || [])]) if (m) moveIds.add(m);
      }
      const moves = moveIds.size ? await q('skills', 'SELECT id, name_zh, name_en, type, category, power, energy_delta, duration_ms FROM moves WHERE id = ANY($1)', [[...moveIds]]) : [];
      if (moves) {
        const byId = new Map(moves.map((m) => [m.id, m]));
        out.skills = new Map(rows.map((r) => {
          const fastIds = [...new Set([r.fast_move, ...(r.learned_fast_moves || [])].filter(Boolean))];
          const chargeIds = [...new Set([r.charge_move, ...(r.learned_charge_moves || [])].filter(Boolean))];
          return [r.id, {
            selected: { fast: r.fast_move || null, charge: r.charge_move || null },
            fast: fastIds.map((id) => byId.get(id) || { id }),
            charge: chargeIds.map((id) => byId.get(id) || { id }),
          }];
        }));
      }
    }
    if (include.includes('equipment')) {
      const eq = await q('equipment', `SELECT pe.id, pe.equipped_to_pokemon_id, pe.current_level, pe.current_stats, et.name_zh, et.name_en, et.type, et.rarity
                                         FROM player_equipment pe JOIN equipment_templates et ON et.id = pe.template_id
                                        WHERE pe.equipped_to_pokemon_id = ANY($1::uuid[]) AND pe.user_id = $2 AND pe.is_equipped = true`, [ids, userId]);
      if (eq) {
        const m = new Map(ids.map((id) => [id, []]));
        for (const e of eq) m.get(e.equipped_to_pokemon_id).push({ id: e.id, name_zh: e.name_zh, name_en: e.name_en, type: e.type, rarity: e.rarity, level: e.current_level, stats: e.current_stats });
        out.equipment = m;
      }
    }
    if (include.includes('effects')) {
      // 实例级状态（battle_pokemon_status 的实例 id 为整型，与 UUID 实例不兼容，故从实例字段推导）
      out.effects = new Map(rows.map((r) => {
        const effects = [];
        if (r.fatigue_level && r.fatigue_level !== 'NONE' && r.fatigue_level !== 'normal') effects.push({ type: 'fatigue', level: r.fatigue_level });
        if (r.max_stamina) effects.push({ type: 'stamina', current: r.current_stamina, max: r.max_stamina });
        if (r.hp_max && r.hp_current !== null && r.hp_current < r.hp_max) effects.push({ type: 'injured', hp: r.hp_current, hpMax: r.hp_max });
        if (r.defending_gym_id) effects.push({ type: 'defending', gymId: r.defending_gym_id });
        if (r.is_locked) effects.push({ type: 'locked' });
        return [r.id, effects];
      }));
    }
    if (include.includes('battle')) {
      const b = await q('battle', `SELECT pokemon_id, battles_won, battles_lost, total_damage_dealt, total_damage_taken, ko_count, fainted_count
                                     FROM pokemon_battle_stats WHERE pokemon_id = ANY($1::uuid[])`, [ids]);
      if (b) {
        const m = new Map(b.map((x) => [x.pokemon_id, x]));
        out.battle = new Map(ids.map((id) => {
          const x = m.get(id);
          return [id, x ? { won: x.battles_won, lost: x.battles_lost, damageDealt: Number(x.total_damage_dealt), damageTaken: Number(x.total_damage_taken), ko: x.ko_count, fainted: x.fainted_count } : { won: 0, lost: 0, damageDealt: 0, damageTaken: 0, ko: 0, fainted: 0 }];
        }));
      }
    }
    if (include.includes('history')) {
      const h = await q('history', `SELECT pokemon_instance_id, change_amount, source, new_value, created_at FROM (
                                      SELECT *, ROW_NUMBER() OVER (PARTITION BY pokemon_instance_id ORDER BY created_at DESC) AS rn
                                        FROM pokemon_friendship_logs WHERE pokemon_instance_id = ANY($1::uuid[])) t
                                    WHERE rn <= 10`, [ids]);
      if (h) {
        const m = new Map(rows.map((r) => [r.id, r.caught_at ? [{ type: 'caught', at: r.caught_at }] : []]));
        for (const x of h) m.get(x.pokemon_instance_id).unshift({ type: 'friendship', source: x.source, change: x.change_amount, value: x.new_value, at: x.created_at });
        out.history = m;
      }
    }
    return { out, failed, queries };
  }

  /**
   * @returns {{ results: object, errors: object, metadata: object }}
   */
  async getBatchDetails(rawIds, { userId, include: rawInclude = [], cacheStrategy = 'prefer', timeout = 5000 } = {}) {
    const t0 = Date.now();
    const { ids, include } = PokemonBatchService.validate(rawIds, rawInclude);
    if (!['prefer', 'bypass', 'only'].includes(cacheStrategy)) throw new BatchValidationError('cacheStrategy 只能是 prefer/bypass/only');
    this.metrics.size.observe(ids.length);
    const ver = await this._userVersion(userId);
    const results = {};
    const errors = {};
    let cached = 0;
    let missing = ids;
    if (ver !== null && cacheStrategy !== 'bypass') {
      const vals = await this._mget(ids.map((id) => this._key(userId, ver, id, include)));
      missing = [];
      ids.forEach((id, i) => {
        if (vals[i]) {
          const v = JSON.parse(vals[i]);
          delete v._pf;
          results[id] = v;
          cached++;
        } else missing.push(id);
      });
      this.metrics.cache.inc({ result: 'hit' }, cached);
      this.metrics.cache.inc({ result: 'miss' }, missing.length);
    }
    let dbQueries = 0;
    let partial = false;
    let failedIncludes = [];
    if (missing.length && cacheStrategy !== 'only') {
      const client = await this.getClient();
      try {
        await client.query(`SET statement_timeout = ${Math.max(100, Math.min(30000, Number(timeout) || 5000))}`);
        const base = await this.loadBase(missing, userId, client);
        dbQueries++;
        const rows = missing.map((id) => base.get(id)).filter(Boolean);
        const { out, failed, queries } = include.length && rows.length ? await this._loadIncludes(client, rows, userId, include) : { out: {}, failed: [], queries: 0 };
        dbQueries += queries;
        failedIncludes = failed;
        partial = failed.length > 0;
        const toCache = [];
        for (const r of rows) {
          const item = { ...r };
          for (const inc of include) {
            if (out[inc]) item[inc] = out[inc].get(r.id);
            else if (failed.includes(inc)) (item._missing = item._missing || []).push(inc);
          }
          results[r.id] = item;
          if (!item._missing && ver !== null) toCache.push([this._key(userId, ver, r.id, include), item]);
        }
        this._mset(toCache);
        for (const id of missing) if (!base.has(id)) errors[id] = { code: 'NOT_FOUND', message: '精灵不存在或不属于当前用户' };
      } finally {
        await client.query('RESET statement_timeout').catch(() => {});
        client.release();
      }
    } else if (cacheStrategy === 'only') {
      for (const id of missing) errors[id] = { code: 'CACHE_MISS', message: '缓存中不存在（cacheStrategy=only）' };
    }
    // 按请求顺序输出
    const ordered = {};
    for (const id of ids) if (results[id]) ordered[id] = results[id];
    const queryTime = Date.now() - t0;
    this.metrics.duration.observe(queryTime / 1000);
    this.metrics.requests.inc({ result: Object.keys(errors).length ? (Object.keys(ordered).length ? 'partial' : 'empty') : 'ok' });
    return {
      results: ordered,
      errors,
      metadata: {
        requested: ids.length,
        found: Object.keys(ordered).length,
        failed: Object.keys(errors).length,
        cached,
        cacheHitRate: ids.length ? +(cached / ids.length).toFixed(4) : 0,
        queryTime,
        dbQueries,
        dbConnections: dbQueries ? 1 : 0,
        include,
        partial,
        failedIncludes,
      },
    };
  }

  /** 单个详情：缓存 → 50ms 窗口合并查询 → 写缓存 */
  async getDetail(id, userId) {
    if (!UUID_RE.test(String(id))) return null;
    const ver = await this._userVersion(userId);
    if (ver !== null && this.redis) {
      const [hit] = await this._mget([this._key(userId, ver, id, [])]);
      if (hit) {
        const v = JSON.parse(hit);
        if (v._pf) {
          this.metrics.prefetch.inc({ result: 'hit' });
          this.redis.hincrby('pkprefetch:stats', 'hits', 1).catch(() => {});
          delete v._pf;
          // 预取条目只计一次命中，之后按普通缓存处理
          this._mset([[this._key(userId, ver, id, []), v]]);
        }
        this.metrics.cache.inc({ result: 'hit' });
        return v;
      }
    }
    const row = await this.coalescer.load(userId, String(id).toLowerCase());
    if (row && ver !== null) this._mset([[this._key(userId, ver, id, []), row]]);
    return row;
  }

  /** 列表返回后异步预取前 N 个详情（带 _pf 标记，用于统计预测准确率） */
  async prefetch(userId, ids, { limit = 10 } = {}) {
    if (!this.redis || !ids.length) return 0;
    const target = ids.filter((x) => UUID_RE.test(String(x))).slice(0, limit);
    const ver = await this._userVersion(userId);
    if (ver === null) return 0;
    const existing = await this._mget(target.map((id) => this._key(userId, ver, id, [])));
    const need = target.filter((_, i) => !existing[i]);
    if (!need.length) return 0;
    const base = await this.loadBase(need, userId);
    const entries = [...base.values()].map((r) => [this._key(userId, ver, r.id, []), { ...r, _pf: 1 }]);
    await this._mset(entries);
    this.metrics.prefetch.inc({ result: 'prefetched' }, entries.length);
    this.redis.hincrby('pkprefetch:stats', 'prefetched', entries.length).catch(() => {});
    return entries.length;
  }

  async prefetchStats() {
    if (!this.redis) return { prefetched: 0, hits: 0, accuracy: null };
    const s = await this.redis.hgetall('pkprefetch:stats').catch(() => ({}));
    const prefetched = Number(s.prefetched || 0), hits = Number(s.hits || 0);
    return { prefetched, hits, accuracy: prefetched ? +(hits / prefetched).toFixed(4) : null, coalescer: this.coalescer.stats };
  }
}

module.exports = { PokemonBatchService, BatchValidationError, INCLUDES, MAX_IDS, DETAIL_SQL };
