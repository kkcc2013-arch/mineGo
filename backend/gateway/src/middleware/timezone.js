/**
 * 时区中间件 - REQ-00612
 * 全球化业务实时时区调度与跨区协作支持系统
 * 
 * 功能：
 * - 自动检测用户请求头中的 Time-Zone 信息
 * - 将时区信息注入到请求上下文中
 * - 统一 API 返回 UTC 时间戳
 * - 支持时区配置热更新
 * 
 * 不依赖外部时区库，使用原生 JavaScript 实现
 */

'use strict';

const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('timezone-middleware');

// 支持的时区配置
const TIMEZONE_OFFSETS = {
  'UTC': 0,
  'Asia/Shanghai': 8 * 3600,      // +8 小时
  'Asia/Tokyo': 9 * 3600,         // +9 小时
  'America/New_York': -5 * 3600,  // -5 小时 (EST)
  'America/Los_Angeles': -8 * 3600, // -8 小时 (PST)
  'Europe/London': 0,             // GMT
  'Europe/Paris': 1 * 3600,       // +1 小时 (CET)
  'Australia/Sydney': 10 * 3600   // +10 小时 (AEST)
};

// 缓存时区配置，支持热更新
let timezoneConfig = {
  defaultTimezone: 'UTC',
  supportedTimezones: new Set(Object.keys(TIMEZONE_OFFSETS)),
  lastUpdate: Date.now()
};

/**
 * 更新时区配置（热更新）
 * @param {Object} config - 新配置
 */
function updateTimezoneConfig(config) {
  if (config.defaultTimezone) {
    timezoneConfig.defaultTimezone = config.defaultTimezone;
  }
  if (config.supportedTimezones && Array.isArray(config.supportedTimezones)) {
    timezoneConfig.supportedTimezones = new Set(config.supportedTimezones);
  }
  timezoneConfig.lastUpdate = Date.now();
  logger.info({ config: timezoneConfig }, 'Timezone config updated');
}

/**
 * 获取当前时区配置
 */
function getTimezoneConfig() {
  return {
    ...timezoneConfig,
    supportedTimezones: Array.from(timezoneConfig.supportedTimezones)
  };
}

/**
 * 时区中间件
 */
function timezoneMiddleware(req, res, next) {
  // 从请求头获取时区信息
  const userTimezone = req.headers['time-zone'] || 
                       req.headers['x-timezone'] ||
                       req.query.timezone ||
                       timezoneConfig.defaultTimezone;

  // 验证时区是否支持
  if (!timezoneConfig.supportedTimezones.has(userTimezone)) {
    logger.warn({ 
      timezone: userTimezone, 
      supported: Array.from(timezoneConfig.supportedTimezones) 
    }, 'Unsupported timezone, using default');
    req.userTimezone = timezoneConfig.defaultTimezone;
  } else {
    req.userTimezone = userTimezone;
  }

  // 获取时区偏移（秒）
  req.timezoneOffset = TIMEZONE_OFFSETS[req.userTimezone] || 0;

  // 添加时区信息到响应头
  res.setHeader('X-Timezone', req.userTimezone);
  res.setHeader('X-Timezone-Offset', req.timezoneOffset);

  // 记录时区信息
  logger.debug({ 
    userTimezone: req.userTimezone, 
    offset: req.timezoneOffset,
    path: req.path 
  }, 'Timezone context set');

  next();
}

/**
 * UTC 时间响应转换器
 * 确保所有时间字段都以 UTC ISO 格式返回
 */
function utcResponseMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function(data) {
    if (data && typeof data === 'object') {
      // 递归转换所有时间字段为 UTC
      data = convertToUTC(data);
    }

    return originalJson(data);
  };

  next();
}

/**
 * 递归转换为 UTC
 */
function convertToUTC(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => convertToUTC(item));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // 识别时间字段
    if (isTimeField(key, value)) {
      result[key] = toUTCString(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = convertToUTC(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 判断是否为时间字段
 */
function isTimeField(key, value) {
  const timeFieldPatterns = [
    /time$/i,
    /date$/i,
    /_at$/i,
    /timestamp$/i,
    /^created/i,
    /^updated/i,
    /^start/i,
    /^end/i,
    /^expire/i
  ];

  if (value instanceof Date) return true;
  if (typeof value === 'number' && value > 1000000000000 && value < 9999999999999) {
    // 可能是毫秒时间戳
    return true;
  }
  if (typeof value === 'string') {
    // ISO 时间格式
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return true;
    }
  }

  return timeFieldPatterns.some(pattern => pattern.test(key));
}

/**
 * 转换为 UTC 时间字符串
 */
function toUTCString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  
  if (typeof value === 'number') {
    // 毫秒时间戳转 ISO
    return new Date(value).toISOString();
  }
  
  if (typeof value === 'string') {
    try {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    } catch (err) {
      // 忽略解析错误
    }
  }
  
  return value;
}

/**
 * 时区工具函数
 */
const TimezoneUtils = {
  /**
   * 将 UTC 时间转换为指定时区的本地时间字符串
   */
  utcToLocal(utcTime, timezone) {
    const date = new Date(utcTime);
    const offset = TIMEZONE_OFFSETS[timezone] || 0;
    const localTime = new Date(date.getTime() + offset * 1000);
    return localTime.toISOString().replace('Z', '');
  },

  /**
   * 将本地时间转换为 UTC
   */
  localToUTC(localTime, timezone) {
    const offset = TIMEZONE_OFFSETS[timezone] || 0;
    const date = new Date(localTime);
    const utcTime = new Date(date.getTime() - offset * 1000);
    return utcTime.toISOString();
  },

  /**
   * 获取当前时区的偏移量（秒）
   */
  getOffset(timezone) {
    return TIMEZONE_OFFSETS[timezone] || 0;
  },

  /**
   * 判断是否在夏令时期间（简化实现，实际应根据具体时区规则）
   */
  isDST(timezone) {
    // 简化实现：美国和欧洲在夏季（4-10月）使用夏令时
    const month = new Date().getMonth();
    const isSummer = month >= 3 && month <= 9; // 4-10月（0-11）
    
    if (timezone.startsWith('America/') || timezone.startsWith('Europe/')) {
      return isSummer;
    }
    
    return false;
  },

  /**
   * 格式化时间显示（根据时区）
   */
  formatTime(time, timezone, format = 'YYYY-MM-DD HH:mm:ss') {
    const date = new Date(time);
    const offset = TIMEZONE_OFFSETS[timezone] || 0;
    const localTime = new Date(date.getTime() + offset * 1000);
    
    // 简单格式化
    const year = localTime.getUTCFullYear();
    const month = String(localTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(localTime.getUTCDate()).padStart(2, '0');
    const hour = String(localTime.getUTCHours()).padStart(2, '0');
    const minute = String(localTime.getUTCMinutes()).padStart(2, '0');
    const second = String(localTime.getUTCSeconds()).padStart(2, '0');
    
    return format
      .replace('YYYY', year)
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hour)
      .replace('mm', minute)
      .replace('ss', second);
  },

  /**
   * 获取支持的时区列表
   */
  getSupportedTimezones() {
    return Array.from(timezoneConfig.supportedTimezones);
  },

  /**
   * 验证时区是否有效
   */
  isValidTimezone(timezone) {
    return TIMEZONE_OFFSETS.hasOwnProperty(timezone);
  }
};

module.exports = {
  timezoneMiddleware,
  utcResponseMiddleware,
  updateTimezoneConfig,
  getTimezoneConfig,
  TimezoneUtils,
  TIMEZONE_OFFSETS
};
