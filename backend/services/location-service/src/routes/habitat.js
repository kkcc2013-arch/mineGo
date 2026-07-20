// backend/services/location-service/src/routes/habitat.js
// REQ-00361: 精灵栖息地偏好与环境加成系统

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, successResp, AppError } = require('../../../../shared/auth');
const { habitatService } = require('../../../../shared/habitatService');

/**
 * GET /api/habitat/current
 * 获取当前位置的栖息地类型
 */
router.get('/current', requireAuth, async (req, res, next) => {
  try {
    const { lat, lon } = req.query;
    
    if (!lat || !lon) {
      throw new AppError('缺少位置参数：lat, lon', 400);
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    
    if (isNaN(latitude) || isNaN(longitude)) {
      throw new AppError('位置参数格式错误', 400);
    }

    // 识别栖息地类型
    const habitat = await habitatService.identifyHabitat(latitude, longitude);
    
    // 更新用户缓存
    await habitatService.updateUserHabitatCache(req.user.id, latitude, longitude);
    
    // 获取栖息地详细信息
    const allHabitats = await habitatService.getAllHabitats();
    const habitatInfo = allHabitats.find(h => h.id === habitat.primary);

    return successResp(res, {
      habitat: {
        primary: habitat.primary,
        secondary: habitat.secondary,
        confidence: habitat.confidence,
        source: habitat.source,
        name: habitatInfo?.name || habitat.primary,
        name_en: habitatInfo?.name_en || habitat.primary,
        description: habitatInfo?.description,
        icon_url: habitatInfo?.icon_url
      },
      location: {
        latitude,
        longitude
      },
      timestamp: new Date()
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/habitat/user/:userId
 * 获取用户缓存的栖息地信息
 */
router.get('/user/:userId', requireAuth, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    
    if (isNaN(userId) || userId !== req.user.id) {
      throw new AppError('无效的用户 ID', 403);
    }

    const habitatCache = await habitatService.getUserHabitatCache(userId);
    
    if (!habitatCache) {
      return successResp(res, {
        habitat: null,
        message: '用户栖息地缓存不存在或已过期'
      });
    }

    const allHabitats = await habitatService.getAllHabitats();
    const habitatInfo = allHabitats.find(h => h.id === habitatCache.primary);

    return successResp(res, {
      habitat: {
        primary: habitatCache.primary,
        secondary: habitatCache.secondary,
        confidence: habitatCache.confidence,
        name: habitatInfo?.name,
        name_en: habitatInfo?.name_en,
        description: habitatInfo?.description
      },
      location: {
        latitude: habitatCache.latitude,
        longitude: habitatCache.longitude
      },
      timestamp: new Date()
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/habitat/recommended-pokemon
 * 获取当前栖息地推荐的精灵列表
 */
router.get('/recommended-pokemon', requireAuth, async (req, res, next) => {
  try {
    const { lat, lon, limit = 10 } = req.query;
    
    if (!lat || !lon) {
      throw new AppError('缺少位置参数：lat, lon', 400);
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    
    // 识别栖息地
    const habitat = await habitatService.identifyHabitat(latitude, longitude);
    
    // 获取推荐精灵
    const recommendedPokemon = await habitatService.getRecommendedPokemon(habitat, parseInt(limit));

    return successResp(res, {
      habitat: habitat,
      recommended_pokemon: recommendedPokemon.map(p => ({
        species_id: p.species_id,
        battle_bonus: parseFloat(p.battle_bonus),
        catch_bonus: parseFloat(p.catch_bonus),
        spawn_boost: parseFloat(p.spawn_boost),
        is_primary: p.is_primary,
        habitat_name: p.habitat_name
      })),
      total: recommendedPokemon.length,
      timestamp: new Date()
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/habitat/types
 * 获取所有栖息地类型列表
 */
router.get('/types', async (req, res, next) => {
  try {
    const habitats = await habitatService.getAllHabitats();

    return successResp(res, {
      habitats: habitats.map(h => ({
        id: h.id,
        name: h.name,
        name_en: h.name_en,
        terrain_features: h.terrain_features,
        description: h.description,
        bonus_multiplier: parseFloat(h.bonus_multiplier),
        icon_url: h.icon_url
      })),
      total: habitats.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/habitat/define-area (Admin)
 * 定义自定义栖息地区域
 */
router.post('/define-area', requireAuth, async (req, res, next) => {
  try {
    const { habitat_id, area_name, center_lat, center_lon, radius_meters = 500 } = req.body;
    
    if (!habitat_id || !area_name || !center_lat || !center_lon) {
      throw new AppError('缺少必要参数：habitat_id, area_name, center_lat, center_lon', 400);
    }

    // 检查用户是否有管理员权限（简化版）
    if (!req.user.is_admin) {
      throw new AppError('需要管理员权限', 403);
    }

    // 插入自定义区域
    const result = await query(`
      INSERT INTO habitat_areas (
        habitat_id, area_name, center_lat, center_lon, radius_meters, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, habitat_id, area_name, center_lat, center_lon, radius_meters
    `, [habitat_id, area_name, center_lat, center_lon, radius_meters, req.user.id]);

    const area = result.rows[0];

    return successResp(res, {
      area: {
        id: area.id,
        habitat_id: area.habitat_id,
        area_name: area.area_name,
        center_lat: parseFloat(area.center_lat),
        center_lon: parseFloat(area.center_lon),
        radius_meters: area.radius_meters,
        created_by: req.user.id
      },
      message: '栖息地区域创建成功'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/habitat/area/:areaId (Admin)
 * 删除自定义栖息地区域
 */
router.delete('/area/:areaId', requireAuth, async (req, res, next) => {
  try {
    const areaId = parseInt(req.params.areaId);
    
    if (isNaN(areaId)) {
      throw new AppError('无效的区域 ID', 400);
    }

    if (!req.user.is_admin) {
      throw new AppError('需要管理员权限', 403);
    }

    await query(`
      UPDATE habitat_areas
      SET is_active = FALSE
      WHERE id = $1
    `, [areaId]);

    return successResp(res, {
      message: '栖息地区域已禁用',
      area_id: areaId
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;