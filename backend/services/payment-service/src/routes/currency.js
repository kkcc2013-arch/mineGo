// backend/services/payment-service/src/routes/currency.js
// REQ-00051: 多货币支持 API

'use strict';

const express = require('express');
const router = express.Router();
const { exchangeRateService } = require('../../../shared/exchangeRateService');
const { currencyFormatter } = require('../../../shared/currencyFormatter');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');

const logger = createLogger('currency-api');

/**
 * 获取支持的货币列表
 * GET /api/v1/currencies
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        currency_code,
        currency_name,
        currency_symbol,
        decimal_places,
        supported_since
      FROM supported_currencies
      WHERE is_active = true
      ORDER BY currency_code
    `);
    
    res.json(successResp({
      currencies: result.rows.map(row => ({
        code: row.currency_code,
        name: row.currency_name,
        symbol: row.currency_symbol,
        decimalPlaces: row.decimal_places,
        supportedSince: row.supported_since
      }))
    }));
  } catch (error) {
    logger.error('Failed to get currencies', { error: error.message });
    next(error);
  }
});

/**
 * 获取汇率
 * GET /api/v1/currencies/rates?from=USD&to=JPY,EUR,GBP
 */
router.get('/rates', async (req, res, next) => {
  try {
    const { from = 'USD', to } = req.query;
    
    if (!to) {
      throw new AppError(6001, 'Target currencies required', 400);
    }
    
    const targetCurrencies = to.split(',').map(c => c.trim().toUpperCase());
    const rates = await exchangeRateService.getRates(from, targetCurrencies);
    
    res.json(successResp({
      base: from,
      rates,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to get exchange rates', { error: error.message });
    next(error);
  }
});

/**
 * 转换金额
 * POST /api/v1/currencies/convert
 * Body: { amount: 100, from: "USD", to: "JPY" }
 */
router.post('/convert', async (req, res, next) => {
  try {
    const { amount, from, to, lockRate = false } = req.body;
    
    if (amount === undefined || !from || !to) {
      throw new AppError(6002, 'amount, from, and to are required', 400);
    }
    
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount)) {
      throw new AppError(6003, 'Invalid amount', 400);
    }
    
    const rate = await exchangeRateService.getRate(from, to);
    const converted = numAmount * rate;
    
    let rateLock = null;
    if (lockRate) {
      rateLock = await exchangeRateService.lockRate(from, to);
    }
    
    metrics.increment('currency.conversion', { from, to });
    
    res.json(successResp({
      original: {
        amount: numAmount,
        currency: from,
        formatted: currencyFormatter.format(numAmount, from)
      },
      converted: {
        amount: converted,
        currency: to,
        formatted: currencyFormatter.format(converted, to)
      },
      rate,
      rateLock: rateLock ? {
        lockId: rateLock.lockId,
        expiresAt: rateLock.expiresAt
      } : null,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to convert currency', { error: error.message });
    next(error);
  }
});

/**
 * 获取商品多货币价格
 * GET /api/v1/currencies/prices/:productId?currency=JPY
 */
router.get('/prices/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { currency = 'USD' } = req.query;
    
    // 查询本地化价格
    const localPrice = await query(`
      SELECT price, original_price, updated_at
      FROM product_prices
      WHERE product_id = $1 AND currency_code = $2
    `, [productId, currency]);
    
    if (localPrice.rows.length > 0) {
      return res.json(successResp({
        productId,
        currency,
        price: parseFloat(localPrice.rows[0].price),
        originalPrice: localPrice.rows[0].original_price ? 
          parseFloat(localPrice.rows[0].original_price) : null,
        formatted: currencyFormatter.format(
          parseFloat(localPrice.rows[0].price), 
          currency
        ),
        source: 'localized'
      }));
    }
    
    // 本地化价格不存在，从 USD 转换
    const usdPrice = await query(`
      SELECT price
      FROM product_prices
      WHERE product_id = $1 AND currency_code = 'USD'
    `, [productId]);
    
    if (usdPrice.rows.length === 0) {
      throw new AppError(6004, 'Product not found', 404);
    }
    
    const rate = await exchangeRateService.getRate('USD', currency);
    const convertedPrice = parseFloat(usdPrice.rows[0].price) * rate;
    
    res.json(successResp({
      productId,
      currency,
      price: convertedPrice,
      rate,
      formatted: currencyFormatter.format(convertedPrice, currency),
      source: 'converted',
      basePrice: {
        amount: parseFloat(usdPrice.rows[0].price),
        currency: 'USD'
      }
    }));
  } catch (error) {
    logger.error('Failed to get product price', {
      productId: req.params.productId,
      error: error.message
    });
    next(error);
  }
});

/**
 * 锁定汇率（支付前调用）
 * POST /api/v1/currencies/lock-rate
 * Body: { from: "USD", to: "JPY", durationMinutes: 15 }
 */
router.post('/lock-rate', requireAuth, async (req, res, next) => {
  try {
    const { from, to, durationMinutes = 15 } = req.body;
    
    if (!from || !to) {
      throw new AppError(6005, 'from and to currencies required', 400);
    }
    
    const lock = await exchangeRateService.lockRate(from, to, durationMinutes);
    
    logger.info('Rate locked for payment', {
      userId: req.user?.sub,
      from,
      to,
      lockId: lock.lockId,
      rate: lock.lockedRate
    });
    
    res.json(successResp({
      lockId: lock.lockId,
      rate: lock.lockedRate,
      expiresAt: lock.expiresAt
    }));
  } catch (error) {
    logger.error('Failed to lock rate', { error: error.message });
    next(error);
  }
});

/**
 * 设置用户货币偏好
 * POST /api/v1/currencies/preference
 * Body: { currency: "JPY", autoDetect: false }
 */
router.post('/preference', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    const { currency, autoDetect = true } = req.body;
    
    if (!userId) {
      throw new AppError(1002, 'Unauthorized', 401);
    }
    
    if (!currency) {
      throw new AppError(6006, 'Currency required', 400);
    }
    
    // 验证货币代码
    const currencyExists = await query(`
      SELECT 1 FROM supported_currencies 
      WHERE currency_code = $1 AND is_active = true
    `, [currency]);
    
    if (currencyExists.rows.length === 0) {
      throw new AppError(6007, 'Unsupported currency', 400);
    }
    
    await query(`
      UPDATE users
      SET preferred_currency = $1,
          currency_auto_detect = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [currency, autoDetect, userId]);
    
    res.json(successResp({
      currency,
      autoDetect
    }));
  } catch (error) {
    logger.error('Failed to set currency preference', { error: error.message });
    next(error);
  }
});

/**
 * 获取用户货币偏好
 * GET /api/v1/currencies/preference
 */
router.get('/preference', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    
    if (!userId) {
      throw new AppError(1002, 'Unauthorized', 401);
    }
    
    const result = await query(`
      SELECT preferred_currency, currency_auto_detect
      FROM users
      WHERE id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      throw new AppError(1003, 'User not found', 404);
    }
    
    res.json(successResp({
      currency: result.rows[0].preferred_currency || 'USD',
      autoDetect: result.rows[0].currency_auto_detect ?? true
    }));
  } catch (error) {
    logger.error('Failed to get currency preference', { error: error.message });
    next(error);
  }
});

/**
 * 根据国家检测货币
 * GET /api/v1/currencies/detect?country=JP
 */
router.get('/detect', async (req, res, next) => {
  try {
    const { country } = req.query;
    
    if (!country) {
      throw new AppError(6008, 'Country code required', 400);
    }
    
    const currency = currencyFormatter.detectCurrency(country);
    
    res.json(successResp({
      country: country.toUpperCase(),
      currency,
      formatted: currencyFormatter.format(0, currency).replace(/0/, '')
    }));
  } catch (error) {
    logger.error('Failed to detect currency', { error: error.message });
    next(error);
  }
});

/**
 * 管理员：刷新汇率
 * POST /api/v1/currencies/admin/refresh-rates
 */
router.post('/admin/refresh-rates', requireAuth, async (req, res, next) => {
  try {
    if (!req.user?.isAdmin) {
      throw new AppError(1004, 'Admin access required', 403);
    }
    
    const result = await exchangeRateService.refreshAllRates();
    
    res.json(successResp({
      refreshed: result.successCount,
      failed: result.failureCount
    }));
  } catch (error) {
    logger.error('Failed to refresh rates', { error: error.message });
    next(error);
  }
});

module.exports = router;
