/**
 * 管理员天赋配置 API
 */

import express from 'express';
import db from '../db/index.js';
import logger from '../../../shared/logger.js';
import { requireAdmin, requirePermission } from '../../../shared/middleware/auth.js';

const router = express.Router();

/**
 * GET /api/admin/talents
 * 获取所有天赋定义
 */
router.get('/talents', requireAdmin, async (req, res) => {
  try {
    const { category, limit = 100, offset = 0 } = req.query;

    let query = 'SELECT * FROM talent_definitions';
    const params = [];

    if (category) {
      query += ' WHERE category = $1';
      params.push(category);
    }

    query += ` ORDER BY category, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (error) {
    logger.error('Failed to get talent definitions', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/talents
 * 创建新的天赋定义
 */
router.post('/talents', requireAdmin, async (req, res) => {
  try {
    const {
      id,
      name,
      description,
      category,
      maxLevel = 3,
      costPerLevel = 1,
      effects = {},
      prerequisites = [],
      unlockCondition = {},
      pokemonTypes = []
    } = req.body;

    if (!id || !name || !category) {
      return res.status(400).json({ error: 'Missing required fields: id, name, category' });
    }

    const result = await db.query(`
      INSERT INTO talent_definitions 
        (id, name, description, category, max_level, cost_per_level, effects, prerequisites, unlock_condition, pokemon_types)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      id, name, description, category, maxLevel, costPerLevel,
      JSON.stringify(effects), JSON.stringify(prerequisites),
      JSON.stringify(unlockCondition), JSON.stringify(pokemonTypes)
    ]);

    logger.info('Talent definition created', { talentId: id, by: req.user.id });

    res.status(201).json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'Talent ID already exists' });
    }
    logger.error('Failed to create talent definition', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/talents/:talentId
 * 更新天赋定义
 */
router.put('/talents/:talentId', requireAdmin, async (req, res) => {
  try {
    const { talentId } = req.params;
    const updates = req.body;

    const allowedFields = ['name', 'description', 'category', 'max_level', 'cost_per_level', 
                          'effects', 'prerequisites', 'unlock_condition', 'pokemon_types'];
    const setClauses = [];
    const params = [talentId];
    let paramIndex = 2;

    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key === 'maxLevel' ? 'max_level' : 
                   key === 'costPerLevel' ? 'cost_per_level' :
                   key === 'pokemonTypes' ? 'pokemon_types' : key;
      
      if (allowedFields.includes(dbKey)) {
        setClauses.push(`${dbKey} = $${paramIndex}`);
        params.push(typeof value === 'object' ? JSON.stringify(value) : value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    const result = await db.query(`
      UPDATE talent_definitions 
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING *
    `, params);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Talent not found' });
    }

    logger.info('Talent definition updated', { talentId, by: req.user.id });

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Failed to update talent definition', { error, talentId: req.params.talentId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/talents/:talentId
 * 删除天赋定义
 */
router.delete('/talents/:talentId', requireAdmin, async (req, res) => {
  try {
    const { talentId } = req.params;

    const result = await db.query(`
      DELETE FROM talent_definitions WHERE id = $1 RETURNING id
    `, [talentId]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Talent not found' });
    }

    logger.info('Talent definition deleted', { talentId, by: req.user.id });

    res.json({
      success: true,
      message: 'Talent deleted successfully'
    });

  } catch (error) {
    logger.error('Failed to delete talent definition', { error, talentId: req.params.talentId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/talent-trees
 * 获取所有天赋树定义
 */
router.get('/talent-trees', requireAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM talent_tree_definitions ORDER BY pokemon_type');

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    logger.error('Failed to get talent trees', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/talent-trees
 * 创建天赋树定义
 */
router.post('/talent-trees', requireAdmin, async (req, res) => {
  try {
    const { pokemonType, branches, totalTalentPoints = 15 } = req.body;

    if (!pokemonType || !branches) {
      return res.status(400).json({ error: 'Missing required fields: pokemonType, branches' });
    }

    const result = await db.query(`
      INSERT INTO talent_tree_definitions (pokemon_type, branches, total_talent_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (pokemon_type) DO UPDATE SET 
        branches = $2, 
        total_talent_points = $3, 
        updated_at = CURRENT_TIMESTAMP,
        version = talent_tree_definitions.version + 1
      RETURNING *
    `, [pokemonType, JSON.stringify(branches), totalTalentPoints]);

    logger.info('Talent tree created/updated', { pokemonType, by: req.user.id });

    res.status(201).json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Failed to create talent tree', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/talent-stats
 * 获取天赋系统统计信息
 */
router.get('/talent-stats', requireAdmin, async (req, res) => {
  try {
    // 天赋分配统计
    const allocationStats = await db.query(`
      SELECT 
        key AS talent_id,
        COUNT(*) as pokemon_count,
        AVG(value::int) as avg_level
      FROM pokemon_talent_config, jsonb_each(allocated_talents) AS t(key, value)
      GROUP BY key
      ORDER BY pokemon_count DESC
      LIMIT 20
    `);

    // 按精灵类型统计
    const typeStats = await db.query(`
      SELECT 
        p.type,
        COUNT(DISTINCT p.id) as pokemon_count,
        AVG(ptc.used_points) as avg_used_points,
        AVG(ptc.total_points) as avg_total_points
      FROM pokemon p
      LEFT JOIN pokemon_talent_config ptc ON p.id = ptc.pokemon_id
      GROUP BY p.type
      ORDER BY pokemon_count DESC
    `);

    // 重置统计
    const resetStats = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as reset_count,
        AVG(refunded_points) as avg_refunded_points
      FROM talent_reset_logs
      WHERE created_at > CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({
      success: true,
      data: {
        allocationStats: allocationStats.rows,
        typeStats: typeStats.rows,
        resetStats: resetStats.rows
      }
    });

  } catch (error) {
    logger.error('Failed to get talent stats', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/grant-talent-points
 * 给指定精灵发放天赋点
 */
router.post('/grant-talent-points', requireAdmin, async (req, res) => {
  try {
    const { pokemonId, points, reason } = req.body;

    if (!pokemonId || !points || points < 1) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const result = await db.query(`
      INSERT INTO pokemon_talent_config (pokemon_id, total_points, point_sources)
      VALUES ($1, $2, jsonb_build_array(jsonb_build_object('source', 'admin_grant', 'points', $2, 'reason', $3, 'timestamp', EXTRACT(EPOCH FROM CURRENT_TIMESTAMP), 'granted_by', $4)))
      ON CONFLICT (pokemon_id) DO UPDATE SET
        total_points = pokemon_talent_config.total_points + $2,
        point_sources = pokemon_talent_config.point_sources || jsonb_build_object('source', 'admin_grant', 'points', $2, 'reason', $3, 'timestamp', EXTRACT(EPOCH FROM CURRENT_TIMESTAMP), 'granted_by', $4),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [pokemonId, points, reason || 'Admin grant', req.user.id]);

    logger.info('Talent points granted', { pokemonId, points, reason, by: req.user.id });

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Failed to grant talent points', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;