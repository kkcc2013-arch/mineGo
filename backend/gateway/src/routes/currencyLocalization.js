/**
 * Currency Localization API Routes
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 * 
 * @module gateway/src/routes/currencyLocalization
 */

'use strict';

const express = require('express');
const router = express.Router();
const {
  GameCurrencyLocalizer,
  GAME_CURRENCIES,
  createMagnitudeAbbreviator,
  RegionalTaxCalculator,
  RegionalPricingService
} = require('../../../shared/currencyLocalizer');

const pricingService = new RegionalPricingService();

/**
 * 成功响应格式
 */
function successResp(data) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString()
  };
}

/**
 * 错误响应格式
 */
function errorResp(code, message) {
  return {
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString()
  };
}

/**
 * GET /api/v1/currency/format
 * 格式化游戏货币显示
 * 
 * Query params:
 * - amount: 金额（必填）
 * - currency: 货币类型（默认 COINS）
 * - locale: 语言区域（默认 zh-CN）
 */
router.get('/format', async (req, res, next) => {
  try {
    const { amount, currency = 'COINS', locale = 'zh-CN' } = req.query;

    if (!amount) {
      return res.status(400).json(errorResp('PARAM_ERROR', 'Amount is required'));
    }

    const localizer = new GameCurrencyLocalizer(locale);
    const formatted = localizer.format(parseInt(amount), currency, { useAbbreviation: true });
    const fullDisplay = localizer.format(parseInt(amount), currency, { useAbbreviation: false });

    res.json(successResp({
      amount: parseInt(amount),
      currency,
      locale,
      formatted,
      fullDisplay
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/abbreviate
 * 数量级简写测试
 * 
 * Query params:
 * - number: 数字（必填）
 * - locale: 语言区域（默认 zh-CN）
 */
router.get('/abbreviate', async (req, res, next) => {
  try {
    const { number, locale = 'zh-CN' } = req.query;

    if (!number) {
      return res.status(400).json(errorResp('PARAM_ERROR', 'Number is required'));
    }

    const abbreviator = createMagnitudeAbbreviator(locale);
    const abbreviated = abbreviator.abbreviate(parseInt(number));

    res.json(successResp({
      original: parseInt(number),
      abbreviated,
      locale,
      examples: abbreviator.getExamples(),
      rules: abbreviator.getRules()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/pricing/:productId
 * 获取产品区域定价
 * 
 * Path params:
 * - productId: 产品ID
 * 
 * Query params:
 * - country: 国家代码（默认 US）
 * - currency: 货币代码（默认 USD）
 * - state: 州/省代码（可选）
 */
router.get('/pricing/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { country = 'US', currency = 'USD', state } = req.query;

    const pricing = await pricingService.getProductPrice(productId, country, currency);

    if (!pricing) {
      return res.status(404).json(errorResp('PRODUCT_NOT_FOUND', `Product ${productId} not found`));
    }

    const taxCalc = new RegionalTaxCalculator(country, req.headers['accept-language'] || 'en-US', state);
    const display = taxCalc.formatPriceDisplay(pricing.price, (p) =>
      new Intl.NumberFormat(req.headers['accept-language'] || 'en-US', {
        style: 'currency',
        currency: currency
      }).format(p)
    );

    res.json(successResp({
      productId,
      ...pricing,
      display,
      showBreakdown: taxCalc.shouldShowBreakdown(),
      taxInfo: taxCalc.getTaxInfo()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/info
 * 获取所有游戏货币信息
 * 
 * Query params:
 * - locale: 语言区域（默认 zh-CN）
 */
router.get('/info', async (req, res, next) => {
  try {
    const { locale = 'zh-CN' } = req.query;
    const localizer = new GameCurrencyLocalizer(locale);
    const currencies = localizer.getAllCurrenciesInfo();

    res.json(successResp({
      locale,
      currencies,
      supportedCurrencies: Object.keys(GAME_CURRENCIES)
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/packages/recommend
 * 获取货币包推荐
 * 
 * Query params:
 * - country: 国家代码
 * - currency: 货币代码
 */
router.get('/packages/recommend', async (req, res, next) => {
  try {
    const userId = req.user?.sub || 'anonymous';
    const { country = 'US', currency = 'USD' } = req.query;

    const recommendations = await pricingService.getRecommendedPackages(
      userId,
      country,
      currency
    );

    res.json(successResp(recommendations));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/packages
 * 获取货币包列表
 * 
 * Query params:
 * - country: 国家代码
 * - currency: 货币代码
 */
router.get('/packages', async (req, res, next) => {
  try {
    const { country = 'US', currency = 'USD' } = req.query;

    const packages = await pricingService.getPopularPackages(country);

    // 计算每个包的本地价格
    const packagesWithPricing = await Promise.all(
      packages.map(async (pkg) => {
        const pricing = await pricingService.getProductPrice(pkg.id, country, currency);
        return {
          ...pkg,
          pricing
        };
      })
    );

    res.json(successResp({
      country,
      currency,
      packages: packagesWithPricing
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/tax/:country
 * 获取国家税率信息
 * 
 * Path params:
 * - country: 国家代码
 * 
 * Query params:
 * - state: 州/省代码（可选）
 * - locale: 语言区域
 */
router.get('/tax/:country', async (req, res, next) => {
  try {
    const { country } = req.params;
    const { state, locale = 'en-US' } = req.query;

    const taxCalc = new RegionalTaxCalculator(country, locale, state);
    const taxInfo = taxCalc.getTaxInfo();

    // 示例价格计算
    const exampleBasePrice = 9.99;
    const examplePricing = taxCalc.calculateTaxInclusivePrice(exampleBasePrice);

    res.json(successResp({
      ...taxInfo,
      example: {
        basePrice: exampleBasePrice,
        ...examplePricing
      }
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currency/supported
 * 获取支持的货币和国家列表
 */
router.get('/supported', async (req, res, next) => {
  try {
    res.json(successResp({
      currencies: pricingService.getSupportedCurrencies(),
      countries: pricingService.getSupportedCountries()
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;