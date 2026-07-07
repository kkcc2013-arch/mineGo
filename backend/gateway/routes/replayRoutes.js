/**
 * REQ-00469: 游戏实时对战回放录制与分享系统 - API 路由
 * 创建时间: 2026-07-07 17:05 UTC
 * 
 * API 端点:
 * - GET /replays - 获取用户回放列表
 * - GET /replay/:id - 获取回放详情
 * - POST /replay/:id/share - 生成分享链接
 * - GET /replay/:code/view - 查看分享回放
 * - POST /replay/:code/verify - 验证密码保护
 * - DELETE /replay/:id - 删除回放
 * - GET /replay/:id/stats - 获取回放统计
 * - POST /replay/:id/like - 点赞回放
 */

const express = require('express');
const router = express.Router();
const ReplayService = require('../../shared/ReplayService');
const auth = require('../../shared/auth');
const metrics = require('../../shared/metrics');
const logger = require('../../shared/logger');

/**
 * GET /replays
 * 获取用户的回放列表
 */
router.get('/replays', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { limit, offset, result } = req.query;
  
  try {
    const replays = await ReplayService.getUserReplays(userId, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
      result: result || 'all'
    });
    
    res.json({
      success: true,
      ...replays
    });
    
  } catch (error) {
    logger.error('Failed to get replays', {
      error: error.message,
      userId
    });
    res.status(500).json({ error: '获取回放列表失败' });
  }
});

/**
 * GET /replay/:id
 * 获取回放详情
 */
router.get('/replay/:id', auth.optionalAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;
  
  try {
    const replay = await ReplayService.getReplay(id, userId);
    
    if (!replay) {
      return res.status(404).json({ error: '回放不存在' });
    }
    
    if (replay.error) {
      if (replay.error === 'password_required') {
        return res.status(403).json({
          error: 'password_required',
          message: '该回放需要密码访问',
          shareCode: replay.shareCode
        });
      }
      if (replay.error === 'view_limit_exceeded') {
        return res.status(403).json({
          error: 'view_limit_exceeded',
          message: replay.message
        });
      }
      return res.status(403).json({ error: replay.error, message: replay.message });
    }
    
    res.json({
      success: true,
      replay
    });
    
  } catch (error) {
    logger.error('Failed to get replay', {
      error: error.message,
      replayId: id
    });
    res.status(500).json({ error: '获取回放失败' });
  }
});

/**
 * POST /replay/:id/share
 * 生成分享链接
 */
router.post('/replay/:id/share', auth.requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { isPublic, password, maxViews, platform, expiresAt } = req.body;
  
  try {
    // 验证回放所有权
    const replay = await ReplayService.getReplay(id, userId);
    
    if (!replay) {
      return res.status(404).json({ error: '回放不存在' });
    }
    
    // 生成分享链接
    const shareResult = await ReplayService.generateShareLink(id, userId, {
      isPublic: isPublic !== false,
      password,
      maxViews: maxViews || 0,
      platform,
      expiresAt: expiresAt ? new Date(expiresAt) : null
    });
    
    logger.info('Share link created', {
      replayId: id,
      shareCode: shareResult.shareCode,
      userId,
      isPublic
    });
    
    metrics.replayShareCreateTotal.inc();
    
    res.json({
      success: true,
      share: shareResult
    });
    
  } catch (error) {
    logger.error('Failed to create share link', {
      error: error.message,
      replayId: id,
      userId
    });
    res.status(500).json({ error: '生成分享链接失败' });
  }
});

/**
 * GET /replay/:code/view
 * 通过分享码查看回放
 */
