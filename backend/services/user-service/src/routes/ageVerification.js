// user-service/src/routes/ageVerification.js
// REQ-00034: COPPA 合规与年龄验证 API 路由

'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('../../../../shared/db');
const { AppError, successResp, errorResp, authMiddleware } = require('../../../../shared/auth');
const {
  getAgeProfile,
  sendParentConsentEmail,
  verifyParentConsent,
  verifyParentConsentToken,
  canUserLogin,
  checkPlayTimeLimit,
  checkSpendLimit,
  getChildrenByParentEmail,
  updateChildLimits,
  recordPlayTime,
  CONSENT_STATUS,
  AGE_BRACKETS
} = require('../../../../shared/ageVerification');

const router = express.Router();

// 所有路由需要认证
router.use(authMiddleware);

// ── Schemas ───────────────────────────────────────────────────
const SendConsentSchema = z.object({
  parentEmail: z.string().email('家长邮箱格式不正确')
});

const UpdateLimitsSchema = z.object({
  dailyPlayMinutes: z.number().min(0).max(480).optional(),
  monthlySpendCents: z.number().min(0).max(1000000).optional(),
  featuresDisabled: z.array(z.string()).optional()
});

// ── GET /age/profile ─────────────────────────────────────────
// 获取当前用户的年龄档案
router.get('/profile', async (req, res, next) => {
  try {
    const profile = await getAgeProfile(req.user.id);
    
    if (!profile) {
      return res.json(successResp({
        hasProfile: false,
        message: '用户未设置年龄信息'
      }));
    }
    
    // 隐藏敏感信息
    const safeProfile = {
      hasProfile: true,
      ageBracket: profile.age_bracket,
      consentStatus: profile.parent_consent_status,
      dailyPlayLimit: profile.daily_play_limit_minutes,
      monthlySpendLimit: profile.monthly_spend_limit_cents,
      featuresDisabled: profile.features_disabled || [],
      isMinor: profile.age_bracket === AGE_BRACKETS.UNDER_13 || 
               profile.age_bracket === AGE_BRACKETS.TEEN_13_17
    };
    
    res.json(successResp(safeProfile));
  } catch (err) {
    next(err);
  }
});

// ── POST /age/send-consent ────────────────────────────────────
// 发送或重新发送家长同意邮件
router.post('/send-consent', async (req, res, next) => {
  try {
    const { parentEmail } = SendConsentSchema.parse(req.body);
    
    const profile = await getAgeProfile(req.user.id);
    
    if (!profile) {
      throw new AppError(4041, '用户年龄档案不存在', 404);
    }
    
    if (profile.age_bracket !== AGE_BRACKETS.UNDER_13) {
      throw new AppError(4042, '仅13岁以下用户需要家长同意', 400);
    }
    
    if (profile.parent_consent_status === CONSENT_STATUS.VERIFIED) {
      throw new AppError(4043, '家长已同意，无需重复验证', 400);
    }
    
    // 获取用户昵称
    const { rows } = await query('SELECT nickname FROM users WHERE id = $1', [req.user.id]);
    const nickname = rows[0]?.nickname || 'Player';
    
    const result = await sendParentConsentEmail(req.user.id, parentEmail, nickname);
    
    res.json(successResp({
      success: true,
      expiresAt: result.expiresAt,
      message: '验证邮件已发送，请家长查收'
    }));
  } catch (err) {
    next(err);
  }
});

