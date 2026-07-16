/**
 * Unit Tests for Currency Localizer
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 */

'use strict';

const assert = require('assert');
const { GameCurrencyLocalizer, GAME_CURRENCIES } = require('../GameCurrencyLocalizer');
const createMagnitudeAbbreviator = require('../MagnitudeAbbreviator');
const { RegionalTaxCalculator, REGIONAL_TAX_CONFIG } = require('../RegionalTaxCalculator');
const { RegionalPricingService, PPP_ADJUSTMENT_FACTORS, PSYCHOLOGICAL_LEVELS } = require('../RegionalPricingService');

// ====== GameCurrencyLocalizer Tests ======

describe('GameCurrencyLocalizer', () => {
  describe('constructor', () => {
    it('should default to zh-CN locale', () => {
      const localizer = new GameCurrencyLocalizer();
      assert.strictEqual(localizer.locale, 'zh-CN');
    });

    it('should accept custom locale', () => {
      const localizer = new GameCurrencyLocalizer('en-US');
      assert.strictEqual(localizer.locale, 'en-US');
    });
  });

  describe('format', () => {
    it('should format coins in Chinese', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(100, 'COINS', { useAbbreviation: false });
      assert.strictEqual(result, '100 金币');
    });

    it('should format coins in English', () => {
      const localizer = new GameCurrencyLocalizer('en-US');
      const result = localizer.format(100, 'COINS', { useAbbreviation: false });
      assert.strictEqual(result, '100 Coins');
    });

    it('should format coins in Japanese', () => {
      const localizer = new GameCurrencyLocalizer('ja-JP');
      const result = localizer.format(100, 'COINS', { useAbbreviation: false });
      assert.strictEqual(result, '100 コイン');
    });

    it('should format large numbers with abbreviation in Chinese', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(12000, 'COINS', { useAbbreviation: true });
      assert.ok(result.includes('万'));
      assert.ok(result.includes('金币'));
    });

    it('should format large numbers with abbreviation in English', () => {
      const localizer = new GameCurrencyLocalizer('en-US');
      const result = localizer.format(1200000, 'COINS', { useAbbreviation: true });
      assert.ok(result.includes('M'));
    });

    it('should format pokecoins with prefix symbol', () => {
      const localizer = new GameCurrencyLocalizer('en-US');
      const result = localizer.format(500, 'POKECOINS', { useAbbreviation: false });
      assert.ok(result.includes('₽'));
    });

    it('should show full number when showFullNumber is true', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(12000, 'COINS', { showFullNumber: true });
      assert.ok(result.includes('12,000') || result.includes('12000'));
      assert.ok(!result.includes('万'));
    });

    it('should hide symbol when showSymbol is false', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(100, 'COINS', { showSymbol: false, useAbbreviation: false });
      assert.strictEqual(result, '100');
    });

    it('should not abbreviate below threshold', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(9999, 'COINS', { minAbbreviationThreshold: 10000 });
      assert.ok(!result.includes('万'));
    });

    it('should return raw number for unknown currency', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.format(100, 'UNKNOWN_CURRENCY');
      assert.strictEqual(result, '100');
    });
  });

  describe('formatNumber', () => {
    it('should format numbers with locale', () => {
      const localizer = new GameCurrencyLocalizer('en-US');
      const result = localizer.formatNumber(1234567);
      assert.ok(result.includes('1,234,567') || result.includes('1234567'));
    });
  });

  describe('getCurrencyName', () => {
    it('should return localized name for coins', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      assert.strictEqual(localizer.getCurrencyName('COINS'), '金币');
    });

    it('should return English fallback', () => {
      const localizer = new GameCurrencyLocalizer('ar-SA');
      assert.strictEqual(localizer.getCurrencyName('COINS'), 'Coins');
    });

    it('should return currency type for unknown', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      assert.strictEqual(localizer.getCurrencyName('UNKNOWN'), 'UNKNOWN');
    });
  });

  describe('getAllCurrenciesInfo', () => {
    it('should return all currencies with localized names', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const info = localizer.getAllCurrenciesInfo();
      assert.ok(Array.isArray(info));
      assert.ok(info.length > 0);
      assert.ok(info.find(c => c.id === 'COINS'));
      assert.strictEqual(info.find(c => c.id === 'COINS').name, '金币');
    });
  });

  describe('parseInput', () => {
    it('should parse simple number', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.parseInput('100', 'COINS');
      assert.strictEqual(result, 100);
    });

    it('should return null for invalid input', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.parseInput('abc', 'COINS');
      assert.strictEqual(result, null);
    });
  });

  describe('formatMultiple', () => {
    it('should format multiple currencies at once', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.formatMultiple({ COINS: 100, STARDUST: 50 }, { useAbbreviation: false });
      assert.ok(result.COINS);
      assert.ok(result.STARDUST);
    });
  });

  describe('compare', () => {
    it('should compare two amounts of same currency', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.compare(100, 'COINS', 200, 'COINS');
      assert.ok(result < 0);
    });

    it('should compare amounts of different currencies', () => {
      const localizer = new GameCurrencyLocalizer('zh-CN');
      const result = localizer.compare(100, 'POKECOINS', 100, 'COINS');
      assert.ok(result > 0);
    });
  });
});

