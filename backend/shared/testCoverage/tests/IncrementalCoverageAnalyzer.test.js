'use strict';

const IncrementalCoverageAnalyzer = require('./IncrementalCoverageAnalyzer');
const { expect } = require('@jest/globals');

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}));

describe('IncrementalCoverageAnalyzer', () => {
  let analyzer;
  let mockExec;
  let mockFs;

  beforeEach(() => {
    analyzer = new IncrementalCoverageAnalyzer({
      minLines: 80,
      minFunctions: 80,
      minBranches: 70
    });
    mockExec = require('child_process').execSync;
    mockFs = require('fs');
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct thresholds', () => {
      expect(analyzer.threshold.lines).toBe(80);
      expect(analyzer.threshold.functions).toBe(80);
      expect(analyzer.threshold.branches).toBe(70);
    });

    it('should use default thresholds when not specified', () => {
      const defaultAnalyzer = new IncrementalCoverageAnalyzer();
      
      expect(defaultAnalyzer.threshold.lines).toBe(80);
      expect(defaultAnalyzer.threshold.functions).toBe(80);
    });
  });

  describe('getChangedFiles', () => {
    it('should return list of changed files', () => {
      mockExec.mockReturnValue('backend/services/user/src/auth.js\nbackend/shared/logger.js\nREADME.md');

      const files = analyzer.getChangedFiles('main', 'abc123');

      expect(files).toHaveLength(3);
      expect(files).toContain('backend/services/user/src/auth.js');
    });

    it('should handle empty output', () => {
      mockExec.mockReturnValue('');

      const files = analyzer.getChangedFiles('main', 'abc123');

      expect(files).toHaveLength(0);
    });

    it('should fallback to HEAD~10 on error', () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error('Branch not found');
      });
      mockExec.mockReturnValueOnce('backend/shared/test.js');

      const files = analyzer.getChangedFiles('main', 'abc123');

      expect(mockExec).toHaveBeenCalledTimes(2);
      expect(files).toContain('backend/shared/test.js');
    });
  });

  describe('calculatePercentage', () => {
    it('should calculate coverage percentage correctly', () => {
      const coverage = { '1': 1, '2': 0, '3': 1, '4': 0 };

      const percentage = analyzer.calculatePercentage(coverage);

      expect(percentage).toBe(50); // 2 covered out of 4
    });

    it('should return 0 for empty coverage', () => {
      const percentage = analyzer.calculatePercentage({});

      expect(percentage).toBe(0);
    });

    it('should return 100 for fully covered', () => {
      const coverage = { '1': 1, '2': 2, '3': 1 };

      const percentage = analyzer.calculatePercentage(coverage);

      expect(percentage).toBe(100);
    });
  });

  describe('calculateBranchPercentage', () => {
    it('should calculate branch coverage correctly', () => {
      const branches = {
        '0': [1, 0], // 50% covered
        '1': [1, 1]  // 100% covered
      };

      const percentage = analyzer.calculateBranchPercentage(branches);

      // 3 covered out of 4 = 75%
      expect(percentage).toBe(75);
    });

    it('should handle empty branches', () => {
      const percentage = analyzer.calculateBranchPercentage({});

      expect(percentage).toBe(0);
    });
  });

  describe('checkThreshold', () => {
    it('should pass when coverage meets threshold', () => {
      const coverage = {
        lines: 85,
        statements: 85,
        functions: 82,
        branches: 75
      };

      const passes = analyzer.checkThreshold(coverage);

      expect(passes).toBe(true);
    });

    it('should fail when coverage below threshold', () => {
      const coverage = {
        lines: 75,
        statements: 75,
        functions: 70,
        branches: 60
      };

      const passes = analyzer.checkThreshold(coverage);

      expect(passes).toBe(false);
    });

    it('should fail on partial threshold failure', () => {
      const coverage = {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 65 // below 70
      };

      const passes = analyzer.checkThreshold(coverage);

      expect(passes).toBe(false);
    });
  });

  describe('getCoverageStatus', () => {
    it('should return good for high coverage', () => {
      expect(analyzer.getCoverageStatus(85)).toBe('good');
    });

    it('should return acceptable for medium coverage', () => {
      expect(analyzer.getCoverageStatus(65)).toBe('acceptable');
    });

    it('should return low for moderate coverage', () => {
      expect(analyzer.getCoverageStatus(45)).toBe('low');
    });

    it('should return critical for very low coverage', () => {
      expect(analyzer.getCoverageStatus(20)).toBe('critical');
    });
  });

  describe('calculateAverageCoverage', () => {
    it('should calculate average correctly', () => {
      const files = [
        { lines: 80, statements: 80, functions: 75, branches: 70 },
        { lines: 60, statements: 60, functions: 55, branches: 50 }
      ];

      const avg = analyzer.calculateAverageCoverage(files);

      expect(avg.lines).toBe(70);
      expect(avg.functions).toBe(65);
    });

    it('should return null for empty array', () => {
      const avg = analyzer.calculateAverageCoverage([]);

      expect(avg).toBeNull();
    });
  });

  describe('analyzeFileCoverage', () => {
    it('should extract coverage from file data', () => {
      const coverageData = {
        'backend/shared/test.js': {
          l: { '1': 1, '2': 0, '3': 1 },
          f: { '0': 1, '1': 0 },
          b: { '0': [1, 0] }
        }
      };

      const result = analyzer.analyzeFileCoverage('backend/shared/test.js', coverageData);

      expect(result.lines).toBeCloseTo(66.67, 1);
      expect(result.functions).toBe(50);
      expect(result.branches).toBe(50);
    });

    it('should return null for missing file', () => {
      const result = analyzer.analyzeFileCoverage('unknown.js', {});

      expect(result).toBeNull();
    });
  });

  describe('analyze', () => {
    it('should return no JS changes when no backend files changed', async () => {
      mockExec.mockReturnValue('README.md\nCHANGELOG.md');

      const result = await analyzer.analyze('main', 'abc123');

      expect(result.hasJsChanges).toBe(false);
      expect(result.passes).toBe(true);
    });

    it('should analyze changed JS files', async () => {
      mockExec.mockReturnValue('backend/shared/test.js');
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        'test.js': {
          l: { '1': 1, '2': 1, '3': 1 },
          f: { '0': 1 },
          b: {}
        }
      }));

      const result = await analyzer.analyze('main', 'abc123');

      expect(result.hasJsChanges).toBe(true);
      expect(result.totalFiles).toBe(1);
    });
  });

  describe('generateSummary', () => {
    it('should generate markdown summary', () => {
      const result = {
        hasJsChanges: true,
        totalFiles: 5,
        filesWithCoverage: 4,
        filesWithoutCoverage: 1,
        filesBelowThreshold: 2,
        passes: false,
        averageCoverage: { lines: 65, functions: 60, branches: 55 },
        threshold: { lines: 80, functions: 80, branches: 70 },
        fileResults: [
          { file: 'test1.js', hasCoverage: true, meetsThreshold: false, lines: 70, functions: 65 },
          { file: 'test2.js', hasCoverage: true, meetsThreshold: false, lines: 60, functions: 55 }
        ]
      };

      const summary = analyzer.generateSummary(result);

      expect(summary).toContain('📊 Incremental Coverage Report');
      expect(summary).toContain('❌ FAILED');
      expect(summary).toContain('Files below threshold: 2');
    });

    it('should generate passing summary', () => {
      const result = {
        hasJsChanges: false,
        message: 'No JavaScript files',
        passes: true
      };

      const summary = analyzer.generateSummary(result);

      expect(summary).toContain('No JavaScript files');
    });
  });
});

describe('IncrementalCoverageAnalyzer Integration', () => {
  it('should handle complete analysis workflow', async () => {
    const analyzer = new IncrementalCoverageAnalyzer({
      minLines: 70,
      minFunctions: 70
    });

    // Simulate coverage data
    const coverage = {
      lines: 75,
      statements: 75,
      functions: 72,
      branches: 65
    };

    const passes = analyzer.checkThreshold(coverage);
    expect(passes).toBe(true);

    const status = analyzer.getCoverageStatus(coverage.lines);
    expect(status).toBe('acceptable');
  });
});