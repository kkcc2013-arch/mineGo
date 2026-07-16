// user-service/src/routes/minorProtection.js
// REQ-00578: 未成年人保护路由

'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redis');
const { authMiddleware } = require('../../../shared/authMiddleware');
const {
  checkCurfewTime,
  getDailyPlayTimeLimit,
  getTodayPlayedMinutes,
  checkUserCanPlay,
  getRemainingPlayTime,
  CURFEW_CONFIG
} = require('../../../shared/minorPlayTimeService');
const { getAgeProfile, isMinor } = require('../../../shared/ageVerification');

/**
 * GET /minor-protection/status
 * 获取当前用户的未成年人保护状态
 */
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const profile = await getAgeProfile(userId);
    const timezone = req.headers['x-timezone'] || 'Asia/Shanghai';
    
    if (!profile || !isMinor(profile)) {
      return res.json({
        isMinor: false,
        protections: null
      });
    }
    
    const canPlay = await checkUserCanPlay(userId, timezone);
    const limitInfo = await getDailyPlayTimeLimit(userId);
    const playedMinutes = await getTodayPlayedMinutes(userId);
    const curfewCheck = checkCurfewTime(timezone);
    
    res.json({
      isMinor: true,
      ageBracket: profile.age_bracket,
      protections: {
        canPlay: canPlay.canPlay,
        reason: canPlay.reason,
        remainingMinutes: canPlay.remainingMinutes,
        playedMinutes,
        limitMinutes: limitInfo.limit,
        curfew: {
          isActive: curfewCheck.isCurfew,
          config: curfewCheck.config || {
            startHour: CURFEW_CONFIG.default.startHour,
            endHour: CURFEW_CONFIG.default.endHour,
            timezone: CURFEW_CONFIG.default.timezone
          },
          endsAt: curfewCheck.endsAt?.toISOString()
        },
        parentConsent: profile.parent_consent_status
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /minor-protection/remaining-time
 * 获取剩余游戏时间
 */
router.get('/remaining-time', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const remaining = await getRemainingPlayTime(userId);
    const profile = await getAgeProfile(userId);
    
    res.json({
      remainingMinutes: remaining,
      limitMinutes: profile?.daily_play_limit_minutes || null,
      isMinor: profile ? isMinor(profile) : false
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /minor-protection/curfew
 * 获取宵禁时间配置
 */
router.get('/curfew', authMiddleware, async (req, res, next) => {
  try {
    const timezone = req.headers['x-timezone'] || 'Asia/Shanghai';
    const curfewCheck = checkCurfewTime(timezone);
    
    res.json({
      isActive: curfewCheck.isCurfew,
      reason: curfewCheck.reason,
      endsAt: curfewCheck.endsAt?.toISOString(),
      config: curfewCheck.config || CURFEW_CONFIG.default
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /minor-protection/heartbeat
 * 游戏客户端心跳，用于实时检查保护状态
 */
router.post('/heartbeat', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const profile = await getAgeProfile(userId);
    
    if (!profile || !isMinor(profile)) {
      return res.json({ canPlay: true });
    }
    
    const timezone = req.headers['x-timezone'] || 'Asia/Shanghai';
    const canPlay = await checkUserCanPlay(userId, timezone);
    
    if (!canPlay.canPlay) {
      return res.json({
        canPlay: false,
        reason: canPlay.reason,
        code: canPlay.code,
        remainingMinutes: 0,
        forceLogout: true
      });
    }
    
    // 记录心跳（1分钟）
    const { recordPlayTimeIncrement } = require('../../../shared/minorPlayTimeService');
    await recordPlayTimeIncrement(userId, 1, `heartbeat:${userId}:${Date.now()}`);
    
    res.json({
      canPlay: true,
      remainingMinutes: canPlay.remainingMinutes,
      playedMinutes: canPlay.playedMinutes,
      limitMinutes: canPlay.limitMinutes
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;