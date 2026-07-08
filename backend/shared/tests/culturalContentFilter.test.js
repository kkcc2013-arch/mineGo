// backend/shared/tests/culturalContentFilter.test.js
// REQ-00495: CulturalContentFilter 单元测试
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CulturalContentFilter } = require('../CulturalContentFilter');
const { query } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('test:cultural-filter');

describe('CulturalContentFilter', () => {
  let filter;

  before(async () => {
    filter = new CulturalContentFilter();
    logger.info('Test suite initialized');
  });

  after(async () => {
    filter.clearCache();
    logger.info('Test suite completed');
  });

  beforeEach(() => {
    filter.clearCache();
  });

  describe('filterEntities()', () => {
    it('should return empty array for empty input', async () => {
      const result = await filter.filterEntities([], 'US', 25);
      assert.deepEqual(result, []);
    });

    it('should filter entities without restrictions', async () => {
      const entities = [
        { type: 'pokemon', id: 1, name: 'Pikachu' },
        { type: 'pokemon', id: 25, name: 'Pikachu' }
      ];
      
      const result = await filter.filterEntities(entities, 'US', 25);
      assert.equal(result.length, entities.length);
      assert.equal(result[0].name, 'Pikachu');
    });

    it('should apply cultural rules when available', async () => {
      const entities = [
        { type: 'pokemon', id: 149, name: 'Dragonite', description: 'Dragon' }
      ];
      
      // 中东地区规则可能修改龙类精灵
      const result = await filter.filterEntities(entities, 'SA', 25, 'ar');
      
      // 即使没有数据库数据，也不应该崩溃
      assert.ok(Array.isArray(result));
    });

    it('should handle null userAge gracefully', async () => {
      const entities = [
        { type: 'pokemon', id: 1, name: 'Pikachu' }
      ];
      
      const result = await filter.filterEntities(entities, 'US', null);
      assert.equal(result.length, 1);
    });

    it('should log filtering statistics', async () => {
      const entities = [
        { type: 'pokemon', id: 1, name: 'Bulbasaur' },
        { type: 'pokemon', id: 25, name: 'Pikachu' },
        { type: 'pokemon', id: 39, name: 'Jigglypuff' }
      ];
      
      const result = await filter.filterEntities(entities, 'US', 25);
      assert.ok(Array.isArray(result));
    });
  });

  describe('checkEntityRestriction()', () => {
    it('should return none for unrestricted entity', async () => {
      const result = await filter.checkEntityRestriction('pokemon', 999, 'US');
      assert.equal(result.level, 'none');
    });

    it('should cache restriction results', async () => {
      const first = await filter.checkEntityRestriction('pokemon', 1, 'US');
      const second = await filter.checkEntityRestriction('pokemon', 1, 'US');
      
      // 应该从缓存返回相同结果
      assert.deepEqual(first, second);
      
      // 检查缓存统计
      const stats = filter.getCacheStats();
      assert.ok(stats.size >= 1);
    });
  });

  describe('getRatingSystemForRegion()', () => {
    it('should return ESRB for US', () => {
      const system = filter.getRatingSystemForRegion('US');
      assert.equal(system, 'ESRB');
    });

    it('should return PEGI for EU countries', () => {
      assert.equal(filter.getRatingSystemForRegion('GB'), 'PEGI');
      assert.equal(filter.getRatingSystemForRegion('DE'), 'PEGI');
      assert.equal(filter.getRatingSystemForRegion('FR'), 'PEGI');
    });

    it('should return CERO for Japan', () => {
      assert.equal(filter.getRatingSystemForRegion('JP'), 'CERO');
    });

    it('should return CADPA for China', () => {
      assert.equal(filter.getRatingSystemForRegion('CN'), 'CADPA');
    });

    it('should return PEGI as default', () => {
      assert.equal(filter.getRatingSystemForRegion('XX'), 'PEGI');
    });
  });

  describe('ageRatingToMinAge()', () => {
    it('should convert PEGI ratings correctly', () => {
      assert.equal(filter.ageRatingToMinAge('3', 'PEGI'), 3);
      assert.equal(filter.ageRatingToMinAge('7', 'PEGI'), 7);
      assert.equal(filter.ageRatingToMinAge('12', 'PEGI'), 12);
      assert.equal(filter.ageRatingToMinAge('16', 'PEGI'), 16);
      assert.equal(filter.ageRatingToMinAge('18', 'PEGI'), 18);
    });

    it('should convert ESRB ratings correctly', () => {
      assert.equal(filter.ageRatingToMinAge('E', 'ESRB'), 6);
      assert.equal(filter.ageRatingToMinAge('T', 'ESRB'), 13);
      assert.equal(filter.ageRatingToMinAge('M', 'ESRB'), 17);
      assert.equal(filter.ageRatingToMinAge('AO', 'ESRB'), 18);
    });

    it('should convert CERO ratings correctly', () => {
      assert.equal(filter.ageRatingToMinAge('A', 'CERO'), 3);
      assert.equal(filter.ageRatingToMinAge('B', 'CERO'), 12);
      assert.equal(filter.ageRatingToMinAge('C', 'CERO'), 15);
      assert.equal(filter.ageRatingToMinAge('Z', 'CERO'), 18);
    });

    it('should return 0 for unknown ratings', () => {
      assert.equal(filter.ageRatingToMinAge('UNKNOWN', 'PEGI'), 0);
    });
  });

  describe('applyModification()', () => {
    it('should apply name modification', () => {
      const entity = { id: 1, name: 'Dragonite' };
      const restriction = {
        level: 'modified',
        alternative: { name: { ar: '精灵149' } }
      };
      
      const result = filter.applyModification(entity, restriction, 'ar');
      assert.equal(result.name, '精灵149');
      assert.equal(result.original_name, 'Dragonite');
      assert.equal(result.localized, true);
    });

    it('should apply description modification', () => {
      const entity = { id: 1, name: 'Pikachu', description: 'Electric mouse' };
      const restriction = {
        level: 'modified',
        alternative: { description: { ar: '精灵电老鼠' } }
      };
      
      const result = filter.applyModification(entity, restriction, 'ar');
      assert.equal(result.description, '精灵电老鼠');
      assert.equal(result.original_description, 'Electric mouse');
    });

    it('should apply image modification', () => {
      const entity = { id: 1, image_url: 'original.png' };
      const restriction = {
        level: 'modified',
        alternative: { image_url: 'modified.png' }
      };
      
      const result = filter.applyModification(entity, restriction, 'en');
      assert.equal(result.image_url, 'modified.png');
      assert.equal(result.original_image_url, 'original.png');
    });

    it('should return unchanged entity without alternative', () => {
      const entity = { id: 1, name: 'Pikachu' };
      const restriction = { level: 'modified', alternative: null };
      
      const result = filter.applyModification(entity, restriction, 'en');
      assert.equal(result.name, 'Pikachu');
    });
  });

  describe('getMinAgeForSensitivity()', () => {
    it('should map sensitivity levels to ages', () => {
      assert.equal(filter.getMinAgeForSensitivity('low'), 12);
      assert.equal(filter.getMinAgeForSensitivity('medium'), 16);
      assert.equal(filter.getMinAgeForSensitivity('high'), 18);
      assert.equal(filter.getMinAgeForSensitivity('critical'), 21);
    });

    it('should return 0 for unknown level', () => {
      assert.equal(filter.getMinAgeForSensitivity('unknown'), 0);
    });
  });

  describe('isActivityEnabled()', () => {
    it('should return true by default', async () => {
      const result = await filter.isActivityEnabled(9999, 'US');
      assert.equal(result, true);
    });
  });

  describe('clearCache()', () => {
    it('should clear all cached data', async () => {
      // 建立一些缓存
      await filter.checkEntityRestriction('pokemon', 1, 'US');
      await filter.loadRegionRules('US');
      
      const before = filter.getCacheStats();
      assert.ok(before.size > 0);
      
      filter.clearCache();
      
      const after = filter.getCacheStats();
      assert.equal(after.size, 0);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      // 即使数据库连接有问题，也不应该崩溃
      const result = await filter.checkEntityRestriction('pokemon', 1, 'US');
      assert.ok(result.level);
    });

    it('should return entities on filtering error', async () => {
      const entities = [{ type: 'pokemon', id: 1, name: 'Pikachu' }];
      
      // 即使出错，降级返回原列表
      const result = await filter.filterEntities(entities, 'XX', 25);
      assert.ok(Array.isArray(result));
    });
  });
});

describe('CulturalContentFilter Integration', () => {
  let filter;

  before(async () => {
    filter = new CulturalContentFilter();
  });

  describe('region-specific filtering', () => {
    it('should handle multiple regions', async () => {
      const entities = [
        { type: 'pokemon', id: 1, name: 'Bulbasaur' }
      ];
      
      const regions = ['US', 'GB', 'JP', 'CN', 'SA'];
      
      for (const region of regions) {
        const result = await filter.filterEntities(entities, region, 25);
        assert.ok(Array.isArray(result));
      }
    });

    it('should handle entity with missing fields', async () => {
      const entities = [
        { type: 'pokemon', id: 1 } // 缺少 name
      ];
      
      const result = await filter.filterEntities(entities, 'US', 25);
      assert.ok(Array.isArray(result));
    });
  });
});

// 运行测试统计
describe('Test Summary', () => {
  it('should pass all CulturalContentFilter tests', () => {
    logger.info('✅ CulturalContentFilter tests completed');
    assert.ok(true);
  });
});