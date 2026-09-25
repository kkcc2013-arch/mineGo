/**
 * REQ-00079: 好感度 API 路由
 */

const express = require('express');
const router = express.Router();
const friendshipService = require('../../../../shared/friendshipService');
const { logger, metrics } = require('../../../../shared');

/**
 * 认证中间件：校验 JWT（原实现直接信任 x-user-id 请求头 / session，可冒充任意用户）
 */
const { requireAuth } = require('../../../../shared/auth');
const authenticate = (req, res, next) => requireAuth(req, res, (err) => {
  if (err) return next(err);
  req.user.id = req.user.sub; // 本文件后续代码使用 req.user.id
  next();
});

/**
 * 获取精灵好感度
 * GET /api/pokemon/:pokemonId/friendship
 */
router.get('/:pokemonId/friendship', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const friendship = await friendshipService.getFriendship(pokemonId);
    
    if (!friendship) {
      return res.status(404).json({ 
        success: false, 
        error: 'friendship_not_found',
        message: '未找到该精灵的好感度数据'
      });
    }
    
    res.json({
      success: true,
      data: friendship
    });
    
  } catch (error) {
    logger.error('Failed to get friendship', { 
      pokemonId: req.params.pokemonId, 
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '获取好感度失败'
    });
  }
});

/**
 * 与精灵互动
 * POST /api/pokemon/:pokemonId/interact
 * Body: { type: 'massage'|'camping'|'feed_berry'|'feed_vitamin'|'spa'|'touch', itemId?: number }
 */
router.post('/:pokemonId/interact', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    const { type, itemId } = req.body;
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const validTypes = ['massage', 'camping', 'feed_berry', 'feed_vitamin', 'spa', 'touch'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_interaction_type',
        validTypes
      });
    }
    
    // 获取互动配置
    const config = await friendshipService.getInteractionConfig(type);
    
    if (!config || !config.is_active) {
      return res.status(400).json({ 
        success: false, 
        error: 'interaction_unavailable',
        message: '该互动类型不可用'
      });
    }
    
    // 检查每日限制
    const status = await friendshipService.getInteractionStatus(pokemonId);
    if (config.daily_limit && status && status.dailyCount >= config.daily_limit) {
      return res.status(400).json({ 
        success: false, 
        error: 'daily_limit_reached',
        message: `今日${config.description}次数已达上限`,
        limit: config.daily_limit
      });
    }
    
    // 执行互动
    const result = await friendshipService.modifyFriendship(
      pokemonId,
      config.friendship_change,
      type,
      { itemId, userId: req.user.id }
    );
    
    metrics.increment(`friendship.interact.${type}`);
    
    res.json({
      success: true,
      data: {
        ...result,
        interactionType: type,
        interactionName: config.description,
        message: `好感度${result.change > 0 ? '提升' : '降低'}了 ${Math.abs(result.change)} 点！`
      }
    });
    
  } catch (error) {
    logger.error('Failed to interact with pokemon', { 
      pokemonId: req.params.pokemonId,
      type: req.body.type,
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '互动失败'
    });
  }
});

/**
 * 亲密度进化检查 / 执行：委托唯一的进化服务（亲密度、昼夜等条件由 evolution_rules 配置）
 * 原实现 parseInt(UUID) 后查询，任何真实精灵都 400/500，且与其他进化接口是两套扣糖逻辑
 * GET  /pokemon/:pokemonId/evolution-check
 * POST /pokemon/:pokemonId/evolve  { targetSpeciesId? }
 */
const evolutionService = require('../evolutionService');

router.get('/:pokemonId/evolution-check', authenticate, async (req, res, next) => {
  try {
    const result = await evolutionService.checkEvolution(req.params.pokemonId, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:pokemonId/evolve', authenticate, async (req, res, next) => {
  try {
    const result = await evolutionService.evolve(req.params.pokemonId, req.user.id, {
      targetSpeciesId: req.body && req.body.targetSpeciesId,
    });
    metrics.increment && metrics.increment('friendship.evolution.performed');
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

/**
 * 获取互动历史
 * GET /api/pokemon/:pokemonId/friendship-history
 * Query: limit, offset
 */
router.get('/:pokemonId/friendship-history', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const history = await friendshipService.getFriendshipHistory(pokemonId, limit, offset);
    
    res.json({ 
      success: true, 
      data: history,
      pagination: { limit, offset, count: history.length }
    });
    
  } catch (error) {
    logger.error('Failed to get friendship history', { 
      pokemonId: req.params.pokemonId, 
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '获取历史记录失败'
    });
  }
});

/**
 * 获取互动状态
 * GET /api/pokemon/:pokemonId/interaction-status
 */
router.get('/:pokemonId/interaction-status', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const status = await friendshipService.getInteractionStatus(pokemonId);
    
    res.json({ 
      success: true, 
      data: status 
    });
    
  } catch (error) {
    logger.error('Failed to get interaction status', { 
      pokemonId: req.params.pokemonId, 
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '获取互动状态失败'
    });
  }
});

/**
 * 处理行走步数奖励
 * POST /api/pokemon/:pokemonId/walking-bonus
 * Body: { steps: number }
 */
router.post('/:pokemonId/walking-bonus', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    const { steps } = req.body;
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    if (!steps || steps < 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_steps' 
      });
    }
    
    const result = await friendshipService.processWalkingBonus(pokemonId, steps);
    
    res.json({ 
      success: true, 
      data: result 
    });
    
  } catch (error) {
    logger.error('Failed to process walking bonus', { 
      pokemonId: req.params.pokemonId, 
      steps: req.body.steps,
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '处理行走奖励失败'
    });
  }
});

/**
 * 批量获取精灵好感度
 * POST /api/pokemon/friendship/batch
 * Body: { pokemonIds: number[] }
 */
router.post('/friendship/batch', authenticate, async (req, res) => {
  try {
    const { pokemonIds } = req.body;
    
    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_ids' 
      });
    }
    
    if (pokemonIds.length > 50) {
      return res.status(400).json({ 
        success: false, 
        error: 'too_many_pokemon',
        message: '一次最多查询 50 只精灵'
      });
    }
    
    const results = await Promise.all(
      pokemonIds.map(async (id) => {
        try {
          const friendship = await friendshipService.getFriendship(id);
          return { id, friendship, success: true };
        } catch (err) {
          return { id, friendship: null, success: false, error: err.message };
        }
      })
    );
    
    res.json({ 
      success: true, 
      data: results 
    });
    
  } catch (error) {
    logger.error('Failed to batch get friendship', { 
      pokemonIds: req.body.pokemonIds,
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '批量获取好感度失败'
    });
  }
});

module.exports = router;
