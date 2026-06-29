// frontend/game-client/src/utils/numberFormat.js
// Core number formatting module for game localization (frontend version)
'use strict';

import { FORMAT_CONFIGS, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './numberFormatConfig.js';
import { getCurrentLanguage } from '../i18n/index.js';

/**
 * NumberFormatter - Unified number formatting for mineGo frontend
 * Supports zh-CN, en-US, ja-JP locales
 */
const NumberFormatter = {
  /**
   * Get current locale from i18n system
   */
  getCurrentLocale() {
    try {
      return getCurrentLanguage() || DEFAULT_LANGUAGE;
    } catch (e) {
      return DEFAULT_LANGUAGE;
    }
  },

  /**
   * Get locale configuration
   */
  getConfig(locale) {
    if (!locale || !SUPPORTED_LANGUAGES.includes(locale)) {
      locale = DEFAULT_LANGUAGE;
    }
    return FORMAT_CONFIGS[locale] || FORMAT_CONFIGS[DEFAULT_LANGUAGE];
  },

  /**
   * Format number with thousand separator
   */
  formatNumber(value, locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof value !== 'number' || isNaN(value)) return '0';
    
    const config = this.getConfig(locale);
    const { precision = 0, compact = false } = options;
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
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
   */
  formatCompact(value, locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof value !== 'number' || isNaN(value)) return '0';
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    const config = this.getConfig(locale);
    const thresholds = config.compact.thresholds;
    
    let threshold = thresholds.find(t => absValue >= t.value);
    if (!threshold) threshold = thresholds[thresholds.length - 1];
    
    if (threshold.divisor === 1) {
      const formatted = Math.floor(absValue).toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, config.thousandSeparator);
      return isNegative ? `-${formatted}` : formatted;
    }
    
    const scaled = absValue / threshold.divisor;
    const precision = options.precision ?? threshold.precision;
    const formatted = scaled.toFixed(precision);
    const result = parseFloat(formatted).toString() + threshold.unit;
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format currency (gold, gems, diamonds)
   */
  formatCurrency(value, currency = 'gold', locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof value !== 'number' || isNaN(value)) value = 0;
    
    const config = this.getConfig(locale);
    const currencyConfig = config.currencies[currency] || config.currencies.gold;
    
    const { compact = true, precision } = options;
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
    let formatted;
    if (compact && absValue >= 10000) {
      formatted = this.formatCompact(absValue, locale, { precision });
    } else {
      formatted = this.formatNumber(absValue, locale, { precision });
    }
    
    const { symbol, position, spacing } = currencyConfig;
    const space = spacing ? ' ' : '';
    
    let result = position === 'prefix' 
      ? `${symbol}${space}${formatted}` 
      : `${formatted}${space}${symbol}`;
    
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format percentage
   */
  formatPercent(value, locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof value !== 'number' || isNaN(value)) return '0%';
    
    const config = this.getConfig(locale);
    const { precision = config.percent.precision, normalize = true } = options;
    
    let percentValue = normalize && value <= 1 && value >= 0 ? value * 100 : value;
    percentValue = Math.max(0, Math.min(100, percentValue));
    
    return `${percentValue.toFixed(precision)}${config.percent.suffix}`;
  },

  /**
   * Format game-specific values (power, exp, damage, hp, level)
   */
  formatGameValue(value, type = 'power', locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof value !== 'number' || isNaN(value)) value = 0;
    
    const config = this.getConfig(locale);
    const valueConfig = config.gameValues[type];
    
    if (!valueConfig) return this.formatNumber(value, locale, options);
    
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    
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
    
    if (valueConfig.suffix) formatted = `${formatted}${valueConfig.suffix}`;
    
    if (valueConfig.showLabel && valueConfig.label) {
      const space = locale === 'en-US' ? ' ' : '';
      formatted = valueConfig.prefix 
        ? `${valueConfig.label}${formatted}` 
        : `${formatted}${space}${valueConfig.label}`;
    }
    
    return isNegative ? `-${formatted}` : formatted;
  },

  /**
   * Format level
   */
  formatLevel(level, locale = null) {
    return this.formatGameValue(level, 'level', locale);
  },

  /**
   * Format catch rate (0-1 probability to percentage)
   */
  formatCatchRate(rate, locale = null) {
    return this.formatGameValue(rate * 100, 'catchRate', locale);
  },

  /**
   * Format damage
   */
  formatDamage(damage, locale = null, options = {}) {
    return this.formatGameValue(damage, 'damage', locale, options);
  },

  /**
   * Format HP
   */
  formatHP(hp, locale = null, options = {}) {
    return this.formatGameValue(hp, 'hp', locale, options);
  },

  /**
   * Format experience
   */
  formatExp(exp, locale = null, options = {}) {
    return this.formatGameValue(exp, 'exp', locale, options);
  },

  /**
   * Format power/combat power
   */
  formatPower(power, locale = null, options = {}) {
    return this.formatGameValue(power, 'power', locale, options);
  },

  /**
   * Format distance (meters to km/m)
   */
  formatDistance(meters, locale = null, options = {}) {
    if (locale === null) locale = this.getCurrentLocale();
    const { precision = 1, unit = 'auto' } = options;
    
    const isNegative = meters < 0;
    const absMeters = Math.abs(meters);
    
    let formatted, unitStr;
    
    if (unit === 'auto') {
      if (absMeters >= 1000) {
        formatted = (absMeters / 1000).toFixed(precision);
        unitStr = locale === 'en-US' ? 'km' : '公里';
      } else {
        formatted = Math.floor(absMeters).toString();
        unitStr = locale === 'en-US' ? 'm' : '米';
      }
    } else if (unit === 'km') {
      formatted = (absMeters / 1000).toFixed(precision);
      unitStr = locale === 'en-US' ? 'km' : '公里';
    } else {
      formatted = Math.floor(absMeters).toString();
      unitStr = locale === 'en-US' ? 'm' : '米';
    }
    
    const result = `${formatted}${locale === 'en-US' ? ' ' : ''}${unitStr}`;
    return isNegative ? `-${result}` : result;
  },

  /**
   * Format duration (seconds to human readable)
   */
  formatDuration(seconds, locale = null) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return locale === 'en-US' ? '0s' : '0秒';
    
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
   * Format countdown (MM:SS or HH:MM:SS)
   */
  formatCountdown(seconds, locale = null, options = {}) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) seconds = 0;
    
    const { showHours = false } = options;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (showHours || hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  /**
   * Parse formatted number back to numeric value
   */
  parseFormatted(formatted, locale = null) {
    if (locale === null) locale = this.getCurrentLocale();
    if (typeof formatted !== 'string') {
      return typeof formatted === 'number' ? formatted : 0;
    }
    
    const config = this.getConfig(locale);
    let clean = formatted.trim();
    
    // Remove currency symbols
    for (const currency of Object.values(config.currencies)) {
      clean = clean.replace(currency.symbol, '');
    }
    
    // Remove compact units
    for (const threshold of config.compact.thresholds) {
      if (threshold.unit) clean = clean.replace(threshold.unit, '');
    }
    
    // Remove game value labels and suffixes
    for (const gv of Object.values(config.gameValues)) {
      if (gv.label) clean = clean.replace(gv.label, '');
      if (gv.suffix) clean = clean.replace(gv.suffix, '');
    }
    
    // Remove thousand separators and normalize decimal
    clean = clean.replace(new RegExp(config.thousandSeparator, 'g'), '');
    clean = clean.replace(config.decimalSeparator, '.');
    clean = clean.replace(/[^\d.-]/g, '');
    
    const value = parseFloat(clean);
    return isNaN(value) ? 0 : value;
  }
};

