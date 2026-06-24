'use strict';

/**
 * Currency Formatter
 * Provides localized currency formatting and parsing
 * REQ-00051: Multi-currency Support
 */

const { createLogger } = require('./logger');
const logger = createLogger('currency-formatter');

// Currency locale mapping
const CURRENCY_LOCALES = {
  'USD': 'en-US',
  'EUR': 'de-DE',
  'GBP': 'en-GB',
  'JPY': 'ja-JP',
  'CNY': 'zh-CN',
  'KRW': 'ko-KR',
  'TWD': 'zh-TW',
  'HKD': 'zh-HK',
  'SGD': 'en-SG',
  'AUD': 'en-AU',
  'CAD': 'en-CA',
  'CHF': 'de-CH',
  'SEK': 'sv-SE',
  'NOK': 'nb-NO',
  'INR': 'en-IN',
  'THB': 'th-TH',
  'MYR': 'ms-MY',
  'PHP': 'en-PH',
  'VND': 'vi-VN',
  'BRL': 'pt-BR'
};

// Country to currency mapping
const COUNTRY_CURRENCY = {
  'US': 'USD', 'GB': 'GBP', 'EU': 'EUR',
  'JP': 'JPY', 'CN': 'CNY', 'KR': 'KRW',
  'TW': 'TWD', 'HK': 'HKD', 'SG': 'SGD',
  'AU': 'AUD', 'CA': 'CAD', 'CH': 'CHF',
  'SE': 'SEK', 'NO': 'NOK', 'IN': 'INR',
  'TH': 'THB', 'MY': 'MYR', 'PH': 'PHP',
  'VN': 'VND', 'BR': 'BRL',
  'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR'
};

// Currency configurations
const CURRENCY_CONFIG = {
  'USD': { symbol: '$', decimalPlaces: 2, symbolPosition: 'before' },
  'EUR': { symbol: '€', decimalPlaces: 2, symbolPosition: 'after' },
  'GBP': { symbol: '£', decimalPlaces: 2, symbolPosition: 'before' },
  'JPY': { symbol: '¥', decimalPlaces: 0, symbolPosition: 'before' },
  'CNY': { symbol: '¥', decimalPlaces: 2, symbolPosition: 'before' },
  'KRW': { symbol: '₩', decimalPlaces: 0, symbolPosition: 'before' },
  'TWD': { symbol: 'NT$', decimalPlaces: 2, symbolPosition: 'before' },
  'HKD': { symbol: 'HK$', decimalPlaces: 2, symbolPosition: 'before' },
  'SGD': { symbol: 'S$', decimalPlaces: 2, symbolPosition: 'before' },
  'AUD': { symbol: 'A$', decimalPlaces: 2, symbolPosition: 'before' },
  'CAD': { symbol: 'C$', decimalPlaces: 2, symbolPosition: 'before' },
  'CHF': { symbol: 'CHF', decimalPlaces: 2, symbolPosition: 'after' },
  'SEK': { symbol: 'kr', decimalPlaces: 2, symbolPosition: 'after' },
  'NOK': { symbol: 'kr', decimalPlaces: 2, symbolPosition: 'after' },
  'INR': { symbol: '₹', decimalPlaces: 2, symbolPosition: 'before' },
  'THB': { symbol: '฿', decimalPlaces: 2, symbolPosition: 'before' },
  'MYR': { symbol: 'RM', decimalPlaces: 2, symbolPosition: 'before' },
  'PHP': { symbol: '₱', decimalPlaces: 2, symbolPosition: 'before' },
  'VND': { symbol: '₫', decimalPlaces: 0, symbolPosition: 'after' },
  'BRL': { symbol: 'R$', decimalPlaces: 2, symbolPosition: 'before' }
};

