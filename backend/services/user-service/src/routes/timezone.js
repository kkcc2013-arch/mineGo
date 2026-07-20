/**
 * 用户时区偏好管理 - REQ-00612
 * 路由：获取/更新用户时区偏好
 */

'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../../shared/logger');
const db = require('../../../shared/db');
const { TimezoneUtils } = require('../../gateway/src/middleware/timezone');

const logger = createLogger('user-timezone');

/**
 * 获取用户时区偏好
 * GET /users/:userId/timezone
 */
router.get('/:userId/timezone', async (req, res) => {
  try {
    const { userId } = req.params;

    // 查询用户时区偏好
    const result = await db.query(
      `SELECT timezone, auto_detect, updated_at 
       FROM user_timezone_preferences 
       WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // 返回默认值
      return res.json({
        userId,
        timezone: 'UTC',
        autoDetect: true,
        updatedAt: null
      });
    }

    const row = result.rows[0];
    res.json({
      userId,
      timezone: row.timezone,
      autoDetect: row.auto_detect,
      updatedAt: row.updated_at
    });
  } catch (err) {
    logger.error({ userId: req.params.userId, error: err.message }, 'Failed to get timezone');
    res.status(500).json({ error: 'Failed to get timezone preference' });
  }
});

/**
 * 更新用户时区偏好
 * PUT /users/:userId/timezone
 */
router.put('/:userId/timezone', async (req, res) => {
  try {
    const { userId } = req.params;
    const { timezone, autoDetect } = req.body;

    // 验证时区
    if (!TimezoneUtils.isValidTimezone(timezone)) {
      return res.status(400).json({ 
        error: 'Invalid timezone',
        supportedTimezones: TimezoneUtils.getSupportedTimezones()
      });
    }

    // 更新或插入
    const result = await db.query(
      `INSERT INTO user_timezone_preferences (user_id, timezone, auto_detect, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET 
         timezone = EXCLUDED.timezone,
         auto_detect = EXCLUDED.auto_detect,
         updated_at = NOW()
       RETURNING *`,
      [userId, timezone, autoDetect || false]
    );

    const row = result.rows[0];
    logger.info({ userId, timezone, autoDetect }, 'Timezone preference updated');

    res.json({
      userId: row.user_id,
      timezone: row.timezone,
      autoDetect: row.auto_detect,
      updatedAt: row.updated_at
    });
  } catch (err) {
    logger.error({ userId: req.params.userId, error: err.message }, 'Failed to update timezone');
    res.status(500).json({ error: 'Failed to update timezone preference' });
  }
});

/**
 * 自动检测时区（基于 IP）
 * POST /users/:userId/timezone/auto-detect
 */
router.post('/:userId/timezone/auto-detect', async (req, res) => {
  try {
    const { userId } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // 这里可以集成 GeoIP 服务（如 MaxMind）
    // 简化实现：根据 IP 段推断时区
    const detectedTimezone = detectTimezoneByIP(ip);

    // 更新用户时区
    const result = await db.query(
      `INSERT INTO user_timezone_preferences (user_id, timezone, auto_detect, updated_at)
       VALUES ($1, $2, true, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET 
         timezone = EXCLUDED.timezone,
         auto_detect = true,
         updated_at = NOW()
       RETURNING *`,
      [userId, detectedTimezone]
    );

    const row = result.rows[0];
    logger.info({ userId, ip, detectedTimezone }, 'Timezone auto-detected');

    res.json({
      userId: row.user_id,
      timezone: row.timezone,
      autoDetect: true,
      detectedFromIP: ip,
      updatedAt: row.updated_at
    });
  } catch (err) {
    logger.error({ userId: req.params.userId, error: err.message }, 'Failed to auto-detect timezone');
    res.status(500).json({ error: 'Failed to auto-detect timezone' });
  }
});

/**
 * 根据IP推断时区（简化版）
 */
function detectTimezoneByIP(ip) {
  // 实际生产环境应使用 GeoIP 数据库（如 MaxMind GeoIP2）
  // 这里提供简化实现
  
  // 如果是本地 IP，返回默认时区
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return 'UTC';
  }

  // 实际应调用 GeoIP 服务
  // 示例：根据 IP 段映射到时区
  const ipTimezoneMap = {
    'China': 'Asia/Shanghai',
    'Japan': 'Asia/Tokyo',
    'US-East': 'America/New_York',
    'US-West': 'America/Los_Angeles',
    'UK': 'Europe/London',
    'France': 'Europe/Paris',
    'Australia': 'Australia/Sydney'
  };

  // 默认返回 UTC
  return 'UTC';
}

/**
 * 获取时区列表
 * GET /users/timezones
 */
router.get('/timezones', (req, res) => {
  const supportedTimezones = TimezoneUtils.getSupportedTimezones();
  
  // 获取每个时区的详细信息
  const timezoneInfo = supportedTimezones.map(tz => ({
    id: tz,
    offset: TimezoneUtils.getOffset(tz),
    isDST: TimezoneUtils.isDST(tz),
    label: getTimezoneLabel(tz)
  }));

  res.json({
    timezones: timezoneInfo,
    total: timezoneInfo.length
  });
});

/**
 * 获取时区显示标签
 */
function getTimezoneLabel(timezone) {
  const labels = {
    'UTC': 'UTC (Coordinated Universal Time)',
    'Asia/Shanghai': '中国标准时间 (CST)',
    'Asia/Tokyo': '日本标准时间 (JST)',
    'America/New_York': '美国东部时间 (EST/EDT)',
    'America/Los_Angeles': '美国太平洋时间 (PST/PDT)',
    'Europe/London': '英国时间 (GMT/BST)',
    'Europe/Paris': '欧洲中部时间 (CET/CEST)',
    'Australia/Sydney': '澳大利亚东部时间 (AEST/AEDT)'
  };

  return labels[timezone] || timezone;
}

module.exports = router;