// ====== MagnitudeAbbreviator Tests ======

describe('MagnitudeAbbreviator', () => {
  describe('Chinese locale', () => {
    const abbreviator = createMagnitudeAbbreviator('zh-CN');

    it('should abbreviate 10000 as 1万', () => {
      assert.strictEqual(abbreviator.abbreviate(10000), '1万');
    });

    it('should abbreviate 12000 as 1.2万', () => {
      assert.strictEqual(abbreviator.abbreviate(12000), '1.2万');
    });

    it('should abbreviate 100000000 as 1亿', () => {
      assert.strictEqual(abbreviator.abbreviate(100000000), '1亿');
    });

    it('should abbreviate 120000000 as 1.2亿', () => {
      assert.strictEqual(abbreviator.abbreviate(120000000), '1.2亿');
    });

    it('should not abbreviate numbers below 1000', () => {
      const result = abbreviator.abbreviate(999);
      assert.ok(!result.includes('万'));
    });
  });

  describe('English locale', () => {
    const abbreviator = createMagnitudeAbbreviator('en-US');

    it('should abbreviate 1000 as 1K', () => {
      assert.strictEqual(abbreviator.abbreviate(1000), '1K');
    });

    it('should abbreviate 1200 as 1.2K', () => {
      assert.strictEqual(abbreviator.abbreviate(1200), '1.2K');
    });

    it('should abbreviate 1000000 as 1M', () => {
      assert.strictEqual(abbreviator.abbreviate(1000000), '1M');
    });

    it('should abbreviate 1000000000 as 1B', () => {
      assert.strictEqual(abbreviator.abbreviate(1000000000), '1B');
    });

    it('should abbreviate 1000000000000 as 1T', () => {
      assert.strictEqual(abbreviator.abbreviate(1000000000000), '1T');
    });
  });

  describe('Japanese locale', () => {
    const abbreviator = createMagnitudeAbbreviator('ja-JP');

    it('should abbreviate 10000 as 1万', () => {
      assert.strictEqual(abbreviator.abbreviate(10000), '1万');
    });

    it('should abbreviate 100000000 as 1億', () => {
      assert.strictEqual(abbreviator.abbreviate(100000000), '1億');
    });
  });

  describe('Korean locale', () => {
    const abbreviator = createMagnitudeAbbreviator('ko-KR');

    it('should abbreviate 10000 as 1만', () => {
      assert.strictEqual(abbreviator.abbreviate(10000), '1만');
    });

    it('should abbreviate 100000000 as 1억', () => {
      assert.strictEqual(abbreviator.abbreviate(100000000), '1억');
    });
  });

  describe('German locale', () => {
    const abbreviator = createMagnitudeAbbreviator('de-DE');

    it('should abbreviate 1000 as 1Tsd.', () => {
      assert.strictEqual(abbreviator.abbreviate(1000), '1Tsd.');
    });

    it('should abbreviate 1000000 as 1Mio.', () => {
      assert.strictEqual(abbreviator.abbreviate(1000000), '1Mio.');
    });
  });

  describe('parseAbbreviated', () => {
    const abbreviator = createMagnitudeAbbreviator('en-US');

    it('should parse K suffix', () => {
      assert.strictEqual(abbreviator.parseAbbreviated('1.5K'), 1500);
    });

    it('should parse M suffix', () => {
      assert.strictEqual(abbreviator.parseAbbreviated('2.5M'), 2500000);
    });

    it('should parse plain number', () => {
      assert.strictEqual(abbreviator.parseAbbreviated('12345'), 12345);
    });

    it('should return null for invalid input', () => {
      assert.strictEqual(abbreviator.parseAbbreviated('abc'), null);
    });
  });

  describe('getExamples', () => {
    it('should return example abbreviations', () => {
      const abbreviator = createMagnitudeAbbreviator('zh-CN');
      const examples = abbreviator.getExamples();
      assert.ok(examples.thousand);
      assert.ok(examples.million);
      assert.ok(examples.billion);
      assert.ok(examples.trillion);
    });
  });

  describe('fallback', () => {
    it('should fallback to en-US for unknown locale', () => {
      const abbreviator = createMagnitudeAbbreviator('xx-XX');
      const result = abbreviator.abbreviate(1000);
      assert.strictEqual(result, '1K');
    });
  });
});

