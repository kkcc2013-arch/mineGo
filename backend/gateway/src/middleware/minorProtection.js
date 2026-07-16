// gateway/src/middleware/minorProtection.js
// REQ-00578: 未成年人保护中间件（宵禁 + 时长限制）

'use strict';

const {
  checkUserCanPlay,
  checkForceLogout,
  recordPlayTimeIncrement,
  markMinorOnline,
  markMinorOffline,
  getRemainingPlayTime
} = require('@pmg/shared/minorPlayTimeService');
const { getAgeProfile, isMinor } = require('@pmg/shared/ageVerification');
const { AppError } = require('@pmg/shared/auth');

/**
 * 未成年人保护检查中间件
 * 在每个游戏请求前检查宵禁和时长限制
 */
async function minorProtectionMiddleware(req, res, next) {
  try {
    // 跳过不需要检查的路径
    const skipPaths = [
      '/health',
      '/metrics',
      '/auth/',
      '/age/',
      '/parent/',
      '/compliance/',
      '/data-deletion/',
      '/privacy/',
      '/ip-appeal/'
    ];
    
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // 检查用户是否登录
    if (!req.user || !req.user.id) {
      return next();
    }
    
    // 检查是否被强制下线
    const forceLogoutCheck = await checkForceLogout(req.user.id);
    if (forceLogoutCheck.forced) {
      throw new AppError(
        4034,
        forceLogoutCheck.reason || '您已被强制下线',
        403,
        { code: forceLogoutCheck.code || 'FORCE_LOGOUT' }
      );
    }
    
    // 获取年龄档案
    const profile = await getAgeProfile(req.user.id);
    
    // 非未成年人，跳过保护检查
    if (!profile || !isMinor(profile)) {
      return next();
    }
    
    // 获取用户时区（从请求头或默认中国时区）
    const timezone = req.headers['x-timezone'] || 'Asia/Shanghai';
    
    // 检查用户是否可以继续游戏
    const canPlayCheck = await checkUserCanPlay(req.user.id, timezone);
    
    if (!canPlayCheck.canPlay) {
      const errorCode = canPlayCheck.code || 'PROTECTION';
      
      throw new AppError(
        4034,
        canPlayCheck.reason,
        403,
        { 
          code: errorCode,
          playedMinutes: canPlayCheck.playedMinutes,
          limitMinutes: canPlayCheck.limitMinutes,
          curfewEndsAt: canPlayCheck.curfewEndsAt?.toISOString()
        }
      );
    }
    
    // 在响应头中添加剩余时间信息
    if (canPlayCheck.remainingMinutes !== null && canPlayCheck.remainingMinutes !== undefined) {
      res.set('X-Play-Time-Remaining', String(canPlayCheck.remainingMinutes));
      res.set('X-Play-Time-Limit', String(canPlayCheck.limitMinutes));
      res.set('X-Play-Time-Used', String(canPlayCheck.playedMinutes));
    }
    
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 游戏时长追踪中间件
 * 在请求结束后记录游戏时长
 */
function playTimeTrackingMiddleware() {
  return async (req, res, next) => {
    const startTime = Date.now();
    
    // 监听响应完成事件
    res.on('finish', async () => {
      try {
        // 只记录成功的游戏相关请求
        if (res.statusCode >= 200 && res.statusCode < 300 && req.user && req.user.id) {
          const profile = await getAgeProfile(req.user.id);
          
          if (profile && isMinor(profile)) {
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            // 每30秒记录一次，向上取整
            const minutes = Math.max(1, Math.ceil(elapsedSeconds / 60));
            
            // 使用请求ID作为会话去重键
            const sessionId = req.headers['x-request-id'] || req.id;
            await recordPlayTimeIncrement(req.user.id, minutes, sessionId);
          }
        }
      } catch (err) {
        console.error('[MinorProtection] Failed to track play time:', err);
      }
    });
    
    next();
  };
}

/**
 * 登录后检查未成年用户状态
 */
async function minorLoginCheckMiddleware(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return next();
    }
    
    const profile = await getAgeProfile(req.user.id);
    
    if (!profile || !isMinor(profile)) {
      return next();
    }
    
    // 获取用户时区
    const timezone = req.headers['x-timezone'] || 'Asia/Shanghai';
    
    // 检查是否可以游戏
    const canPlayCheck = await checkUserCanPlay(req.user.id, timezone);
    
    // 标记未成年用户在线
    await markMinorOnline(req.user.id);
    
    // 在登录响应中包含保护信息
    if (res.locals && res.locals.loginResponse) {
      res.locals.loginResponse.minorProtection = {
        isMinor: true,
        ageBracket: profile.age_bracket,
        remainingMinutes: canPlayCheck.remainingMinutes,
        limitMinutes: canPlayCheck.limitMinutes,
        canPlay: canPlayCheck.canPlay,
        reason: canPlayCheck.reason
      };
    }
    
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 登出时清除在线状态
 */
async function minorLogoutCleanupMiddleware(req, res, next) {
  try {
    if (req.user && req.user.id) {
      await markMinorOffline(req.user.id);
    }
    next();
  } catch (err) {
    console.error('[MinorProtection] Failed to cleanup on logout:', err);
    next();
  }
}

/**
 * 获取剩余游戏时间路由处理器
 */
async function getRemainingTimeHandler(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ code: 1001, message: '未登录' });
    }
    
    const remaining = await getRemainingPlayTime(req.user.id);
    const profile = await getAgeProfile(req.user.id);
    
    res.json({
      isMinor: profile ? isMinor(profile) : false,
      remainingMinutes: remaining,
      limitMinutes: profile?.daily_play_limit_minutes || null,
      ageBracket: profile?.age_bracket || null
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  minorProtectionMiddleware,
  playTimeTrackingMiddleware,
  minorLoginCheckMiddleware,
  minorLogoutCleanupMiddleware,
  getRemainingTimeHandler
};