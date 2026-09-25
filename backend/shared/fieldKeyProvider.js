/**
 * REQ-00565：字段加密密钥来源
 *
 * 按优先级加载一次（服务启动时 await initFieldKeys()），结果写回进程内配置供 fieldCrypto 使用：
 *   1. HashiCorp Vault KV v2：VAULT_ADDR + VAULT_TOKEN + FIELD_KEYS_VAULT_PATH（如 secret/data/minego/field-keys），
 *      secret 中的字段：keys（"kid:hex,kid:hex"）、active_kid、hash_key
 *   2. 加密密钥文件：FIELD_KEYS_FILE（JSON，由 scripts/field-keys-file.js 生成），用 FIELD_KEYS_FILE_PASSPHRASE
 *      经 scrypt 派生的密钥做 AES-256-GCM 解密；文件内容同上三个字段
 *   3. 环境变量：FIELD_ENCRYPTION_KEYS / FIELD_ENCRYPTION_ACTIVE_KID / FIELD_HASH_KEY（兼容原配置）
 *
 * 每次加载都写审计记录（来源、kid 列表、结果；不含任何密钥材料）：日志 + audit_logs（action=field_keys.load）。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const FILE_MAGIC = 'minego-field-keys:v1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let loaded = null; // { source, keys, activeKid, hashKey, loadedAt }

function deriveFileKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

/** 生成加密密钥文件内容（供脚本与测试使用） */
function sealKeyFile({ keys, activeKid, hashKey }, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveFileKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(FILE_MAGIC));
  const body = JSON.stringify({ keys, active_kid: activeKid, hash_key: hashKey });
  const ct = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  return JSON.stringify({
    magic: FILE_MAGIC,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ct.toString('base64'),
  }, null, 2);
}

function openKeyFile(content, passphrase) {
  const f = JSON.parse(content);
  if (f.magic !== FILE_MAGIC) throw new Error('FIELD_KEYS_FILE 格式不正确');
  const decipher = crypto.createDecipheriv('aes-256-gcm',
    deriveFileKey(passphrase, Buffer.from(f.salt, 'base64')), Buffer.from(f.iv, 'base64'));
  decipher.setAAD(Buffer.from(FILE_MAGIC));
  decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
  const body = Buffer.concat([decipher.update(Buffer.from(f.data, 'base64')), decipher.final()]).toString('utf8');
  const j = JSON.parse(body);
  return { keys: j.keys, activeKid: j.active_kid, hashKey: j.hash_key };
}

async function loadFromVault(env) {
  const url = `${env.VAULT_ADDR.replace(/\/$/, '')}/v1/${env.FIELD_KEYS_VAULT_PATH.replace(/^\//, '')}`;
  const res = await fetch(url, {
    headers: { 'X-Vault-Token': env.VAULT_TOKEN, ...(env.VAULT_NAMESPACE ? { 'X-Vault-Namespace': env.VAULT_NAMESPACE } : {}) },
    signal: AbortSignal.timeout(Number(env.VAULT_TIMEOUT_MS || 5000)),
  });
  if (!res.ok) throw new Error(`Vault 读取失败：HTTP ${res.status}`);
  const body = await res.json();
  const d = (body.data && body.data.data) || body.data || {}; // KV v2: data.data；KV v1: data
  if (!d.keys || !d.hash_key) throw new Error('Vault secret 缺少 keys / hash_key 字段');
  return { keys: d.keys, activeKid: d.active_kid, hashKey: d.hash_key };
}

function kidsOf(spec) {
  return String(spec || '').split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
}

async function writeAudit(auditQuery, entry, logger) {
  if (logger) logger.info({ ...entry, module: 'field-keys' }, 'field encryption keys loaded');
  if (!auditQuery) return;
  try {
    await auditQuery(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('field_keys.load', 'field_keys', $1, $2)",
      [entry.source, JSON.stringify(entry)],
    );
  } catch (err) {
    if (logger) logger.warn({ err: err.message }, 'field key audit log write failed');
  }
}

/**
 * 加载密钥并应用到本进程（fieldCrypto 读取 process.env 中的三个变量）
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {Function} [opts.auditQuery] (sql, params) => Promise，写 audit_logs
 * @param {object} [opts.logger]
 */
async function initFieldKeys({ env = process.env, auditQuery, logger } = {}) {
  let source = 'env';
  let material = null;
  try {
    if (env.VAULT_ADDR && env.VAULT_TOKEN && env.FIELD_KEYS_VAULT_PATH) {
      source = 'vault';
      material = await loadFromVault(env);
    } else if (env.FIELD_KEYS_FILE) {
      source = 'file';
      if (!env.FIELD_KEYS_FILE_PASSPHRASE) throw new Error('缺少 FIELD_KEYS_FILE_PASSPHRASE');
      material = openKeyFile(fs.readFileSync(env.FIELD_KEYS_FILE, 'utf8'), env.FIELD_KEYS_FILE_PASSPHRASE);
    }
  } catch (err) {
    await writeAudit(auditQuery, { source, ok: false, error: err.message, at: new Date().toISOString() }, logger);
    throw err;
  }
  if (material) {
    env.FIELD_ENCRYPTION_KEYS = material.keys;
    env.FIELD_ENCRYPTION_ACTIVE_KID = material.activeKid || kidsOf(material.keys).slice(-1)[0];
    env.FIELD_HASH_KEY = material.hashKey;
  }
  loaded = {
    source,
    kids: kidsOf(env.FIELD_ENCRYPTION_KEYS),
    activeKid: env.FIELD_ENCRYPTION_ACTIVE_KID || null,
    hashKeyConfigured: !!env.FIELD_HASH_KEY,
    loadedAt: new Date().toISOString(),
  };
  await writeAudit(auditQuery, { ...loaded, ok: true }, logger);
  return loaded;
}

/** 当前密钥来源信息（不含密钥材料），供管理/健康接口展示 */
function keyStatus() {
  return loaded;
}

module.exports = { initFieldKeys, keyStatus, sealKeyFile, openKeyFile };
