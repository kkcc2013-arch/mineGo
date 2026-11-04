'use strict';

/**
 * Exchange Rate Service
 * Provides exchange rate fetching, caching, and conversion
 * REQ-00051: Multi-currency Support
 */

const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const currencyFormatter = require('./currencyFormatter');
const { createLogger } = require('./logger');
const metrics = require('./currencyMetrics');

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
  constructor({database = db, http = axios, now = Date.now, apiKeys = {}, providerUrls = {}} = {}) {
    this.db = database;
    this.http = http;
    this.now = now;
    this.apiKeys = apiKeys;
    this.providerUrls = {...Object.fromEntries(Object.entries(SOURCES).map(([key,value])=>[key,value.url])),...providerUrls};
    this.cache = new Map();
    this.baseCurrency = 'USD';
  }

  /**
   * Get current exchange rate with caching
   */
  async getRate(fromCurrency, toCurrency) {
    this.validatePair(fromCurrency, toCurrency);
    if (fromCurrency === toCurrency) return 1;
    const cacheKey = `${fromCurrency}_${toCurrency}`;
    const cached = this.cache.get(cacheKey);

    if (cached && this.now() < cached.validUntil && this.now() - cached.timestamp < CACHE_TTL_MS) {
      metrics.cacheHit.inc();
      return cached.rate;
    }

    metrics.cacheMiss.inc();

    // Try database first
    const quote = await this.getQuoteFromDB(fromCurrency, toCurrency);
    if (quote) {
      this.cache.set(cacheKey, {...quote, timestamp: this.now()});
      return quote.rate;
    }

    // Fetch from external API
    const fetchedRate = await this.fetchRate(fromCurrency, toCurrency);
    return fetchedRate;
  }

  /**
   * Get rate from database
   */
  async getRateFromDB(fromCurrency, toCurrency) {
    return (await this.getQuoteFromDB(fromCurrency, toCurrency))?.rate ?? null;
  }

  validatePair(from, to) {
    if (!currencyFormatter.isSupported(from) || !currencyFormatter.isSupported(to)) throw new Error('Unsupported currency');
  }

  validateRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0 || value >= 1e10) throw new Error('Invalid exchange rate');
    return value;
  }

  async getQuoteFromDB(fromCurrency, toCurrency) {
      this.validatePair(fromCurrency, toCurrency);
      const result = await this.db.query(`
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
        const validUntil = new Date(result.rows[0].valid_until).getTime();
        if (!Number.isFinite(validUntil) || validUntil <= this.now()) return null;
        return {rate: this.validateRate(result.rows[0].rate),rateExact:result.rows[0].rate, validUntil};
      }
      return null;
  }

  /**
   * Get multiple rates at once
   */
  async getRates(baseCurrency, targetCurrencies) {
    if (!Array.isArray(targetCurrencies) || targetCurrencies.length > 20) throw new Error('Invalid target currencies');
    const rates = {};
    for (const currency of new Set(targetCurrencies)) rates[currency] = await this.getRate(baseCurrency, currency);
    return rates;
  }

  /**
   * Fetch rate from external API
   */
  async fetchRate(fromCurrency, toCurrency) {
    this.validatePair(fromCurrency, toCurrency);
    if (fromCurrency === toCurrency) return 1;
    const sources = Object.entries(SOURCES).sort((a, b) => a[1].priority - b[1].priority);

    for (const [key, source] of sources) {
      const apiKey = this.apiKeys[source.apiKeyEnv] ?? process.env[source.apiKeyEnv];
      if (!apiKey) continue;

      try {
        const rate = await this.fetchFromSource(key, fromCurrency, toCurrency, apiKey);
        if (rate != null) {
          this.validateRate(rate);
          const saved = await this.saveRate(fromCurrency, toCurrency, rate, key);
          metrics.fetchSuccess.inc({source:key});
          return saved.rate;
        }
      } catch (error) {
        logger.warn('Failed to fetch from source', {
          source: key,
          fromCurrency,
          toCurrency
        });
        metrics.fetchFailure.inc({source:key});
      }
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
    const response = await this.http.get(this.providerUrls.openexchangerates, {
      params: { app_id: apiKey },
      timeout: 10000
    });

    if (response.data?.error) throw new Error('Provider quote unavailable');
    return this.tableQuote(response.data?.base, response.data?.rates, from, to);
  }

  async fetchFromFixer(from, to, apiKey) {
    const response = await this.http.get(this.providerUrls.fixer, {
      params: { access_key: apiKey, symbols: `${from},${to}` },
      timeout: 10000
    });

    if (response.data?.success !== true) throw new Error('Provider quote unavailable');
    return this.tableQuote(response.data.base,response.data.rates,from,to);
  }

  async fetchFromExchangeRateAPI(from, to, apiKey) {
    const response = await this.http.get(`${this.providerUrls.exchangerate}/${encodeURIComponent(apiKey)}/latest/${from}`, {
      timeout: 10000
    });

    if (response.data?.result !== 'success') throw new Error('Provider quote unavailable');
    return this.tableQuote(response.data.base_code,response.data.conversion_rates,from,to);
  }

  tableQuote(base, rates, from, to) {
    this.validatePair(from,to);
    if (!currencyFormatter.isSupported(base) || !rates || typeof rates!=='object' || Array.isArray(rates)) throw new Error('Invalid provider response');
    const fromRate = from===base ? 1 : this.validateRate(Object.hasOwn(rates,from) ? rates[from] : undefined);
    const toRate = to===base ? 1 : this.validateRate(Object.hasOwn(rates,to) ? rates[to] : undefined);
    return this.validateRate(toRate/fromRate);
  }

  /**
   * Save rate to database
   */
  async saveRate(fromCurrency, toCurrency, rate, source) {
    this.validatePair(fromCurrency, toCurrency);
    if (fromCurrency === toCurrency) throw new Error('Same-currency quotes are unnecessary');
    this.validateRate(rate);
    if (typeof source !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(source)) throw new Error('Invalid rate source');
    const validUntil = new Date(this.now() + RATE_VALIDITY_MS);
    const saved = await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':currency:'||$1||':'||$2,0))", [fromCurrency, toCurrency]);
      await client.query('UPDATE exchange_rates SET is_current=false WHERE from_currency=$1 AND to_currency=$2', [fromCurrency, toCurrency]);
      const result = await client.query(`INSERT INTO exchange_rates(from_currency,to_currency,rate,source,fetched_at,valid_until,is_current)
        VALUES($1,$2,$3,$4,NOW(),$5,true) RETURNING rate,valid_until`, [fromCurrency,toCurrency,rate,source,validUntil]);
      const stored = result.rows[0];
      await client.query(`INSERT INTO exchange_rate_history(from_currency,to_currency,rate,recorded_at,open_rate,close_rate,high_rate,low_rate)
        VALUES($1,$2,$3,(NOW() AT TIME ZONE 'UTC')::date,$3,$3,$3,$3)
        ON CONFLICT(from_currency,to_currency,recorded_at) DO UPDATE SET rate=EXCLUDED.rate,close_rate=EXCLUDED.rate,
        high_rate=GREATEST(exchange_rate_history.high_rate,EXCLUDED.rate),low_rate=LEAST(exchange_rate_history.low_rate,EXCLUDED.rate)`,
      [fromCurrency,toCurrency,stored.rate]);
      return {rate:this.validateRate(stored.rate),rateExact:stored.rate,validUntil:new Date(stored.valid_until).getTime()};
    });
    this.cache.set(`${fromCurrency}_${toCurrency}`, {...saved,timestamp:this.now()});
    return saved;
  }

  /**
   * Convert amount between currencies
   */
  async convert(amount, fromCurrency, toCurrency, {lockId,userId} = {}) {
    this.validatePair(fromCurrency,toCurrency);
    if (!['number','string'].includes(typeof amount) || !/^\d{1,16}(?:\.\d{1,10})?$/.test(String(amount)) || !Number.isFinite(Number(amount))) throw new Error('Invalid conversion amount');
    let rateExact;
    if (lockId) {
      this.validateOwner(userId);
      const lock = await this.db.query(`SELECT locked_rate FROM rate_locks WHERE lock_id=$1 AND user_id=$2
        AND from_currency=$3 AND to_currency=$4 AND used=false AND expires_at>NOW()`,[lockId,userId,fromCurrency,toCurrency]);
      if (!lock.rows.length) throw new Error('Rate lock not found, expired, or already used');
      rateExact=lock.rows[0].locked_rate;
    } else {
      await this.getRate(fromCurrency,toCurrency);
      rateExact=fromCurrency===toCurrency ? '1' : this.cache.get(`${fromCurrency}_${toCurrency}`)?.rateExact;
    }
    const rate=this.validateRate(rateExact);
    if (rateExact == null) throw new Error('Durable quote is unavailable');
    const places = currencyFormatter.getConfig(toCurrency).decimalPlaces;
    const result = await this.db.query('SELECT ROUND($1::numeric*$2::numeric,$3) AS amount', [String(amount),rateExact,places]);
    const amountExact = result.rows[0].amount;
    const convertedAmount = Number(amountExact);
    if (!Number.isFinite(convertedAmount) || convertedAmount*10**places > Number.MAX_SAFE_INTEGER) throw new Error('Conversion exceeds safe display range');
    await this.db.query(`INSERT INTO currency_conversion_logs(from_currency,to_currency,from_amount,to_amount,rate,rate_source,conversion_type,rate_lock_id,user_id,input_amount)
      VALUES($1,$2,$3,$4,$5,'stored','display',$6,$7,$8)`,[fromCurrency,toCurrency,String(amount),amountExact,rateExact,lockId??null,userId??null,String(amount)]);
    metrics.conversion.inc({from:fromCurrency,to:toCurrency});
    return {convertedAmount,amountExact,rate};
  }

  /**
   * Lock exchange rate for payment
   */
  async lockRate(fromCurrency, toCurrency, durationMinutes = RATE_LOCK_DEFAULT_MINUTES, userId) {
    this.validateOwner(userId);
    if (!Number.isInteger(durationMinutes) || durationMinutes<1 || durationMinutes>15) throw new Error('Invalid lock duration');
    const rate = await this.getRate(fromCurrency, toCurrency);
    const lockId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now() + durationMinutes * 60 * 1000);

    await this.db.query(`
      INSERT INTO rate_locks
      (lock_id, from_currency, to_currency, locked_rate, expires_at, user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [lockId, fromCurrency, toCurrency, fromCurrency===toCurrency ? '1' : this.cache.get(`${fromCurrency}_${toCurrency}`).rateExact, expiresAt,userId]);

    metrics.lockCreated.inc({from:fromCurrency,to:toCurrency});

    return {
      lockId,
      lockedRate: rate,
      expiresAt
    };
  }

  /**
   * Use locked rate for payment
   */
  validateOwner(userId) {
    if (typeof userId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new Error('Authenticated owner required');
  }

  async useLockedRate(lockId, referenceType, referenceId, {userId,client=this.db} = {}) {
    this.validateOwner(userId);
    if (typeof lockId!=='string' || !/^[a-f0-9]{64}$/.test(lockId) || !['order','display','refund'].includes(referenceType) || typeof referenceId!=='string' || !referenceId.length || referenceId.length>100) throw new Error('Invalid rate lock reference');
    const result = await client.query(`
      UPDATE rate_locks
      SET used = true,
          reference_type = $2,
          reference_id = $3
      WHERE lock_id = $1 AND user_id=$4
        AND used = false
        AND expires_at > NOW()
      RETURNING from_currency, to_currency, locked_rate
    `, [lockId, referenceType, referenceId,userId]);

    if (result.rows.length === 0) {
      throw new Error('Rate lock not found, expired, or already used');
    }

    if(client===this.db) metrics.lockUsed.inc();

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
    const result = await this.db.query(`
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
    const result = await this.db.query(`
      DELETE FROM rate_locks
      WHERE expires_at < NOW() AND used=false
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

module.exports.ExchangeRateService = ExchangeRateService;
module.exports.exchangeRateService = module.exports;
