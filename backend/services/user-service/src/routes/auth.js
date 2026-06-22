// user-service/src/routes/auth.js
'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { z }    = require('zod');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../../shared/redis');
const {
  signAccess, signRefresh, verifyAccess, verifyRefresh,
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
  // REQ-00034: 年龄验证
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '出生日期格式不正确').optional(),
  parentEmail: z.string().email('家长邮箱格式不正确').optional(),
  // REQ-00016: GDPR consent
  consent: z.object({
    privacyPolicy: z.boolean(),
    termsOfService: z.boolean()
  }).optional()
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
    const dailyKey   = `sms:daily:${phone}`;
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
    const { phone, smsCode, nickname, deviceId, birthDate, parentEmail, consent } = RegisterSchema.parse(req.body);

    // REQ-00016: Verify GDPR consent
    if (!consent || !consent.privacyPolicy || !consent.termsOfService) {
      throw new AppError(1010, '必须同意隐私政策和服务条款', 400);
    }

    // REQ-00034: 验证年龄和COPPA合规
    const {
      calculateAge,
      getAgeBracket,
      AGE_BRACKETS,
      createOrUpdateAgeProfile,
      sendParentConsentEmail
    } = require('../../../../shared/ageVerification');

    const age = birthDate ? calculateAge(birthDate) : null;
    const ageBracket = birthDate ? getAgeBracket(age) : AGE_BRACKETS.UNKNOWN;

    // 13岁以下必须提供家长邮箱
    if (ageBracket === AGE_BRACKETS.UNDER_13 && !parentEmail) {
      throw new AppError(1011, '13岁以下用户必须提供家长邮箱', 400);
    }

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

      // REQ-00016: Record user consent
      await client.query(`
        INSERT INTO user_consents
          (user_id, privacy_policy_version, terms_version, consented_at, ip_address, user_agent)
        VALUES ($1, '1.0', '1.0', NOW(), $2, $3)
      `, [
        user.id,
        req.ip || req.connection.remoteAddress,
        req.headers['user-agent']
      ]);

      // REQ-00034: Create age profile if birthDate provided
      if (birthDate) {
        await client.query(`
          INSERT INTO user_age_profiles
            (user_id, birth_date, age_bracket, parent_email, parent_consent_status,
             daily_play_limit_minutes, monthly_spend_limit_cents, features_disabled)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          user.id,
          birthDate,
          ageBracket,
          parentEmail || null,
          ageBracket === AGE_BRACKETS.UNDER_13 ? 'pending' : 'not_required',
          ageBracket === AGE_BRACKETS.UNDER_13 ? 60 : null,
          ageBracket === AGE_BRACKETS.UNDER_13 ? 0 : null,
          ageBracket === AGE_BRACKETS.UNDER_13 ? ['trade', 'social'] : []
        ]);
      }

      return user;
    });

    // REQ-00034: 发送家长同意邮件
    if (ageBracket === AGE_BRACKETS.UNDER_13 && parentEmail) {
      try {
        await sendParentConsentEmail(result.id, parentEmail, result.nickname);
      } catch (emailError) {
        console.error('[COPPA] Failed to send parent consent email:', emailError);
        // 不中断注册流程，但记录错误
      }

      // 13岁以下用户需要等待家长同意才能登录
      res.status(201).json(successResp({
        userId: result.id,
        nickname: result.nickname,
        requiresParentConsent: true,
        message: '注册成功！已向家长邮箱发送验证邮件，请等待家长同意后登录。'
      }));
      return;
    }

    const tokens = issueTokens(result, {
      deviceName: req.body.deviceId || 'Unknown',
      deviceType: req.headers['x-device-type'] || 'unknown',
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });
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

    const tokens = issueTokens(user, {
      deviceName: req.headers['x-device-name'] || 'Unknown',
      deviceType: req.headers['x-device-type'] || 'unknown',
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });
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
// FIX: verifyAccess was called here but not imported in the original file.
// It is now explicitly imported from shared/auth above.
router.post('/logout', async (req, res, next) => {
  try {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      try {
        const payload = verifyAccess(token);
        const jti    = payload.jti;
        const userId = payload.sub;

        if (jti) {
          const { getJwtBlacklist } = require('../../../../shared/JwtBlacklist');
          const blacklist = getJwtBlacklist();
          const expiresAt = payload.exp || Math.floor(Date.now() / 1000) + 86400;

          await blacklist.revokeToken(jti, userId, expiresAt, {
            reason: 'logout',
            deviceInfo: {
              ip: req.ip || req.connection.remoteAddress,
              userAgent: req.headers['user-agent']
            }
          });
        }
      } catch (e) {
        // Token invalid, just proceed with logout
      }
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

function issueTokens(user, deviceInfo = {}) {
  const jti = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const accessToken  = signAccess({ sub: user.id, nickname: user.nickname, level: user.level, jti, iat: now, exp: now + 86400 });
  const refreshToken = signRefresh({ sub: user.id, jti });

  // Register session in blacklist (async, don't wait)
  const { getJwtBlacklist } = require('../../../../shared/JwtBlacklist');
  getJwtBlacklist().registerSession(jti, user.id, now + 86400, deviceInfo).catch(() => {});

  return {
    accessToken,
    refreshToken,
    tokenExpireAt: now + 86400,
    jti
  };
}

module.exports = router;
