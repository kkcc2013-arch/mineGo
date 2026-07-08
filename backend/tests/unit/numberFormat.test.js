// backend/tests/unit/numberFormat.test.js
// Unit tests for server-side number formatting localization system
'use strict';

const NumberFormatter = require('../../shared/numberFormat');
const { FORMAT_CONFIGS, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } = require('../../shared/numberFormatConfig');
const { numberFormatMiddleware, createNumberFormatContext } = require('../../shared/middleware/numberFormatMiddleware');
const { formatLogMessage, createFormattedLogger } = require('../../shared/formattedLogger');

describe('NumberFormatter', () => {
  
  describe('formatNumber', () => {
    test('should format with thousand separator for zh-CN', () => {
      expect(NumberFormatter.formatNumber(1000, 'zh-CN')).toBe('1,000');
      expect(NumberFormatter.formatNumber(1234567, 'zh-CN')).toBe('1,234,567');
    });
    
    test('should format with thousand separator for en-US', () => {
      expect(NumberFormatter.formatNumber(1000, 'en-US')).toBe('1,000');
      expect(NumberFormatter.formatNumber(1234567, 'en-US')).toBe('1,234,567');
    });
    
    test('should format with thousand separator for ja-JP', () => {
      expect(NumberFormatter.formatNumber(1000, 'ja-JP')).toBe('1,000');
      expect(NumberFormatter.formatNumber(1234567, 'ja-JP')).toBe('1,234,567');
    });
    
    test('should handle negative numbers', () => {
      expect(NumberFormatter.formatNumber(-1000, 'zh-CN')).toBe('-1,000');
      expect(NumberFormatter.formatNumber(-1234567, 'en-US')).toBe('-1,234,567');
    });
    
    test('should handle precision option', () => {
      expect(NumberFormatter.formatNumber(1234.567, 'zh-CN', { precision: 2 })).toBe('1,234.57');
      expect(NumberFormatter.formatNumber(1234.567, 'en-US', { precision: 1 })).toBe('1,234.6');
    });
    
    test('should return 0 for invalid input', () => {
      expect(NumberFormatter.formatNumber(null)).toBe('0');
      expect(NumberFormatter.formatNumber(undefined)).toBe('0');
      expect(NumberFormatter.formatNumber('abc')).toBe('0');
      expect(NumberFormatter.formatNumber(NaN)).toBe('0');
    });
  });
  
  describe('formatCompact', () => {
    test('should format large numbers in Chinese (万/亿)', () => {
      expect(NumberFormatter.formatCompact(10000, 'zh-CN')).toBe('1万');
      expect(NumberFormatter.formatCompact(15000, 'zh-CN')).toBe('1.5万');
      expect(NumberFormatter.formatCompact(100000000, 'zh-CN')).toBe('1亿');
      expect(NumberFormatter.formatCompact(150000000, 'zh-CN')).toBe('1.5亿');
    });
    
    test('should format large numbers in English (K/M/B)', () => {
      expect(NumberFormatter.formatCompact(1000, 'en-US')).toBe('1K');
      expect(NumberFormatter.formatCompact(1500, 'en-US')).toBe('1.5K');
      expect(NumberFormatter.formatCompact(1000000, 'en-US')).toBe('1M');
      expect(NumberFormatter.formatCompact(1500000, 'en-US')).toBe('1.5M');
      expect(NumberFormatter.formatCompact(1000000000, 'en-US')).toBe('1B');
      expect(NumberFormatter.formatCompact(1500000000, 'en-US')).toBe('1.5B');
    });
    
    test('should format large numbers in Japanese (万/億)', () => {
      expect(NumberFormatter.formatCompact(10000, 'ja-JP')).toBe('1万');
      expect(NumberFormatter.formatCompact(15000, 'ja-JP')).toBe('1.5万');
      expect(NumberFormatter.formatCompact(100000000, 'ja-JP')).toBe('1億');
      expect(NumberFormatter.formatCompact(150000000, 'ja-JP')).toBe('1.5億');
    });
    
    test('should handle negative compact numbers', () => {
      expect(NumberFormatter.formatCompact(-10000, 'zh-CN')).toBe('-1万');
      expect(NumberFormatter.formatCompact(-1000000, 'en-US')).toBe('-1M');
    });
    
    test('should not apply compact format for numbers < 10000', () => {
      expect(NumberFormatter.formatCompact(9999, 'zh-CN')).toBe('9,999');
      expect(NumberFormatter.formatCompact(999, 'en-US')).toBe('999');
    });
  });
  
  describe('formatCurrency', () => {
    test('should format gold currency for zh-CN', () => {
      expect(NumberFormatter.formatCurrency(1000, 'gold', 'zh-CN')).toBe('1,000金币');
      expect(NumberFormatter.formatCurrency(10000, 'gold', 'zh-CN')).toBe('1万金币');
      expect(NumberFormatter.formatCurrency(100000000, 'gold', 'zh-CN')).toBe('1亿金币');
    });
    
    test('should format gold currency for en-US', () => {
      expect(NumberFormatter.formatCurrency(1000, 'gold', 'en-US')).toBe('1,000 Gold');
      expect(NumberFormatter.formatCurrency(10000, 'gold', 'en-US')).toBe('10K Gold');
      expect(NumberFormatter.formatCurrency(1000000, 'gold', 'en-US')).toBe('1M Gold');
    });
    
    test('should format gems/diamonds with prefix symbol', () => {
      expect(NumberFormatter.formatCurrency(1000, 'gems', 'en-US')).toBe('💎 1,000');
      expect(NumberFormatter.formatCurrency(10000, 'diamonds', 'en-US')).toBe('💎 10K');
    });
    
    test('should handle negative currency', () => {
      expect(NumberFormatter.formatCurrency(-1000, 'gold', 'zh-CN')).toBe('-1,000金币');
      expect(NumberFormatter.formatCurrency(-10000, 'gold', 'en-US')).toBe('-10K Gold');
    });
    
    test('should support non-compact format', () => {
      expect(NumberFormatter.formatCurrency(100000, 'gold', 'zh-CN', { compact: false })).toBe('100,000金币');
    });
  });
  
  describe('formatPercent', () => {
    test('should format percentage with suffix', () => {
      expect(NumberFormatter.formatPercent(50, 'zh-CN')).toBe('50.0%');
      expect(NumberFormatter.formatPercent(50, 'en-US')).toBe('50.0%');
      expect(NumberFormatter.formatPercent(50, 'ja-JP')).toBe('50.0%');
    });
    
    test('should normalize values from 0-1', () => {
      expect(NumberFormatter.formatPercent(0.5, 'zh-CN', { normalize: true })).toBe('50.0%');
      expect(NumberFormatter.formatPercent(0.123, 'en-US', { normalize: true })).toBe('12.3%');
    });
    
    test('should not normalize values > 1', () => {
      expect(NumberFormatter.formatPercent(50, 'zh-CN', { normalize: true })).toBe('50.0%');
      expect(NumberFormatter.formatPercent(100, 'en-US', { normalize: true })).toBe('100.0%');
    });
    
    test('should respect precision option', () => {
      expect(NumberFormatter.formatPercent(50.567, 'zh-CN', { precision: 2 })).toBe('50.57%');
      expect(NumberFormatter.formatPercent(50.567, 'en-US', { precision: 0 })).toBe('51%');
    });
    
    test('should clamp to 0-100', () => {
      expect(NumberFormatter.formatPercent(150, 'zh-CN')).toBe('100.0%');
      expect(NumberFormatter.formatPercent(-50, 'en-US')).toBe('0.0%');
    });
  });
  
  describe('formatGameValue', () => {
    test('should format power with label', () => {
      expect(NumberFormatter.formatGameValue(1000, 'power', 'zh-CN')).toBe('战力1,000');
      expect(NumberFormatter.formatGameValue(10000, 'power', 'zh-CN')).toBe('战力1万');
      expect(NumberFormatter.formatGameValue(1000, 'power', 'en-US')).toBe('Power 1,000');
      expect(NumberFormatter.formatGameValue(10000, 'power', 'en-US')).toBe('Power 10K');
    });
    
    test('should format exp with label', () => {
      expect(NumberFormatter.formatGameValue(1000, 'exp', 'zh-CN')).toBe('1,000经验');
      expect(NumberFormatter.formatGameValue(100000, 'exp', 'zh-CN')).toBe('10万经验');
      expect(NumberFormatter.formatGameValue(1000, 'exp', 'en-US')).toBe('1,000 EXP');
      expect(NumberFormatter.formatGameValue(10000, 'exp', 'en-US')).toBe('10K EXP');
    });
    
    test('should format damage without label', () => {
      expect(NumberFormatter.formatGameValue(1000, 'damage', 'zh-CN')).toBe('1,000');
      expect(NumberFormatter.formatGameValue(10000, 'damage', 'en-US')).toBe('10K');
    });
    
    test('should format HP with label', () => {
      expect(NumberFormatter.formatGameValue(100, 'hp', 'zh-CN')).toBe('100');
      expect(NumberFormatter.formatGameValue(100, 'hp', 'en-US')).toBe('HP 100');
    });
    
    test('should format level with prefix label', () => {
      expect(NumberFormatter.formatGameValue(50, 'level', 'zh-CN')).toBe('Lv.50');
      expect(NumberFormatter.formatGameValue(50, 'level', 'en-US')).toBe('Lv.50');
    });
    
    test('should format catch rate with percent suffix', () => {
      expect(NumberFormatter.formatGameValue(0.5, 'catchRate', 'zh-CN')).toBe('50.0%');
      expect(NumberFormatter.formatGameValue(0.123, 'catchRate', 'en-US')).toBe('12.3%');
    });
    
    test('should handle negative game values', () => {
      expect(NumberFormatter.formatGameValue(-1000, 'power', 'zh-CN')).toBe('-战力1,000');
      expect(NumberFormatter.formatGameValue(-10000, 'exp', 'en-US')).toBe('-10K EXP');
    });
  });
  
  describe('formatDistance', () => {
    test('should format meters without unit conversion', () => {
      expect(NumberFormatter.formatDistance(500, 'zh-CN')).toBe('500米');
      expect(NumberFormatter.formatDistance(500, 'en-US')).toBe('500 m');
      expect(NumberFormatter.formatDistance(500, 'ja-JP')).toBe('500米');
    });
    
    test('should format kilometers with conversion', () => {
      expect(NumberFormatter.formatDistance(1000, 'zh-CN')).toBe('1.0公里');
      expect(NumberFormatter.formatDistance(1500, 'zh-CN')).toBe('1.5公里');
      expect(NumberFormatter.formatDistance(1000, 'en-US')).toBe('1.0 km');
      expect(NumberFormatter.formatDistance(1500, 'en-US')).toBe('1.5 km');
    });
    
    test('should handle large distances', () => {
      expect(NumberFormatter.formatDistance(10000, 'zh-CN')).toBe('10.0公里');
      expect(NumberFormatter.formatDistance(100000, 'en-US')).toBe('100.0 km');
    });
    
    test('should handle negative distances', () => {
      expect(NumberFormatter.formatDistance(-1000, 'zh-CN')).toBe('-1.0公里');
      expect(NumberFormatter.formatDistance(-500, 'en-US')).toBe('-500 m');
    });
    
    test('should respect precision option', () => {
      expect(NumberFormatter.formatDistance(1234, 'zh-CN', { precision: 2 })).toBe('1.23公里');
      expect(NumberFormatter.formatDistance(1234, 'en-US', { precision: 0 })).toBe('1 km');
    });
    
    test('should force specific unit', () => {
      expect(NumberFormatter.formatDistance(1000, 'zh-CN', { unit: 'km' })).toBe('1.0公里');
      expect(NumberFormatter.formatDistance(1000, 'zh-CN', { unit: 'm' })).toBe('1,000米');
    });
  });
  
  describe('formatDuration', () => {
    test('should format seconds', () => {
      expect(NumberFormatter.formatDuration(30, 'zh-CN')).toBe('30秒');
      expect(NumberFormatter.formatDuration(30, 'en-US')).toBe('30s');
      expect(NumberFormatter.formatDuration(30, 'ja-JP')).toBe('30秒');
    });
    
    test('should format minutes and seconds', () => {
      expect(NumberFormatter.formatDuration(90, 'zh-CN')).toBe('1分钟30秒');
      expect(NumberFormatter.formatDuration(90, 'en-US')).toBe('1m 30s');
      expect(NumberFormatter.formatDuration(90, 'ja-JP')).toBe('1分30秒');
    });
    
    test('should format hours, minutes and seconds', () => {
      expect(NumberFormatter.formatDuration(3665, 'zh-CN')).toBe('1小时1分钟5秒');
      expect(NumberFormatter.formatDuration(3665, 'en-US')).toBe('1h 1m 5s');
      expect(NumberFormatter.formatDuration(3665, 'ja-JP')).toBe('1時間1分5秒');
    });
    
    test('should handle zero duration', () => {
      expect(NumberFormatter.formatDuration(0, 'zh-CN')).toBe('0秒');
      expect(NumberFormatter.formatDuration(0, 'en-US')).toBe('0s');
      expect(NumberFormatter.formatDuration(0, 'ja-JP')).toBe('0秒');
    });
    
    test('should handle negative duration', () => {
      expect(NumberFormatter.formatDuration(-1, 'zh-CN')).toBe('0秒');
      expect(NumberFormatter.formatDuration(-100, 'en-US')).toBe('0s');
    });
    
    test('should handle invalid input', () => {
      expect(NumberFormatter.formatDuration(null, 'zh-CN')).toBe('0秒');
      expect(NumberFormatter.formatDuration('abc', 'en-US')).toBe('0s');
      expect(NumberFormatter.formatDuration(NaN, 'ja-JP')).toBe('0秒');
    });
  });
  
  describe('formatCountdown', () => {
    test('should format MM:SS for < 1 hour', () => {
      expect(NumberFormatter.formatCountdown(90, 'zh-CN')).toBe('01:30');
      expect(NumberFormatter.formatCountdown(90, 'en-US')).toBe('01:30');
      expect(NumberFormatter.formatCountdown(5, 'ja-JP')).toBe('00:05');
    });
    
    test('should format HH:MM:SS for >= 1 hour', () => {
      expect(NumberFormatter.formatCountdown(3665, 'zh-CN')).toBe('01:01:05');
      expect(NumberFormatter.formatCountdown(3665, 'en-US')).toBe('01:01:05');
    });
    
    test('should show hours with showHours option', () => {
      expect(NumberFormatter.formatCountdown(90, 'zh-CN', { showHours: true })).toBe('00:01:30');
    });
    
    test('should handle zero countdown', () => {
      expect(NumberFormatter.formatCountdown(0, 'zh-CN')).toBe('00:00');
    });
    
    test('should handle negative countdown', () => {
      expect(NumberFormatter.formatCountdown(-100, 'en-US')).toBe('00:00');
    });
  });
  
  describe('formatBatch', () => {
    test('should batch format multiple values', () => {
      const items = [
        { value: 10000, type: 'currency', currency: 'gold' },
        { value: 0.5, type: 'percent' },
        { value: 1000, type: 'distance' },
        { value: 90, type: 'duration' },
        { value: 100000, type: 'gameValue', valueType: 'exp' }
      ];
      
      const results = NumberFormatter.formatBatch(items, 'zh-CN');
      expect(results[0]).toBe('1万金币');
      expect(results[1]).toBe('50.0%');
      expect(results[2]).toBe('1.0公里');
      expect(results[3]).toBe('1分钟30秒');
      expect(results[4]).toBe('10万经验');
    });
    
    test('should default to number formatting', () => {
      const items = [
        { value: 1234 },
        { value: 5678 }
      ];
      
      const results = NumberFormatter.formatBatch(items, 'en-US');
      expect(results[0]).toBe('1,234');
      expect(results[1]).toBe('5,678');
    });
  });
});

