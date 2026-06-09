# REQ-00051: 多货币支持与汇率转换系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00051 |
| 标题 | 多货币支持与汇率转换系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | payment-service、user-service、gateway、backend/shared |
| 创建时间 | 2026-06-09 15:00 |

## 需求描述

为支持全球化运营，需要实现多货币支持与汇率转换系统，允许用户在不同地区使用本地货币进行支付。系统需要：

1. 支持主流货币（USD、EUR、JPY、CNY、GBP、KRW 等 15+ 种）
2. 实时汇率更新（每日多次，来自权威汇率源）
3. 用户货币偏好设置与自动检测
4. 价格展示本地化（符号、格式、小数位数）
5. 支付时汇率锁定机制（避免汇率波动）
6. 汇率历史记录与审计追踪

## 技术方案

### 1. 数据库设计

```sql
-- database/pending/20260609_150000__add_currency_support.sql

-- 支持的货币列表
CREATE TABLE supported_currencies (
    currency_code CHAR(3) PRIMARY KEY,  -- ISO 4217 货币代码
    currency_name VARCHAR(50) NOT NULL,
    currency_symbol VARCHAR(10) NOT NULL,
    decimal_places INTEGER DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    supported_since TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(currency_code)
);

-- 用户货币偏好
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency CHAR(3) DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_auto_detect BOOLEAN DEFAULT true;

-- 汇率快照表
CREATE TABLE exchange_rates (
    id SERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    source VARCHAR(50) NOT NULL,  -- 'openexchangerates', 'ecb', 'manual'
    fetched_at TIMESTAMP NOT NULL,
    valid_until TIMESTAMP NOT NULL,
    is_current BOOLEAN DEFAULT true,
    UNIQUE(from_currency, to_currency, fetched_at)
);

CREATE INDEX idx_exchange_rates_current ON exchange_rates(from_currency, to_currency) WHERE is_current = true;
CREATE INDEX idx_exchange_rates_validity ON exchange_rates(valid_until);

-- 汇率锁定记录（支付专用）
CREATE TABLE rate_locks (
    id SERIAL PRIMARY KEY,
    lock_id VARCHAR(64) UNIQUE NOT NULL,  -- UUID
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    locked_rate DECIMAL(20, 10) NOT NULL,
    locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    reference_type VARCHAR(20),  -- 'order', 'price_display'
    reference_id VARCHAR(100),
    used BOOLEAN DEFAULT false
);

CREATE INDEX idx_rate_locks_lookup ON rate_locks(lock_id, expires_at) WHERE used = false;

-- 汇率历史表（审计）
CREATE TABLE exchange_rate_history (
    id SERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    recorded_at DATE NOT NULL,
    open_rate DECIMAL(20, 10),
    close_rate DECIMAL(20, 10),
    high_rate DECIMAL(20, 10),
    low_rate DECIMAL(20, 10),
    UNIQUE(from_currency, to_currency, recorded_at)
);

-- 商品定价表（支持多货币）
CREATE TABLE product_prices (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(100) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    price DECIMAL(20, 2) NOT NULL,
    original_price DECIMAL(20, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, currency_code)
);

CREATE INDEX idx_product_prices_lookup ON product_prices(product_id);

-- 初始化支持的货币
INSERT INTO supported_currencies (currency_code, currency_name, currency_symbol, decimal_places) VALUES
('USD', 'US Dollar', '$', 2),
('EUR', 'Euro', '€', 2),
('GBP', 'British Pound', '£', 2),
('JPY', 'Japanese Yen', '¥', 0),
('CNY', 'Chinese Yuan', '¥', 2),
('KRW', 'South Korean Won', '₩', 0),
('TWD', 'Taiwan Dollar', 'NT$', 2),
('HKD', 'Hong Kong Dollar', 'HK$', 2),
('SGD', 'Singapore Dollar', 'S$', 2),
('AUD', 'Australian Dollar', 'A$', 2),
('CAD', 'Canadian Dollar', 'C$', 2),
('CHF', 'Swiss Franc', 'CHF', 2),
('SEK', 'Swedish Krona', 'kr', 2),
('NOK', 'Norwegian Krone', 'kr', 2),
('INR', 'Indian Rupee', '₹', 2);
```

### 2. 汇率获取服务

