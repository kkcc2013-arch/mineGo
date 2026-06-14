/**
 * 区域管理 REST API
 * 
 * 端点：
 * - GET  /api/v2/region/config     - 获取当前区域配置
 * - GET  /api/v2/regions           - 获取区域列表
 * - GET  /api/v2/regions/:code     - 获取区域详情
 * - POST /api/v2/admin/regions     - 创建区域（管理员）
 * - GET  /api/v2/admin/regions/:code/pokemon-weights - 获取区域精灵权重
 * - POST /api/v2/admin/regions/:code/pokemon-weights - 设置精灵权重
 * - GET  /api/v2/admin/regions/:code/events - 获取区域活动
 * - POST /api/v2/admin/regions/:code/events - 创建区域活动
 * - GET  /api/v2/admin/regions/:code/compliance - 获取合规规则
 * - POST /api/v2/admin/regions/:code/compliance - 创建合规规则
 * 
 * @module routes/region
 * @requirement REQ-00083
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { getRegionManager } = require('../RegionManager');
const { createLogger } = require('../logger');
const { authMiddleware, adminMiddleware } = require('../auth');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const regionManager = getRegionManager();
const logger = createLogger('region-routes');

// =====================================================
// 公开 API
// =====================================================

/**
 * GET /api/v2/region/config
 * 获取当前区域配置（客户端使用）
 * 
 * Query: lat, lng
 */
