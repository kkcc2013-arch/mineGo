#!/usr/bin/env node
/**
 * REQ-00476：关键接口性能基准 + 预算门禁 + 回归检测
 *
 *   node scripts/bench-api-performance.js [--requests 100] [--concurrency 10] [--baseline config/performance-baseline.json]
 *                                  [--gate] [--update-baseline] [--record-db] [--out report.json]
 *
 * - 经网关压测 config/performance-budget.yaml 中的 P0/P1 接口（自动注册测试用户、写入测试精灵）
 * - 每个接口：预热 5 次 → N 次请求（并发 C）→ P50/P95/P99/MAX/错误率/吞吐
 * - 与预算比较（checkAgainstBudget）、与基线比较（detectRegression：P99 增长 > 20% 视为退化）
 * - --gate：超预算（strict 或 P95）或退化时退出码 1（CI 门禁）
 * - --record-db：结果写 api_performance_test_results；--update-baseline 同时写 api_performance_baselines 与基线文件
 * - 请求带随机 X-Forwarded-For（经本机代理可信），避免网关按 IP 的全局限流干扰测量
 */
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./lib/testUser');
const perf = require(path.join(T.ROOT, 'backend', 'shared', 'apiStandards', 'performanceBudget'));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function runEndpoint(ep, { requests, concurrency }) {
  for (let i = 0; i < 5; i++) await ep.run(i).catch(() => {});
  const lat = [];
  let errors = 0;
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = next++;
      if (i >= requests) return;
      try {
        const r = await ep.run(i);
        lat.push(r.ms);
        if (r.status >= 400) errors++;
      } catch { errors++; }
    }
  }));
  const s = perf.stats(lat);
  const round = (x) => (x === null ? null : +x.toFixed(2));
  return { route: ep.route, requests, concurrency, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), max: round(s.max), avg: round(s.avg), errorRate: +(errors / requests).toFixed(4), rps: +(requests / ((Date.now() - t0) / 1000)).toFixed(1) };
}

async function main() {
  const requests = Number(arg('requests', 100));
  const concurrency = Number(arg('concurrency', 10));
  const baselineFile = path.resolve(T.ROOT, arg('baseline', 'config/performance-baseline.json'));
  const redis = T.redisClient();
  await redis.connect();
  const pg = T.pgClient();
  await pg.connect();
  const user = await T.registerUser(redis, { prefix: 'bench' });
  const ids = await T.seedPokemon(pg, user.userId, 60);
  const token = user.token;
  const lat = 31.2398, lng = 121.5014;
  const ip = () => T.randomIp();
  const get = (url) => () => T.call('GET', url, { token, ip: ip() });
  const endpoints = [
    { route: 'GET /v1/users/me', run: get('/v1/users/me') },
    { route: 'GET /v1/pokemon/my', run: get('/v1/pokemon/my?pageSize=20') },
    { route: 'GET /v1/pokemon/my/:id', run: (i) => T.call('GET', `/v1/pokemon/my/${ids[i % ids.length]}`, { token, ip: ip() }) },
    { route: 'GET /v1/pokemon/species', run: get('/v1/pokemon/species?pageSize=50') },
    { route: 'GET /v1/map/nearby', run: get(`/v1/map/nearby?lat=${lat}&lng=${lng}&radius=1000`) },
    { route: 'POST /v1/location', run: () => T.call('POST', '/v1/location', { token, ip: ip(), body: { lat: lat + (Math.random() - 0.5) * 0.00002, lng: lng + (Math.random() - 0.5) * 0.00002, accuracy: 10 } }) },
    { route: 'GET /v1/rewards/daily', run: get('/v1/rewards/daily') },
    { route: 'POST /v1/pokemon/batch/details', run: (i) => T.call('POST', '/v1/pokemon/batch/details', { token, ip: ip(), body: { ids: ids.slice(i % 40, (i % 40) + 20), include: ['skills', 'battle'] } }) },
    { route: 'POST /api/v1/batch', run: () => T.call('POST', '/api/v1/batch', { token, ip: ip(), body: { requests: [{ path: '/v1/users/me' }, { path: '/v1/rewards/daily' }, { path: '/v1/pokemon/my?pageSize=5' }] } }) },
  ];
  const results = {};
  for (const ep of endpoints) {
    results[ep.route] = await runEndpoint(ep, { requests, concurrency });
    console.error(`  ${ep.route.padEnd(34)} p50=${results[ep.route].p50}ms p95=${results[ep.route].p95}ms p99=${results[ep.route].p99}ms err=${results[ep.route].errorRate}`);
  }
  const cfg = perf.loadConfigFile();
  const budget = perf.checkAgainstBudget(cfg, results);
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')).results : null;
  const regression = baseline ? perf.detectRegression(baseline, results, cfg.regressionThresholds) : { regressions: [], passed: true, note: 'no baseline' };
  const report = { generatedAt: new Date().toISOString(), requests, concurrency, results, budget, regression, passed: budget.passed && regression.passed };

  if (arg('record-db', false)) {
    for (const [route, r] of Object.entries(results)) {
      const bf = budget.failures.filter((f) => f.route === route);
      await pg.query(`INSERT INTO api_performance_test_results (endpoint, test_type, metrics, analysis_result, passed) VALUES ($1, 'benchmark', $2, $3, $4)`,
        [route, JSON.stringify(r), JSON.stringify({ budgetFailures: bf, regressions: regression.regressions.filter((x) => x.route === route) }), !bf.length]);
      if (arg('update-baseline', false)) {
        await pg.query(`INSERT INTO api_performance_baselines (endpoint, avg_response_time, median_response_time, p95_response_time, p99_response_time, error_rate, throughput, sample_count, last_updated)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`, [route, r.avg, r.p50, r.p95, r.p99, r.errorRate, r.rps, requests]);
      }
    }
  }
  if (arg('update-baseline', false)) {
    fs.writeFileSync(baselineFile, `${JSON.stringify({ generatedAt: report.generatedAt, requests, concurrency, results }, null, 2)}\n`);
    console.error(`基线已写入 ${path.relative(T.ROOT, baselineFile)}`);
  }
  const out = arg('out', null);
  if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  await pg.query('DELETE FROM pokemon_instances WHERE user_id = $1', [user.userId]).catch(() => {});
  await pg.end();
  await redis.quit();
  return arg('gate', false) && !report.passed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 2; });
