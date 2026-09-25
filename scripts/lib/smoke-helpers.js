/**
 * 经网关的集成冒烟测试公共工具（供 scripts/smoke-*.js 复用）
 *
 * 环境变量：
 *   BASE_URL      网关地址，默认 http://127.0.0.1:8080
 *   REDIS_URL     读取短信验证码（生产模式验证码不回传），默认从仓库根目录 .env 推导
 *   DATABASE_URL  可选：授予测试账号管理员角色、准备测试数据时使用，默认从 .env 推导
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const req = (m) => require(path.join(ROOT, 'backend', 'node_modules', m));

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
const BASE = process.env.BASE_URL || `http://127.0.0.1:${fileEnv.PORT_BASE || 8080}`;
const REDIS_URL = process.env.REDIS_URL || fileEnv.REDIS_URL ||
  `redis://:${encodeURIComponent(fileEnv.REDIS_PASSWORD || '')}@${fileEnv.REDIS_HOST || '127.0.0.1'}:${fileEnv.REDIS_PORT || 6379}/0`;
const DATABASE_URL = process.env.DATABASE_URL || fileEnv.DATABASE_URL ||
  `postgres://${fileEnv.POSTGRES_USER || 'pmg_user'}:${encodeURIComponent(fileEnv.POSTGRES_PASSWORD || '')}@${fileEnv.POSTGRES_HOST || '127.0.0.1'}:${fileEnv.POSTGRES_PORT || 5432}/${fileEnv.POSTGRES_DB || 'pmg'}`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  return !!ok;
}

async function call(method, url, { body, token, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (raw) return res;
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, data: json && json.data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let redis = null;
async function getRedis() {
  if (!redis) {
    const Redis = req('ioredis');
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
  }
  return redis;
}

let pool = null;
function getDb() {
  if (!pool) {
    const { Pool } = req('pg');
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  }
  return pool;
}

/** 注册并登录一个新测试账号，返回 { token, refreshToken, userId, phone } */
async function newUser(prefix = 'smk') {
  const r = await getRedis();
  const phone = `13${String(Date.now()).slice(-6)}${String(crypto.randomInt(0, 1000)).padStart(3, '0')}`;
  // 注册/验证码接口按 IP 限流：批量造测试账号时遇到 429 退避重试
  const withRetry = async (fn) => {
    for (let i = 0; ; i++) {
      const res = await fn();
      if (res.status !== 429 || i >= 12) return res;
      await sleep(5000);
    }
  };
  await withRetry(() => call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'register' } }));
  const code = await r.get(`sms:code:${phone}:register`);
  const nickname = `${prefix}${phone.slice(-7)}`;
  const reg = await withRetry(() => call('POST', '/v1/auth/register', {
    body: { phone, smsCode: code, nickname, consent: { privacyPolicy: true, termsOfService: true } },
  }));
  if (!reg.data || !reg.data.accessToken) throw new Error(`注册失败 status=${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
  const token = reg.data.accessToken;
  const me = await call('GET', '/v1/users/me', { token });
  const userId = (me.data && (me.data.id || (me.data.user && me.data.user.id))) || reg.data.userId || (reg.data.user && reg.data.user.id);
  return { token, refreshToken: reg.data.refreshToken, userId, phone, nickname };
}

/** 重新登录拿新 token（角色变更后需要） */
async function relogin(user) {
  const r = await getRedis();
  await r.del(`sms:lock:${user.phone}`);
  await call('POST', '/v1/auth/sms-code', { body: { phone: user.phone, scene: 'login' } });
  const code = await r.get(`sms:code:${user.phone}:login`);
  const login = await call('POST', '/v1/auth/login', { body: { phone: user.phone, smsCode: code } });
  if (!login.data || !login.data.accessToken) throw new Error(`登录失败 status=${login.status}`);
  user.token = login.data.accessToken;
  user.refreshToken = login.data.refreshToken;
  return user;
}

/** 授予管理员角色并重新登录（需要 DATABASE_URL） */
async function makeAdmin(user) {
  await getDb().query(
    "UPDATE users SET roles = array_append(COALESCE(roles, '{}'), 'admin') WHERE id = $1 AND NOT ('admin' = ANY(COALESCE(roles, '{}')))",
    [user.userId],
  );
  return relogin(user);
}

async function finish() {
  if (redis) redis.disconnect();
  if (pool) await pool.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

module.exports = { BASE, DATABASE_URL, REDIS_URL, record, call, sleep, getRedis, getDb, newUser, relogin, makeAdmin, finish, results };