// ====== RegionalTaxCalculator Tests ======

describe('RegionalTaxCalculator', () => {
  describe('Japan tax', () => {
    it('should calculate 10% JCT for Japan', () => {
      const calc = new RegionalTaxCalculator('JP', 'ja-JP');
      const result = calc.calculateTaxInclusivePrice(1000);
      assert.strictEqual(result.taxRate, 0.10);
      assert.strictEqual(result.taxAmount, 100);
      assert.strictEqual(result.totalPrice, 1100);
      assert.strictEqual(result.displayMode, 'tax_inclusive');
    });

    it('should show Japanese tax label', () => {
      const calc = new RegionalTaxCalculator('JP', 'ja-JP');
      const label = calc.getTaxLabel();
      assert.strictEqual(label, '（税込）');
    });

    it('should require breakdown for Japan', () => {
      const calc = new RegionalTaxCalculator('JP');
      assert.strictEqual(calc.shouldShowBreakdown(), true);
    });
  });

  describe('EU VAT', () => {
    it('should calculate 19% VAT for Germany', () => {
      const calc = new RegionalTaxCalculator('DE');
      const result = calc.calculateTaxInclusivePrice(100);
      assert.strictEqual(result.taxRate, 0.19);
      assert.strictEqual(result.taxAmount, 19);
    });

    it('should calculate 20% VAT for France', () => {
      const calc = new RegionalTaxCalculator('FR');
      const result = calc.calculateTaxInclusivePrice(100);
      assert.strictEqual(result.taxRate, 0.20);
      assert.strictEqual(result.taxAmount, 20);
    });

    it('should calculate 20% VAT for UK', () => {
      const calc = new RegionalTaxCalculator('GB');
      const result = calc.calculateTaxInclusivePrice(100);
      assert.strictEqual(result.taxRate, 0.20);
    });
  });

  describe('US sales tax', () => {
    it('should return 0 for US without state', () => {
      const calc = new RegionalTaxCalculator('US');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0);
    });

    it('should calculate CA state tax', () => {
      const calc = new RegionalTaxCalculator('US', 'en-US', 'CA');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0.0825);
    });

    it('should calculate NY state tax', () => {
      const calc = new RegionalTaxCalculator('US', 'en-US', 'NY');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0.08);
    });

    it('should not require breakdown for US', () => {
      const calc = new RegionalTaxCalculator('US');
      assert.strictEqual(calc.shouldShowBreakdown(), false);
    });
  });

  describe('Canada GST/PST', () => {
    it('should calculate ON HST 13%', () => {
      const calc = new RegionalTaxCalculator('CA', 'en-CA', 'ON');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0.13);
    });

    it('should calculate AB GST 5%', () => {
      const calc = new RegionalTaxCalculator('CA', 'en-CA', 'AB');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0.05);
    });
  });

  describe('China VAT', () => {
    it('should calculate 6% VAT for China', () => {
      const calc = new RegionalTaxCalculator('CN', 'zh-CN');
      const result = calc.calculateTaxInclusivePrice(100);
      assert.strictEqual(result.taxRate, 0.06);
      assert.strictEqual(result.taxAmount, 6);
    });
  });

  describe('Unknown country', () => {
    it('should return 0 tax for unknown country', () => {
      const calc = new RegionalTaxCalculator('XX');
      assert.strictEqual(calc.getEffectiveTaxRate(), 0);
    });
  });

  describe('getPriceBreakdown', () => {
    it('should return null for zero tax rate', () => {
      const calc = new RegionalTaxCalculator('US');
      const result = calc.getPriceBreakdown({ taxRate: 0 });
      assert.strictEqual(result, null);
    });

    it('should return breakdown lines for taxed price', () => {
      const calc = new RegionalTaxCalculator('JP');
      const taxInfo = calc.calculateTaxInclusivePrice(1000);
      const breakdown = calc.getPriceBreakdown(taxInfo);
      assert.ok(breakdown);
      assert.strictEqual(breakdown.lines.length, 3);
      assert.ok(breakdown.lines.find(l => l.isTotal));
    });
  });

  describe('calculateTaxFromTotal', () => {
    it('should reverse calculate base price from total', () => {
      const calc = new RegionalTaxCalculator('JP');
      const result = calc.calculateTaxFromTotal(1100);
      assert.strictEqual(result.basePrice, 1000);
      assert.strictEqual(result.taxAmount, 100);
    });
  });

  describe('formatPriceDisplay', () => {
    it('should format price with tax label', () => {
      const calc = new RegionalTaxCalculator('JP', 'ja-JP');
      const result = calc.formatPriceDisplay(1000, (p) => `¥${p}`);
      assert.ok(result.displayPrice);
      assert.ok(result.taxLabel);
    });
  });
});