class CurrencyFormatter {
  /**
   * Format amount for display
   */
  format(amount, currencyCode, options = {}) {
    const config = CURRENCY_CONFIG[currencyCode] || CURRENCY_CONFIG['USD'];
    const {
      showSymbol = true,
      showCode = false,
      compact = false
    } = options;

    let displayAmount = amount;
    let suffix = '';

    // Compact mode (K, M)
    if (compact && Math.abs(amount) >= 1000) {
      if (Math.abs(amount) >= 1000000) {
        displayAmount = amount / 1000000;
        suffix = 'M';
      } else {
        displayAmount = amount / 1000;
        suffix = 'K';
      }
    }

    // Format number with locale
    const locale = CURRENCY_LOCALES[currencyCode] || 'en-US';
    let formatted;

    try {
      formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: config.decimalPlaces,
        maximumFractionDigits: config.decimalPlaces
      }).format(displayAmount);
    } catch (error) {
      // Fallback to basic formatting
      formatted = displayAmount.toFixed(config.decimalPlaces);
    }

    // Add suffix
    if (suffix) {
      formatted += suffix;
    }

    // Add symbol
    if (showSymbol && config.symbol) {
      if (config.symbolPosition === 'after') {
        formatted = `${formatted} ${config.symbol}`;
      } else {
        formatted = `${config.symbol}${formatted}`;
      }
    }

    // Add currency code
    if (showCode) {
      formatted += ` ${currencyCode}`;
    }

    return formatted;
  }

  /**
   * Format using Intl.NumberFormat (full localization)
   */
  formatIntl(amount, currencyCode, locale = null) {
    const targetLocale = locale || CURRENCY_LOCALES[currencyCode] || 'en-US';

    try {
      return new Intl.NumberFormat(targetLocale, {
        style: 'currency',
        currency: currencyCode
      }).format(amount);
    } catch (error) {
      logger.warn('Intl formatting failed, using fallback', {
        error: error.message,
        currencyCode
      });
      return this.format(amount, currencyCode);
    }
  }

  /**
   * Parse user input to amount
   */
  parse(input, currencyCode) {
    // Remove currency symbols, spaces, thousand separators
    let cleaned = String(input)
      .replace(/[^\d.,\-]/g, '')
      .replace(/,/g, '');

    // Handle European decimal format (comma as decimal separator)
    const locale = CURRENCY_LOCALES[currencyCode];
    if (locale && ['de-DE', 'fr-FR', 'it-IT', 'es-ES'].includes(locale)) {
      // European format: 1.234,56 -> 1234.56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }

    const amount = parseFloat(cleaned);

    if (isNaN(amount)) {
      throw new Error(`Invalid amount: ${input}`);
    }

    return amount;
  }

  /**
   * Detect currency by country code
   */
  detectCurrency(countryCode) {
    return COUNTRY_CURRENCY[countryCode] || 'USD';
  }

  /**
   * Get currency config
   */
  getConfig(currencyCode) {
    return CURRENCY_CONFIG[currencyCode] || CURRENCY_CONFIG['USD'];
  }

  /**
   * Get locale for currency
   */
  getLocale(currencyCode) {
    return CURRENCY_LOCALES[currencyCode] || 'en-US';
  }

  /**
   * Round to currency's decimal places
   */
  round(amount, currencyCode) {
    const config = this.getConfig(currencyCode);
    const multiplier = Math.pow(10, config.decimalPlaces);
    return Math.round(amount * multiplier) / multiplier;
  }

  /**
   * Compare two amounts in same currency
   */
  compare(amount1, amount2, currencyCode) {
    const config = this.getConfig(currencyCode);
    const multiplier = Math.pow(10, config.decimalPlaces);

    const units1 = Math.round(amount1 * multiplier);
    const units2 = Math.round(amount2 * multiplier);

    return units1 - units2;
  }

  /**
   * Get supported currency codes
   */
  getSupportedCurrencies() {
    return Object.keys(CURRENCY_CONFIG);
  }

  /**
   * Check if currency is supported
   */
  isSupported(currencyCode) {
    return currencyCode in CURRENCY_CONFIG;
  }
}

// Export singleton
module.exports = new CurrencyFormatter();
