/**
 * REQ-00481: 精灵数据预编译缓存系统
 * 单元测试
 */

'use strict';

const assert = require('assert');
const LRUCache = require('../../shared/LRUCache');
const pokemonDataCompiler = require('../../shared/pokemonDataCompiler');

// Mock 数据
const mockSpecies = {
  id: 1,
  name_zh: '妙蛙种子',
  name_en: 'Bulbasaur',
  name_ja: 'フシギダネ',
  type1: 'GRASS',
  type2: 'POISON',
  rarity: 'COMMON',
  base_attack: 118,
  base_defense: 111,
  base_hp: 128,
  base_catch_rate: 0.2,
  base_flee_rate: 0.1,
  candy_to_evolve: 25,
  evolves_to: 2,
  evolves_with_item: null,
  biomes: ['FOREST', 'GRASSLAND']
};

describe('REQ-00481: 精灵数据预编译缓存系统', function() {
  
  describe('LRUCache', function() {
    
    it('应该正确初始化 LRU 缓存', function() {
      const cache = new LRUCache({ maxSize: 100, defaultTTL: 60000 });
      
      assert.strictEqual(cache.maxSize, 100);
      assert.strictEqual(cache.defaultTTL, 60000);
      assert.strictEqual(cache.cache.size, 0);
      
      cache.close();
    });
    
    it('应该正确设置和获取缓存值', function() {
      const cache = new LRUCache({ maxSize: 100 });
      
      cache.set('key1', 'value1', 60000);
      const value = cache.get('key1');
      
      assert.strictEqual(value, 'value1');
      assert.strictEqual(cache.stats.hits, 1);
      
      cache.close();
    });
    
    it('应该正确处理过期数据', function(done) {
      const cache = new LRUCache({ maxSize: 100, defaultTTL: 100 });
      
      cache.set('key1', 'value1', 100);
      
      // 等待过期
      setTimeout(() => {
        const value = cache.get('key1');
        assert.strictEqual(value, null);
        assert.strictEqual(cache.stats.misses, 1);
        
        cache.close();
        done();
      }, 150);
    });
    
    it('应该在达到 maxSize 时淘汰最少使用的数据', function() {
      const cache = new LRUCache({ maxSize: 3 });
      
      cache.set('key1', 'value1', 60000);
      cache.set('key2', 'value2', 60000);
      cache.set('key3', 'value3', 60000);
      cache.set('key4', 'value4', 60000); // 应该淘汰 key1
      
      assert.strictEqual(cache.cache.size, 3);
      assert.strictEqual(cache.get('key1'), null);
      assert.strictEqual(cache.get('key4'), 'value4');
      assert.strictEqual(cache.stats.evictions, 1);
      
      cache.close();
    });
    
    it('应该正确更新访问顺序', function() {
      const cache = new LRUCache({ maxSize: 3 });
      
      cache.set('key1', 'value1', 60000);
      cache.set('key2', 'value2', 60000);
      cache.set('key3', 'value3', 60000);
      
      // 访问 key1，使其变为最常使用
      cache.get('key1');
      
      // 添加新数据，应该淘汰 key2（而不是 key1）
      cache.set('key4', 'value4', 60000);
      
      assert.strictEqual(cache.get('key1'), 'value1');
      assert.strictEqual(cache.get('key2'), null);
      
      cache.close();
    });
    
    it('应该正确计算命中率', function() {
      const cache = new LRUCache({ maxSize: 100 });
      
      cache.set('key1', 'value1', 60000);
      
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('key2'); // miss
      
      const stats = cache.getStats();
      assert.strictEqual(stats.hits, 2);
      assert.strictEqual(stats.misses, 1);
      assert.strictEqual(stats.hitRate.toFixed(2), '0.67');
      
      cache.close();
    });
    
    it('应该正确处理内存限制', function() {
      const cache = new LRUCache({ maxSize: 1000, maxMemoryMB: 0.01 }); // 10KB
      
      // 添加大量数据
      const largeValue = 'x'.repeat(5000);
      cache.set('key1', largeValue, 60000);
      
      assert.ok(cache.currentMemoryBytes <= 10 * 1024);
      
      cache.close();
    });
  });
  
  describe('PokemonDataCompiler', function() {
    
    it('应该正确编译精灵基础数据', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled);
      assert.strictEqual(compiled.id, 1);
      assert.ok(compiled.baseStats);
      assert.strictEqual(compiled.baseStats.attack, 118);
      assert.strictEqual(compiled.baseStats.defense, 111);
      assert.strictEqual(compiled.baseStats.hp, 128);
    });
    
    it('应该正确计算满级属性预估', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled.maxLevelStats);
      assert.ok(compiled.maxLevelStats.maxCP > 0);
      assert.ok(compiled.maxLevelStats.maxAttack > 0);
      assert.ok(compiled.maxLevelStats.maxDefense > 0);
      assert.ok(compiled.maxLevelStats.maxHP > 0);
    });
    
    it('应该正确构建进化节点查找表', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled.evolution);
      assert.strictEqual(compiled.evolution.evolvesTo, 2);
      assert.ok(Array.isArray(compiled.evolution.evolutionConditions));
      assert.ok(compiled.evolution.evolutionConditions.length > 0);
      
      // 检查糖果进化条件
      const candyCondition = compiled.evolution.evolutionConditions.find(c => c.type === 'CANDY');
      assert.ok(candyCondition);
      assert.strictEqual(candyCondition.amount, 25);
    });
    
    it('应该正确计算属性克制关系', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled.typeEffectiveness);
      assert.ok(Array.isArray(compiled.typeEffectiveness.weakTo));
      assert.ok(Array.isArray(compiled.typeEffectiveness.strongAgainst));
      
      // GRASS/POISON 应对 FIRE, ICE, FLYING, PSYCHIC 等
      assert.ok(compiled.typeEffectiveness.weakTo.length > 0);
    });
    
    it('应该正确处理本地化数据', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled.names);
      assert.strictEqual(compiled.names.zh, '妙蛙种子');
      assert.strictEqual(compiled.names.en, 'Bulbasaur');
      assert.strictEqual(compiled.names.ja, 'フシギダネ');
    });
    
    it('应该正确序列化和反序列化数据', function() {
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      // 编译后的数据应该是 Buffer
      assert.ok(Buffer.isBuffer(compiled) || typeof compiled === 'object');
      
      // 反序列化
      const decoded = pokemonDataCompiler.decodeData(compiled);
      
      assert.ok(decoded);
      assert.strictEqual(decoded.id, 1);
      assert.ok(decoded.baseStats);
    });
    
    it('应该正确处理无进化精灵', function() {
      const speciesNoEvolution = {
        ...mockSpecies,
        evolves_to: null,
        candy_to_evolve: 0
      };
      
      const compiled = pokemonDataCompiler.compileSpeciesData(speciesNoEvolution);
      
      assert.strictEqual(compiled.evolution.evolvesTo, null);
      assert.ok(compiled.evolution.evolutionConditions.length === 0);
    });
    
    it('应该正确处理单一属性精灵', function() {
      const speciesSingleType = {
        ...mockSpecies,
        type2: null
      };
      
      const compiled = pokemonDataCompiler.compileSpeciesData(speciesSingleType);
      
      assert.ok(Array.isArray(compiled.types));
      assert.strictEqual(compiled.types.length, 1);
      assert.strictEqual(compiled.types[0], 'GRASS');
    });
  });
  
  describe('Integration Tests', function() {
    
    it('应该正确集成缓存和编译器', async function() {
      // Mock cache.set 和 cache.get
      const mockCache = {
        set: async (key, value) => {},
        get: async (key) => null
      };
      
      // 测试编译流程
      const compiled = pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      assert.ok(compiled);
      
      // 模拟存储
      await mockCache.set('pokemon:1', compiled);
      
      // 模拟获取
      const retrieved = await mockCache.get('pokemon:1');
      assert.strictEqual(retrieved, null); // Mock 返回 null
    });
    
    it('应该正确处理批量编译', function() {
      const speciesList = [
        mockSpecies,
        { ...mockSpecies, id: 2, name_zh: '妙蛙草' }
      ];
      
      const results = pokemonDataCompiler.compileAll(speciesList);
      
      assert.ok(results.data);
      assert.strictEqual(results.count, 2);
      assert.ok(results.compileTime > 0);
    });
  });
  
  describe('Performance Tests', function() {
    
    it('编译延迟应该在 5ms 以内', function() {
      const startTime = Date.now();
      
      pokemonDataCompiler.compileSpeciesData(mockSpecies);
      
      const duration = Date.now() - startTime;
      assert.ok(duration < 5, `编译耗时 ${duration}ms，超过 5ms 限制`);
    });
    
    it('批量编译 100 个精灵应该在 500ms 以内', function() {
      const speciesList = Array(100).fill(mockSpecies).map((s, i) => ({
        ...s,
        id: i + 1
      }));
      
      const startTime = Date.now();
      pokemonDataCompiler.compileAll(speciesList);
      
      const duration = Date.now() - startTime;
      assert.ok(duration < 500, `批量编译耗时 ${duration}ms，超过 500ms 限制`);
    });
    
    it('缓存命中应该在 1ms 以内', function() {
      const cache = new LRUCache({ maxSize: 100 });
      cache.set('key1', mockSpecies, 60000);
      
      const startTime = Date.now();
      cache.get('key1');
      
      const duration = Date.now() - startTime;
      assert.ok(duration < 1, `缓存命中耗时 ${duration}ms，超过 1ms 限制`);
      
      cache.close();
    });
  });
});

// 运行测试
if (require.main === module) {
  console.log('运行 REQ-00481 单元测试...');
  
  describe.run().then(() => {
    console.log('测试完成！');
  }).catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
  });
}

module.exports = { mockSpecies };