'use strict';

/**
 * 位置验证路由
 * REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
 */

const express = require('express');
const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { requireAuth, successResp, AppError } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { locationTrustEngine } = require('../locationTrustEngine');
const { locationAnomalyDetector } = require('../../../../analysis/src/locationAnomalyDetector');
const { locationSpoofResponse } = require('../../../../security/src/locationSpoofResponse');

const logger = createLogger('location-verify-route');
const router = express.Router();

/**
 * POST /api/v1/location/verify
 * 验证位置可信度
 */
router.post('/verify', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { location, deviceRisk, context } = req.body;

    if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
      throw new AppError('Invalid location data', 400);
    }

    // 计算位置可信度
    const trustResult = await locationTrustEngine.calculateLocationTrustScore(
      userId,
      location,
      deviceRisk,
      context
    );

    // 运行异常检测
    const anomalyResult = await locationAnomalyDetector.runFullDetection(userId, location);

    // 计算综合风险
    const overallRisk = Math.max(
      100 - trustResult.trustScore,
      anomalyResult.overallRisk
    );

    // 如果风险高，执行反制措施
    let actionTaken = null;
    if (overallRisk >= 30) {
      actionTaken = await locationSpoofResponse.executeCountermeasure(
        userId,
        overallRisk,
        {
          trustResult,
          anomalyResult,
          location,
          context
        }
      );
    }

    // 保存当前位置
    await locationTrustEngine.saveCurrentLocation(userId, {
      ...location,
      timestamp: location.timestamp || Date.now()
    });

    // 更新用户位置到 GEO 集合（用于协同检测）
    const redis = await getRedis();
    await redis.geoadd('user:locations', location.longitude, location.latitude, userId);

    // 构建响应
    const response = {
      trustScore: trustResult.trustScore,
      riskLevel: trustResult.riskLevel,
      recommendation: trustResult.recommendation,
      overallRisk,
      requestId: `loc-${Date.now()}-${userId}`
    };

    // 如果有限制，添加到响应
    if (actionTaken && actionTaken.restrictions) {
      response.restrictions = actionTaken.restrictions;
      response.action = actionTaken.action;
    }

    successResp(res, response);
  } catch (error) {
    logger.error({ error, body: req.body }, 'Location verification failed');
    next(error);
  }
});

/**
 * POST /api/v1/location/report
 * 上报位置（客户端定期上报）
 */
router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { location, deviceRisk } = req.body;

    if (!location) {
      throw new AppError('Location required', 400);
    }

    // 保存位置
    await locationTrustEngine.saveCurrentLocation(userId, {
      ...location,
      timestamp: location.timestamp || Date.now()
    });

    // 更新 GEO 集合
    const redis = await getRedis();
    await redis.geoadd('user:locations', location.longitude, location.latitude, userId);

    // 如果有设备风险，进行验证
    if (deviceRisk && deviceRisk.score > 30) {
      const trustResult = await locationTrustEngine.calculateLocationTrustScore(
        userId,
        location,
        deviceRisk,
        { action: 'report' }
      );

      if (trustResult.trustScore < 70) {
        // 低信任度，执行反制
        await locationSpoofResponse.executeCountermeasure(
          userId,
          100 - trustResult.trustScore,
          { trustResult, location, deviceRisk }
        );
      }
    }

    successResp(res, { reported: true, timestamp: Date.now() });
  } catch (error) {
    logger.error({ error }, 'Location report failed');
    next(error);
  }
});

/**
 * GET /api/v1/location/restrictions
 * 获取用户当前限制
 */
router.get('/restrictions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    const restrictions = await locationSpoofResponse.getRestrictions(userId);
    const banStatus = await locationSpoofResponse.isBanned(userId);

    successResp(res, {
      restrictions,
      banned: banStatus.banned,
      banInfo: banStatus.banned ? {
        type: banStatus.type,
        reason: banStatus.reason,
        expiresAt: banStatus.expiresAt
      } : null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/location/device-check
 * 设备风险检查
 */
router.post('/device-check', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { mockLocationApps, developerMode, mockProviders, jailbroken } = req.body;

    // 计算设备风险分数
    let deviceRiskScore = 0;
    const flags = [];

    if (mockLocationApps && mockLocationApps.length > 0) {
      deviceRiskScore += 40;
      flags.push('mock_location_apps');
    }

    if (developerMode) {
      deviceRiskScore += 20;
      flags.push('developer_mode');
    }

    if (mockProviders && mockProviders.length > 0) {
      deviceRiskScore += 30;
      flags.push('mock_providers');
    }

    if (jailbroken) {
      deviceRiskScore += 50;
      flags.push('jailbroken');
    }

    deviceRiskScore = Math.min(deviceRiskScore, 100);

    // 缓存设备风险
    const redis = await getRedis();
    await redis.set(`device:risk:${userId}`, JSON.stringify({
      score: deviceRiskScore,
      flags,
      timestamp: Date.now()
    }), 'EX', 3600);

    successResp(res, {
      riskScore: deviceRiskScore,
      riskLevel: locationSpoofResponse.getRiskLevel(deviceRiskScore),
      flags,
      recommendation: deviceRiskScore >= 50 ? 'deny' : deviceRiskScore >= 30 ? 'monitor' : 'allow'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/location/check-action
 * 检查某动作是否允许（用于捕捉、道馆等）
 */
router.post('/check-action', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { action, location, targetId } = req.body;

    // 检查是否被封禁
    const banStatus = await locationSpoofResponse.isBanned(userId);
    if (banStatus.banned) {
      throw new AppError('Account is suspended', 403);
    }

    // 检查限制
    const restrictions = await locationSpoofResponse.getRestrictions(userId);

    if (restrictions) {
      const restrictionMap = restrictions.restrictions || {};

      // 检查动作是否被限制
      if (action === 'catch' && restrictionMap.catch === false) {
        throw new AppError('Catch action is restricted', 403);
      }
      if (action === 'gym' && restrictionMap.gymAccess === false) {
        throw new AppError('Gym action is restricted', 403);
      }
      if (action === 'pokestop' && restrictionMap.pokestop === false) {
        throw new AppError('Pokestop action is restricted', 403);
      }
      if (action === 'trade' && restrictionMap.tradeRestricted) {
        throw new AppError('Trade action is restricted', 403);
      }

      // 应用惩罚（如稀有度降低）
      const penalties = {};
      if (restrictionMap.rareSpawnPenalty) {
        penalties.rareSpawnPenalty = restrictionMap.rareSpawnPenalty;
      }
      if (restrictionMap.pokestopBonus) {
        penalties.pokestopBonus = restrictionMap.pokestopBonus;
      }

      successResp(res, {
        allowed: true,
        penalties: Object.keys(penalties).length > 0 ? penalties : null
      });
    } else {
      successResp(res, { allowed: true, penalties: null });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;