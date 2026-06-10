/**
 * 羁绊系统 API 路由 - REQ-00067
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const Joi = require('joi');
const FriendshipService = require('../friendshipService');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('friendship-routes');
const friendshipService = new FriendshipService();

// 验证 schema
const interactionSchema = Joi.object({
  interactionType: Joi.string().valid('feed', 'play', 'pet', 'train', 'walk').required(),
  resourceId: Joi.string().uuid(),
  location: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required()
  })
});

/**
 * GET /api/pokemon/:pokemonId/friendship
 * 获取精灵羁绊信息
 */
router.get('/:pokemonId/friendship', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user?.id || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const info = await friendshipService.getFriendshipInfo(pokemonId, userId);
    
    res.json({ 
      success: true, 
      data: info 
    });
  } catch (error) {
    logger.error({ err: error, pokemonId: req.params.pokemonId }, 'Failed to get friendship info');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/pokemon/:pokemonId/friendship/interact
 * 执行互动行为
 */
router.post('/:pokemonId/friendship/interact', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user?.id || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    // 验证请求
    const { error, value } = interactionSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        error: error.details[0].message 
      });
    }
    
    const result = await friendshipService.performInteraction(
      pokemonId,
      userId,
      value.interactionType,
      value
    );
    
    logger.info({ 
      pokemonId, 
      userId, 
      interactionType: value.interactionType,
      friendshipGain: result.friendshipGain 
    }, 'Interaction performed');
    
    res.json({ 
      success: true, 
      data: result 
    });
  } catch (error) {
    logger.error({ err: error, pokemonId: req.params.pokemonId }, 'Interaction failed');
    
    const statusCode = error.message.includes('Cooldown') ? 429 : 400;
    res.status(statusCode).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/pokemon/:pokemonId/friendship/interactions
 * 获取互动历史
 */
router.get('/:pokemonId/friendship/interactions', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user?.id || req.headers['x-user-id'];
    const limit = parseInt(req.query.limit) || 50;
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const history = await friendshipService.getInteractionHistory(pokemonId, userId, limit);
    
    res.json({ 
      success: true, 
      data: history,
      count: history.length
    });
  } catch (error) {
    logger.error({ err: error, pokemonId: req.params.pokemonId }, 'Failed to get interaction history');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/pokemon/friendship/leaderboard
 * 获取羁绊排行榜
 */
router.get('/friendship/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const leaderboard = await friendshipService.getLeaderboard(limit);
    
    res.json({ 
      success: true, 
      data: leaderboard,
      count: leaderboard.length
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get leaderboard');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/pokemon/friendship/my
 * 获取用户的羁绊列表
 */
router.get('/friendship/my', async (req, res) => {
  try {
    const userId = req.user?.id || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const minLevel = parseInt(req.query.minLevel) || 0;
    
    const friendships = await friendshipService.getUserFriendships(userId, {
      limit,
      offset,
      minLevel
    });
    
    res.json({ 
      success: true, 
      data: friendships,
      count: friendships.length
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get user friendships');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/pokemon/friendship/config
 * 获取羁绊系统配置（等级、心情等）
 */
router.get('/friendship/config', async (req, res) => {
  try {
    res.json({ 
      success: true, 
      data: {
        levels: friendshipService.FRIENDSHIP_LEVELS,
        interactionTypes: Object.entries(friendshipService.INTERACTION_TYPES).map(([key, value]) => ({
          type: key,
          ...value
        })),
        moodEffects: friendshipService.MOOD_EFFECTS
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get friendship config');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
