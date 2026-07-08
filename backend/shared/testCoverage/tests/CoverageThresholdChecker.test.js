'use strict';

const CoverageThresholdChecker = require('./CoverageThresholdChecker');
const { expect } = require('@jest/globals');

describe('CoverageThresholdChecker', () => {
  let checker;

  beforeEach(() => {
    checker = new CoverageThresholdChecker({
      minLines: 60,
      minFunctions: 50,
      minBranches: 40
    });
  });

  describe('constructor', () => {
    it('should initialize with default thresholds', () => {
      expect(checker.defaultThreshold.lines).toBe(60);
      expect(checker.defaultThreshold.functions).toBe(50);
      expect(checker.defaultThreshold.branches).toBe(40);
    });

    it('should have service-specific thresholds', () => {
      expect(checker.serviceThresholds['payment-service']).toBeDefined();
      expect(checker.serviceThresholds['payment-service'].lines).toBe(80);
    });
  });

  describe('getServiceThreshold', () => {
    it('should return service-specific threshold', () => {
      const threshold = checker.getServiceThreshold('payment-service');

      expect(threshold.lines).toBe(80);
    });

    it('should return default threshold for unknown service', () => {
      const threshold = checker.getServiceThreshold('unknown-service');

      expect(threshold.lines).toBe(60);
    });
  });

  describe('setServiceThreshold', () => {
    it('should update service threshold', () => {
      checker.setServiceThreshold('gateway', { lines: 70 });

      expect(checker.serviceThresholds['gateway'].lines).toBe(70);
    });
  });

  describe('checkThreshold', () => {
    it('should pass when coverage meets threshold', () => {
      const data = { lines: 65, statements: 65, functions: 55, branches: 45 };
      const threshold = { lines: 60, statements: 60, functions: 50, branches: 40 };

      const result = checker.checkThreshold('test', data, threshold);

      expect(result.passes).toBe(true);
      expect(result.details.lines.passes).toBe(true);
    });

    it('should fail when coverage below threshold', () => {
      const data = { lines: 55, statements: 55, functions: 45, branches: 35 };
      const threshold = { lines: 60, statements: 60, functions: 50, branches: 40 };

      const result = checker.checkThreshold('test', data, threshold);

      expect(result.passes).toBe(false);
      expect(result.failureDetails).toBeDefined();
    });

    it('should identify specific failing metrics', () => {
      const data = { lines: 65, statements: 65, functions: 45, branches: 35 };
      const threshold = { lines: 60, statements: 60, functions: 50, branches: 40 };

      const result = checker.checkThreshold('test', data, threshold);

      expect(result.passes).toBe(false);
      expect(result.failureDetails).toHaveLength(2);
      expect(result.failureDetails[0].metric).toBe('functions');
      expect(result.failureDetails[1].metric).toBe('branches');
    });
  });

  describe('check', () => {
    it('should check total coverage', async () => {
      const coverageData = {
        total: { lines: 70, statements: 70, functions: 60, branches: 50 }
      };

      const result = await checker.check(coverageData);

      expect(result.total).toBeDefined();
      expect(result.total.passes).toBe(true);
    });

    it('should check all services', async () => {
      const coverageData = {
        total: { lines: 65, statements: 65, functions: 55, branches: 45 },
        services: {
          'user-service': { lines: 70, statements: 70, functions: 65, branches: 55 },
          'payment-service': { lines: 85, statements: 85, functions: 82, branches: 75 }
        }
      };

      const result = await checker.check(coverageData);

      expect(result.services['user-service']).toBeDefined();
      expect(result.services['payment-service']).toBeDefined();
      expect(result.passes).toBe(true);
    });

    it('should detect service failures', async () => {
      const coverageData = {
        total: { lines: 65, statements: 65, functions: 55, branches: 45 },
        services: {
          'payment-service': { lines: 70, statements: 70, functions: 60, branches: 50 }
        }
      };

      const result = await checker.check(coverageData);

      // payment-service requires 80% lines
      expect(result.passes).toBe(false);
      expect(result.failures).toHaveLength(1);
    });

    it('should handle services with errors', async () => {
      const coverageData = {
        total: { lines: 65, statements: 65, functions: 55, branches: 45 },
        services: {
          'gateway': { error: 'coverage_not_found' }
        }
      };

      const result = await checker.check(coverageData);

      expect(result.services['gateway'].error).toBe('coverage_not_found');
    });
  });

  describe('formatSummary', () => {
    it('should format summary with emojis', () => {
      const details = {
        lines: { value: 70, threshold: 60, passes: true },
        functions: { value: 45, threshold: 50, passes: false },
        branches: { value: 35, threshold: 40, passes: false }
      };

      const summary = checker.formatSummary('test-service', details);

      expect(summary.lines).toContain('✅');
      expect(summary.lines).toContain('70');
      expect(summary.functions).toContain('❌');
    });
  });

  describe('generateReport', () => {
    it('should generate markdown report', () => {
      const result = {
        passes: true,
        total: {
          summary: {
            lines: '✅ Lines: 65% (threshold: 60%)',
            functions: '✅ Functions: 55% (threshold: 50%)',
            branches: '✅ Branches: 45% (threshold: 40%)'
          }
        },
        services: {},
        failures: [],
        checkedAt: new Date().toISOString()
      };

      const report = checker.generateReport(result);

      expect(report).toContain('# Coverage Threshold Check Report');
      expect(report).toContain('PASSED');
    });

    it('should include failures in report', () => {
      const result = {
        passes: false,
        total: null,
        services: {},
        failures: [
          { scope: 'payment-service', failureDetails: [{ metric: 'lines', value: 70, threshold: 80 }] }
        ],
        checkedAt: new Date().toISOString()
      };

      const report = checker.generateReport(result);

      expect(report).toContain('FAILED');
      expect(report).toContain('Failures');
    });
  });

  describe('generateCliOutput', () => {
    it('should generate colored CLI output', () => {
      const result = {
        passes: true,
        total: {
          details: {
            lines: { value: 65, threshold: 60, passes: true },
            functions: { value: 55, threshold: 50, passes: true },
            branches: { value: 45, threshold: 40, passes: true }
          }
        },
        failures: []
      };

      const output = checker.generateCliOutput(result);

      expect(output).toContain('PASSED');
      expect(output).toContain('Lines');
    });
  });
});

describe('CoverageThresholdChecker Integration', () => {
  it('should handle complete check workflow', async () => {
    const checker = new CoverageThresholdChecker();

    const coverageData = {
      total: { lines: 75, statements: 75, functions: 70, branches: 60 },
      services: {
        'user-service': { lines: 80, statements: 80, functions: 75, branches: 65 },
        'payment-service': { lines: 90, statements: 90, functions: 88, branches: 85 }
      }
    };

    const result = await checker.check(coverageData);

    expect(result.passes).toBe(true);
    expect(result.failures).toHaveLength(0);

    const report = checker.generateReport(result);
    expect(report).toContain('PASSED');
  });
});