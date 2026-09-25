#!/usr/bin/env node
/**
 * REQ-00565：生成字段加密的"加密密钥文件"（供 FIELD_KEYS_FILE 使用，替代把密钥明文放在 .env）
 *
 *   FIELD_KEYS_FILE_PASSPHRASE=<口令> node scripts/field-keys-file.js --out /etc/minego/field-keys.json \
 *     [--from-env]            # 从当前 FIELD_ENCRYPTION_KEYS / ACTIVE_KID / FIELD_HASH_KEY 迁移
 *     [--add-kid k2]          # 追加一个新 kid（随机生成）并设为 active，用于密钥轮换
 *
 * 口令建议来自部署平台的机密存储，文件权限 600。服务启动时由 shared/fieldKeyProvider 解密加载。
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { sealKeyFile, openKeyFile } = require('../backend/shared/fieldKeyProvider');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const out = arg('--out');
const pass = process.env.FIELD_KEYS_FILE_PASSPHRASE;
if (!out || !pass) {
  console.error('用法：FIELD_KEYS_FILE_PASSPHRASE=... node scripts/field-keys-file.js --out <file> [--from-env] [--add-kid <kid>]');
  process.exit(2);
}
let m;
if (fs.existsSync(out)) m = openKeyFile(fs.readFileSync(out, 'utf8'), pass);
else if (args.includes('--from-env')) {
  m = { keys: process.env.FIELD_ENCRYPTION_KEYS, activeKid: process.env.FIELD_ENCRYPTION_ACTIVE_KID, hashKey: process.env.FIELD_HASH_KEY };
} else {
  m = { keys: `k1:${crypto.randomBytes(32).toString('hex')}`, activeKid: 'k1', hashKey: crypto.randomBytes(32).toString('hex') };
}
const newKid = arg('--add-kid');
if (newKid) {
  m.keys = `${m.keys},${newKid}:${crypto.randomBytes(32).toString('hex')}`;
  m.activeKid = newKid;
}
if (!m.keys || !m.hashKey) { console.error('密钥不完整'); process.exit(1); }
fs.writeFileSync(out, sealKeyFile(m, pass), { mode: 0o600 });
console.log(`已写入 ${out}：kids=${m.keys.split(',').map((s) => s.split(':')[0]).join(',')} active=${m.activeKid}`);
