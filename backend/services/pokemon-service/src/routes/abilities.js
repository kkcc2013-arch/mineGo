/**
 * REQ-00086: 特性 API 路由
 */

const express = require('express');
const router = express.Router();
const AbilityService = require('../abilityService');
const logger = require('../../../../shared/logger');

const abilityService = new AbilityService();

/**
 * 获取特性列表
 * GET /api/pokemon/abilities
 */
router.get('/', async (req, res) => {
  try {
    const { type, is_hidden, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM abilities WHERE 1=1';
    const params = [];
    
    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }
    
    if (is_hidden !== undefined) {
      params.push(is_hidden === 'true');
      query += ` AND is_hidden = $${params.length}`;
    }
    
    query += ` ORDER BY name_en LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await abilityService.db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rows.length
      }
    });
  } catch (error) {
    logger.error('Failed to get abilities', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取单个特性详情
 * GET /api/pokemon/abilities/:abilityId
 */
router.get('/:abilityId', async (req, res) => {
  try {
    const ability = abilityService.getAbility(req.params.abilityId);
    
    if (!ability) {
      return res.status(404).json({ error: 'Ability not found' });
    }
    
    res.json({ success: true, data: ability });
  } catch (error) {
    logger.error('Failed to get ability', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取精灵种类的特性配置
 * GET /api/pokemon/abilities/species/:speciesId
 */
router.get('/species/:speciesId', async (req, res) => {
  try {
    const { speciesId } = req.params;
    
    const abilities = await abilityService.getPokemonAbilities(speciesId);
    
    res.json({
      success: true,
      data: abilities
    });
  } catch (error) {
    logger.error('Failed to get species abilities', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取玩家精灵的特性列表
 * GET /api/pokemon/abilities/pokemon/:pokemonId
 */
router.get('/pokemon/:pokemonId', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const abilities = await abilityService.getPlayerPokemonAbilities(pokemonId);
    
    res.json({
      success: true,
      data: abilities
    });
  } catch (error) {
    logger.error('Failed to get pokemon abilities', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取玩家精灵的激活特性
 * GET /api/pokemon/abilities/pokemon/:pokemonId/active
 */
router.get('/pokemon/:pokemonId/active', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const ability = await abilityService.getActiveAbility(pokemonId);
    
    res.json({
      success: true,
      data: ability
    });
  } catch (error) {
    logger.error('Failed to get active ability', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 切换精灵特性
 * POST /api/pokemon/abilities/pokemon/:pokemonId/switch
 */
router.post('/pokemon/:pokemonId/switch', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { targetSlot } = req.body;
    
    if (!targetSlot || ![1, 2].includes(targetSlot)) {
      return res.status(400).json({ error: 'Invalid target slot. Must be 1 or 2.' });
    }
    
    const result = await abilityService.switchAbility(pokemonId, targetSlot);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to switch ability', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 解锁隐藏特性
 * POST /api/pokemon/abilities/pokemon/:pokemonId/unlock-hidden
 */
router.post('/pokemon/:pokemonId/unlock-hidden', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const result = await abilityService.unlockHiddenAbility(pokemonId);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to unlock hidden ability', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 激活隐藏特性
 * POST /api/pokemon/abilities/pokemon/:pokemonId/activate-hidden
 */
router.post('/pokemon/:pokemonId/activate-hidden', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const result = await abilityService.activateHiddenAbility(pokemonId);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to activate hidden ability', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 使用特性道具
 * POST /api/pokemon/abilities/pokemon/:pokemonId/use-item
 */
router.post('/pokemon/:pokemonId/use-item', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { itemId, userId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }
    
    const result = await abilityService.useAbilityItem(userId || req.user?.id, pokemonId, itemId);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to use ability item', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

/**
 * 获取特性统计
 * GET /api/pokemon/abilities/stats
 */
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await abilityService.getAbilityStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get ability stats', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取特性道具列表
 * GET /api/pokemon/abilities/items
 */
router.get('/items/list', async (req, res) => {
  try {
    const result = await abilityService.db.query('SELECT * FROM ability_items ORDER BY rarity');
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('Failed to get ability items', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 检查特性触发条件
 * POST /api/pokemon/abilities/check-trigger
 */
router.post('/check-trigger', async (req, res) => {
  try {
    const { abilityId, context } = req.body;
    
    const ability = abilityService.getAbility(abilityId);
    
    if (!ability) {
      return res.status(404).json({ error: 'Ability not found' });
    }
    
    const result = abilityService.checkTriggerCondition(ability, context);
    
    res.json({
      success: true,
      canTrigger: result.canTrigger,
      reason: result.reason
    });
  } catch (error) {
    logger.error('Failed to check trigger', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 应用特性效果
 * POST /api/pokemon/abilities/apply-effect
 */
router.post('/apply-effect', async (req, res) => {
  try {
    const { abilityId, context, battle } = req.body;
    
    const effects = abilityService.applyAbilityEffect(abilityId, context, battle || {});
    
    res.json({
      success: true,
      effects
    });
  } catch (error) {
    logger.error('Failed to apply effect', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
