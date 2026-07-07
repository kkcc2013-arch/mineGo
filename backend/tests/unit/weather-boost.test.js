/**
 * 天气增益引擎单元测试
 * 测试 WeatherBoostEngine 的核心功能
 */

'use strict';

const { WeatherBoostEngine, weatherBoostEngine } = require('../WeatherBoostEngine');
const { WEATHER_BOOST_MATRIX, mapWeatherCodeToGameWeather, isSpecialWeather } = require('../WeatherBoostMatrix');

describe('WeatherBoostEngine', () => {
  let engine;
  
  beforeEach(() => {
    engine = new WeatherBoostEngine();
  });
  
  describe('calculateBoostFactor', () => {
    test('晴天时火系精灵刷新概率提升 50%', () => {
      const boostFactor = engine.calculateBoostFactor('clear', 'fire');
      expect(boostFactor).toBe(1.5);
    });
    
    test('雨天时水系精灵刷新概率提升 60%', () => {
      const boostFactor = engine.calculateBoostFactor('rain', 'water');
      expect(boostFactor).toBe(1.6);
    });
    
    test('雾天时幽灵系精灵刷新概率提升 80%', () => {
      const boostFactor = engine.calculateBoostFactor('fog', 'ghost');
      expect(boostFactor).toBe(1.8);
    });
    
    test('暴风雨时龙系精灵刷新概率提升 100%', () => {
      const boostFactor = engine.calculateBoostFactor('thunderstorm', 'dragon');
      expect(boostFactor).toBe(2.0);
    });
    
    test('非增益属性概率降低 30%', () => {
      const boostFactor = engine.calculateBoostFactor('clear', 'water');
      expect(boostFactor).toBe(0.7);
    });
    
    test('未知天气无增益', () => {
      const boostFactor = engine.calculateBoostFactor('unknown', 'fire');
      expect(boostFactor).toBe(1.0);
    });
    
    test('类型大小写不敏感', () => {
      const boostFactorLower = engine.calculateBoostFactor('clear', 'fire');
      const boostFactorUpper = engine.calculateBoostFactor('clear', 'FIRE');
      expect(boostFactorLower).toBe(boostFactorUpper);
    });
  });
  
  describe('calculateBatchBoostFactors', () => {
    test('批量计算多个精灵类型增益', () => {
      const types = ['fire', 'water', 'grass', 'electric'];
      const factors = engine.calculateBatchBoostFactors('clear', types);
      
      expect(factors['fire']).toBe(1.5);   // 增益
      expect(factors['water']).toBe(0.7);  // 非增益
      expect(factors['grass']).toBe(1.5);  // 增益
      expect(factors['electric']).toBe(0.7); // 非增益
    });
  });
  
  describe('checkRareSpawnTrigger', () => {
    test('雾天触发稀有精灵刷新概率提升 30%', () => {
      const trigger = engine.checkRareSpawnTrigger('fog');
      expect(trigger.triggered).toBe(true);
      expect(trigger.rarityBoost).toBe(0.3);
      expect(trigger.specialEvent).toBe(true);
    });
    
    test('晴天触发稀有精灵刷新概率提升 10%', () => {
      const trigger = engine.checkRareSpawnTrigger('clear');
      expect(trigger.triggered).toBe(true);
      expect(trigger.rarityBoost).toBe(0.1);
      expect(trigger.specialEvent).toBe(false);
    });
    
    test('暴风雨触发稀有精灵刷新概率提升 40%', () => {
      const trigger = engine.checkRareSpawnTrigger('thunderstorm');
      expect(trigger.triggered).toBe(true);
      expect(trigger.rarityBoost).toBe(0.4);
      expect(trigger.specialEvent).toBe(true);
    });
    
    test('未知天气不触发稀有精灵', () => {
      const trigger = engine.checkRareSpawnTrigger('unknown');
      expect(trigger.triggered).toBe(false);
      expect(trigger.rarityBoost).toBe(0);
    });
  });
  
  describe('selectRarePokemon', () => {
    test('晴天可能选择增益类型的稀有精灵', () => {
      // 多次测试确保随机性被正确处理
      const results = [];
      for (let i = 0; i < 20; i++) {
        const rare = engine.selectRarePokemon('clear', 0.5); // 高概率确保触发
        if (rare) {
          results.push(rare);
        }
      }
      
      // 至少应该有一些触发（50%概率）
      expect(results.length).toBeGreaterThan(0);
      
      // 所有触发的都应该是增益类型
      results.forEach(rare => {
        expect(['fire', 'grass', 'ground']).toContain(rare.type);
        expect(rare.rarity).toBeGreaterThan(0.5);
      });
    });
    
    test('暴风雨选择增益类型稀有精灵（包括龙系）', () => {
      const rare = engine.selectRarePokemon('thunderstorm', 0.9); // 高概率触发
      if (rare) {
        expect(['electric', 'water', 'dragon']).toContain(rare.type);
        expect(rare.specialEvent).toBe(true);
      }
    });
  });
  
  describe('applyWeatherBoost', () => {
    test('应用天气增益到精灵刷新列表', () => {
      const baseSpawns = [
        { id: 1, name: 'Pikachu', type: 'electric', baseProbability: 0.2 },
        { id: 2, name: 'Charmander', type: 'fire', baseProbability: 0.15 },
        { id: 3, name: 'Squirtle', type: 'water', baseProbability: 0.18 }
      ];
      
      const boostedSpawns = engine.applyWeatherBoost('rain', baseSpawns);
      
      // 检查增益应用
      expect(boostedSpawns.length).toBeGreaterThanOrEqual(3);
      
      // 电系（增益）
      const pikachu = boostedSpawns.find(s => s.name === 'Pikachu');
      expect(pikachu.spawnProbability).toBe(0.2 * 1.6); // 增益 60%
      expect(pikachu.weatherBoosted).toBe(true);
      
      // 火系（非增益）
      const charmander = boostedSpawns.find(s => s.name === 'Charmander');
      expect(charmander.spawnProbability).toBe(0.15 * 0.7); // 降低 30%
      expect(charmander.weatherBoosted).toBe(false);
      
      // 水系（增益）
      const squirtle = boostedSpawns.find(s => s.name === 'Squirtle');
      expect(squirtle.spawnProbability).toBe(0.18 * 1.6); // 增益 60%
      expect(squirtle.weatherBoosted).toBe(true);
    });
    
    test('特殊天气可能添加稀有精灵', () => {
      const baseSpawns = [
        { id: 1, name: 'Pikachu', type: 'electric', baseProbability: 0.2 }
      ];
      
      // 多次测试确保至少有一次添加稀有精灵
      const results = [];
      for (let i = 0; i < 50; i++) {
        const boosted = engine.applyWeatherBoost('thunderstorm', baseSpawns);
        if (boosted.length > baseSpawns.length) {
          results.push(boosted);
        }
      }
      
      // 应该有至少一些结果包含额外精灵
      expect(results.length).toBeGreaterThan(0);
    });
  });
  
  describe('getWeatherBoostSummary', () => {
    test('获取晴天增益摘要', () => {
      const summary = engine.getWeatherBoostSummary('clear');
      
      expect(summary.weather).toBe('clear');
      expect(summary.boostedTypes.length).toBe(3);
      expect(summary.spawnMultiplier).toBe(1.5);
      expect(summary.rarityBoost).toBe(0.1);
      expect(summary.specialEvent).toBe(false);
    });
    
    test('获取暴风雨增益摘要', () => {
      const summary = engine.getWeatherBoostSummary('thunderstorm');
      
      expect(summary.weather).toBe('thunderstorm');
      expect(summary.boostedTypes.length).toBe(3);
      expect(summary.spawnMultiplier).toBe(2.0);
      expect(summary.rarityBoost).toBe(0.4);
      expect(summary.specialEvent).toBe(true);
    });
    
    test('获取未知天气摘要', () => {
      const summary = engine.getWeatherBoostSummary('unknown');
      
      expect(summary.weather).toBe('unknown');
      expect(summary.boostedTypes.length).toBe(0);
      expect(summary.spawnMultiplier).toBe(1.0);
      expect(summary.rarityBoost).toBe(0);
    });
  });
});

