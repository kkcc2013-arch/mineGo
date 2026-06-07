// gateway/src/middleware/ageRestriction.js
// REQ-00034: 年龄限制中间件

'use strict';

const { getAgeProfile, checkPlayTimeLimit, isMinor, isFeatureDisabled } = require('../../shared/ageVerification');
const { AppError } = require('../../shared/auth');

/**
 * 检查游戏时间限制中间件
 * 用于限制未成年人的游戏时间
 */
async function checkPlayTimeLimitMiddleware(req, res, next) {
  try {
    // 跳过不需要限制的路径
    const skipPaths = [
      '/health',
      '/metrics',
      '/auth/',
      '/age/',
      '/parent/'
    ];
    
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // 检查用户是否登录
    if (!req.user || !req.user.id) {
      return next();
    }
    
    // 检查年龄档案
    const profile = await getAgeProfile(req.user.id);
    
    if (!profile || !isMinor(profile)) {
      // 非未成年人，不限制
      return next();
    }
    
    // 检查游戏时间
    const limitCheck = await checkPlayTimeLimit(req.user.id);
    
    if (!limitCheck.withinLimit) {
      console.warn(`[COPPA] User ${req.user.id} exceeded daily play limit: ${limitCheck.currentMinutes}/${limitCheck.limitMinutes} minutes`);
      
      throw new AppError(
        4031,
        limitCheck.message || '今日游戏时间已达上限，请明日再来',
        403
      );
    }
    
    // 将剩余时间添加到响应头
    if (limitCheck.remainingMinutes !== undefined) {
      res.set('X-Play-Time-Remaining', limitCheck.remainingMinutes);
    }
    
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 检查功能限制中间件
 * 用于限制未成年人访问特定功能
 */
function checkFeatureRestriction(feature) {
  return async (req, res, next) => {
    try {
      // 检查用户是否登录
      if (!req.user || !req.user.id) {
        return next();
      }
      
      // 检查年龄档案
      const profile = await getAgeProfile(req.user.id);
      
      if (!profile || !isMinor(profile)) {
        // 非未成年人，不限制
        return next();
      }
      
      // 检查功能是否被禁用
      if (isFeatureDisabled(profile, feature)) {
        console.warn(`[COPPA] User ${req.user.id} attempted to access disabled feature: ${feature}`);
        
        throw new AppError(
          4032,
          `此功能对未成年人不可用`,
          403
        );
      }
      
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * 检查登录权限中间件
 * 用于验证13岁以下用户是否已获得家长同意
 */
async function checkLoginPermissionMiddleware(req, res, next) {
  try {
    // 此中间件在登录后使用
    if (!req.user || !req.user.id) {
      return next();
    }
    
    const { canUserLogin, getAgeProfile, AGE_BRACKETS } = require('../../shared/ageVerification');
    
    const profile = await getAgeProfile(req.user.id);
    
    // 没有年龄档案，允许登录（兼容旧用户）
    if (!profile) {
      return next();
    }
    
    // 13岁以下用户检查
    if (profile.age_bracket === AGE_BRACKETS.UNDER_13) {
      const permission = await canUserLogin(req.user.id);
      
      if (!permission.canLogin) {
        console.warn(`[COPPA] User ${req.user.id} login denied: ${permission.reason}`);
        
        throw new AppError(
          4033,
          permission.message,
          403,
          { reason: permission.reason }
        );
      }
    }
    
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 记录游戏时间中间件
 * 在请求结束时记录游戏时间
 */
function trackPlayTimeMiddleware() {
  return async (req, res, next) => {
    // 记录请求开始时间
    const startTime = Date.now();
    
    // 监听响应完成事件
    res.on('finish', async () => {
      try {
        // 只记录成功的游戏相关请求
        if (res.statusCode >= 200 && res.statusCode < 300 && req.user && req.user.id) {
          const { getAgeProfile, isMinor, recordPlayTime } = require('../../shared/ageVerification');
          
          const profile = await getAgeProfile(req.user.id);
          
          if (profile && isMinor(profile)) {
            // 计算本次游戏时间（秒转分钟，向上取整）
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            const minutes = Math.ceil(elapsedSeconds / 60);
            
            // 最少记录1分钟
            if (minutes > 0) {
              await recordPlayTime(req.user.id, minutes);
              console.log(`[COPPA] Recorded ${minutes} min play time for user ${req.user.id}`);
            }
          }
        }
      } catch (err) {
        console.error('[COPPA] Failed to track play time:', err);
      }
    });
    
    next();
  };
}

module.exports = {
  checkPlayTimeLimitMiddleware,
  checkFeatureRestriction,
  checkLoginPermissionMiddleware,
  trackPlayTimeMiddleware
};
