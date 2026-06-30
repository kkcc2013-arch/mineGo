/**
 * IP 封禁管理 API 路由（管理员端）
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 */

const express = require('express');
const router = express.Router();
const { getIpBanManager, getClientIp } = require('../../middleware/ipBan');
const { logger, metrics } = require('../../../../shared/index');

// 管理员权限检查中间件
function adminOnly(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      code: 'IP_ADMIN_001',
      message: '请先登录'
    });
  }
  
  // 检查管理员权限（需要用户表中有 role 或 is_admin 字段）
  if (req.user.role !== 'admin' && !req.user.isAdmin) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      code: 'IP_ADMIN_002',
      message: '需要管理员权限'
    });
  }
  
  next();
}

// ==================== IP 黑名单管理 ====================

/**
 * POST /api/admin/ip-blacklist
 * 添加 IP 到黑名单
 */
router.post('/ip-blacklist', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ipAddress, reason, severity, expiresAt } = req.body;
    
    if (!ipAddress || !reason) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_ADMIN_003',
        message: 'IP 地址和封禁理由为必填项'
      });
    }
    
    const validSeverity = ['low', 'medium', 'high', 'critical'];
    if (!severity || !validSeverity.includes(severity)) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_ADMIN_004',
        message: 'severity 必须为 low/medium/high/critical'
      });
    }

    // 检查是否已在白名单中
    if (await ipBanManager.isWhitelisted(ipAddress)) {
      return res.status(400).json({
        error: 'IN_WHITELIST',
        code: 'IP_ADMIN_005',
        message: '该 IP 在白名单中，请先从白名单移除'
      });
    }

    await ipBanManager.addToBlacklist(
      ipAddress,
      reason,
      severity,
      expiresAt ? new Date(expiresAt) : null,
      req.user.id
    );

    metrics.increment('ip_ban_total', 1, { type: 'blacklist', method: 'manual' });
    
    res.json({
      success: true,
      message: 'IP 已添加到黑名单',
      data: { ipAddress, reason, severity, expiresAt }
    });
  } catch (error) {
    logger.error('Failed to add IP to blacklist', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to add IP to blacklist' });
  }
});

/**
 * DELETE /api/admin/ip-blacklist/:ip
 * 从黑名单移除 IP
 */
router.delete('/ip-blacklist/:ip', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ip } = req.params;
    
    await ipBanManager.removeFromBlacklist(ip, req.user.id);
    
    res.json({
      success: true,
      message: 'IP 已从黑名单移除'
    });
  } catch (error) {
    logger.error('Failed to remove IP from blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to remove IP from blacklist' });
  }
});

/**
 * GET /api/admin/ip-blacklist
 * 查询黑名单列表
 */
router.get('/ip-blacklist', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { page = 1, limit = 50, severity, activeOnly } = req.query;
    
    const client = await ipBanManager.db.connect();
    
    let whereClause = 'WHERE 1=1';
    if (severity) {
      whereClause += ` AND severity = '${severity}'`;
    }
    if (activeOnly === 'true') {
      whereClause += ` AND (expires_at IS NULL OR expires_at > NOW())`;
    }
    
    const countResult = await client.query(`SELECT COUNT(*) FROM ip_blacklist ${whereClause}`);
    const total = parseInt(countResult.rows[0].count);
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await client.query(`
      SELECT b.*, u.username as blocked_by_name
      FROM ip_blacklist b
      LEFT JOIN users u ON b.blocked_by = u.id
      ${whereClause}
      ORDER BY b.blocked_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    
    client.release();
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Failed to list blacklist', { error: error.message });
    res.status(500).json({ error: 'Failed to list blacklist' });
  }
});

/**
 * GET /api/admin/ip-blacklist/stats
 * 黑名单统计
 */
router.get('/ip-blacklist/stats', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const client = await ipBanManager.db.connect();
    
    const stats = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE expires_at IS NULL OR expires_at > NOW()) as active,
        COUNT(*) FILTER (WHERE is_auto = true) as auto_banned,
        COUNT(*) FILTER (WHERE is_auto = false) as manual_banned,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
        COUNT(*) FILTER (WHERE severity = 'high') as high_count,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium_count,
        COUNT(*) FILTER (WHERE severity = 'low') as low_count
      FROM ip_blacklist
    `);
    
    const recentBans = await client.query(`
      SELECT severity, COUNT(*) as count
      FROM ip_blacklist
      WHERE blocked_at > NOW() - INTERVAL '24 hours'
      GROUP BY severity
    `);
    
    client.release();
    
    res.json({
      success: true,
      data: {
        ...stats.rows[0],
        recentBans24h: recentBans.rows
      }
    });
  } catch (error) {
    logger.error('Failed to get blacklist stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get blacklist stats' });
  }
});

