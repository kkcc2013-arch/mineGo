/**
 * 冒烟 / 基准脚本共用：读取 .env、经网关注册登录测试用户、授予管理员、批量插入测试精灵
 * 依赖 backend/node_modules（ioredis、pg），在 CI 栈容器副本中运行
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const f = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const BASE = process.env.BASE_URL || `http://127.0.0.1:${env.PORT_BASE || 8080}`;

function randomIp() {
  return `10.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
}

/** 通用请求：默认 JSON，返回 { status, headers, body, buf, ms } */
async function call(method, url, { body, token, headers = {}, raw = false, ip, timeout = 20000 } = {}) {
  const t0 = process.hrtime.bigint();
  const h = { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  if (ip) h['X-Forwarded-For'] = ip;
  const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)), signal: AbortSignal.timeout(timeout) });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (/json/.test(ct)) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return { status: res.status, headers: res.headers, body: json, data: json && json.data, buf, ms };
}

function redisClient() {
  const Redis = require(path.join(ROOT, 'backend', 'node_modules', 'ioredis'));
  const url = env.REDIS_URL || `redis://:${encodeURIComponent(env.REDIS_PASSWORD || '')}@${env.REDIS_HOST || '127.0.0.1'}:${env.REDIS_PORT || 6379}/0`;
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

function pgClient() {
  const { Client } = require(path.join(ROOT, 'backend', 'node_modules', 'pg'));
  return new Client(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
    host: env.POSTGRES_HOST || '127.0.0.1', port: Number(env.POSTGRES_PORT || 5432), database: env.POSTGRES_DB, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
  });
}

/** 注册并登录一个新用户（验证码从 Redis 读取） */
async function registerUser(redis, { prefix = 'std' } = {}) {
  const phone = `13${String(Date.now()).slice(-7)}${crypto.randomInt(10, 99)}`;
  const ip = randomIp();
  await call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'register' }, ip });
  const code = await redis.get(`sms:code:${phone}:register`);
  const reg = await call('POST', '/v1/auth/register', { ip, body: { phone, smsCode: code, nickname: `${prefix}${phone.slice(-6)}`, consent: { privacyPolicy: true, termsOfService: true } } });
  if (!reg.data || !reg.data.accessToken) throw new Error(`注册失败 status=${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
  return { phone, token: reg.data.accessToken, refreshToken: reg.data.refreshToken, userId: reg.data.userId || (reg.data.user && reg.data.user.id) };
}

/** 重新登录（授予角色后需要新 token 才带 roles） */
async function login(redis, phone) {
  const ip = randomIp();
  await redis.del(`sms:lock:${phone}`);
  await call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'login' }, ip });
  const code = await redis.get(`sms:code:${phone}:login`);
  const r = await call('POST', '/v1/auth/login', { body: { phone, smsCode: code }, ip });
  if (!r.data || !r.data.accessToken) throw new Error(`登录失败 status=${r.status}`);
  return r.data.accessToken;
}

async function grantAdmin(pg, userId) {
  await pg.query(`UPDATE users SET roles = CASE WHEN roles IS NULL THEN ARRAY['admin'] WHEN 'admin' = ANY(roles) THEN roles ELSE array_append(roles, 'admin') END WHERE id = $1`, [userId]);
}

/** 给用户插入 n 只精灵（直接写库，用于批量/分页/详情测试），返回 id 列表（按 cp 降序） */
async function seedPokemon(pg, userId, n) {
  const { rows } = await pg.query(`
    INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny, fast_move, charge_move, caught_at)
    SELECT $1, ((g - 1) % 150) + 1, 100 + g * 7, 50, 50, g % 16, (g * 3) % 16, (g * 7) % 16, g % 20 = 0, NULL, NULL, NOW() - (g || ' minutes')::interval
      FROM generate_series(1, $2) g
    RETURNING id, cp`, [userId, n]);
  return rows.sort((a, b) => b.cp - a.cp).map((r) => r.id);
}

module.exports = { ROOT, env, BASE, call, randomIp, redisClient, pgClient, registerUser, login, grantAdmin, seedPokemon };