describe('numberFormatMiddleware', () => {
  test('should attach formatter functions to request', () => {
    const req = { headers: {}, language: 'zh-CN' };
    const res = { json: jest.fn() };
    const next = jest.fn();
    
    numberFormatMiddleware(req, res, next);
    
    expect(req.formatNumber).toBeDefined();
    expect(req.formatCurrency).toBeDefined();
    expect(req.formatPercent).toBeDefined();
    expect(req.formatGameValue).toBeDefined();
    expect(req.numberFormatter).toBeDefined();
    expect(next).toHaveBeenCalled();
  });
  
  test('should format response numbers', () => {
    const req = { headers: {}, language: 'zh-CN' };
    const res = {};
    const next = jest.fn();
    
    numberFormatMiddleware(req, res, next);
    
    const testData = { gold: 10000, exp: 100000 };
    res.json(testData);
    
    // Response should be formatted (middleware wraps res.json)
    expect(next).toHaveBeenCalled();
  });
});

describe('createNumberFormatContext', () => {
  test('should create formatting context for zh-CN', () => {
    const context = createNumberFormatContext('zh-CN');
    
    expect(context.formatNumber(10000)).toBe('1万');
    expect(context.formatCurrency(10000, 'gold')).toBe('1万金币');
    expect(context.formatPercent(50)).toBe('50.0%');
    expect(context.locale).toBe('zh-CN');
  });
  
  test('should create formatting context for en-US', () => {
    const context = createNumberFormatContext('en-US');
    
    expect(context.formatNumber(10000)).toBe('10K');
    expect(context.formatCurrency(10000, 'gold')).toBe('10K Gold');
    expect(context.formatPercent(50)).toBe('50.0%');
    expect(context.locale).toBe('en-US');
  });
});

