// tests/unit/catch-anomaly-detector.test.js
// REQ-00082: 精灵捕捉成功率异常检测系统单元测试
'use strict';

const {
  CatchRiskEngine,
  CatchSuccessRateAnalyzer,
  CatchRequestValidator,
  BatchCatchDetector,
  BASE_CATCH_RATES,
  BALL_MODIFIERS,
  THROW_MODIFIERS,
} = require('../../shared/catchAnomalyDetector');

describe('REQ-00082: 捕捉成功率异常检测系统', () => {
  // ============================================================
  // CatchSuccessRateAnalyzer 测试
  // ============================================================
  describe('CatchSuccessRateAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new CatchSuccessRateAnalyzer();
    });

    describe('calculateExpectedRate', () => {
      it('should calculate correct rate for common pokemon with poke ball', () => {
        const rate = analyzer.calculateExpectedRate('common', 'poke');
        expect(rate).toBeCloseTo(0.40, 2);
      });

      it('should calculate correct rate for rare pokemon with great ball', () => {
        const rate = analyzer.calculateExpectedRate('rare', 'great');
        expect(rate).toBeCloseTo(0.30, 2); // 0.20 * 1.5
      });

      it('should calculate correct rate for legendary with ultra ball', () => {
        const rate = analyzer.calculateExpectedRate('legendary', 'ultra');
        expect(rate).toBeCloseTo(0.10, 2); // 0.05 * 2.0
      });

      it('should apply throw modifier correctly', () => {
        const normalRate = analyzer.calculateExpectedRate('epic', 'poke', 'normal');
        const excellentRate = analyzer.calculateExpectedRate('epic', 'poke', 'excellent');
        expect(excellentRate).toBeCloseTo(normalRate * 1.5, 2);
      });

      it('should apply curveball modifier', () => {
        const normalRate = analyzer.calculateExpectedRate('rare', 'poke');
        const curveRate = analyzer.calculateExpectedRate('rare', 'poke', 'normal', true);
        expect(curveRate).toBeCloseTo(normalRate * 1.7, 2);
      });

      it('should apply berry modifier', () => {
        const normalRate = analyzer.calculateExpectedRate('common', 'poke');
        const berryRate = analyzer.calculateExpectedRate('common', 'poke', 'normal', false, 3);
        expect(berryRate).toBeCloseTo(normalRate * 1.3, 2);
      });

      it('should cap rate at 1.0', () => {
        const rate = analyzer.calculateExpectedRate('common', 'master');
        expect(rate).toBe(1.0);
      });

      it('should use default values for unknown types', () => {
        const rate = analyzer.calculateExpectedRate('unknown', 'unknown');
        expect(rate).toBeGreaterThan(0);
        expect(rate).toBeLessThanOrEqual(1);
      });
    });

    describe('calculateAnomalyScore', () => {
      it('should return 0 for small sample size', () => {
        const score = analyzer.calculateAnomalyScore(0.1, 0.5, 3);
        expect(score).toBe(0);
      });

      it('should return 0 for normal success rate', () => {
        const score = analyzer.calculateAnomalyScore(0.4, 0.42, 100);
        expect(score).toBeLessThan(10);
      });

      it('should detect high anomaly for abnormal success rate', () => {
        const score = analyzer.calculateAnomalyScore(0.05, 0.80, 100);
        expect(score).toBeGreaterThan(50);
      });

      it('should increase score with more attempts', () => {
        const lowScore = analyzer.calculateAnomalyScore(0.1, 0.5, 30);
        const highScore = analyzer.calculateAnomalyScore(0.1, 0.5, 100);
        expect(highScore).toBeGreaterThanOrEqual(lowScore);
      });

      it('should cap score at 100', () => {
        const score = analyzer.calculateAnomalyScore(0.01, 1.0, 1000);
        expect(score).toBeLessThanOrEqual(100);
      });
    });
  });

  // ============================================================
  // CatchRequestValidator 测试
  // ============================================================
  describe('CatchRequestValidator', () => {
    let validator;

    beforeEach(() => {
      validator = new CatchRequestValidator();
    });

    describe('generateRequestSignature', () => {
      it('should generate consistent signature for same input', () => {
        const sig1 = validator.generateRequestSignature('user1', 'poke1', 1000, { lat: 10, lng: 20 }, 'nonce1');
        const sig2 = validator.generateRequestSignature('user1', 'poke1', 1000, { lat: 10, lng: 20 }, 'nonce1');
        expect(sig1).toBe(sig2);
      });

      it('should generate different signature for different input', () => {
        const sig1 = validator.generateRequestSignature('user1', 'poke1', 1000, { lat: 10, lng: 20 }, 'nonce1');
        const sig2 = validator.generateRequestSignature('user2', 'poke1', 1000, { lat: 10, lng: 20 }, 'nonce1');
        expect(sig1).not.toBe(sig2);
      });

      it('should return 64 character hex string', () => {
        const sig = validator.generateRequestSignature('user1', 'poke1', 1000, { lat: 10, lng: 20 }, 'nonce1');
        expect(sig).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    describe('validateCatchRequest', () => {
      it('should validate timestamp within window', async () => {
        const result = await validator.validateCatchRequest({
          userId: 'user1',
          pokemonId: 'poke1',
          timestamp: Date.now(),
          location: { lat: 10, lng: 20 },
          ballType: 'poke',
          ballCount: 1,
        });
        expect(result.checks.timestampValid).toBe(true);
        expect(result.checks.ballCountValid).toBe(true);
      });

      it('should reject old timestamp', async () => {
        const result = await validator.validateCatchRequest({
          userId: 'user1',
          pokemonId: 'poke1',
          timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
          location: { lat: 10, lng: 20 },
          ballType: 'poke',
          ballCount: 1,
        });
        expect(result.checks.timestampValid).toBe(false);
      });

      it('should validate ball count', async () => {
        const validResult = await validator.validateCatchRequest({
          userId: 'user1',
          pokemonId: 'poke1',
          timestamp: Date.now(),
          ballCount: 5,
        });
        expect(validResult.checks.ballCountValid).toBe(true);

        const invalidResult = await validator.validateCatchRequest({
          userId: 'user1',
          pokemonId: 'poke1',
          timestamp: Date.now(),
          ballCount: 200,
        });
        expect(invalidResult.checks.ballCountValid).toBe(false);
      });

      it('should calculate integrity score correctly', async () => {
        const result = await validator.validateCatchRequest({
          userId: 'user1',
          pokemonId: 'poke1',
          timestamp: Date.now(),
          location: { lat: 10, lng: 20 },
          ballType: 'poke',
          ballCount: 1,
        });
        expect(result.integrityScore).toBeGreaterThanOrEqual(0);
        expect(result.integrityScore).toBeLessThanOrEqual(100);
      });
    });

    describe('calculateDistance', () => {
      it('should calculate distance between two points', () => {
        const dist = validator.calculateDistance(
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 }
        );
        expect(dist).toBeGreaterThan(100000); // ~111km
        expect(dist).toBeLessThan(112000);
      });

      it('should return 0 for same point', () => {
        const dist = validator.calculateDistance(
          { lat: 10, lng: 20 },
          { lat: 10, lng: 20 }
        );
        expect(dist).toBeLessThan(1);
      });
    });
  });

  // ============================================================
  // BatchCatchDetector 测试
  // ============================================================
  describe('BatchCatchDetector', () => {
    let detector;

    beforeEach(() => {
      detector = new BatchCatchDetector();
    });

    describe('calculateRiskLevel', () => {
      it('should return low for no violations', () => {
        const level = detector.calculateRiskLevel([]);
        expect(level).toBe('low');
      });

      it('should return critical for severe violations', () => {
        const violations = [{ count: 100, limit: 30 }];
        const level = detector.calculateRiskLevel(violations);
        expect(level).toBe('critical');
      });

      it('should return high for moderate violations', () => {
        const violations = [{ count: 50, limit: 30 }];
        const level = detector.calculateRiskLevel(violations);
        expect(level).toBe('high');
      });

      it('should return medium for minor violations', () => {
        const violations = [{ count: 35, limit: 30 }];
        const level = detector.calculateRiskLevel(violations);
        expect(level).toBe('medium');
      });
    });

    describe('calculateRiskScore', () => {
      it('should return 0 for no violations', () => {
        const score = detector.calculateRiskScore([]);
        expect(score).toBe(0);
      });

      it('should increase with violation severity', () => {
        const lowScore = detector.calculateRiskScore([{ count: 35, limit: 30 }]);
        const highScore = detector.calculateRiskScore([{ count: 100, limit: 30 }]);
        expect(highScore).toBeGreaterThan(lowScore);
      });

      it('should cap at 100', () => {
        const score = detector.calculateRiskScore([
          { count: 1000, limit: 10 },
          { count: 1000, limit: 10 },
        ]);
        expect(score).toBeLessThanOrEqual(100);
      });
    });
  });

  // ============================================================
  // CatchRiskEngine 测试
  // ============================================================
  describe('CatchRiskEngine', () => {
    let engine;

    beforeEach(() => {
      engine = new CatchRiskEngine();
    });

    describe('executeAction', () => {
      it('should allow for allow action', async () => {
        const result = await engine.executeAction('allow', {});
        expect(result.success).toBe(true);
        expect(result.warning).toBeUndefined();
      });

      it('should warn for warn action', async () => {
        const result = await engine.executeAction('warn', {});
        expect(result.success).toBe(true);
        expect(result.warning).toBe(true);
      });

      it('should block for block action', async () => {
        const result = await engine.executeAction('block', {});
        expect(result.success).toBe(false);
        expect(result.error).toBe('CATCH_BLOCKED_RISK_DETECTED');
      });
    });

    describe('checkSuccessRate', () => {
      it('should return valid result structure', async () => {
        const result = await engine.checkSuccessRate('user1', {
          pokemonId: 'poke1',
          pokemonRarity: 'common',
          ballType: 'poke',
          throwType: 'normal',
          curveball: false,
          berries: 0,
        });
        expect(result).toHaveProperty('expectedRate');
        expect(result).toHaveProperty('actualRate');
        expect(result).toHaveProperty('attempts');
        expect(result).toHaveProperty('anomalyScore');
        expect(result.expectedRate).toBeGreaterThan(0);
        expect(result.anomalyScore).toBeGreaterThanOrEqual(0);
      });
    });

    describe('checkDataIntegrity', () => {
      it('should return valid result structure', async () => {
        const result = await engine.checkDataIntegrity('user1', {
          pokemonId: 'poke1',
          timestamp: Date.now(),
          location: { lat: 10, lng: 20 },
          ballType: 'poke',
          ballCount: 1,
        });
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('integrityScore');
        expect(result).toHaveProperty('checks');
        expect(result.integrityScore).toBeGreaterThanOrEqual(0);
        expect(result.integrityScore).toBeLessThanOrEqual(100);
      });
    });
  });

  // ============================================================
  // 配置常量测试
  // ============================================================
  describe('Configuration Constants', () => {
    it('should have valid base catch rates', () => {
      expect(BASE_CATCH_RATES.common).toBe(0.40);
      expect(BASE_CATCH_RATES.rare).toBe(0.20);
      expect(BASE_CATCH_RATES.epic).toBe(0.10);
      expect(BASE_CATCH_RATES.legendary).toBe(0.05);
    });

    it('should have valid ball modifiers', () => {
      expect(BALL_MODIFIERS.poke).toBe(1.0);
      expect(BALL_MODIFIERS.great).toBe(1.5);
      expect(BALL_MODIFIERS.ultra).toBe(2.0);
      expect(BALL_MODIFIERS.master).toBe(255.0);
    });

    it('should have valid throw modifiers', () => {
      expect(THROW_MODIFIERS.normal).toBe(1.0);
      expect(THROW_MODIFIERS.nice).toBe(1.1);
      expect(THROW_MODIFIERS.great).toBe(1.3);
      expect(THROW_MODIFIERS.excellent).toBe(1.5);
    });

    it('should have increasing modifiers', () => {
      expect(THROW_MODIFIERS.excellent).toBeGreaterThan(THROW_MODIFIERS.great);
      expect(THROW_MODIFIERS.great).toBeGreaterThan(THROW_MODIFIERS.nice);
      expect(THROW_MODIFIERS.nice).toBeGreaterThan(THROW_MODIFIERS.normal);
    });
  });
});
