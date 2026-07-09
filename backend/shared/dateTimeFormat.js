// backend/shared/dateTimeFormat.js
// Core date and time formatting module for game localization
// REQ-00524: 游戏日期时间格式本地化与智能显示系统
'use strict';

const {
  DATETIME_CONFIGS,
  DEFAULT_CONFIG,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  CACHE_CONFIG,
  RELATIVE_THRESHOLDS,
  EVENT_THRESHOLDS
} = require('./dateTimeFormatConfig');

const { createLogger } = require('./logger');
const logger = createLogger('dateTimeFormatter');

/**
 * DateTimeFormatter - Unified date and time formatting for mineGo
 * Supports zh-CN, en-US, ja-JP locales
 */
const DateTimeFormatter = {
  // LRU 缓存
  _cache: new Map(),
  _cacheHits: 0,
  _cacheMisses: 0,
  
  /**
   * Get locale configuration
   * @param {string} locale - Locale code (zh-CN, en-US, ja-JP)
   * @returns {Object} Locale configuration
   */
  getConfig(locale) {
    if (!locale || !SUPPORTED_LANGUAGES.includes(locale)) {
      locale = DEFAULT_LANGUAGE;
    }
    return DATETIME_CONFIGS[locale] || DEFAULT_CONFIG;
  },
  
  /**
   * Clear cache (for testing or manual reset)
   */
  clearCache() {
    this._cache.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  },
  
  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    const total = this._cacheHits + this._cacheMisses;
    const hitRate = total > 0 ? (this._cacheHits / total) * 100 : 0;
    return {
      size: this._cache.size,
      hits: this._cacheHits,
      misses: this._cacheMisses,
      hitRate: hitRate.toFixed(2) + '%',
      maxSize: CACHE_CONFIG.maxSize,
      ttlMs: CACHE_CONFIG.ttlMs
    };
  },
  
  /**
   * Get from cache or compute
   * @param {string} key - Cache key
   * @param {Function} compute - Compute function
   * @returns {string} Cached or computed result
   */
  _getOrCompute(key, compute) {
    if (!CACHE_CONFIG.enabled) {
      return compute();
    }
    
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.ttlMs) {
      this._cacheHits++;
      return cached.value;
    }
    
    // Remove stale entry
    if (cached) {
      this._cache.delete(key);
    }
    
    // Compute new value
    const value = compute();
    this._cacheMisses++;
    
    // Manage cache size
    if (this._cache.size >= CACHE_CONFIG.maxSize) {
      // Remove oldest entry
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
    
    this._cache.set(key, { value, timestamp: Date.now() });
    return value;
  },
  
  /**
   * Format date with locale-specific format
   * @param {Date|string|number} date - Date to format
   * @param {string} locale - Locale code
   * @param {Object} options - Format options (format: 'full'|'long'|'medium'|'short')
   * @returns {string} Formatted date
   */
  formatDate(date, locale = DEFAULT_LANGUAGE, options = {}) {
    const d = this._toDate(date);
    if (!d) return '';
    
    const format = options.format || 'long';
    const cacheKey = `date:${d.getTime()}:${locale}:${format}`;
    
    return this._getOrCompute(cacheKey, () => {
      const config = this.getConfig(locale);
      const template = config.date[format] || config.date.long;
      
      return this._fillTemplate(template, {
        year: d.getFullYear(),
        month: config.monthsShort[d.getMonth()],
        day: d.getDate(),
        weekday: config.weekdaysShort[d.getDay()],
        weekdayFull: config.weekdays[d.getDay()]
      }, locale);
    });
  },
  
  /**
   * Format time with locale-specific format
   * @param {Date|string|number} date - Date to format
   * @param {string} locale - Locale code
   * @param {Object} options - Format options (format: 'full'|'long'|'short', hour12: boolean)
   * @returns {string} Formatted time
   */
  formatTime(date, locale = DEFAULT_LANGUAGE, options = {}) {
    const d = this._toDate(date);
    if (!d) return '';
    
    const config = this.getConfig(locale);
    const format = options.format || 'long';
    const useHour12 = options.hour12 !== undefined ? options.hour12 : config.formatOptions.hour12;
    
    const cacheKey = `time:${d.getTime()}:${locale}:${format}:${useHour12}`;
    
    return this._getOrCompute(cacheKey, () => {
      let hour = d.getHours();
      const minute = d.getMinutes().toString().padStart(2, '0');
      const second = d.getSeconds().toString().padStart(2, '0');
      
      let ampm = '';
      if (useHour12) {
        ampm = hour < 12 ? config.ampm.am : config.ampm.pm;
        hour = hour % 12 || 12;
      }
      
      const template = config.time[format] || config.time.long;
      return this._fillTemplate(template, {
        hour: hour.toString().padStart(2, '0'),
        minute,
        second,
        ampm
      }, locale);
    });
  },
  
  /**
   * Format date and time together
   * @param {Date|string|number} date - Date to format
   * @param {string} locale - Locale code
   * @param {Object} options - Format options
   * @returns {string} Formatted datetime
   */
  formatDateTime(date, locale = DEFAULT_LANGUAGE, options = {}) {
    const d = this._toDate(date);
    if (!d) return '';
    
    const format = options.format || 'long';
    const cacheKey = `datetime:${d.getTime()}:${locale}:${format}`;
    
    return this._getOrCompute(cacheKey, () => {
      const config = this.getConfig(locale);
      const template = config.datetime[format] || config.datetime.long;
      
      let hour = d.getHours();
      const useHour12 = options.hour12 !== undefined ? options.hour12 : config.formatOptions.hour12;
      let ampm = '';
      
      if (useHour12) {
        ampm = hour < 12 ? config.ampm.am : config.ampm.pm;
        hour = hour % 12 || 12;
      }
      
      return this._fillTemplate(template, {
        year: d.getFullYear(),
        month: config.monthsShort[d.getMonth()],
        monthNum: d.getMonth() + 1,
        day: d.getDate(),
        weekday: config.weekdaysShort[d.getDay()],
        hour: hour.toString().padStart(2, '0'),
        minute: d.getMinutes().toString().padStart(2, '0'),
        second: d.getSeconds().toString().padStart(2, '0'),
        ampm
      }, locale);
    });
  },
  
  /**
   * Format relative time (ago/in)
   * @param {Date|string|number} date - Target date
   * @param {string} locale - Locale code
   * @param {Date|string|number} referenceDate - Reference date (defaults to now)
   * @returns {string} Relative time string
   */
  formatRelative(date, locale = DEFAULT_LANGUAGE, referenceDate = new Date()) {
    const d = this._toDate(date);
    const ref = this._toDate(referenceDate) || new Date();
    if (!d) return '';
    
    const diffMs = d.getTime() - ref.getTime();
    const diffSeconds = Math.floor(Math.abs(diffMs) / 1000);
    const isFuture = diffMs > 0;
    
    const cacheKey = `relative:${Math.floor(d.getTime() / 60000)}:${Math.floor(ref.getTime() / 60000)}:${locale}:${isFuture}`;
    
    return this._getOrCompute(cacheKey, () => {
      const config = this.getConfig(locale);
      const rel = config.relative;
      
      // 刚刚 / in 1 minute
      if (diffSeconds < RELATIVE_THRESHOLDS.justNow) {
        return isFuture ? this._pluralize(rel.inMinutes, 1, locale) : rel.justNow;
      }
      
      // N分钟前 / in N minutes
      if (diffSeconds < RELATIVE_THRESHOLDS.minutes) {
        const minutes = Math.floor(diffSeconds / 60);
        return isFuture
          ? this._pluralize(rel.inMinutes, minutes, locale)
          : this._pluralize(rel.minutesAgo, minutes, locale);
      }
      
      // N小时前 / in N hours
      if (diffSeconds < RELATIVE_THRESHOLDS.hours) {
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        
        // 检查是否同一天
        const targetDay = this._getStartOfDay(d);
        const refDay = this._getStartOfDay(ref);
        const dayDiff = Math.floor((targetDay - refDay) / 86400000);
        
        if (!isFuture && dayDiff === 0) {
          return this._fillTemplate(rel.today, { time: this.formatTime(d, locale) }, locale);
        }
        if (!isFuture && dayDiff === -1) {
          return this._fillTemplate(rel.yesterday, { time: this.formatTime(d, locale) }, locale);
        }
        if (isFuture && dayDiff === 1) {
          return this._fillTemplate(rel.tomorrow, { time: this.formatTime(d, locale) }, locale);
        }
        
        return isFuture
          ? this._pluralize(rel.inHours, hours, locale)
          : this._pluralize(rel.hoursAgo, hours, locale);
      }
      
      // N天前 / in N days
      const days = Math.floor(diffSeconds / 86400);
      if (days < 7) {
        return isFuture
          ? this._pluralize(rel.inDays, days, locale)
          : this._pluralize(rel.daysAgo, days, locale);
      }
      
      // N周前 / in N weeks
      const weeks = Math.floor(days / 7);
      if (weeks < 4) {
        return isFuture
          ? this._pluralize(rel.inWeeks, weeks, locale)
          : this._pluralize(rel.weeksAgo, weeks, locale);
      }
      
      // N个月前 / in N months
      const months = Math.floor(days / 30);
      if (months < 12) {
        return isFuture
          ? this._pluralize(rel.inMonths, months, locale)
          : this._pluralize(rel.monthsAgo, months, locale);
      }
      
      // N年前 / in N years
      const years = Math.floor(days / 365);
      return isFuture
        ? this._pluralize(rel.inYears, years, locale)
        : this._pluralize(rel.yearsAgo, years, locale);
    });
  },
  
  /**
   * Format countdown (remaining time)
   * @param {number} seconds - Remaining seconds
   * @param {string} locale - Locale code
   * @param {Object} options - Format options (showDays, showHours, showSeconds, short)
   * @returns {string} Countdown string
   */
  formatCountdown(seconds, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
      return '0s';
    }
    
    const { showDays = true, showHours = true, showSeconds = true, short = false } = options;
    const config = this.getConfig(locale);
    const cd = config.countdown;
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    // 根据剩余时间选择合适的格式
    if (days > 0 && showDays) {
      if (hours > 0 && showHours) {
        return short
          ? `${cd.shortDays.replace('{d}', days)} ${cd.shortHours.replace('{h}', hours)}`
          : this._fillTemplate(cd.daysHours, { d: days, h: hours }, locale);
      }
      return cd.shortDays.replace('{d}', days);
    }
    
    if (hours > 0 && showHours) {
      if (minutes > 0) {
        return short
          ? `${cd.shortHours.replace('{h}', hours)} ${cd.shortMinutes.replace('{m}', minutes)}`
          : this._fillTemplate(cd.hoursMinutes, { h: hours, m: minutes }, locale);
      }
      return cd.shortHours.replace('{h}', hours);
    }
    
    if (minutes > 0) {
      if (secs > 0 && showSeconds) {
        return short
          ? `${cd.shortMinutes.replace('{m}', minutes)} ${cd.shortSeconds.replace('{s}', secs)}`
          : this._fillTemplate(cd.minutesSeconds, { m: minutes, s: secs }, locale);
      }
      return cd.shortMinutes.replace('{m}', minutes);
    }
    
    return cd.shortSeconds.replace('{s}', secs);
  },
  
  /**
   * Format event time status
   * @param {Date|string|number} startTime - Event start time
   * @param {Date|string|number} endTime - Event end time
   * @param {string} locale - Locale code
   * @param {Date} now - Current time (defaults to now)
   * @returns {Object} Event status with formatted text
   */
  formatEventTime(startTime, endTime, locale = DEFAULT_LANGUAGE, now = new Date()) {
    const start = this._toDate(startTime);
    const end = this._toDate(endTime);
    const current = this._toDate(now) || new Date();
    
    if (!start || !end) {
      return { status: 'UNKNOWN', text: '' };
    }
    
    const config = this.getConfig(locale);
    const status = config.eventStatus;
    
    const startMs = start.getTime();
    const endMs = end.getTime();
    const nowMs = current.getTime();
    
    // 已结束
    if (nowMs > endMs) {
      return {
        status: 'ENDED',
        text: status.ended,
        detail: this._fillTemplate(status.endedAt, { time: this.formatRelative(end, locale, current) }, locale)
      };
    }
    
    // 进行中但即将结束
    if (nowMs >= startMs && nowMs < endMs) {
      const remainingSeconds = Math.floor((endMs - nowMs) / 1000);
      
      if (remainingSeconds < EVENT_THRESHOLDS.endingSoon) {
        return {
          status: 'ENDING_SOON',
          text: status.endingSoon,
          detail: this._fillTemplate(status.endsIn, { time: this.formatCountdown(remainingSeconds, locale) }, locale),
          remainingSeconds
        };
      }
      
      return {
        status: 'IN_PROGRESS',
        text: status.inProgress,
        detail: this._fillTemplate(status.endsIn, { time: this.formatCountdown(remainingSeconds, locale) }, locale),
        remainingSeconds
      };
    }
    
    // 未开始
    const remainingToStart = Math.floor((startMs - nowMs) / 1000);
    
    if (remainingToStart < EVENT_THRESHOLDS.startingSoon) {
      return {
        status: 'NOT_STARTED',
        text: status.notStarted,
        detail: this._fillTemplate(status.startsIn, { time: this.formatCountdown(remainingToStart, locale) }, locale),
        remainingSeconds: remainingToStart
      };
    }
    
    return {
      status: 'NOT_STARTED',
      text: status.notStarted,
      detail: this._fillTemplate(status.startsIn, { time: this.formatRelative(start, locale, current) }, locale),
      remainingSeconds: remainingToStart
    };
  },
  
  /**
   * Format cooldown time
   * @param {number} seconds - Cooldown remaining seconds
   * @param {string} locale - Locale code
   * @returns {string} Cooldown text
   */
  formatCooldown(seconds, locale = DEFAULT_LANGUAGE) {
    if (typeof seconds !== 'number' || isNaN(seconds)) {
      return '';
    }
    
    const config = this.getConfig(locale);
    const cd = config.cooldown;
    
    if (seconds <= 0) {
      return cd.ready;
    }
    
    const remaining = this.formatCountdown(seconds, locale, { short: true });
    return this._fillTemplate(cd.remaining, { time: remaining }, locale);
  },
  
  /**
   * Format incubation/hatching time
   * @param {number} seconds - Remaining seconds
   * @param {string} locale - Locale code
   * @returns {string} Incubation status
   */
  formatIncubation(seconds, locale = DEFAULT_LANGUAGE) {
    if (typeof seconds !== 'number' || isNaN(seconds)) {
      return '';
    }
    
    const config = this.getConfig(locale);
    const inc = config.incubation;
    
    if (seconds <= 0) {
      return inc.ready;
    }
    
    const remaining = this.formatCountdown(seconds, locale, { short: true });
    return this._fillTemplate(inc.remaining, { time: remaining }, locale);
  },
  
  /**
   * Smart format - automatically choose best format based on context
   * @param {Date|string|number} date - Date to format
   * @param {string} locale - Locale code
   * @param {Object} options - Options (maxRelativeDays: 7, showTime: true)
   * @returns {string} Smart formatted string
   */
  formatSmart(date, locale = DEFAULT_LANGUAGE, options = {}) {
    const d = this._toDate(date);
    if (!d) return '';
    
    const { maxRelativeDays = 7, showTime = true } = options;
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.abs(Math.floor(diffMs / 86400000));
    
    // Use relative format for recent dates
    if (diffDays <= maxRelativeDays) {
      return this.formatRelative(d, locale, now);
    }
    
    // Use absolute format for older/future dates
    if (showTime) {
      return this.formatDateTime(d, locale, { format: 'medium' });
    }
    return this.formatDate(d, locale, { format: 'medium' });
  },
  
  /**
   * Convert various date inputs to Date object
   * @param {Date|string|number} input - Date input
   * @returns {Date|null} Date object or null
   */
  _toDate(input) {
    if (!input) return null;
    
    if (input instanceof Date) {
      return isNaN(input.getTime()) ? null : input;
    }
    
    if (typeof input === 'number') {
      // Assume milliseconds or seconds
      const ms = input > 1e10 ? input : input * 1000;
      return new Date(ms);
    }
    
    if (typeof input === 'string') {
      const d = new Date(input);
      return isNaN(d.getTime()) ? null : d;
    }
    
    return null;
  },
  
  /**
   * Get start of day (00:00:00)
   * @param {Date} date - Date
   * @returns {number} Milliseconds of start of day
   */
  _getStartOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },
  
  /**
   * Fill template with values
   * @param {string} template - Template string
   * @param {Object} values - Values to fill
   * @param {string} locale - Locale code
   * @returns {string} Filled template
   */
  _fillTemplate(template, values, locale) {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return result;
  },
  
  /**
   * Pluralize template (handle singular/plural)
   * @param {string} template - Template with {n}
   * @param {number} count - Count
   * @param {string} locale - Locale code
   * @returns {string} Pluralized string
   */
  _pluralize(template, count, locale) {
    // For en-US, handle singular forms
    if (locale === 'en-US' && count === 1) {
      // Convert "N minutes ago" to "1 minute ago"
      const singular = template
        .replace('minutes', 'minute')
        .replace('hours', 'hour')
        .replace('days', 'day')
        .replace('weeks', 'week')
        .replace('months', 'month')
        .replace('years', 'year');
      return this._fillTemplate(singular, { n: count }, locale);
    }
    
    return this._fillTemplate(template, { n: count }, locale);
  },
  
  /**
   * Get weekday name
   * @param {number} dayIndex - Day index (0-6)
   * @param {string} locale - Locale code
   * @param {boolean} short - Use short form
   * @returns {string} Weekday name
   */
  getWeekday(dayIndex, locale = DEFAULT_LANGUAGE, short = false) {
    if (dayIndex < 0 || dayIndex > 6) return '';
    const config = this.getConfig(locale);
    return short ? config.weekdaysShort[dayIndex] : config.weekdays[dayIndex];
  },
  
  /**
   * Get month name
   * @param {number} monthIndex - Month index (0-11)
   * @param {string} locale - Locale code
   * @param {boolean} short - Use short form
   * @returns {string} Month name
   */
  getMonth(monthIndex, locale = DEFAULT_LANGUAGE, short = false) {
    if (monthIndex < 0 || monthIndex > 11) return '';
    const config = this.getConfig(locale);
    return short ? config.monthsShort[monthIndex] : config.months[monthIndex];
  },
  
  /**
   * Parse duration string to seconds
   * @param {string} duration - Duration string (e.g., "2h30m", "90s", "1d")
   * @returns {number} Seconds
   */
  parseDuration(duration) {
    if (typeof duration !== 'string') return 0;
    
    let totalSeconds = 0;
    const patterns = {
      d: /(\d+)d/i,
      h: /(\d+)h/i,
      m: /(\d+)m/i,
      s: /(\d+)s/i
    };
    
    for (const [unit, pattern] of Object.entries(patterns)) {
      const match = duration.match(pattern);
      if (match) {
        const value = parseInt(match[1], 10);
        switch (unit) {
          case 'd': totalSeconds += value * 86400; break;
          case 'h': totalSeconds += value * 3600; break;
          case 'm': totalSeconds += value * 60; break;
          case 's': totalSeconds += value; break;
        }
      }
    }
    
    return totalSeconds;
  },
  
  /**
   * Format ISO 8601 string
   * @param {Date|string|number} date - Date to format
   * @returns {string} ISO 8601 string
   */
  formatISO(date) {
    const d = this._toDate(date);
    if (!d) return '';
    return d.toISOString();
  },
  
  /**
   * Format Unix timestamp
   * @param {Date|string|number} date - Date to format
   * @returns {number} Unix timestamp (seconds)
   */
  formatUnix(date) {
    const d = this._toDate(date);
    if (!d) return 0;
    return Math.floor(d.getTime() / 1000);
  },
  
  /**
   * Precompute common time formats for the next 24 hours
   * Call this at startup to improve performance
   */
  precompute() {
    const now = Date.now();
    const languages = SUPPORTED_LANGUAGES;
    
    logger.info('Precomputing datetime formats for next 24 hours...');
    
    // Precompute for each hour in next 24 hours
    for (let i = 0; i < 24; i++) {
      const futureTime = now + i * 3600000;
      const futureDate = new Date(futureTime);
      
      for (const locale of languages) {
        // Precompute common formats
        this.formatDate(futureDate, locale, { format: 'long' });
        this.formatTime(futureDate, locale, { format: 'long' });
        this.formatDateTime(futureDate, locale, { format: 'long' });
        this.formatRelative(futureDate, locale);
      }
    }
    
    logger.info(`Precomputed ${24 * languages.length * 4} formats`);
  }
};

module.exports = DateTimeFormatter;