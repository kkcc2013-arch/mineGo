// backend/shared/middleware/numberFormatMiddleware.js
// Middleware for automatic number formatting in API responses
'use strict';

const NumberFormatter = require('../numberFormat');
const { getLanguageFromRequest } = require('../i18n');

/**
 * Number format middleware - automatically formats numeric fields in API responses
 * Based on the user's locale preference
 */
function numberFormatMiddleware(req, res, next) {
  const lang = getLanguageFromRequest(req);
  
  // Store original res.json
  const originalJson = res.json.bind(res);
  
  // Override res.json to apply number formatting
  res.json = function(data) {
    // Apply number formatting if response contains numeric fields
    if (data && typeof data === 'object') {
      const formattedData = formatResponseNumbers(data, lang);
      return originalJson(formattedData);
    }
    return originalJson(data);
  };
  
  // Attach formatter to request for manual use
  req.formatNumber = (value, options = {}) => {
    return NumberFormatter.formatNumber(value, lang, options);
  };
  
  req.formatCurrency = (value, currency = 'gold', options = {}) => {
    return NumberFormatter.formatCurrency(value, currency, lang, options);
  };
  
  req.formatPercent = (value, options = {}) => {
    return NumberFormatter.formatPercent(value, lang, options);
  };
  
  req.formatGameValue = (value, type = 'power', options = {}) => {
    return NumberFormatter.formatGameValue(value, type, lang, options);
  };
  
  req.numberFormatter = NumberFormatter;
  req.language = lang;
  
  next();
}

/**
 * Format numeric fields in response object
 * This is a selective formatter that only formats known game numeric fields
 * 
 * @param {Object} data - Response data
 * @param {string} lang - Locale code
 * @returns {Object} Formatted data
 */
function formatResponseNumbers(data, lang) {
  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => formatResponseNumbers(item, lang));
  }
  
  // Handle objects
  if (data && typeof data === 'object') {
    const formatted = { ...data };
    
    // Known numeric field mappings to formatter types
    const numericFields = {
      // Player stats
      power: 'power',
      exp: 'exp',
      experience: 'exp',
      level: 'level',
      hp: 'hp',
      stamina: 'stamina',
      
      // Combat
      damage: 'damage',
      catch_rate: 'catchRate',
      catchRate: 'catchRate',
      
      // Currencies
      gold: 'currency:gold',
      gems: 'currency:gems',
      diamonds: 'currency:diamonds',
      coins: 'currency:coins',
      tickets: 'currency:tickets',
      balance: 'currency:gold',
      
      // Percentages
      success_rate: 'percent',
      successRate: 'percent',
      win_rate: 'percent',
      winRate: 'percent',
      
      // Distance
      distance: 'distance',
      distance_meters: 'distance',
      
      // Duration
      cooldown_seconds: 'duration',
      duration_seconds: 'duration'
    };
    
    for (const [field, type] of Object.entries(numericFields)) {
      if (formatted[field] !== undefined && typeof formatted[field] === 'number') {
        const value = formatted[field];
        
        if (type.startsWith('currency:')) {
          const currency = type.split(':')[1];
          formatted[field] = NumberFormatter.formatCurrency(value, currency, lang);
        } else if (type === 'percent') {
          formatted[field] = NumberFormatter.formatPercent(value, lang, { normalize: false });
        } else if (type === 'distance') {
          formatted[field] = NumberFormatter.formatDistance(value, lang);
        } else if (type === 'duration') {
          formatted[field] = NumberFormatter.formatDuration(value, lang);
        } else {
          formatted[field] = NumberFormatter.formatGameValue(value, type, lang);
        }
      }
    }
    
    // Recursively format nested objects
    for (const key of Object.keys(formatted)) {
      if (typeof formatted[key] === 'object' && formatted[key] !== null) {
        formatted[key] = formatResponseNumbers(formatted[key], lang);
      }
    }
    
    return formatted;
  }
  
  return data;
}

/**
 * Selective number formatting middleware - only formats specified fields
 * Use this when you want fine-grained control over which fields to format
 * 
 * @param {Array<string>} fields - Array of field names to format
 * @param {Object} options - Formatting options for each field
 */
function selectiveNumberFormatMiddleware(fields = [], options = {}) {
  return function(req, res, next) {
    const lang = getLanguageFromRequest(req);
    
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (data && typeof data === 'object' && fields.length > 0) {
        const formattedData = selectiveFormat(data, fields, lang, options);
        return originalJson(formattedData);
      }
      return originalJson(data);
    };
    
    req.numberFormatter = NumberFormatter;
    req.language = lang;
    next();
  };
}

/**
 * Selectively format only specified fields
 */
function selectiveFormat(data, fields, lang, options = {}) {
  if (Array.isArray(data)) {
    return data.map(item => selectiveFormat(item, fields, lang, options));
  }
  
  if (data && typeof data === 'object') {
    const formatted = { ...data };
    
    for (const field of fields) {
      if (formatted[field] !== undefined && typeof formatted[field] === 'number') {
        const fieldOptions = options[field] || {};
        const type = fieldOptions.type || 'number';
        const currency = fieldOptions.currency || 'gold';
        
        switch (type) {
          case 'currency':
            formatted[field] = NumberFormatter.formatCurrency(formatted[field], currency, lang, fieldOptions);
            break;
          case 'percent':
            formatted[field] = NumberFormatter.formatPercent(formatted[field], lang, fieldOptions);
            break;
          case 'gameValue':
            formatted[field] = NumberFormatter.formatGameValue(formatted[field], fieldOptions.valueType, lang, fieldOptions);
            break;
          case 'compact':
            formatted[field] = NumberFormatter.formatCompact(formatted[field], lang, fieldOptions);
            break;
          default:
            formatted[field] = NumberFormatter.formatNumber(formatted[field], lang, fieldOptions);
        }
      }
    }
    
    return formatted;
  }
  
  return data;
}

/**
 * Create number formatting context for a request
 * Useful for services that need formatting without middleware
 */
function createNumberFormatContext(lang) {
  return {
    formatNumber: (value, options = {}) => NumberFormatter.formatNumber(value, lang, options),
    formatCurrency: (value, currency = 'gold', options = {}) => NumberFormatter.formatCurrency(value, currency, lang, options),
    formatPercent: (value, options = {}) => NumberFormatter.formatPercent(value, lang, options),
    formatGameValue: (value, type = 'power', options = {}) => NumberFormatter.formatGameValue(value, type, lang, options),
    formatCompact: (value, options = {}) => NumberFormatter.formatCompact(value, lang, options),
    formatDistance: (value, options = {}) => NumberFormatter.formatDistance(value, lang, options),
    formatDuration: (value, options = {}) => NumberFormatter.formatDuration(value, lang, options),
    formatCountdown: (value, options = {}) => NumberFormatter.formatCountdown(value, lang, options),
    locale: lang
  };
}

module.exports = {
  numberFormatMiddleware,
  selectiveNumberFormatMiddleware,
  createNumberFormatContext,
  formatResponseNumbers
};