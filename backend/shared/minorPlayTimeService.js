// backend/shared/minorPlayTimeService.js
// REQ-00578: 未成年人游戏时长限制与宵禁系统

'use strict';

const { query } = require('./db');
const { getRedis } = require('./redis');
const { getAgeProfile, isMinor, AGE_BRACKETS } = require('./ageVerification');

// 宵禁配置（中国法规：22:00 - 次日 08:00）
const CURFEW_CONFIG = {
  // 默认宵禁时段（可按地区配置）
  default: {
    startHour: 22,  // 22:00 开始
    endHour: 8,     // 08:00 结束
    timezone: 'Asia/Shanghai'
  },
  // 可扩展其他地区配置
  regions: {
    'CN': { startHour: 22, endHour: 8, timezone: 'Asia/Shanghai' }
  }
};

// 年龄段每日时长限制（分钟）
const DAILY_LIMITS = {
  [AGE_BRACKETS.UNDER_13]: 60,    // 13岁以下：1小时
  [AGE_BRACKETS.TEEN_13_17]: 90,  // 13-17岁：1.5小时
  [AGE_BRACKETS.ADULT_18_PLUS]: null,  // 成年人无限制
  [AGE_BRACKETS.UNKNOWN]: null    // 未知无限制
};

/**
 * 检查当前是否在宵禁时间段
 * @param {string} timezone - 时区，默认 'Asia/Shanghai'
 * @param {string} region - 地区代码，用于获取配置
 * @returns {{ isCurfew: boolean, reason?: string, endsAt?: Date }}
 */
function checkCurfewTime(timezone = 'Asia/Shanghai', region = 'CN') {
  const config = CURFEW_CONFIG.regions[region] || CURFEW_CONFIG.default;
  
  // 获取当前时区的时间
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString('en-US', { 
      hour: 'numeric', 
      hour12: false,
      timeZone: config.timezone 
    })
  );
  
  const { startHour, endHour } = config;
  
  // 检查是否在宵禁时段
  // 例如 22:00 - 08:00
  let isCurfew = false;
  let endsAt;
  
  if (startHour > endHour) {
    // 宵禁跨天（如 22:00 - 08:00）
    if (localHour >= startHour || localHour < endHour) {
      isCurfew = true;
      // 计算结束时间
      if (localHour >= startHour) {
        // 当前在当晚，结束时间是明天早上
        endsAt = new Date(now);
        endsAt.setDate(endsAt.getDate() + 1);
        endsAt.setHours(endHour, 0, 0, 0);
      } else {
        // 当前在凌晨，结束时间是今天早上
        endsAt = new Date(now);
        endsAt.setHours(endHour, 0, 0, 0);
      }
    }
  } else {
    // 宵禁不跨天（如 12:00 - 14:00）
    if (localHour >= startHour && localHour < endHour) {
      isCurfew = true;
      endsAt = new Date(now);
      endsAt.setHours(endHour, 0, 0, 0);
    }
  }
  
  if (isCurfew) {
    return {
      isCurfew: true,
      reason: `当前处于宵禁时段（${startHour}:00 - ${endHour}:00），未成年人禁止游戏`,
      endsAt,
      config: { startHour, endHour, timezone: config.timezone }
    };
  }
  
  return { isCurfew: false };
}

/**
 * 获取用户的每日游戏时长限制
 * @param {string} userId - 用户ID
 * @returns {Promise<{ limit: number|null, reason?: string }>}
 */
async function getDailyPlayTimeLimit(userId) {
  const profile = await getAgeProfile(userId);
  
  if (!profile || !isMinor(profile)) {
    return { limit: null }; // 成年人无限制
  }
  
  // 使用配置的限制或默认值
  const defaultLimit = DAILY_LIMITS[profile.age_bracket] || DAILY_LIMITS[AGE_BRACKETS.UNDER_13];
  const limit = profile.daily_play_limit_minutes || defaultLimit;
  
  return {
    limit,
    ageBracket: profile.age_bracket,
    reason: `未成年人每日游戏时长限制为 ${limit} 分钟`
  };
}

/**
 * 获取用户今日已玩游戏时长
 * @param {string} userId - 用户ID
 * @returns {Promise<number>} 已玩分钟数
 */
