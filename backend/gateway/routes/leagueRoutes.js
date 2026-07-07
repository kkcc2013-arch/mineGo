// REQ-00487: 联赛系统路由
'use strict';

const express = require('express');
const router = express.Router();
const LeagueService = require('@pmg/shared/LeagueService');
const authMiddleware = require('@pmg/shared/authMiddleware');

// 初始化联赛服务
const dbPool = require('@pmg/shared/db');
const leagueService = new LeagueService(dbPool);

/**
 * GET /api/league/info
 * 获取当前赛季信息
 */
router.get('/info', async (req, res) => {
  try {
    const season = await leagueService.getCurrentSeason();
    res.json({
      success: true,
      data: season
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/league/player/:id
 * 获取玩家联赛信息
 */
router.get('/player/:id', authMiddleware, async (req, res) => {
  try {
    const playerId = parseInt(req.params.id);
    const leagueInfo = await leagueService.getPlayerLeagueInfo(playerId);
    
    res.json({
      success: true,
      data: leagueInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/league/ranking/:level/:group
 * 获取联赛排行榜
 */
router.get('/ranking/:level/:group', async (req, res) => {
  try {
    const { level, group } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    
    const ranking = await leagueService.getLeagueRanking(level, group, limit);
    
    res.json({
      success: true,
      data: ranking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/league/match/find
 * 查找联赛匹配
 */
router.post('/match/find', authMiddleware, async (req, res) => {
  try {
    const playerId = req.user.id;
    const opponent = await leagueService.findMatch(playerId);
    
    res.json({
      success: true,
      data: opponent ? {
        found: true,
        opponent: {
          id: opponent.player_id,
          rating: opponent.league_rating,
          level: opponent.league_level,
          group: opponent.league_group
        }
      } : {
        found: false,
        message: 'No suitable opponent found. Please try again later.'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/league/match/result
 * 提交对战结果
 */
router.post('/match/result', authMiddleware, async (req, res) => {
  try {
    const { player1Id, player2Id, winnerId, matchDuration } = req.body;
    
    // 验证用户权限
    if (req.user.id !== player1Id && req.user.id !== player2Id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized to submit match result'
      });
    }
    
    const result = await leagueService.processMatchResult(
      player1Id, player2Id, winnerId, matchDuration
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/league/history/:id
 * 获取玩家升降级历史
 */
router.get('/history/:id', authMiddleware, async (req, res) => {
  try {
    const playerId = parseInt(req.params.id);
    const season = await leagueService.getCurrentSeason();
    
    const result = await dbPool.query(`
      SELECT * FROM league_history
      WHERE player_id = $1 AND season_id = $2
      ORDER BY created_at DESC
    `, [playerId, season.id]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/league/season/status
 * 获取赛季状态
 */
router.get('/season/status', async (req, res) => {
  try {
    const season = await leagueService.getCurrentSeason();
    const now = new Date();
    const remainingMs = season.end_time - now;
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    
    res.json({
      success: true,
      data: {
        seasonNumber: season.season_number,
        status: season.status,
        startTime: season.start_time,
        endTime: season.end_time,
        remainingDays: Math.max(0, remainingDays),
        totalPlayers: season.total_players,
        isSeasonEnding: remainingDays <= 3
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/league/rewards/pending
 * 获取待领取奖励
 */
router.get('/rewards/pending', authMiddleware, async (req, res) => {
  try {
    const playerId = req.user.id;
    const rewards = await leagueService.getPendingRewards(playerId);
    
    res.json({
      success: true,
      data: rewards
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/league/rewards/claim
 * 领取奖励
 */
router.post('/rewards/claim', authMiddleware, async (req, res) => {
  try {
    const { rewardId } = req.body;
    const playerId = req.user.id;
    
    const reward = await leagueService.claimReward(playerId, rewardId);
    
    res.json({
      success: true,
      data: {
        claimed: true,
        reward: reward.reward_data
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
