#!/usr/bin/env node
/**
 * Epic E21（客户端无障碍）后端接口冒烟（经网关）
 *
 *   注册用户 → 无障碍偏好 GET/PUT/DELETE /v1/users/me/preferences/a11y（含校验与鉴权）
 *   → 精灵语音描述 /v1/pokemon/species/:id/voice-description、批量 /v1/pokemon/voice-descriptions
 *
 * 用法：BASE_URL=http://127.0.0.1:18480 node scripts/smoke-a11y.js
 * 退出码：0 全部通过；1 有失败项
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Redis = require(path.join(ROOT, 'backend', 'node_modules', 'ioredis'));

function loadEnv() {
  const f = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

const fileEnv = loadEnv();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const REDIS_URL = process.env.REDIS_URL || fileEnv.REDIS_URL ||
  `redis://:${encodeURIComponent(fileEnv.REDIS_PASSWORD || '')}@${fileEnv.REDIS_HOST || '127.0.0.1'}:${fileEnv.REDIS_PORT || 6379}/0`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function call(method, url, { body, token } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, data: json && json.data };
}

/** 注册一个新测试用户，返回 { token, refreshToken, phone }（也供 e2e-a11y.js 复用） */
async function registerUser(redis, prefix = '15') {
  const phone = `${prefix}${String(Date.now()).slice(-9)}`;
  await call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'register' } });
  const code = await redis.get(`sms:code:${phone}:register`);
  const reg = await call('POST', '/v1/auth/register', {
    body: { phone, smsCode: code, nickname: `a11y${phone.slice(-6)}`, consent: { privacyPolicy: true, termsOfService: true } },
  });
  if (!reg.data || !reg.data.accessToken) throw new Error(`注册失败 status=${reg.status} ${JSON.stringify(reg.body).slice(0, 160)}`);
  return { token: reg.data.accessToken, refreshToken: reg.data.refreshToken, phone };
}

async function main() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  const { token } = await registerUser(redis);
  record('注册测试用户', !!token);

  const P = '/v1/users/me/preferences/a11y';
  const anon = await call('GET', P);
  record('鉴权：未登录读取偏好被拒绝', anon.status === 401, `status=${anon.status}`);

  const empty = await call('GET', P, { token });
  record('偏好：新用户读取为空', empty.status === 200 && empty.data && empty.data.prefs === null, `status=${empty.status}`);

  const doc = {
    version: 1,
    color: { mode: 'deuteranopia', shapes: true, contrast: 'high' },
    pace: { catch: 0.5, battle: 1, ui: 0.75 },
    haptics: { enabled: true, intensity: 150 },
    subtitles: { enabled: true, size: 'large' },
    bogus: { x: 1 },
  };
  const t0 = Date.now();
  const put = await call('PUT', P, { token, body: { prefs: doc, clientUpdatedAt: new Date().toISOString() } });
  const putMs = Date.now() - t0;
  record('偏好：保存 PUT', put.status === 200 && put.data && put.data.version === 1, `status=${put.status} ${putMs}ms`);
  record('偏好：未知分组被服务端丢弃', put.data && put.data.prefs && put.data.prefs.bogus === undefined);
  record('偏好：慢速模式被标记（反作弊审计）', put.data && put.data.flags && put.data.flags.slowMode === true);

  const got = await call('GET', P, { token });
  record('偏好：读回一致（跨设备恢复）', got.status === 200 && got.data.prefs.color.mode === 'deuteranopia' && got.data.prefs.pace.catch === 0.5,
    `status=${got.status}`);

  const put2 = await call('PUT', P, { token, body: { prefs: { ...doc, pace: { catch: 1 } } } });
  record('偏好：再次保存 version 递增', put2.status === 200 && put2.data.version === 2, `version=${put2.data && put2.data.version}`);

  const bad = await call('PUT', P, { token, body: { prefs: { pace: { catch: 0.1 } } } });
  record('偏好：越界节奏倍率被拒绝（后端校验）', bad.status === 400, `status=${bad.status}`);
  const badNs = await call('GET', '/v1/users/me/preferences/BAD..NS', { token });
  record('偏好：非法 namespace 被拒绝', badNs.status === 400 || badNs.status === 404, `status=${badNs.status}`);

  const del = await call('DELETE', P, { token });
  record('偏好：删除云端副本', del.status === 200 && del.data.deleted === true, `status=${del.status}`);

  const v = await call('GET', '/v1/pokemon/species/1/voice-description?lang=en-US&cp=321', { token });
  record('语音描述：单个精灵（英文）', v.status === 200 && /Bulbasaur/.test(v.data.text) && /CP 321/.test(v.data.text),
    v.data ? v.data.text.slice(0, 80) : `status=${v.status}`);
  const vz = await call('GET', '/v1/pokemon/species/4/voice-description?lang=zh-CN', { token });
  record('语音描述：中文含属性与进化路径', vz.status === 200 && /火属性/.test(vz.data.text) && /进化为/.test(vz.data.text),
    vz.data ? vz.data.text.slice(0, 60) : `status=${vz.status}`);
  const vj = await call('GET', '/v1/pokemon/species/7/voice-description?lang=ja-JP', { token });
  record('语音描述：日文', vj.status === 200 && vj.data.lang === 'ja-JP' && /タイプ/.test(vj.data.text), `status=${vj.status}`);
  const batch = await call('GET', '/v1/pokemon/voice-descriptions?ids=1,4,7&lang=zh-CN', { token });
  record('语音描述：批量接口', batch.status === 200 && batch.data.items.length === 3, `status=${batch.status}`);
  const nf = await call('GET', '/v1/pokemon/species/9999/voice-description', { token });
  record('语音描述：不存在的精灵 404', nf.status === 404, `status=${nf.status}`);
  const va = await call('GET', '/v1/pokemon/species/1/voice-description');
  record('鉴权：未登录访问语音描述被拒绝', va.status === 401, `status=${va.status}`);

  await redis.quit();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('❌ 冒烟中断：', e.message); process.exit(1); });
}

module.exports = { registerUser, call, loadEnv, REDIS_URL };
