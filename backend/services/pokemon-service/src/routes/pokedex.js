/**
 * REQ-00056: 精灵图鉴完成度奖励系统
 * API 路由
 */

const express = require('express');
const router = express.Router();
const { pokedexService } = require('../pokedexService');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { authenticate, optionalAuth } = require('../../../shared/auth');

const logger = createLogger('pokedex-routes');

/**
 * GET /api/pokedex/progress
 * 获取图鉴完成度进度
 */
router.get('/progress', authenticate, async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(req.user.id);

    res.json({
      success: true,
      data: progress,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get pokedex progress error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/detailed
 * 获取详细图鉴列表
 * Query params: region, type, caught, shiny, seen
 */
router.get('/detailed', authenticate, async (req, res) => {
  try {
    const { region, type, caught, shiny, seen } = req.query;
    const filters = {
      region,
      type,
      caught: caught === 'true' ? true : caught === 'false' ? false : undefined,
      shiny: shiny === 'true',
      seen: seen === 'true' ? true : seen === 'false' ? false : undefined,
    };

    const detailed = await pokedexService.getDetailedProgress(req.user.id, filters);

    res.json({
      success: true,
      data: detailed,
      count: detailed.length,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get detailed pokedex error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/missing
 * 获取未拥有的精灵列表
 * Query params: region, type
 */
router.get('/missing', authenticate, async (req, res) => {
  try {
    const { region, type } = req.query;
    const filters = { region, type };

    const missing = await pokedexService.getMissingPokemon(req.user.id, filters);

    res.json({
      success: true,
      data: missing,
      count: missing.length,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get missing pokemon error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/achievements
 * 获取图鉴成就列表
 */
router.get('/achievements', authenticate, async (req, res) => {
  try {
    const achievements = await pokedexService.getUserAchievements(req.user.id);

    // 计算统计
    const unlocked = achievements.filter((a) => a.unlocked_at).length;
    const total = achievements.length;

    res.json({
      success: true,
      data: achievements,
      stats: {
        total,
        unlocked,
        locked: total - unlocked,
        completionRate: total > 0 ? ((unlocked / total) * 100).toFixed(1) : 0,
      },
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get achievements error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/milestones
 * 获取里程碑列表
 */
router.get('/milestones', authenticate, async (req, res) => {
  try {
    const milestones = await pokedexService.getMilestones(req.user.id);

    // 计算统计
    const claimed = milestones.filter((m) => m.claimed).length;
    const total = milestones.length;
    const available = milestones.filter((m) => !m.claimed).length;

    res.json({
      success: true,
      data: milestones,
      stats: {
        total,
        claimed,
        available,
      },
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get milestones error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pokedex/milestones/:milestoneId/claim
 * 手动领取里程碑奖励
 */
router.post('/milestones/:milestoneId/claim', authenticate, async (req, res) => {
  try {
    const { milestoneId } = req.params;

    // 检查是否已领取
    const existing = await query(
      `SELECT 1 FROM user_milestone_claims WHERE user_id = $1 AND milestone_id = $2`,
      [req.user.id, milestoneId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: '奖励已领取',
      });
    }

    // 检查是否满足条件
    const progress = await pokedexService.getPokedexProgress(req.user.id);
    const milestoneResult = await query(
      'SELECT * FROM pokedex_milestones WHERE id = $1',
      [milestoneId]
    );

    if (milestoneResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '里程碑不存在',
      });
    }

    const milestone = milestoneResult.rows[0];
    let eligible = false;

    switch (milestone.milestone_type) {
      case 'percentage':
        eligible = parseFloat(progress.completion_percentage) >= milestone.threshold;
        break;
      case 'count':
        eligible = progress.caught_count >= milestone.threshold;
        break;
      case 'special':
        if (milestone.category === 'shiny') {
          eligible = progress.shiny_count >= milestone.threshold;
        } else if (milestone.category === 'legendary') {
          eligible = progress.legendary_count >= milestone.threshold;
        }
        break;
    }

    if (!eligible) {
      return res.status(400).json({
        success: false,
        error: '尚未达到领取条件',
      });
    }

    // 领取奖励
    const result = await pokedexService.claimMilestone(req.user.id, parseInt(milestoneId), milestone);

    res.json({
      success: true,
      data: result,
      message: '奖励已发放',
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id, milestoneId: req.params.milestoneId }, 'Claim milestone error');
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/catch-bonus
 * 获取捕捉概率加成
 */
router.get('/catch-bonus', authenticate, async (req, res) => {
  try {
    const bonus = await pokedexService.getCatchBonus(req.user.id);

    res.json({
      success: true,
      data: bonus,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get catch bonus error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/leaderboard
 * 获取图鉴排行榜
 * Query params: limit, offset
 */
router.get('/leaderboard', optionalAuth, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const leaderboard = await pokedexService.getLeaderboard(
      parseInt(limit),
      parseInt(offset)
    );

    res.json({
      success: true,
      data: leaderboard,
    });
  } catch (error) {
    logger.error({ err: error }, 'Get leaderboard error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/rank
 * 获取当前用户排名
 */
router.get('/rank', authenticate, async (req, res) => {
  try {
    const rankInfo = await pokedexService.getUserRank(req.user.id);

    res.json({
      success: true,
      data: rankInfo,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get user rank error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/stats/:userId
 * 获取指定用户的图鉴统计（公开信息）
 */
router.get('/stats/:userId', optionalAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    const progress = await pokedexService.getPokedexProgress(parseInt(userId));

    // 只返回公开信息
    const publicStats = {
      caughtCount: progress.caught_count,
      shinyCount: progress.shiny_count,
      legendaryCount: progress.legendary_count,
      completionPercentage: progress.completion_percentage,
      regionStats: progress.region_stats,
      typeStats: progress.type_stats,
    };

    res.json({
      success: true,
      data: publicStats,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.params.userId }, 'Get user stats error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pokedex/record/seen
 * 记录见过精灵（内部调用）
 */
router.post('/record/seen', authenticate, async (req, res) => {
  try {
    const { pokemonSpeciesId } = req.body;

    if (!pokemonSpeciesId) {
      return res.status(400).json({
        success: false,
        error: 'pokemonSpeciesId 必填',
      });
    }

    const result = await pokedexService.recordSeen(req.user.id, pokemonSpeciesId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Record seen error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pokedex/record/caught
 * 记录捕获精灵（内部调用）
 */
router.post('/record/caught', authenticate, async (req, res) => {
  try {
    const { pokemonSpeciesId, isShiny } = req.body;

    if (!pokemonSpeciesId) {
      return res.status(400).json({
        success: false,
        error: 'pokemonSpeciesId 必填',
      });
    }

    const result = await pokedexService.recordCaught(req.user.id, pokemonSpeciesId, isShiny || false);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Record caught error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/region-stats
 * 获取地区统计
 */
router.get('/region-stats', authenticate, async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(req.user.id);

    res.json({
      success: true,
      data: progress.region_stats || [],
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get region stats error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/type-stats
 * 获取属性统计
 */
router.get('/type-stats', authenticate, async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(req.user.id);

    res.json({
      success: true,
      data: progress.type_stats || [],
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get type stats error');
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/generation-stats
 * 获取世代统计
 */
router.get('/generation-stats', authenticate, async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(req.user.id);

    res.json({
      success: true,
      data: progress.generation_stats || [],
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get generation stats error');
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