describe('WeatherBoostMatrix', () => {
  describe('mapWeatherCodeToGameWeather', () => {
    test('天气代码 800 映射为晴天', () => {
      expect(mapWeatherCodeToGameWeather(800)).toBe('clear');
    });
    
    test('天气代码 500 映射为雨天', () => {
      expect(mapWeatherCodeToGameWeather(500)).toBe('rain');
    });
    
    test('天气代码 601 映射为雪天', () => {
      expect(mapWeatherCodeToGameWeather(601)).toBe('snow');
    });
    
    test('天气代码 741 映射为雾天', () => {
      expect(mapWeatherCodeToGameWeather(741)).toBe('fog');
    });
    
    test('天气代码 211 映射为暴风雨', () => {
      expect(mapWeatherCodeToGameWeather(211)).toBe('thunderstorm');
    });
    
    test('未知天气代码映射为晴天（默认）', () => {
      expect(mapWeatherCodeToGameWeather(999)).toBe('clear');
    });
  });
  
  describe('isSpecialWeather', () => {
    test('雾天是特殊天气', () => {
      expect(isSpecialWeather('fog')).toBe(true);
    });
    
    test('雪天是特殊天气', () => {
      expect(isSpecialWeather('snow')).toBe(true);
    });
    
    test('暴风雨是特殊天气', () => {
      expect(isSpecialWeather('thunderstorm')).toBe(true);
    });
    
    test('晴天不是特殊天气', () => {
      expect(isSpecialWeather('clear')).toBe(false);
    });
    
    test('雨天不是特殊天气', () => {
      expect(isSpecialWeather('rain')).toBe(false);
    });
  });
  
  describe('WEATHER_BOOST_MATRIX', () => {
    test('包含所有必要的天气类型', () => {
      const weatherTypes = Object.keys(WEATHER_BOOST_MATRIX);
      expect(weatherTypes).toContain('clear');
      expect(weatherTypes).toContain('rain');
      expect(weatherTypes).toContain('cloudy');
      expect(weatherTypes).toContain('windy');
      expect(weatherTypes).toContain('fog');
      expect(weatherTypes).toContain('snow');
      expect(weatherTypes).toContain('thunderstorm');
    });
    
    test('每个天气配置包含必要字段', () => {
      Object.entries(WEATHER_BOOST_MATRIX).forEach(([weather, config]) => {
        expect(config).toHaveProperty('boostedTypes');
        expect(config).toHaveProperty('spawnMultiplier');
        expect(config).toHaveProperty('rarityBoost');
        expect(config).toHaveProperty('specialEvent');
        expect(Array.isArray(config.boostedTypes)).toBe(true);
        expect(config.spawnMultiplier).toBeGreaterThan(0);
        expect(config.rarityBoost).toBeGreaterThanOrEqual(0);
      });
    });
    
    test('刷新倍率在合理范围内', () => {
      Object.entries(WEATHER_BOOST_MATRIX).forEach(([weather, config]) => {
        expect(config.spawnMultiplier).toBeGreaterThanOrEqual(1.0);
        expect(config.spawnMultiplier).toBeLessThanOrEqual(3.0);
      });
    });
    
    test('稀有度提升在合理范围内', () => {
      Object.entries(WEATHER_BOOST_MATRIX).forEach(([weather, config]) => {
        expect(config.rarityBoost).toBeGreaterThanOrEqual(0);
        expect(config.rarityBoost).toBeLessThanOrEqual(0.5);
      });
    });
  });
});

