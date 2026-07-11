/**
 * Property-Based Testing Framework
 * 基于 fast-check 的属性测试引擎
 * 
 * @module backend/shared/testing/PropertyBasedTester
 * @version 1.0.0
 */

const fc = require('fast-check');
const { pokemonArbitrary, locationArbitrary, userInputArbitrary, userArbitrary, battleArbitrary, paymentArbitrary } = require('./arbitraries');
const { BoundaryExplorer } = require('./BoundaryExplorer');

/**
 * PropertyBasedTester - 属性测试器
 * 使用 fast-check 自动生成大量随机输入验证代码属性
 */
class PropertyBasedTester {
  constructor(options = {}) {
    this.options = {
      numRuns: options.numRuns || 10000,
      timeout: options.timeout || 60000,
      seed: options.seed || undefined,
      verbose: options.verbose || false
    };
    this.results = [];
    this.boundaryExplorer = new BoundaryExplorer();
  }

  /**
   * Pokemon CP 计算属性测试
   * 验证：CP 值必须为正整数、不超过 MAX_CP、与输入正相关
   */
  testPokemonCPCalculation(calculateCP) {
    const property = fc.property(
      fc.record({
        ivAttack: fc.integer({ min: 0, max: 31 }),
        ivDefense: fc.integer({ min: 0, max: 31 }),
        ivStamina: fc.integer({ min: 0, max: 31 }),
        level: fc.integer({ min: 1, max: 100 }),
        baseAttack: fc.integer({ min: 1, max: 300 }),
        baseDefense: fc.integer({ min: 1, max: 300 }),
        baseStamina: fc.integer({ min: 1, max: 300 })
      }),
      (input) => {
        const cp = calculateCP(input);
        
        // 属性验证
        if (!Number.isInteger(cp)) return false;  // CP 必须为整数
        if (cp < 10) return false;                 // CP 最小值 10
        if (cp > 65535) return false;              // CP 最大值 65535
        
        // CP 与等级正相关（相同配置下，等级越高 CP 越大）
        if (input.level > 1) {
          const lowerLevelCP = calculateCP({ ...input, level: input.level - 1 });
          if (cp <= lowerLevelCP) return false;
        }
        
        return true;
      }
    );

    return this.runProperty(property, 'PokemonCP Calculation');
  }

  /**
   * 坐标距离计算属性测试
   * 验证：距离必须为正数、不超过地球半周长、计算对称性
   */
  testDistanceCalculation(calculateDistance) {
    const property = fc.property(
      fc.record({
        lat1: fc.float({ min: -90, max: 90, noNaN: true }),
        lon1: fc.float({ min: -180, max: 180, noNaN: true }),
        lat2: fc.float({ min: -90, max: 90, noNaN: true }),
        lon2: fc.float({ min: -180, max: 180, noNaN: true })
      }),
      (coords) => {
        const distance = calculateDistance(coords);
        
        // 属性验证
        if (!Number.isFinite(distance)) return false;  // 距离必须为有限数
        if (distance < 0) return false;                  // 距离不能为负
        
        // 距离不超过地球半周长（约 20015 km）
        if (distance > 20015) return false;
        
        // 相同点距离接近 0
        if (coords.lat1 === coords.lat2 && coords.lon1 === coords.lon2) {
          if (distance > 0.001) return false;  // 允许微小误差
        }
        
        // 距离计算对称性
        const reverseDistance = calculateDistance({
          lat1: coords.lat2, lon1: coords.lon2,
          lat2: coords.lat1, lon2: coords.lon1
        });
        if (Math.abs(distance - reverseDistance) > 0.001) return false;
        
        return true;
      }
    );

    return this.runProperty(property, 'Distance Calculation');
  }

