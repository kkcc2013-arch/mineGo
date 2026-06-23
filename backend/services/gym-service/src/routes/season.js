const express = require('express');
const router = express.Router();
const SeasonManager = require('../services/SeasonManager');
const RankManager = require('../services/RankManager');
const TournamentManager = require('../services/TournamentManager');
const { requireAuth } = require('../../../../shared/auth');

// 获取当前赛季信息
router.get('/current', async (req, res) => {
  try {
    const season = await SeasonManager.getCurrentSeason();
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON', message: '当前没有活跃赛季' });
    }
    
    const timeRemaining = Math.max(0, new Date(season.end_time) - new Date());
    
    res.json({
      season,
      timeRemaining: {
        days: Math.floor(timeRemaining / (1000 * 60 * 60 * 24)),
        hours: Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60))
      }
    });
  } catch (error) {
    console.error('Get current season error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取赛季信息失败' });
  }
});

// 获取玩家段位信息
router.get('/rank', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const season = await SeasonManager.getCurrentSeason();
    
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
    }
    
    const rank = await RankManager.getPlayerRank(userId, season.id);
    
    res.json({
      rank,
      tierInfo: RankManager.getTierInfo(rank.tier, rank.tier_level),
      progress: RankManager.getProgressToNextTier(rank)
    });
  } catch (error) {
    console.error('Get player rank error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取段位信息失败' });
  }
});

// 获取段位排行榜
router.get('/leaderboard', async (req, res) => {
  try {
    const season = await SeasonManager.getCurrentSeason();
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
    }
    
    const { tier, limit = 50 } = req.query;
    
    // 简易验证
    if (tier && !['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'].includes(tier)) {
      return res.status(400).json({ error: 'INVALID_TIER', message: '无效的段位' });
    }
    
    const parsedLimit = parseInt(limit);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: 'INVALID_LIMIT', message: '无效的限制数量' });
    }
    
    const leaderboard = await RankManager.getLeaderboard(season.id, { tier, limit: parsedLimit });
    
    res.json({ leaderboard, season: season.id });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取排行榜失败' });
  }
});

// 定位赛匹配
router.post('/placement/match', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const season = await SeasonManager.getCurrentSeason();
    
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
    }
    
    const rank = await RankManager.getPlayerRank(userId, season.id);
    
    if (rank.placement_done) {
      return res.status(400).json({ error: 'PLACEMENT_DONE', message: '定位赛已完成' });
    }
    
    if (rank.placement_matches >= 10) {
      return res.status(400).json({ error: 'PLACEMENT_LIMIT', message: '定位赛次数已达上限' });
    }
    
    // 匹配对手
    const match = await RankManager.findPlacementMatch(userId, rank);
    
    res.json({ match, placementProgress: rank.placement_matches + 1 });
  } catch (error) {
    console.error('Placement match error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '匹配失败' });
  }
});

// 排位赛匹配
router.post('/ranked/match', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const season = await SeasonManager.getCurrentSeason();
    
    if (!season) {
      return res.status(404).json({ error: 'NO_ACTIVE_SEASON' });
    }
    
    const rank = await RankManager.getPlayerRank(userId, season.id);
    
    if (!rank.placement_done) {
      return res.status(400).json({ error: 'PLACEMENT_REQUIRED', message: '请先完成定位赛' });
    }
    
    // 检查段位衰减
    const decayed = await RankManager.checkDecay(userId, season.id);
    if (decayed) {
      return res.status(400).json({ error: 'RANK_DECAYED', message: '段位已衰减，请重新定位' });
    }
    
    // 匹配对手
    const match = await RankManager.findRankedMatch(userId, rank);
    
    res.json({ match, estimatedWaitTime: match.estimatedWaitTime });
  } catch (error) {
    console.error('Ranked match error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '匹配失败' });
  }
});

// 上报排位赛结果
router.post('/ranked/result', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const { matchId, result, battleData } = req.body;
    
    if (!matchId || !result || !battleData) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: '缺失必要字段' });
    }
    
    if (!['win', 'lose', 'draw'].includes(result)) {
      return res.status(400).json({ error: 'INVALID_RESULT', message: '无效的比赛结果' });
    }
    
    const rankChange = await RankManager.processMatchResult(userId, matchId, result, battleData);
    
    res.json({
      rankChange,
      newRank: rankChange.newRank,
      tierChanged: rankChange.tierChanged,
      rewards: rankChange.rewards
    });
  } catch (error) {
    console.error('Report ranked result error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '上报结果失败' });
  }
});

// 获取赛季历史
router.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const { limit = 5 } = req.query;
    
    const parsedLimit = parseInt(limit);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: 'INVALID_LIMIT' });
    }
    
    const history = await SeasonManager.getSeasonHistory(userId, parsedLimit);
    
    res.json({ history });
  } catch (error) {
    console.error('Get season history error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取历史失败' });
  }
});

// 领取赛季奖励
router.post('/rewards/:seasonId/claim', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub || req.user.id;
    const { seasonId } = req.params;
    
    const parsedSeasonId = parseInt(seasonId);
    if (isNaN(parsedSeasonId)) {
      return res.status(400).json({ error: 'INVALID_SEASON_ID' });
    }
    
    const rewards = await SeasonManager.claimSeasonRewards(userId, parsedSeasonId);
    
    res.json({ rewards, claimed: true });
  } catch (error) {
    console.error('Claim season rewards error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '领取奖励失败' });
  }
});

module.exports = router;
