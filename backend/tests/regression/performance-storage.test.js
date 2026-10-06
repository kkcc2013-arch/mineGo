'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Pool} = require('pg');
const Redis = require('ioredis');
const express = require('express');
const Tester = require('./shared/performanceRegressionTester');
const Manager = require('./shared/performanceBaselineManager');

test('performance storage, cache, trend and 90-day retention against real PostgreSQL and Redis', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  assert.ok(process.env.TEST_REDIS_URL, 'TEST_REDIS_URL is required');
  const schema = `perf_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`});
  const redis = new Redis(process.env.TEST_REDIS_URL);
  const endpoint = `GET /test/${schema}`;
  const cacheKey = `perf:baseline:${endpoint.replace(/\s+/g, ':')}`;
  try {
    await db.query(await fs.readFile(path.resolve(__dirname, '../../../database/migrations/20260708_010800_performance_regression_tables.sql'), 'utf8'));
    assert.equal((await db.query('SELECT COUNT(*) FROM api_performance_baselines')).rows[0].count, '0', 'migration must not seed fabricated baselines');
    const app = express(); app.get(`/test/${schema}`, (_req, res) => res.json({ok: true}));
    const tester = new Tester(db, redis, {warmupIterations: 0});
    const first = await tester.runTest(endpoint, {app, iterations: 10, concurrency: 2});
    assert.equal(first.passed, false, 'missing baseline must remain unverified');
    const manager = new Manager(db, redis);
    await manager.forceUpdateBaseline(endpoint, {...first.performance, errorRate: 0, stdDev: 0});
    const baseline = await tester._getBaseline(endpoint);
    assert.equal(baseline.errorRate, 0);
    assert.equal(baseline.sampleCount, 10);
    assert.ok(await redis.ttl(cacheKey) > 0, 'baseline cache must have a TTL');
    assert.deepEqual(await tester._getBaseline(endpoint), JSON.parse(await redis.get(cacheKey)));
    assert.equal((await manager.getBaselineSummary()).length, 1);
    assert.equal((await manager.getPerformanceTrend(endpoint)).data.length, 1);
    assert.equal((await manager.getRegressionHistory(endpoint)).length, 1);
    await db.query("UPDATE api_performance_test_results SET created_at = NOW() - INTERVAL '91 days'");
    await tester._storeTestResult(endpoint, first.performance, first.analysis);
    const cleaned = await manager.cleanupOldData();
    assert.equal(cleaned.deleted, 1);
    assert.equal((await db.query('SELECT COUNT(*) FROM api_performance_test_results')).rows[0].count, '1');
    await assert.rejects(manager.cleanupOldData(1), /at least 90 days/);
    const malicious = "1'; DROP TABLE api_performance_baselines; --";
    await assert.rejects(manager.getPerformanceTrend(endpoint, malicious));
    assert.equal((await manager.getBaselineSummary()).length, 1);
  } finally {
    await redis.del(cacheKey); redis.disconnect();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
