// backend/shared/formattedLogger.js
// Enhanced logger with automatic number formatting for better readability
'use strict';

const NumberFormatter = require('./numberFormat');

/**
 * Format log message with readable numbers
 * Automatically detects and formats large numbers, currencies, durations, distances
 * 
 * @param {string} message - Original log message
 * @param {string} locale - Locale code (default: en-US for logs)
 * @returns {string} Formatted message
 */
function formatLogMessage(message, locale = 'en-US') {
  if (typeof message !== 'string') return message;
  
  // Format large numbers (> 10000) with compact notation
  message = message.replace(/\b(\d{5,})\b/g, (match) => {
    const num = parseInt(match);
    return NumberFormatter.formatCompact(num, locale);
  });
  
  // Format currency mentions (e.g., "5000 gold", "10000 gems")
  message = message.replace(/(\d+)\s+(gold|gems?|diamonds?|coins?|tickets?)/gi, (match, num, currency) => {
    const value = parseInt(num);
    const currencyType = currency.toLowerCase().replace(/s$/, '');
    return NumberFormatter.formatCurrency(value, currencyType, locale);
  });
  
  // Format duration mentions (e.g., "3600 seconds", "1800s")
  message = message.replace(/(\d+)\s*(seconds?|s)\b/gi, (match, num) => {
    const seconds = parseInt(num);
    return NumberFormatter.formatDuration(seconds, locale);
  });
  
  // Format distance mentions (e.g., "1500 meters", "2000m")
  message = message.replace(/(\d+)\s*(meters?|m)\b/gi, (match, num) => {
    const meters = parseInt(num);
    return NumberFormatter.formatDistance(meters, locale);
  });
  
  // Format experience/power mentions (e.g., "gained 100000 exp", "power 50000")
  message = message.replace(/(\d+)\s*(exp|experience|power|cp)/gi, (match, num, type) => {
    const value = parseInt(num);
    const valueType = type.toLowerCase() === 'cp' ? 'power' : type.toLowerCase();
    return NumberFormatter.formatGameValue(value, valueType, locale);
  });
  
  // Format damage mentions (e.g., "dealt 50000 damage")
  message = message.replace(/(\d+)\s*(damage|dmg)/gi, (match, num) => {
    const value = parseInt(num);
    return NumberFormatter.formatGameValue(value, 'damage', locale);
  });
  
  return message;
}

/**
 * Create a formatted logger wrapper that automatically formats numbers
 * 
 * @param {Object} logger - Original logger instance (pino/winston/etc)
 * @param {string} locale - Locale code for formatting
 * @returns {Object} Wrapped logger with formatted output
 */
function createFormattedLogger(logger, locale = 'en-US') {
  const wrapLogMethod = (method) => {
    return (...args) => {
      // Handle different log argument patterns
      if (args.length === 0) return method.call(logger);
      
      const firstArg = args[0];
      
      // Pattern 1: message string
      if (typeof firstArg === 'string') {
        const formattedMessage = formatLogMessage(firstArg, locale);
        return method.call(logger, formattedMessage, ...args.slice(1));
      }
      
      // Pattern 2: object with message field
      if (typeof firstArg === 'object' && firstArg !== null) {
        if (firstArg.message) {
          const formattedObj = {
            ...firstArg,
            message: formatLogMessage(firstArg.message, locale)
          };
          return method.call(logger, formattedObj, ...args.slice(1));
        }
        
        // Format numeric fields in the object
        const formattedObj = formatLogObject(firstArg, locale);
        return method.call(logger, formattedObj, ...args.slice(1));
      }
      
      return method.call(logger, ...args);
    };
  };
  
  return {
    info: wrapLogMethod(logger.info),
    warn: wrapLogMethod(logger.warn),
    error: wrapLogMethod(logger.error),
    debug: wrapLogMethod(logger.debug),
    trace: wrapLogMethod(logger.trace || logger.debug),
    fatal: wrapLogMethod(logger.fatal || logger.error)
  };
}

/**
 * Format numeric fields in log objects
 * 
 * @param {Object} obj - Log object
 * @param {string} locale - Locale code
 * @returns {Object} Formatted object
 */
function formatLogObject(obj, locale) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const formatted = { ...obj };
  
  // Known numeric fields to format
  const numericFields = {
    gold: 'currency:gold',
    gems: 'currency:gems',
    diamonds: 'currency:diamonds',
    coins: 'currency:coins',
    tickets: 'currency:tickets',
    balance: 'currency:gold',
    exp: 'exp',
    experience: 'exp',
    power: 'power',
    combatPower: 'power',
    damage: 'damage',
    hp: 'hp',
    stamina: 'stamina',
    level: 'level',
    catchRate: 'catchRate',
    duration: 'duration',
    cooldown: 'duration',
    distance: 'distance'
  };
  
  for (const [field, type] of Object.entries(numericFields)) {
    if (formatted[field] !== undefined && typeof formatted[field] === 'number') {
      const value = formatted[field];
      
      if (type.startsWith('currency:')) {
        const currency = type.split(':')[1];
        formatted[field] = NumberFormatter.formatCurrency(value, currency, locale, { compact: true });
      } else if (type === 'duration') {
        formatted[field] = NumberFormatter.formatDuration(value, locale);
      } else if (type === 'distance') {
        formatted[field] = NumberFormatter.formatDistance(value, locale);
      } else {
        formatted[field] = NumberFormatter.formatGameValue(value, type, locale);
      }
      
      // Keep original numeric value as _raw
      formatted[`${field}_raw`] = value;
    }
  }
  
  return formatted;
}

/**
 * Create a log formatting context for manual formatting
 * 
 * @param {string} locale - Locale code
 * @returns {Object} Formatting context
 */
function createLogFormatContext(locale = 'en-US') {
  return {
    formatLogMessage: (message) => formatLogMessage(message, locale),
    formatLogObject: (obj) => formatLogObject(obj, locale),
    locale
  };
}

module.exports = {
  formatLogMessage,
  createFormattedLogger,
  formatLogObject,
  createLogFormatContext
};