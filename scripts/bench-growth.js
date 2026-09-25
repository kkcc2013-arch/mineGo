#!/usr/bin/env node
/**
 * Epic E07 精灵成长接口压测（经网关），输出每个接口的 P50/P95/最大延迟与错误数
 *
 *   BASE_URL=http://127.0.0.1:8080 N=200 C=20 BREED_C=1000 node scripts/bench-growth.js
 *
 *   N        每个接口请求总数（默认 200）
 *   C        并发数（默认 20）
 *   BREED_C  培育配对检查的并发请求数（REQ-00276 "1000 并发培育请求"，默认 1000）
 * 依赖 scripts/lib/smoke-helpers.js（造测试账号与夹具，读 .env 推导 DATABASE_URL / REDIS_URL）
 * 对照需求：体力批量查询 < 100ms（REQ-00172）；成长轨迹 P95 < 200ms（REQ-00230）；培育 < 200ms（REQ-00276）；
 *          合并 < 500ms（REQ-00390）；特训队列 < 100ms、开始/完成 < 200ms（REQ-00612）
 */
'use strict';

const { call, newUser, getDb, finish, record } = require('./lib/smoke-helpers');

const N = Number(process.env.N || 200);
const C = Number(process.env.C || 20);
const BREED_C = Number(process.env.BREED_C || 1000);

async function bench(name, n, c, fn, targetMs) {
  const times = [];
  let errors = 0;
  let i = 0;
  const worker = async () => {
    while (i < n) {
      i++;
      const t0 = process.hrtime.bigint();
      const r = await fn().catch(() => ({ status: 0 }));
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (!(r.status >= 200 && r.status < 300)) errors++;
    }
  };
  await Promise.all(Array.from({ length: c }, worker));
  times.sort((a, b) => a - b);
  const p = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
  const res = { p50: p(0.5), p95: p(0.95), max: Math.round(times[times.length - 1]), errors };
  record(`${name}（n=${n} c=${c}）P95 ${res.p95}ms${targetMs ? ` 目标 < ${targetMs}ms` : ''}`, (!targetMs || res.p95 < targetMs) && errors === 0,
    `p50=${res.p50} p95=${res.p95} max=${res.max} errors=${errors}`);
  return res;
}

(async () => {
  const u = await newUser('bench');
  const db = getDb();
  const { rows } = await db.query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, friendship)
     SELECT $1, CASE WHEN g % 2 = 0 THEN 1 ELSE 4 END, 800, 600, 600, g % 16, (g * 7) % 16, (g * 3) % 16, 120 FROM generate_series(1, 100) g
     RETURNING id, species_id`, [u.userId]);
  const ids = rows.map((r) => r.id);
  const bulb = rows.filter((r) => r.species_id === 1).map((r) => r.id);
  const charm = rows.filter((r) => r.species_id === 4).map((r) => r.id);
  const tok = { token: u.token };

  await bench('体力批量查询 100 只', N, C, () => call('POST', '/v1/pokemon/stamina/batch', { ...tok, body: { pokemonIds: ids } }), 100);
  await bench('成长轨迹 30 天', N, C, () => call('GET', `/v1/pokemon/${ids[0]}/growth/trajectory?days=30`, tok), 200);
  await bench('经验历史', N, C, () => call('GET', `/v1/pokemon/${ids[0]}/exp-history?limit=20`, tok), 200);
  await bench('进化检查', N, C, () => call('GET', `/v1/pokemon/${ids[0]}/evolution/check`, tok), 200);
  await bench('进化树', N, C, () => call('GET', '/v1/pokemon/species/133/evolution-chain', tok), 200);
  await bench('特训队列', N, C, () => call('GET', '/v1/pokemon/special-training/queue', tok), 100);
  const recipes = await call('GET', '/v1/pokemon/merge/recipes', tok);
  const trio = (recipes.data || []).find((r) => r.code === 'bulbasaur_trio');
  await bench('合并预览', N, C, () => call('POST', '/v1/pokemon/merge/preview', { ...tok, body: { recipeId: trio && trio.recipeId, pokemonIds: bulb.slice(0, 3) } }), 500);
  let k = 0;
  await bench(`培育配对检查 ${BREED_C} 并发`, BREED_C, BREED_C, () => {
    const m = bulb[k % bulb.length];
    const f = charm[k++ % charm.length];
    return call('POST', '/v1/pokemon/breeding/check', { ...tok, body: { motherId: m, fatherId: f } });
  }, 200);
  await finish();
})().catch(async (err) => { record('执行异常', false, err.message); await finish(); });
