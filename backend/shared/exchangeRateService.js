'use strict';

/**
 * Exchange Rate Service
 * Provides exchange rate fetching, caching, and conversion
 * REQ-00051: Multi-currency Support
 */

const axios = require('axios');
const crypto = require('crypto');
const { query } = require('./db');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('exchange-rate-service');

// Exchange rate API sources
const SOURCES = {
  openexchangerates: {
    name: 'OpenExchangeRates',
    url: 'https://openexchangerates.org/api/latest.json',
    priority: 1,
    apiKeyEnv: 'OER_API_KEY'
  },
  fixer: {
    name: 'Fixer',
    url: 'https://data.fixer.io/api/latest',
    priority: 2,
    apiKeyEnv: 'FIXER_API_KEY'
  },
  exchangerate: {
    name: 'ExchangeRate-API',
    url: 'https://v6.exchangerate-api.com/v6',
    priority: 3,
    apiKeyEnv: 'EXCHANGE_RATE_API_KEY'
  }
};

// Cache settings
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_VALIDITY_MS = 60 * 60 * 1000; // 1 hour
const RATE_LOCK_DEFAULT_MINUTES = 15;

class ExchangeRateService {
  constructor() {
    this.cache = new Map();
    this.baseCurrency = 'USD';
  }

  /**
   * Get current exchange rate with caching
   */
  async getRate(fromCurrency, toCurrency) {
    const cacheKey = `${fromCurrency}_${toCurrency}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      metrics.increment('exchange_rate.cache_hit');
      return cached.rate;
    }

    metrics.increment('exchange_rate.cache_miss');

    // Try database first
    const dbRate = await this.getRateFromDB(fromCurrency, toCurrency);
    if (dbRate) {
      this.cache.set(cacheKey, { rate: dbRate, timestamp: Date.now() });
      return dbRate;
    }

    // Fetch from external API
    const fetchedRate = await this.fetchRate(fromCurrency, toCurrency);
    this.cache.set(cacheKey, { rate: fetchedRate, timestamp: Date.now() });
    return fetchedRate;
  }

  /**
   * Get rate from database
   */
  async getRateFromDB(fromCurrency, toCurrency) {
    try {
      const result = await query(`
        SELECT rate, valid_until
        FROM exchange_rates
        WHERE from_currency = $1
          AND to_currency = $2
          AND is_current = true
          AND valid_until > NOW()
        ORDER BY fetched_at DESC
        LIMIT 1
      `, [fromCurrency, toCurrency]);

      if (result.rows.length > 0) {
        return parseFloat(result.rows[0].rate);
      }
      return null;
    } catch (error) {
      logger.error('Failed to get rate from DB', { error: error.message, fromCurrency, toCurrency });
      return null;
    }
  }

  /**
   * Get multiple rates at once
   */
  async getRates(baseCurrency, targetCurrencies) {
    const rates = {};
    const uncached = [];

    // Check cache first
    for (const currency of targetCurrencies) {
      if (currency === baseCurrency) {
        rates[currency] = 1;
        continue;
      }

      const cacheKey = `${baseCurrency}_${currency}`;
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        rates[currency] = cached.rate;
      } else {
        uncached.push(currency);
      }
    }

    // Batch query DB for uncached
    if (uncached.length > 0) {
      const result = await query(`
        SELECT to_currency, rate
        FROM exchange_rates
        WHERE from_currency = $1
          AND to_currency = ANY($2)
          AND is_current = true
          AND valid_until > NOW()
      `, [baseCurrency, uncached]);

      for (const row of result.rows) {
        rates[row.to_currency] = parseFloat(row.rate);
        this.cache.set(`${baseCurrency}_${row.to_currency}`, {
          rate: parseFloat(row.rate),
          timestamp: Date.now()
        });
      }
    }

    return rates;
  }

  /**
   * Fetch rate from external API
   */
  async fetchRate(fromCurrency, toCurrency) {
    const sources = Object.entries(SOURCES).sort((a, b) => a[1].priority - b[1].priority);

    for (const [key, source] of sources) {
      const apiKey = process.env[source.apiKeyEnv];
      if (!apiKey && process.env.NODE_ENV === 'production') {
        continue; // Skip sources without API key in production
      }

      try {
        const rate = await this.fetchFromSource(key, fromCurrency, toCurrency, apiKey);
        if (rate) {
          await this.saveRate(fromCurrency, toCurrency, rate, key);
          metrics.increment('exchange_rate.fetch_success', { source: key });
          return rate;
        }
      } catch (error) {
        logger.warn('Failed to fetch from source', {
          source: key,
          error: error.message,
          fromCurrency,
          toCurrency
        });
        metrics.increment('exchange_rate.fetch_failure', { source: key });
      }
    }

    // Fallback: return 1 if same currency or throw error
    if (fromCurrency === toCurrency) {
      return 1;
    }

    // Use mock rate for development
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('Using mock exchange rate for development');
      return this.getMockRate(fromCurrency, toCurrency);
    }

    throw new Error(`Failed to fetch exchange rate for ${fromCurrency}/${toCurrency}`);
  }

  /**
   * Fetch from specific API source
   */
  async fetchFromSource(sourceKey, fromCurrency, toCurrency, apiKey) {
    switch (sourceKey) {
      case 'openexchangerates':
        return await this.fetchFromOER(fromCurrency, toCurrency, apiKey);
      case 'fixer':
        return await this.fetchFromFixer(fromCurrency, toCurrency, apiKey);
      case 'exchangerate':
        return await this.fetchFromExchangeRateAPI(fromCurrency, toCurrency, apiKey);
      default:
        throw new Error(`Unknown source: ${sourceKey}`);
    }
  }

  async fetchFromOER(from, to, apiKey) {
    const response = await axios.get('https://openexchangerates.org/api/latest.json', {
      params: { app_id: apiKey, base: from },
      timeout: 10000
    });

    if (response.data?.rates?.[to]) {
      return response.data.rates[to];
    }
    return null;
  }

  async fetchFromFixer(from, to, apiKey) {
    const response = await axios.get('https://data.fixer.io/api/latest', {
      params: { access_key: apiKey, base: from, symbols: to },
      timeout: 10000
    });

    if (response.data?.success && response.data?.rates?.[to]) {
      return response.data.rates[to];
    }
    return null;
  }

  async fetchFromExchangeRateAPI(from, to, apiKey) {
    const response = await axios.get(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/${from}`, {
      timeout: 10000
    });