describe('formattedLogger', () => {
  describe('formatLogMessage', () => {
    test('should format large numbers in log messages', () => {
      const message = 'User gained 100000 exp points';
      const formatted = formatLogMessage(message, 'en-US');
      expect(formatted).toBe('User gained 100K exp points');
    });
    
    test('should format currency in log messages', () => {
      const message = 'Player spent 5000 gold on items';
      const formatted = formatLogMessage(message, 'en-US');
      expect(formatted).toBe('Player spent 5K Gold on items');
    });
    
    test('should format duration in log messages', () => {
      const message = 'Cooldown active for 3600 seconds';
      const formatted = formatLogMessage(message, 'en-US');
      expect(formatted).toBe('Cooldown active for 1h');
    });
    
    test('should format distance in log messages', () => {
      const message = 'Player moved 1500 meters';
      const formatted = formatLogMessage(message, 'en-US');
      expect(formatted).toBe('Player moved 1.5 km');
    });
    
    test('should format damage in log messages', () => {
      const message = 'Attack dealt 50000 damage';
      const formatted = formatLogMessage(message, 'en-US');
      expect(formatted).toBe('Attack dealt 50K damage');
    });
  });
  
  test('should create formatted logger wrapper', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    const formattedLogger = createFormattedLogger(mockLogger, 'en-US');
    
    formattedLogger.info('User gained 100000 exp');
    expect(mockLogger.info).toHaveBeenCalledWith('User gained 100K exp');
    
    formattedLogger.warn('Cooldown active for 1800 seconds');
    expect(mockLogger.warn).toHaveBeenCalledWith('Cooldown active for 30m');
  });
});