// ====== RegionalPricingService Tests ======

describe('RegionalPricingService', () => {
  let service;

  beforeEach(() => {
    service = new RegionalPricingService();
  });

  describe('getBasePrice', () => {
    it('should return price for known product', () => {
      assert.strictEqual(service.getBasePrice('coins_100'), 0.99);
    });

    it('should return null for unknown product', () => {
      assert.strictEqual(service.getBasePrice('unknown_product'), null);
    });
  });

  describe('roundToPsychologicalPrice', () => {
    it('should round USD to .99', () => {
      const result = service.roundToPsychologicalPrice(4.50, 'USD');
      assert.strictEqual(result, 4.99);
    });

    it('should round JPY to nearest level', () => {
      const result = service.roundToPsychologicalPrice(450, 'JPY');
      assert.ok(result <= 500);
    });

    it('should round CNY to game pricing', () => {
      const result = service.roundToPsychologicalPrice(6.5, 'CNY');
      assert.ok([6, 30, 68, 98, 128, 198, 328, 648].includes(result));
    });
  });

  describe('getProductPrice', () => {
    it('should return pricing for US product', async () => {
      const result = await service.getProductPrice('coins_100', 'US', 'USD');
      assert.ok(result);
      assert.strictEqual(result.productId, 'coins_100');
      assert.strictEqual(result.country, 'US');
      assert.strictEqual(result.currency, 'USD');
    });

    it('should apply PPP adjustment for China', async () => {
      const result = await service.getProductPrice('coins_100', 'CN', 'CNY');
      assert.ok(result);
      assert.strictEqual(result.pppFactor, 0.42);
      assert.strictEqual(result.strategy, 'PPP');
    });

    it('should return null for unknown product', async () => {
      const result = await service.getProductPrice('unknown', 'US', 'USD');
      assert.strictEqual(result, null);
    });

    it('should cache results', async () => {
      const result1 = await service.getProductPrice('coins_100', 'US', 'USD');
      const result2 = await service.getProductPrice('coins_100', 'US', 'USD');
      assert.deepStrictEqual(result1, result2);
    });
  });

  describe('getRecommendedPackages', () => {
    it('should return recommendations with bestValue', async () => {
      const result = await service.getRecommendedPackages('user1', 'US', 'USD');
      assert.ok(result.recommended);
      assert.ok(result.popular);
      assert.ok(result.all);
    });
  });

  describe('getSupportedCurrencies', () => {
    it('should return list of supported currencies', () => {
      const currencies = service.getSupportedCurrencies();
      assert.ok(Array.isArray(currencies));
      assert.ok(currencies.includes('USD'));
      assert.ok(currencies.includes('CNY'));
      assert.ok(currencies.includes('JPY'));
    });
  });

  describe('getSupportedCountries', () => {
    it('should return list of supported countries', () => {
      const countries = service.getSupportedCountries();
      assert.ok(Array.isArray(countries));
      assert.ok(countries.includes('US'));
      assert.ok(countries.includes('CN'));
      assert.ok(countries.includes('JP'));
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', async () => {
      await service.getProductPrice('coins_100', 'US', 'USD');
      service.clearCache();
      assert.strictEqual(service.cache.size, 0);
    });
  });
});

// ====== GAME_CURRENCIES Tests ======

