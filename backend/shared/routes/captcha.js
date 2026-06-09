/**
 * CAPTCHA API Routes
 * 风险触发式人机验证 API 路由
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const CaptchaTrigger = require('../shared/captchaTrigger');
const CaptchaValidator = require('../shared/captchaValidator');
const { requireAuth, verifyAccess } = require('../shared/auth');
const { createLogger } = require('../shared/logger');
const { metrics } = require('../shared/metrics');

const logger = createLogger('captcha-routes');

// 初始化
const captchaTrigger = new CaptchaTrigger();
const captchaValidator = new CaptchaValidator();

/**
 * POST /api/captcha/trigger
 * 检查并触发验证
 * 
 * Request Body:
 * - userId: string (optional, will use authenticated user)
 * - action: string (login|catch|gym|trade|...)
 * - context: object
 * 
 * Response:
 * - required: boolean
 * - sessionId: string (if required)
 * - challengeType: string
 * - difficulty: string
 * - challengeData: object
 */
router.post('/trigger', requireAuth, async (req, res) => {
  try {
    const userId = req.body.userId || req.user.id;
    const action = req.body.action || 'unknown';
    const context = req.body.context || {};
    
    // 添加请求信息到上下文
    context.ipAddress = req.ip;
    context.deviceFingerprint = req.headers['x-device-fingerprint'];
    
    // 检查是否需要触发验证
    const trigger = await captchaTrigger.checkTrigger(userId, action, context);
    
    if (!trigger) {
      return res.json({
        required: false,
        message: 'No verification required'
      });
    }
    
    // 触发验证
    const session = await captchaTrigger.trigger(userId, trigger, context);
    
    res.json({
      required: true,
      ...session
    });
    
  } catch (error) {
    logger.error({ error }, 'Error triggering captcha');
    res.status(500).json({
      error: 'captcha_trigger_error',
      message: 'Failed to trigger verification'
    });
  }
});

/**
 * POST /api/captcha/verify
 * 提交验证答案
 * 
 * Request Body:
 * - sessionId: string
 * - answer: object
 * - clientData: object
 *   - responseTimeMs: integer
 *   - trajectory: array
 *   - deviceFingerprint: string
 * 
 * Response:
 * - valid: boolean
 * - message: string
 * - remainingAttempts: integer
 * - trustScoreRecovery: integer
 */
router.post('/verify', async (req, res) => {
  try {
    const { sessionId, answer, clientData } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'missing_session_id',
        message: 'Session ID is required'
      });
    }
    
    // 验证答案
    const result = await captchaValidator.validate(sessionId, answer, clientData || {});
    
    if (result.code) {
      return res.status(result.code).json(result);
    }
    
    res.json(result);
    
  } catch (error) {
    logger.error({ error }, 'Error verifying captcha');
    res.status(500).json({
      error: 'captcha_verify_error',
      message: 'Failed to verify answer'
    });
  }
});

/**
 * GET /api/captcha/challenge/:sessionId
 * 获取验证挑战
 * 
 * Response:
 * - sessionId: string
 * - sessionType: string
 * - difficulty: string
 * - challengeData: object
 */
router.get('/challenge/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await captchaValidator.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: 'session_not_found',
        message: 'Verification session not found'
      });
    }
    
    if (session.status !== 'pending') {
      return res.status(400).json({
        error: 'session_completed',
        message: `Session already ${session.status}`,
        status: session.status
      });
    }
    
    // 返回挑战数据（不包含答案）
    const challengeData = JSON.parse(session.challenge_data);
    delete challengeData.expectedAnswer;
    
    res.json({
      sessionId: session.id,
      sessionType: session.session_type,
      difficulty: session.difficulty,
      challengeData,
      expiresAt: session.expires_at,
      attemptsRemaining: session.max_attempts - session.attempt_count
    });
    
  } catch (error) {
    logger.error({ error }, 'Error getting captcha challenge');
    res.status(500).json({
      error: 'captcha_challenge_error',
      message: 'Failed to get challenge'
    });
  }
});

/**
 * GET /api/captcha/status/:userId
 * 获取用户验证状态
 * 
 * Response:
 * - lastVerification: timestamp
 * - totalVerifications: integer
 * - passedVerifications: integer
 * - failedVerifications: integer
 * - passRate: number
 * - currentTrustScore: integer
 */