// ==================== IP 白名单管理 ====================

/**
 * POST /api/admin/ip-whitelist
 * 添加 IP 到白名单
 */
router.post('/ip-whitelist', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ipAddress, description } = req.body;
    
    if (!ipAddress) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_ADMIN_006',
        message: 'IP 地址为必填项'
      });
    }

    // 如果在黑名单中，先移除
    const blockResult = await ipBanManager.isBlocked(ipAddress);
    if (blockResult.blocked) {
      await ipBanManager.removeFromBlacklist(ipAddress, req.user.id);
    }

    await ipBanManager.addToWhitelist(ipAddress, description || '', req.user.id);

    metrics.increment('ip_ban_total', 1, { type: 'whitelist' });
    
    res.json({
      success: true,
      message: 'IP 已添加到白名单'
    });
  } catch (error) {
    logger.error('Failed to add IP to whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to add IP to whitelist' });
  }
});

/**
 * DELETE /api/admin/ip-whitelist/:ip
 * 从白名单移除 IP
 */
router.delete('/ip-whitelist/:ip', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ip } = req.params;
    
    await ipBanManager.removeFromWhitelist(ip, req.user.id);
    
    res.json({
      success: true,
      message: 'IP 已从白名单移除'
    });
  } catch (error) {
    logger.error('Failed to remove IP from whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to remove IP from whitelist' });
  }
});

/**
 * GET /api/admin/ip-whitelist
 * 查询白名单列表
 */
router.get('/ip-whitelist', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { page = 1, limit = 50 } = req.query;
    
    const client = await ipBanManager.db.connect();
    
    const countResult = await client.query('SELECT COUNT(*) FROM ip_whitelist');
    const total = parseInt(countResult.rows[0].count);
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await client.query(`
      SELECT w.*, u.username as added_by_name
      FROM ip_whitelist w
      LEFT JOIN users u ON w.added_by = u.id
      ORDER BY w.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    
    client.release();
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Failed to list whitelist', { error: error.message });
    res.status(500).json({ error: 'Failed to list whitelist' });
  }
});

// ==================== IP 风险评分管理 ====================

/**
 * GET /api/admin/ip-risk/:ip
 * 查询 IP 风险评分详情
 */
router.get('/ip-risk/:ip', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ip } = req.params;
    
    const client = await ipBanManager.db.connect();
    
    const riskResult = await client.query(`
      SELECT * FROM ip_risk_scores WHERE ip_address = $1
    `, [ip]);
    
    const triggerEvents = await client.query(`
      SELECT trigger_type, COUNT(*) as count, MAX(created_at) as last_event
      FROM ip_trigger_events
      WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY trigger_type
    `, [ip]);
    
    const accessLogs = await client.query(`
      SELECT 
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE is_blocked = true) as blocked_requests,
        AVG(response_time_ms) as avg_response_time,
        MAX(created_at) as last_access
      FROM ip_access_logs
      WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [ip]);
    
    client.release();
    
    res.json({
      success: true,
      data: {
        riskScore: riskResult.rows[0] || null,
        triggerEvents24h: triggerEvents.rows,
        accessStats24h: accessLogs.rows[0]
      }
    });
  } catch (error) {
    logger.error('Failed to get IP risk info', { error: error.message });
    res.status(500).json({ error: 'Failed to get IP risk info' });
  }
});

/**
 * POST /api/admin/ip-risk/:ip/reset
 * 重置 IP 风险评分
 */
router.post('/ip-risk/:ip/reset', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { ip } = req.params;
    
    await ipBanManager.resetRiskScore(ip);
    
    res.json({
      success: true,
      message: 'IP 风险评分已重置'
    });
  } catch (error) {
    logger.error('Failed to reset IP risk score', { error: error.message });
    res.status(500).json({ error: 'Failed to reset IP risk score' });
  }
});

