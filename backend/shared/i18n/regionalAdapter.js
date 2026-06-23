// backend/shared/i18n/regionalAdapter.js
// REQ-00294: 区域化适配引擎

'use strict';

const moment = require('moment-timezone');
const numeral = require('numeral');
const { createLogger } = require('../logger');

const logger = createLogger('regional-adapter');

// 区域配置
const REGIONAL_CONFIGS = {
  'zh-CN': {
    timezone: 'Asia/Shanghai',
    dateFormat: 'YYYY年MM月DD日',
    timeFormat: 'HH:mm',
    dateTimeFormat: 'YYYY年MM月DD日 HH:mm',
    numberFormat: '0,0.00',
    currency: 'CNY',
    currencyFormat: '¥0,0.00',
    currencySymbol: '¥',
    weekStart: 1,
    firstDayOfYear: 1,
    listSeparator: '、',
    quotationMarks: ['「', '」']
  },
  'zh-TW': {
    timezone: 'Asia/Taipei',
    dateFormat: 'YYYY年MM月DD日',
    timeFormat: 'HH:mm',
    dateTimeFormat: 'YYYY年MM月DD日 HH:mm',
    numberFormat: '0,0.00',
    currency: 'TWD',
    currencyFormat: 'NT$0,0.00',
    currencySymbol: 'NT$',
    weekStart: 1,
    listSeparator: '、',
    quotationMarks: ['「', '」']
  },
  'en-US': {
    timezone: 'America/New_York',
    dateFormat: 'MM/DD/YYYY',
    timeFormat: 'h:mm A',
    dateTimeFormat: 'MM/DD/YYYY h:mm A',
    numberFormat: '0,0.00',
    currency: 'USD',
    currencyFormat: '$0,0.00',
    currencySymbol: '$',
    weekStart: 0,
    firstDayOfYear: 1,
    listSeparator: ', ',
    quotationMarks: ['"', '"']
  },
  'en-GB': {
    timezone: 'Europe/London',
    dateFormat: 'DD/MM/YYYY',
    timeFormat: 'HH:mm',
    dateTimeFormat: 'DD/MM/YYYY HH:mm',
    numberFormat: '0,0.00',
    currency: 'GBP',
    currencyFormat: '£0,0.00',
    currencySymbol: '£',
    weekStart: 1,
    listSeparator: ', ',
    quotationMarks: ['"', '"']
  },
  'ja-JP': {
    timezone: 'Asia/Tokyo',
    dateFormat: 'YYYY年MM月DD日',
    timeFormat: 'HH:mm',
    dateTimeFormat: 'YYYY年MM月DD日 HH:mm',
    numberFormat: '0,0.00',
    currency: 'JPY',
    currencyFormat: '¥0,0',
    currencySymbol: '¥',
    weekStart: 0,
    listSeparator: '、',
    quotationMarks: ['「', '」']
  }
};

// 汇率缓存（简化实现，实际应集成 API）
const EXCHANGE_RATES = {
  USD_CNY: 7.24,
  USD_TWD: 32.5,
  USD_JPY: 149.5,
  USD_GBP: 0.79,
  CNY_USD: 0.138,
  TWD_USD: 0.031,
  JPY_USD: 0.0067,
  GBP_USD: 1.27
};

class RegionalAdapter {
  constructor() {
    this.configs = REGIONAL_CONFIGS;
    this.rates = EXCHANGE_RATES;
  }

  /**
   * 获取区域配置
   */
  getConfig(locale) {
    return this.configs[locale] || this.configs['en-US'];
  }

  /**
   * 获取适配器实例
   */
  getAdapter(locale) {
    const config = this.getConfig(locale);
    return {
      formatDateTime: (date, options = {}) => this.formatDateTime(date, locale, options),
      formatNumber: (number, options = {}) => this.formatNumber(number, locale, options),
      formatCurrency: (amount, options = {}) => this.formatCurrency(amount, locale, options),
      formatRelativeTime: (date) => this.formatRelativeTime(date, locale),
      formatList: (items) => this.formatList(items, locale),
      getWeekStart: () => config.weekStart,
      getTimezone: () => config.timezone,
      getCurrencySymbol: () => config.currencySymbol
    };
  }