describe('Configuration', () => {
  test('should have correct default language', () => {
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
  });
  
  test('should have supported languages', () => {
    expect(SUPPORTED_LANGUAGES).toContain('zh-CN');
    expect(SUPPORTED_LANGUAGES).toContain('en-US');
    expect(SUPPORTED_LANGUAGES).toContain('ja-JP');
  });
  
  test('should have format configs for all supported languages', () => {
    expect(FORMAT_CONFIGS['zh-CN']).toBeDefined();
    expect(FORMAT_CONFIGS['en-US']).toBeDefined();
    expect(FORMAT_CONFIGS['ja-JP']).toBeDefined();
  });
  
  test('should have correct thousand separator configs', () => {
    expect(FORMAT_CONFIGS['zh-CN'].thousandSeparator).toBe(',');
    expect(FORMAT_CONFIGS['en-US'].thousandSeparator).toBe(',');
    expect(FORMAT_CONFIGS['ja-JP'].thousandSeparator).toBe(',');
  });
  
  test('should have compact thresholds for each language', () => {
    expect(FORMAT_CONFIGS['zh-CN'].compact.thresholds).toBeDefined();
    expect(FORMAT_CONFIGS['zh-CN'].compact.thresholds.length).toBeGreaterThan(0);
    
    expect(FORMAT_CONFIGS['en-US'].compact.thresholds).toBeDefined();
    expect(FORMAT_CONFIGS['en-US'].compact.thresholds.length).toBeGreaterThan(0);
    
    expect(FORMAT_CONFIGS['ja-JP'].compact.thresholds).toBeDefined();
    expect(FORMAT_CONFIGS['ja-JP'].compact.thresholds.length).toBeGreaterThan(0);
  });
});

describe('Performance', () => {
  test('should format 1000 numbers in < 50ms', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      value: i * 100,
      type: 'currency',
      currency: 'gold'
    }));
    
    const start = Date.now();
    const results = NumberFormatter.formatBatch(items, 'zh-CN');
    const duration = Date.now() - start;
    
    expect(results.length).toBe(1000);
    expect(duration).toBeLessThan(50);
  });
  
  test('should format log message quickly', () => {
    const message = 'User spent 10000 gold and gained 500000 exp after walking 2000 meters for 1800 seconds';
    
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      formatLogMessage(message, 'en-US');
    }
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(50);
  });
});