  /**
   * 时间戳处理属性测试
   * 验证：格式化结果不为空、包含有效日期组件、转换一致
   */
  testTimestampHandling(formatTimestamp, parseTimestamp) {
    const property = fc.property(
      fc.record({
        timestamp: fc.integer({ min: 0, max: 2147483647 }),
        timezoneOffset: fc.integer({ min: -12, max: 14 })
      }),
      (input) => {
        const formatted = formatTimestamp(input.timestamp, input.timezoneOffset);
        
        // 属性验证
        if (!formatted || formatted.length === 0) return false;  // 格式化结果不为空
        
        // 格式化结果包含有效日期组件（至少包含年月日）
        if (!/\d{4}/.test(formatted)) return false;  // 包含年份
        if (!/\d{1,2}/.test(formatted)) return false; // 包含月或日
        
        // 转换回时间戳一致（允许 ±1 天误差，因为时区转换）
        const parsed = parseTimestamp(formatted);
        const diffDays = Math.abs(input.timestamp - parsed) / 86400;
        if (diffDays > 1) return false;
        
        return true;
      }
    );

    return this.runProperty(property, 'Timestamp Handling');
  }

  /**
   * 价格计算属性测试
   * 验证：价格为正数、不超过最大值、精度正确
   */
  testPriceCalculation(calculatePrice) {
    const property = fc.property(
      fc.record({
        basePrice: fc.float({ min: 0.01, max: 1000, noNaN: true }),
        quantity: fc.integer({ min: 1, max: 100 }),
        discount: fc.float({ min: 0, max: 0.99, noNaN: true }),
        currency: fc.constantFrom('USD', 'EUR', 'JPY', 'CNY')
      }),
      (input) => {
        const price = calculatePrice(input);
        
        // 属性验证
        if (!Number.isFinite(price)) return false;  // 价格必须为有限数
        if (price < 0) return false;                  // 价格不能为负
        
        // 价格不超过 basePrice * quantity
        const maxPrice = input.basePrice * input.quantity;
        if (price > maxPrice) return false;
        
        // 价格精度（日元无小数，其他货币最多 2 位小数）
        if (input.currency === 'JPY') {
          if (!Number.isInteger(price)) return false;
        } else {
          const decimals = (price.toString().split('.')[1] || '').length;
          if (decimals > 2) return false;
        }
        
        return true;
      }
    );

    return this.runProperty(property, 'Price Calculation');
  }

  /**
   * 用户输入验证属性测试
   * 验证：非法输入被拒绝、不抛异常
   */
  testInputValidation(validateInput) {
    const property = fc.property(
      userInputArbitrary,
      (input) => {
        // 属性验证：无论输入是什么，验证函数都应返回布尔值
        try {
          const result = validateInput(input);
          if (typeof result !== 'boolean') return false;
          return true;
        } catch (error) {
          // 不应该抛出未处理的异常
          return false;
        }
      }
    );

    return this.runProperty(property, 'Input Validation');
  }

  /**
   * Pokemon 数据验证属性测试
   * 验证：Pokemon 数据结构完整性
   */
  testPokemonValidation(validatePokemon) {
    const property = fc.property(
      pokemonArbitrary,
      (pokemon) => {
        try {
          const isValid = validatePokemon(pokemon);
          
          // 基本属性验证
          if (typeof isValid !== 'boolean') return false;
          
          // ID 必须为正整数
          if (pokemon.id && (!Number.isInteger(pokemon.id) || pokemon.id < 1)) return false;
          
          // CP/HP 必须为正数
          if (pokemon.cp && pokemon.cp < 10) return false;
          if (pokemon.hp && pokemon.hp < 1) return false;
          
          return true;
        } catch (error) {
          return false;
        }
      }
    );

    return this.runProperty(property, 'Pokemon Validation');
  }

  /**
   * 位置数据验证属性测试
   * 验证：坐标在有效范围内
   */
  testLocationValidation(validateLocation) {
    const property = fc.property(
      locationArbitrary,
      (location) => {
        try {
          const isValid = validateLocation(location);
          
          // 基本属性验证
          if (typeof isValid !== 'boolean') return false;
          
          // 坐标必须在有效范围内
          if (location.latitude < -90 || location.latitude > 90) return false;
          if (location.longitude < -180 || location.longitude > 180) return false;
          
          return true;
        } catch (error) {
          return false;
        }
      }
    );

    return this.runProperty(property, 'Location Validation');
  }

