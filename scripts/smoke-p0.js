#!/usr/bin/env node
/**
 * P0 需求补全回归（经网关）
 *   REQ-00565 敏感字段加密：邮箱加密存储 + 盲索引唯一、接口返回明文、GDPR 导出解密；密钥加载写审计日志
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-p0.js
 */
'use strict';

const { record, call, newUser, finish, getDb } = require('./lib/smoke-helpers');

async function testFieldEncryption() {
  const db = getDb();
  const a = await newUser('enc');
  const b = await newUser('enc');
  const email = `P0.${Date.now()}@Example.com`;

  const set = await call('PATCH', '/v1/users/me', { token: a.token, body: { email } });
  record('加密：设置邮箱', set.status === 200, `status=${set.status}`);
  const row = (await db.query('SELECT email, email_hash, phone FROM users WHERE id = $1', [a.userId])).rows[0];
  record('加密：数据库中邮箱为密文（enc:v1:）且有盲索引', /^enc:v1:/.test(row.email || '') && /^[0-9a-f]{64}$/.test(row.email_hash || ''), `email=${String(row.email).slice(0, 16)}…`);
  record('加密：手机号同为密文', /^enc:v1:/.test(row.phone || ''));
  const me = await call('GET', '/v1/users/me', { token: a.token });
  record('加密：接口返回解密后的邮箱（小写规范化）', me.data && me.data.email === email.toLowerCase(), `email=${me.data && me.data.email}`);

  const dup = await call('PATCH', '/v1/users/me', { token: b.token, body: { email: email.toUpperCase() } });
  record('加密：同一邮箱（大小写不同）被他人使用 → 409', dup.status === 409, `status=${dup.status}`);

  const exp = await call('GET', '/v1/gdpr/export', { token: a.token });
  const profile = (exp.body && exp.body.profile) || (exp.data && exp.data.profile); // 导出接口直接返回导出文档（无 data 包装）
  record('加密：GDPR 导出中邮箱为明文', profile && profile.email === email.toLowerCase(), `status=${exp.status}`);

  const clear = await call('PATCH', '/v1/users/me', { token: a.token, body: { email: null } });
  const cleared = (await db.query('SELECT email, email_hash FROM users WHERE id = $1', [a.userId])).rows[0];
  record('加密：清除邮箱同时清除盲索引', clear.status === 200 && cleared.email === null && cleared.email_hash === null);

  const audit = await db.query("SELECT details FROM audit_logs WHERE action = 'field_keys.load' ORDER BY id DESC LIMIT 1");
  const d = audit.rows[0] && audit.rows[0].details;
  record('密钥：服务启动加载密钥写入审计日志（含来源与 kid，不含密钥）',
    d && d.ok === true && Array.isArray(d.kids) && !JSON.stringify(d).match(/[0-9a-f]{64}/), `source=${d && d.source} kids=${d && d.kids}`);
}

(async () => {
  await testFieldEncryption();
  await finish();
})().catch(async (e) => {
  record('执行异常', false, e.message);
  await finish();
});