router.get('/status/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 获取验证统计
    const statsResult = await captchaValidator.db.query(
      `SELECT * FROM captcha_stats WHERE user_id = $1`,
      [userId]
    );
    
    // 获取当前可信度
    const trustScore = await captchaTrigger.getUserTrustScore(userId);
    
    const stats = statsResult.rows[0] || {
      total_verifications: 0,
      passed_verifications: 0,
      failed_verifications: 0,
      last_verification_at: null
    };
    
    const passRate = stats.total_verifications > 0
      ? stats.passed_verifications / stats.total_verifications
      : 0;
    
    res.json({
      userId,
      lastVerification: stats.last_verification_at,
      totalVerifications: stats.total_verifications,
      passedVerifications: stats.passed_verifications,
      failedVerifications: stats.failed_verifications,
      passRate,
      currentTrustScore: trustScore,
      avgResponseTimeMs: stats.avg_response_time_ms
    });
    
  } catch (error) {
    logger.error({ error }, 'Error getting captcha status');
    res.status(500).json({
      error: 'captcha_status_error',
      message: 'Failed to get verification status'
    });
  }
});

/**
 * GET /api/captcha/config
 * 获取验证配置（管理员）
 */
router.get('/config', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
    }
    
    const result = await captchaValidator.db.query(
      `SELECT * FROM captcha_config ORDER BY key`
    );
    
    const config = {};
    result.rows.forEach(row => {
      config[row.key] = row.value;
    });
    
    res.json({ config });
    
  } catch (error) {
    logger.error({ error }, 'Error getting captcha config');
    res.status(500).json({
      error: 'captcha_config_error',
      message: 'Failed to get configuration'
    });
  }
});

/**
 * PUT /api/captcha/config
 * 更新验证配置（管理员）
 */
router.put('/config', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
    }
    
    const { key, value } = req.body;
    
    if (!key) {
      return res.status(400).json({
        error: 'missing_key',
        message: 'Configuration key is required'
      });
    }
    
    await captchaValidator.db.query(
      `INSERT INTO captcha_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    
    logger.info({ key, value, userId: req.user.id }, 'Captcha config updated');
    
    res.json({ success: true, key, value });
    
  } catch (error) {
    logger.error({ error }, 'Error updating captcha config');
    res.status(500).json({
      error: 'captcha_config_update_error',
      message: 'Failed to update configuration'
    });
  }
});

/**
 * GET /api/captcha/rules
 * 获取触发规则列表（管理员）
 */
router.get('/rules', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
    }
    
    const result = await captchaValidator.db.query(
      `SELECT * FROM captcha_trigger_rules ORDER BY trigger_type`
    );
    
    res.json({ rules: result.rows });
    
  } catch (error) {
    logger.error({ error }, 'Error getting captcha rules');
    res.status(500).json({
      error: 'captcha_rules_error',
      message: 'Failed to get trigger rules'
    });
  }
});

/**
 * PUT /api/captcha/rules/:triggerType
 * 更新触发规则（管理员）
 */
router.put('/rules/:triggerType', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
    }
    
    const { triggerType } = req.params;
    const { enabled, difficulty_override, cooldown_seconds } = req.body;
    
    const result = await captchaValidator.db.query(
      `UPDATE captcha_trigger_rules
       SET enabled = COALESCE($2, enabled),
           difficulty_override = COALESCE($3, difficulty_override),
           cooldown_seconds = COALESCE($4, cooldown_seconds)
       WHERE trigger_type = $1
       RETURNING *`,
      [triggerType, enabled, difficulty_override, cooldown_seconds]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'rule_not_found',
        message: 'Trigger rule not found'
      });
    }
    
    logger.info({ 
      triggerType, 
      updates: req.body, 
      userId: req.user.id 
    }, 'Captcha trigger rule updated');
    
    res.json({ success: true, rule: result.rows[0] });
    
  } catch (error) {
    logger.error({ error }, 'Error updating captcha rule');
    res.status(500).json({
      error: 'captcha_rule_update_error',
      message: 'Failed to update trigger rule'
    });
  }
});

/**
 * GET /api/captcha/history
 * 获取验证历史（管理员）
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
    }
    
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    let query = `SELECT id, user_id, session_type, difficulty, trigger_reason, 
                        status, attempt_count, created_at, completed_at
                 FROM captcha_sessions`;
    const params = [];
    
    if (userId) {
      query += ` WHERE user_id = $1`;
      params.push(userId);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await captchaValidator.db.query(query, params);
    
    res.json({ 
      sessions: result.rows,
      limit,
      offset
    });
    
  } catch (error) {
    logger.error({ error }, 'Error getting captcha history');
    res.status(500).json({
      error: 'captcha_history_error',
      message: 'Failed to get verification history'
    });
  }
});

module.exports = router;