    if (response.data?.result === 'success' && response.data?.conversion_rates?.[to]) {
      return response.data.conversion_rates[to];
    }
    return null;
  }

  /**
   * Mock rates for development
   */
  getMockRate(from, to) {
    const mockRates = {
      'USD_EUR': 0.92,
      'USD_GBP': 0.79,
      'USD_JPY': 155.0,
      'USD_CNY': 7.24,
      'USD_KRW': 1380.0,
      'USD_TWD': 32.5,
      'USD_HKD': 7.82,
      'USD_SGD': 1.35,
      'USD_AUD': 1.53,
      'USD_CAD': 1.37,
      'EUR_USD': 1.09,
      'GBP_USD': 1.27,
      'JPY_USD': 0.0065,
      'CNY_USD': 0.14
    };

    if (from === to) return 1;
    return mockRates[`${from}_${to}`] || 1;
  }

  /**
   * Save rate to database
   */
  async saveRate(fromCurrency, toCurrency, rate, source) {
    const validUntil = new Date(Date.now() + RATE_VALIDITY_MS);

    try {
      // Mark old rates as not current
      await query(`
        UPDATE exchange_rates
        SET is_current = false
        WHERE from_currency = $1 AND to_currency = $2
      `, [fromCurrency, toCurrency]);

      // Insert new rate
      await query(`
        INSERT INTO exchange_rates
        (from_currency, to_currency, rate, source, fetched_at, valid_until, is_current)
        VALUES ($1, $2, $3, $4, NOW(), $5, true)
      `, [fromCurrency, toCurrency, rate, source, validUntil]);

      logger.info('Exchange rate saved', { fromCurrency, toCurrency, rate, source, validUntil });
    } catch (error) {
      logger.error('Failed to save exchange rate', { error: error.message });
    }
  }

  /**
   * Convert amount between currencies
   */
  async convert(amount, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) {
      return { convertedAmount: amount, rate: 1 };
    }

    const rate = await this.getRate(fromCurrency, toCurrency);
    const convertedAmount = amount * rate;

    return { convertedAmount, rate };
  }

  /**
   * Lock exchange rate for payment
   */
  async lockRate(fromCurrency, toCurrency, durationMinutes = RATE_LOCK_DEFAULT_MINUTES) {
    const rate = await this.getRate(fromCurrency, toCurrency);
    const lockId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

    await query(`
      INSERT INTO rate_locks
      (lock_id, from_currency, to_currency, locked_rate, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [lockId, fromCurrency, toCurrency, rate, expiresAt]);

    metrics.increment('exchange_rate.lock_created', { from: fromCurrency, to: toCurrency });

    return {
      lockId,
      lockedRate: rate,
      expiresAt
    };
  }

  /**
   * Use locked rate for payment
   */
  async useLockedRate(lockId, referenceType, referenceId) {
    const result = await query(`
      UPDATE rate_locks
      SET used = true,
          reference_type = $2,
          reference_id = $3
      WHERE lock_id = $1
        AND used = false
        AND expires_at > NOW()
      RETURNING from_currency, to_currency, locked_rate
    `, [lockId, referenceType, referenceId]);

    if (result.rows.length === 0) {
      throw new Error('Rate lock not found, expired, or already used');
    }

    metrics.increment('exchange_rate.lock_used');

    return {
      fromCurrency: result.rows[0].from_currency,
      toCurrency: result.rows[0].to_currency,
      lockedRate: parseFloat(result.rows[0].locked_rate)
    };
  }

  /**
   * Get supported currencies
   */
  async getSupportedCurrencies() {
    const result = await query(`
      SELECT currency_code, currency_name, currency_symbol, decimal_places
      FROM supported_currencies
      WHERE is_active = true
      ORDER BY currency_code
    `);

    return result.rows.map(row => ({
      code: row.currency_code,
      name: row.currency_name,
      symbol: row.currency_symbol,
      decimalPlaces: row.decimal_places
    }));
  }

  /**
   * Refresh all rates from external APIs
   */
  async refreshAllRates() {
    const currencies = await this.getSupportedCurrencies();
    const currencyCodes = currencies.map(c => c.code);

    let successCount = 0;
    let failureCount = 0;

    for (const targetCurrency of currencyCodes) {
      if (targetCurrency === this.baseCurrency) continue;

      try {
        await this.fetchRate(this.baseCurrency, targetCurrency);
        successCount++;
      } catch (error) {
        failureCount++;
        logger.error('Failed to refresh rate', {
          from: this.baseCurrency,
          to: targetCurrency,
          error: error.message
        });
      }
    }

    logger.info('Exchange rate refresh completed', { successCount, failureCount });
    return { successCount, failureCount };
  }

  /**
   * Clean up expired rate locks
   */
  async cleanupExpiredLocks() {
    const result = await query(`
      DELETE FROM rate_locks
      WHERE expires_at < NOW()
      RETURNING id
    `);

    if (result.rows.length > 0) {
      logger.info('Cleaned up expired rate locks', { count: result.rows.length });
    }

    return result.rows.length;
  }
}

// Export singleton
module.exports = new ExchangeRateService();
