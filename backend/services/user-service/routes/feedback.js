/**
 * 用户服务 - 反馈路由
 * REQ-00339: 玩家反馈收集与智能分析系统
 */

const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const auth = require('../../../shared/auth');
const FeedbackController = require('../controllers/FeedbackController');

/**
 * 提交反馈
 * POST /api/v1/feedback
 */
router.post('/',
  auth.authenticate,
  [
    body('feedback_type')
      .isIn(['bug', 'suggestion', 'complaint', 'other'])
      .withMessage('Invalid feedback type'),
    body('content')
      .isLength({ min: 10, max: 2000 })
      .withMessage('Content must be between 10 and 2000 characters'),
    body('title')
      .optional()
      .isLength({ max: 200 })
      .withMessage('Title must be less than 200 characters'),
    body('category')
      .optional()
      .isLength({ max: 50 }),
    body('tags')
      .optional()
      .isArray({ max: 5 })
      .withMessage('Maximum 5 tags allowed'),
    body('attachments')
      .optional()
      .isArray({ max: 3 })
      .withMessage('Maximum 3 attachments allowed'),
    body('pokemon_id')
      .optional()
      .isInt({ min: 1 }),
    body('battle_id')
      .optional()
      .isInt({ min: 1 })
  ],
  FeedbackController.submitFeedback
);

/**
 * 获取用户反馈历史
 * GET /api/v1/feedback/my-feedbacks
 */
router.get('/my-feedbacks',
  auth.authenticate,
  [
    query('status')
      .optional()
      .isIn(['pending', 'in_progress', 'resolved', 'closed']),
    query('type')
      .optional()
      .isIn(['bug', 'suggestion', 'complaint', 'other']),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .toInt(),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .toInt()
  ],
  FeedbackController.getUserFeedbacks
);

/**
 * 获取反馈详情
 * GET /api/v1/feedback/:id
 */
router.get('/:id',
  auth.authenticate,
  [
    param('id').isInt({ min: 1 }).toInt()
  ],
  FeedbackController.getFeedbackDetail
);

/**
 * 更新反馈（补充信息）
 * PATCH /api/v1/feedback/:id
 */
router.patch('/:id',
  auth.authenticate,
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('content')
      .optional()
      .isLength({ min: 10, max: 2000 }),
    body('tags')
      .optional()
      .isArray({ max: 5 }),
    body('attachments')
      .optional()
      .isArray({ max: 3 })
  ],
  FeedbackController.updateFeedback
);

/**
 * 取消反馈
 * DELETE /api/v1/feedback/:id
 */
router.delete('/:id',
  auth.authenticate,
  [
    param('id').isInt({ min: 1 }).toInt()
  ],
  FeedbackController.cancelFeedback
);

/**
 * 获取反馈标签列表
 * GET /api/v1/feedback/tags/list
 */
router.get('/tags/list',
  auth.optionalAuth,
  FeedbackController.getFeedbackTags
);

/**
 * 获取常见问题FAQ
 * GET /api/v1/feedback/faq/list
 */
router.get('/faq/list',
  auth.optionalAuth,
  [
    query('category').optional().isString(),
    query('keyword').optional().isString()
  ],
  FeedbackController.getFAQ
);

/**
 * 反馈FAQ有帮助
 * POST /api/v1/feedback/faq/:id/helpful
 */
router.post('/faq/:id/helpful',
  auth.optionalAuth,
  [
    param('id').isInt({ min: 1 }).toInt()
  ],
  FeedbackController.markFAQHelpful
);

/**
 * 获取反馈统计（用户自己的）
 * GET /api/v1/feedback/stats
 */
router.get('/stats/summary',
  auth.authenticate,
  FeedbackController.getUserStats
);

module.exports = router;
