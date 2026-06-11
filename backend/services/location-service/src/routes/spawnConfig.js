// backend/services/location-service/src/routes/spawnConfig.js — Spawn Configuration Admin API
'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('spawn-config');

/**
 * Admin middleware
 */
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      code: 2003,
      message: '需要管理员权限'
    });
  }
  next();
}

/**
 * GET /api/admin/spawn/config/cell/:geohash
 * Get spawn configuration for a cell
 */
router.get('/config/cell/:geohash', async (req, res) => {
  const { geohash } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT * FROM spawn_cell_configs 
      WHERE geohash = $1
    `, [geohash]);
    
    const config = result.rows[0] || {
      geohash,
      base_spawn_count: 3,
      min_spawn: 1,
      max_spawn: 10,
      enabled: true
    };
    
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get cell config', { geohash, error: error.message });
    res.status(500).json({
      success: false,
      code: 3001,
      message: '获取区域配置失败'
    });
  }
});

/**
 * PUT /api/admin/spawn/config/cell/:geohash
 * Update spawn configuration for a cell
 */
router.put('/config/cell/:geohash', adminOnly, async (req, res) => {
  const { geohash } = req.params;
  const {
    base_spawn_count,
    min_spawn,
    max_spawn,
    spawn_pool_override,
    enabled
  } = req.body;
  
  try {
    await req.db.query(`
      INSERT INTO spawn_cell_configs 
        (geohash, base_spawn_count, min_spawn, max_spawn, spawn_pool_override, enabled, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (geohash) DO UPDATE SET
        base_spawn_count = $2,
        min_spawn = $3,
        max_spawn = $4,
        spawn_pool_override = $5,
        enabled = $6,
        updated_at = NOW()
    `, [geohash, base_spawn_count, min_spawn, max_spawn, spawn_pool_override, enabled]);
    
    // Clear cache
    await req.redis.del(`spawn:config:${geohash}`);
    
    // Log admin action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'update_config',
      'cell',
      geohash,
      JSON.stringify({ base_spawn_count, min_spawn, max_spawn, enabled })
    ]);
    
    logger.info('Cell config updated', { geohash, adminId: req.user.id });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update cell config', { geohash, error: error.message });
    res.status(500).json({
      success: false,
      code: 3002,
      message: '更新区域配置失败'
    });
  }
});

/**
 * GET /api/admin/spawn/events
 * Get spawn events
 */
router.get('/events', async (req, res) => {
  const { active, limit = 20, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM spawn_events';
    const params = [];
    
    if (active === 'true') {
      query += ' WHERE start_time <= NOW() AND end_time >= NOW() AND enabled = true';
    }
    
    query += ' ORDER BY start_time DESC LIMIT $1 OFFSET $2';
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await req.db.query(query, params);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to get events', { error: error.message });
    res.status(500).json({
      success: false,
      code: 3003,
      message: '获取活动列表失败'
    });
  }
});

/**
 * POST /api/admin/spawn/events
 * Create spawn event
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
    const result = await req.db.query(`
      INSERT INTO spawn_events 
        (name, type, start_time, end_time, affected_areas, spawn_multiplier, featured_pokemon)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      name,
      type,
      startTime,
      endTime,
      JSON.stringify(affectedAreas),
      spawnMultiplier || 1.0,
      featuredPokemon || []
    ]);
    
    const eventId = result.rows[0].id;
    
    // Log admin action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'create_event',
      'event',
      eventId.toString(),
      JSON.stringify({ name, type, startTime, endTime, spawnMultiplier })
    ]);
    
    logger.info('Event created', { eventId, name, adminId: req.user.id });
    
    res.json({ success: true, eventId });
  } catch (error) {
    logger.error('Failed to create event', { error: error.message });
    res.status(500).json({
      success: false,
      code: 3004,
      message: '创建活动失败'
    });
  }
});

/**
 * PUT /api/admin/spawn/events/:eventId
 * Update spawn event
 */
router.put('/events/:eventId', adminOnly, async (req, res) => {
  const { eventId } = req.params;
  const updates = req.body;
  
  try {
    const fields = [];
    const values = [eventId];
    let paramCount = 2;
    
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${dbKey} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
    
    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        code: 3005,
        message: '没有提供更新字段'
      });
    }
    
    fields.push('updated_at = NOW()');
    
    await req.db.query(`
      UPDATE spawn_events 
      SET ${fields.join(', ')}
      WHERE id = $1
    `, values);
    
    // Log admin action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'update_event',
      'event',
      eventId,
      JSON.stringify(updates)
    ]);
    
    logger.info('Event updated', { eventId, adminId: req.user.id });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update event', { eventId, error: error.message });
    res.status(500).json({
      success: false,
      code: 3006,
      message: '更新活动失败'
    });
  }
});

/**
 * DELETE /api/admin/spawn/events/:eventId
 * Delete spawn event
 */
