/**
 * IP 封禁管理 API 路由
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 * 管理端 API（需要管理员权限）
 */

const express = require('express');
const router = express.Router();
const { getIpBanManager, getClientIp } = require('../middleware/ipBan');
const { logger } = require('../../../shared/index');

/**
 * 检查管理员权限中间件
 */
function adminAuthMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'FORBIDDEN',
      code: 'IP_BAN_ADMIN_001',
      message: '需要管理员权限'
    });
  }
  next();
}

// 所有路由需要管理员权限
router.use(adminAuthMiddleware);

/**
 * GET /api/admin/ip-blacklist
 * 获取黑名单列表
 */
router.get('/ip-blacklist', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { page = 1, limit = 50, severity, active } = req.query;
    const offset = (page - 1) * limit;
    
    const client = await ipBanManager.db.connect();
    
    let query = `
      SELECT b.*, u.username as blocked_by_name
      FROM ip_blacklist b
      LEFT JOIN users u ON b.blocked_by = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (severity) {
      query += ` AND b.severity = $${paramIndex++}`;
      params.push(severity);
    }
    
    if (active === 'true') {
      query += ` AND (b.expires_at IS NULL OR b.expires_at > NOW())`;
    } else if (active === 'false') {
      query += ` AND b.expires_at < NOW()`;
    }
    
    query += ` ORDER BY b.blocked_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);
    
    const result = await client.query(query, params);
    
    // 获取总数
    const countResult = await client.query('SELECT COUNT(*) FROM ip_blacklist');
    
    client.release();
    
    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count)
      }
    });
  } catch (error) {
    logger.error('Failed to get blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to get blacklist' });
  }
});

/**
 * POST /api/admin/ip-blacklist
 * 添加 IP 到黑名单
 */
router.post('/ip-blacklist', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ipAddress, reason, severity = 'medium', expiresAt } = req.body;
    
    if (!ipAddress || !reason) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_BAN_ADMIN_002',
        message: 'ipAddress 和 reason 必填'
      });
    }
    
    const result = await ipBanManager.addToBlacklist(
      ipAddress,
      reason,
      severity,
      expiresAt ? new Date(expiresAt) : null,
      req.user.id
    );
    
    res.json({
      success: true,
      message: 'IP 已添加到黑名单',
      data: result
    });
  } catch (error) {
    logger.error('Failed to add to blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to add to blacklist' });
  }
});

/**
 * DELETE /api/admin/ip-blacklist/:ip
 * 从黑名单移除
 */
router.delete('/ip-blacklist/:ip', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const ipAddress = req.params.ip;
    
    const result = await ipBanManager.removeFromBlacklist(ipAddress);
    
    res.json({
      success: true,
      message: 'IP 已从黑名单移除',
      data: result
    });
  } catch (error) {
    logger.error('Failed to remove from blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to remove from blacklist' });
  }
});

/**
 * GET /api/admin/ip-blacklist/stats
 * 黑名单统计
 */
router.get('/ip-blacklist/stats', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const stats = await ipBanManager.getStats();
    
    res.json({ data: stats });
  } catch (error) {
    logger.error('Failed to get stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * POST /api/admin/ip-blacklist/batch
 * 批量添加 IP 到黑名单
 */
router.post('/ip-blacklist/batch', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ipList, reason, severity = 'medium', expiresAt } = req.body;
    
    if (!ipList || !Array.isArray(ipList) || ipList.length === 0) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        message: 'ipList 必须是非空数组'
      });
    }
    
    const results = [];
    const errors = [];
    
    for (const ip of ipList) {
      try {
        const result = await ipBanManager.addToBlacklist(
          ip,
          reason,
          severity,
          expiresAt ? new Date(expiresAt) : null,
          req.user.id
        );
        results.push(result);
      } catch (error) {
        errors.push({ ip, error: error.message });
      }
    }
    
    res.json({
      success: true,
      message: `成功添加 ${results.length} 个 IP`,
      added: results.length,
      failed: errors.length,
      errors
    });
  } catch (error) {
    logger.error('Failed to batch add to blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to batch add to blacklist' });
  }
});

/**
 * GET /api/admin/ip-whitelist
 * 获取白名单列表
 */
router.get('/ip-whitelist', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const client = await ipBanManager.db.connect();
    
    const result = await client.query(`
      SELECT w.*, u.username as added_by_name
      FROM ip_whitelist w
      LEFT JOIN users u ON w.added_by = u.id
      ORDER BY w.created_at DESC
    `);
    
    client.release();
    
    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Failed to get whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to get whitelist' });
  }
});

/**
 * POST /api/admin/ip-whitelist
 * 添加 IP 到白名单
 */
router.post('/ip-whitelist', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ipAddress, description } = req.body;
    
    if (!ipAddress) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        message: 'ipAddress 必填'
      });
    }
    
    const result = await ipBanManager.addToWhitelist(ipAddress, description || '', req.user.id);
    
    res.json({
      success: true,
      message: 'IP 已添加到白名单',
      data: result
    });
  } catch (error) {
    logger.error('Failed to add to whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to add to whitelist' });
  }
});

/**
 * DELETE /api/admin/ip-whitelist/:ip
 * 从白名单移除
 */
router.delete('/ip-whitelist/:ip', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const ipAddress = req.params.ip;
    
    const result = await ipBanManager.removeFromWhitelist(ipAddress);
    
    res.json({
      success: true,
      message: 'IP 已从白名单移除',
      data: result
    });
  } catch (error) {
    logger.error('Failed to remove from whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to remove from whitelist' });
  }
});