describe('GAME_CURRENCIES', () => {
  it('should have COINS currency', () => {
    assert.ok(GAME_CURRENCIES.COINS);
    assert.ok(GAME_CURRENCIES.COINS.names['zh-CN']);
    assert.ok(GAME_CURRENCIES.COINS.names['en-US']);
    assert.ok(GAME_CURRENCIES.COINS.names['ja-JP']);
  });

  it('should have all 6 currency types', () => {
    const keys = Object.keys(GAME_CURRENCIES);
    assert.ok(keys.length >= 6);
    assert.ok(keys.includes('COINS'));
    assert.ok(keys.includes('POKECOINS'));
    assert.ok(keys.includes('STARDUST'));
    assert.ok(keys.includes('CANDY'));
    assert.ok(keys.includes('GOLDEN_RASPBERRY'));
    assert.ok(keys.includes('PREMIUM_PASS'));
  });
});

// ====== REGIONAL_TAX_CONFIG Tests ======

describe('REGIONAL_TAX_CONFIG', () => {
  it('should have tax config for major regions', () => {
    assert.ok(REGIONAL_TAX_CONFIG['JP']);
    assert.ok(REGIONAL_TAX_CONFIG['US']);
    assert.ok(REGIONAL_TAX_CONFIG['DE']);
    assert.ok(REGIONAL_TAX_CONFIG['CN']);
    assert.ok(REGIONAL_TAX_CONFIG['KR']);
    assert.ok(REGIONAL_TAX_CONFIG['GB']);
  });

  it('should have correct tax type for each country', () => {
    assert.strictEqual(REGIONAL_TAX_CONFIG['JP'].taxType, 'JCT');
    assert.strictEqual(REGIONAL_TAX_CONFIG['DE'].taxType, 'VAT');
    assert.strictEqual(REGIONAL_TAX_CONFIG['US'].taxType, 'SALES_TAX');
    assert.strictEqual(REGIONAL_TAX_CONFIG['CN'].taxType, 'VAT');
    assert.strictEqual(REGIONAL_TAX_CONFIG['AU'].taxType, 'GST');
  });

  it('should have more than 10 countries configured', () => {
    assert.ok(Object.keys(REGIONAL_TAX_CONFIG).length >= 10);
  });
});

// ====== Integration Tests ======

describe('Currency Localization Integration', () => {
  it('should format Chinese coins with 万 abbreviation', () => {
    const localizer = new GameCurrencyLocalizer('zh-CN');
    const result = localizer.format(25000, 'COINS');
    assert.ok(result.includes('万'));
    assert.ok(result.includes('金币'));
  });

  it('should format English coins with K abbreviation', () => {
    const localizer = new GameCurrencyLocalizer('en-US');
    const result = localizer.format(2500, 'COINS');
    assert.ok(result.includes('K'));
    assert.ok(result.includes('Coins'));
  });

  it('should format Japanese stardust with 万 abbreviation', () => {
    const localizer = new GameCurrencyLocalizer('ja-JP');
    const result = localizer.format(30000, 'STARDUST');
    assert.ok(result.includes('万'));
    assert.ok(result.includes('ほしのすな'));
  });

  it('should calculate tax for Japanese purchase', () => {
    const localizer = new GameCurrencyLocalizer('ja-JP');
    const taxCalc = new RegionalTaxCalculator('JP', 'ja-JP');

    const price = 1000;
    const formatted = localizer.format(price, 'COINS', { useAbbreviation: false });
    const taxInfo = taxCalc.calculateTaxInclusivePrice(price);

    assert.ok(formatted.includes('コイン'));
    assert.strictEqual(taxInfo.taxRate, 0.10);
    assert.ok(taxInfo.label.includes('税込'));
  });

  it('should get full pricing pipeline for Chinese user', async () => {
    const localizer = new GameCurrencyLocalizer('zh-CN');
    const pricingService = new RegionalPricingService();
    const taxCalc = new RegionalTaxCalculator('CN', 'zh-CN');

    const pricing = await pricingService.getProductPrice('coins_1200', 'CN', 'CNY');
    const taxInfo = taxCalc.calculateTaxInclusivePrice(pricing.price);
    const formatted = localizer.format(pricing.price, 'COINS', { useAbbreviation: false });

    assert.ok(pricing.pppFactor < 1);
    assert.strictEqual(taxInfo.taxRate, 0.06);
    assert.ok(formatted.includes('金币'));
  });
});

// Run tests
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}