// ── GET /age/verify-consent ───────────────────────────────────
// 验证家长同意（公开接口，通过token验证）
router.get('/verify-consent', async (req, res, next) => {
  try {
    const { token, action } = req.query;
    
    if (!token || !action) {
      throw new AppError(4044, '缺少必要参数', 400);
    }
    
    if (!['approve', 'deny'].includes(action)) {
      throw new AppError(4045, '无效的操作类型', 400);
    }
    
    // 验证token
    const verification = await verifyParentConsentToken(token);
    
    if (!verification.valid) {
      throw new AppError(4046, verification.error, 400);
    }
    
    const { userId, parentEmail, childNickname } = verification.data;
    
    // 执行验证
    const result = await verifyParentConsent(userId, action, {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });
    
    // 返回HTML页面
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>家长同意验证 - mineGo</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
          .success { color: #28a745; }
          .denied { color: #dc3545; }
          .card { max-width: 500px; margin: 0 auto; padding: 30px; border: 1px solid #ddd; border-radius: 8px; }
          h1 { margin-bottom: 20px; }
          p { color: #666; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1 class="${action === 'approve' ? 'success' : 'denied'}">
            ${action === 'approve' ? '✅ 验证成功' : '❌ 已拒绝'}
          </h1>
          <p>
            ${action === 'approve' 
              ? `您已同意 <strong>${childNickname}</strong> 使用 mineGo 游戏。` 
              : `您已拒绝 <strong>${childNickname}</strong> 使用 mineGo 游戏。`}
          </p>
          ${action === 'approve' 
            ? '<p>您可以通过家长控制面板管理孩子的游戏时间和消费限制。</p>' 
            : '<p>如需重新考虑，请联系客服。</p>'}
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// ── GET /age/play-time ────────────────────────────────────────
// 获取今日游戏时间和限制
router.get('/play-time', async (req, res, next) => {
  try {
    const result = await checkPlayTimeLimit(req.user.id);
    res.json(successResp(result));
  } catch (err) {
    next(err);
  }
});

// ── POST /age/play-time ───────────────────────────────────────
// 记录游戏时间
router.post('/play-time', async (req, res, next) => {
  try {
    const { minutes } = req.body;
    
    if (!minutes || minutes < 1) {
      throw new AppError(4047, '游戏时间必须大于0', 400);
    }
    
    await recordPlayTime(req.user.id, minutes);
    
    const limitCheck = await checkPlayTimeLimit(req.user.id);
    
    res.json(successResp({
      recorded: true,
      minutes,
      ...limitCheck
    }));
  } catch (err) {
    next(err);
  }
});

// ── GET /age/spend-limit ──────────────────────────────────────
// 获取消费限制状态
router.get('/spend-limit', async (req, res, next) => {
  try {
    const profile = await getAgeProfile(req.user.id);
    
    if (!profile) {
      return res.json(successResp({ applicable: false }));
    }
    
    const { getMonthlySpend, isMinor } = require('../../../../shared/ageVerification');
    const monthlySpend = await getMonthlySpend(req.user.id);
    
    res.json(successResp({
      applicable: isMinor(profile),
      currentSpend: monthlySpend,
      limit: profile.monthly_spend_limit_cents || 0,
      currency: 'CNY'
    }));
  } catch (err) {
    next(err);
  }
});

// ── POST /age/check-spend ─────────────────────────────────────
// 检查消费限制
router.post('/check-spend', async (req, res, next) => {
  try {
    const { cents } = req.body;
    
    if (!cents || cents < 1) {
      throw new AppError(4048, '消费金额必须大于0', 400);
    }
    
    const result = await checkSpendLimit(req.user.id, cents);
    res.json(successResp(result));
  } catch (err) {
    next(err);
  }
});

// ── 家长控制面板 API ──────────────────────────────────────────

// ── GET /parent/children ──────────────────────────────────────
// 获取关联的儿童账号列表
router.get('/parent/children', async (req, res, next) => {
  try {
    const profile = await getAgeProfile(req.user.id);
    
    // 这个API需要验证家长身份
    // 在实际应用中，家长通过单独的认证流程登录
    // 这里简化处理，假设用户已经验证了家长邮箱
    
    const { parentEmail } = req.query;
    
    if (!parentEmail) {
      throw new AppError(4049, '需要提供家长邮箱', 400);
    }
    
    const children = await getChildrenByParentEmail(parentEmail);
    
    res.json(successResp(children));
  } catch (err) {
    next(err);
  }
});

// ── PUT /parent/children/:userId/limits ───────────────────────
// 更新儿童账号限制
router.put('/parent/children/:userId/limits', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const limits = UpdateLimitsSchema.parse(req.body);
    const { parentEmail } = req.body;
    
    if (!parentEmail) {
      throw new AppError(4049, '需要提供家长邮箱', 400);
    }
    
    const result = await updateChildLimits(userId, limits, parentEmail);
    
    res.json(successResp({
      success: true,
      profile: {
        dailyPlayLimit: result.daily_play_limit_minutes,
        monthlySpendLimit: result.monthly_spend_limit_cents,
        featuresDisabled: result.features_disabled
      }
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
