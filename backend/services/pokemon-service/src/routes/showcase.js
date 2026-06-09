/**
 * REQ-00055: 精灵收藏展示系统
 * API 路由
 * 
 * 创建时间: 2026-06-09 20:25
 */

'use strict';

const express = require('express');
const router = express.Router();
const showcaseService = require('../showcaseService');
const logger = require('../../shared/logger');

// ============================================================
// 中间件：验证用户身份
// ============================================================

function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// ============================================================
// 收藏管理 API
// ============================================================

/**
 * GET /api/pokemon/favorites
 * 获取当前用户的收藏列表
 */
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const favorites = await showcaseService.getFavorites(req.user.id);
    res.json({ favorites });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Failed to get favorites');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/pokemon/favorites
 * 添加收藏
 */
router.post('/favorites', requireAuth, async (req, res) => {
  try {
    const { pokemonId, displayOrder } = req.body;
    
    if (!pokemonId) {
      return res.status(400).json({ error: 'pokemonId is required' });
    }
    
    const result = await showcaseService.addFavorite(
      req.user.id, 
      pokemonId, 
      displayOrder || 0
    );
    
    res.json({ success: true, message: 'Added to favorites', favorite: result });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Failed to add favorite');
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/pokemon/favorites/:pokemonId
 * 移除收藏
 */
router.delete('/favorites/:pokemonId', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const result = await showcaseService.removeFavorite(req.user.id, pokemonId);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Failed to remove favorite');
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/pokemon/favorites/reorder
 * 重新排序收藏
 */
router.put('/favorites/reorder', requireAuth, async (req, res) => {
  try {
    const { orders } = req.body;
    
    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'orders must be an array' });
    }
    
    const result = await showcaseService.reorderFavorites(req.user.id, orders);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Failed to reorder favorites');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 点赞 API
// ============================================================

/**
 * POST /api/pokemon/:pokemonId/like
 * 点赞精灵
 */
router.post('/:pokemonId/like', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const result = await showcaseService.likePokemon(req.user.id, pokemonId);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id, pokemonId: req.params.pokemonId }, 'Failed to like pokemon');
    
    if (err.message.includes('limit')) {
      res.status(429).json({ error: err.message });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

/**
 * DELETE /api/pokemon/:pokemonId/like
 * 取消点赞
 */
router.delete('/:pokemonId/like', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const result = await showcaseService.unlikePokemon(req.user.id, pokemonId);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id, pokemonId: req.params.pokemonId }, 'Failed to unlike pokemon');
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/pokemon/:pokemonId/liked
 * 检查是否已点赞
 */
router.get('/:pokemonId/liked', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const isLiked = await showcaseService.hasLiked(req.user.id, pokemonId);
    res.json({ isLiked });
  } catch (err) {
    logger.error({ err, userId: req.user.id, pokemonId: req.params.pokemonId }, 'Failed to check like status');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 评语 API
// ============================================================

/**
 * POST /api/pokemon/:pokemonId/comments
 * 添加评语
 */
router.post('/:pokemonId/comments', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { comment } = req.body;
    
    if (!comment) {
      return res.status(400).json({ error: 'comment is required' });
    }
    
    const result = await showcaseService.addComment(req.user.id, pokemonId, comment);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id, pokemonId: req.params.pokemonId }, 'Failed to add comment');
    
    if (err.message.includes('inappropriate')) {
      res.status(400).json({ error: err.message });
    } else if (err.message.includes('limit')) {
      res.status(429).json({ error: err.message });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

/**
 * GET /api/pokemon/:pokemonId/comments
 * 获取评语列表
 */
router.get('/:pokemonId/comments', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { limit, offset } = req.query;
    
    const result = await showcaseService.getComments(
      pokemonId,
      parseInt(limit) || 20,
      parseInt(offset) || 0
    );
    
    res.json(result);
  } catch (err) {
    logger.error({ err, pokemonId: req.params.pokemonId }, 'Failed to get comments');
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/pokemon/comments/:commentId
 * 删除评语
 */
router.delete('/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    
    const result = await showcaseService.deleteComment(req.user.id, commentId);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user.id, commentId: req.params.commentId }, 'Failed to delete comment');
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// 展示页面 API
// ============================================================

/**
 * GET /api/users/:userId/showcase
 * 获取用户展示页
 */
router.get('/users/:userId/showcase', async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.id || null;
    
    const result = await showcaseService.getUserShowcase(userId, viewerId);
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.params.userId }, 'Failed to get showcase');
    res.status(404).json({ error: err.message });
  }
});

// ============================================================
// 排行榜 API
// ============================================================

/**
 * GET /api/pokemon/showcase/leaderboard
 * 获取排行榜
 */
router.get('/showcase/leaderboard', async (req, res) => {
  try {
    const { type, limit } = req.query;
    
    const result = await showcaseService.getLeaderboard(
      type || 'likes',
      parseInt(limit) || 50
    );
    
    res.json({ leaderboard: result });
  } catch (err) {
    logger.error({ err }, 'Failed to get leaderboard');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 导出
// ============================================================

module.exports = router;
