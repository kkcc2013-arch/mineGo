/**
 * REQ-00019: 精灵技能学习与技能机器系统
 * 技能管理路由
 */

const express = require('express');
const router = express.Router();
const moveService = require('./moveService');
const logger = require('../../../shared/logger');

// 认证中间件
const authenticate = require('../../../shared/authMiddleware');

/**
 * GET /moves
 * 获取技能列表
 * Query: type, category, limit, offset
 */
router.get('/moves', async (req, res) => {
  try {
    const { type, category, limit, offset } = req.query;
    
    const result = await moveService.getMoves({
      type,
      category,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to get moves', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /moves/:id
 * 获取技能详情
 */
router.get('/moves/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const move = await moveService.getMoveById(id);
    
    if (!move) {
      return res.status(404).json({
        success: false,
        error: 'Move not found'
      });
    }
    
    res.json({
      success: true,
      move
    });
  } catch (error) {
    logger.error('Failed to get move', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /pokemon/my/:id/moves
 * 获取精灵技能栏
 */
router.get('/pokemon/my/:id/moves', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const result = await moveService.getPokemonMoves(userId, parseInt(id));
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to get pokemon moves', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/my/:id/moves/learn
 * 学习新技能
 * Body: { tmId, forgetMoveId? }
 */
router.post('/pokemon/my/:id/moves/learn', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { tmId, forgetMoveId } = req.body;
    const userId = req.user.id;
    
    if (!tmId) {
      return res.status(400).json({
        success: false,
        error: 'tmId is required'
      });
    }
    
    const result = await moveService.learnMove(
      userId,
      parseInt(id),
      tmId,
      forgetMoveId
    );
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to learn move', { error: error.message });
    
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/my/:id/moves/switch
 * 切换技能
 * Body: { fastMoveId?, chargeMoveId? }
 */
router.post('/pokemon/my/:id/moves/switch', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { fastMoveId, chargeMoveId } = req.body;
    const userId = req.user.id;
    
    if (!fastMoveId && !chargeMoveId) {
      return res.status(400).json({
        success: false,
        error: 'At least one move must be specified'
      });
    }
    
    const result = await moveService.switchMove(
      userId,
      parseInt(id),
      fastMoveId,
      chargeMoveId
    );
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to switch move', { error: error.message });
    
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/my/:id/moves/forget
 * 遗忘技能
 * Body: { moveId }
 */
router.post('/pokemon/my/:id/moves/forget', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { moveId } = req.body;
    const userId = req.user.id;
    
    if (!moveId) {
      return res.status(400).json({
        success: false,
        error: 'moveId is required'
      });
    }
    
    const result = await moveService.forgetMove(userId, parseInt(id), moveId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to forget move', { error: error.message });
    
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /pokemon/:speciesId/learnset
 * 获取种族可学习技能列表
 */
router.get('/pokemon/:speciesId/learnset', async (req, res) => {
  try {
    const { speciesId } = req.params;
    
    const result = await moveService.getSpeciesLearnset(parseInt(speciesId));
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to get species learnset', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /tm/my
 * 获取玩家 TM 背包
 */
router.get('/tm/my', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await moveService.getTMInventory(userId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to get TM inventory', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /tm/use
 * 使用 TM（等同于 /pokemon/my/:id/moves/learn）
 * Body: { pokemonId, tmId, forgetMoveId? }
 */
router.post('/tm/use', authenticate, async (req, res) => {
  try {
    const { pokemonId, tmId, forgetMoveId } = req.body;
    const userId = req.user.id;
    
    if (!pokemonId || !tmId) {
      return res.status(400).json({
        success: false,
        error: 'pokemonId and tmId are required'
      });
    }
    
    const result = await moveService.learnMove(
      userId,
      parseInt(pokemonId),
      tmId,
      forgetMoveId
    );
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to use TM', { error: error.message });
    
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