// ==================== 申诉审核管理 ====================

/**
 * GET /api/admin/ip-appeals
 * 查询申诉列表
 */
router.get('/ip-appeals', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { page = 1, limit = 50, status } = req.query;
    
    const client = await ipBanManager.db.connect();
    
    let whereClause = 'WHERE 1=1';
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      whereClause += ` AND a.status = '${status}'`;
    }
    
    const countResult = await client.query(`
      SELECT COUNT(*) FROM ip_ban_appeals a ${whereClause}
    `);
    const total = parseInt(countResult.rows[0].count);
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await client.query(`
      SELECT a.*, 
        u.username as user_name,
        r.username as reviewer_name
      FROM ip_ban_appeals a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN users r ON a.reviewed_by = r.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    
    client.release();
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Failed to list appeals', { error: error.message });
    res.status(500).json({ error: 'Failed to list appeals' });
  }
});

/**
 * POST /api/admin/ip-appeals/:id/approve
 * 批准申诉并解封 IP
 */
router.post('/ip-appeals/:id/approve', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { id } = req.params;
    const { reviewNote } = req.body;
    
    await ipBanManager.approveAppeal(parseInt(id), req.user.id, reviewNote || '');
    
    metrics.increment('ip_ban_appeal_total', 1, { status: 'approved' });
    
    res.json({
      success: true,
      message: '申诉已批准，IP 已解封'
    });
  } catch (error) {
    logger.error('Failed to approve appeal', { error: error.message });
    res.status(500).json({ error: 'Failed to approve appeal' });
  }
});

/**
 * POST /api/admin/ip-appeals/:id/reject
 * 拒绝申诉
 */
router.post('/ip-appeals/:id/reject', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { id } = req.params;
    const { reviewNote } = req.body;
    
    await ipBanManager.rejectAppeal(parseInt(id), req.user.id, reviewNote || '');
    
    metrics.increment('ip_ban_appeal_total', 1, { status: 'rejected' });
    
    res.json({
      success: true,
      message: '申诉已拒绝'
    });
  } catch (error) {
    logger.error('Failed to reject appeal', { error: error.message });
    res.status(500).json({ error: 'Failed to reject appeal' });
  }
});

// ==================== 地理位置封禁管理 ====================

/**
 * POST /api/admin/geo-ban
 * 添加地理位置封禁
 */
router.post('/geo-ban', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { countryCode, reason } = req.body;
    
    if (!countryCode || countryCode.length !== 2) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_ADMIN_007',
        message: 'countryCode 必须为 2 位国家代码'
      });
    }
    
    if (!reason) {
      return res.status(400).json({
        error: 'INVALID_PARAMS',
        code: 'IP_ADMIN_008',
        message: '封禁理由为必填项'
      });
    }

    await ipBanManager.addGeoBan(countryCode, reason, req.user.id);
    
    res.json({
      success: true,
      message: `国家 ${countryCode} 已添加到封禁列表`
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
router.delete('/geo-ban/:country', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const { country } = req.params;
    
    await ipBanManager.removeGeoBan(country, req.user.id);
    
    res.json({
      success: true,
      message: `国家 ${country} 已解除封禁`
    });
  } catch (error) {
    logger.error('Failed to remove geo ban', { error: error.message });
    res.status(500).json({ error: 'Failed to remove geo ban' });
  }
});

/**
 * GET /api/admin/geo-ban
 * 查询地理位置封禁列表
 */
router.get('/geo-ban', adminOnly, async (req, res) => {
  const ipBanManager = getIpBanManager();
  if (!ipBanManager) {
    return res.status(500).json({ error: 'IpBanManager not initialized' });
  }

  try {
    const client = await ipBanManager.db.connect();
    
    const result = await client.query(`
      SELECT g.*, u.username as banned_by_name
      FROM geo_ban g
      LEFT JOIN users u ON g.banned_by = u.id
      WHERE g.is_active = true
      ORDER BY g.created_at DESC
    `);
    
    client.release();
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('Failed to list geo bans', { error: error.message });
    res.status(500).json({ error: 'Failed to list geo bans' });
  }
});

module.exports = router;