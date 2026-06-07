// backend/shared/ageVerification.js
// REQ-00034: COPPA 合规与年龄验证服务

'use strict';

const { query, transaction } = require('./db');
const { getRedis } = require('./redis');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// 年龄分组常量
const AGE_BRACKETS = {
  UNDER_13: 'under_13',
  TEEN_13_17: '13_17',
  ADULT_18_PLUS: '18_plus',
  UNKNOWN: 'unknown'
};

// 家长同意状态
const CONSENT_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  DENIED: 'denied',
  NOT_REQUIRED: 'not_required'
};

// 根据出生日期计算年龄
function calculateAge(birthDate) {
  if (!birthDate) return null;
  
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

// 根据年龄确定年龄分组
function getAgeBracket(age) {
  if (age === null || age === undefined) return AGE_BRACKETS.UNKNOWN;
  if (age < 13) return AGE_BRACKETS.UNDER_13;
  if (age < 18) return AGE_BRACKETS.TEEN_13_17;
  return AGE_BRACKETS.ADULT_18_PLUS;
}

// 创建或更新用户年龄档案
async function createOrUpdateAgeProfile(userId, birthDate, parentEmail = null) {
  const age = calculateAge(birthDate);
  const ageBracket = getAgeBracket(age);
  const needsParentConsent = ageBracket === AGE_BRACKETS.UNDER_13;
  
  const result = await query(`
    INSERT INTO user_age_profiles 
      (user_id, birth_date, age_bracket, parent_email, parent_consent_status, 
       daily_play_limit_minutes, monthly_spend_limit_cents, features_disabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      birth_date = EXCLUDED.birth_date,
      age_bracket = EXCLUDED.age_bracket,
      parent_email = EXCLUDED.parent_email,
      parent_consent_status = EXCLUDED.parent_consent_status,
      daily_play_limit_minutes = EXCLUDED.daily_play_limit_minutes,
      monthly_spend_limit_cents = EXCLUDED.monthly_spend_limit_cents,
      features_disabled = EXCLUDED.features_disabled,
      updated_at = NOW()
    RETURNING *
  `, [
    userId,
    birthDate,
    ageBracket,
    parentEmail,
    needsParentConsent ? CONSENT_STATUS.PENDING : CONSENT_STATUS.NOT_REQUIRED,
    ageBracket === AGE_BRACKETS.UNDER_13 ? 60 : null, // 13岁以下默认60分钟/天
    ageBracket === AGE_BRACKETS.UNDER_13 ? 0 : null,  // 13岁以下默认禁止消费
    ageBracket === AGE_BRACKETS.UNDER_13 ? ['trade', 'social'] : [] // 禁止交易和社交
  ]);
  
  return result.rows[0];
}

// 获取用户年龄档案
async function getAgeProfile(userId) {
  const { rows } = await query(
    'SELECT * FROM user_age_profiles WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// 生成家长同意令牌
function generateParentConsentToken(userId, parentEmail) {
  const token = crypto.randomBytes(32).toString('hex');
  const payload = JSON.stringify({ userId, parentEmail, timestamp: Date.now() });
  const hash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
    .update(payload)
    .digest('hex');
  
  return {
    token: `${token}.${hash}`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7天有效期
  };
}

// 验证家长同意令牌
async function verifyParentConsentToken(token) {
  const redis = getRedis();
  const stored = await redis.get(`parent_consent:${token}`);
  
  if (!stored) {
    return { valid: false, error: 'Token 无效或已过期' };
  }
  
  try {
    const data = JSON.parse(stored);
    return { valid: true, data };
  } catch (error) {
    return { valid: false, error: 'Token 数据格式错误' };
  }
}

// 发送家长同意邮件
async function sendParentConsentEmail(userId, parentEmail, childNickname) {
  const { token, expiresAt } = generateParentConsentToken(userId, parentEmail);
  
  // 存储令牌到 Redis
  const redis = getRedis();
  const tokenData = JSON.stringify({
    userId,
    parentEmail,
    childNickname,
    createdAt: new Date().toISOString()
  });
  
  await redis.setex(
    `parent_consent:${token}`,
    7 * 24 * 60 * 60, // 7天
    tokenData
  );
  
  // 更新数据库
  await query(`
    UPDATE user_age_profiles 
    SET parent_consent_token = $1, parent_consent_expires_at = $2, updated_at = NOW()
    WHERE user_id = $3
  `, [token, expiresAt, userId]);
  
  // 记录日志
  await logParentConsentAction(userId, parentEmail, 'sent');
  
  // 在生产环境中，这里应该调用邮件服务
  console.log(`[COPPA] Parent consent email sent to ${parentEmail} for user ${userId}`);
  console.log(`[COPPA] Token: ${token}`);
  console.log(`[COPPA] Approve URL: ${process.env.APP_URL || 'http://localhost:8080'}/auth/verify-parent-consent?token=${token}&action=approve`);
  
  // 开发模式下返回令牌（生产环境不应返回）
  const devMode = process.env.NODE_ENV !== 'production';
  
  return {
    success: true,
    expiresAt,
    ...(devMode && { dev_token: token })
  };
}

// 验证家长同意
async function verifyParentConsent(userId, action, metadata = {}) {
  const profile = await getAgeProfile(userId);
  
  if (!profile) {
    throw new Error('用户年龄档案不存在');
  }
  
  if (action === 'approve') {
    await query(`
      UPDATE user_age_profiles 
      SET parent_consent_status = $1, 
          consent_verified_at = NOW(),
          parent_consent_token = NULL,
          updated_at = NOW()
      WHERE user_id = $2
    `, [CONSENT_STATUS.VERIFIED, userId]);
    
    await logParentConsentAction(userId, profile.parent_email, 'verified', metadata);
    
    return { success: true, status: CONSENT_STATUS.VERIFIED };
  } else if (action === 'deny') {
    await query(`
      UPDATE user_age_profiles 
      SET parent_consent_status = $1, 
          parent_consent_token = NULL,
          updated_at = NOW()
      WHERE user_id = $2
    `, [CONSENT_STATUS.DENIED, userId]);
    
    await logParentConsentAction(userId, profile.parent_email, 'denied', metadata);
    
    return { success: true, status: CONSENT_STATUS.DENIED };
  } else {
    throw new Error('无效的操作类型');
  }
}

// 记录家长同意操作日志
async function logParentConsentAction(userId, parentEmail, action, metadata = {}) {
  await query(`
    INSERT INTO parent_consent_logs 
      (user_id, parent_email, action, ip_address, user_agent, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    userId,
    parentEmail,
    action,
    metadata.ipAddress || null,
    metadata.userAgent || null,
    metadata
  ]);
}

// 检查用户是否可以登录（13岁以下需要家长同意）
async function canUserLogin(userId) {
  const profile = await getAgeProfile(userId);
  
  if (!profile) {
    // 没有年龄档案，允许登录（兼容旧用户）
    return { canLogin: true };
  }
  
  if (profile.age_bracket === AGE_BRACKETS.UNDER_13) {
    if (profile.parent_consent_status === CONSENT_STATUS.VERIFIED) {
      return { canLogin: true };
    } else if (profile.parent_consent_status === CONSENT_STATUS.DENIED) {
      return { 
        canLogin: false, 
        reason: 'parent_denied',
        message: '家长已拒绝同意，请联系客服'
      };
    } else {
      return { 
        canLogin: false, 
        reason: 'pending_consent',
        message: '等待家长同意，请查收邮件'
      };
    }
  }
  
  return { canLogin: true };
}

// 检查用户是否为未成年人
function isMinor(profile) {
  if (!profile) return false;
  return profile.age_bracket === AGE_BRACKETS.UNDER_13 || 
         profile.age_bracket === AGE_BRACKETS.TEEN_13_17;
}

// 检查功能是否被禁用
function isFeatureDisabled(profile, feature) {
  if (!profile || !profile.features_disabled) return false;
  return profile.features_disabled.includes(feature);
}

// 记录游戏时间
async function recordPlayTime(userId, minutes) {
  const today = new Date().toISOString().split('T')[0];
  
  await query(`
    INSERT INTO user_play_time_daily (user_id, play_date, total_minutes, session_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (user_id, play_date)
    DO UPDATE SET 
      total_minutes = user_play_time_daily.total_minutes + $3,
      session_count = user_play_time_daily.session_count + 1,
      updated_at = NOW()
  `, [userId, today, minutes]);
}

// 获取今日游戏时间
async function getTodayPlayTime(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await query(`
    SELECT total_minutes FROM user_play_time_daily 
    WHERE user_id = $1 AND play_date = $2
  `, [userId, today]);
  
  return rows[0]?.total_minutes || 0;
}

// 检查游戏时间限制
async function checkPlayTimeLimit(userId) {
  const profile = await getAgeProfile(userId);
  
  if (!profile || !isMinor(profile)) {
    return { withinLimit: true };
  }
  
  const todayMinutes = await getTodayPlayTime(userId);
  const limit = profile.daily_play_limit_minutes || 60;
  
  if (todayMinutes >= limit) {
    return {
      withinLimit: false,
      currentMinutes: todayMinutes,
      limitMinutes: limit,
      message: `今日游戏时间已达 ${limit} 分钟上限`
    };
  }
  
  return {
    withinLimit: true,
    currentMinutes: todayMinutes,
    limitMinutes: limit,
    remainingMinutes: limit - todayMinutes
  };
}

// 记录消费
async function recordSpend(userId, cents) {
  const yearMonth = new Date().toISOString().substring(0, 7); // 'YYYY-MM'
  
  await query(`
    INSERT INTO user_monthly_spend (user_id, year_month, total_cents, transaction_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (user_id, year_month)
    DO UPDATE SET 
      total_cents = user_monthly_spend.total_cents + $3,
      transaction_count = user_monthly_spend.transaction_count + 1,
      updated_at = NOW()
  `, [userId, yearMonth, cents]);
}

// 获取本月消费
async function getMonthlySpend(userId) {
  const yearMonth = new Date().toISOString().substring(0, 7);
  const { rows } = await query(`
    SELECT total_cents FROM user_monthly_spend 
    WHERE user_id = $1 AND year_month = $2
  `, [userId, yearMonth]);
  
  return rows[0]?.total_cents || 0;
}

// 检查消费限制
async function checkSpendLimit(userId, additionalCents) {
  const profile = await getAgeProfile(userId);
  
  if (!profile || !isMinor(profile)) {
    return { withinLimit: true };
  }
  
  const monthlySpend = await getMonthlySpend(userId);
  const limit = profile.monthly_spend_limit_cents || 0;
  
  if (monthlySpend + additionalCents > limit) {
    return {
      withinLimit: false,
      currentSpend: monthlySpend,
      limitSpend: limit,
      requestedSpend: additionalCents,
      message: `月度消费已达上限 ¥${(limit / 100).toFixed(2)}`
    };
  }
  
  return {
    withinLimit: true,
    currentSpend: monthlySpend,
    limitSpend: limit,
    remainingSpend: limit - monthlySpend
  };
}

// 获取儿童账号列表（按家长邮箱）
async function getChildrenByParentEmail(parentEmail) {
  const { rows } = await query(`
    SELECT 
      uap.user_id,
      u.nickname,
      uap.birth_date,
      uap.age_bracket,
      uap.parent_consent_status,
      uap.daily_play_limit_minutes,
      uap.monthly_spend_limit_cents,
      uap.features_disabled,
      uap.created_at
    FROM user_age_profiles uap
    JOIN users u ON u.id = uap.user_id
    WHERE uap.parent_email = $1 AND uap.parent_consent_status = 'verified'
    ORDER BY uap.created_at DESC
  `, [parentEmail]);
  
  return rows;
}

// 更新儿童账号限制
async function updateChildLimits(userId, limits, parentEmail) {
  const profile = await getAgeProfile(userId);
  
  if (!profile || profile.parent_email !== parentEmail) {
    throw new Error('无权修改此用户限制');
  }
  
  const updates = [];
  const values = [userId];
  let paramIndex = 2;
  
  if (limits.dailyPlayMinutes !== undefined) {
    updates.push(`daily_play_limit_minutes = $${paramIndex++}`);
    values.push(limits.dailyPlayMinutes);
  }
  
  if (limits.monthlySpendCents !== undefined) {
    updates.push(`monthly_spend_limit_cents = $${paramIndex++}`);
    values.push(limits.monthlySpendCents);
  }
  
  if (limits.featuresDisabled !== undefined) {
    updates.push(`features_disabled = $${paramIndex++}`);
    values.push(limits.featuresDisabled);
  }
  
  if (updates.length === 0) {
    return profile;
  }
  
  updates.push('updated_at = NOW()');
  
  const { rows } = await query(`
    UPDATE user_age_profiles 
    SET ${updates.join(', ')}
    WHERE user_id = $1
    RETURNING *
  `, values);
  
  return rows[0];
}

module.exports = {
  AGE_BRACKETS,
  CONSENT_STATUS,
  calculateAge,
  getAgeBracket,
  createOrUpdateAgeProfile,
  getAgeProfile,
  generateParentConsentToken,
  verifyParentConsentToken,
  sendParentConsentEmail,
  verifyParentConsent,
  logParentConsentAction,
  canUserLogin,
  isMinor,
  isFeatureDisabled,
  recordPlayTime,
  getTodayPlayTime,
  checkPlayTimeLimit,
  recordSpend,
  getMonthlySpend,
  checkSpendLimit,
  getChildrenByParentEmail,
  updateChildLimits
};
