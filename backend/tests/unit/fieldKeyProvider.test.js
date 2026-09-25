'use strict';
// REQ-00565：密钥来源（加密密钥文件 / Vault KV v2 / 环境变量）与审计记录，直接测试 shared/fieldKeyProvider + fieldCrypto
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { initFieldKeys, sealKeyFile, openKeyFile } = require('../../shared/fieldKeyProvider');
const fieldCrypto = require('../../shared/fieldCrypto');

const material = () => ({
  keys: `k1:${crypto.randomBytes(32).toString('hex')},k2:${crypto.randomBytes(32).toString('hex')}`,
  activeKid: 'k2',
  hashKey: crypto.randomBytes(32).toString('hex'),
});

test('加密密钥文件：封装/解封往返；口令错误无法解密', () => {
  const m = material();
  const sealed = sealKeyFile(m, 'correct horse');
  assert.ok(!sealed.includes(m.hashKey), '文件中不含明文密钥');
  assert.deepStrictEqual(openKeyFile(sealed, 'correct horse'), m);
  assert.throws(() => openKeyFile(sealed, 'wrong'));
});

test('initFieldKeys 从加密文件加载，fieldCrypto 使用该密钥；审计记录不含密钥材料', async () => {
  const m = material();
  const file = path.join(os.tmpdir(), `fk-${process.pid}.json`);
  fs.writeFileSync(file, sealKeyFile(m, 'pass'));
  const env = { FIELD_KEYS_FILE: file, FIELD_KEYS_FILE_PASSPHRASE: 'pass' };
  const audits = [];
  const st = await initFieldKeys({ env, auditQuery: async (sql, params) => audits.push(params) });
  fs.unlinkSync(file);
  assert.strictEqual(st.source, 'file');
  assert.deepStrictEqual(st.kids, ['k1', 'k2']);
  assert.strictEqual(env.FIELD_ENCRYPTION_ACTIVE_KID, 'k2');
  assert.strictEqual(audits.length, 1);
  assert.ok(!JSON.stringify(audits).includes(m.hashKey) && !JSON.stringify(audits).includes(m.keys.split(',')[0].split(':')[1]));
  // 用加载到的密钥加解密
  Object.assign(process.env, { FIELD_ENCRYPTION_KEYS: env.FIELD_ENCRYPTION_KEYS, FIELD_ENCRYPTION_ACTIVE_KID: env.FIELD_ENCRYPTION_ACTIVE_KID, FIELD_HASH_KEY: env.FIELD_HASH_KEY });
  const c = fieldCrypto.encrypt('a@b.com', 'users.email');
  assert.strictEqual(fieldCrypto.keyIdOf(c), 'k2');
  assert.strictEqual(fieldCrypto.decrypt(c, 'users.email'), 'a@b.com');
});

test('initFieldKeys 从 Vault KV v2 加载（本地模拟 Vault HTTP 接口，校验 token 头）', async () => {
  const m = material();
  const server = http.createServer((req, res) => {
    if (req.headers['x-vault-token'] !== 'tok' || req.url !== '/v1/secret/data/minego/field-keys') {
      res.writeHead(403); return res.end('{}');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { data: { keys: m.keys, active_kid: m.activeKid, hash_key: m.hashKey }, metadata: { version: 3 } } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { VAULT_ADDR: addr, VAULT_TOKEN: 'tok', FIELD_KEYS_VAULT_PATH: 'secret/data/minego/field-keys' };
    const st = await initFieldKeys({ env });
    assert.strictEqual(st.source, 'vault');
    assert.strictEqual(env.FIELD_HASH_KEY, m.hashKey);
    const bad = { VAULT_ADDR: addr, VAULT_TOKEN: 'nope', FIELD_KEYS_VAULT_PATH: 'secret/data/minego/field-keys' };
    const audits = [];
    await assert.rejects(initFieldKeys({ env: bad, auditQuery: async (s, p) => audits.push(p) }), /HTTP 403/);
    assert.ok(audits.length === 1 && audits[0][1].includes('"ok":false'), '失败也写审计');
  } finally {
    server.close();
  }
});

test('未配置 Vault/文件时沿用环境变量', async () => {
  const env = { FIELD_ENCRYPTION_KEYS: `k9:${'ab'.repeat(32)}`, FIELD_ENCRYPTION_ACTIVE_KID: 'k9', FIELD_HASH_KEY: 'cd'.repeat(32) };
  const st = await initFieldKeys({ env });
  assert.strictEqual(st.source, 'env');
  assert.deepStrictEqual(st.kids, ['k9']);
});
