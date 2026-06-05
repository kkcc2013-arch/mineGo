// backend/services/user-service/src/routes/timezone.js
// REQ-00029: 游戏事件时区本地化与多时区支持
'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');

const router = express.Router();
router.use(requireAuth);

// 常用时区列表（用于验证和前端展示）
const COMMON_TIMEZONES = [
  { id: 'UTC', label: 'UTC (协调世界时)', offset: '+00:00' },
  { id: 'Asia/Shanghai', label: '中国标准时间 (北京)', offset: '+08:00' },
  { id: 'Asia/Tokyo', label: '日本标准时间', offset: '+09:00' },
  { id: 'Asia/Seoul', label: '韩国标准时间', offset: '+09:00' },
  { id: 'Asia/Hong_Kong', label: '香港时间', offset: '+08:00' },
  { id: 'Asia/Taipei', label: '台北时间', offset: '+08:00' },
  { id: 'Asia/Singapore', label: '新加坡时间', offset: '+08:00' },
  { id: 'America/New_York', label: '美国东部时间', offset: '-05:00' },
  { id: 'America/Chicago', label: '美国中部时间', offset: '-06:00' },
  { id: 'America/Denver', label: '美国山地时间', offset: '-07:00' },
  { id: 'America/Los_Angeles', label: '美国太平洋时间', offset: '-08:00' },
  { id: 'Europe/London', label: '英国时间', offset: '+00:00' },
  { id: 'Europe/Paris', label: '中欧时间', offset: '+01:00' },
  { id: 'Europe/Berlin', label: '德国时间', offset: '+01:00' },
  { id: 'Europe/Moscow', label: '莫斯科时间', offset: '+03:00' },
  { id: 'Australia/Sydney', label: '悉尼时间', offset: '+11:00' },
  { id: 'Pacific/Auckland', label: '新西兰时间', offset: '+13:00' }
];

// 验证时区是否有效
async function isValidTimezone(tz) {
  try {
    const { rows } = await query(
      'SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1',
      [tz]
    );
    return rows.length > 0 || tz === 'UTC';
  } catch (err) {
    console.error('Timezone validation error:', err);
    return tz === 'UTC'; // UTC 总是有效
  }
}

// 获取时区当前偏移量（考虑夏令时）
function getTimezoneOffset(tz) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset'
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(p => p.type === 'timeZoneName');
    return offsetPart ? offsetPart.value : '+00:00';
  } catch (err) {
    return '+00:00';
  }
}

// GET /users/me/timezone - 获取用户时区设置
router.get('/me/timezone', async (req, res, next) => {
  try {
    const { rows: [user] } = await query(
      'SELECT timezone, timezone_updated_at FROM users WHERE id = $1',
      [req.user.sub]
    );

    if (!user) {
      throw new AppError(2003, '用户不存在', 404);
    }

    const timezone = user.timezone || 'UTC';
    const offset = getTimezoneOffset(timezone);
    
    // 计算本地时间
    const localTime = new Date().toLocaleString('en-US', { 
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    res.json(successResp({
      timezone,
      offset,
      localTime,
      updatedAt: user.timezone_updated_at,
      commonTimezones: COMMON_TIMEZONES
    }));
  } catch (err) {
    next(err);
  }
});

// PUT /users/me/timezone - 更新用户时区设置
router.put('/me/timezone', async (req, res, next) => {
  try {
    const schema = z.object({
      timezone: z.string().min(1).max(100)
    });
    
    const { timezone } = schema.parse(req.body);

    // 验证时区是否有效
    const valid = await isValidTimezone(timezone);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TIMEZONE',
          message: `无效的时区: ${timezone}`,
          hint: '请使用 IANA 时区标识符，如 Asia/Shanghai, America/New_York'
        }
      });
    }

    // 更新用户时区
    await query(
      'UPDATE users SET timezone = $1, timezone_updated_at = NOW() WHERE id = $2',
      [timezone, req.user.sub]
    );

    const offset = getTimezoneOffset(timezone);
    const localTime = new Date().toLocaleString('en-US', { 
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    res.json(successResp({
      timezone,
      offset,
      localTime
    }, '时区设置已更新'));
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数验证失败',
          details: err.errors
        }
      });
    }
    next(err);
  }
});

// GET /users/timezones - 获取可用时区列表
router.get('/timezones', async (req, res, next) => {
  try {
    // 返回常用时区列表
    // 如果需要完整列表，可以从数据库查询 pg_timezone_names
    const { rows } = await query(`
      SELECT name, utc_offset 
      FROM pg_timezone_names 
      WHERE name NOT LIKE 'posix/%' 
        AND name NOT LIKE 'SystemV/%'
      ORDER BY utc_offset, name
      LIMIT 200
    `);

    res.json(successResp({
      common: COMMON_TIMEZONES,
      all: rows.map(r => ({
        id: r.name,
        offset: formatOffset(r.utc_offset)
      }))
    }));
  } catch (err) {
    // 如果查询失败，至少返回常用时区
    res.json(successResp({
      common: COMMON_TIMEZONES,
      all: COMMON_TIMEZONES
    }));
  }
});

// 辅助函数：格式化 UTC 偏移量
function formatOffset(seconds) {
  const hours = Math.floor(Math.abs(seconds) / 3600);
  const mins = Math.floor((Math.abs(seconds) % 3600) / 60);
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

module.exports = router;
module.exports.COMMON_TIMEZONES = COMMON_TIMEZONES;
