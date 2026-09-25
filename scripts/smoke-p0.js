#!/usr/bin/env node
/**
 * P0 需求补全回归（经网关）
 *   REQ-00565 敏感字段加密：邮箱加密存储 + 盲索引唯一、接口返回明文、GDPR 导出解密；密钥加载写审计日志
 *   REQ-00586 定位反作弊补全：客户端信号、地形（水域）校验、自定义区域、申诉与审核、监控统计
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-p0.js
 */
'use strict';

const { record, call, newUser, makeAdmin, finish, getDb } = require('./lib/smoke-helpers');

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

async function incidents(userId) {
  const { rows } = await getDb().query(
    "SELECT type FROM anti_cheat_records WHERE user_id = $1 AND type NOT IN ('TRUST_DECREASE','TRUST_INCREASE') ORDER BY id", [userId]);
  return rows.map((r) => r.type);
}

async function testLocationIntegrity() {
  const admin = await makeAdmin(await newUser('acadm'));
  const jitter = () => (Math.random() - 0.5) * 0.0004;

  // 客户端信号：连续 12 个完全相同的定位 + 精度恒定 → 记录但不阻断
  const a = await newUser('sig');
  const r1 = await call('POST', '/v1/location', { token: a.token, body: { lat: 31.2304 + jitter(), lng: 121.4737 + jitter(), accuracy: 12,
    clientSignals: { samples: 12, identicalFixes: 11, accuracyConstant: true, nonMonotonicTimestamps: 0, webdriver: false } } });
  record('反作弊：静态伪造定位信号被记录且不阻断', r1.status === 200 && (await incidents(a.userId)).includes('CLIENT_SIGNAL_ANOMALY'), `status=${r1.status}`);
  const b = await newUser('wd');
  const r2 = await call('POST', '/v1/location', { token: b.token, body: { lat: 31.2350 + jitter(), lng: 121.4800 + jitter(), accuracy: 15,
    clientSignals: { samples: 3, identicalFixes: 0, webdriver: true } } });
  record('反作弊：自动化浏览器（webdriver）记为伪造嫌疑', r2.status === 200 && (await incidents(b.userId)).includes('GPS_FAKE_SUSPECT'), `status=${r2.status}`);

  // 地形：首次定位在东海海面上
  const c = await newUser('sea');
  const r3 = await call('POST', '/v1/location', { token: c.token, body: { lat: 31.20 + jitter(), lng: 122.90 + jitter(), accuracy: 10 } });
  record('反作弊：位置落在水域（东海）被记录', r3.status === 200 && (await incidents(c.userId)).includes('TERRAIN_WATER'), `status=${r3.status}`);

  // 管理员新增禁入区域（GeoJSON），落入该区域被记录
  const zoneName = `smoke-zone-${Date.now()}`;
  const z = await call('POST', '/api/admin/anticheat/zones', { token: admin.token, body: { name: zoneName, kind: 'restricted',
    geojson: { type: 'Polygon', coordinates: [[[121.30, 31.05], [121.32, 31.05], [121.32, 31.07], [121.30, 31.07], [121.30, 31.05]]] } } });
  const d = await newUser('zone');
  await call('POST', '/v1/location', { token: d.token, body: { lat: 31.06 + jitter() / 10, lng: 121.31 + jitter() / 10, accuracy: 10 } });
  record('反作弊：管理员新增禁入区域后生效', z.status === 201 && (await incidents(d.userId)).includes('TERRAIN_RESTRICTED'), `status=${z.status}`);
  const zDenied = await call('POST', '/api/admin/anticheat/zones', { token: d.token, body: { name: 'x', kind: 'water', geojson: { type: 'Polygon', coordinates: [[[0, 0]]] } } });
  record('反作弊：普通玩家不能管理区域', zDenied.status === 403, `status=${zDenied.status}`);

  // 申诉：无记录的玩家不能申诉；有记录的可申诉一次；管理员通过后恢复可信度
  const clean = await newUser('clean');
  const n0 = await call('POST', '/v1/location/appeals', { token: clean.token, body: { reason: '我没有任何风控记录，只是想试试申诉功能' } });
  record('申诉：无风控记录时拒绝申诉', n0.status === 400, `status=${n0.status}`);
  const ap = await call('POST', '/v1/location/appeals', { token: c.token, body: { reason: '我在去舟山的渡轮上，不是虚拟定位', evidence: { scenario: '乘坐渡轮' } } });
  const dup = await call('POST', '/v1/location/appeals', { token: c.token, body: { reason: '重复提交一次看看会不会被拒绝' } });
  record('申诉：提交成功，重复提交被拒绝', ap.status === 201 && dup.status === 409, `status=${ap.status}/${dup.status}`);
  const mine = await call('GET', '/v1/location/appeals', { token: c.token });
  const before = mine.data && mine.data.trustScore;
  const list = await call('GET', '/api/admin/anticheat/appeals?status=PENDING', { token: admin.token });
  const found = list.data && list.data.appeals.some((x) => x.id === ap.data.id);
  record('申诉：管理员可见待审核申诉', list.status === 200 && found && before < 100, `trust=${before}`);
  const decisions = await Promise.all([1, 2].map(() => call('POST', `/api/admin/anticheat/appeals/${ap.data.id}/decision`, { token: admin.token, body: { decision: 'APPROVE', note: '核实为渡轮' } })));
  const after = await call('GET', '/v1/location/appeals', { token: c.token });
  record('申诉：审核通过恢复可信度，重复审核只成功一次', decisions.filter((x) => x.status === 200).length === 1 && after.data.trustScore === 100 &&
    after.data.appeals[0].status === 'APPROVED', `statuses=${decisions.map((x) => x.status)} trust=${after.data.trustScore}`);

  // 监控统计
  const stats = await call('GET', '/api/admin/anticheat/stats?hours=24', { token: admin.token });
  const types = ((stats.data && stats.data.byType) || []).map((t) => t.type);
  record('监控：统计包含各类事件与申诉数', stats.status === 200 && types.includes('TERRAIN_WATER') && types.includes('CLIENT_SIGNAL_ANOMALY') && stats.data.appeals.APPROVED >= 1,
    `types=${types.join(',')}`);
  const statsDenied = await call('GET', '/api/admin/anticheat/stats', { token: a.token });
  record('监控：普通玩家不能查看', statsDenied.status === 403, `status=${statsDenied.status}`);
}

(async () => {
  await testFieldEncryption();
  await testLocationIntegrity();
  await finish();
})().catch(async (e) => {
  record('执行异常', false, e.message);
  await finish();
});
