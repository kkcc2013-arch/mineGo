/**
 * 精灵刷新配置路由
 * 运营后台管理接口
 *
 * @module spawnConfig
 */

const express = require('express');
const router = express.Router();

/**
 * 中间件：管理员权限验证
 */
function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }
  next();
}

/**
 * 获取区域配置
 * GET /api/v1/spawn/config/cell/:geohash
 */
router.get('/config/cell/:geohash', async (req, res) => {
  const { geohash } = req.params;

  try {
    const result = await req.db.query(
      'SELECT * FROM spawn_cell_configs WHERE geohash = $1',
      [geohash]
    );

    res.json({
      success: true,
      data: result.rows[0] || {
        geohash,
        baseSpawnCount: 3,
        minSpawn: 1,
        maxSpawn: 10,
        enabled: true
      }
    });
  } catch (error) {
    console.error('Error fetching cell config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cell config'
    });
  }
});

/**
 * 更新区域配置
 * PUT /api/v1/spawn/config/cell/:geohash
 */
router.put('/config/cell/:geohash', adminOnly, async (req, res) => {
  const { geohash } = req.params;
  const {
    baseSpawnCount,
    minSpawn,
    maxSpawn,
    spawnPoolOverride,
    enabled
  } = req.body;

  try {
    await req.db.query(
      `INSERT INTO spawn_cell_configs
        (geohash, base_spawn_count, min_spawn, max_spawn, spawn_pool_override, enabled, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (geohash) DO UPDATE SET
        base_spawn_count = $2,
        min_spawn = $3,
        max_spawn = $4,
        spawn_pool_override = $5,
        enabled = $6,
        updated_at = NOW()`,
      [geohash, baseSpawnCount, minSpawn, maxSpawn, spawnPoolOverride, enabled]
    );

    // 清除缓存
    await req.redis.del(`spawn:config:${geohash}`);

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'update_config',
        'cell',
        geohash,
        { baseSpawnCount, minSpawn, maxSpawn, enabled }
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating cell config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update cell config'
    });
  }
});

/**
 * 批量更新区域配置
 * POST /api/v1/spawn/config/cells/batch
 */
router.post('/config/cells/batch', adminOnly, async (req, res) => {
  const { cells } = req.body; // [{ geohash, baseSpawnCount, minSpawn, maxSpawn, enabled }]

  try {
    await req.db.query('BEGIN');

    for (const cell of cells) {
      await req.db.query(
        `INSERT INTO spawn_cell_configs
          (geohash, base_spawn_count, min_spawn, max_spawn, enabled, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (geohash) DO UPDATE SET
          base_spawn_count = $2,
          min_spawn = $3,
          max_spawn = $4,
          enabled = $5,
          updated_at = NOW()`,
        [cell.geohash, cell.baseSpawnCount, cell.minSpawn, cell.maxSpawn, cell.enabled]
      );

      // 清除缓存
      await req.redis.del(`spawn:config:${cell.geohash}`);
    }

    await req.db.query('COMMIT');

    res.json({
      success: true,
      updated: cells.length
    });
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Error batch updating cell configs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to batch update cell configs'
    });
  }
});

/**
 * 创建活动事件
 * POST /api/v1/spawn/events
 */
router.post('/events', adminOnly, async (req, res) => {
  const {
    name,
    type,
    startTime,
    endTime,
    affectedAreas,
    spawnMultiplier,
    featuredPokemon
  } = req.body;

  try {
    const result = await req.db.query(
      `INSERT INTO spawn_events
        (name, type, start_time, end_time, affected_areas, spawn_multiplier, featured_pokemon)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [name, type, startTime, endTime, JSON.stringify(affectedAreas), spawnMultiplier, featuredPokemon]
    );

    const eventId = result.rows[0].id;

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'create_event',
        'event',
        eventId.toString(),
        { name, type, startTime, endTime, spawnMultiplier }
      ]
    );

    res.json({
      success: true,
      eventId
    });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create event'
    });
  }
});

/**
 * 获取活动列表
 * GET /api/v1/spawn/events
 */
router.get('/events', async (req, res) => {
  const { active, type } = req.query;

  try {
    let query = 'SELECT * FROM spawn_events WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (active === 'true') {
      query += ` AND start_time <= NOW() AND end_time >= NOW() AND enabled = true`;
    }

    if (type) {
      query += ` AND type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    query += ' ORDER BY start_time DESC';

    const result = await req.db.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch events'
    });
  }
});

/**
 * 更新活动事件
 * PUT /api/v1/spawn/events/:id
 */
