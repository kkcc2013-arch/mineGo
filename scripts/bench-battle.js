#!/usr/bin/env node
/**
 * E11 战斗性能基准
 *
 * 1) 进程内（无需服务）：node scripts/bench-battle.js --local
 *    - 伤害计算：缓存命中/未命中单次耗时（REQ-00192：命中 <5ms、未命中 <50ms）、预热耗时（<30s）
 *    - L1 缓存 1 万条内存（REQ-00362：<100MB，按堆增量实测）、属性矩阵 324 项
 *    - 同配置战斗请求的缓存命中率（REQ-00362 >80%，REQ-00192 技能伤害 ≥80%、属性系数 ≥95%）
 *    - 连击检测单次延迟（REQ-00364 <50ms）、冷却计算（REQ-00299 <50ms）
 *    - AI：实时建议 P95（<500ms）、阵容优化（<3s）、胜率预测
 *    - 回合引擎：单回合服务端计算 P95（不含网络/存储）
 *
 * 2) 经网关（需要运行中的服务，BASE_URL / DATABASE_URL / REDIS_URL 同 smoke 脚本）：
 *    node scripts/bench-battle.js [--battles 20] [--concurrency 5]
 *    - 并发道馆战斗：回合接口 P50/P95/P99（REQ-00362 P95 <50ms 为服务端目标，经网关含网络开销）
 *    - 能量查询 P95（REQ-00112 <50ms）、技能推荐 P95（REQ-00324 <200ms）、AI 建议 P95（<500ms）、团战攻击 P95
 */
'use strict';