async function getTodayPlayedMinutes(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await query(`
    SELECT COALESCE(SUM(total_minutes), 0) as total
    FROM user_play_time_daily 
    WHERE user_id = $1 AND play_date = $2
  `, [userId, today]);
  
  return parseInt(rows[0]?.total || 0);
}

/**
 * 检查用户是否可以继续游戏
 * @param {string} userId - 用户ID
 * @param {string} timezone - 用户时区
 * @returns {Promise<{ canPlay: boolean, reason?: string, remainingMinutes?: number, curfewEndsAt?: Date }>}
 */
async function checkUserCanPlay(userId, timezone = 'Asia/Shanghai') {
  // 1. 检查宵禁
  const curfewCheck = checkCurfewTime(timezone);
  if (curfewCheck.isCurfew) {
    return {
      canPlay: false,
      reason: curfewCheck.reason,
      curfewEndsAt: curfewCheck.endsAt,
      code: 'CURFEW'
    };
  }
  
  // 2. 获取年龄档案
  const profile = await getAgeProfile(userId);
  
  if (!profile || !isMinor(profile)) {
    return { canPlay: true, remainingMinutes: null }; // 成年人
  }
  
  // 3. 检查家长同意状态
  const CONSENT_STATUS = {
    PENDING: 'pending',
    VERIFIED: 'verified',
    DENIED: 'denied',
    NOT_REQUIRED: 'not_required'
  };
  
  if (profile.age_bracket === AGE_BRACKETS.UNDER_13) {
    if (profile.parent_consent_status === CONSENT_STATUS.DENIED) {
      return {
        canPlay: false,
        reason: '家长已拒绝同意，账号已被限制',
        code: 'PARENT_DENIED'
      };
    }
    if (profile.parent_consent_status === CONSENT_STATUS.PENDING) {
      return {
        canPlay: false,
        reason: '等待家长同意，请查收邮件',
        code: 'PENDING_CONSENT'
      };
    }
  }
  
  // 4. 检查每日时长限制
  const limitResult = await getDailyPlayTimeLimit(userId);
  const playedMinutes = await getTodayPlayedMinutes(userId);
  
  if (limitResult.limit && playedMinutes >= limitResult.limit) {
    return {
      canPlay: false,
      reason: `今日游戏时间已达 ${limitResult.limit} 分钟上限，请明日再来`,
      playedMinutes,
      limitMinutes: limitResult.limit,
      code: 'DAILY_LIMIT_EXCEEDED'
    };
  }
  
  return {
    canPlay: true,
    remainingMinutes: limitResult.limit ? limitResult.limit - playedMinutes : null,
    playedMinutes,
    limitMinutes: limitResult.limit
  };
}

/**
 * 记录游戏时长（实时更新）
 * @param {string} userId - 用户ID
 * @param {number} minutes - 本次游戏分钟数
 * @param {string} sessionId - 会话ID（用于去重）
 */
