// frontend/game-client/src/utils/timezone.js
// REQ-00029: 游戏事件时区本地化与多时区支持
// 前端时区工具函数

'use strict';

const STORAGE_KEY = 'pmg_timezone';

/**
 * 检测用户时区
 * 优先级：localStorage > 浏览器检测 > UTC
 */
export function detectUserTimezone() {
  // 1. 优先使用用户设置
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return saved;

  // 2. 自动检测
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) {
      localStorage.setItem(STORAGE_KEY, detected);
      return detected;
    }
  } catch (err) {
    console.warn('Failed to detect timezone:', err);
  }

  // 3. 默认 UTC
  return 'UTC';
}

/**
 * 设置用户时区
 */
export function setTimezone(timezone) {
  localStorage.setItem(STORAGE_KEY, timezone);
  
  // 触发全局事件，通知其他组件更新
  window.dispatchEvent(new CustomEvent('timezoneChanged', {
    detail: { timezone }
  }));
}

/**
 * 获取当前时区
 */
export function getCurrentTimezone() {
  return localStorage.getItem(STORAGE_KEY) || detectUserTimezone();
}

/**
 * 格式化时间为本地时区
 * @param {string|Date} isoString - ISO 8601 时间字符串或 Date 对象
 * @param {Object} options - Intl.DateTimeFormat 选项
 */
export function formatTime(isoString, options = {}) {
  if (!isoString) return '';
  
  const timezone = getCurrentTimezone();
  const date = new Date(isoString);

  const defaultOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options
  };

  try {
    return new Intl.DateTimeFormat(navigator.language, defaultOptions).format(date);
  } catch (err) {
    console.error('formatTime error:', err);
    return date.toLocaleString();
  }
}

/**
 * 格式化时间为短格式（仅时间）
 */
export function formatTimeShort(isoString) {
  return formatTime(isoString, {
    year: undefined,
    month: undefined,
    day: undefined,
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * 格式化时间为日期格式
 */
export function formatDate(isoString) {
  return formatTime(isoString, {
    hour: undefined,
    minute: undefined
  });
}

/**
 * 格式化相对时间
 * @param {string|Date} isoString - 目标时间
 * @returns {string} 如 "2小时后"、"3天前"
 */
export function formatRelative(isoString) {
  if (!isoString) return '';
  
  const now = Date.now();
  const target = new Date(isoString).getTime();
  const diff = target - now;

  try {
    const rtf = new Intl.RelativeTimeFormat(navigator.language, {
      numeric: 'auto'
    });

    const absDiff = Math.abs(diff);

    // 根据时间差选择合适的单位
    if (absDiff < 60000) { // < 1 分钟
      const seconds = Math.round(diff / 1000);
      return rtf.format(seconds, 'second');
    } else if (absDiff < 3600000) { // < 1 小时
      const minutes = Math.round(diff / 60000);
      return rtf.format(minutes, 'minute');
    } else if (absDiff < 86400000) { // < 1 天
      const hours = Math.round(diff / 3600000);
      return rtf.format(hours, 'hour');
    } else if (absDiff < 604800000) { // < 1 周
      const days = Math.round(diff / 86400000);
      return rtf.format(days, 'day');
    } else if (absDiff < 2592000000) { // < 30 天
      const weeks = Math.round(diff / 604800000);
      return rtf.format(weeks, 'week');
    } else { // >= 30 天
      const months = Math.round(diff / 2592000000);
      return rtf.format(months, 'month');
    }
  } catch (err) {
    // 降级到简单显示
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return `${Math.round(diff / 1000)}秒`;
    if (absDiff < 3600000) return `${Math.round(diff / 60000)}分钟`;
    if (absDiff < 86400000) return `${Math.round(diff / 3600000)}小时`;
    return `${Math.round(diff / 86400000)}天`;
  }
}

/**
 * 格式化倒计时（剩余时间）
 * @param {string|Date} endsAt - 结束时间
 * @returns {string} 如 "02:30:45" 或 "已结束"
 */
export function formatCountdown(endsAt) {
  if (!endsAt) return '';
  
  const now = Date.now();
  const end = new Date(endsAt).getTime();
  const diff = end - now;

  if (diff <= 0) return '已结束';

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}天 ${hours % 24}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 获取时区偏移量
 * @param {string} timezone - IANA 时区标识符
 * @returns {string} 如 "+08:00"
 */
export function getTimezoneOffset(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset'
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(p => p.type === 'timeZoneName');
    return offsetPart ? offsetPart.value : '+00:00';
  } catch (err) {
    return '+00:00';
  }
}

/**
 * 获取时区当前时间
 */
export function getCurrentLocalTime(timezone) {
  const tz = timezone || getCurrentTimezone();
  return new Date().toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/**
 * 检查时间是否在范围内
 */
export function isTimeInRange(startTime, endTime) {
  const now = Date.now();
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  return now >= start && now <= end;
}

/**
 * 格式化持续时间（如 Raid 剩余时间）
 */
export function formatDuration(minutes) {
  if (minutes < 60) {
    return `${minutes}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
}

export default {
  detectUserTimezone,
  setTimezone,
  getCurrentTimezone,
  formatTime,
  formatTimeShort,
  formatDate,
  formatRelative,
  formatCountdown,
  getTimezoneOffset,
  getCurrentLocalTime,
  isTimeInRange,
  formatDuration
};
