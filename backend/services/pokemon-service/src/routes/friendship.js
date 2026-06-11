/**
 * REQ-00079: 好感度 API 路由
 */

const express = require('express');
const router = express.Router();
const friendshipService = require('../../../shared/friendshipService');
const { logger, metrics } = require('../../../shared');

/**
 * 认证中间件（简化版）
 */
const authenticate = (req, res, next) => {
  // 从 header 或 session 获取用户信息
  const userId = req.headers['x-user-id'] || req.session?.userId;
  
  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      error: 'unauthorized',
      message: '请先登录' 
    });
  }
  
  req.user = { id: userId };
  next();
};

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
 * 检查亲密度进化
 * GET /api/pokemon/:pokemonId/evolution-check
 */
router.get('/:pokemonId/evolution-check', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const result = await friendshipService.checkFriendshipEvolution(pokemonId, req.user.id);
    
    res.json({ 
      success: true, 
      data: result 
    });
    
  } catch (error) {
    logger.error('Failed to check friendship evolution', { 
      pokemonId: req.params.pokemonId, 
      error: error.message 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '检查进化失败'
    });
  }
});

/**
 * 执行亲密度进化
 * POST /api/pokemon/:pokemonId/evolve
 */
router.post('/:pokemonId/evolve', authenticate, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.pokemonId, 10);
    
    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'invalid_pokemon_id' 
      });
    }
    
    const result = await friendshipService.performFriendshipEvolution(pokemonId, req.user.id);
    
    metrics.increment('friendship.evolution.performed');
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to perform friendship evolution', { 
      pokemonId: req.params.pokemonId, 
      error: error.message 
    });
    
    // 根据错误类型返回不同状态码
    if (error.message.includes('Cannot evolve')) {
      return res.status(400).json({ 
        success: false, 
        error: 'evolution_not_available',
        message: error.message
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'internal_error',
      message: '进化失败'
    });
  }
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