async function recordPlayTimeIncrement(userId, minutes, sessionId = null) {
  const today = new Date().toISOString().split('T')[0];
  const redis = getRedis();
  
  // 使用 Redis 原子操作记录实时游戏时间
  const cacheKey = `playtime:${userId}:${today}`;
  const totalKey = `playtime:total:${userId}:${today}`;
  
  // 检查会话去重
  if (sessionId) {
    const sessionKey = `playtime:session:${sessionId}`;
    const exists = await redis.exists(sessionKey);
    if (exists) {
      return; // 已记录过此会话
    }
    await redis.setex(sessionKey, 86400, '1'); // 24小时过期
  }
  
  // 更新 Redis 计数器
  await redis.incrby(totalKey, minutes);
  await redis.expire(totalKey, 86400); // 24小时过期
  
  // 异步写入数据库
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

/**
 * 强制下线通知
 * @param {string} userId - 用户ID
 * @param {string} reason - 下线原因
 * @param {Object} metadata - 额外信息
 */
async function forceLogout(userId, reason, metadata = {}) {
  const redis = getRedis();
  
  // 设置强制下线标记
  await redis.setex(`force_logout:${userId}`, 3600, JSON.stringify({
    reason,
    timestamp: new Date().toISOString(),
    ...metadata
  }));
  
  // 发布强制下线事件
  const EventBus = require('./EventBus');
  const eventBus = EventBus.getEventBus();
  
  await eventBus.emit('user.force_logout', {
    userId,
    reason,
    code: metadata.code,
    timestamp: new Date().toISOString()
  });
  
  // 记录日志
  await query(`
    INSERT INTO minor_protection_events 
      (user_id, event_type, reason, metadata, created_at)
    VALUES ($1, $2, $3, $4, NOW())
  `, [userId, 'force_logout', reason, metadata]);
}

/**
 * 检查用户是否被强制下线
 * @param {string} userId - 用户ID
 * @returns {Promise<{ forced: boolean, reason?: string }>}
 */
async function checkForceLogout(userId) {
  const redis = getRedis();
  const data = await redis.get(`force_logout:${userId}`);
  
  if (data) {
    try {
      return { forced: true, ...JSON.parse(data) };
    } catch {
      return { forced: true };
    }
  }
  
  return { forced: false };
}

/**
 * 清除强制下线标记
 * @param {string} userId - 用户ID
 */
async function clearForceLogout(userId) {
  const redis = getRedis();
  await redis.del(`force_logout:${userId}`);
}

/**
 * 获取用户今日剩余游戏时间
 * @param {string} userId - 用户ID
 * @returns {Promise<number|null>} 剩余分钟数，null 表示无限制
 */
async function getRemainingPlayTime(userId) {
  const check = await checkUserCanPlay(userId);
  
  if (!check.canPlay) {
    return 0;
  }
  
  return check.remainingMinutes;
}

/**
 * 定时检查并强制下线超时用户（由定时任务调用）
 */
async function enforcePlayTimeLimits() {
  // 获取今日所有游戏中的未成年用户
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await query(`
    SELECT DISTINCT upt.user_id
    FROM user_play_time_daily upt
    JOIN user_age_profiles uap ON uap.user_id = upt.user_id
    WHERE upt.play_date = $1
      AND uap.age_bracket IN ('under_13', '13_17')
      AND uap.parent_consent_status IN ('verified', 'not_required')
  `, [today]);
  
  const violations = [];
  
  for (const row of rows) {
    const check = await checkUserCanPlay(row.user_id);
    
    if (!check.canPlay && check.code === 'DAILY_LIMIT_EXCEEDED') {
      await forceLogout(row.user_id, check.reason, {
        code: check.code,
        playedMinutes: check.playedMinutes,
        limitMinutes: check.limitMinutes
      });
      violations.push(row.user_id);
    }
  }
  
  return {
    checked: rows.length,
    violations: violations.length,
    users: violations
  };
}

/**
 * 定时检查宵禁用户（由定时任务调用）
 */
async function enforceCurfew() {
  // 获取所有在线的未成年用户
  const redis = getRedis();
  const onlineKey = 'online:minors';
  const onlineUsers = await redis.smembers(onlineKey);
  
  const violations = [];
  
  for (const userId of onlineUsers) {
    const check = await checkUserCanPlay(userId);
    
    if (!check.canPlay && check.code === 'CURFEW') {
      await forceLogout(userId, check.reason, {
        code: check.code,
        curfewEndsAt: check.curfewEndsAt
      });
      violations.push(userId);
    }
  }
  
  return {
    checked: onlineUsers.length,
    violations: violations.length,
    users: violations
  };
}

/**
 * 添加用户到在线未成年用户集合
 */
async function markMinorOnline(userId) {
  const redis = getRedis();
  const profile = await getAgeProfile(userId);
  
  if (profile && isMinor(profile)) {
    await redis.sadd('online:minors', userId);
  }
}

/**
 * 从在线未成年用户集合移除
 */
async function markMinorOffline(userId) {
  const redis = getRedis();
  await redis.srem('online:minors', userId);
}

module.exports = {
  CURFEW_CONFIG,
  DAILY_LIMITS,
  checkCurfewTime,
  getDailyPlayTimeLimit,
  getTodayPlayedMinutes,
  checkUserCanPlay,
  recordPlayTimeIncrement,
  forceLogout,
  checkForceLogout,
  clearForceLogout,
  getRemainingPlayTime,
  enforcePlayTimeLimits,
  enforceCurfew,
  markMinorOnline,
  markMinorOffline
};