router.get('/config', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({
        error: 'MISSING_COORDINATES',
        message: 'Latitude and longitude are required'
      });
    }
    
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({
        error: 'INVALID_COORDINATES',
        message: 'Invalid latitude or longitude'
      });
    }
    
    const config = await regionManager.getRegionConfig(latitude, longitude);
    
    // 更新用户区域映射
    if (req.user?.id) {
      await regionManager.updateUserRegion(req.user.id, config.region.code);
    }
    
    res.json({
      success: true,
      data: config
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get region config');
    res.status(500).json({
      error: 'REGION_CONFIG_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/regions
 * 获取所有区域列表
 */
router.get('/', async (req, res) => {
  try {
    const { level, active } = req.query;
    
    const result = await pool.query(`
      SELECT 
        code, name, level, timezone, currency, language, is_active
      FROM regions
      WHERE ($1::text IS NULL OR level = $1)
        AND ($2::boolean IS NULL OR is_active = $2)
      ORDER BY code
    `, [level, active]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get regions');
    res.status(500).json({
      error: 'REGIONS_FETCH_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/regions/:code
 * 获取区域详情
 */
router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM regions WHERE code = $1',
      [code]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'REGION_NOT_FOUND',
        message: `Region ${code} not found`
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get region');
    res.status(500).json({
      error: 'REGION_FETCH_FAILED',
      message: err.message
    });
  }
});

// =====================================================
// 管理员 API
// =====================================================

/**
 * POST /api/v2/admin/regions
 * 创建新区域
 */
router.post('/admin/regions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {
      code,
      name,
      level,
      parent_code,
      timezone,
      currency,
      language,
      geo_bounds,
      compliance_rules
    } = req.body;
    
    if (!code || !name || !level) {
      return res.status(400).json({
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'code, name, and level are required'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO regions (
        code, name, level, parent_code, timezone, currency, language,
        geo_bounds, compliance_rules
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      code, name, level, parent_code, timezone, currency, language,
      JSON.stringify(geo_bounds), JSON.stringify(compliance_rules)
    ]);
    
    logger.info({ code, name, level, by: req.user.id }, 'Region created');
    
    res.status(201).json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create region');
    
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'REGION_EXISTS',
        message: 'Region with this code already exists'
      });
    }
    
    res.status(500).json({
      error: 'REGION_CREATE_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/admin/regions/:code/pokemon-weights
 * 获取区域精灵权重配置
 */
router.get('/admin/regions/:code/pokemon-weights', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const { active_only } = req.query;
    
    let query = `
      SELECT 
        rpw.id, rpw.pokemon_id, rpw.spawn_weight, rpw.is_exclusive,
        rpw.start_date, rpw.end_date, rpw.created_at
      FROM region_pokemon_weights rpw
      WHERE rpw.region_code = $1
    `;
    
    if (active_only === 'true') {
      query += `
        AND (rpw.start_date IS NULL OR rpw.start_date <= NOW())
        AND (rpw.end_date IS NULL OR rpw.end_date >= NOW())
      `;
    }
    
    query += ' ORDER BY rpw.pokemon_id';
    
    const result = await pool.query(query, [code]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get pokemon weights');
    res.status(500).json({
      error: 'WEIGHTS_FETCH_FAILED',
      message: err.message
    });
  }
});

/**
 * POST /api/v2/admin/regions/:code/pokemon-weights
 * 设置精灵权重
 */
router.post('/admin/regions/:code/pokemon-weights', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const { pokemon_id, spawn_weight, is_exclusive, start_date, end_date } = req.body;
    
    if (!pokemon_id) {
      return res.status(400).json({
        error: 'MISSING_POKEMON_ID',
        message: 'pokemon_id is required'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO region_pokemon_weights (
        region_code, pokemon_id, spawn_weight, is_exclusive, start_date, end_date
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (region_code, pokemon_id)
      DO UPDATE SET
        spawn_weight = EXCLUDED.spawn_weight,
        is_exclusive = EXCLUDED.is_exclusive,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        updated_at = NOW()
      RETURNING *
    `, [code, pokemon_id, spawn_weight || 1.0, is_exclusive || false, start_date, end_date]);
    
    // 清除缓存
    await regionManager.clearCache();
    
    logger.info({
      region: code,
      pokemon_id,
      weight: spawn_weight,
      exclusive: is_exclusive,
      by: req.user.id
    }, 'Pokemon weight set');
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to set pokemon weight');
    res.status(500).json({
      error: 'WEIGHT_SET_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/admin/regions/:code/events
 * 获取区域活动
 */
router.get('/admin/regions/:code/events', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const { active_only } = req.query;
    
    let query = `
      SELECT * FROM region_events
      WHERE $1 = ANY(region_codes)
    `;
    
    if (active_only === 'true') {
      query += ' AND is_active = true AND end_time >= NOW()';
    }
    
    query += ' ORDER BY start_time DESC';
    
    const result = await pool.query(query, [code]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get region events');
    res.status(500).json({
      error: 'EVENTS_FETCH_FAILED',
      message: err.message
    });
  }
});

/**
 * POST /api/v2/admin/regions/:code/events
 * 创建区域活动
 */
router.post('/admin/regions/:code/events', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const {
      event_id,
      title,
      description,
      event_type,
      bonuses,
      start_time,
      end_time,
      region_codes
    } = req.body;
    
    // 验证必填字段
    if (!event_id || !title || !event_type || !bonuses || !start_time || !end_time) {
      return res.status(400).json({
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'event_id, title, event_type, bonuses, start_time, end_time are required'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO region_events (
        event_id, region_codes, title, description, event_type,
        bonuses, start_time, end_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      event_id,
      region_codes || [code],
      JSON.stringify(title),
      JSON.stringify(description || {}),
      event_type,
      JSON.stringify(bonuses),
      start_time,
      end_time
    ]);
    
    // 清除缓存
    await regionManager.clearCache();
    
    logger.info({
      event_id,
      region: code,
      type: event_type,
      by: req.user.id
    }, 'Region event created');
    
    res.status(201).json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create region event');
    res.status(500).json({
      error: 'EVENT_CREATE_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/admin/regions/:code/compliance
 * 获取合规规则
 */
router.get('/admin/regions/:code/compliance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const { content_type } = req.query;
    
    const result = await pool.query(`
      SELECT * FROM compliance_rules
      WHERE region_code = $1
        AND ($2::text IS NULL OR content_type = $2)
      ORDER BY content_type, content_id NULLS FIRST
    `, [code, content_type]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get compliance rules');
    res.status(500).json({
      error: 'COMPLIANCE_FETCH_FAILED',
      message: err.message
    });
  }
});

/**
 * POST /api/v2/admin/regions/:code/compliance
 * 创建合规规则
 */
router.post('/admin/regions/:code/compliance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const {
      content_type,
      content_id,
      filter_action,
      modified_content,
      reason
    } = req.body;
    
    if (!content_type || !filter_action) {
      return res.status(400).json({
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'content_type and filter_action are required'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO compliance_rules (
        region_code, content_type, content_id, filter_action,
        modified_content, reason
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [code, content_type, content_id, filter_action, JSON.stringify(modified_content), reason]);
    
    // 清除缓存
    await regionManager.clearCache();
    
    logger.info({
      region: code,
      content_type,
      content_id,
      action: filter_action,
      by: req.user.id
    }, 'Compliance rule created');
    
    res.status(201).json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create compliance rule');
    res.status(500).json({
      error: 'COMPLIANCE_CREATE_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/v2/admin/regions/stats
 * 获取区域统计数据
 */
router.get('/admin/regions/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        r.code,
        r.name,
        r.level,
        COUNT(DISTINCT ur.user_id) as user_count,
        COUNT(DISTINCT rpw.pokemon_id) as pokemon_weights_count,
        COUNT(DISTINCT cr.id) as compliance_rules_count
      FROM regions r
      LEFT JOIN user_regions ur ON ur.region_code = r.code
      LEFT JOIN region_pokemon_weights rpw ON rpw.region_code = r.code
      LEFT JOIN compliance_rules cr ON cr.region_code = r.code
      WHERE r.is_active = true
      GROUP BY r.code, r.name, r.level
      ORDER BY user_count DESC
    `);
    
    res.json({
      success: true,
      data: stats.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get region stats');
    res.status(500).json({
      error: 'STATS_FETCH_FAILED',
      message: err.message
    });
  }
});

module.exports = router;
