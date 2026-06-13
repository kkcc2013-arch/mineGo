// backend/tests/unit/contentLocalizer.test.js
// Unit tests for REQ-00167: Content Localizer
'use strict';

const { describe, it, expect, beforeEach, afterEach, mock } = require('bun:test');
const { ContentLocalizer, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../../shared/contentLocalizer');

// Mock database and cache
const mockDb = {
  query: mock(() => Promise.resolve({ rows: [] }))
};

const mockCache = {
  get: mock(() => Promise.resolve(null)),
  set: mock(() => Promise.resolve('OK')),
  del: mock(() => Promise.resolve(1))
};

describe('ContentLocalizer', () => {
  let localizer;

  beforeEach(() => {
    localizer = new ContentLocalizer(mockDb, mockCache);
    mockDb.query.mockClear();
    mockCache.get.mockClear();
    mockCache.set.mockClear();
  });

  describe('normalizeLanguage', () => {
    it('should return default language for null input', () => {
      expect(localizer.normalizeLanguage(null)).toBe('zh-CN');
    });

    it('should normalize zh variants to zh-CN', () => {
      expect(localizer.normalizeLanguage('zh')).toBe('zh-CN');
      expect(localizer.normalizeLanguage('zh-TW')).toBe('zh-CN');
      expect(localizer.normalizeLanguage('ZH-CN')).toBe('zh-CN');
    });

    it('should normalize en variants to en-US', () => {
      expect(localizer.normalizeLanguage('en')).toBe('en-US');
      expect(localizer.normalizeLanguage('en-GB')).toBe('en-US');
      expect(localizer.normalizeLanguage('EN-US')).toBe('en-US');
    });

    it('should normalize ja variants to ja-JP', () => {
      expect(localizer.normalizeLanguage('ja')).toBe('ja-JP');
      expect(localizer.normalizeLanguage('ja-JP')).toBe('ja-JP');
      expect(localizer.normalizeLanguage('JA')).toBe('ja-JP');
    });

    it('should return default for unsupported languages', () => {
      expect(localizer.normalizeLanguage('fr')).toBe('zh-CN');
      expect(localizer.normalizeLanguage('de')).toBe('zh-CN');
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return array of supported languages', () => {
      const langs = localizer.getSupportedLanguages();
      expect(Array.isArray(langs)).toBe(true);
      expect(langs).toContain('zh-CN');
      expect(langs).toContain('en-US');
      expect(langs).toContain('ja-JP');
    });
  });

  describe('getLocalized', () => {
    it('should return cached value if available', async () => {
      mockCache.get.mockReturnValueOnce(Promise.resolve('ピカチュウ'));
      
      const result = await localizer.getLocalized('pokemon', '25', 'name', 'ja-JP');
      
      expect(result).toBe('ピカチュウ');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('should query database when cache miss', async () => {
      mockCache.get.mockReturnValueOnce(Promise.resolve(null));
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{ translation: 'ピカチュウ' }]
      }));
      
      const result = await localizer.getLocalized('pokemon', '25', 'name', 'ja-JP');
      
      expect(result).toBe('ピカチュウ');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT translation'),
        ['pokemon', '25', 'name', 'ja-JP']
      );
    });

    it('should cache the result after database query', async () => {
      mockCache.get.mockReturnValueOnce(Promise.resolve(null));
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{ translation: 'ピカチュウ' }]
      }));
      
      await localizer.getLocalized('pokemon', '25', 'name', 'ja-JP');
      
      expect(mockCache.set).toHaveBeenCalledWith(
        'loc:pokemon:25:name:ja-JP',
        'ピカチュウ',
        86400
      );
    });

    it('should return null when translation not found', async () => {
      mockCache.get.mockReturnValueOnce(Promise.resolve(null));
      mockDb.query.mockReturnValueOnce(Promise.resolve({ rows: [] }));
      
      const result = await localizer.getLocalized('pokemon', '999', 'name', 'ja-JP');
      
      expect(result).toBeNull();
    });
  });

  describe('setLocalization', () => {
    it('should insert new localization', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({ rowCount: 1 }));
      
      const result = await localizer.setLocalization(
        'pokemon', '25', 'name', 'ja-JP', 'ピカチュウ'
      );
      
      expect(result).toBe(true);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO content_localizations'),
        ['pokemon', '25', 'name', 'ja-JP', 'ピカチュウ']
      );
    });

    it('should invalidate cache after update', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({ rowCount: 1 }));
      
      await localizer.setLocalization(
        'pokemon', '25', 'name', 'ja-JP', 'ピカチュウ'
      );
      
      expect(mockCache.del).toHaveBeenCalledWith('loc:pokemon:25:name:ja-JP');
    });
  });

  describe('getLocalizedPokemon', () => {
    it('should return localized Pokemon data', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{
          id: 25,
          name: 'ピカチュウ',
          description: '電気ネズミポケモン',
          type1: 'ELECTRIC',
          type2: null,
          rarity: 'COMMON',
          base_attack: 112,
          base_defense: 96,
          base_hp: 111,
          sprite_url: '/sprites/25.png'
        }]
      }));
      
      const result = await localizer.getLocalizedPokemon(25, 'ja-JP');
      
      expect(result).not.toBeNull();
      expect(result.name).toBe('ピカチュウ');
      expect(result._locale).toBe('ja-JP');
    });
  });

  describe('batchLocalizePokemon', () => {
    it('should return map of localized Pokemon', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [
          { id: 25, name: 'ピカチュウ', type1: 'ELECTRIC' },
          { id: 1, name: 'フシギダネ', type1: 'GRASS' }
        ]
      }));
      
      const result = await localizer.batchLocalizePokemon([25, 1], 'ja-JP');
      
      expect(result.size).toBe(2);
      expect(result.get(25).name).toBe('ピカチュウ');
      expect(result.get(1).name).toBe('フシギダネ');
    });

    it('should return empty map for empty input', async () => {
      const result = await localizer.batchLocalizePokemon([], 'ja-JP');
      
      expect(result.size).toBe(0);
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('getLocalizedItem', () => {
    it('should return localized item data', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{
          id: 'POKE_BALL',
          name: 'モンスターボール',
          description: 'ポケモンを捕まえるための基本的なボール',
          category: 'BALL',
          shop_price: 100
        }]
      }));
      
      const result = await localizer.getLocalizedItem('POKE_BALL', 'ja-JP');
      
      expect(result).not.toBeNull();
      expect(result.name).toBe('モンスターボール');
      expect(result._locale).toBe('ja-JP');
    });
  });

  describe('getLocalizedMove', () => {
    it('should return localized move data', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{
          id: 'THUNDERBOLT',
          name: '１０まんボルト',
          description: '強力な電流を放つ',
          move_type: 'ELECTRIC',
          power: 80
        }]
      }));
      
      const result = await localizer.getLocalizedMove('THUNDERBOLT', 'ja-JP');
      
      expect(result).not.toBeNull();
      expect(result.name).toBe('１０まんボルト');
      expect(result._locale).toBe('ja-JP');
    });
  });

  describe('getLocalizedWithFallback', () => {
    it('should try primary language first', async () => {
      mockCache.get.mockReturnValueOnce(Promise.resolve(null));
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{ translation: 'ピカチュウ' }]
      }));
      
      const result = await localizer.getLocalizedWithFallback('pokemon', '25', 'name', 'ja-JP');
      
      expect(result).toBe('ピカチュウ');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['ja-JP'])
      );
    });

    it('should fallback to default language when primary not found', async () => {
      // Primary language returns null
      mockCache.get.mockReturnValue(Promise.resolve(null));
      mockDb.query.mockReturnValueOnce(Promise.resolve({ rows: [] }));
      // Default language returns result
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [{ translation: 'Pikachu' }]
      }));
      
      const result = await localizer.getLocalizedWithFallback('pokemon', '25', 'name', 'ja-JP');
      
      expect(result).toBe('Pikachu');
    });
  });
});

describe('Constants', () => {
  it('SUPPORTED_LANGUAGES should contain expected values', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en-US', 'ja-JP']);
  });

  it('DEFAULT_LANGUAGE should be zh-CN', () => {
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
  });
});

// Run tests
console.log('✅ ContentLocalizer unit tests completed');