```javascript
// backend/shared/exchangeRateService.js

const axios = require('axios');
const crypto = require('crypto');
const { logger, metrics } = require('./index');
const db = require('./db');

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
      },
      ecb: {
        // European Central Bank - 免费
        url: 'https://sdw-wsrest.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A',
        priority: 3
      }
    };
    
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 分钟缓存
  }

  /**
   * 获取最新汇率（带缓存）
   */
  async getRate(fromCurrency, toCurrency) {
    const cacheKey = `${fromCurrency}_${toCurrency}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      metrics.increment('exchange_rate.cache_hit');
      return cached.rate;
    }
    
    // 从数据库获取当前汇率
    const result = await db.query(`
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
    
    // 汇率过期或不存在，尝试实时获取
    metrics.increment('exchange_rate.fetch_required');
    return await this.fetchAndCacheRate(fromCurrency, toCurrency);
  }

  /**
   * 批量获取汇率
   */
  async getRates(baseCurrency, targetCurrencies) {
    const rates = {};
    const uncached = [];
    
    // 先检查缓存
    for (const currency of targetCurrencies) {
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
      const result = await db.query(`
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
   * 从外部 API 获取汇率
   */
  async fetchAndCacheRate(fromCurrency, toCurrency) {
    const startTime = Date.now();
    
    for (const [sourceName, config] of Object.entries(this.sources).sort((a, b) => a[1].priority - b[1].priority)) {
      try {
        const rate = await this.fetchFromSource(sourceName, fromCurrency, toCurrency);
        
        if (rate) {
          // 存储到数据库
          await this.saveRate(fromCurrency, toCurrency, rate, sourceName);
          
          // 更新缓存
          const cacheKey = `${fromCurrency}_${toCurrency}`;
          this.cache.set(cacheKey, { rate, timestamp: Date.now() });
          
          metrics.histogram('exchange_rate.fetch_duration', Date.now() - startTime);
          metrics.increment('exchange_rate.fetch_success', { source: sourceName });
          
          return rate;
        }
      } catch (error) {
        logger.warn(`Failed to fetch rate from ${sourceName}`, {
          error: error.message,
          from: fromCurrency,
          to: toCurrency
        });
        metrics.increment('exchange_rate.fetch_failure', { source: sourceName });
      }
    }
    
    throw new Error(`Failed to fetch exchange rate for ${fromCurrency}/${toCurrency}`);
  }

  /**
   * 从特定数据源获取汇率
   */
  async fetchFromSource(sourceName, fromCurrency, toCurrency) {
    const config = this.sources[sourceName];
    
    if (!config) {
      throw new Error(`Unknown exchange rate source: ${sourceName}`);
    }
    
    switch (sourceName) {
      case 'openexchangerates':
        return await this.fetchFromOER(config, fromCurrency, toCurrency);
      case 'fixer':
        return await this.fetchFromFixer(config, fromCurrency, toCurrency);
      case 'ecb':
        return await this.fetchFromECB(config, fromCurrency, toCurrency);
      default:
        throw new Error(`Unsupported source: ${sourceName}`);
    }
  }

  /**
   * OpenExchangeRates API
   */
  async fetchFromOER(config, fromCurrency, toCurrency) {
    const response = await axios.get(config.url, {
      params: {
        app_id: config.apiKey,
        base: fromCurrency
      },
      timeout: 10000
    });
    
    if (response.data && response.data.rates) {
      return response.data.rates[toCurrency];
    }
    
    return null;
  }

  /**
   * Fixer API
   */
  async fetchFromFixer(config, fromCurrency, toCurrency) {
    const response = await axios.get(config.url, {
      params: {
        access_key: config.apiKey,
        base: fromCurrency,
        symbols: toCurrency
      },
      timeout: 10000
    });
    
    if (response.data && response.data.success && response.data.rates) {
      return response.data.rates[toCurrency];
    }
    
    return null;
  }

  /**
   * ECB (European Central Bank) - 免费但只支持 EUR 作为基准
   */
  async fetchFromECB(config, fromCurrency, toCurrency) {
    // ECB 只提供 EUR 为基准的汇率
    // 需要计算交叉汇率
    if (fromCurrency === 'EUR') {
      const response = await axios.get(config.url, {
        headers: { Accept: 'application/json' },
        timeout: 10000
      });
      
      // 解析 ECB 数据格式
      // 这里简化处理，实际需要解析 XML/JSON 响应
      return this.parseECBRate(response.data, toCurrency);
    } else if (toCurrency === 'EUR') {
      const rate = await this.fetchFromECB(config, 'EUR', fromCurrency);
      return rate ? 1 / rate : null;
    } else {
      // 交叉汇率计算
      const fromToEur = await this.fetchFromECB(config, 'EUR', fromCurrency);
      const eurToTo = await this.fetchFromECB(config, 'EUR', toCurrency);
      
      if (fromToEur && eurToTo) {
        return fromToEur / eurToTo;
      }
    }
    
    return null;
  }

  /**
   * 保存汇率到数据库
   */
  async saveRate(fromCurrency, toCurrency, rate, source) {
    const validUntil = new Date(Date.now() + 3600000); // 1 小时有效期
    
    await db.query(`
      UPDATE exchange_rates 
      SET is_current = false 
      WHERE from_currency = $1 AND to_currency = $2
    `, [fromCurrency, toCurrency]);
    
    await db.query(`
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
    
    await db.query(`
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
    const result = await db.query(`
      UPDATE rate_locks
      SET used = true, 
          reference_type = $3, 
          reference_id = $4,
          expires_at = NOW() + INTERVAL '1 hour'
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
    const currencies = await db.query(`
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
        await this.fetchAndCacheRate(baseCurrency, targetCurrency);
        
        // 计算交叉汇率
        for (const otherCurrency of currencyCodes) {
          if (otherCurrency !== baseCurrency && otherCurrency !== targetCurrency) {
            const usdToTarget = await this.getRate('USD', targetCurrency);
            const usdToOther = await this.getRate('USD', otherCurrency);
            
            if (usdToTarget && usdToOther) {
              const crossRate = usdToTarget / usdToOther;
              await this.saveRate(targetCurrency, otherCurrency, crossRate, 'calculated');
            }
          }
        }
        
        successCount++;
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
}

// 定时任务：每 30 分钟刷新汇率
async function startExchangeRateRefreshJob() {
  const service = new ExchangeRateService();
  
  // 启动时立即刷新一次
  await service.refreshAllRates();
  
  // 定时刷新
  setInterval(async () => {
    try {
      await service.refreshAllRates();
    } catch (error) {
      logger.error('Scheduled exchange rate refresh failed', { error: error.message });
    }
  }, 1800000); // 30 分钟
}

module.exports = {
  ExchangeRateService,
  startExchangeRateRefreshJob
};
```

### 3. 货币格式化服务

```javascript
// backend/shared/currencyFormatter.js

const { supported_currencies: currencyConfig } = require('./currencyConfig');

class CurrencyFormatter {
  constructor() {
    this.localeMap = {
      'USD': 'en-US',
      'EUR': 'de-DE',
      'GBP': 'en-GB',
      'JPY': 'ja-JP',
      'CNY': 'zh-CN',
      'KRW': 'ko-KR',
      'TWD': 'zh-TW',
      'HKD': 'zh-HK',
      'SGD': 'en-SG',
      'AUD': 'en-AU',
      'CAD': 'en-CA',
      'CHF': 'de-CH',
      'SEK': 'sv-SE',
      'NOK': 'nb-NO',
      'INR': 'en-IN'
    };
  }

  /**
   * 格式化金额显示
   */
  format(amount, currencyCode, options = {}) {
    const config = currencyConfig[currencyCode] || { 
      symbol: currencyCode, 
      decimalPlaces: 2 
    };
    
    const {
      showSymbol = true,
      showCode = false,
      compact = false  // 紧凑模式（如 1.2K, 3.5M）
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
    const locale = this.localeMap[currencyCode] || 'en-US';
    const formatter = new Intl.NumberFormat(locale, {
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
      // 某些货币符号在前，某些在后
      const symbolAfterCurrencies = ['EUR', 'CZK', 'SEK', 'NOK'];
      
      if (symbolAfterCurrencies.includes(currencyCode)) {
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
    let cleaned = input
      .replace(/[^\d.,\-]/g, '')
      .replace(/,/g, '');  // 移除千位分隔符
    
    // 处理不同的小数分隔符
    const config = currencyConfig[currencyCode];
    if (config && config.decimalSeparator === ',') {
      cleaned = cleaned.replace(',', '.');
    }
    
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
    const countryCurrencyMap = {
      'US': 'USD',
      'GB': 'GBP',
      'EU': 'EUR',
      'JP': 'JPY',
      'CN': 'CNY',
      'KR': 'KRW',
      'TW': 'TWD',
      'HK': 'HKD',
      'SG': 'SGD',
      'AU': 'AUD',
      'CA': 'CAD',
      'CH': 'CHF',
      'SE': 'SEK',
      'NO': 'NOK',
      'IN': 'INR',
      'DE': 'EUR',
      'FR': 'EUR',
      'IT': 'EUR',
      'ES': 'EUR'
    };
    
    return countryCurrencyMap[countryCode] || 'USD';
  }

  /**
   * 比较金额（考虑货币精度）
   */
  compare(amount1, currency1, amount2, currency2) {
    // 转换为最小单位比较（分、厘等）
    const config1 = currencyConfig[currency1] || { decimalPlaces: 2 };
    const config2 = currencyConfig[currency2] || { decimalPlaces: 2 };
    
    const minUnit1 = Math.round(amount1 * Math.pow(10, config1.decimalPlaces));
    const minUnit2 = Math.round(amount2 * Math.pow(10, config2.decimalPlaces));
    
    // 需要转换为同一货币才能比较
    if (currency1 === currency2) {
      return minUnit1 - minUnit2;
    }
    
    throw new Error('Cannot compare amounts in different currencies without conversion');
  }
}

module.exports = new CurrencyFormatter();
```

### 4. 多货币定价 API

```javascript
// backend/services/payment-service/src/routes/currency.js

const express = require('express');
const router = express.Router();
const { ExchangeRateService } = require('../../../shared/exchangeRateService');
const currencyFormatter = require('../../../shared/currencyFormatter');
const db = require('../../../shared/db');
const { logger, metrics } = require('../../../shared/index');

const exchangeService = new ExchangeRateService();

/**
 * 获取支持的货币列表
 * GET /api/v1/currencies
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
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
    
    res.json({
      success: true,
      currencies: result.rows.map(row => ({
        code: row.currency_code,
        name: row.currency_name,
        symbol: row.currency_symbol,
        decimalPlaces: row.decimal_places,
        supportedSince: row.supported_since
      }))
    });
  } catch (error) {
    logger.error('Failed to get currencies', { error: error.message });
    res.status(500).json({ error: 'Failed to get currencies' });
  }
});

/**
 * 获取汇率
 * GET /api/v1/currencies/rates?from=USD&to=JPY,EUR,GBP
 */
router.get('/rates', async (req, res) => {
  try {
    const { from = 'USD', to } = req.query;
    
    if (!to) {
      return res.status(400).json({ error: 'Target currencies required' });
    }
    
    const targetCurrencies = to.split(',').map(c => c.trim().toUpperCase());
    const rates = await exchangeService.getRates(from, targetCurrencies);
    
    res.json({
      success: true,
      base: from,
      rates,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get exchange rates', { error: error.message });
    res.status(500).json({ error: 'Failed to get exchange rates' });
  }
});

/**
 * 转换金额
 * POST /api/v1/currencies/convert
 * Body: { amount: 100, from: "USD", to: "JPY" }
 */
router.post('/convert', async (req, res) => {
  try {
    const { amount, from, to, lockRate = false } = req.body;
    
    if (!amount || !from || !to) {
      return res.status(400).json({ error: 'amount, from, and to are required' });
    }
    
    const rate = await exchangeService.getRate(from, to);
    const converted = amount * rate;
    
    let rateLock = null;
    if (lockRate) {
      rateLock = await exchangeService.lockRate(from, to);
    }
    
    metrics.increment('currency.conversion', { from, to });
    
    res.json({
      success: true,
      original: {
        amount,
        currency: from,
        formatted: currencyFormatter.format(amount, from)
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
    });
  } catch (error) {
    logger.error('Failed to convert currency', { error: error.message });
    res.status(500).json({ error: 'Failed to convert currency' });
  }
});

/**
 * 获取商品多货币价格
 * GET /api/v1/currencies/prices/:productId?currency=JPY
 */
router.get('/prices/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { currency = 'USD' } = req.query;
    
    // 查询本地化价格
    const localPrice = await db.query(`
      SELECT price, original_price, updated_at
      FROM product_prices
      WHERE product_id = $1 AND currency_code = $2
    `, [productId, currency]);
    
    if (localPrice.rows.length > 0) {
      return res.json({
        success: true,
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
      });
    }
    
    // 本地化价格不存在，从 USD 转换
    const usdPrice = await db.query(`
      SELECT price
      FROM product_prices
      WHERE product_id = $1 AND currency_code = 'USD'
    `, [productId]);
    
    if (usdPrice.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const rate = await exchangeService.getRate('USD', currency);
    const convertedPrice = parseFloat(usdPrice.rows[0].price) * rate;
    
    res.json({
      success: true,
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
    });
  } catch (error) {
    logger.error('Failed to get product price', {
      productId: req.params.productId,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to get product price' });
  }
});

/**
 * 锁定汇率（支付前调用）
 * POST /api/v1/currencies/lock-rate
 * Body: { from: "USD", to: "JPY", durationMinutes: 15 }
 */
router.post('/lock-rate', async (req, res) => {
  try {
    const { from, to, durationMinutes = 15 } = req.body;
    
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to currencies required' });
    }
    
    const lock = await exchangeService.lockRate(from, to, durationMinutes);
    
    logger.info('Rate locked for payment', {
      from,
      to,
      lockId: lock.lockId,
      rate: lock.lockedRate
    });
    
    res.json({
      success: true,
      lockId: lock.lockId,
      rate: lock.lockedRate,
      expiresAt: lock.expiresAt
    });
  } catch (error) {
    logger.error('Failed to lock rate', { error: error.message });
    res.status(500).json({ error: 'Failed to lock rate' });
  }
});

/**
 * 设置用户货币偏好
 * POST /api/v1/currencies/preference
 * Body: { currency: "JPY", autoDetect: false }
 */
router.post('/preference', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { currency, autoDetect = true } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // 验证货币代码
    const currencyExists = await db.query(`
      SELECT 1 FROM supported_currencies 
      WHERE currency_code = $1 AND is_active = true
    `, [currency]);
    
    if (currencyExists.rows.length === 0) {
      return res.status(400).json({ error: 'Unsupported currency' });
    }
    
    await db.query(`
      UPDATE users
      SET preferred_currency = $1,
          currency_auto_detect = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [currency, autoDetect, userId]);
    
    res.json({
      success: true,
      currency,
      autoDetect
    });
  } catch (error) {
    logger.error('Failed to set currency preference', { error: error.message });
    res.status(500).json({ error: 'Failed to set preference' });
  }
});

/**
 * 管理员：刷新汇率
 * POST /api/v1/currencies/admin/refresh-rates
 */
router.post('/admin/refresh-rates', async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await exchangeService.refreshAllRates();
    
    res.json({
      success: true,
      refreshed: result.successCount,
      failed: result.failureCount
    });
  } catch (error) {
    logger.error('Failed to refresh rates', { error: error.message });
    res.status(500).json({ error: 'Failed to refresh rates' });
  }
});

module.exports = router;
```

### 5. 支付服务集成

```javascript
// backend/services/payment-service/src/multiCurrencyPayment.js

const { ExchangeRateService } = require('../../../shared/exchangeRateService');
const db = require('../../../shared/db');
const { logger, metrics } = require('../../../shared/index');

const exchangeService = new ExchangeRateService();

/**
 * 创建多货币支付订单
 */
async function createMultiCurrencyOrder(userId, productId, userCurrency, rateLockId = null) {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // 获取商品基础价格
    const product = await client.query(`
      SELECT 
        pp.product_id,
        pp.price as usd_price,
        p.name,
        p.description
      FROM product_prices pp
      JOIN products p ON pp.product_id = p.id
      WHERE pp.product_id = $1 AND pp.currency_code = 'USD'
    `, [productId]);
    
    if (product.rows.length === 0) {
      throw new Error('Product not found');
    }
    
    const usdPrice = parseFloat(product.rows[0].usd_price);
    let userPrice, rate, rateLockInfo;
    
    if (userCurrency === 'USD') {
      userPrice = usdPrice;
      rate = 1;
    } else if (rateLockId) {
      // 使用锁定的汇率
      rateLockInfo = await exchangeService.useLockedRate(
        rateLockId, 
        'order',
        `pending_${Date.now()}`
      );
      rate = rateLockInfo.lockedRate;
      userPrice = usdPrice * rate;
    } else {
      // 实时汇率
      rate = await exchangeService.getRate('USD', userCurrency);
      userPrice = usdPrice * rate;
    }
    
    // 创建订单
    const order = await client.query(`
      INSERT INTO payment_orders (
        user_id,
        product_id,
        amount_usd,
        amount_local,
        local_currency,
        exchange_rate,
        rate_lock_id,
        status,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING *
    `, [
      userId,
      productId,
      usdPrice,
      userPrice,
      userCurrency,
      rate,
      rateLockId
    ]);
    
    await client.query('COMMIT');
    
    metrics.increment('payment.multi_currency_order_created', { currency: userCurrency });
    
    return {
      orderId: order.rows[0].id,
      productId,
      productName: product.rows[0].name,
      usdPrice,
      userPrice,
      userCurrency,
      exchangeRate: rate,
      rateLocked: !!rateLockId
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 支付完成后更新汇率使用记录
 */
async function confirmMultiCurrencyPayment(orderId) {
  const result = await db.query(`
    UPDATE payment_orders
    SET status = 'paid', paid_at = NOW()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [orderId]);
  
  if (result.rows.length > 0) {
    const order = result.rows[0];
    
    // 更新汇率锁定记录
    if (order.rate_lock_id) {
      await db.query(`
        UPDATE rate_locks
        SET reference_id = $1
        WHERE lock_id = $2
      `, [orderId, order.rate_lock_id]);
    }
    
    logger.info('Multi-currency payment confirmed', {
      orderId,
      currency: order.local_currency,
      amount: order.amount_local,
      rate: order.exchange_rate
    });
  }
  
  return result.rows[0];
}

module.exports = {
  createMultiCurrencyOrder,
  confirmMultiCurrencyPayment
};
```

### 6. 前端集成

```javascript
// frontend/game-client/src/utils/currency.js

class CurrencyManager {
  constructor() {
    this.currentCurrency = localStorage.getItem('preferred_currency') || 'USD';
    this.rates = {};
    this.ratesExpiry = null;
  }

  /**
   * 初始化：获取用户货币偏好
   */
  async init(userCountry = null) {
    // 检查是否启用自动检测
    const autoDetect = localStorage.getItem('currency_auto_detect') !== 'false';
    
    if (autoDetect && userCountry) {
      const detectedCurrency = await this.detectByCountry(userCountry);
      if (detectedCurrency) {
        this.currentCurrency = detectedCurrency;
      }
    } else {
      this.currentCurrency = localStorage.getItem('preferred_currency') || 'USD';
    }
    
    // 预加载汇率
    await this.loadRates();
  }

  /**
   * 根据国家检测货币
   */
  async detectByCountry(countryCode) {
    const response = await fetch(`/api/v1/currencies/detect?country=${countryCode}`);
    const data = await response.json();
    return data.currency;
  }

  /**
   * 加载汇率缓存
   */
  async loadRates() {
    try {
      const response = await fetch(
        `/api/v1/currencies/rates?from=USD&to=USD,EUR,GBP,JPY,CNY,KRW,TWD,HKD,SGD,AUD`
      );
      const data = await response.json();
      
      if (data.success) {
        this.rates = data.rates;
        this.ratesExpiry = Date.now() + 300000; // 5 分钟缓存
      }
    } catch (error) {
      console.error('Failed to load rates:', error);
    }
  }

  /**
   * 转换金额
   */
  convert(amount, fromCurrency = 'USD') {
    if (fromCurrency === this.currentCurrency) {
      return amount;
    }
    
    const rate = this.rates[this.currentCurrency];
    if (!rate) {
      console.warn(`Rate not found for ${this.currentCurrency}`);
      return amount;
    }
    
    return amount * rate;
  }

  /**
   * 格式化显示
   */
  format(amount, currency = null, options = {}) {
    const targetCurrency = currency || this.currentCurrency;
    const formatter = new Intl.NumberFormat(this.getLocale(targetCurrency), {
      style: 'currency',
      currency: targetCurrency,
      ...options
    });
    
    return formatter.format(amount);
  }

  /**
   * 获取货币对应的 locale
   */
  getLocale(currency) {
    const map = {
      'USD': 'en-US',
      'EUR': 'de-DE',
      'GBP': 'en-GB',
      'JPY': 'ja-JP',
      'CNY': 'zh-CN',
      'KRW': 'ko-KR',
      'TWD': 'zh-TW',
      'HKD': 'zh-HK',
      'SGD': 'en-SG',
      'AUD': 'en-AU'
    };
    
    return map[currency] || 'en-US';
  }

  /**
   * 设置用户货币偏好
   */
  async setCurrency(currency) {
    this.currentCurrency = currency;
    localStorage.setItem('preferred_currency', currency);
    
    // 通知后端
    await fetch('/api/v1/currencies/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency, autoDetect: false })
    });
    
    // 重新加载汇率
    await this.loadRates();
    
    // 触发 UI 更新事件
    window.dispatchEvent(new CustomEvent('currencyChanged', { 
      detail: { currency } 
    }));
  }

  /**
   * 获取商品价格（支持本地化）
   */
  async getProductPrice(productId) {
    const response = await fetch(
      `/api/v1/currencies/prices/${productId}?currency=${this.currentCurrency}`
    );
    const data = await response.json();
    
    if (data.success) {
      return {
        amount: data.price,
        formatted: data.formatted,
        source: data.source,
        originalPrice: data.originalPrice
      };
    }
    
    throw new Error('Failed to get product price');
  }

  /**
   * 创建支付订单（带汇率锁定）
   */
  async createOrderWithRateLock(productId) {
    // 先锁定汇率
    const lockResponse = await fetch('/api/v1/currencies/lock-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'USD',
        to: this.currentCurrency,
        durationMinutes: 15
      })
    });
    
    const lockData = await lockResponse.json();
    
    if (!lockData.success) {
      throw new Error('Failed to lock exchange rate');
    }
    
    // 创建订单
    const orderResponse = await fetch('/api/v1/payments/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        currency: this.currentCurrency,
        rateLockId: lockData.lockId
      })
    });
    
    return await orderResponse.json();
  }
}

export default new CurrencyManager();
```

### 7. 单元测试

```javascript
// backend/tests/unit/currency.test.js

const { ExchangeRateService } = require('../../shared/exchangeRateService');
const currencyFormatter = require('../../shared/currencyFormatter');
const db = require('../../shared/db');

jest.mock('../../shared/db');
jest.mock('axios');

describe('ExchangeRateService', () => {
  let service;

  beforeEach(() => {
    service = new ExchangeRateService();
    jest.clearAllMocks();
  });

  describe('getRate', () => {
    it('should return cached rate', async () => {
      service.cache.set('USD_JPY', { rate: 150.5, timestamp: Date.now() });
      
      const rate = await service.getRate('USD', 'JPY');
      expect(rate).toBe(150.5);
    });

    it('should fetch from database if cache miss', async () => {
      db.query.mockResolvedValue({
        rows: [{ rate: '145.2', valid_until: new Date(Date.now() + 3600000) }]
      });
      
      const rate = await service.getRate('USD', 'EUR');
      expect(rate).toBe(145.2);
      expect(db.query).toHaveBeenCalled();
    });

    it('should fetch from API if database expired', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      
      // Mock API response
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: { rates: { JPY: 150.0 } }
      });
      
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockResolvedValueOnce({ rows: [] });
      
      const rate = await service.getRate('USD', 'JPY');
      expect(rate).toBeDefined();
    });
  });

  describe('lockRate', () => {
    it('should create rate lock', async () => {
      db.query.mockResolvedValue({ rows: [] });
      
      const lock = await service.lockRate('USD', 'JPY', 15);
      
      expect(lock.lockId).toBeDefined();
      expect(lock.lockedRate).toBeGreaterThan(0);
      expect(lock.expiresAt).toBeInstanceOf(Date);
    });
  });
});

describe('CurrencyFormatter', () => {
  describe('format', () => {
    it('should format USD correctly', () => {
      const result = currencyFormatter.format(1234.56, 'USD');
      expect(result).toMatch(/\$1,234\.56/);
    });

    it('should format JPY correctly (no decimals)', () => {
      const result = currencyFormatter.format(1234, 'JPY');
      expect(result).toMatch(/¥1,234/);
    });

    it('should format EUR with symbol after', () => {
      const result = currencyFormatter.format(1234.56, 'EUR');
      expect(result).toMatch(/1\.234,56\s*€/);
    });

    it('should support compact mode', () => {
      const result = currencyFormatter.format(1234567, 'USD', { compact: true });
      expect(result).toMatch(/1\.23M/);
    });
  });

  describe('detectCurrency', () => {
    it('should detect currency by country', () => {
      expect(currencyFormatter.detectCurrency('US')).toBe('USD');
      expect(currencyFormatter.detectCurrency('JP')).toBe('JPY');
      expect(currencyFormatter.detectCurrency('CN')).toBe('CNY');
    });

    it('should default to USD for unknown country', () => {
      expect(currencyFormatter.detectCurrency('XX')).toBe('USD');
    });
  });
});
```

### 8. Prometheus 指标

```javascript
// 添加到 backend/shared/metrics.js

// 汇率相关指标
metrics.register({
  name: 'exchange_rate_fetch_duration',
  type: 'histogram',
  help: 'Duration of exchange rate fetch operations',
  buckets: [10, 50, 100, 500, 1000, 5000]
});

metrics.register({
  name: 'exchange_rate_fetch_success_total',
  type: 'counter',
  help: 'Total successful exchange rate fetches',
  labels: ['source']
});

metrics.register({
  name: 'exchange_rate_fetch_failure_total',
  type: 'counter',
  help: 'Total failed exchange rate fetches',
  labels: ['source']
});

metrics.register({
  name: 'exchange_rate_cache_hit_total',
  type: 'counter',
  help: 'Total exchange rate cache hits'
});

metrics.register({
  name: 'exchange_rate_lock_created_total',
  type: 'counter',
  help: 'Total rate locks created'
});

metrics.register({
  name: 'exchange_rate_lock_used_total',
  type: 'counter',
  help: 'Total rate locks used for payments'
});

metrics.register({
  name: 'currency_conversion_total',
  type: 'counter',
  help: 'Total currency conversions',
  labels: ['from', 'to']
});

metrics.register({
  name: 'multi_currency_order_created_total',
  type: 'counter',
  help: 'Total multi-currency payment orders created',
  labels: ['currency']
});
```

## 验收标准

- [ ] 支持 15+ 种主流货币（USD、EUR、GBP、JPY、CNY、KRW 等）
- [ ] 汇率每 30 分钟自动刷新，支持 3+ 个数据源
- [ ] 汇率缓存命中率 ≥ 90%
- [ ] 支付时汇率锁定 15 分钟，避免汇率波动
- [ ] 商品支持本地化定价和动态转换两种模式
- [ ] 货币格式化符合各地区习惯（符号位置、小数位数、千位分隔符）
- [ ] 用户可设置货币偏好，支持自动检测
- [ ] 所有汇率操作有审计日志
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 响应时间 < 100ms（缓存命中）

## 影响范围

### 新增文件
- `backend/shared/exchangeRateService.js` - 汇率服务核心
- `backend/shared/currencyFormatter.js` - 货币格式化
- `backend/services/payment-service/src/routes/currency.js` - 货币 API
- `backend/services/payment-service/src/multiCurrencyPayment.js` - 多货币支付
- `frontend/game-client/src/utils/currency.js` - 前端货币管理
- `database/pending/20260609_150000__add_currency_support.sql` - 数据库迁移
- `backend/tests/unit/currency.test.js` - 单元测试

### 修改文件
- `backend/services/payment-service/src/index.js` - 集成多货币路由
- `backend/services/user-service/src/index.js` - 用户货币偏好
- `backend/gateway/src/index.js` - 汇率刷新定时任务
- `frontend/game-client/src/components/PaymentDialog.js` - 多货币显示
- `frontend/game-client/src/components/ShopPage.js` - 商品价格本地化

## 参考

- [ISO 4217 Currency Codes](https://www.iso.org/iso-4217-currency-codes.html)
- [OpenExchangeRates API](https://openexchangerates.org/)
- [European Central Bank Exchange Rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/)
- [Unicode CLDR Currency Data](https://www.unicode.org/cldr/charts/latest/by_type/index.html)
