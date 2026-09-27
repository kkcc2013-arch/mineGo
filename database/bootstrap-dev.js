#!/usr/bin/env node
/**
 * Dev/test database bootstrap for mineGo.
 *
 * Why: migrations live in two directories (database/pending, database/migrations)
 * with four naming conventions, overlapping files and ordering bugs, so
 * `migrate.js up` stops at the first broken file. This tool converges a fresh
 * database instead: it applies V1 schema + V2 seed, then every SQL/JS migration
 * in its own transaction, repeating passes until no more files succeed. Files
 * that still fail are reported (and written to database/bootstrap-report.json)
 * so they can be fixed one by one.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node database/bootstrap-dev.js [--report]
 *
 * Never run against production: it is idempotent-ish but not a migration log.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Pool;
try { ({ Pool } = require('pg')); }
catch { ({ Pool } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'))); }

const ROOT = __dirname;
const MAX_PASSES = 8;

function upSection(sql) {
  if (!/--\s*migrate:(up|down)/.test(sql)) return sql;
  const up = sql.match(/--\s*migrate:up\s*\n([\s\S]*?)(?=--\s*migrate:down|$)/);
  if (up) return up[1];
  const before = sql.match(/^([\s\S]*?)(?=--\s*migrate:down)/);
  return before ? before[1] : sql;
}

function collectFiles() {
  const list = [];
  for (const dir of ['pending', 'migrations']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (f.startsWith('V1__')) continue; // applied first explicitly
      if (f.endsWith('.sql') || f.endsWith('.js')) list.push(path.join(abs, f));
    }
  }
  // de-duplicate identical files that exist in both directories
  const seen = new Map();
  for (const p of list) {
    const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    if (!seen.has(h)) seen.set(h, p);
  }
  return [...seen.values()];
}

async function applyOne(pool, file) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '20s'; SET LOCAL lock_timeout = '5s'");
    if (file.endsWith('.js')) {
      const mod = require(file);
      const up = mod.up || (mod.default && mod.default.up);
      if (typeof up !== 'function') throw new Error('no exports.up');
      await Promise.race([
        up(client, client),
        new Promise((_, rej) => setTimeout(() => rej(new Error('js migration timed out (20s)')), 20000)),
      ]);
    } else {
      await client.query(upSection(fs.readFileSync(file, 'utf8')));
    }
    await client.query('COMMIT');
    return null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return e.message.split('\n')[0];
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis').catch(() => {});
  await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"').catch(() => {});
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});

  const hasUsers = (await pool.query("SELECT to_regclass('public.users') AS t")).rows[0].t;
  if (!hasUsers) {
    const err = await applyOne(pool, path.join(ROOT, 'migrations', 'V1__initial_schema.sql'));
    if (err) throw new Error(`V1 schema failed: ${err}`);
    const seedErr = await applyOne(pool, path.join(ROOT, 'seeds', 'V2__seed_data.sql'));
    console.log(seedErr ? `seed: FAILED ${seedErr}` : 'seed: ok');
  }

  let pending = collectFiles();
  const applied = [];
  let failures = new Map();
  for (let pass = 1; pass <= MAX_PASSES && pending.length; pass++) {
    const next = [];
    failures = new Map();
    for (const f of pending) {
      if (process.env.BOOTSTRAP_VERBOSE) console.log(`  -> ${path.relative(ROOT, f)}`);
      const err = await applyOne(pool, f);
      if (err) { next.push(f); failures.set(f, err); } else applied.push(f);
    }
    console.log(`pass ${pass}: applied ${pending.length - next.length}, remaining ${next.length}`);
    if (next.length === pending.length) break;
    pending = next;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    applied: applied.length,
    failed: [...failures].map(([f, e]) => ({ file: path.relative(ROOT, f), error: e })),
  };
  if (process.argv.includes('--report')) {
    fs.writeFileSync(path.join(ROOT, 'bootstrap-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`applied=${report.applied} failed=${report.failed.length}`);
  for (const x of report.failed) console.log(`  FAIL ${x.file}: ${x.error}`);
  await pool.end();
  process.exit(report.failed.length ? 2 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
