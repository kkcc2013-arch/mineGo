// backend/shared/currencyFormatter.js
// REQ-00051: 货币格式化服务

'use strict';

// 货币配置
const CURRENCY_CONFIG = {
  'USD': { symbol: '$', decimalPlaces: 2, locale: 'en-US', symbolPosition: 'before' },
  'EUR': { symbol: '€', decimalPlaces: 2, locale: 'de-DE', symbolPosition: 'after' },
  'GBP': { symbol: '£', decimalPlaces: 2, locale: 'en-GB', symbolPosition: 'before' },
  'JPY': { symbol: '¥', decimalPlaces: 0, locale: 'ja-JP', symbolPosition: 'before' },
  'CNY': { symbol: '¥', decimalPlaces: 2, locale: 'zh-CN', symbolPosition: 'before' },
  'KRW': { symbol: '₩', decimalPlaces: 0, locale: 'ko-KR', symbolPosition: 'before' },
  'TWD': { symbol: 'NT$', decimalPlaces: 2, locale: 'zh-TW', symbolPosition: 'before' },
  'HKD': { symbol: 'HK$', decimalPlaces: 2, locale: 'zh-HK', symbolPosition: 'before' },
  'SGD': { symbol: 'S$', decimalPlaces: 2, locale: 'en-SG', symbolPosition: 'before' },
  'AUD': { symbol: 'A$', decimalPlaces: 2, locale: 'en-AU', symbolPosition: 'before' },
  'CAD': { symbol: 'C$', decimalPlaces: 2, locale: 'en-CA', symbolPosition: 'before' },
  'CHF': { symbol: 'CHF', decimalPlaces: 2, locale: 'de-CH', symbolPosition: 'after' },
  'SEK': { symbol: 'kr', decimalPlaces: 2, locale: 'sv-SE', symbolPosition: 'after' },
  'NOK': { symbol: 'kr', decimalPlaces: 2, locale: 'nb-NO', symbolPosition: 'after' },
  'INR': { symbol: '₹', decimalPlaces: 2, locale: 'en-IN', symbolPosition: 'before' }
};

// 国家到货币映射
const COUNTRY_CURRENCY_MAP = {
  'US': 'USD', 'GB': 'GBP', 'EU': 'EUR', 'JP': 'JPY', 'CN': 'CNY',
  'KR': 'KRW', 'TW': 'TWD', 'HK': 'HKD', 'SG': 'SGD', 'AU': 'AUD',
  'CA': 'CAD', 'CH': 'CHF', 'SE': 'SEK', 'NO': 'NOK', 'IN': 'INR',
  'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR', 'NL': 'EUR',
  'BE': 'EUR', 'AT': 'EUR', 'PT': 'EUR', 'GR': 'EUR', 'IE': 'EUR',
  'FI': 'EUR', 'DK': 'EUR', 'PL': 'EUR', 'CZ': 'EUR', 'RU': 'EUR',
  'BR': 'USD', 'MX': 'USD', 'AR': 'USD', 'CL': 'USD', 'CO': 'USD',
  'TH': 'USD', 'VN': 'USD', 'ID': 'USD', 'MY': 'USD', 'PH': 'USD'
};

class CurrencyFormatter {
  /**
   * 格式化金额显示
   */
  format(amount, currencyCode, options = {}) {
    const config = CURRENCY_CONFIG[currencyCode] || { 
      symbol: currencyCode, 
      decimalPlaces: 2,
      locale: 'en-US',
      symbolPosition: 'before'
    };
    
    const {
      showSymbol = true,
      showCode = false,
      compact = false
    } = options;
    
    let displayAmount = amount;
    let suffix = '';
    
    // 紧凑模式
    if (compact && Math.abs(amount) >= 1000) {
      if (Math.abs(amount) >= 1000000) {
        displayAmount = amount / 1000000;
        suffix = 'M';
      } else {
        displayAmount = amount / 1000;
        suffix = 'K';
      }
    }
    
    // 使用 Intl.NumberFormat 格式化
    const formatter = new Intl.NumberFormat(config.locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: config.decimalPlaces
    });
    
    let formatted = formatter.format(displayAmount);
    
    // 添加后缀
    if (suffix) {
      formatted += suffix;
    }
    
    // 添加符号或代码
    if (showSymbol && config.symbol) {
      if (config.symbolPosition === 'after') {
        formatted = `${formatted} ${config.symbol}`;
      } else {
        formatted = `${config.symbol}${formatted}`;
      }
    }
    
    if (showCode) {
      formatted += ` ${currencyCode}`;
    }
    
    return formatted;
  }

  /**
   * 解析用户输入的金额
   */
  parse(input, currencyCode) {
    // 移除货币符号、空格、千位分隔符
    let cleaned = String(input)
      .replace(/[^\d.,\-]/g, '')
      .replace(/,/g, '');  // 移除千位分隔符
    
    const amount = parseFloat(cleaned);
    
    if (isNaN(amount)) {
      throw new Error(`Invalid amount: ${input}`);
    }
    
    return amount;
  }

  /**
   * 根据地区检测货币
   */
  detectCurrency(countryCode) {
    return COUNTRY_CURRENCY_MAP[countryCode?.toUpperCase()] || 'USD';
  }

  /**
   * 获取货币配置
   */
  getConfig(currencyCode) {
    return CURRENCY_CONFIG[currencyCode] || null;
  }

  /**
   * 获取所有支持的货币
   */
  getSupportedCurrencies() {
    return Object.keys(CURRENCY_CONFIG);
  }

  /**
   * 比较金额（同一货币）
   */
  compare(amount1, amount2, currencyCode) {
    const config = CURRENCY_CONFIG[currencyCode] || { decimalPlaces: 2 };
    const multiplier = Math.pow(10, config.decimalPlaces);
    
    const minUnit1 = Math.round(amount1 * multiplier);
    const minUnit2 = Math.round(amount2 * multiplier);
    
    return minUnit1 - minUnit2;
  }

  /**
   * 转换为最小单位（分、厘等）
   */
  toMinorUnit(amount, currencyCode) {
    const config = CURRENCY_CONFIG[currencyCode] || { decimalPlaces: 2 };
    const multiplier = Math.pow(10, config.decimalPlaces);
    return Math.round(amount * multiplier);
  }

  /**
   * 从最小单位转换
   */
  fromMinorUnit(minorAmount, currencyCode) {
    const config = CURRENCY_CONFIG[currencyCode] || { decimalPlaces: 2 };
    const divisor = Math.pow(10, config.decimalPlaces);
    return minorAmount / divisor;
  }

  /**
   * 验证货币代码
   */
  isValidCurrency(currencyCode) {
    return currencyCode in CURRENCY_CONFIG;
  }
}

// 单例导出
const currencyFormatter = new CurrencyFormatter();

module.exports = {
  CurrencyFormatter,
  currencyFormatter,
  CURRENCY_CONFIG,
  COUNTRY_CURRENCY_MAP
};
