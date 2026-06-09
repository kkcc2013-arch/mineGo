// backend/tests/unit/currency.test.js
// REQ-00051: 多货币支持单元测试

'use strict';

const { exchangeRateService, ExchangeRateService } = require('../../shared/exchangeRateService');
const { currencyFormatter, CurrencyFormatter } = require('../../shared/currencyFormatter');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../shared/metrics', () => ({
  increment: jest.fn(),
  histogram: jest.fn()
}));

const db = require('../../shared/db');

describe('ExchangeRateService', () => {
  let service;

  beforeEach(() => {
    service = new ExchangeRateService();
    jest.clearAllMocks();
    service.cache.clear();
  });

  describe('getRate', () => {
    it('should return 1 for same currency', async () => {
      const rate = await service.getRate('USD', 'USD');
      expect(rate).toBe(1);
    });

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

    it('should use reverse rate if direct rate not found', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] })  // Direct rate not found
        .mockResolvedValueOnce({             // Reverse rate
          rows: [{ rate: '0.0067', valid_until: new Date(Date.now() + 3600000) }]
        });
      
      const rate = await service.getRate('JPY', 'USD');
      expect(rate).toBeCloseTo(149.25, 0);
    });

    it('should calculate cross rate via USD', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] })  // EUR -> JPY not found
        .mockResolvedValueOnce({ rows: [] })  // Reverse not found
        .mockResolvedValueOnce({             // EUR -> USD
          rows: [{ rate: '1.0869', valid_until: new Date(Date.now() + 3600000) }]
        })
        .mockResolvedValueOnce({             // USD -> JPY
          rows: [{ rate: '149.5', valid_until: new Date(Date.now() + 3600000) }]
        });
      
      const rate = await service.getRate('EUR', 'JPY');
      expect(rate).toBeCloseTo(162.5, 0);
    });
  });

  describe('getRates', () => {
    it('should return multiple rates', async () => {
      db.query.mockResolvedValue({
        rows: [
          { to_currency: 'EUR', rate: '0.92' },
          { to_currency: 'JPY', rate: '149.5' }
        ]
      });
      
      const rates = await service.getRates('USD', ['EUR', 'JPY', 'USD']);
      
      expect(rates['USD']).toBe(1);
      expect(rates['EUR']).toBe(0.92);
      expect(rates['JPY']).toBe(149.5);
    });
  });

  describe('lockRate', () => {
    it('should create rate lock', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [{ rate: '149.5', valid_until: new Date(Date.now() + 3600000) }]
        })
        .mockResolvedValueOnce({ rows: [] });
      
      const lock = await service.lockRate('USD', 'JPY', 15);
      
      expect(lock.lockId).toBeDefined();
      expect(lock.lockId).toHaveLength(64);
      expect(lock.lockedRate).toBe(149.5);
      expect(lock.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('useLockedRate', () => {
    it('should use locked rate', async () => {
      db.query.mockResolvedValue({
        rows: [{
          from_currency: 'USD',
          to_currency: 'JPY',
          locked_rate: '149.5'
        }]
      });
      
      const result = await service.useLockedRate('test-lock-id', 'order', 'order-123');
      
      expect(result.fromCurrency).toBe('USD');
      expect(result.toCurrency).toBe('JPY');
      expect(result.lockedRate).toBe(149.5);
    });

    it('should throw error if lock not found', async () => {
      db.query.mockResolvedValue({ rows: [] });
      
      await expect(
        service.useLockedRate('invalid-lock', 'order', 'order-123')
      ).rejects.toThrow('Rate lock not found, expired, or already used');
    });
  });

  describe('saveRate', () => {
    it('should save rate to database', async () => {
      db.query.mockResolvedValue({ rows: [] });
      
      await service.saveRate('USD', 'JPY', 149.5, 'manual');
      
      expect(db.query).toHaveBeenCalledTimes(2);
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
      expect(result).toMatch(/1,234\.56/);
      expect(result).toContain('€');
    });

    it('should format CNY correctly', () => {
      const result = currencyFormatter.format(1234.56, 'CNY');
      expect(result).toMatch(/¥1,234\.56/);
    });

    it('should support compact mode', () => {
      const result = currencyFormatter.format(1234567, 'USD', { compact: true });
      expect(result).toMatch(/1\.23M/);
    });

    it('should support showCode option', () => {
      const result = currencyFormatter.format(100, 'USD', { showCode: true });
      expect(result).toContain('USD');
    });

    it('should handle unknown currency', () => {
      const result = currencyFormatter.format(100, 'XXX');
      expect(result).toContain('100');
    });
  });

  describe('parse', () => {
    it('should parse numeric string', () => {
      expect(currencyFormatter.parse('1234.56', 'USD')).toBe(1234.56);
    });

    it('should parse string with symbol', () => {
      expect(currencyFormatter.parse('$1,234.56', 'USD')).toBe(1234.56);
    });

    it('should parse negative amount', () => {
      expect(currencyFormatter.parse('-100', 'USD')).toBe(-100);
    });

    it('should throw error for invalid input', () => {
      expect(() => currencyFormatter.parse('abc', 'USD')).toThrow('Invalid amount');
    });
  });

  describe('detectCurrency', () => {
    it('should detect currency by country', () => {
      expect(currencyFormatter.detectCurrency('US')).toBe('USD');
      expect(currencyFormatter.detectCurrency('JP')).toBe('JPY');
      expect(currencyFormatter.detectCurrency('CN')).toBe('CNY');
      expect(currencyFormatter.detectCurrency('GB')).toBe('GBP');
      expect(currencyFormatter.detectCurrency('KR')).toBe('KRW');
    });

    it('should default to USD for unknown country', () => {
      expect(currencyFormatter.detectCurrency('XX')).toBe('USD');
    });

    it('should handle lowercase input', () => {
      expect(currencyFormatter.detectCurrency('jp')).toBe('JPY');
    });
  });

  describe('getConfig', () => {
    it('should return currency config', () => {
      const config = currencyFormatter.getConfig('USD');
      expect(config).toEqual({
        symbol: '$',
        decimalPlaces: 2,
        locale: 'en-US',
        symbolPosition: 'before'
      });
    });

    it('should return null for unknown currency', () => {
      expect(currencyFormatter.getConfig('XXX')).toBeNull();
    });
  });

  describe('getSupportedCurrencies', () => {
    it('should return list of supported currencies', () => {
      const currencies = currencyFormatter.getSupportedCurrencies();
      expect(currencies).toContain('USD');
      expect(currencies).toContain('EUR');
      expect(currencies).toContain('JPY');
      expect(currencies).toContain('CNY');
      expect(currencies.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('compare', () => {
    it('should compare amounts correctly', () => {
      expect(currencyFormatter.compare(100, 50, 'USD')).toBeGreaterThan(0);
      expect(currencyFormatter.compare(50, 100, 'USD')).toBeLessThan(0);
      expect(currencyFormatter.compare(100, 100, 'USD')).toBe(0);
    });

    it('should handle decimal places', () => {
      expect(currencyFormatter.compare(0.01, 0.009, 'USD')).toBeGreaterThan(0);
    });
  });

  describe('toMinorUnit / fromMinorUnit', () => {
    it('should convert to minor unit', () => {
      expect(currencyFormatter.toMinorUnit(1.23, 'USD')).toBe(123);
      expect(currencyFormatter.toMinorUnit(100, 'JPY')).toBe(100);
      expect(currencyFormatter.toMinorUnit(1.234, 'USD')).toBe(123);
    });

    it('should convert from minor unit', () => {
      expect(currencyFormatter.fromMinorUnit(123, 'USD')).toBe(1.23);
      expect(currencyFormatter.fromMinorUnit(100, 'JPY')).toBe(100);
    });

    it('should round-trip correctly', () => {
      const original = 12.34;
      const minor = currencyFormatter.toMinorUnit(original, 'USD');
      const back = currencyFormatter.fromMinorUnit(minor, 'USD');
      expect(back).toBe(original);
    });
  });

  describe('isValidCurrency', () => {
    it('should validate currency codes', () => {
      expect(currencyFormatter.isValidCurrency('USD')).toBe(true);
      expect(currencyFormatter.isValidCurrency('JPY')).toBe(true);
      expect(currencyFormatter.isValidCurrency('XXX')).toBe(false);
    });
  });
});

describe('Integration Tests', () => {
  it('should format converted amount', async () => {
    const service = new ExchangeRateService();
    
    db.query.mockResolvedValue({
      rows: [{ rate: '149.5', valid_until: new Date(Date.now() + 3600000) }]
    });
    
    const rate = await service.getRate('USD', 'JPY');
    const amount = 100;
    const converted = amount * rate;
    const formatted = currencyFormatter.format(converted, 'JPY');
    
    expect(formatted).toMatch(/¥14,950/);
  });
});