const path = require('path');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(3)); };
const summary = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: arr.length ? Number(Math.max(...arr).toFixed(3)) : null });
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function local() {
  const B = path.join(__dirname, '..', 'backend', 'services', 'gym-service', 'src', 'battle');
  const { DamageService, TYPES } = require(`${B}/damage`);
  const { normalizeMove, buildCombatant } = require(`${B}/stats`);
  const { ComboDetector } = require(`${B}/combo`);
  const cooldown = require(`${B}/cooldown`);
  const engine = require(`${B}/engine`);
  const ai = require(`${B}/ai`);
  const out = {};

  // 技能与精灵夹具（数值与 moves / pokemon_species 种子一致的子集）
  const rows = [
    ['TACKLE', 'NORMAL', 'FAST', 5, 8, 500, 500], ['EMBER', 'FIRE', 'FAST', 10, 8, 1000, 500], ['WATER_GUN', 'WATER', 'FAST', 5, 8, 1000, 500],
    ['VINE_WHIP', 'GRASS', 'FAST', 7, 8, 800, 500], ['THUNDER_SHOCK', 'ELECTRIC', 'FAST', 6, 8, 900, 500], ['BITE', 'DARK', 'FAST', 6, 8, 900, 500],
    ['FLAMETHROWER', 'FIRE', 'CHARGE', 70, -55, 2500, 1500], ['HYDRO_PUMP', 'WATER', 'CHARGE', 90, -75, 3500, 2300], ['SOLAR_BEAM', 'GRASS', 'CHARGE', 100, -100, 4000, 3000],
    ['THUNDERBOLT', 'ELECTRIC', 'CHARGE', 80, -50, 2500, 1500], ['CRUNCH', 'DARK', 'CHARGE', 80, -45, 2000, 2000], ['ICE_BEAM', 'ICE', 'CHARGE', 90, -55, 3000, 1500],
  ];
  const moves = new Map(rows.map(([id, type, category, power, energy_delta, duration_ms, cooldown_ms]) => [id, normalizeMove({ id, name_zh: id, type, category, power, energy_delta, duration_ms, cooldown_ms })]));
  const species = [[1, 'GRASS', 'POISON', 118, 111, 128, 'VINE_WHIP', 'SOLAR_BEAM'], [4, 'FIRE', null, 116, 93, 118, 'EMBER', 'FLAMETHROWER'],
    [7, 'WATER', null, 94, 121, 127, 'WATER_GUN', 'HYDRO_PUMP'], [25, 'ELECTRIC', null, 112, 96, 111, 'THUNDER_SHOCK', 'THUNDERBOLT'],
    [52, 'NORMAL', null, 92, 78, 120, 'BITE', 'CRUNCH'], [131, 'WATER', 'ICE', 165, 174, 277, 'WATER_GUN', 'ICE_BEAM']];
  const mon = (i, cp, iv = 10) => {
    const [sid, t1, t2, a, d, s, fast, charge] = species[i % species.length];
    return buildCombatant({ id: `p${i}-${cp}-${iv}`, species_id: sid, name_zh: `#${sid}`, type1: t1, type2: t2, base_attack: a, base_defense: d, base_hp: s, cp, iv_attack: iv, iv_defense: iv, iv_hp: iv, fast_move: fast, charge_move: charge }, moves);
  };

  // 预热
  const ds = new DamageService();
  const combos = [...new Set(species.map(([, t1, t2]) => [t1, t2].filter(Boolean).map((x) => x.toLowerCase()).join('/')))].map((x) => x.split('/'));
  let t0 = process.hrtime.bigint();
  const w = await ds.warmup([...moves.values()], combos.length ? combos : TYPES.map((t) => [t]), { loadL2: false });
  out.warmup = { coefficients: w.coefficients, ms: Number(ms(t0).toFixed(2)) };

  // 同配置战斗请求：100 只热门精灵配置 × 10 万次攻击（Zipf 分布，模拟道馆热门对局重复）
  const pool = Array.from({ length: 100 }, (_, i) => mon(i, 500 + (i % 20) * 100, i % 16));
  const zipf = () => Math.min(pool.length - 1, Math.floor(pool.length * Math.random() ** 3));
  const hit = [];
  const miss = [];
  for (let i = 0; i < 100000; i++) {
    const a = pool[zipf()];
    const d = pool[zipf()];
    const m = a.moves[i % a.moves.length];
    t0 = process.hrtime.bigint();
    const r = ds.compute(a, d, m, {});
    (r.cached ? hit : miss).push(ms(t0));
  }
  const st = ds.stats();
  out.damage = {
    typeMatrix: st.typeMatrixSize, typeHitRate: st.typeHitRate, coefficientHitRate: st.coefficientHitRate, l1HitRate: st.l1HitRate,
    hitLatencyMs: summary(hit), missLatencyMs: summary(miss),
  };

  // L1 1 万条实测内存
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const big = new DamageService({ l1Max: 10000 });
  const mv = moves.get('FLAMETHROWER');
  for (let i = 0; i < 10000; i++) big.baseDamage({ attack: 100 + i / 100, types: ['fire'] }, { defense: 90 + (i % 7), types: ['grass', 'poison'] }, mv, null);
  if (global.gc) global.gc();
  out.l1Memory = { entries: big.stats().l1Entries, heapDeltaMb: Number(((process.memoryUsage().heapUsed - before) / 1048576).toFixed(2)), estimateMb: Number((big.stats().l1MemoryBytesEstimate / 1048576).toFixed(2)) };

  // 连击检测 / 冷却计算
  const chainRows = Array.from({ length: 26 }, (_, i) => ({ chain_id: `C${i}`, name: `C${i}`, trigger_sequence: [rows[i % 6][0], rows[(i + 1) % 6][0], rows[6 + (i % 6)][0]], time_window_ms: 5000, damage_multiplier: 1.5, is_active: true, min_trainer_level: 1 }));
  const cd = new ComboDetector(chainRows);
  const det = [];
  const now = Date.now();
  for (let i = 0; i < 20000; i++) {
    const hist = [{ moveId: rows[i % 6][0], at: now - 800, seq: 0 }, { moveId: rows[(i + 1) % 6][0], at: now - 400, seq: 1 }];
    t0 = process.hrtime.bigint();
    cd.detect(hist, rows[6 + (i % 6)][0], { now, seq: 2, attackerTypes: ['fire'], trainerLevel: 50 });
    det.push(ms(t0));
  }
  out.comboDetectMs = summary(det);
  const cdt = [];
  for (let i = 0; i < 20000; i++) {
    t0 = process.hrtime.bigint();
    cooldown.effectiveCooldown(moves.get('HYDRO_PUMP'), { mode: ['PVE', 'PVP', 'RAID', 'TOURNAMENT'][i % 4], mastery: i % 100, comboCount: i % 8, speed: i % 200, equipment: [{ reduction_pct: 10, applies_to: 'ALL' }], weather: 'rainy' });
    cdt.push(ms(t0));
  }
  out.cooldownCalcMs = summary(cdt);

  // 回合引擎 + AI
  const deps = { damage: ds, combos: cd };
  const turns = [];
  const advise = [];
  const predict = [];
  let battles = 0;
  for (let b = 0; b < 30; b++) {
    const state = engine.createBattle({ id: `bench-${b}`, userId: 'u', seed: b + 1, attackerTeam: [mon(b, 1500), mon(b + 1, 1400), mon(b + 2, 1300)], defenderTeam: [mon(b + 3, 1200), mon(b + 4, 1200)] });
    let t = Date.now();
    t0 = process.hrtime.bigint();
    ai.predict(state, deps, { simulations: 24 });
    predict.push(ms(t0));
    let guard = 0;
    while (state.status === 'active' && guard++ < 200) {
      t0 = process.hrtime.bigint();
      const a = ai.adviseMove(state, deps, { variant: 'A' });
      advise.push(ms(t0));
      t0 = process.hrtime.bigint();
      if (a.best && a.best.action === 'switch') engine.switchActive(state, a.best.pokemonId, { now: (t += 1000) }, deps);
      else engine.playTurn(state, { moveId: a.best ? a.best.moveId : engine.availableMoves(state).find((m) => m.ready).id, now: (t += 1000) }, deps);
      turns.push(ms(t0));
    }
    battles++;
  }
  out.engineTurnMs = summary(turns);
  out.aiAdviceMs = summary(advise);
  out.aiPredictMs = summary(predict);
  const cands = Array.from({ length: 40 }, (_, i) => mon(i, 800 + i * 30, i % 16));
  const defs = Array.from({ length: 6 }, (_, i) => mon(i + 2, 1500));
  t0 = process.hrtime.bigint();
  ai.optimizeLineup(cands, defs, deps, { size: 6 });
  out.aiLineupMs = Number(ms(t0).toFixed(2));
  out.battlesSimulated = battles;
  return out;
}