router.get('/replay/:code/view', auth.optionalAuth, async (req, res) => {
  const { code } = req.params;
  const userId = req.user?.id;
  const password = req.query.password;
  
  try {
    const replay = await ReplayService.getReplay(code, userId);
    
    if (!replay) {
      return res.status(404).json({ error: '分享链接不存在' });
    }
    
    if (replay.error === 'password_required') {
      // 如果提供了密码，验证密码
      if (password) {
        const verifyResult = await ReplayService.verifySharePassword(code, password);
        
        if (!verifyResult.valid) {
          return res.status(401).json({ error: verifyResult.error });
        }
        
        // 密码正确，重新获取回放
        const verifiedReplay = await ReplayService.getReplay(verifyResult.replayId, userId);
        return res.json({ success: true, replay: verifiedReplay });
      }
      
      return res.status(403).json({
        error: 'password_required',
        message: '请输入密码以访问该回放',
        shareCode: code
      });
    }
    
    if (replay.error) {
      return res.status(403).json({ error: replay.error, message: replay.message });
    }
    
    res.json({
      success: true,
      replay
    });
    
  } catch (error) {
    logger.error('Failed to view replay by share code', {
      error: error.message,
      shareCode: code
    });
    res.status(500).json({ error: '查看回放失败' });
  }
});

/**
 * POST /replay/:code/verify
 * 验证密码保护的回放
 */
router.post('/replay/:code/verify', async (req, res) => {
  const { code } = req.params;
  const { password } = req.body;
  
  try {
    if (!password) {
      return res.status(400).json({ error: '请提供密码' });
    }
    
    const verifyResult = await ReplayService.verifySharePassword(code, password);
    
    if (!verifyResult.valid) {
      return res.status(401).json({ error: verifyResult.error });
    }
    
    // 获取回放详情
    const replay = await ReplayService.getReplay(verifyResult.replayId);
    
    res.json({
      success: true,
      replay
    });
    
  } catch (error) {
    logger.error('Failed to verify share password', {
      error: error.message,
      shareCode: code
    });
    res.status(500).json({ error: '验证失败' });
  }
});

/**
 * DELETE /replay/:id
 * 删除回放
 */
router.delete('/replay/:id', auth.requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    const result = await ReplayService.deleteReplay(id, userId);
    
    if (!result.success) {
      return res.status(403).json({ error: result.error });
    }
    
    logger.info('Replay deleted', { replayId: id, userId });
    
    res.json({
      success: true,
      message: '回放已删除'
    });
    
  } catch (error) {
    logger.error('Failed to delete replay', {
      error: error.message,
      replayId: id,
      userId
    });
    res.status(500).json({ error: '删除失败' });
  }
});

/**
 * GET /replay/:id/stats
 * 获取回放统计信息
 */
router.get('/replay/:id/stats', auth.optionalAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    const replay = await ReplayService.getReplay(id);
    
    if (!replay) {
      return res.status(404).json({ error: '回放不存在' });
    }
    
    // 计算详细统计
    const stats = ReplayService.calculateBattleStats(replay.eventStream);
    
    res.json({
      success: true,
      stats: {
        ...stats,
        turns: replay.turns,
        duration: replay.duration,
        viewCount: replay.viewCount,
        shareCount: replay.shareCount
      }
    });
    
  } catch (error) {
    logger.error('Failed to get replay stats', {
      error: error.message,
      replayId: id
    });
    res.status(500).json({ error: '获取统计失败' });
  }
});

/**
 * POST /replay/:id/like
 * 点赞回放
 */
router.post('/replay/:id/like', auth.requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    const db = require('../../shared/db');
    
    // 检查是否已点赞
    const existingResult = await db.query(`
      SELECT id FROM replay_likes
      WHERE replay_id = $1 AND user_id = $2
    `, [id, userId]);
    
    if (existingResult.rows.length > 0) {
      // 取消点赞
      await db.query(`
        DELETE FROM replay_likes
        WHERE replay_id = $1 AND user_id = $2
      `, [id, userId]);
      
      await db.query(`
        UPDATE battle_replay_records
        SET like_count = like_count - 1
        WHERE id = $1
      `, [id]);
      
      res.json({
        success: true,
        liked: false,
        message: '已取消点赞'
      });
      
    } else {
      // 添加点赞
      await db.query(`
        INSERT INTO replay_likes (replay_id, user_id)
        VALUES ($1, $2)
      `, [id, userId]);
      
      await db.query(`
        UPDATE battle_replay_records
        SET like_count = like_count + 1
        WHERE id = $1
      `, [id]);
      
      res.json({
        success: true,
        liked: true,
        message: '已点赞'
      });
    }
    
  } catch (error) {
    logger.error('Failed to like replay', {
      error: error.message,
      replayId: id,
      userId
    });
    res.status(500).json({ error: '点赞失败' });
  }
});

