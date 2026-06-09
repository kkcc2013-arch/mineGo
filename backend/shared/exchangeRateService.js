// backend/shared/exchangeRateService.js
// REQ-00051: 多货币支持与汇率转换系统

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { query } = require('./db');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('exchange-rate-service');

class ExchangeRateService {
  constructor() {
    this.sources = {
      openexchangerates: {
        url: 'https://openexchangerates.org/api/latest.json',
        apiKey: process.env.OER_API_KEY,
        priority: 1
      },
      fixer: {
        url: 'https://data.fixer.io/api/latest',
        apiKey: process.env.FIXER_API_KEY,
        priority: 2
      }
    };
    
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 分钟缓存
  }

  /**
   * 获取最新汇率（带缓存）
   */
  async getRate(fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) {
      return 1;
    }

    const cacheKey = `${fromCurrency}_${toCurrency}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      metrics.increment('exchange_rate.cache_hit');
      return cached.rate;
    }
    
    // 从数据库获取当前汇率
    const result = await query(`
      SELECT rate, valid_until, source
      FROM exchange_rates
      WHERE from_currency = $1 
        AND to_currency = $2 
        AND is_current = true
        AND valid_until > NOW()
      ORDER BY fetched_at DESC
      LIMIT 1
    `, [fromCurrency, toCurrency]);
    
    if (result.rows.length > 0) {
      const rate = parseFloat(result.rows[0].rate);
      this.cache.set(cacheKey, { rate, timestamp: Date.now() });
      metrics.increment('exchange_rate.db_hit');
      return rate;
    }
    
    // 汇率过期或不存在，尝试反向汇率
    const reverseResult = await query(`
      SELECT rate, valid_until
      FROM exchange_rates
      WHERE from_currency = $1 
        AND to_currency = $2 
        AND is_current = true
        AND valid_until > NOW()
      ORDER BY fetched_at DESC
      LIMIT 1
    `, [toCurrency, fromCurrency]);
    
    if (reverseResult.rows.length > 0) {
      const rate = 1 / parseFloat(reverseResult.rows[0].rate);
      this.cache.set(cacheKey, { rate, timestamp: Date.now() });
      return rate;
    }
    
    // 尝试通过 USD 计算交叉汇率
    if (fromCurrency !== 'USD' && toCurrency !== 'USD') {
      const fromToUsd = await this.getRate(fromCurrency, 'USD');
      const usdToTarget = await this.getRate('USD', toCurrency);
      
      if (fromToUsd && usdToTarget) {
        const crossRate = fromToUsd * usdToTarget;
        this.cache.set(cacheKey, { rate: crossRate, timestamp: Date.now() });
        return crossRate;
      }
    }
    
    metrics.increment('exchange_rate.fetch_required');
    throw new Error(`Exchange rate not found for ${fromCurrency}/${toCurrency}`);
  }

  /**
   * 批量获取汇率
   */
  async getRates(baseCurrency, targetCurrencies) {
    const rates = {};
    const uncached = [];
    
    // 先检查缓存
    for (const currency of targetCurrencies) {
      if (currency === baseCurrency) {
        rates[currency] = 1;
        continue;
      }
      
      const cacheKey = `${baseCurrency}_${currency}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        rates[currency] = cached.rate;
      } else {
        uncached.push(currency);
      }
    }
    
    // 批量查询数据库
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
   * 保存汇率到数据库
   */
  async saveRate(fromCurrency, toCurrency, rate, source) {
    const validUntil = new Date(Date.now() + 3600000); // 1 小时有效期
    
    await query(`
      UPDATE exchange_rates 
      SET is_current = false 
      WHERE from_currency = $1 AND to_currency = $2
    `, [fromCurrency, toCurrency]);
    
    await query(`
      INSERT INTO exchange_rates 
      (from_currency, to_currency, rate, source, fetched_at, valid_until, is_current)
      VALUES ($1, $2, $3, $4, NOW(), $5, true)
    `, [fromCurrency, toCurrency, rate, source, validUntil]);
    
    logger.info('Exchange rate updated', {
      from: fromCurrency,
      to: toCurrency,
      rate,
      source,
      validUntil
    });
  }

  /**
   * 锁定汇率（用于支付）
   */
  async lockRate(fromCurrency, toCurrency, durationMinutes = 15) {
    const rate = await this.getRate(fromCurrency, toCurrency);
    const lockId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);
    
    await query(`
      INSERT INTO rate_locks 
      (lock_id, from_currency, to_currency, locked_rate, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [lockId, fromCurrency, toCurrency, rate, expiresAt]);
    
    metrics.increment('exchange_rate.lock_created');
    
    return {
      lockId,
      lockedRate: rate,
      expiresAt
    };
  }

  /**
   * 验证并使用锁定的汇率
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
   * 定时刷新所有汇率
   */
  async refreshAllRates() {
    const currencies = await query(`
      SELECT currency_code FROM supported_currencies WHERE is_active = true
    `);
    
    const currencyCodes = currencies.rows.map(r => r.currency_code);
    const baseCurrency = 'USD'; // 基准货币
    
    logger.info('Starting exchange rate refresh', {
      baseCurrency,
      targetCount: currencyCodes.length
    });
    
    let successCount = 0;
    let failureCount = 0;
    
    for (const targetCurrency of currencyCodes) {
      if (targetCurrency === baseCurrency) continue;
      
      try {
        // 尝试从外部 API 获取
        const rate = await this.fetchFromExternal(baseCurrency, targetCurrency);
        
        if (rate) {
          await this.saveRate(baseCurrency, targetCurrency, rate, 'external');
          successCount++;
        } else {
          failureCount++;
        }
      } catch (error) {
        failureCount++;
        logger.error('Failed to refresh rate', {
          from: baseCurrency,
          to: targetCurrency,
          error: error.message
        });
      }
    }
    
    logger.info('Exchange rate refresh completed', {
      successCount,
      failureCount
    });
    
    return { successCount, failureCount };
  }

  /**
   * 从外部 API 获取汇率
   */
  async fetchFromExternal(fromCurrency, toCurrency) {
    // 如果没有配置 API Key，使用数据库中的现有汇率
    if (!process.env.OER_API_KEY && !process.env.FIXER_API_KEY) {
      logger.debug('No external API key configured, using existing rates');
      return null;
    }

    try {
      if (process.env.OER_API_KEY) {
        const response = await axios.get('https://openexchangerates.org/api/latest.json', {
          params: {
            app_id: process.env.OER_API_KEY,
            base: fromCurrency
          },
          timeout: 10000
        });
        
        if (response.data && response.data.rates && response.data.rates[toCurrency]) {
          return response.data.rates[toCurrency];
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch from OpenExchangeRates', { error: error.message });
    }
    
    return null;
  }

  /**
   * 清理过期汇率锁定
   */
  async cleanupExpiredLocks() {
    const result = await query(`
      DELETE FROM rate_locks
      WHERE expires_at < NOW() AND used = false
      RETURNING lock_id
    `);
    
    if (result.rows.length > 0) {
      logger.info('Cleaned up expired rate locks', { count: result.rows.length });
    }
    
    return result.rows.length;
  }
}

// 单例
const exchangeRateService = new ExchangeRateService();

// 定时任务：每 30 分钟刷新汇率
let refreshInterval = null;

function startExchangeRateRefreshJob() {
  if (refreshInterval) return;
  
  // 启动时延迟 5 秒刷新一次
  setTimeout(async () => {
    try {
      await exchangeRateService.refreshAllRates();
    } catch (error) {
      logger.error('Initial exchange rate refresh failed', { error: error.message });
    }
  }, 5000);
  
  // 定时刷新
  refreshInterval = setInterval(async () => {
    try {
      await exchangeRateService.refreshAllRates();
      await exchangeRateService.cleanupExpiredLocks();
    } catch (error) {
      logger.error('Scheduled exchange rate refresh failed', { error: error.message });
    }
  }, 1800000); // 30 分钟
}

function stopExchangeRateRefreshJob() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

module.exports = {
  ExchangeRateService,
  exchangeRateService,
  startExchangeRateRefreshJob,
  stopExchangeRateRefreshJob
};
