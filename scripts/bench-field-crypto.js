#!/usr/bin/env node
/**
 * REQ-00565 性能验收：字段加密开销实测
 *
 *   1. 单条加/解密延迟（目标 < 1ms，统计 p50/p99）
 *   2. 批量 100 条解密总耗时（目标 < 50ms）
 *   3. 内存：10 万次加解密后，GC 后的堆内存（retained heap）增量（目标 < 10%；RSS 为分配器高水位，仅供参考）
 *   4. 查询：10 万用户下"盲索引列等值查询"与"明文唯一索引等值查询"的数据库耗时对比（目标开销 ≤ 10%），
 *      另报告含 HMAC 计算与解密的端到端耗时（绝对值，微秒级）
 *      需要 DATABASE_URL；在临时表上进行，不影响业务表
 *
 * 用法：DATABASE_URL=... FIELD_ENCRYPTION_KEYS=... FIELD_ENCRYPTION_ACTIVE_KID=... FIELD_HASH_KEY=... \
 *        node scripts/bench-field-crypto.js [--rows 100000] [--lookups 3000]
 * 未配置密钥时使用随机测试密钥。结果以 JSON 输出，不达标退出码 1。
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

if (!process.env.FIELD_ENCRYPTION_KEYS) {
  process.env.FIELD_ENCRYPTION_KEYS = `bench:${crypto.randomBytes(32).toString('hex')}`;
  process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'bench';
  process.env.FIELD_HASH_KEY = crypto.randomBytes(32).toString('hex');
}
const fc = require('../backend/shared/fieldCrypto');

const args = process.argv.slice(2);
const argN = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const ROWS = argN('--rows', 100000);
const LOOKUPS = argN('--lookups', 3000);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const ms = (ns) => Number(ns) / 1e6;

function benchCrypto() {
  const enc = []; const dec = [];
  const phone = () => `138${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
  for (let i = 0; i < 2000; i++) fc.decrypt(fc.encrypt(phone(), 'users.phone'), 'users.phone'); // 预热
  for (let i = 0; i < 20000; i++) {
    const p = phone();
    let t = process.hrtime.bigint(); const c = fc.encrypt(p, 'users.phone'); enc.push(ms(process.hrtime.bigint() - t));
    t = process.hrtime.bigint(); fc.decrypt(c, 'users.phone'); dec.push(ms(process.hrtime.bigint() - t));
  }
  const batch = Array.from({ length: 100 }, () => fc.encrypt(phone(), 'users.phone'));
  const runs = [];
  for (let r = 0; r < 200; r++) {
    const t = process.hrtime.bigint();
    for (const c of batch) fc.decrypt(c, 'users.phone');
    runs.push(ms(process.hrtime.bigint() - t));
  }
  if (global.gc) global.gc();
  const m0 = process.memoryUsage();
  for (let i = 0; i < 100000; i++) fc.decrypt(fc.encrypt(phone(), 'users.phone'), 'users.phone');
  if (global.gc) { global.gc(); global.gc(); }
  const m1 = process.memoryUsage();
  return {
    encrypt: { p50: pct(enc, 50), p99: pct(enc, 99) },
    decrypt: { p50: pct(dec, 50), p99: pct(dec, 99) },
    batch100Decrypt: { p50: pct(runs, 50), p99: pct(runs, 99) },
    heapIncreasePct: ((m1.heapUsed - m0.heapUsed) / m0.heapUsed) * 100,
    rssIncreasePct: ((m1.rss - m0.rss) / m0.rss) * 100,
    gcExposed: !!global.gc,
  };
}

async function benchQuery() {
  if (!process.env.DATABASE_URL) return null;
  const { Client } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE bench_users (
      id SERIAL PRIMARY KEY, phone_plain VARCHAR(20) UNIQUE, phone_enc TEXT, phone_hash VARCHAR(64) UNIQUE)`);
    const phones = [];
    for (let off = 0; off < ROWS; off += 5000) {
      const vals = []; const params = [];
      for (let i = 0; i < Math.min(5000, ROWS - off); i++) {
        const p = `139${String(off + i).padStart(8, '0')}`;
        phones.push(p);
        params.push(p, fc.encrypt(p, 'users.phone'), fc.blindIndex(p, 'users.phone'));
        vals.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
      }
      await client.query(`INSERT INTO bench_users (phone_plain, phone_enc, phone_hash) VALUES ${vals.join(',')}`, params);
    }
    await client.query('ANALYZE bench_users');
    const pick = () => phones[crypto.randomInt(0, phones.length)];
    const plain = []; const blind = [];
    for (let i = 0; i < 300; i++) { // 预热
      await client.query('SELECT id FROM bench_users WHERE phone_plain = $1', [pick()]);
      await client.query('SELECT id FROM bench_users WHERE phone_hash = $1', [fc.blindIndex(pick(), 'users.phone')]);
    }
    // 交替执行，抵消缓存/负载波动；分别计时：数据库查询本身、以及含 HMAC + 解密的端到端
    const blindQuery = [];
    for (let i = 0; i < LOOKUPS; i++) {
      const p = pick();
      let t = process.hrtime.bigint();
      const a = await client.query('SELECT id, phone_plain FROM bench_users WHERE phone_plain = $1', [p]);
      plain.push(ms(process.hrtime.bigint() - t));
      const t0 = process.hrtime.bigint();
      const h = fc.blindIndex(p, 'users.phone');
      t = process.hrtime.bigint();
      const b = await client.query('SELECT id, phone_enc FROM bench_users WHERE phone_hash = $1', [h]);
      blindQuery.push(ms(process.hrtime.bigint() - t));
      if (fc.decrypt(b.rows[0].phone_enc, 'users.phone') !== a.rows[0].phone_plain) throw new Error('decrypt mismatch');
      blind.push(ms(process.hrtime.bigint() - t0));
    }
    const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
    return {
      rows: ROWS, lookups: LOOKUPS,
      plaintext: { mean: mean(plain), p50: pct(plain, 50), p95: pct(plain, 95) },
      blindIndexQuery: { mean: mean(blindQuery), p50: pct(blindQuery, 50), p95: pct(blindQuery, 95) },
      blindIndexPlusCrypto: { mean: mean(blind), p50: pct(blind, 50), p95: pct(blind, 95) },
      queryOverheadPct: ((mean(blindQuery) - mean(plain)) / mean(plain)) * 100,
      cryptoAddedMicros: (mean(blind) - mean(blindQuery)) * 1000,
    };
  } finally {
    await client.end();
  }
}

(async () => {
  const cryptoRes = benchCrypto();
  const queryRes = await benchQuery();
  const checks = {
    singleOpUnder1ms: cryptoRes.encrypt.p99 < 1 && cryptoRes.decrypt.p99 < 1,
    batch100Under50ms: cryptoRes.batch100Decrypt.p99 < 50,
    memoryIncreaseUnder10pct: cryptoRes.heapIncreasePct < 10,
    queryOverheadAtMost10pct: queryRes ? queryRes.queryOverheadPct <= 10 : null,
  };
  console.log(JSON.stringify({ crypto: cryptoRes, query: queryRes, checks }, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 2));
  process.exit(Object.values(checks).some((v) => v === false) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
