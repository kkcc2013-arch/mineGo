/**
 * REQ-00059: 新手引导与教程系统
 * 教程 API 路由
 */

const express = require('express');
const router = express.Router();
const tutorialService = require('../tutorialService');
const { requireAuth } = require('../../../../shared/auth');
const logger = require('../../../../shared/logger');

/**
 * GET /api/tutorial/progress
 * 获取教程进度
 */
router.get('/progress', requireAuth, async (req, res) => {
  try {
    const progress = await tutorialService.getTutorialProgress(req.user.id);
    res.json({ success: true, data: progress });
  } catch (error) {
    logger.error('Get tutorial progress failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/current-step
 * 获取当前步骤
 */
router.get('/current-step', requireAuth, async (req, res) => {
  try {
    const step = await tutorialService.getCurrentStep(req.user.id);
    res.json({ success: true, data: step });
  } catch (error) {
    logger.error('Get current step failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/complete-step
 * 完成步骤
 */
router.post('/complete-step', requireAuth, async (req, res) => {
  try {
    const { stepKey } = req.body;
    if (!stepKey) {
      return res.status(400).json({ success: false, error: 'stepKey is required' });
    }
    
    const result = await tutorialService.completeStep(req.user.id, stepKey);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Complete step failed', { userId: req.user.id, stepKey: req.body.stepKey, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/skip
 * 跳过教程
 */
router.post('/skip', requireAuth, async (req, res) => {
  try {
    const result = await tutorialService.skipTutorial(req.user.id);
    res.json(result);
  } catch (error) {
    logger.error('Skip tutorial failed', { userId: req.user.id, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/beginner-tasks
 * 获取新手任务
 */
router.get('/beginner-tasks', requireAuth, async (req, res) => {
  try {
    const tasks = await tutorialService.getBeginnerTasks(req.user.id);
    res.json({ success: true, data: tasks });
  } catch (error) {
    logger.error('Get beginner tasks failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/beginner-tasks/:taskId/claim
 * 领取任务奖励
 */
router.post('/beginner-tasks/:taskId/claim', requireAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await tutorialService.claimBeginnerTaskReward(req.user.id, taskId);
    res.json(result);
  } catch (error) {
    logger.error('Claim beginner task reward failed', { userId: req.user.id, taskId: req.params.taskId, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/smart-tips
 * 获取智能提示
 */
router.get('/smart-tips', requireAuth, async (req, res) => {
  try {
    const context = {
      backpackFull: req.query.backpackFull === 'true',
      pokeballCount: parseInt(req.query.pokeballCount) || 0,
      nearGym: req.query.nearGym === 'true',
      location: req.query.location ? JSON.parse(req.query.location) : null
    };
    
    const tips = await tutorialService.getSmartTips(req.user.id, context);
    res.json({ success: true, data: tips });
  } catch (error) {
    logger.error('Get smart tips failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/smart-tips/:tipId/dismiss
 * 关闭提示
 */
router.post('/smart-tips/:tipId/dismiss', requireAuth, async (req, res) => {
  try {
    const tipId = parseInt(req.params.tipId);
    await tutorialService.dismissTip(req.user.id, tipId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Dismiss tip failed', { userId: req.user.id, tipId: req.params.tipId, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/features
 * 获取功能解锁状态
 */
router.get('/features', requireAuth, async (req, res) => {
  try {
    const { featureKey } = req.query;
    
    if (featureKey) {
      const unlocked = await tutorialService.isFeatureUnlocked(req.user.id, featureKey);
      res.json({ success: true, data: { featureKey, unlocked } });
    } else {
      // 返回所有已解锁功能
      const { db } = require('../../../shared/db');
      const result = await db.query(`
        SELECT fu.feature_key, fu.feature_name, fu.description, ufu.unlocked_at
        FROM feature_unlocks fu
        JOIN user_feature_unlocks ufu ON fu.id = ufu.feature_id
        WHERE ufu.user_id = $1
        ORDER BY ufu.unlocked_at DESC
      `, [req.user.id]);
      
      res.json({ success: true, data: result.rows });
    }
  } catch (error) {
    logger.error('Get features failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/features/:featureKey/unlock
 * 解锁功能
 */
router.post('/features/:featureKey/unlock', requireAuth, async (req, res) => {
  try {
    const { featureKey } = req.params;
    const result = await tutorialService.unlockFeature(req.user.id, featureKey);
    res.json(result);
  } catch (error) {
    logger.error('Unlock feature failed', { userId: req.user.id, featureKey: req.params.featureKey, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/faq/search
 * 搜索FAQ
 */
router.get('/faq/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'Query must be at least 2 characters' });
    }
    
    const results = await tutorialService.searchFAQ(q);
    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Search FAQ failed', { query: req.query.q, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/faq/:faqId
 * 获取FAQ详情
 */
router.get('/faq/:faqId', async (req, res) => {
  try {
    const faqId = parseInt(req.params.faqId);
    const { db } = require('../../../shared/db');
    
    const result = await db.query(
      'SELECT * FROM help_faq WHERE id = $1 AND is_active = TRUE',
      [faqId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'FAQ not found' });
    }
    
    // 记录查看
    await tutorialService.recordFAQView(faqId);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    logger.error('Get FAQ failed', { faqId: req.params.faqId, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/faq/:faqId/feedback
 * 提交FAQ反馈
 */
router.post('/faq/:faqId/feedback', requireAuth, async (req, res) => {
  try {
    const faqId = parseInt(req.params.faqId);
    const { wasHelpful, feedbackText } = req.body;
    
    await tutorialService.submitFAQFeedback(req.user.id, faqId, wasHelpful, feedbackText);
    res.json({ success: true });
  } catch (error) {
    logger.error('Submit FAQ feedback failed', { userId: req.user.id, faqId: req.params.faqId, error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/stats
 * 获取新手统计（管理员）
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user.isAdmin) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    
    const { startDate, endDate } = req.query;
    const stats = await tutorialService.getBeginnerStats(
      startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate || new Date()
    );
    
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Get tutorial stats failed', { userId: req.user.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