router.put('/events/:id', adminOnly, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const setClauses = [];
    const params = [id];
    let paramIndex = 2;

    const allowedFields = ['name', 'type', 'start_time', 'end_time', 'affected_areas', 'spawn_multiplier', 'featured_pokemon', 'enabled'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex}`);
        params.push(updates[field]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid fields to update'
      });
    }

    setClauses.push('updated_at = NOW()');

    await req.db.query(
      `UPDATE spawn_events SET ${setClauses.join(', ')} WHERE id = $1`,
      params
    );

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, 'update_event', 'event', id.toString(), updates]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update event'
    });
  }
});

/**
 * 删除活动事件
 * DELETE /api/v1/spawn/events/:id
 */
router.delete('/events/:id', adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    await req.db.query(
      'UPDATE spawn_events SET enabled = false WHERE id = $1',
      [id]
    );

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, 'delete_event', 'event', id.toString()]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete event'
    });
  }
});

/**
 * 获取精灵池配置
 * GET /api/v1/spawn/pool/:biome
 */
router.get('/pool/:biome', async (req, res) => {
  const { biome } = req.params;

  try {
    const result = await req.db.query(
      `SELECT p.id, p.name, p.rarity, sp.weight, sp.min_level, sp.max_level, sp.enabled
       FROM spawn_pools sp
       JOIN pokemon p ON sp.pokemon_id = p.id
       WHERE sp.biome = $1
       ORDER BY sp.weight DESC`,
      [biome]
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching spawn pool:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch spawn pool'
    });
  }
});

/**
 * 更新精灵池
 * PUT /api/v1/spawn/pool/:biome
 */
router.put('/pool/:biome', adminOnly, async (req, res) => {
  const { biome } = req.params;
  const { pokemon } = req.body; // [{ id, weight, minLevel, maxLevel }]

  try {
    await req.db.query('BEGIN');

    for (const p of pokemon) {
      await req.db.query(
        `INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (biome, pokemon_id) DO UPDATE SET
           weight = $3,
           min_level = $4,
           max_level = $5`,
        [biome, p.id, p.weight, p.minLevel, p.maxLevel]
      );
    }

    await req.db.query('COMMIT');

    // 清除缓存
    await req.redis.del(`spawn:pool:${biome}`);

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, 'update_pool', 'pool', biome, { pokemonCount: pokemon.length }]
    );

    res.json({ success: true });
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Error updating spawn pool:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update spawn pool'
    });
  }
});

/**
 * 获取所有生物群系
 * GET /api/v1/spawn/biomes
 */
router.get('/biomes', async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT DISTINCT biome, COUNT(*) as pokemon_count
       FROM spawn_pools
       WHERE enabled = true
       GROUP BY biome
       ORDER BY biome`
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching biomes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch biomes'
    });
  }
});

/**
 * 获取刷新统计
 * GET /api/v1/spawn/statistics
 */
router.get('/statistics', async (req, res) => {
  const { geohash, startDate, endDate } = req.query;

  try {
    let query = 'SELECT * FROM spawn_statistics WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (geohash) {
      query += ` AND geohash = $${paramIndex}`;
      params.push(geohash);
      paramIndex++;
    }

    if (startDate) {
      query += ` AND date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      query += ` AND date <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    query += ' ORDER BY date DESC, hour DESC LIMIT 1000';

    const result = await req.db.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

/**
 * 获取操作日志
 * GET /api/v1/spawn/logs
 */
router.get('/logs', adminOnly, async (req, res) => {
  const { adminId, action, limit = 100 } = req.query;

  try {
    let query = 'SELECT * FROM spawn_admin_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (adminId) {
      query += ` AND admin_id = $${paramIndex}`;
      params.push(adminId);
      paramIndex++;
    }

    if (action) {
      query += ` AND action = $${paramIndex}`;
      params.push(action);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await req.db.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch logs'
    });
  }
});

/**
 * 手动刷新精灵
 * POST /api/v1/spawn/manual
 */
router.post('/manual', adminOnly, async (req, res) => {
  const { geohash, pokemonId, count = 1 } = req.body;

  try {
    const spawnEngine = req.app.locals.spawnEngine;
    if (!spawnEngine) {
      return res.status(503).json({
        success: false,
        error: 'Spawn engine not available'
      });
    }

    const spawned = await spawnEngine.manualSpawn(geohash, pokemonId, count);

    // 记录操作日志
    await req.db.query(
      `INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, 'manual_spawn', 'cell', geohash, { pokemonId, count, spawned: spawned.length }]
    );

    res.json({
      success: true,
      spawned: spawned.length,
      data: spawned
    });
  } catch (error) {
    console.error('Error manual spawning:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to spawn pokemon'
    });
  }
});

module.exports = router;
