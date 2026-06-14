'use strict';

const express = require('express');
const router = express.Router();
const timePeriodManager = require('../../../shared/TimePeriodManager');
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { query } = require('../../../shared/db');

const logger = createLogger('time-period-routes');

/**
 * GET /api/time/current
 * 获取当前时段信息
 */
router.get('/current', async (req, res, next) => {
  try {
    const timezone = req.query.timezone || req.headers['x-timezone'] || 'UTC';
    const period = await timePeriodManager.getCurrentPeriod(timezone);
    
    metrics.incrementCounter('time_period_requests_total', { period: period.id });
    
    successResp(res, period);
  } catch (error) {
    logger.error({ error }, 'Failed to get current time period');
    next(new AppError('Failed to get time period', 500));
  }
});

/**
 * GET /api/time/periods
 * 获取所有时段配置
 */
router.get('/periods', async (req, res, next) => {
  try {
    const periods = await timePeriodManager.loadTimePeriods();
    successResp(res, { periods });
  } catch (error) {
    logger.error({ error }, 'Failed to get time periods');
    next(new AppError('Failed to get time periods', 500));
  }
});

/**
 * GET /api/time/special-pokemon
 * 获取当前时段特殊精灵列表
 */
router.get('/special-pokemon', async (req, res, next) => {
  try {
    const timezone = req.query.timezone || 'UTC';
    const currentPeriod = await timePeriodManager.getCurrentPeriod(timezone);
    const specialPokemon = await timePeriodManager.getPeriodSpecialPokemon(currentPeriod.id);
    
    successResp(res, {
      period: currentPeriod,
      special_pokemon: specialPokemon,
      count: specialPokemon.length
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get special pokemon');
    next(new AppError('Failed to get special pokemon', 500));
  }
});

/**
 * GET /api/time/type-bonus/:type
 * 获取特定属性在当前时段的加成
 */
router.get('/type-bonus/:type', async (req, res, next) => {
  try {
    const { type } = req.params;
    const currentPeriod = await timePeriodManager.getCurrentPeriod();
    const bonus = await timePeriodManager.getTypeBonus(type.toLowerCase(), currentPeriod.id);
    
    successResp(res, {
      pokemon_type: type.toLowerCase(),
      period: currentPeriod.id,
      bonus
    });
  } catch (error) {
    logger.error({ error, type: req.params.type }, 'Failed to get type bonus');
    next(new AppError('Failed to get type bonus', 500));
  }
});

/**
 * GET /api/time/type-bonuses
 * 获取当前时段所有属性加成
 */
router.get('/type-bonuses', async (req, res, next) => {
  try {
    const currentPeriod = await timePeriodManager.getCurrentPeriod();
    const bonuses = await timePeriodManager.getAllTypeBonuses(currentPeriod.id);
    
    successResp(res, {
      period: currentPeriod,
      bonuses
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get all type bonuses');
    next(new AppError('Failed to get all type bonuses', 500));
  }
});

/**
 * GET /api/time/activity-stats
 * 获取玩家时段活动统计（需认证）
 */
router.get('/activity-stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const result = await query(
      'SELECT * FROM player_time_activity_stats WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return successResp(res, {
        user_id: userId,
        dawn_catches: 0,
        day_catches: 0,
        dusk_catches: 0,
        night_catches: 0,
        late_night_catches: 0,
        total_catches: 0
      });
    }
    
    const stats = result.rows[0];
    stats.total_catches = 
      (stats.dawn_catches || 0) + 
      (stats.day_catches || 0) + 
      (stats.dusk_catches || 0) + 
      (stats.night_catches || 0) + 
      (stats.late_night_catches || 0);
    
    successResp(res, stats);
  } catch (error) {
    logger.error({ error }, 'Failed to get activity stats');
    next(new AppError('Failed to get activity stats', 500));
  }
});

/**
 * GET /api/time/preview/:hour
 * 预览指定小时的时段信息
 */
router.get('/preview/:hour', async (req, res, next) => {
  try {
    const hour = parseInt(req.params.hour);
    
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return next(new AppError('Invalid hour. Must be 0-23', 400));
    }
    
    await timePeriodManager.loadTimePeriods();
    const period = timePeriodManager.findPeriodByHour(hour);
    const nextPeriod = timePeriodManager.getNextPeriod(hour);
    
    successResp(res, {
      hour,
      period,
      next_period: nextPeriod
    });
  } catch (error) {
    logger.error({ error, hour: req.params.hour }, 'Failed to preview time period');
    next(new AppError('Failed to preview time period', 500));
  }
});

/**
 * POST /api/time/spawn-config
 * 配置精灵时段刷新（管理员接口）
 */
router.post('/spawn-config', requireAuth, async (req, res, next) => {
  try {
    // TODO: 添加管理员权限检查
    const { pokemon_id, time_period_id, spawn_multiplier, is_exclusive } = req.body;
    
    if (!pokemon_id || !time_period_id) {
      return next(new AppError('Missing required fields: pokemon_id, time_period_id', 400));
    }
    
    const result = await query(
      `INSERT INTO pokemon_time_spawn_config (pokemon_id, time_period_id, spawn_multiplier, is_exclusive)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pokemon_id, time_period_id)
       DO UPDATE SET 
         spawn_multiplier = EXCLUDED.spawn_multiplier,
         is_exclusive = EXCLUDED.is_exclusive
       RETURNING *`,
      [pokemon_id, time_period_id, spawn_multiplier || 1.0, is_exclusive || false]
    );
    
    successResp(res, result.rows[0]);
  } catch (error) {
    logger.error({ error }, 'Failed to configure spawn config');
    next(new AppError('Failed to configure spawn config', 500));
  }
});

module.exports = router;