async function gateway() {
  const H = require('./lib/smoke-helpers');
  const crypto = require('crypto');
  const battlesN = Number(arg('battles', 20));
  const conc = Number(arg('concurrency', 5));
  const db = H.getDb();
  const lat = 30 + crypto.randomInt(0, 90000) / 1e5;
  const lng = 120 + crypto.randomInt(0, 90000) / 1e5;
  const tm = { turn: [], energy: [], reco: [], advice: [], raid: [] };
  const timed = async (bucket, fn) => { const t = Date.now(); const r = await fn(); tm[bucket].push(Date.now() - t); return r; };
  const d = (r) => (r.body && r.body.data) || {};

  async function oneBattle(k) {
    const { rows: [g] } = await db.query(`INSERT INTO gyms (name, lat, lng, location) VALUES ($1, $2::numeric, $3::numeric,
      ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography) RETURNING id`, [`压测道馆${k}`, lat + k * 1e-4, lng]);
    const def = await H.newUser('bd');
    const att = await H.newUser('ba');
    for (const [u, team] of [[def, 'MYSTIC'], [att, 'VALOR']]) {
      await H.call('POST', '/v1/users/team', { token: u.token, body: { team } });
      await H.call('POST', '/v1/location', { token: u.token, body: { lat: lat + k * 1e-4, lng, accuracy: 10 } });
    }
    const give = async (uid, sid, cp, f, c) => (await db.query(`INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, fast_move, charge_move)
      VALUES ($1,$2,$3,100,100,12,12,12,$4,$5) RETURNING id`, [uid, sid, cp, f, c])).rows[0].id;
    const dp = await give(def.userId, 7, 1200, 'WATER_GUN', 'HYDRO_PUMP');
    const ap = [await give(att.userId, 6, 1800, 'EMBER', 'FLAMETHROWER'), await give(att.userId, 25, 1500, 'THUNDER_SHOCK', 'THUNDERBOLT')];
    await H.call('POST', `/v1/gyms/${g.id}/defend`, { token: def.token, body: { pokemonId: dp } });
    const start = await H.call('POST', `/v1/gyms/${g.id}/battle/start`, { token: att.token, body: { pokemonIds: ap } });
    const id = d(start).battleId;
    if (!id) return;
    await timed('energy', () => H.call('GET', `/api/pokemon/${ap[0]}/energy`, { token: att.token }));
    await timed('reco', () => H.call('GET', '/api/v1/pokemon/6/move-recommendations', { token: att.token }));
    await timed('advice', () => H.call('GET', `/v1/gyms/battles/${id}/advice`, { token: att.token }));
    for (let i = 0; i < 150; i++) {
      const r = await timed('turn', () => H.call('POST', `/v1/gyms/battles/${id}/turn`, { token: att.token, body: { useAdvice: true } }));
      if (r.status !== 200 || d(r).result) break;
    }
  }
  const t0 = Date.now();
  for (let i = 0; i < battlesN; i += conc) {
    await Promise.all(Array.from({ length: Math.min(conc, battlesN - i) }, (_, j) => oneBattle(i + j).catch((e) => console.error(e.message))));
  }
  const out = { battles: battlesN, concurrency: conc, seconds: (Date.now() - t0) / 1000 };
  for (const [k, v] of Object.entries(tm)) if (v.length) out[`${k}Ms`] = summary(v);
  if (H.getRedis) { try { (await H.getRedis()).disconnect(); } catch { /* ignore */ } }
  await db.end();
  return out;
}

(async () => {
  const res = args.includes('--local') ? await local() : await gateway();
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
