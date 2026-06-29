'use strict';

/**
 * CAPTCHA 验证路由
 * 提供验证触发、提交、状态查询等接口
 */

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');

const CaptchaChallengeGenerator = require('../../shared/CaptchaChallengeGenerator');
const CaptchaValidator = require('../../shared/CaptchaValidator');
const CaptchaTrigger = require('../../shared/CaptchaTrigger');
const { Pool } = require('pg');
const redis = require('redis');

// 初始化
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
const challengeGenerator = new CaptchaChallengeGenerator();
const captchaValidator = new CaptchaValidator();
const captchaTrigger = new CaptchaTrigger();

/**
 * POST /api/captcha/trigger
 * 检查并触发验证
 */
router.post('/trigger',
  [
    body('userId').isInt({ min: 1 }),
    body('action').isIn(['login', 'catch', 'gym', 'trade', 'gift', 'evolve', 'battle']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
      }

      const { userId, action } = req.body;
      const context = req.body.context || {};

      // 获取用户可信度数据
      const userResult = await db.query(
        `SELECT 
          u.id, 
          u.trust_score,
          cs.last_verification_at as last_captcha_verification,
          cs.total_verifications,
          cs.passed_verifications,
          u.last_login_location,
          u.current_location
        FROM users u
        LEFT JOIN captcha_stats cs ON u.id = cs.user_id
        WHERE u.id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // 检查是否需要触发验证
      const trigger = await captchaTrigger.shouldTrigger(user, action, context);

      if (!trigger) {
        return res.json({
          required: false,
          message: 'No verification required'
        });
      }

      // 生成挑战
      const challenge = challengeGenerator.generate(trigger.difficulty);

      // 创建验证会话
      const sessionResult = await db.query(
        `INSERT INTO captcha_sessions 
          (user_id, session_type, difficulty, trigger_reason, challenge_data, expected_answer, 
           expires_at, ip_address, device_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          userId,
          challenge.type,
          challenge.difficulty,
          trigger.reason,
          JSON.stringify(challenge),
          JSON.stringify({ answerHash: challenge.answerHash, correctOptionIndex: challenge.correctOptionIndex }),
          challenge.expiresAt,
          req.ip,
          context.deviceFingerprint
        ]
      );

      const sessionId = sessionResult.rows[0].id;

      // 记录触发日志
      await db.query(
        `INSERT INTO captcha_trigger_logs (user_id, trigger_reason, difficulty, session_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, trigger.reason, challenge.difficulty, sessionId]
      );

      // 返回挑战（不包含答案）
      const responseChallenge = {
        sessionId,
        type: challenge.type,
        difficulty: challenge.difficulty,
        gridSize: challenge.gridSize,
        pieces: challenge.pieces,
        grid: challenge.grid,
        targetChars: challenge.targetChars,
        question: challenge.question,
        options: challenge.options,
        expiresAt: challenge.expiresAt
      };

      res.json({
        required: true,
        sessionId,
        triggerReason: trigger.reason,
        difficulty: trigger.difficulty,
        description: trigger.description,
        challenge: responseChallenge
      });

    } catch (error) {
      console.error('CAPTCHA trigger error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/captcha/verify
 * 提交验证答案
 */
router.post('/verify',
  [
    body('sessionId').isUUID(),
    body('answer').notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
      }

      const { sessionId, answer, clientData } = req.body;

      // 获取会话
      const sessionResult = await db.query(
        `SELECT * FROM captcha_sessions WHERE id = $1`,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = sessionResult.rows[0];

      // 增加尝试次数
      await db.query(
        `UPDATE captcha_sessions SET attempt_count = attempt_count + 1 WHERE id = $1`,
        [sessionId]
      );

      // 验证答案
      const validation = captchaValidator.validate(session, answer, clientData);

      const responseTime = clientData?.responseTimeMs || 0;

      if (validation.valid) {
        // 验证通过
        await db.query(
          `UPDATE captcha_sessions 
           SET status = 'passed', completed_at = NOW(), client_data = $1 
           WHERE id = $2`,
          [JSON.stringify(clientData), sessionId]
        );

        // 更新统计
        await db.query(
          `INSERT INTO captcha_stats (user_id, total_verifications, passed_verifications, avg_response_time_ms, last_verification_at, last_passed_verification_at)
           VALUES ($1, 1, 1, $2, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             total_verifications = captcha_stats.total_verifications + 1,
             passed_verifications = captcha_stats.passed_verifications + 1,
             avg_response_time_ms = (captcha_stats.avg_response_time_ms * captcha_stats.passed_verifications + $2) / (captcha_stats.passed_verifications + 1),
             last_verification_at = NOW(),
             last_passed_verification_at = NOW(),
             updated_at = NOW()`,
          [session.user_id, responseTime]
        );

        // 恢复可信度
        const config = await getCaptchaConfig();
        await db.query(
          `UPDATE users SET trust_score = LEAST(100, trust_score + $1) WHERE id = $2`,
          [config.trust_score_recovery, session.user_id]
        );

        // 更新触发日志
        await db.query(
          `UPDATE captcha_trigger_logs 
           SET resolved_at = NOW(), resolution = 'passed' 
           WHERE session_id = $1`,
          [sessionId]
        );

        res.json({
          valid: true,
          message: 'Verification passed',
          trustScoreRecovery: config.trust_score_recovery
        });

      } else {
        // 验证失败
        const status = session.attempt_count + 1 >= session.max_attempts ? 'failed' : 'pending';
        
        await db.query(
          `UPDATE captcha_sessions 
           SET status = $1, completed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE completed_at END, client_data = $2 
           WHERE id = $3`,
          [status, JSON.stringify(clientData), sessionId]
        );

        // 更新统计
        await db.query(
          `INSERT INTO captcha_stats (user_id, total_verifications, failed_verifications, avg_response_time_ms, last_verification_at, last_failed_verification_at)
           VALUES ($1, 1, 1, $2, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             total_verifications = captcha_stats.total_verifications + 1,
             failed_verifications = captcha_stats.failed_verifications + 1,
             last_verification_at = NOW(),
             last_failed_verification_at = NOW(),
             updated_at = NOW()`,
          [session.user_id, responseTime]
        );

        // 降低可信度
        const config = await getCaptchaConfig();
        await db.query(
          `UPDATE users SET trust_score = GREATEST(0, trust_score - $1) WHERE id = $2`,
          [config.trust_score_penalty, session.user_id]
        );

        // 检查是否需要冻结账号
        if (status === 'failed') {
          const recentFailures = await db.query(
            `SELECT COUNT(*) FROM captcha_sessions 
             WHERE user_id = $1 AND status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'`,
            [session.user_id]
          );

          if (parseInt(recentFailures.rows[0].count) >= 3) {
            // 冻结账号
            await db.query(
              `UPDATE users SET status = 'frozen', frozen_until = NOW() + INTERVAL '24 hours', frozen_reason = 'captcha_failures' WHERE id = $1`,
              [session.user_id]
            );

            // 更新触发日志
            await db.query(
              `UPDATE captcha_trigger_logs 
               SET resolved_at = NOW(), resolution = 'failed' 
               WHERE session_id = $1`,
              [sessionId]
            );

            return res.json({
              valid: false,
              error: 'account_frozen',
              message: 'Account temporarily frozen due to multiple verification failures',
              contactSupport: true
            });
          }
        }

        const remainingAttempts = session.max_attempts - session.attempt_count - 1;

        res.json({
          valid: false,
          error: validation.errors[0] || 'incorrect_answer',
          remainingAttempts,
          warnings: validation.warnings,
          message: remainingAttempts > 0 
            ? `Incorrect answer. ${remainingAttempts} attempts remaining.`
            : 'Maximum attempts exceeded'
        });
      }

    } catch (error) {
      console.error('CAPTCHA verify error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/captcha/challenge/:sessionId
 * 获取新挑战（失败后重新获取）
 */
router.get('/challenge/:sessionId',
  [param('sessionId').isUUID()],
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      // 获取会话
      const sessionResult = await db.query(
        `SELECT * FROM captcha_sessions WHERE id = $1`,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = sessionResult.rows[0];

      // 生成新挑战（保持相同难度）
      const challenge = challengeGenerator.generate(session.difficulty);

      // 更新会话
      await db.query(
        `UPDATE captcha_sessions 
         SET session_type = $1, challenge_data = $2, expected_answer = $3, 
             expires_at = $4, attempt_count = 0
         WHERE id = $5`,
        [
          challenge.type,
          JSON.stringify(challenge),
          JSON.stringify({ answerHash: challenge.answerHash, correctOptionIndex: challenge.correctOptionIndex }),
          challenge.expiresAt,
          sessionId
        ]
      );

      res.json({
        sessionId,
        type: challenge.type,
        difficulty: challenge.difficulty,
        gridSize: challenge.gridSize,
        pieces: challenge.pieces,
        grid: challenge.grid,
        targetChars: challenge.targetChars,
        question: challenge.question,
        options: challenge.options,
        expiresAt: challenge.expiresAt
      });

    } catch (error) {
      console.error('Get challenge error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/captcha/status/:userId
 * 查询用户验证状态
 */
router.get('/status/:userId',
  [param('userId').isInt({ min: 1 })],
  async (req, res) => {
    try {
      const { userId } = req.params;

      const result = await db.query(
        `SELECT 
          cs.*,
          u.trust_score
        FROM captcha_stats cs
        JOIN users u ON u.id = cs.user_id
        WHERE cs.user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.json({
          userId,
          totalVerifications: 0,
          passedVerifications: 0,
          failedVerifications: 0,
          passRate: 0,
          currentTrustScore: null,
          lastVerification: null
        });
      }

      const stats = result.rows[0];
      const passRate = stats.total_verifications > 0 
        ? (stats.passed_verifications / stats.total_verifications * 100).toFixed(1)
        : 0;

      res.json({
        userId: stats.user_id,
        totalVerifications: stats.total_verifications,
        passedVerifications: stats.passed_verifications,
        failedVerifications: stats.failed_verifications,
        avgResponseTimeMs: stats.avg_response_time_ms,
        passRate: parseFloat(passRate),
        currentTrustScore: stats.trust_score,
        lastVerification: stats.last_verification_at,
        lastPassed: stats.last_passed_verification_at,
        lastFailed: stats.last_failed_verification_at
      });

    } catch (error) {
      console.error('Get status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 获取 CAPTCHA 配置
 */
async function getCaptchaConfig() {
  try {
    const result = await db.query(
      `SELECT key, value FROM captcha_config`
    );
    
    const config = {};
    result.rows.forEach(row => {
      let value = row.value;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          // 保持字符串
        }
      }
      config[row.key] = value;
    });
    
    return config;
  } catch (error) {
    console.error('Get captcha config error:', error);
    return {
      trust_score_recovery: 10,
      trust_score_penalty: 10
    };
  }
}

module.exports = router;