describe('Integration Tests', () => {
  test('完整天气增益流程', () => {
    const engine = new WeatherBoostEngine();
    
    // 1. 获取天气增益摘要
    const summary = engine.getWeatherBoostSummary('rain');
    
    // 2. 批量计算增益系数
    const pokemonTypes = ['water', 'fire', 'electric', 'grass'];
    const boostFactors = engine.calculateBatchBoostFactors('rain', pokemonTypes);
    
    // 3. 检查稀有精灵触发
    const rareTrigger = engine.checkRareSpawnTrigger('rain');
    
    // 4. 应用增益到刷新列表
    const baseSpawns = pokemonTypes.map((type, i) => ({
      id: i,
      name: `Pokemon-${type}`,
      type: type,
      baseProbability: 0.1
    }));
    
    const boostedSpawns = engine.applyWeatherBoost('rain', baseSpawns);
    
    // 验证完整性
    expect(summary.weather).toBe('rain');
    expect(boostFactors['water']).toBe(1.6);
    expect(boostFactors['fire']).toBe(0.7);
    expect(rareTrigger.triggered).toBe(true);
    expect(boostedSpawns.length).toBeGreaterThanOrEqual(4);
  });
  
  test('特殊天气（暴风雨）完整流程', () => {
    const engine = new WeatherBoostEngine();
    
    const summary = engine.getWeatherBoostSummary('thunderstorm');
    expect(summary.specialEvent).toBe(true);
    expect(summary.spawnMultiplier).toBe(2.0);
    
    const rareTrigger = engine.checkRareSpawnTrigger('thunderstorm');
    expect(rareTrigger.specialEvent).toBe(true);
    expect(rareTrigger.rarityBoost).toBe(0.4);
  });
});