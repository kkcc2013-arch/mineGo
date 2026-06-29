// backend/shared/numberFormat.js
// Core number formatting module for game localization
'use strict';

const { FORMAT_CONFIGS, DEFAULT_CONFIG, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('./numberFormatConfig');

/**
 * NumberFormatter - Unified number formatting for mineGo
 * Supports zh-CN, en-US, ja-JP locales
 */
const NumberFormatter = {
  /**
   * Get locale configuration
   * @param {string} locale - Locale code (zh-CN, en-US, ja-JP)
   * @returns {Object} Locale configuration
   */
  getConfig(locale) {
    if (!locale || !SUPPORTED_LANGUAGES.includes(locale)) {
      locale = DEFAULT_LANGUAGE;
    }
    return FORMAT_CONFIGS[locale] || DEFAULT_CONFIG;
  },

  /**
   * Format number with thousand separator
   * @param {number} value - Number to format
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted number
   */
  formatNumber(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) {
      return '0';
    }
    
    const config = this.getConfig(locale);
    const { precision = 0, compact = false } = options;
    
    // Handle negative numbers
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
      // Format with thousand separator
      const fixed = precision > 0 ? absValue.toFixed(precision) : Math.floor(absValue).toString();
      const parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
      formatted = parts.join(config.decimalSeparator);
    }
    
    return isNegative ? `-${formatted}` : formatted;
  },

  /**
   * Format large number with compact notation
   * zh-CN: 万(10^4), 亿(10^8)
   * en-US: K(10^3), M(10^6), B(10^9)
   * ja-JP: 万(10^4), 億(10^8)
   * 
   * @param {number} value - Number to format
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Compact formatted number
   */
  formatCompact(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) {
      return '0';
    }
    
    // Handle negative numbers
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    const config = this.getConfig(locale);
    const thresholds = config.compact.thresholds;
    
    // Find the appropriate threshold
    let threshold = thresholds.find(t => absValue >= t.value);
    if (!threshold) {
      threshold = thresholds[thresholds.length - 1];
    }
    
    // If no unit needed, format normally
    if (threshold.divisor === 1) {
      const formatted = Math.floor(absValue).toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
      return isNegative ? `-${formatted}` : formatted;
    }
    
    // Apply compact format
    const scaled = absValue / threshold.divisor;
    const precision = options.precision ?? threshold.precision;
    const formatted = scaled.toFixed(precision);
    
    // Remove trailing zeros after decimal
    const result = parseFloat(formatted).toString() + threshold.unit;
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format currency (game virtual currencies: gold, gems, diamonds, etc.)
   * @param {number} value - Currency amount
   * @param {string} currency - Currency type (gold, gems, diamonds)
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted currency string
   */
  formatCurrency(value, currency = 'gold', locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) {
      value = 0;
    }
    
    const config = this.getConfig(locale);
    const currencyConfig = config.currencies[currency];
    
    if (!currencyConfig) {
      // Fallback to gold if currency not found
      currencyConfig = config.currencies.gold;
    }
    
    const { compact = true, precision } = options;
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    // Format the number
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
      formatted = this.formatNumber(absValue, locale, { precision });
    }
    
    // Apply currency symbol
    const { symbol, position, spacing } = currencyConfig;
    const space = spacing ? ' ' : '';
    
    let result;
    if (position === 'prefix') {
      result = `${symbol}${space}${formatted}`;
    } else {
      result = `${formatted}${space}${symbol}`;
    }
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format percentage
   * @param {number} value - Percentage value (0-100 or 0-1)
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted percentage
   */
  formatPercent(value, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) {
      return '0%';
    }
    
    const config = this.getConfig(locale);
    const { precision = config.percent.precision, normalize = true } = options;
    
    // Normalize if value is between 0-1
    let percentValue = normalize && value <= 1 && value >= 0 ? value * 100 : value;
    
    // Clamp to 0-100 range
    percentValue = Math.max(0, Math.min(100, percentValue));
    
    const formatted = percentValue.toFixed(precision);
    return `${formatted}${config.percent.suffix}`;
  },

  /**
   * Format game-specific values (power, exp, damage, hp, level, etc.)
   * @param {number} value - Game value
   * @param {string} type - Value type (power, exp, damage, hp, level, stamina, catchRate)
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted game value
   */
  formatGameValue(value, type = 'power', locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof value !== 'number' || isNaN(value)) {
      value = 0;
    }
    
    const config = this.getConfig(locale);
    const valueConfig = config.gameValues[type];
    
    if (!valueConfig) {
      // Fallback to generic number format
      return this.formatNumber(value, locale, options);
    }
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    // Apply compact format if configured
    let formatted;
    if (valueConfig.compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { 
        precision: options.precision ?? valueConfig.precision 
      });
    } else {
      formatted = this.formatNumber(absValue, locale, { 
        precision: options.precision ?? valueConfig.precision 
      });
    }
    
    // Apply suffix if configured
    if (valueConfig.suffix) {
      formatted = `${formatted}${valueConfig.suffix}`;
    }
    
    // Apply label if configured
    if (valueConfig.showLabel && valueConfig.label) {
      const space = locale === 'en-US' ? ' ' : '';
      if (valueConfig.prefix) {
        formatted = `${valueConfig.label}${formatted}`;
      } else {
        formatted = `${formatted}${space}${valueConfig.label}`;
      }
    }
    
    return isNegative ? `-${formatted}` : formatted;
  },

  /**
   * Format level with special handling
   * @param {number} level - Player/Pokemon level
   * @param {string} locale - Locale code
   * @returns {string} Formatted level
   */
  formatLevel(level, locale = DEFAULT_LANGUAGE) {
    return this.formatGameValue(level, 'level', locale);
  },

  /**
   * Format catch rate with percentage
   * @param {number} rate - Catch rate (0-1 probability)
   * @param {string} locale - Locale code
   * @returns {string} Formatted catch rate
   */
  formatCatchRate(rate, locale = DEFAULT_LANGUAGE) {
    return this.formatGameValue(rate * 100, 'catchRate', locale);
  },

  /**
   * Format damage value
   * @param {number} damage - Damage amount
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted damage
   */
  formatDamage(damage, locale = DEFAULT_LANGUAGE, options = {}) {
    return this.formatGameValue(damage, 'damage', locale, options);
  },

  /**
   * Format HP value
   * @param {number} hp - HP amount
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted HP
   */
  formatHP(hp, locale = DEFAULT_LANGUAGE, options = {}) {
    return this.formatGameValue(hp, 'hp', locale, options);
  },

  /**
   * Format experience value
   * @param {number} exp - Experience amount
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted experience
   */
  formatExp(exp, locale = DEFAULT_LANGUAGE, options = {}) {
    return this.formatGameValue(exp, 'exp', locale, options);
  },

  /**
   * Format power/combat power
   * @param {number} power - Power value
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted power
   */
  formatPower(power, locale = DEFAULT_LANGUAGE, options = {}) {
    return this.formatGameValue(power, 'power', locale, options);
  },

  /**
   * Parse formatted number back to numeric value
   * @param {string} formatted - Formatted number string
   * @param {string} locale - Locale code
   * @returns {number} Numeric value
   */
  parseFormatted(formatted, locale = DEFAULT_LANGUAGE) {
    if (typeof formatted !== 'string') {
      return typeof formatted === 'number' ? formatted : 0;
    }
    
    const config = this.getConfig(locale);
    
    // Remove currency symbols and labels
    let clean = formatted.trim();
    
    // Remove known currency symbols
    for (const currency of Object.values(config.currencies)) {
      clean = clean.replace(currency.symbol, '');
    }
    
    // Remove compact units
    for (const threshold of config.compact.thresholds) {
      if (threshold.unit) {
        clean = clean.replace(threshold.unit, '');
      }
    }
    
    // Remove game value labels
    for (const gv of Object.values(config.gameValues)) {
      if (gv.label) {
        clean = clean.replace(gv.label, '');
      }
      if (gv.suffix) {
        clean = clean.replace(gv.suffix, '');
      }
    }
    
    // Remove thousand separators and normalize decimal
    clean = clean.replace(new RegExp(config.thousandSeparator, 'g'), '');
    clean = clean.replace(config.decimalSeparator, '.');
    
    // Remove any remaining non-numeric characters except minus and decimal
    clean = clean.replace(/[^\d.-]/g, '');
    
    const value = parseFloat(clean);
    return isNaN(value) ? 0 : value;
  },

  /**
   * Format distance (km/m) - uses existing distance localization
   * @param {number} meters - Distance in meters
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted distance
   */
  formatDistance(meters, locale = DEFAULT_LANGUAGE, options = {}) {
    const { precision = 1, unit = 'auto' } = options;
    const config = this.getConfig(locale);
    
    const isNegative = meters < 0;
    const absMeters = Math.abs(meters);
    
    let formatted;
    let unitStr;
    
    if (unit === 'auto') {
      if (absMeters >= 1000) {
        const km = absMeters / 1000;
        formatted = km.toFixed(precision);
        unitStr = locale === 'en-US' ? 'km' : '公里';
      } else {
        formatted = Math.floor(absMeters).toString();
        unitStr = locale === 'en-US' ? 'm' : '米';
      }
    } else if (unit === 'km') {
      const km = absMeters / 1000;
      formatted = km.toFixed(precision);
      unitStr = locale === 'en-US' ? 'km' : '公里';
    } else {
      formatted = Math.floor(absMeters).toString();
      unitStr = locale === 'en-US' ? 'm' : '米';
    }
    
    // Add thousand separator to large numbers
    if (parseFloat(formatted) >= 1000) {
      formatted = formatted.replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
    }
    
    const result = `${formatted}${locale === 'en-US' ? ' ' : ''}${unitStr}`;
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format duration (seconds to human readable)
   * @param {number} seconds - Duration in seconds
   * @param {string} locale - Locale code
   * @returns {string} Formatted duration
   */
  formatDuration(seconds, locale = DEFAULT_LANGUAGE) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
      return '0秒';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    
    if (locale === 'zh-CN') {
      if (hours > 0) parts.push(`${hours}小时`);
      if (minutes > 0) parts.push(`${minutes}分钟`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    } else if (locale === 'en-US') {
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    } else if (locale === 'ja-JP') {
      if (hours > 0) parts.push(`${hours}時間`);
      if (minutes > 0) parts.push(`${minutes}分`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    }
    
    return parts.join(locale === 'en-US' ? ' ' : '');
  },

  /**
   * Format countdown time (MM:SS or HH:MM:SS)
   * @param {number} seconds - Countdown seconds
   * @param {string} locale - Locale code
   * @param {Object} options - Additional options
   * @returns {string} Formatted countdown
   */
  formatCountdown(seconds, locale = DEFAULT_LANGUAGE, options = {}) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
      seconds = 0;
    }
    
    const { showHours = false } = options;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (showHours || hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
};

module.exports = NumberFormatter;