#!/usr/bin/env node
/**
 * REQ-00565: users.phone 加密回填 / 密钥轮换（可重复执行）
 *
 *   node scripts/encrypt-user-phones.js            # 明文行 → 密文 + 盲索引
 *   node scripts/encrypt-user-phones.js --rotate   # 另外把非当前 kid 的密文重新加密到当前 kid
 *   node scripts/encrypt-user-phones.js --dry-run  # 只统计不写入
 *   node scripts/encrypt-user-phones.js --verify   # 抽查：所有行可解密且盲索引匹配
 *
 * 读取仓库根目录 .env（DATABASE_URL 或 POSTGRES_*，FIELD_ENCRYPTION_KEYS / FIELD_ENCRYPTION_ACTIVE_KID / FIELD_HASH_KEY）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { Pool } = require(path.join(ROOT, 'backend', 'node_modules', 'pg'));
const fieldCrypto = require(path.join(ROOT, 'backend', 'shared', 'fieldCrypto'));

const CTX = 'users.phone';
const BATCH = Number(process.env.MIGRATION_BATCH_SIZE || 200);
const args = new Set(process.argv.slice(2));

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  return `postgres://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD || '')}@${e.POSTGRES_HOST || '127.0.0.1'}:${e.POSTGRES_PORT || 5432}/${e.POSTGRES_DB}`;
}

async function main() {
  if (!fieldCrypto.isEnabled()) {
    console.error('FIELD_ENCRYPTION_KEYS / FIELD_ENCRYPTION_ACTIVE_KID / FIELD_HASH_KEY 未配置，退出');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl(), max: 2 });
  const active = fieldCrypto.activeKeyId();
  const stats = { scanned: 0, encrypted: 0, rotated: 0, hashed: 0, errors: 0, verifyFailed: 0 };

  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, phone, phone_hash FROM users WHERE phone IS NOT NULL AND id > $1 ORDER BY id LIMIT $2`,
      [lastId, BATCH]);
    if (!rows.length) break;
    for (const r of rows) {
      lastId = r.id;
      stats.scanned++;
      try {
        const plain = fieldCrypto.decrypt(r.phone, CTX);
        const hash = fieldCrypto.blindIndex(plain, CTX);
        if (args.has('--verify')) {
          if (!fieldCrypto.isEncrypted(r.phone) || r.phone_hash !== hash) stats.verifyFailed++;
          continue;
        }
        const needEncrypt = !fieldCrypto.isEncrypted(r.phone);
        const needRotate = !needEncrypt && args.has('--rotate') && fieldCrypto.keyIdOf(r.phone) !== active;
        const needHash = r.phone_hash !== hash;
        if (!needEncrypt && !needRotate && !needHash) continue;
        const cipher = needEncrypt || needRotate ? fieldCrypto.encrypt(plain, CTX) : r.phone;
        if (!args.has('--dry-run')) {
          await pool.query('UPDATE users SET phone = $2, phone_hash = $3 WHERE id = $1 AND phone = $4',
            [r.id, cipher, hash, r.phone]);
        }
        if (needEncrypt) stats.encrypted++;
        if (needRotate) stats.rotated++;
        if (needHash) stats.hashed++;
      } catch (err) {
        stats.errors++;
        console.error(`user ${r.id}: ${err.message}`);
      }
    }
  }
  await pool.end();
  console.log(JSON.stringify({ activeKid: active, dryRun: args.has('--dry-run'), ...stats }));
  process.exit(stats.errors || stats.verifyFailed ? 2 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
