/**
 * Regional Pricing Service - 区域定价策略服务
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 * 
 * 功能：
 * - 获取产品区域定价
 * - PPP 调整定价
 * - 汇率转换定价
 * - 心理价位四舍五入
 * 
 * @module backend/shared/currencyLocalizer/RegionalPricingService
 * @version 1.0.0
 */

'use strict';

const logger = require('../logger');

/**
 * PPP 调整系数（相对于美国）
 * 数据来源：World Bank PPP conversion factors
 */
const PPP_ADJUSTMENT_FACTORS = {
  'US': 1.00,
  'JP': 0.85,
  'GB': 0.92,
  'DE': 0.88,
  'FR': 0.87,
  'ES': 0.72,
  'IT': 0.68,
  'CN': 0.42,
  'KR': 0.68,
  'BR': 0.35,
  'IN': 0.21,
  'RU': 0.28,
  'AU': 0.92,
  'SG': 0.95,
  'TW': 0.58,
  'HK': 0.75,
  'MX': 0.42,
  'CA': 0.85,
  'TH': 0.28,
  'VN': 0.21,
  'ID': 0.22,
  'PH': 0.25,
  'MY': 0.38
};

/**
 * 心理价位配置（不同货币）
 */
const PSYCHOLOGICAL_LEVELS = {
  'USD': [0.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'EUR': [0.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'JPY': [120, 500, 1000, 1500, 2000, 3000, 5000, 10000],
  'CNY': [6, 30, 68, 98, 128, 198, 328, 648],
  'KRW': [1100, 5500, 11000, 33000, 55000, 110000],
  'GBP': [0.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'TWD': [30, 150, 300, 450, 600, 900, 1500, 3000],
  'AUD': [1.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'CAD': [1.29, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'SGD': [1.99, 4.99, 9.99, 14.99, 19.99, 24.99, 49.99, 99.99],
  'HKD': [8, 38, 78, 118, 158, 238, 398, 788],
  'BRL': [5, 20, 40, 60, 80, 120, 200, 400],
  'INR': [89, 449, 899, 1349, 1799, 2699, 4499, 8999],
  'RUB': [119, 599, 1199, 1799, 2399, 3599, 5999, 11999],
  'MXN': [25, 99, 199, 299, 399, 599, 999, 1999],
  'THB': [39, 159, 319, 479, 639, 959, 1599, 3199],
  'VND': [22000, 110000, 220000, 660000, 1100000, 2200000],
  'IDR': [15900, 79000, 159000, 477000, 790000, 1590000],
  'PHP': [59, 299, 599, 899, 1199, 1799, 2999, 5999],
  'MYR': [9, 39, 79, 119, 159, 239, 399, 799]
};

/**
 * 区域定价服务
 */
class RegionalPricingService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 300000; // 5分钟
  }

  /**
   * 获取产品区域定价
   * @param {string} productId - 产品ID
   * @param {string} countryCode - 国家代码
   * @param {string} currencyCode - 货币代码
   * @returns {Promise<Object>} - 定价信息
   */
  async getProductPrice(productId, countryCode, currencyCode) {
    const cacheKey = `${productId}:${countryCode}:${currencyCode}`;

    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    // 模拟数据库查询（实际应查询数据库）
    const pricing = await this.resolvePrice(productId, countryCode, currencyCode);

    // 缓存结果
    this.cache.set(cacheKey, {
      data: pricing,
      timestamp: Date.now()
    });

    return pricing;
  }

  /**
   * 解析价格
   * @param {string} productId - 产品ID
   * @param {string} countryCode - 国家代码
   * @param {string} currencyCode - 货币代码
   * @returns {Promise<Object>} - 定价信息
   */
  async resolvePrice(productId, countryCode, currencyCode) {
    // 1. 获取基础价格（美元）
    const basePrice = this.getBasePrice(productId);
    if (!basePrice) {
      return null;
    }

    // 2. 检查是否有 PPP 调整
    const pppFactor = PPP_ADJUSTMENT_FACTORS[countryCode] || 1.0;
    const adjustedPrice = basePrice * pppFactor;

    // 3. 获取汇率
    const exchangeRate = this.getExchangeRate(currencyCode);

    // 4. 转换为本地货币
    const localPrice = adjustedPrice * exchangeRate;

    // 5. 四舍五入到心理价位
    const psychologicalPrice = this.roundToPsychologicalPrice(localPrice, currencyCode);

    return {
      productId,
      basePriceUSD: basePrice,
      pppFactor,
      exchangeRate,
      rawLocalPrice: Math.round(localPrice * 100) / 100,
      price: psychologicalPrice,
      currency: currencyCode,
      country: countryCode,
      strategy: pppFactor < 0.8 ? 'PPP' : 'exchange',
      source: 'calculated'
    };
  }

  /**
   * 获取基础价格（美元）
   * @param {string} productId - 产品ID
   * @returns {number} - 基础价格
   */
  getBasePrice(productId) {
    // 产品定价表（实际应从数据库获取）
    const productPrices = {
      'coins_100': 0.99,
      'coins_550': 4.99,
      'coins_1200': 9.99,
      'coins_2500': 19.99,
      'coins_5200': 39.99,
      'coins_14500': 99.99,
      'pokecoins_100': 0.99,
      'pokecoins_550': 4.99,
      'pokecoins_1200': 9.99,
      'pokecoins_2500': 19.99,
      'pokecoins_5200': 39.99,
      'pokecoins_14500': 99.99,
      'premium_pass_1': 4.99,
      'premium_pass_3': 12.99,
      'premium_pass_10': 39.99
    };

    return productPrices[productId] || null;
  }

  /**
   * 获取汇率
   * @param {string} currencyCode - 货币代码
   * @returns {number} - 汇率
   */
  getExchangeRate(currencyCode) {
    // 模拟汇率（实际应调用汇率服务）
    const rates = {
      'USD': 1.0,
      'EUR': 0.92,
      'JPY': 149.5,
      'CNY': 7.24,
      'KRW': 1330.0,
      'GBP': 0.79,
      'TWD': 31.8,
      'AUD': 1.53,
      'CAD': 1.36,
      'SGD': 1.34,
      'HKD': 7.82,
      'BRL': 4.97,
      'INR': 83.12,
      'RUB': 88.5,
      'MXN': 17.15,
      'THB': 35.5,
      'VND': 24500,
      'IDR': 15900,
      'PHP': 56.5,
      'MYR': 4.72
    };

    return rates[currencyCode] || 1.0;
  }

  /**
   * 四舍五入到心理价位
   * @param {number} price - 价格
   * @param {string} currencyCode - 货币代码
   * @returns {number} - 心理价位
   */
  roundToPsychologicalPrice(price, currencyCode) {
    const levels = PSYCHOLOGICAL_LEVELS[currencyCode] || PSYCHOLOGICAL_LEVELS['USD'];

    // 找到最接近的心理价位（向下取整）
    for (let i = levels.length - 1; i >= 0; i--) {
      if (price >= levels[i] * 0.95) {
        return levels[i];
      }
    }

    return levels[0];
  }

  /**
   * 获取货币包推荐
   * @param {string} userId - 用户ID
   * @param {string} countryCode - 国家代码
   * @param {string} currencyCode - 货币代码
   * @returns {Promise<Object>} - 推荐信息
   */
  async getRecommendedPackages(userId, countryCode, currencyCode) {
    // 获取热门包列表
    const popularPackages = await this.getPopularPackages(countryCode);

    // 计算性价比
    const packagesWithPricing = await Promise.all(
      popularPackages.map(async (pkg) => {
        const pricing = await this.getProductPrice(pkg.id, countryCode, currencyCode);
        const coinsPerDollar = pkg.coins / (pricing?.price || 1);
        return {
          ...pkg,
          pricing,
          coinsPerDollar
        };
      })
    );

    // 找到最佳性价比
    const bestValue = packagesWithPricing.reduce((best, pkg) =>
      pkg.coinsPerDollar > (best?.coinsPerDollar || 0) ? pkg : best,
      null
    );

    // 找到最畅销
    const mostPopular = packagesWithPricing.find(pkg => pkg.id === 'coins_1200');

    return {
      recommended: mostPopular || packagesWithPricing[0],
      bestValue,
      popular: packagesWithPricing.slice(0, 3),
      all: packagesWithPricing
    };
  }

  /**
   * 获取热门包列表
   * @param {string} countryCode - 国家代码
   * @returns {Promise<Array>} - 包列表
   */
  async getPopularPackages(countryCode) {
    // 模拟热门包数据
    return [
      { id: 'coins_100', coins: 100, bonus: 0 },
      { id: 'coins_550', coins: 550, bonus: 50 },
      { id: 'coins_1200', coins: 1200, bonus: 150 },
      { id: 'coins_2500', coins: 2500, bonus: 400 },
      { id: 'coins_5200', coins: 5200, bonus: 900 },
      { id: 'coins_14500', coins: 14500, bonus: 3000 }
    ];
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear();
    logger.info('RegionalPricingService cache cleared');
  }

  /**
   * 获取支持的货币列表
   * @returns {Array<string>} - 货币代码列表
   */
  getSupportedCurrencies() {
    return Object.keys(PSYCHOLOGICAL_LEVELS);
  }

  /**
   * 获取支持的国家列表
   * @returns {Array<string>} - 国家代码列表
   */
  getSupportedCountries() {
    return Object.keys(PPP_ADJUSTMENT_FACTORS);
  }
}

module.exports = { RegionalPricingService, PPP_ADJUSTMENT_FACTORS, PSYCHOLOGICAL_LEVELS };