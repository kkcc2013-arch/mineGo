'use strict';

const TestCoverageCollector = require('./TestCoverageCollector');
const { expect } = require('@jest/globals');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}));

describe('TestCoverageCollector', () => {
  let collector;
  let mockFs;

  beforeEach(() => {
    collector = new TestCoverageCollector();
    mockFs = require('fs');
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct services', () => {
      expect(collector.services).toHaveLength(9);
      expect(collector.services).toContain('gateway');
      expect(collector.services).toContain('payment-service');
    });
  });

  describe('parseCoverageData', () => {
    it('should parse coverage summary correctly', () => {
      const mockData = {
        total: {
          lines: { pct: 65.5, total: 100, covered: 65 },
          statements: { pct: 64.2, total: 100, covered: 64 },
          functions: { pct: 58.3, total: 50, covered: 29 },
          branches: { pct: 42.1, total: 80, covered: 34 }
        },
        'src/index.js': { lines: { pct: 80 } }
      };

      const result = collector.parseCoverageData(mockData);

      expect(result.lines).toBe(65.5);
      expect(result.statements).toBe(64.2);
      expect(result.functions).toBe(58.3);
      expect(result.branches).toBe(42.1);
      expect(result.filesCovered).toBe(1);
      expect(result.totalLines).toBe(100);
      expect(result.coveredLines).toBe(65);
    });

    it('should handle missing coverage data', () => {
      const mockData = { total: {} };

      const result = collector.parseCoverageData(mockData);

      expect(result.lines).toBe(0);
      expect(result.statements).toBe(0);
      expect(result.functions).toBe(0);
      expect(result.branches).toBe(0);
    });
  });

  describe('calculateTotalCoverage', () => {
    it('should calculate weighted average correctly', () => {
      const results = {
        'user-service': { 
          lines: 60, statements: 60, functions: 50, branches: 40,
          totalLines: 100, coveredLines: 60,
          totalFunctions: 20, coveredFunctions: 10,
          totalBranches: 40, coveredBranches: 16
        },
        'payment-service': { 
          lines: 80, statements: 80, functions: 70, branches: 60,
          totalLines: 50, coveredLines: 40,
          totalFunctions: 10, coveredFunctions: 7,
          totalBranches: 20, coveredBranches: 12
        }
      };

      const total = collector.calculateTotalCoverage(results);

      // Weighted: (60*100 + 80*50) / (100+50) = (6000+4000)/150 = 66.67
      expect(total.lines).toBeCloseTo(66.67, 1);
      expect(total.functions).toBeCloseTo(56.67, 1);
      expect(total.branches).toBeCloseTo(46.67, 1);
      expect(total.servicesCovered).toBe(2);
    });

    it('should handle empty results', () => {
      const results = {};

      const total = collector.calculateTotalCoverage(results);

      expect(total.lines).toBe(0);
      expect(total.functions).toBe(0);
      expect(total.servicesCovered).toBe(0);
    });

    it('should handle services with errors', () => {
      const results = {
        'user-service': { error: 'coverage_not_found' },
        'payment-service': { 
          lines: 80, statements: 80, functions: 70, branches: 60,
          totalLines: 50, coveredLines: 40,
          totalFunctions: 10, coveredFunctions: 7,
          totalBranches: 20, coveredBranches: 12
        }
      };

      const total = collector.calculateTotalCoverage(results);

      expect(total.lines).toBe(80);
      expect(total.servicesCovered).toBe(1);
    });
  });

  describe('collectAll', () => {
    it('should collect all service coverage', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        total: {
          lines: { pct: 65 },
          statements: { pct: 64 },
          functions: { pct: 58 },
          branches: { pct: 42 }
        }
      }));

      const result = await collector.collectAll('build-123', 'main', 'abc123');

      expect(result.buildId).toBe('build-123');
      expect(result.branch).toBe('main');
      expect(result.commitSha).toBe('abc123');
      expect(result.services).toBeDefined();
      expect(result.total).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('should handle missing coverage files', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await collector.collectAll('build-123', 'main', 'abc123');

      expect(result.services['gateway'].error).toBe('coverage_not_found');
    });
  });

  describe('calculateGapSeverity', () => {
    it('should calculate severity based on uncovered lines', () => {
      const fileCoverage = {
        l: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 0 }
      };

      const severity = collector.calculateGapSeverity(fileCoverage);

      // 3 uncovered out of 5 = 60% uncovered
      expect(severity).toBe(60);
    });

    it('should return 0 for fully covered file', () => {
      const fileCoverage = {
        l: { '1': 1, '2': 2, '3': 1 }
      };

      const severity = collector.calculateGapSeverity(fileCoverage);

      expect(severity).toBe(0);
    });

    it('should handle empty file', () => {
      const fileCoverage = { l: {} };

      const severity = collector.calculateGapSeverity(fileCoverage);

      expect(severity).toBe(0);
    });
  });

  describe('generateBadge', () => {
    it('should generate brightgreen badge for high coverage', () => {
      const badge = collector.generateBadge(85);

      expect(badge.color).toBe('brightgreen');
      expect(badge.message).toBe('85.0%');
    });

    it('should generate yellow badge for medium coverage', () => {
      const badge = collector.generateBadge(65);

      expect(badge.color).toBe('yellow');
      expect(badge.message).toBe('65.0%');
    });

    it('should generate red badge for low coverage', () => {
      const badge = collector.generateBadge(30);

      expect(badge.color).toBe('red');
      expect(badge.message).toBe('30.0%');
    });
  });

  describe('analyzeGaps', () => {
    it('should analyze uncovered functions and branches', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        'src/auth.js': {
          f: { '0': 0, '1': 5, '2': 0 },
          fnMap: {
            '0': { name: 'validateToken', loc: { start: { line: 10 } } },
            '1': { name: 'login', loc: { start: { line: 20 } } },
            '2': { name: 'refreshSession', loc: { start: { line: 30 } } }
          },
          b: { '0': [0, 0], '1': [1, 1] },
          branchMap: {
            '0': { type: 'if', loc: { start: { line: 15 } } },
            '1': { type: 'switch', loc: { start: { line: 25 } } }
          },
          l: { '10': 0, '20': 5, '30': 0 }
        }
      }));

      const result = await collector.analyzeGaps('user-service');

      expect(result.service).toBe('user-service');
      expect(result.totalFiles).toBe(1);
      expect(result.gaps).toBeDefined();
    });

    it('should handle missing coverage file', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await collector.analyzeGaps('user-service');

      expect(result.error).toBe('coverage_file_not_found');
    });
  });
});

describe('TestCoverageCollector Integration', () => {
  it('should handle full workflow', async () => {
    const collector = new TestCoverageCollector();
    
    // Simulate collection
    const mockData = {
      total: {
        lines: { pct: 70, total: 200, covered: 140 },
        statements: { pct: 68, total: 200, covered: 136 },
        functions: { pct: 55, total: 40, covered: 22 },
        branches: { pct: 45, total: 80, covered: 36 }
      }
    };

    const parsed = collector.parseCoverageData(mockData);
    expect(parsed.lines).toBe(70);

    const badge = collector.generateBadge(parsed.lines);
    expect(badge.color).toBe('yellow');
  });
});