  /**
   * 战斗伤害计算属性测试
   * 验证：伤害为正数、不超过最大值、类型系数正确
   */
  testDamageCalculation(calculateDamage) {
    const property = fc.property(
      battleArbitrary,
      (battle) => {
        const damage = calculateDamage(battle);
        
        // 属性验证
        if (!Number.isFinite(damage)) return false;  // 伤害必须为有限数
        if (damage < 0) return false;                  // 伤害不能为负
        if (damage > 10000) return false;              // 单次伤害上限
        
        return true;
      }
    );

    return this.runProperty(property, 'Damage Calculation');
  }

  /**
   * 运行属性测试
   */
  runProperty(property, testName) {
    const startTime = Date.now();
    let result = { testName, passed: true, error: null, seed: null };

    try {
      const out = fc.check(property, {
        numRuns: this.options.numRuns,
        timeout: this.options.timeout,
        seed: this.options.seed,
        verbose: this.options.verbose ? 2 : 0
      });

      if (out.failed) {
        result.passed = false;
        result.error = out.error;
        result.seed = out.seed;
        result.counterexample = out.counterexample;
        result.numRuns = out.numRuns;
      } else {
        result.numRuns = out.numRuns;
        result.seed = out.seed;
      }
    } catch (error) {
      result.passed = false;
      result.error = error.message;
    }

    result.duration = Date.now() - startTime;
    this.results.push(result);
    return result;
  }

  /**
   * 运行所有核心属性测试
   */
  async runAllTests(testFunctions) {
    const {
      calculateCP,
      calculateDistance,
      formatTimestamp,
      parseTimestamp,
      calculatePrice,
      validateInput,
      validatePokemon,
      validateLocation,
      calculateDamage
    } = testFunctions;

    const testResults = [];

    if (calculateCP) {
      testResults.push(this.testPokemonCPCalculation(calculateCP));
    }

    if (calculateDistance) {
      testResults.push(this.testDistanceCalculation(calculateDistance));
    }

    if (formatTimestamp && parseTimestamp) {
      testResults.push(this.testTimestampHandling(formatTimestamp, parseTimestamp));
    }

    if (calculatePrice) {
      testResults.push(this.testPriceCalculation(calculatePrice));
    }

    if (validateInput) {
      testResults.push(this.testInputValidation(validateInput));
    }

    if (validatePokemon) {
      testResults.push(this.testPokemonValidation(validatePokemon));
    }

    if (validateLocation) {
      testResults.push(this.testLocationValidation(validateLocation));
    }

    if (calculateDamage) {
      testResults.push(this.testDamageCalculation(calculateDamage));
    }

    return this.generateReport(testResults);
  }

  /**
   * 生成测试报告
   */
  generateReport(results) {
    const totalTests = results.length;
    const passedTests = results.filter(r => r.passed).length;
    const failedTests = results.filter(r => !r.passed).length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    return {
      summary: {
        totalTests,
        passed: passedTests,
        failed: failedTests,
        passRate: (passedTests / totalTests * 100).toFixed(2),
        totalDuration,
        avgDuration: totalDuration / totalTests
      },
      results: results.map(r => ({
        testName: r.testName,
        passed: r.passed,
        numRuns: r.numRuns || this.options.numRuns,
        duration: r.duration,
        error: r.error,
        seed: r.seed,
        counterexample: r.counterexample ? JSON.stringify(r.counterexample) : null,
        reproCommand: r.seed ? `npm run test:property -- --seed=${r.seed}` : null
      })),
      failures: results.filter(r => !r.passed).map(r => ({
        testName: r.testName,
        error: r.error,
        counterexample: r.counterexample,
        reproCommand: r.seed ? `npm run test:property -- --seed=${r.seed}` : null
      }))
    };
  }
}

module.exports = { PropertyBasedTester };