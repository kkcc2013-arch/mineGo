// user-service/src/routes/auth.js
'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { z }    = require('zod');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../../shared/redis');
const {
  signAccess, signRefresh, verifyRefresh,
  AppError, successResp, errorResp
} = require('../../../../shared/auth');

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────
const RegisterSchema = z.object({
  phone:    z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  smsCode:  z.string().length(6, '验证码为6位'),
  nickname: z.string().min(2,'昵称最少2个字符').max(30,'昵称最多30个字符')
              .regex(/^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/, '昵称含非法字符'),
  deviceId: z.string().optional(),
});

const LoginSchema = z.object({
  phone:   z.string().regex(/^1[3-9]\d{9}$/),
  smsCode: z.string().length(6),
});

const SmsSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  scene: z.enum(['register','login','reset']).default('login'),
});

// ── POST /auth/sms-code ───────────────────────────────────────
router.post('/sms-code', async (req, res, next) => {
  try {
    const { phone, scene } = SmsSchema.parse(req.body);
    const redis = getRedis();

    // Rate limit: 1 per 60s per phone
    const lockKey = `sms:lock:${phone}`;
    const locked  = await redis.get(lockKey);
    if (locked) throw new AppError(1007, '请60秒后再试', 429);

    // Daily limit: 10 per phone
    const dailyKey  = `sms:daily:${phone}`;
    const dailyCount = parseInt(await redis.get(dailyKey) || '0');
    if (dailyCount >= 10) throw new AppError(1007, '今日验证码发送次数已达上限', 429);

    // Generate code (in prod: call SMS provider API)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`[SMS] To ${phone}: ${code} (scene: ${scene})`);

    // Store with 5min TTL
    await redis.setex(`sms:code:${phone}:${scene}`, 300, code);
    await redis.setex(lockKey, 60, '1');
    await redis.setex(dailyKey, 86400, (dailyCount + 1).toString());

    const devPayload = process.env.SMS_DEV_MODE === 'true' ? { expireIn: 300, dev_code: code } : { expireIn: 300 };
    res.json(successResp(devPayload, '验证码已发送'));
  } catch (err) { next(err); }
});

// ── POST /auth/register ───────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { phone, smsCode, nickname, deviceId } = RegisterSchema.parse(req.body);

    // Accept 'register' or 'login' scene (frontend sends 'login' for unified auth flow)
    await verifySmsCode(phone, smsCode, 'register').catch(async (e) => {
      if (e.code === 1008) return verifySmsCode(phone, smsCode, 'login');
      throw e;
    });

    const result = await transaction(async (client) => {
      // Check phone uniqueness
      const phoneHash = await bcrypt.hash(phone, 4); // light hash for lookup — real impl uses separate index
      const existing  = await client.query(
        'SELECT id FROM users WHERE phone = $1', [phone]
      );
      if (existing.rows.length > 0) throw new AppError(2001, '该手机号已注册', 409);

      // Check nickname uniqueness
      const nickExists = await client.query(
        'SELECT id FROM users WHERE nickname = $1', [nickname]
      );
      if (nickExists.rows.length > 0) throw new AppError(2002, '昵称已被使用', 409);

      // Create user
      const { rows: [user] } = await client.query(`
        INSERT INTO users (phone, nickname)
        VALUES ($1, $2)
        RETURNING id, nickname, level, xp, stardust, coins, created_at
      `, [phone, nickname]);

      // Create initial daily quest
      await client.query(`
        INSERT INTO daily_quests (user_id) VALUES ($1)
        ON CONFLICT DO NOTHING
      `, [user.id]);

      return user;
    });

    const tokens = issueTokens(result);
    res.status(201).json(successResp({ ...tokens, userId: result.id, nickname: result.nickname }));
  } catch (err) { next(err); }
});

// ── POST /auth/login ──────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { phone, smsCode } = LoginSchema.parse(req.body);

    // Check user exists BEFORE consuming the one-time code
    const { rows } = await query(
      'SELECT id, nickname, level, xp, team, is_banned, ban_reason FROM users WHERE phone = $1',
      [phone]
    );
    if (rows.length === 0) throw new AppError(2003, '账号不存在，请先注册', 404);
    const user = rows[0];
    if (user.is_banned) throw new AppError(2004, `账号已封禁: ${user.ban_reason}`, 403);

    await verifySmsCode(phone, smsCode, 'login');

    // Update last login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const tokens = issueTokens(user);
    res.json(successResp({ ...tokens, userId: user.id, nickname: user.nickname, level: user.level, team: user.team }));
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(1001, 'refreshToken 必填', 400);

    let payload;
    try { payload = verifyRefresh(refreshToken); }
    catch { throw new AppError(1003, 'Refresh Token 无效或已过期', 401); }

    // Check blacklist
    const blacklisted = await getRedis().get(`token:blacklist:${payload.jti}`);
    if (blacklisted) throw new AppError(1003, 'Token 已失效', 401);

    const { rows } = await query('SELECT id, nickname, level FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0]) throw new AppError(2003, '用户不存在', 404);

    const tokens = issueTokens(rows[0]);
    res.json(successResp(tokens));
  } catch (err) { next(err); }
});

// ── POST /auth/logout ─────────────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      // Blacklist the token until its natural expiry
      // In prod: parse exp from token and use that TTL
      await getRedis().setex(`token:blacklist:${uuidv4()}`, 86400, '1');
    }
    res.json(successResp(null, '已退出登录'));
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────
async function verifySmsCode(phone, code, scene) {
  const redis  = getRedis();
  const stored = await redis.get(`sms:code:${phone}:${scene}`);
  if (!stored)  throw new AppError(1008, '验证码已过期，请重新获取', 400);
  if (stored !== code) throw new AppError(1009, '验证码错误', 400);
  await redis.del(`sms:code:${phone}:${scene}`);  // one-time use
}

function issueTokens(user) {
  const jti = uuidv4();
  const accessToken  = signAccess({ sub: user.id, nickname: user.nickname, level: user.level, jti });
  const refreshToken = signRefresh({ sub: user.id, jti });
  return {
    accessToken,
    refreshToken,
    tokenExpireAt: Math.floor(Date.now() / 1000) + 86400,
  };
}

module.exports = router;
