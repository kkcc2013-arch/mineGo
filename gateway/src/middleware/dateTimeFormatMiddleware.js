// gateway/src/middleware/dateTimeFormatMiddleware.js
// REQ-00524: 日期时间格式化中间件
'use strict';

const DateTimeFormatter = require('../../shared/dateTimeFormat');
const { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../../shared/dateTimeFormatConfig');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('datetime-middleware');

/**
 * Date time format middleware
 * Attaches formatting functions to res.locals
 */
function dateTimeFormatMiddleware(req, res, next) {
  // Get locale from request (set by i18nMiddleware)
  const locale = req.language || DEFAULT_LANGUAGE;
  
  // Attach formatting functions to res.locals for easy access
  res.locals.formatDate = (date, options = {}) => {
    return DateTimeFormatter.formatDate(date, locale, options);
  };
  
  res.locals.formatTime = (date, options = {}) => {
    return DateTimeFormatter.formatTime(date, locale, options);
  };
  
  res.locals.formatDateTime = (date, options = {}) => {
    return DateTimeFormatter.formatDateTime(date, locale, options);
  };
  
  res.locals.formatRelative = (date, referenceDate) => {
    return DateTimeFormatter.formatRelative(date, locale, referenceDate);
  };
  
  res.locals.formatCountdown = (seconds, options = {}) => {
    return DateTimeFormatter.formatCountdown(seconds, locale, options);
  };
  
  res.locals.formatEventTime = (startTime, endTime) => {
    return DateTimeFormatter.formatEventTime(startTime, endTime, locale);
  };
  
  res.locals.formatCooldown = (seconds) => {
    return DateTimeFormatter.formatCooldown(seconds, locale);
  };
  
  res.locals.formatIncubation = (seconds) => {
    return DateTimeFormatter.formatIncubation(seconds, locale);
  };
  
  res.locals.formatSmart = (date, options = {}) => {
    return DateTimeFormatter.formatSmart(date, locale, options);
  };
  
  // Also attach to request for convenience
  req.formatDate = res.locals.formatDate;
  req.formatTime = res.locals.formatTime;
  req.formatDateTime = res.locals.formatDateTime;
  req.formatRelative = res.locals.formatRelative;
  req.formatCountdown = res.locals.formatCountdown;
  req.formatEventTime = res.locals.formatEventTime;
  req.formatCooldown = res.locals.formatCooldown;
  req.formatIncubation = res.locals.formatIncubation;
  req.formatSmart = res.locals.formatSmart;
  
  next();
}

/**
 * Response formatting helper
 * Automatically formats datetime fields in API responses
 */
function formatResponseDatetime(data, fields, locale = DEFAULT_LANGUAGE) {
  if (!data || !fields || !Array.isArray(fields)) {
    return data;
  }
  
  const formatted = { ...data };
  
  for (const field of fields) {
    if (formatted[field]) {
      formatted[`${field}Formatted`] = DateTimeFormatter.formatSmart(formatted[field], locale);
      formatted[`${field}ISO`] = DateTimeFormatter.formatISO(formatted[field]);
      formatted[`${field}Unix`] = DateTimeFormatter.formatUnix(formatted[field]);
    }
  }
  
  return formatted;
}

/**
 * Format event data with status
 */
function formatEventData(event, locale = DEFAULT_LANGUAGE) {
  if (!event || !event.start_time || !event.end_time) {
    return event;
  }
  
  const eventStatus = DateTimeFormatter.formatEventTime(
    event.start_time,
    event.end_time,
    locale
  );
  
  return {
    ...event,
    eventStatus: eventStatus.status,
    eventStatusText: eventStatus.text,
    eventStatusDetail: eventStatus.detail,
    remainingSeconds: eventStatus.remainingSeconds,
    start_time_formatted: DateTimeFormatter.formatSmart(event.start_time, locale),
    end_time_formatted: DateTimeFormatter.formatSmart(event.end_time, locale)
  };
}

/**
 * Format skill cooldown data
 */
function formatSkillData(skill, locale = DEFAULT_LANGUAGE) {
  if (!skill) return skill;
  
  const formatted = { ...skill };
  
  if (typeof skill.cooldown_seconds === 'number') {
    formatted.cooldown_formatted = DateTimeFormatter.formatCooldown(skill.cooldown_seconds, locale);
  }
  
  if (skill.last_used_at) {
    const remainingSeconds = Math.max(0,
      skill.cooldown_seconds - Math.floor((Date.now() - new Date(skill.last_used_at).getTime()) / 1000)
    );
    formatted.cooldown_remaining = remainingSeconds;
    formatted.cooldown_remaining_formatted = DateTimeFormatter.formatCooldown(remainingSeconds, locale);
  }
  
  return formatted;
}

/**
 * Format egg/incubation data
 */
function formatEggData(egg, locale = DEFAULT_LANGUAGE) {
  if (!egg || typeof egg.hatch_time_remaining !== 'number') {
    return egg;
  }
  
  return {
    ...egg,
    hatch_time_formatted: DateTimeFormatter.formatIncubation(egg.hatch_time_remaining, locale),
    hatch_countdown: DateTimeFormatter.formatCountdown(egg.hatch_time_remaining, locale)
  };
}

/**
 * Batch format array of items
 */
function formatBatch(items, formatter, locale = DEFAULT_LANGUAGE) {
  if (!Array.isArray(items)) {
    return items;
  }
  
  return items.map(item => formatter(item, locale));
}

module.exports = {
  dateTimeFormatMiddleware,
  formatResponseDatetime,
  formatEventData,
  formatSkillData,
  formatEggData,
  formatBatch,
  DateTimeFormatter
};