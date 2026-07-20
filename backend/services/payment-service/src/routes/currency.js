'use strict';

/**
 * Currency Routes for Payment Service
 * REQ-00051: Multi-currency Support
 */

const express = require('express');
const router = express.Router();
const exchangeRateService = require('../../../../shared/exchangeRateService');
const currencyFormatter = require('../../../../shared/currencyFormatter');
const { query } = require('../../../../shared/db');
const { createLogger } = require('../../../../shared/logger');
const { requireAuth, requireAdmin, successResp, AppError } = require('../../../../shared/auth');
const metrics = require('../../../../shared/metrics');

const logger = createLogger('currency-routes');

/**
 * GET /api/v1/currencies
 * Get list of supported currencies
 */
router.get('/', async (req, res, next) => {
  try {
    const currencies = await exchangeRateService.getSupportedCurrencies();

    res.json(successResp({
      currencies,
      count: currencies.length
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currencies/rates
 * Get exchange rates
 * Query: from=USD&to=EUR,GBP,JPY
 */
router.get('/rates', async (req, res, next) => {
  try {
    const { from = 'USD', to } = req.query;

    if (!to) {
      throw new AppError(400, 'Target currencies required (use comma-separated list)');
    }

    const targetCurrencies = to.split(',').map(c => c.trim().toUpperCase());
    const rates = await exchangeRateService.getRates(from, targetCurrencies);

    res.json(successResp({
      base: from,
      rates,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/convert
 * Convert amount between currencies
 * Body: { amount, from, to, lockRate?: boolean }
 */
router.post('/convert', async (req, res, next) => {
  try {
    const { amount, from, to, lockRate = false } = req.body;

    if (!amount || !from || !to) {
      throw new AppError(400, 'amount, from, and to are required');
    }

    const { convertedAmount, rate } = await exchangeRateService.convert(amount, from, to);

    let rateLock = null;
    if (lockRate) {
      rateLock = await exchangeRateService.lockRate(from, to);
    }

    // Log conversion
    metrics.increment('currency.conversion', { from, to });

    res.json(successResp({
      original: {
        amount,
        currency: from,
        formatted: currencyFormatter.format(amount, from)
      },
      converted: {
        amount: convertedAmount,
        currency: to,
        formatted: currencyFormatter.format(convertedAmount, to)
      },
      rate,
      rateLock: rateLock ? {
        lockId: rateLock.lockId,
        expiresAt: rateLock.expiresAt
      } : null,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/currencies/prices/:productId
 * Get product price in specified currency
 * Query: currency=JPY
 */
router.get('/prices/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { currency = 'USD' } = req.query;

    // Check for localized price
    const localPrice = await query(`
      SELECT price, original_price, updated_at
      FROM product_prices
      WHERE product_id = $1 AND currency_code = $2
    `, [productId, currency]);

    if (localPrice.rows.length > 0) {
      const price = parseFloat(localPrice.rows[0].price);
      return res.json(successResp({
        productId,
        currency,
        price,
        originalPrice: localPrice.rows[0].original_price ?
          parseFloat(localPrice.rows[0].original_price) : null,
        formatted: currencyFormatter.format(price, currency),
        source: 'localized'
      }));
    }

    // Fallback: convert from USD
    const usdPrice = await query(`
      SELECT price
      FROM product_prices
      WHERE product_id = $1 AND currency_code = 'USD'
    `, [productId]);

    if (usdPrice.rows.length === 0) {
      throw new AppError(404, 'Product not found');
    }

    const basePrice = parseFloat(usdPrice.rows[0].price);
    const { convertedAmount: price, rate } = await exchangeRateService.convert(basePrice, 'USD', currency);

    res.json(successResp({
      productId,
      currency,
      price,
      rate,
      formatted: currencyFormatter.format(price, currency),
      source: 'converted',
      basePrice: {
        amount: basePrice,
        currency: 'USD'
      }
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/lock-rate
 * Lock exchange rate for payment
 * Body: { from, to, durationMinutes }
 */
router.post('/lock-rate', requireAuth, async (req, res, next) => {
  try {
    const { from, to, durationMinutes = 15 } = req.body;

    if (!from || !to) {
      throw new AppError(400, 'from and to currencies required');
    }

    const lock = await exchangeRateService.lockRate(from, to, durationMinutes);

    logger.info('Rate locked', {
      userId: req.user.sub,
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
    next(error);
  }
});

/**
 * POST /api/v1/currencies/preference
 * Set user currency preference
 * Body: { currency, autoDetect }
 */
router.post('/preference', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { currency, autoDetect = true } = req.body;

    if (!currency) {
      throw new AppError(400, 'currency is required');
    }

    // Validate currency
    if (!currencyFormatter.isSupported(currency)) {
      throw new AppError(400, 'Unsupported currency');
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
    next(error);
  }
});

/**
 * GET /api/v1/currencies/preference
 * Get user currency preference
 */
router.get('/preference', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const result = await query(`
      SELECT preferred_currency, currency_auto_detect
      FROM users
      WHERE id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      throw new AppError(404, 'User not found');
    }

    res.json(successResp({
      currency: result.rows[0].preferred_currency || 'USD',
      autoDetect: result.rows[0].currency_auto_detect ?? true
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/detect
 * Detect currency by country
 * Body: { country }
 */
router.post('/detect', async (req, res, next) => {
  try {
    const { country } = req.body;

    if (!country) {
      throw new AppError(400, 'country is required');
    }

    const detectedCurrency = currencyFormatter.detectCurrency(country);

    res.json(successResp({
      country,
      currency: detectedCurrency
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/admin/refresh-rates
 * Admin: Refresh all exchange rates
 */
router.post('/admin/refresh-rates', requireAdmin, async (req, res, next) => {
  try {
    const result = await exchangeRateService.refreshAllRates();

    logger.info('Exchange rates refreshed by admin', {
      userId: req.user.sub,
      result
    });

    res.json(successResp({
      refreshed: result.successCount,
      failed: result.failureCount
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/admin/cleanup-locks
 * Admin: Clean up expired rate locks
 */
router.post('/admin/cleanup-locks', requireAdmin, async (req, res, next) => {
  try {
    const count = await exchangeRateService.cleanupExpiredLocks();

    res.json(successResp({
      cleaned: count
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/currencies/admin/set-price
 * Admin: Set product price in currency
 * Body: { productId, currency, price, originalPrice }
 */
router.post('/admin/set-price', requireAdmin, async (req, res, next) => {
  try {
    const { productId, currency, price, originalPrice } = req.body;

    if (!productId || !currency || price === undefined) {
      throw new AppError(400, 'productId, currency, and price are required');
    }

    await query(`
      INSERT INTO product_prices (product_id, currency_code, price, original_price, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (product_id, currency_code)
      DO UPDATE SET
        price = $3,
        original_price = $4,
        updated_at = NOW()
    `, [productId, currency, price, originalPrice || null]);

    logger.info('Product price updated', {
      userId: req.user.sub,
      productId,
      currency,
      price
    });

    res.json(successResp({
      productId,
      currency,
      price,
      originalPrice
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
