// backend/services/pokemon-service/src/routes/stamina.js
// 精灵体力系统路由 - REQ-00172

'use strict';

const express = require('express');
const router = express.Router();
const { staminaService } = require('../staminaService');
const { createLogger } = require('../../../../shared/logger');
const { db } = require('../../../../shared/db');

const logger = createLogger('stamina-routes');

// ============================================================
// 中间件：验证精灵所有权
// ============================================================

async function validatePokemonOwnership(req, res, next) {
  try {
    const pokemonId = parseInt(req.params.id, 10);
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const pokemon = await db('pokemon')
      .where({ id: pokemonId, user_id: userId })
      .select('id')
      .first();

    if (!pokemon) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    req.pokemonId = pokemonId;
    req.userId = userId;
    next();
  } catch (error) {
    logger.error({ error: error.message }, 'Pokemon ownership validation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 路由定义
// ============================================================

/**
 * GET /pokemon/:id/stamina
 * 获取精灵体力状态
 */
router.get('/:id/stamina', validatePokemonOwnership, async (req, res) => {
  try {
    const status = await staminaService.getStaminaStatus(req.pokemonId, req.userId);
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error({ error: error.message, pokemonId: req.pokemonId }, 'Failed to get stamina status');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/consume
 * 消耗体力
 */
router.post('/:id/stamina/consume', validatePokemonOwnership, async (req, res) => {
  try {
    const { activityType, metadata } = req.body;
    
    if (!activityType) {
      return res.status(400).json({ error: 'activityType is required' });
    }

    const result = await staminaService.consumeStamina(
      req.pokemonId,
      activityType,
      req.userId,
      { metadata: metadata || {} }
    );
    
    res.json({ success: result.success, data: result });
  } catch (error) {
    logger.error({ error: error.message, pokemonId: req.pokemonId }, 'Failed to consume stamina');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/recover
 * 恢复体力
 */
router.post('/:id/stamina/recover', validatePokemonOwnership, async (req, res) => {
  try {
    const { amount, source } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive' });
    }

    if (!source) {
      return res.status(400).json({ error: 'source is required' });
    }

    const result = await staminaService.recoverStamina(
      req.pokemonId,
      amount,
      source,
      req.userId
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ error: error.message, pokemonId: req.pokemonId }, 'Failed to recover stamina');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/use-item
 * 使用道具恢复体力
 */
router.post('/:id/stamina/use-item', validatePokemonOwnership, async (req, res) => {
  try {
    const { itemId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }

    const result = await staminaService.useRecoveryItem(
      req.pokemonId,
      itemId,
      req.userId
    );
    
    res.json({ success: result.success, data: result });
  } catch (error) {
    logger.error({ error: error.message, pokemonId: req.pokemonId }, 'Failed to use recovery item');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /pokemon/:id/stamina/check
 * 检查精灵是否有足够体力
 */
router.post('/:id/stamina/check', validatePokemonOwnership, async (req, res) => {
  try {
    const { activityType } = req.body;
    
    if (!activityType) {
      return res.status(400).json({ error: 'activityType is required' });
    }

    const result = await staminaService.checkStamina(
      req.pokemonId,
      activityType,
      req.userId
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ error: error.message, pokemonId: req.pokemonId }, 'Failed to check stamina');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /stamina/rest-station/:stationId/start
 * 在休息站开始休息
 */
router.post('/rest-station/:stationId/start', async (req, res) => {
  try {
    const stationId = parseInt(req.params.stationId, 10);
    const { pokemonId } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!pokemonId) {
      return res.status(400).json({ error: 'pokemonId is required' });
    }

    const result = await staminaService.startRestAtStation(
      pokemonId,
      stationId,
      userId
    );
    
    res.json({ success: result.success, data: result });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start rest at station');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /stamina/rest/:recordId/end
 * 结束休息
 */
router.post('/rest/:recordId/end', async (req, res) => {
  try {
    const recordId = parseInt(req.params.recordId, 10);
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await staminaService.endRest(recordId, userId);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to end rest');
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /stamina/rest-stations
 * 获取附近的休息站
 */
router.get('/rest-stations', async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const stations = await staminaService.getNearbyRestStations(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(radius, 10) || 2000
    );
    
    res.json({ success: true, data: stations });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get nearby rest stations');
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /stamina/config
 * 获取体力消耗配置
 */
router.get('/config', async (req, res) => {
  try {
    const configs = await staminaService.getActivityConfigs();
    const items = await staminaService.getRecoveryItems();
    
    res.json({ 
      success: true, 
      data: { 
        activities: configs,
        recoveryItems: items,
        fatigueLevels: require('../staminaService').FATIGUE_LEVELS
      } 
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get stamina config');
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /stamina/items
 * 获取用户体力道具库存
 */
router.get('/items', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const items = await staminaService.getUserStaminaItems(userId);
    res.json({ success: true, data: items });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get user stamina items');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /stamina/batch-status
 * 批量获取精灵体力状态
 */
router.post('/batch-status', async (req, res) => {
  try {
    const { pokemonIds } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ error: 'pokemonIds must be a non-empty array' });
    }

    if (pokemonIds.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 pokemon per batch' });
    }

    const statuses = await staminaService.getBatchStaminaStatus(pokemonIds, userId);
    res.json({ success: true, data: statuses });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get batch stamina status');
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
