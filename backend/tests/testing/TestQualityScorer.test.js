// backend/tests/testing/TestQualityScorer.test.js
// 测试质量评分器单元测试

'use strict';

const TestQualityScorer = require('../../shared/testing/TestQualityScorer');

describe('TestQualityScorer', () => {
  let scorer;

  beforeEach(() => {
    scorer = new TestQualityScorer();
  });

  describe('calculateScore', () => {
    it('should calculate score with all perfect metrics', () => {
      const metrics = {
        mutationScore: 100,
        lineCoverage: 100,
        branchCoverage: 100,
        assertionDensity: 0.15,
        boundaryCoverage: 100,
        avgTestDuration: 1000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBe(100);
      expect(result.grade).toBe('A');
      expect(result.breakdown.mutation.score).toBe(100);
      expect(result.breakdown.coverage.score).toBe(100);
      expect(result.recommendations).toHaveLength(0);
    });

    it('should calculate score with low mutation coverage', () => {
      const metrics = {
        mutationScore: 60,
        lineCoverage: 90,
        branchCoverage: 85,
        assertionDensity: 0.1,
        boundaryCoverage: 80,
        avgTestDuration: 3000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBeLessThan(90);
      expect(result.breakdown.mutation.status).toBe('warning');
      expect(result.recommendations.length).toBeGreaterThan(0);
      
      const mutationRec = result.recommendations.find(r => r.type === 'mutation');
      expect(mutationRec).toBeDefined();
      expect(mutationRec.priority).toBe('high');
    });

    it('should calculate score with weak assertions', () => {
      const metrics = {
        mutationScore: 85,
        lineCoverage: 90,
        branchCoverage: 85,
        assertionDensity: 0.05,
        boundaryCoverage: 80,
        avgTestDuration: 3000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.breakdown.assertion.status).toBe('warning');
      
      const assertionRec = result.recommendations.find(r => r.type === 'assertion');
      expect(assertionRec).toBeDefined();
    });

    it('should return grade F for very poor metrics', () => {
      const metrics = {
        mutationScore: 20,
        lineCoverage: 40,
        branchCoverage: 30,
        assertionDensity: 0.01,
        boundaryCoverage: 20,
        avgTestDuration: 15000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.grade).toBe('F');
      expect(result.score).toBeLessThan(50);
      expect(result.recommendations.length).toBeGreaterThan(3);
    });

    it('should handle zero values gracefully', () => {
      const metrics = {
        mutationScore: 0,
        lineCoverage: 0,
        branchCoverage: 0,
        assertionDensity: 0,
        boundaryCoverage: 0,
        avgTestDuration: 50000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.grade).toBe('F');
    });

    it('should cap score at 100', () => {
      const metrics = {
        mutationScore: 150, // Over 100
        lineCoverage: 200,
        branchCoverage: 150,
        assertionDensity: 0.5,
        boundaryCoverage: 150,
        avgTestDuration: 100
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBe(100);
      expect(result.breakdown.mutation.score).toBe(100); // Capped
    });
  });

  describe('getGrade', () => {
    it('should return A for score >= 90', () => {
      expect(scorer.getGrade(90)).toBe('A');
      expect(scorer.getGrade(95)).toBe('A');
      expect(scorer.getGrade(100)).toBe('A');
    });

    it('should return B for score >= 80', () => {
      expect(scorer.getGrade(80)).toBe('B');
      expect(scorer.getGrade(85)).toBe('B');
      expect(scorer.getGrade(89)).toBe('B');
    });

    it('should return C for score >= 70', () => {
      expect(scorer.getGrade(70)).toBe('C');
      expect(scorer.getGrade(75)).toBe('C');
    });

    it('should return D for score >= 60', () => {
      expect(scorer.getGrade(60)).toBe('D');
      expect(scorer.getGrade(65)).toBe('D');
    });

    it('should return E for score >= 50', () => {
      expect(scorer.getGrade(50)).toBe('E');
      expect(scorer.getGrade(55)).toBe('E');
    });

    it('should return F for score < 50', () => {
      expect(scorer.getGrade(49)).toBe('F');
      expect(scorer.getGrade(30)).toBe('F');
      expect(scorer.getGrade(0)).toBe('F');
    });
  });

  describe('generateRecommendations', () => {
    it('should recommend improving mutation coverage', () => {
      const metrics = {
        mutationScore: 60,
        lineCoverage: 90,
        branchCoverage: 90,
        assertionDensity: 0.1,
        boundaryCoverage: 90,
        avgTestDuration: 3000
      };

      const recommendations = scorer.generateRecommendations(metrics, 70);

      const mutationRec = recommendations.find(r => r.type === 'mutation');
      expect(mutationRec).toBeDefined();
      expect(mutationRec.priority).toBe('high');
      expect(mutationRec.message).toContain('变异测试覆盖率');
    });

    it('should recommend improving assertion density', () => {
      const metrics = {
        mutationScore: 85,
        lineCoverage: 90,
        branchCoverage: 90,
        assertionDensity: 0.03,
        boundaryCoverage: 90,
        avgTestDuration: 3000
      };

      const recommendations = scorer.generateRecommendations(metrics, 75);

      const assertionRec = recommendations.find(r => r.type === 'assertion');
      expect(assertionRec).toBeDefined();
      expect(assertionRec.priority).toBe('high');
    });

    it('should recommend improving boundary coverage', () => {
      const metrics = {
        mutationScore: 85,
        lineCoverage: 90,
        branchCoverage: 90,
        assertionDensity: 0.1,
        boundaryCoverage: 50,
        avgTestDuration: 3000
      };

      const recommendations = scorer.generateRecommendations(metrics, 75);

      const boundaryRec = recommendations.find(r => r.type === 'boundary');
      expect(boundaryRec).toBeDefined();
      expect(boundaryRec.priority).toBe('medium');
    });

    it('should recommend performance optimization for slow tests', () => {
      const metrics = {
        mutationScore: 85,
        lineCoverage: 90,
        branchCoverage: 90,
        assertionDensity: 0.1,
        boundaryCoverage: 90,
        avgTestDuration: 15000
      };

      const recommendations = scorer.generateRecommendations(metrics, 80);

      const perfRec = recommendations.find(r => r.type === 'performance');
      expect(perfRec).toBeDefined();
      expect(perfRec.priority).toBe('low');
    });

    it('should add overall recommendation for poor score', () => {
      const metrics = {
        mutationScore: 30,
        lineCoverage: 50,
        branchCoverage: 40,
        assertionDensity: 0.02,
        boundaryCoverage: 30,
        avgTestDuration: 20000
      };

      const recommendations = scorer.generateRecommendations(metrics, 40);

      const overallRec = recommendations.find(r => r.type === 'overall');
      expect(overallRec).toBeDefined();
      expect(overallRec.priority).toBe('critical');
    });
  });

  describe('calculateBatchScore', () => {
    it('should calculate scores for multiple modules', () => {
      const modulesMetrics = {
        'pokemon-service': {
          mutationScore: 85,
          lineCoverage: 90,
          branchCoverage: 85,
          assertionDensity: 0.12,
          boundaryCoverage: 80,
          avgTestDuration: 3000
        },
        'catch-service': {
          mutationScore: 75,
          lineCoverage: 85,
          branchCoverage: 80,
          assertionDensity: 0.08,
          boundaryCoverage: 70,
          avgTestDuration: 5000
        },
        'user-service': {
          mutationScore: 90,
          lineCoverage: 95,
          branchCoverage: 90,
          assertionDensity: 0.15,
          boundaryCoverage: 85,
          avgTestDuration: 2000
        }
      };

      const result = scorer.calculateBatchScore(modulesMetrics);

      expect(result.modules).toHaveProperty('pokemon-service');
      expect(result.modules).toHaveProperty('catch-service');
      expect(result.modules).toHaveProperty('user-service');
      expect(result.average).toBeDefined();
      expect(result.summary.totalModules).toBe(3);
      expect(result.summary.criticalModules).toHaveLength(0);
    });

    it('should identify critical modules', () => {
      const modulesMetrics = {
        'good-service': {
          mutationScore: 85,
          lineCoverage: 90,
          branchCoverage: 85,
          assertionDensity: 0.1,
          boundaryCoverage: 80,
          avgTestDuration: 3000
        },
        'bad-service': {
          mutationScore: 30,
          lineCoverage: 40,
          branchCoverage: 35,
          assertionDensity: 0.01,
          boundaryCoverage: 20,
          avgTestDuration: 20000
        }
      };

      const result = scorer.calculateBatchScore(modulesMetrics);

      expect(result.summary.criticalModules).toContain('bad-service');
      expect(result.summary.criticalModules).not.toContain('good-service');
    });
  });

  describe('calculateTrend', () => {
    it('should detect improving trend', () => {
      const history = [
        { score: 60 },
        { score: 65 },
        { score: 70 },
        { score: 75 },
        { score: 80 },
        { score: 82 },
        { score: 85 },
        { score: 87 },
        { score: 90 },
        { score: 92 }
      ];

      const trend = scorer.calculateTrend(history);

      expect(trend.direction).toBe('improving');
      expect(trend.change).toBeGreaterThan(0);
    });

    it('should detect declining trend', () => {
      const history = [
        { score: 90 },
        { score: 88 },
        { score: 85 },
        { score: 82 },
        { score: 80 },
        { score: 78 },
        { score: 75 },
        { score: 72 },
        { score: 70 },
        { score: 68 }
      ];

      const trend = scorer.calculateTrend(history);

      expect(trend.direction).toBe('declining');
      expect(trend.change).toBeLessThan(0);
    });

    it('should detect stable trend', () => {
      const history = [
        { score: 80 },
        { score: 81 },
        { score: 79 },
        { score: 80 },
        { score: 81 },
        { score: 80 },
        { score: 79 },
        { score: 80 },
        { score: 81 },
        { score: 80 }
      ];

      const trend = scorer.calculateTrend(history);

      expect(trend.direction).toBe('stable');
      expect(Math.abs(trend.change)).toBeLessThan(2);
    });

    it('should handle short history', () => {
      const history = [{ score: 80 }];

      const trend = scorer.calculateTrend(history);

      expect(trend.direction).toBe('stable');
      expect(trend.change).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle missing metrics', () => {
      const result = scorer.calculateScore({});

      expect(result.score).toBeDefined();
      expect(result.score).toBeLessThan(50);
    });

    it('should handle negative values', () => {
      const metrics = {
        mutationScore: -10,
        lineCoverage: -5,
        branchCoverage: -5,
        assertionDensity: -0.1,
        boundaryCoverage: -10,
        avgTestDuration: -1000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large assertion density', () => {
      const metrics = {
        mutationScore: 100,
        lineCoverage: 100,
        branchCoverage: 100,
        assertionDensity: 1.0, // Very high
        boundaryCoverage: 100,
        avgTestDuration: 1000
      };

      const result = scorer.calculateScore(metrics);

      expect(result.score).toBe(100);
      expect(result.breakdown.assertion.score).toBe(100);
    });
  });
});