  /**
   * 格式化日期时间
   */
  formatDateTime(date, locale, options = {}) {
    const config = this.getConfig(locale);
    const timezone = options.timezone || config.timezone;
    
    const m = moment(date).tz(timezone);
    
    let format = options.format;
    if (!format) {
      if (options.showTime === false) {
        format = config.dateFormat;
      } else if (options.showDate === false) {
        format = config.timeFormat;
      } else {
        format = config.dateTimeFormat;
      }
    }
    
    return m.format(format);
  }

  /**
   * 格式化数字
   */
  formatNumber(number, locale, options = {}) {
    const config = this.getConfig(locale);
    let format = options.format || config.numberFormat;
    
    // 处理整数
    if (options.integer) {
      format = '0,0';
    }
    
    // 处理百分比
    if (options.percent) {
      format = '0.0%';
      numeral.register('locale', locale, {
        delimiters: {
          thousands: locale.startsWith('en') ? ',' : ',',
          decimal: '.'
        }
      });
    }
    
    numeral.locale(locale.startsWith('zh') || locale.startsWith('ja') ? 'en' : locale);
    return numeral(number).format(format);
  }

  /**
   * 格式化货币
   */
  formatCurrency(amount, locale, options = {}) {
    const config = this.getConfig(locale);
    const targetCurrency = options.currency || config.currency;
    
    // 汇率转换
    let convertedAmount = amount;
    if (options.fromCurrency && options.fromCurrency !== targetCurrency) {
      convertedAmount = this.convertCurrency(amount, options.fromCurrency, targetCurrency);
    }
    
    numeral.locale('en');
    const formatted = numeral(convertedAmount).format(config.currencyFormat);
    
    // 替换符号
    if (options.showSymbol !== false) {
      return formatted;
    }
    
    // 隐藏符号
    return formatted.replace(config.currencySymbol, '').trim();
  }

  /**
   * 格式化相对时间
   */
  formatRelativeTime(date, locale) {
    const config = this.getConfig(locale);
    const m = moment(date).tz(config.timezone);
    
    // 设置 locale
    const momentLocale = locale.split('-')[0];
    moment.locale(momentLocale);
    
    return m.fromNow();
  }

  /**
   * 格式化列表
   */
  formatList(items, locale) {
    const config = this.getConfig(locale);
    const separator = config.listSeparator;
    
    switch (locale) {
      case 'zh-CN':
      case 'zh-TW':
      case 'ja-JP':
        return items.join(separator);
      
      case 'en-US':
      case 'en-GB':
        if (items.length <= 2) {
          return items.join(' and ');
        }
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
      
      default:
        return items.join(', ');
    }
  }

  /**
   * 货币转换
   */
  convertCurrency(amount, fromCurrency, toCurrency) {
    const rateKey = `${fromCurrency}_${toCurrency}`;
    const rate = this.rates[rateKey];
    
    if (!rate) {
      logger.warn({ fromCurrency, toCurrency }, 'Exchange rate not found');
      return amount;
    }
    
    return amount * rate;
  }

  /**
   * 获取周起始日
   */
  getWeekStart(locale) {
    const config = this.getConfig(locale);
    return config.weekStart;
  }

  /**
   * 获取时区
   */
  getTimezone(locale) {
    const config = this.getConfig(locale);
    return config.timezone;
  }

  /**
   * 格式化引用内容
   */
  formatQuotation(text, locale) {
    const config = this.getConfig(locale);
    const [open, close] = config.quotationMarks;
    return `${open}${text}${close}`;
  }

  /**
   * 获取本地化的日期范围格式
   */
  formatDateRange(startDate, endDate, locale, options = {}) {
    const config = this.getConfig(locale);
    const start = this.formatDateTime(startDate, locale, { showTime: false });
    const end = this.formatDateTime(endDate, locale, { showTime: false });
    
    switch (locale.split('-')[0]) {
      case 'zh':
        return `${start} 至 ${end}`;
      case 'ja':
        return `${start} 〜 ${end}`;
      case 'en':
        return `${start} - ${end}`;
      default:
        return `${start} - ${end}`;
    }
  }

  /**
   * 更新汇率（实际应从 API 获取）
   */
  async updateExchangeRates(newRates) {
    Object.assign(this.rates, newRates);
    logger.info('Exchange rates updated');
  }
}

module.exports = RegionalAdapter;