/**
 * POST /replay/:id/comment
 * 评论回放
 */
router.post('/replay/:id/comment', auth.requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { comment, parentCommentId } = req.body;
  
  try {
    if (!comment || comment.trim().length === 0) {
      return res.status(400).json({ error: '请输入评论内容' });
    }
    
    if (comment.length > 500) {
      return res.status(400).json({ error: '评论内容过长（最多500字）' });
    }
    
    const db = require('../../shared/db');
    
    // 验证回放存在
    const replayCheck = await db.query(`
      SELECT id FROM battle_replay_records WHERE id = $1
    `, [id]);
    
    if (replayCheck.rows.length === 0) {
      return res.status(404).json({ error: '回放不存在' });
    }
    
    // 插入评论
    const result = await db.query(`
      INSERT INTO replay_comments (replay_id, user_id, comment, parent_comment_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, userId, comment.trim(), parentCommentId || null]);
    
    res.json({
      success: true,
      comment: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Failed to comment replay', {
      error: error.message,
      replayId: id,
      userId
    });
    res.status(500).json({ error: '评论失败' });
  }
});

/**
 * GET /replay/:id/comments
 * 获取回放评论列表
 */
router.get('/replay/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { limit, offset } = req.query;
  
  try {
    const db = require('../../shared/db');
    
    const result = await db.query(`
      SELECT rc.*, u.username, u.avatar_url
      FROM replay_comments rc
      JOIN users u ON rc.user_id = u.id
      WHERE rc.replay_id = $1
      ORDER BY rc.created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, parseInt(limit) || 20, parseInt(offset) || 0]);
    
    res.json({
      success: true,
      comments: result.rows
    });
    
  } catch (error) {
    logger.error('Failed to get comments', {
      error: error.message,
      replayId: id
    });
    res.status(500).json({ error: '获取评论失败' });
  }
});

/**
 * POST /replay/:id/highlight/:highlightId/share
 * 分享精彩片段
 */
router.post('/replay/:id/highlight/:highlightId/share', auth.requireAuth, async (req, res) => {
  const { id, highlightId } = req.params;
  const userId = req.user.id;
  const { platform } = req.body;
  
  try {
    const db = require('../../shared/db');
    
    // 验证精彩片段存在
    const highlightCheck = await db.query(`
      SELECT rh.*, brr.attacker_user_id
      FROM replay_highlights rh
      JOIN battle_replay_records brr ON rh.replay_id = brr.id
      WHERE rh.id = $1 AND rh.replay_id = $2
    `, [highlightId, id]);
    
    if (highlightCheck.rows.length === 0) {
      return res.status(404).json({ error: '精彩片段不存在' });
    }
    
    const highlight = highlightCheck.rows[0];
    
    // 生成分享链接
    const shareResult = await ReplayService.generateShareLink(id, userId, {
      isPublic: true,
      platform
    });
    
    // 更新精彩片段分享统计
    await db.query(`
      UPDATE replay_highlights
      SET share_count = share_count + 1
      WHERE id = $1
    `, [highlightId]);
    
    res.json({
      success: true,
      share: shareResult,
      highlight: {
        title: highlight.title,
        description: highlight.description,
        type: highlight.highlight_type
      }
    });
    
  } catch (error) {
    logger.error('Failed to share highlight', {
      error: error.message,
      replayId: id,
      highlightId
    });
    res.status(500).json({ error: '分享失败' });
  }
});

module.exports = router;