/**
 * GET /api/admin/ip-risk/:ip
 * 查询 IP 风险评分
 */
router.get('/ip-risk/:ip', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const ipAddress = req.params.ip;
    
    const client = await ipBanManager.db.connect();
    
    const result = await client.query(
      'SELECT * FROM ip_risk_scores WHERE ip_address = $1',
      [ipAddress]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        ipAddress,
        riskScore: 0,
        message: 'IP 无风险记录'
      });
    }
    
    client.release();
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Failed to get risk score', { error: error.message });
    res.status(500).json({ error: 'Failed to get risk score' });
  }
});

/**
 * POST /api/admin/ip-risk/:ip/update
 * 手动更新风险评分
 */
router.post('/ip-risk/:ip/update', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const ipAddress = req.params.ip;
    const { delta, reason } = req.body;
    
    if (!delta) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        message: 'delta 必填'
      });
    }
    
    const newScore = await ipBanManager.updateRiskScore(ipAddress, parseInt(delta), reason);
    
    res.json({
      success: true,
      ipAddress,
      riskScore: newScore,
      message: `风险评分已更新为 ${newScore}`
    });
  } catch (error) {
    logger.error('Failed to update risk score', { error: error.message });
    res.status(500).json({ error: 'Failed to update risk score' });
  }
});

/**
 * GET /api/admin/ip-appeals
 * 查询申诉列表
 */
router.get('/ip-appeals', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { status = 'pending', page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    
    const client = await ipBanManager.db.connect();
    
    const result = await client.query(`
      SELECT a.*, u.username as user_name, r.username as reviewer_name
      FROM ip_ban_appeals a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN users r ON a.reviewed_by = r.id
      WHERE a.status = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);
    
    const countResult = await client.query(
      'SELECT COUNT(*) FROM ip_ban_appeals WHERE status = $1',
      [status]
    );
    
    client.release();
    
    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count)
      }
    });
  } catch (error) {
    logger.error('Failed to get appeals', { error: error.message });
    res.status(500).json({ error: 'Failed to get appeals' });
  }
});

/**
 * POST /api/admin/ip-appeals/:id/approve
 * 批准申诉
 */
router.post('/ip-appeals/:id/approve', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const appealId = parseInt(req.params.id);
    const { reviewNote } = req.body;
    
    const result = await ipBanManager.processAppeal(appealId, true, req.user.id, reviewNote || '');
    
    res.json({
      success: true,
      message: '申诉已批准，IP 已解封',
      data: result
    });
  } catch (error) {
    logger.error('Failed to approve appeal', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/ip-appeals/:id/reject
 * 拒绝申诉
 */
router.post('/ip-appeals/:id/reject', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const appealId = parseInt(req.params.id);
    const { reviewNote } = req.body;
    
    const result = await ipBanManager.processAppeal(appealId, false, req.user.id, reviewNote || '');
    
    res.json({
      success: true,
      message: '申诉已拒绝',
      data: result
    });
  } catch (error) {
    logger.error('Failed to reject appeal', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/geo-ban
 * 按地理位置封禁
 */
router.post('/geo-ban', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { countryCode, reason } = req.body;
    
    if (!countryCode) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        message: 'countryCode 必填'
      });
    }
    
    const client = await ipBanManager.db.connect();
    
    await client.query(`
      INSERT INTO geo_bans (country_code, reason, banned_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (country_code)
      DO UPDATE SET reason = $2, is_active = true
    `, [countryCode, reason || '', req.user.id]);
    
    client.release();
    
    res.json({
      success: true,
      message: `国家 ${countryCode} 已封禁`,
      countryCode
    });
  } catch (error) {
    logger.error('Failed to add geo ban', { error: error.message });
    res.status(500).json({ error: 'Failed to add geo ban' });
  }
});

/**
 * DELETE /api/admin/geo-ban/:country
 * 解除地理位置封禁
 */
router.delete('/geo-ban/:country', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const countryCode = req.params.country;
    
    const client = await ipBanManager.db.connect();
    
    await client.query(
      'UPDATE geo_bans SET is_active = false WHERE country_code = $1',
      [countryCode]
    );
    
    client.release();
    
    res.json({
      success: true,
      message: `国家 ${countryCode} 封禁已解除`,
      countryCode
    });
  } catch (error) {
    logger.error('Failed to remove geo ban', { error: error.message });
    res.status(500).json({ error: 'Failed to remove geo ban' });
  }
});

/**
 * GET /api/admin/geo-ban
 * 获取地理位置封禁列表
 */
router.get('/geo-ban', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const client = await ipBanManager.db.connect();
    
    const result = await client.query(`
      SELECT g.*, u.username as banned_by_name
      FROM geo_bans g
      LEFT JOIN users u ON g.banned_by = u.id
      WHERE g.is_active = true
      ORDER BY g.banned_at DESC
    `);
    
    client.release();
    
    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Failed to get geo bans', { error: error.message });
    res.status(500).json({ error: 'Failed to get geo bans' });
  }
});

/**
 * POST /api/admin/ip-blacklist/cleanup
 * 清理过期封禁
 */
router.post('/ip-blacklist/cleanup', async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const count = await ipBanManager.cleanupExpired();
    
    res.json({
      success: true,
      message: `已清理 ${count} 个过期封禁`,
      cleanedCount: count
    });
  } catch (error) {
    logger.error('Failed to cleanup expired bans', { error: error.message });
    res.status(500).json({ error: 'Failed to cleanup expired bans' });
  }
});

module.exports = router;