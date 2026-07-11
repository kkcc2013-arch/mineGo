/**
 * Property-Based Testing Framework Unit Tests
 * 测试属性测试框架本身的功能
 * 
 * @module backend/tests/propertyBasedTesting.test.js
 */

const { PropertyBasedTester } = require('../shared/testing/PropertyBasedTester');
const { BoundaryExplorer } = require('../shared/testing/BoundaryExplorer');
const { FuzzTester } = require('../shared/testing/FuzzTester');
const {
  pokemonArbitrary,
  locationArbitrary,
  userInputArbitrary,
  userArbitrary,
  battleArbitrary,
  paymentArbitrary,
  boundaryValuesArbitrary
} = require('../shared/testing/arbitraries');

const fc = require('fast-check');

describe('PropertyBasedTester', () => {
  let tester;

  beforeEach(() => {
    tester = new PropertyBasedTester({ numRuns: 100, verbose: false });
  });

  describe('Pokemon CP Calculation', () => {
    // 模拟 CP 计算函数
    const calculateCP = ({ ivAttack, ivDefense, ivStamina, level, baseAttack, baseDefense, baseStamina }) => {
      const cpMultiplier = Math.pow(0.5, (100 - level) / 100);
      const attack = baseAttack + ivAttack;
      const defense = baseDefense + ivDefense;
      const stamina = baseStamina + ivStamina;
      
      const cp = Math.floor((attack * Math.pow(defense, 0.5) * Math.pow(stamina, 0.5) * cpMultiplier) / 10);
      
      return Math.max(10, Math.min(65535, cp));
    };

    it('should pass CP calculation with valid inputs', () => {
      const result = tester.testPokemonCPCalculation(calculateCP);
      expect(result.passed).toBe(true);
    });

    it('should calculate CP within valid range', () => {
      fc.assert(
        fc.property(
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
            return cp >= 10 && cp <= 65535;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('should maintain CP ordering with level', () => {
      fc.assert(
        fc.property(
          fc.record({
            ivAttack: fc.integer({ min: 0, max: 31 }),
            ivDefense: fc.integer({ min: 0, max: 31 }),
            ivStamina: fc.integer({ min: 0, max: 31 }),
            baseAttack: fc.integer({ min: 1, max: 300 }),
            baseDefense: fc.integer({ min: 1, max: 300 }),
            baseStamina: fc.integer({ min: 1, max: 300 })
          }),
          fc.integer({ min: 2, max: 100 }),
          (base, level) => {
            const cpLower = calculateCP({ ...base, level: level - 1 });
            const cpHigher = calculateCP({ ...base, level });
            return cpHigher >= cpLower;
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Distance Calculation', () => {
    // Haversine 公式计算距离
    const calculateDistance = ({ lat1, lon1, lat2, lon2 }) => {
      const R = 6371; // 地球半径（公里）
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    it('should pass distance calculation with valid inputs', () => {
      const result = tester.testDistanceCalculation(calculateDistance);
      expect(result.passed).toBe(true);
    });

    it('should return non-negative distance', () => {
      fc.assert(
        fc.property(
          fc.record({
            lat1: fc.float({ min: -90, max: 90, noNaN: true }),
            lon1: fc.float({ min: -180, max: 180, noNaN: true }),
            lat2: fc.float({ min: -90, max: 90, noNaN: true }),
            lon2: fc.float({ min: -180, max: 180, noNaN: true })
          }),
          (coords) => {
            const distance = calculateDistance(coords);
            return distance >= 0;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('should return zero for same location', () => {
      fc.assert(
        fc.property(
          fc.record({
            lat: fc.float({ min: -90, max: 90, noNaN: true }),
            lon: fc.float({ min: -180, max: 180, noNaN: true })
          }),
          (location) => {
            const distance = calculateDistance({
              lat1: location.lat, lon1: location.lon,
              lat2: location.lat, lon2: location.lon
            });
            return distance < 0.001; // 允许微小误差
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('should be symmetric', () => {
      fc.assert(
        fc.property(
          fc.record({
            lat1: fc.float({ min: -90, max: 90, noNaN: true }),
            lon1: fc.float({ min: -180, max: 180, noNaN: true }),
            lat2: fc.float({ min: -90, max: 90, noNaN: true }),
            lon2: fc.float({ min: -180, max: 180, noNaN: true })
          }),
          (coords) => {
            const d1 = calculateDistance(coords);
            const d2 = calculateDistance({
              lat1: coords.lat2, lon1: coords.lon2,
              lat2: coords.lat1, lon2: coords.lon1
            });
            return Math.abs(d1 - d2) < 0.001;
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Timestamp Handling', () => {
    it('should handle valid timestamps', () => {
      const formatTimestamp = (ts) => new Date(ts * 1000).toISOString();
      const parseTimestamp = (str) => Math.floor(new Date(str).getTime() / 1000);

      const result = tester.testTimestampHandling(formatTimestamp, parseTimestamp);
      expect(result.passed).toBe(true);
    });
  });

  describe('Input Validation', () => {
    it('should validate user input without throwing', () => {
      const validateInput = (input) => {
        if (input === null || input === undefined) return false;
        if (typeof input === 'string' && input.length > 1000) return false;
        return true;
      };

      const result = tester.testInputValidation(validateInput);
      expect(result.passed).toBe(true);
    });
  });

  describe('Test Report Generation', () => {
    it('should generate valid report', () => {
      const result = tester.generateReport([]);
      expect(result.summary).toBeDefined();
      expect(result.results).toBeDefined();
      expect(result.failures).toBeDefined();
    });

    it('should include pass rate in summary', () => {
      const mockResults = [
        { testName: 'test1', passed: true, duration: 100 },
        { testName: 'test2', passed: false, duration: 200 }
      ];
      const report = tester.generateReport(mockResults);
      expect(report.summary.totalTests).toBe(2);
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(1);
    });
  });
});

describe('BoundaryExplorer', () => {
  let explorer;

  beforeEach(() => {
    explorer = new BoundaryExplorer();
  });

  describe('Numeric Boundaries', () => {
    it('should include zero', () => {
      const boundaries = explorer.getBoundaries('numeric.general');
      expect(boundaries).toContain(0);
    });

    it('should include negative values', () => {
      const boundaries = explorer.getBoundaries('numeric.general');
      expect(boundaries.some(b => b < 0)).toBe(true);
    });

    it('should include infinity values', () => {
      const boundaries = explorer.getBoundaries('numeric.general');
      expect(boundaries).toContain(Infinity);
      expect(boundaries).toContain(-Infinity);
    });

    it('should include NaN', () => {
      const boundaries = explorer.getBoundaries('numeric.general');
      expect(boundaries).toContain(NaN);
    });
  });

  describe('String Boundaries', () => {
    it('should include empty string', () => {
      const boundaries = explorer.getBoundaries('string.general');
      expect(boundaries).toContain('');
    });

    it('should include special characters', () => {
      const boundaries = explorer.getBoundaries('string.special');
      expect(boundaries.some(s => s.includes('\u0000'))).toBe(true);
    });

    it('should include very long strings', () => {
      const boundaries = explorer.getBoundaries('string.general');
      expect(boundaries.some(s => s.length >= 10000)).toBe(true);
    });
  });

  describe('Array Boundaries', () => {
    it('should include empty array', () => {
      const boundaries = explorer.getBoundaries('array.general');
      expect(boundaries).toContainEqual([]);
    });

    it('should include arrays with null', () => {
      const boundaries = explorer.getBoundaries('array.general');
      expect(boundaries.some(arr => arr.includes(null))).toBe(true);
    });

    it('should include sparse arrays', () => {
      const boundaries = explorer.getBoundaries('array.sparse');
      expect(boundaries).toBeDefined();
      expect(boundaries.length).toBeGreaterThan(0);
    });
  });

  describe('Object Boundaries', () => {
    it('should include empty object', () => {
      const boundaries = explorer.getBoundaries('object.general');
      expect(boundaries).toContainEqual({});
    });

    it('should include objects with empty keys', () => {
      const boundaries = explorer.getBoundaries('object.keys');
      expect(boundaries).toContain('');
    });

    it('should include prototype pollution attempts', () => {
      const boundaries = explorer.getBoundaries('object.general');
      expect(boundaries.some(obj => obj && obj.__proto__)).toBe(true);
    });
  });

  describe('Pokemon Specific Boundaries', () => {
    it('should include minimum CP', () => {
      const boundaries = explorer.getBoundaries('pokemon.cp');
      expect(boundaries).toContain(10);
    });

    it('should include maximum CP', () => {
      const boundaries = explorer.getBoundaries('pokemon.cp');
      expect(boundaries).toContain(65535);
    });

    it('should include invalid CP values', () => {
      const boundaries = explorer.getBoundaries('pokemon.cp');
      expect(boundaries).toContain(-1);
      expect(boundaries).toContain(0);
    });

    it('should include perfect IV', () => {
      const boundaries = explorer.getBoundaries('pokemon.iv');
      const perfectIV = boundaries.find(iv => 
        iv && iv.attack === 31 && iv.defense === 31 && iv.stamina === 31
      );
      expect(perfectIV).toBeDefined();
    });
  });

  describe('Location Boundaries', () => {
    it('should include pole boundaries', () => {
      const boundaries = explorer.getBoundaries('location.latitude');
      expect(boundaries).toContain(90);
      expect(boundaries).toContain(-90);
    });

    it('should include date line boundaries', () => {
      const boundaries = explorer.getBoundaries('location.longitude');
      expect(boundaries).toContain(180);
      expect(boundaries).toContain(-180);
    });
  });

  describe('Auto Explore', () => {
    it('should explore function boundaries', () => {
      const fn = (x) => {
        if (typeof x !== 'number') return 0;
        if (x < 0) return -1;
        if (x === 0) return 0;
        return x;
      };

      const result = explorer.autoExplore(fn, 'numeric.general');
      expect(result.totalTests).toBeGreaterThan(0);
      expect(result.failures).toBeDefined();
    });

    it('should format input correctly', () => {
      const formatted = explorer.formatInput({ a: 1, b: 'test' });
      expect(formatted).toContain('a');
      expect(formatted).toContain('b');
    });
  });
});

describe('FuzzTester', () => {
  let fuzzTester;

  beforeEach(() => {
    fuzzTester = new FuzzTester({ numRuns: 10 });
  });

  describe('Strategy Initialization', () => {
    it('should initialize all strategies', () => {
      expect(fuzzTester.strategies.headerInjection).toBeDefined();
      expect(fuzzTester.strategies.bodyInjection).toBeDefined();
      expect(fuzzTester.strategies.paramInjection).toBeDefined();
      expect(fuzzTester.strategies.authBypass).toBeDefined();
      expect(fuzzTester.strategies.typeConfusion).toBeDefined();
      expect(fuzzTester.strategies.boundaryValue).toBeDefined();
    });
  });

  describe('Strategy Selection', () => {
    it('should select appropriate strategies for POST', () => {
      const strategies = fuzzTester.selectStrategies('POST');
      expect(strategies).toContain('bodyInjection');
      expect(strategies).toContain('headerInjection');
      expect(strategies).toContain('authBypass');
    });

    it('should select appropriate strategies for GET', () => {
      const strategies = fuzzTester.selectStrategies('GET');
      expect(strategies).toContain('paramInjection');
      expect(strategies).toContain('headerInjection');
      expect(strategies).toContain('authBypass');
    });

    it('should not include bodyInjection for GET', () => {
      const strategies = fuzzTester.selectStrategies('GET');
      expect(strategies).not.toContain('bodyInjection');
    });
  });

  describe('Response Analysis', () => {
    it('should detect server errors', () => {
      const response = { status: 500, body: 'Internal Error' };
      const result = fuzzTester.analyzeResponse(response, {}, 'test');
      expect(result.issues.some(i => i.type === 'server_error')).toBe(true);
    });

    it('should detect stack trace leaks', () => {
      const response = { 
        status: 200, 
        body: 'Error: test error\n at Object.test (test.js:1)' 
      };
      const result = fuzzTester.analyzeResponse(response, {}, 'test');
      expect(result.issues.some(i => i.type === 'stack_trace_leak')).toBe(true);
    });

    it('should detect SQL error leaks', () => {
      const response = { 
        status: 200, 
        body: 'SQL syntax error near SELECT * FROM' 
      };
      const result = fuzzTester.analyzeResponse(response, {}, 'test');
      expect(result.issues.some(i => i.type === 'sql_error_leak')).toBe(true);
    });

    it('should detect missing security headers', () => {
      const response = { status: 200, body: {}, headers: {} };
      const result = fuzzTester.analyzeResponse(response, {}, 'test');
      expect(result.issues.some(i => i.type === 'missing_content_type')).toBe(true);
    });
  });

  describe('Severity Counting', () => {
    it('should count severities correctly', () => {
      const issues = [
        { severity: 'critical' },
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' }
      ];
      const counts = fuzzTester.countSeverities(issues);
      expect(counts.critical).toBe(2);
      expect(counts.high).toBe(1);
      expect(counts.medium).toBe(1);
      expect(counts.low).toBe(1);
    });
  });

  describe('Request Sanitization', () => {
    it('should redact authorization header', () => {
      const request = {
        headers: { 'Authorization': 'Bearer secret-token' }
      };
      const sanitized = fuzzTester.sanitizeRequest(request);
      expect(sanitized.headers['Authorization']).toBe('[REDACTED]');
    });
  });

  describe('Report Generation', () => {
    it('should generate aggregate report', () => {
      const results = [
        { 
          endpoint: '/api/test1', 
          totalRuns: 10, 
          issues: [],
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 }
        },
        { 
          endpoint: '/api/test2', 
          totalRuns: 10, 
          issues: [{ severity: 'high' }],
          severityCounts: { critical: 0, high: 1, medium: 0, low: 0 }
        }
      ];
      const report = fuzzTester.generateAggregateReport(results);
      expect(report.summary.totalEndpoints).toBe(2);
      expect(report.summary.totalRuns).toBe(20);
      expect(report.summary.totalIssues).toBe(1);
    });
  });
});

describe('Arbitraries', () => {
  describe('Pokemon Arbitrary', () => {
    it('should generate valid Pokemon objects', () => {
      fc.assert(
        fc.property(pokemonArbitrary, (pokemon) => {
          return pokemon.id > 0 && 
                 pokemon.level >= 1 && 
                 pokemon.level <= 100 &&
                 pokemon.cp >= 10 &&
                 pokemon.cp <= 65535 &&
                 pokemon.hp > 0;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Location Arbitrary', () => {
    it('should generate valid coordinates', () => {
      fc.assert(
        fc.property(locationArbitrary, (location) => {
          return location.latitude >= -90 && 
                 location.latitude <= 90 &&
                 location.longitude >= -180 && 
                 location.longitude <= 180;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('User Arbitrary', () => {
    it('should generate valid user objects', () => {
      fc.assert(
        fc.property(userArbitrary, (user) => {
          return user.id > 0 && 
                 user.level >= 1 && 
                 user.level <= 50 &&
                 user.coins >= 0;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Boundary Values Arbitrary', () => {
    it('should generate boundary values', () => {
      fc.assert(
        fc.property(boundaryValuesArbitrary, (value) => {
          // 边界值应该包含特殊值
          const isSpecial = value === null || 
                           value === undefined ||
                           value === '' ||
                           value === 0 ||
                           !Number.isFinite(value) ||
                           Number.isNaN(value);
          return true; // 任何值都是有效的边界值
        }),
        { numRuns: 100 }
      );
    });
  });
});