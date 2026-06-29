/**
 * REQ-00102: 精灵昼夜循环系统路由
 */

'use strict';

const express = require('express');
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { 
  dayNightService, 
  getCurrentTimePeriod, 
  TIME_PERIODS 
} = require('../dayNightService');

const router = express.Router();
const logger = createLogger('day-night-routes');

/**
 * GET /daynight/current
 * 获取当前游戏时间和时间段信息
 */
router.get('/current', async (req, res, next) => {
  try {
    // 从请求头获取时区偏移
    const timezoneOffset = parseInt(req.headers['x-timezone-offset'] || req.query.timezoneOffset || 0);
    
    const periodInfo = await getCurrentTimePeriod(timezoneOffset);
    const announcement = await dayNightService.getTransitionAnnouncement(
      periodInfo.period, 
      periodInfo.nextChangeHours
    );
    const tips = await dayNightService.getPeriodTips(periodInfo.period);
    
    res.json(successResp({
      ...periodInfo,
      announcement,
      tips,
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get current time period');
    next(err);
  }
});

/**
 * GET /daynight/periods
 * 获取所有时间段配置列表
 */
router.get('/periods', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT 
        name, start_hour, end_hour,
        display_name_zh, display_name_en,
        description, spawn_bonus_multiplier,
        color_theme, icon_url, is_active
      FROM day_night_config
      WHERE is_active = true
      ORDER BY id
    `);
    
    res.json(successResp({
      periods: rows,
      total: rows.length
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get period list');
    // 回退到本地数据
    res.json(successResp({
      periods: Object.values(TIME_PERIODS).map(p => ({
        name: p.name,
        start_hour: p.hours[0],
        end_hour: p.hours[p.hours.length - 1] + 1,
        display_name_zh: p.displayZh,
        display_name_en: p.displayEn,
        spawn_bonus_multiplier: p.spawnBonus,
        color_theme: p.colorTheme,
        is_active: true
      })),
      total: Object.keys(TIME_PERIODS).length
    }));
  }
});

/**
 * GET /daynight/pokemon/:period
 * 获取指定时间段的可生成精灵列表
 */
router.get('/pokemon/:period', async (req, res, next) => {
  try {
    const { period } = req.params;
    const { biome, rarity, limit } = req.query;
    
    // 验证时间段
    const validPeriods = Object.keys(TIME_PERIODS);
    if (!validPeriods.includes(period)) {
      throw new AppError(4001, `Invalid time period: ${period}`, 400);
    }
    
    const pokemonList = await dayNightService.getPokemonForPeriod(period, {
      biome: biome || null,
      rarity: rarity || null,
      limit: parseInt(limit) || 50
    });
    
    res.json(successResp({
      period,
      pokemon: pokemonList,
      total: pokemonList.length
    }));
  } catch (err) {
    logger.error({ err, period: req.params.period }, 'Failed to get pokemon for period');
    next(err);
  }
});

/**
 * GET /daynight/statistics
 * 获取昼夜生成统计数据
 */
router.get('/statistics', async (req, res, next) => {
  try {
    const { date, period, days } = req.query;
    const daysLimit = parseInt(days) || 7;
    
    let whereClause = '1=1';
    const params = [];
    
    if (date) {
      params.push(date);
      whereClause += ` AND date = $${params.length}`;
    }
    
    if (period) {
      params.push(period);
      whereClause += ` AND time_period = $${params.length}`;
    }
    
    params.push(daysLimit);
    
    const { rows } = await query(`
      SELECT 
        date, time_period,
        total_spawns, unique_species,
        rare_spawns, shiny_spawns,
        average_iv, created_at
      FROM day_night_spawn_statistics
      WHERE ${whereClause}
      ORDER BY date DESC, time_period
      LIMIT $${params.length}
    `, params);
    
    res.json(successResp({
      statistics: rows,
      total: rows.length
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get statistics');
    next(err);
  }
});

/**
 * POST /daynight/config
 * 管理员配置时间段（需要管理员权限）
 */
router.post('/config', requireAuth, async (req, res, next) => {
  try {
    // TODO: 添加管理员权限检查
    const { name, start_hour, end_hour, spawn_bonus_multiplier, color_theme, description } = req.body;
    
    if (!name || start_hour === undefined || end_hour === undefined) {
      throw new AppError(4002, 'Missing required fields: name, start_hour, end_hour', 400);
    }
    
    const { rows } = await query(`
      INSERT INTO day_night_config 
        (name, start_hour, end_hour, spawn_bonus_multiplier, color_theme, description,
         display_name_zh, display_name_en)
      VALUES ($1, $2, $3, $4, $5, $6, $1, $1)
      ON CONFLICT (name) DO UPDATE SET
        start_hour = EXCLUDED.start_hour,
        end_hour = EXCLUDED.end_hour,
        spawn_bonus_multiplier = EXCLUDED.spawn_bonus_multiplier,
        color_theme = EXCLUDED.color_theme,
        description = EXCLUDED.description,
        updated_at = NOW()
      RETURNING *
    `, [name, start_hour, end_hour, spawn_bonus_multiplier || 1.0, color_theme, description]);
    
    logger.info({ userId: req.user.sub, config: rows[0] }, 'Day/night config updated');
    
    res.json(successResp({
      config: rows[0],
      message: 'Configuration updated successfully'
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to update config');
    next(err);
  }
});

/**
 * POST /daynight/pokemon-config
 * 配置精灵的时间段权重
 */
router.post('/pokemon-config', requireAuth, async (req, res, next) => {
  try {
    const { pokemon_id, time_period, spawn_weight_multiplier, is_exclusive, special_iv_bonus, notes } = req.body;
    
    if (!pokemon_id || !time_period) {
      throw new AppError(4003, 'Missing required fields: pokemon_id, time_period', 400);
    }
    
    const { rows } = await query(`
      INSERT INTO pokemon_day_night_spawn
        (pokemon_id, time_period, spawn_weight_multiplier, is_exclusive, special_iv_bonus, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (pokemon_id, time_period) DO UPDATE SET
        spawn_weight_multiplier = EXCLUDED.spawn_weight_multiplier,
        is_exclusive = EXCLUDED.is_exclusive,
        special_iv_bonus = EXCLUDED.special_iv_bonus,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING *
    `, [pokemon_id, time_period, spawn_weight_multiplier || 1.0, is_exclusive || false, special_iv_bonus || 0, notes]);
    
    logger.info({ userId: req.user.sub, config: rows[0] }, 'Pokemon day/night config updated');
    
    res.json(successResp({
      config: rows[0],
      message: 'Pokemon configuration updated successfully'
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to update pokemon config');
    next(err);
  }
});

/**
 * GET /daynight/tips
 * 获取当前时间段的捕捉提示
 */
router.get('/tips', async (req, res, next) => {
  try {
    const { period } = req.query;
    let targetPeriod = period;
    
    if (!targetPeriod) {
      const timezoneOffset = parseInt(req.headers['x-timezone-offset'] || 0);
      const periodInfo = await getCurrentTimePeriod(timezoneOffset);
      targetPeriod = periodInfo.period;
    }
    
    const tips = await dayNightService.getPeriodTips(targetPeriod);
    
    res.json(successResp({
      period: targetPeriod,
      ...tips
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get tips');
    next(err);
  }
});

module.exports = router;