/**
 * Game Currency Localizer - 游戏货币本地化服务
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 * 
 * 功能：
 * - 游戏虚拟货币本地化显示
 * - 支持多种语言货币名称
 * - 智能数量级简写
 * 
 * @module backend/shared/currencyLocalizer/GameCurrencyLocalizer
 * @version 1.0.0
 */

'use strict';

const createMagnitudeAbbreviator = require('./MagnitudeAbbreviator');

/**
 * 游戏货币类型定义
 */
const GAME_CURRENCIES = {
  COINS: {
    id: 'coins',
    names: {
      'zh-CN': '金币',
      'zh-TW': '金幣',
      'en-US': 'Coins',
      'ja-JP': 'コイン',
      'ko-KR': '코인',
      'es-ES': 'Monedas',
      'fr-FR': 'Pièces',
      'de-DE': 'Münzen'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  },
  POKECOINS: {
    id: 'pokecoins',
    names: {
      'zh-CN': '精币',
      'zh-TW': '精幣',
      'en-US': 'PokéCoins',
      'ja-JP': 'ポケコイン',
      'ko-KR': '포켓코인'
    },
    symbolPosition: 'prefix',
    spaceSeparator: false,
    precision: 0,
    symbol: '₽'
  },
  STARDUST: {
    id: 'stardust',
    names: {
      'zh-CN': '星尘',
      'zh-TW': '星塵',
      'en-US': 'Stardust',
      'ja-JP': 'ほしのすな',
      'ko-KR': '별의모래'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  },
  CANDY: {
    id: 'candy',
    names: {
      'zh-CN': '糖果',
      'zh-TW': '糖果',
      'en-US': 'Candy',
      'ja-JP': 'アメ',
      'ko-KR': '사탕'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  },
  GOLDEN_RASPBERRY: {
    id: 'golden_raspberry',
    names: {
      'zh-CN': '金莓',
      'zh-TW': '金莓',
      'en-US': 'Golden Razz',
      'ja-JP': 'きんのみ',
      'ko-KR': '금열매'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  },
  PREMIUM_PASS: {
    id: 'premium_pass',
    names: {
      'zh-CN': '高级通行证',
      'zh-TW': '高級通行證',
      'en-US': 'Premium Pass',
      'ja-JP': 'プレミアムパス',
      'ko-KR': '프리미엄 패스'
    },
    symbolPosition: 'suffix',
    spaceSeparator: true,
    precision: 0
  }
};

/**
 * 游戏货币本地化器
 */
class GameCurrencyLocalizer {
  /**
   * 构造函数
   * @param {string} locale - 语言区域代码
   */
  constructor(locale = 'zh-CN') {
    this.locale = locale;
    this.abbreviator = createMagnitudeAbbreviator(locale);
  }

  /**
   * 格式化货币显示
   * @param {number} amount - 金额
   * @param {string} currencyType - 货币类型
   * @param {Object} options - 选项
   * @returns {string} - 格式化后的字符串
   */
  format(amount, currencyType, options = {}) {
    const currency = GAME_CURRENCIES[currencyType];
    if (!currency) {
      return String(amount);
    }

    const {
      useAbbreviation = true,
      showFullNumber = false,
      showSymbol = true,
      minAbbreviationThreshold = 10000
    } = options;

    // 获取本地化名称
    const localName = currency.names[this.locale] || currency.names['en-US'] || currencyType;

    // 数字格式化
    let displayAmount;
    if (showFullNumber || !useAbbreviation || amount < minAbbreviationThreshold) {
      displayAmount = this.formatNumber(amount, currency.precision);
    } else {
      displayAmount = this.abbreviator.abbreviate(amount);
    }

    // 组合显示
    if (!showSymbol) {
      return displayAmount;
    }

    if (currency.symbolPosition === 'prefix') {
      const space = currency.spaceSeparator ? ' ' : '';
      const symbol = currency.symbol || localName;
      return `${symbol}${space}${displayAmount}`;
    } else {
      const space = currency.spaceSeparator ? ' ' : '';
      return `${displayAmount}${space}${localName}`;
    }
  }

  /**
   * 格式化数字
   * @param {number} num - 数字
   * @param {number} precision - 精度
   * @returns {string} - 格式化后的字符串
   */
  formatNumber(num, precision = 0) {
    return new Intl.NumberFormat(this.locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision
    }).format(num);
  }

  /**
   * 获取货币本地化名称
   * @param {string} currencyType - 货币类型
   * @returns {string} - 本地化名称
   */
  getCurrencyName(currencyType) {
    const currency = GAME_CURRENCIES[currencyType];
    return currency?.names[this.locale] || currency?.names['en-US'] || currencyType;
  }

  /**
   * 获取所有货币的本地化信息
   * @returns {Array<Object>} - 货币信息列表
   */
  getAllCurrenciesInfo() {
    return Object.entries(GAME_CURRENCIES).map(([key, currency]) => ({
      id: key,
      name: currency.names[this.locale] || currency.names['en-US'],
      symbol: currency.symbol,
      symbolPosition: currency.symbolPosition
    }));
  }

  /**
   * 解析用户输入的货币金额
   * @param {string} input - 用户输入
   * @param {string} currencyType - 货币类型
   * @returns {number|null} - 解析后的金额
   */
  parseInput(input, currencyType) {
    const currency = GAME_CURRENCIES[currencyType];
    if (!currency) return null;

    // 移除货币名称和空格
    let cleanInput = input;
    Object.values(currency.names).forEach(name => {
      cleanInput = cleanInput.replace(new RegExp(name, 'g'), '');
    });
    cleanInput = cleanInput.replace(/[¥₽$€£\s,]/g, '');

    // 处理简写
    return this.abbreviator.parseAbbreviated(cleanInput);
  }

  /**
   * 批量格式化多种货币
   * @param {Object} amounts - 货币金额映射 { COINS: 1000, POKECOINS: 500 }
   * @param {Object} options - 选项
   * @returns {Object} - 格式化后的映射
   */
  formatMultiple(amounts, options = {}) {
    const result = {};
    for (const [currencyType, amount] of Object.entries(amounts)) {
      result[currencyType] = this.format(amount, currencyType, options);
    }
    return result;
  }

  /**
   * 比较金额大小（考虑货币价值）
   * @param {number} amount1 - 金额1
   * @param {string} currencyType1 - 货币类型1
   * @param {number} amount2 - 金额2
   * @param {string} currencyType2 - 货币类型2
   * @returns {number} - 比较结果
   */
  compare(amount1, currencyType1, amount2, currencyType2) {
    // 获取兑换比率（相对于精币）
    const exchangeRates = {
      COINS: 0.01,        // 1 金币 = 0.01 精币
      POKECOINS: 1,       // 1 精币 = 1 精币
      STARDUST: 0.001,    // 1 星尘 = 0.001 精币
      CANDY: 0.1,         // 1 糖果 = 0.1 精币
      GOLDEN_RASPBERRY: 1,
      PREMIUM_PASS: 100
    };

    const rate1 = exchangeRates[currencyType1] || 1;
    const rate2 = exchangeRates[currencyType2] || 1;

    const value1 = amount1 * rate1;
    const value2 = amount2 * rate2;

    return value1 - value2;
  }
}

module.exports = { GameCurrencyLocalizer, GAME_CURRENCIES };