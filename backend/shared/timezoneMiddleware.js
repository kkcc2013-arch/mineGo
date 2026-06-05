// backend/shared/timezoneMiddleware.js
// REQ-00029: 游戏事件时区本地化与多时区支持
// 时区中间件：从请求头或用户偏好获取时区

'use strict';

const { query } = require('./db');

/**
 * 时区中间件
 * 从以下来源获取时区（按优先级）：
 * 1. 用户数据库偏好设置
 * 2. 请求头 X-Timezone
 * 3. 默认 UTC
 */
async function timezoneMiddleware(req, res, next) {
  try {
    let timezone = 'UTC';

    // 1. 从用户数据库偏好获取（如果已认证）
    if (req.user && req.user.sub) {
      try {
        const { rows: [user] } = await query(
          'SELECT timezone FROM users WHERE id = $1',
          [req.user.sub]
        );
        if (user && user.timezone) {
          timezone = user.timezone;
        }
      } catch (err) {
        console.error('Failed to fetch user timezone:', err);
      }
    }

    // 2. 从请求头获取（优先级更高，允许临时覆盖）
    const headerTimezone = req.headers['x-timezone'];
    if (headerTimezone) {
      // 基本验证
      if (/^[A-Za-z_\/]+$/.test(headerTimezone)) {
        timezone = headerTimezone;
      }
    }

    // 3. 设置到 req 和 res.locals
    req.timezone = timezone;
    res.locals.timezone = timezone;

    // 4. 添加到响应头，方便前端调试
    res.setHeader('X-Server-Timezone', 'UTC');
    res.setHeader('X-User-Timezone', timezone);

    next();
  } catch (err) {
    // 出错时使用默认 UTC
    req.timezone = 'UTC';
    res.locals.timezone = 'UTC';
    next();
  }
}

/**
 * 时间格式化辅助函数
 * 将 UTC 时间转换为指定时区的本地时间
 */
function formatTimeForTimezone(utcTime, timezone, options = {}) {
  if (!utcTime) return null;

  const date = new Date(utcTime);
  const defaultOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...options
  };

  try {
    return new Intl.DateTimeFormat('en-US', defaultOptions).format(date);
  } catch (err) {
    return date.toISOString();
  }
}

/**
 * API 响应时间字段格式化
 * 返回 UTC ISO 字符串 + Unix 时间戳
 */
function formatTimeForAPI(date, fieldName = 'time') {
  if (!date) return null;

  const isoString = new Date(date).toISOString();
  const unixTimestamp = Math.floor(new Date(date).getTime() / 1000);

  return {
    [fieldName]: isoString,
    [`${fieldName}Unix`]: unixTimestamp
  };
}

/**
 * 获取时区偏移量（小时）
 */
function getTimezoneOffsetHours(timezone) {
  try {
    const now = new Date();
    const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    return (local - utc) / 3600000; // 毫秒转小时
  } catch (err) {
    return 0;
  }
}

module.exports = {
  timezoneMiddleware,
  formatTimeForTimezone,
  formatTimeForAPI,
  getTimezoneOffsetHours
};