// Export individual functions for direct import
export const formatNumber = NumberFormatter.formatNumber.bind(NumberFormatter);
export const formatCompact = NumberFormatter.formatCompact.bind(NumberFormatter);
export const formatCurrency = NumberFormatter.formatCurrency.bind(NumberFormatter);
export const formatPercent = NumberFormatter.formatPercent.bind(NumberFormatter);
export const formatGameValue = NumberFormatter.formatGameValue.bind(NumberFormatter);
export const formatLevel = NumberFormatter.formatLevel.bind(NumberFormatter);
export const formatCatchRate = NumberFormatter.formatCatchRate.bind(NumberFormatter);
export const formatDamage = NumberFormatter.formatDamage.bind(NumberFormatter);
export const formatHP = NumberFormatter.formatHP.bind(NumberFormatter);
export const formatExp = NumberFormatter.formatExp.bind(NumberFormatter);
export const formatPower = NumberFormatter.formatPower.bind(NumberFormatter);
export const formatDistance = NumberFormatter.formatDistance.bind(NumberFormatter);
export const formatDuration = NumberFormatter.formatDuration.bind(NumberFormatter);
export const formatCountdown = NumberFormatter.formatCountdown.bind(NumberFormatter);
export const parseFormatted = NumberFormatter.parseFormatted.bind(NumberFormatter);

export default NumberFormatter;