router.delete('/events/:eventId', adminOnly, async (req, res) => {
  const { eventId } = req.params;
  
  try {
    await req.db.query('DELETE FROM spawn_events WHERE id = $1', [eventId]);
    
    // Log admin action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id)
      VALUES ($1, $2, $3, $4)
    `, [req.user.id, 'delete_event', 'event', eventId]);
    
    logger.info('Event deleted', { eventId, adminId: req.user.id });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete event', { eventId, error: error.message });
    res.status(500).json({
      success: false,
      code: 3007,
      message: '删除活动失败'
    });
  }
});

/**
 * GET /api/admin/spawn/pool/:biome
 * Get spawn pool for a biome
 */
router.get('/pool/:biome', async (req, res) => {
  const { biome } = req.params;
  
  try {
    const result = await req.db.query(`
      SELECT 
        p.id, p.name, p.rarity,
        sp.weight, sp.min_level, sp.max_level,
        sp.enabled
      FROM spawn_pools sp
      JOIN pokemon_species p ON sp.pokemon_id = p.id
      WHERE sp.biome = $1
      ORDER BY sp.weight DESC
    `, [biome]);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to get spawn pool', { biome, error: error.message });
    res.status(500).json({
      success: false,
      code: 3008,
      message: '获取精灵池失败'
    });
  }
});

/**
 * PUT /api/admin/spawn/pool/:biome
 * Update spawn pool for a biome
 */
router.put('/pool/:biome', adminOnly, async (req, res) => {
  const { biome } = req.params;
  const { pokemon } = req.body; // [{ id, weight, minLevel, maxLevel, enabled }]
  
  try {
    await req.db.query('BEGIN');
    
    // Clear existing pool
    await req.db.query('DELETE FROM spawn_pools WHERE biome = $1', [biome]);
    
    // Insert new pool
    for (const p of pokemon) {
      await req.db.query(`
        INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level, enabled)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [biome, p.id, p.weight, p.minLevel, p.maxLevel, p.enabled]);
    }
    
    await req.db.query('COMMIT');
    
    // Clear cache
    await req.redis.del(`spawn:pool:${biome}`);
    
    // Log admin action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, target_id, changes)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'update_pool',
      'pool',
      biome,
      JSON.stringify({ pokemonCount: pokemon.length })
    ]);
    
    logger.info('Spawn pool updated', { biome, pokemonCount: pokemon.length, adminId: req.user.id });
    
    res.json({ success: true });
  } catch (error) {
    await req.db.query('ROLLBACK');
    logger.error('Failed to update spawn pool', { biome, error: error.message });
    res.status(500).json({
      success: false,
      code: 3009,
      message: '更新精灵池失败'
    });
  }
});

/**
 * GET /api/admin/spawn/stats
 * Get spawn statistics
 */
router.get('/stats', async (req, res) => {
  const { geohash, date, hour } = req.query;
  
  try {
    let query = 'SELECT * FROM spawn_statistics WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (geohash) {
      query += ` AND geohash = $${paramCount}`;
      params.push(geohash);
      paramCount++;
    }
    
    if (date) {
      query += ` AND date = $${paramCount}`;
      params.push(date);
      paramCount++;
    }
    
    if (hour !== undefined) {
      query += ` AND hour = $${paramCount}`;
      params.push(parseInt(hour));
      paramCount++;
    }
    
    query += ' ORDER BY date DESC, hour DESC LIMIT 100';
    
    const result = await req.db.query(query, params);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to get spawn stats', { error: error.message });
    res.status(500).json({
      success: false,
      code: 3010,
      message: '获取统计数据失败'
    });
  }
});

/**
 * GET /api/admin/spawn/logs
 * Get admin operation logs
 */
router.get('/logs', adminOnly, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  
  try {
    const result = await req.db.query(`
      SELECT 
        sal.*,
        u.username as admin_name
      FROM spawn_admin_logs sal
      JOIN users u ON sal.admin_id = u.id
      ORDER BY sal.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to get admin logs', { error: error.message });
    res.status(500).json({
      success: false,
      code: 3011,
      message: '获取操作日志失败'
    });
  }
});

/**
 * POST /api/admin/spawn/manual-spawn
 * Manually spawn pokemon at a location
 */
router.post('/manual-spawn', adminOnly, async (req, res) => {
  const { pokemonId, lat, lng, duration } = req.body;
  
  try {
    // This would call SpawnEngine.createSpawn directly
    // For now, just log the action
    await req.db.query(`
      INSERT INTO spawn_admin_logs (admin_id, action, target_type, changes)
      VALUES ($1, $2, $3, $4)
    `, [
      req.user.id,
      'manual_spawn',
      'pokemon',
      JSON.stringify({ pokemonId, lat, lng, duration })
    ]);
    
    logger.info('Manual spawn triggered', { 
      pokemonId, 
      lat, 
      lng, 
      adminId: req.user.id 
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to manual spawn', { error: error.message });
    res.status(500).json({
      success: false,
      code: 3012,
      message: '手动刷新失败'
    });
  }
});

module.exports = router;
