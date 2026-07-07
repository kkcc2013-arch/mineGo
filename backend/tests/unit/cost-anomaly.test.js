/**
 * REQ-00466: 成本异常检测测试
 */

const { CostAnomalyDetector } = require('../shared/cost-alerting/CostAnomalyDetector');

describe('CostAnomalyDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new CostAnomalyDetector({
      zScoreThreshold: 2.5,
      windowSize: 7,
      minDataPoints: 5
    });
  });

  describe('detect', () => {
    it('should return no anomaly with insufficient data', () => {
      const historicalCosts = [100, 105, 110];
      const result = detector.detect(historicalCosts, 120);

      expect(result.isAnomaly).toBe(false);
      expect(result.reason).toBe('Insufficient data points');
    });

    it('should detect cost spike', () => {
      const historicalCosts = [100, 102, 98, 101, 100, 99, 103];
      const result = detector.detect(historicalCosts, 500); // 5倍增长

      expect(result.isAnomaly).toBe(true);
      expect(result.anomalyType).toBe('cost_spike');
      expect(result.severity).toBe('critical');
      expect(result.zScore).toBeGreaterThan(4);
    });

    it('should detect moderate increase', () => {
      const historicalCosts = [100, 100, 100, 100, 100, 100, 100];
      const result = detector.detect(historicalCosts, 180); // 1.8倍

      expect(result.isAnomaly).toBe(true);
      expect(result.anomalyType).toBe('cost_increase');
    });

    it('should detect cost decrease', () => {
      const historicalCosts = [100, 100, 100, 100, 100, 100, 100];
      const result = detector.detect(historicalCosts, 40); // 0.4倍

      expect(result.isAnomaly).toBe(true);
      expect(result.anomalyType).toBe('cost_decrease');
    });

    it('should return normal for stable costs', () => {
      const historicalCosts = [100, 100, 100, 100, 100, 100, 100];
      const result = detector.detect(historicalCosts, 102);

      expect(result.isAnomaly).toBe(false);
      expect(result.anomalyType).toBe('normal');
    });
  });

  describe('calculateSeverity', () => {
    it('should return critical for z-score > 4', () => {
      expect(detector.calculateSeverity(5)).toBe('critical');
    });

    it('should return high for z-score > 3', () => {
      expect(detector.calculateSeverity(3.5)).toBe('high');
    });

    it('should return medium for z-score > 2.5', () => {
      expect(detector.calculateSeverity(2.7)).toBe('medium');
    });

    it('should return low for z-score <= 2.5', () => {
      expect(detector.calculateSeverity(2)).toBe('low');
    });
  });

  describe('detectTrend', () => {
    it('should detect increasing trend', () => {
      const data = [100, 110, 120, 130, 140, 150, 160];
      const trend = detector.detectTrend(data);

      expect(trend).toBe('increasing');
    });

    it('should detect decreasing trend', () => {
      const data = [160, 150, 140, 130, 120, 110, 100];
      const trend = detector.detectTrend(data);

      expect(trend).toBe('decreasing');
    });

    it('should return stable for stable data', () => {
      const data = [100, 100, 100, 100, 100, 100, 100];
      const trend = detector.detectTrend(data);

      expect(trend).toBe('stable');
    });
  });

  describe('expectedRange', () => {
    it('should calculate valid expected range', () => {
      const historicalCosts = [100, 100, 100, 100, 100, 100, 100];
      const result = detector.detect(historicalCosts, 100);

      expect(result.expectedRange.min).toBeLessThan(100);
      expect(result.expectedRange.max).toBeGreaterThan(100);
    });
  });
});
