/**
 * REQ-00565: 数据库敏感字段加密（应用层）
 *
 * - 加密：AES-256-GCM，随机 IV，AAD 绑定字段上下文（如 "users.phone"），
 *   密文格式 `enc:v1:<kid>:<base64(iv[12] | tag[16] | ciphertext)>`，数据库里只存密文。
 * - 查询：HMAC-SHA256 盲索引（FIELD_HASH_KEY），用于精确匹配/唯一约束；不支持模糊/范围查询（设计如此）。
 * - 密钥轮换：FIELD_ENCRYPTION_KEYS 可配置多个 kid，新数据用 FIELD_ENCRYPTION_ACTIVE_KID 加密，
 *   旧密文按自身 kid 解密；`scripts/encrypt-user-phones.js --rotate` 把历史数据重新加密到当前 kid。
 *
 * 配置（.env）：
 *   FIELD_ENCRYPTION_KEYS=k1:<64位hex>[,k2:<64位hex>]
 *   FIELD_ENCRYPTION_ACTIVE_KID=k1
 *   FIELD_HASH_KEY=<64位hex>          # 设定后不可更换，否则无法按手机号查询
 * 未配置时 isEnabled() 为 false，调用方按明文处理（兼容未配置密钥的环境）。
 */
'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

function parseKeys(spec) {
  const keys = new Map();
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx <= 0) throw new Error('FIELD_ENCRYPTION_KEYS 格式应为 kid:hex[,kid:hex]');
    const kid = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), 'hex');
    if (key.length !== 32) throw new Error(`FIELD_ENCRYPTION_KEYS 中 ${kid} 必须是 32 字节（64 位 hex）`);
    keys.set(kid, key);
  }
  return keys;
}

let cache = null;
function config() {
  const sig = `${process.env.FIELD_ENCRYPTION_KEYS}|${process.env.FIELD_ENCRYPTION_ACTIVE_KID}|${process.env.FIELD_HASH_KEY}`;
  if (cache && cache.sig === sig) return cache;
  const keys = parseKeys(process.env.FIELD_ENCRYPTION_KEYS);
  const activeKid = process.env.FIELD_ENCRYPTION_ACTIVE_KID || (keys.size ? [...keys.keys()][keys.size - 1] : null);
  if (activeKid && keys.size && !keys.has(activeKid)) {
    throw new Error(`FIELD_ENCRYPTION_ACTIVE_KID=${activeKid} 不在 FIELD_ENCRYPTION_KEYS 中`);
  }
  const hashKey = process.env.FIELD_HASH_KEY ? Buffer.from(process.env.FIELD_HASH_KEY, 'hex') : null;
  if (hashKey && hashKey.length < 32) throw new Error('FIELD_HASH_KEY 至少 32 字节（64 位 hex）');
  cache = { sig, keys, activeKid, hashKey };
  return cache;
}

/** 加密与盲索引都已配置 */
function isEnabled() {
  const c = config();
  return c.keys.size > 0 && !!c.activeKid && !!c.hashKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext, context) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const c = config();
  if (!c.keys.size) throw new Error('field encryption is not configured');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', c.keys.get(c.activeKid), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${PREFIX}${c.activeKid}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

function decrypt(value, context) {
  if (!isEncrypted(value)) return value; // 明文（未迁移数据）原样返回
  const rest = value.slice(PREFIX.length);
  const idx = rest.indexOf(':');
  const kid = rest.slice(0, idx);
  const key = config().keys.get(kid);
  if (!key) throw new Error(`unknown encryption key id: ${kid}`);
  const buf = Buffer.from(rest.slice(idx + 1), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}

/** 密文使用的 kid（非密文返回 null） */
function keyIdOf(value) {
  if (!isEncrypted(value)) return null;
  const rest = value.slice(PREFIX.length);
  return rest.slice(0, rest.indexOf(':'));
}

function activeKeyId() {
  return config().activeKid;
}

/** 盲索引：HMAC-SHA256(hashKey, context|normalized) 的 hex（64 字符） */
function blindIndex(value, context) {
  const c = config();
  if (!c.hashKey) throw new Error('FIELD_HASH_KEY is not configured');
  const normalized = String(value).trim();
  return crypto.createHmac('sha256', c.hashKey).update(`${context}|${normalized}`).digest('hex');
}

module.exports = { isEnabled, isEncrypted, encrypt, decrypt, blindIndex, keyIdOf, activeKeyId };
