/**
 * 季节系统 API 路由
 */

const express = require('express');
const router = express.Router();
const { SeasonalRewardManager } = require('../seasonalRewards');
const { SeasonalEngine } = require('../../../shared/seasonalEngine');

// 初始化管理器（在实际应用中通过依赖注入）
let seasonalManager = null;
let seasonalEngine = null;

const initManagers = (req) => {
  if (!seasonalEngine) {
    seasonalEngine = new SeasonalEngine();
  }
  if (!seasonalManager) {
    seasonalManager = new SeasonalRewardManager(
      req.app.locals.db,
      req.app.locals.redis,
      req.app.locals.eventBus
    );
  }
};

/**
 * GET /api/seasonal/current
 * 获取当前季节信息
 */
router.get('/current', async (req, res) => {
  try {
    initManagers(req);

    const season = seasonalEngine.currentSeason;
    const config = await seasonalEngine.loadSeasonConfig(season);
    const transition = seasonalEngine.calculateTransitionProgress();

    res.json({
      success: true,
      data: {
        season,
        info: seasonalEngine.getSeasonInfo(season),
        config,
        transitionProgress: transition,
        nextSeason: seasonalEngine.getNextSeason(),
        seasonalPokemon: seasonalEngine.getSeasonalPokemon(),
        typeBonuses: seasonalEngine.getTypeBonuses(),
        hotspotTypes: seasonalEngine.getHotspotTypes()
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting current season:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/quests
 * 获取季节任务
 */
router.get('/quests', async (req, res) => {
  try {
    initManagers(req);

    const userId = req.user?.id;
    const quests = seasonalEngine.getSeasonalQuests();
    let progress = [];

    if (userId) {
      progress = await seasonalManager.getUserQuestProgress(userId);
    }

    res.json({
      success: true,
      data: {
        quests,
        progress,
        season: seasonalEngine.currentSeason
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting quests:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/seasonal/quests/:questId/progress
 * 更新任务进度
 */
router.post('/quests/:questId/progress', async (req, res) => {
  try {
    initManagers(req);

    const { questId } = req.params;
    const { increment = 1 } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    await seasonalManager.updateQuestProgress(userId, questId, increment);

    res.json({ success: true });
  } catch (error) {
    console.error('[SeasonalAPI] Error updating quest progress:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/seasonal/quests/:questId/claim
 * 领取任务奖励
 */
router.post('/quests/:questId/claim', async (req, res) => {
  try {
    initManagers(req);

    const { questId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const result = await seasonalManager.claimQuestReward(userId, questId);

    res.json(result);
  } catch (error) {
    console.error('[SeasonalAPI] Error claiming reward:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/shop
 * 获取季节商店
 */
router.get('/shop', async (req, res) => {
  try {
    initManagers(req);

    const shop = seasonalManager.getSeasonalShop();

    res.json({
      success: true,
      data: {
        shop,
        season: seasonalEngine.currentSeason,
        seasonInfo: seasonalEngine.getSeasonInfo()
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting shop:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/seasonal/shop/:itemId/purchase
 * 购买季节商品
 */
router.post('/shop/:itemId/purchase', async (req, res) => {
  try {
    initManagers(req);

    const { itemId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const result = await seasonalManager.purchaseItem(userId, itemId);

    res.json(result);
  } catch (error) {
    console.error('[SeasonalAPI] Error purchasing item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/achievements
 * 获取季节成就
 */
router.get('/achievements', async (req, res) => {
  try {
    initManagers(req);

    const achievements = seasonalManager.getSeasonalAchievements();

    res.json({
      success: true,
      data: {
        achievements,
        season: seasonalEngine.currentSeason
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting achievements:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/progress
 * 获取季节进度
 */
router.get('/progress', async (req, res) => {
  try {
    initManagers(req);

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const progress = await seasonalManager.getSeasonalProgress(userId);

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting progress:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/seasonal/track
 * 追踪季节活动
 */
router.post('/track', async (req, res) => {
  try {
    initManagers(req);

    const { action, value = 1 } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    await seasonalManager.trackSeasonalProgress(userId, action, value);

    res.json({ success: true });
  } catch (error) {
    console.error('[SeasonalAPI] Error tracking progress:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/report/:season/:year
 * 获取季节总结报告
 */
router.get('/report/:season/:year', async (req, res) => {
  try {
    initManagers(req);

    const { season, year } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const report = await seasonalManager.generateSeasonReport(
      userId,
      season.toUpperCase(),
      parseInt(year)
    );

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error generating report:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/seasonal/bonuses
 * 获取类型加成
 */
router.get('/bonuses', async (req, res) => {
  try {
    initManagers(req);

    res.json({
      success: true,
      data: {
        season: seasonalEngine.currentSeason,
        bonuses: seasonalEngine.getTypeBonuses()
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error getting bonuses:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/seasonal/calculate-weight
 * 计算精灵刷新权重
 */
router.post('/calculate-weight', async (req, res) => {
  try {
    initManagers(req);

    const { pokemonId, pokemonType, baseWeight = 1.0 } = req.body;

    const weight = seasonalEngine.calculateSpawnWeight(
      pokemonId,
      pokemonType,
      baseWeight
    );

    res.json({
      success: true,
      data: {
        pokemonId,
        pokemonType,
        baseWeight,
        finalWeight: weight,
        season: seasonalEngine.currentSeason
      }
    });
  } catch (error) {
    console.error('[SeasonalAPI] Error calculating weight:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
