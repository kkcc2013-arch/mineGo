/**
 * IP 封禁申诉 API 路由（用户端）
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 */

const express = require('express');
const router = express.Router();
const { getIpBanManager } = require('../../../../gateway/src/middleware/ipBan');
const { logger } = require('../../../shared/index');

/**
 * POST /api/ip-appeal
 * 提交封禁申诉
 */
router.post('/', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    // 需要登录
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        code: 'IP_APPEAL_001',
        message: '请先登录'
      });
    }

    const { appealReason } = req.body;
    
    if (!appealReason || appealReason.trim().length < 10) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_APPEAL_002',
        message: '申诉理由至少需要 10 个字符'
      });
    }

    // 获取客户端 IP
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : 
                       req.ip || req.connection?.remoteAddress || '0.0.0.0';

    // 检查是否被封禁
    const blockResult = await ipBanManager.isBlocked(ipAddress);
    if (!blockResult.blocked) {
      return res.status(400).json({
        error: 'NOT_BLOCKED',
        code: 'IP_APPEAL_003',
        message: '您的 IP 未被封禁，无需申诉'
      });
    }

    // 提交申诉
    const result = await ipBanManager.submitAppeal(ipAddress, req.user.id, appealReason);

    res.json({
      success: true,
      message: '申诉已提交，我们将在 24 小时内处理',
      appealId: result.appealId
    });
  } catch (error) {
    logger.error('Failed to submit appeal', { error: error.message });
    res.status(500).json({ error: 'Failed to submit appeal' });
  }
});

/**
 * GET /api/ip-appeal/status
 * 查询申诉状态
 */
router.get('/status', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    // 需要登录
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        code: 'IP_APPEAL_004',
        message: '请先登录'
      });
    }

    // 获取客户端 IP
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : 
                       req.ip || req.connection?.remoteAddress || '0.0.0.0';

    const client = await ipBanManager.db.connect();

    // 查询该 IP 的申诉记录
    const result = await client.query(`
      SELECT a.*, r.username as reviewer_name
      FROM ip_ban_appeals a
      LEFT JOIN users r ON a.reviewed_by = r.id
      WHERE a.ip_address = $1 AND a.user_id = $2
      ORDER BY a.created_at DESC
      LIMIT 1
    `, [ipAddress, req.user.id]);

    client.release();

    if (result.rows.length === 0) {
      return res.json({
        hasAppeal: false,
        message: '暂无申诉记录'
      });
    }

    const appeal = result.rows[0];

    res.json({
      hasAppeal: true,
      appeal: {
        id: appeal.id,
        status: appeal.status,
        appealReason: appeal.appeal_reason,
        createdAt: appeal.created_at,
        reviewedAt: appeal.reviewed_at,
        reviewNote: appeal.status !== 'pending' ? appeal.review_note : null,
        reviewerName: appeal.reviewer_name
      }
    });
  } catch (error) {
    logger.error('Failed to get appeal status', { error: error.message });
    res.status(500).json({ error: 'Failed to get appeal status' });
  }
});

/**
 * GET /api/ip-appeal/check
 * 检查当前 IP 是否被封禁
 */
router.get('/check', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    // 获取客户端 IP
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : 
                       req.ip || req.connection?.remoteAddress || '0.0.0.0';

    const blockResult = await ipBanManager.isBlocked(ipAddress);
    const riskScore = await ipBanManager.getRiskScore(ipAddress);

    res.json({
      ipAddress,
      isBlocked: blockResult.blocked,
      reason: blockResult.blocked ? blockResult.reason : null,
      expires: blockResult.blocked ? blockResult.expires : null,
      riskScore,
      isWhitelisted: await ipBanManager.isWhitelisted(ipAddress)
    });
  } catch (error) {
    logger.error('Failed to check IP status', { error: error.message });
    res.status(500).json({ error: 'Failed to check IP status' });
  }
});

module.exports = router;