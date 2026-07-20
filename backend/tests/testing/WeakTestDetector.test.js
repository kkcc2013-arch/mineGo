// backend/tests/testing/WeakTestDetector.test.js
// 弱测试检测器单元测试

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { WeakTestDetector, WeakTestType, Severity } = require('../../shared/testing/WeakTestDetector');

// Mock fs.promises
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn()
  }
}));

describe('WeakTestDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new WeakTestDetector();
    jest.clearAllMocks();
  });

  describe('extractTestCases', () => {
    it('should extract test cases with assertions', () => {
      const content = `
        describe('MyClass', () => {
          it('should work correctly', () => {
            const result = calculate(10);
            expect(result).toBe(20);
          });
          
          test('handles edge case', () => {
            expect(handle(null)).toBeUndefined();
          });
        });
      `;

      const testCases = detector.extractTestCases(content);

      expect(testCases.length).toBe(2);
      expect(testCases[0].name).toBe('should work correctly');
      expect(testCases[0].assertions.length).toBe(1);
      expect(testCases[0].assertions[0].matcher).toBe('toBe');
    });

    it('should extract test cases with multiple assertions', () => {
      const content = `
        it('validates input', () => {
          expect(result).toBeDefined();
          expect(result).toBeTruthy();
          expect(result.value).toBe(42);
        });
      `;

      const testCases = detector.extractTestCases(content);

      expect(testCases.length).toBe(1);
      expect(testCases[0].assertions.length).toBe(3);
    });

    it('should handle empty content', () => {
      const testCases = detector.extractTestCases('');

      expect(testCases).toEqual([]);
    });
  });

  describe('detectNoAssertion', () => {
    it('should detect test with no assertions', () => {
      const testCase = {
        name: 'empty test',
        body: 'const result = calculate(10);',
        line: 1,
        assertions: []
      };

      const issue = detector.detectNoAssertion('/test/file.test.js', testCase);

      expect(issue).toBeDefined();
      expect(issue.type).toBe(WeakTestType.NO_ASSERTION);
      expect(issue.severity).toBe(Severity.CRITICAL);
      expect(issue.message).toContain('没有任何断言');
    });

    it('should not detect issue when assertions exist', () => {
      const testCase = {
        name: 'valid test',
        body: 'expect(result).toBe(42);',
        line: 1,
        assertions: [{ full: 'expect(result).toBe(42)', matcher: 'toBe' }]
      };

      const issue = detector.detectNoAssertion('/test/file.test.js', testCase);

      expect(issue).toBeNull();
    });
  });

  describe('detectWeakAssertion', () => {
    it('should detect weak assertions only', () => {
      const testCase = {
        name: 'weak test',
        body: 'expect(result).toBeTruthy();',
        line: 1,
        assertions: [{ full: 'expect(result).toBeTruthy()', matcher: 'toBeTruthy' }]
      };

      const issue = detector.detectWeakAssertion('/test/file.test.js', testCase);

      expect(issue).toBeDefined();
      expect(issue.type).toBe(WeakTestType.WEAK_ASSERTION);
      expect(issue.severity).toBe(Severity.HIGH);
      expect(issue.details).toContain('toBeTruthy');
    });

    it('should not flag mixed strong and weak assertions', () => {
      const testCase = {
        name: 'mixed test',
        body: 'expect(result).toBeTruthy(); expect(result.value).toBe(42);',
        line: 1,
        assertions: [
          { full: 'expect(result).toBeTruthy()', matcher: 'toBeTruthy' },
          { full: 'expect(result.value).toBe(42)', matcher: 'toBe' }
        ]
      };

      const issue = detector.detectWeakAssertion('/test/file.test.js', testCase);

      expect(issue).toBeNull();
    });

    it('should detect toBeDefined as weak assertion', () => {
      const testCase = {
        name: 'weak test',
        body: 'expect(result).toBeDefined();',
        line: 1,
        assertions: [{ full: 'expect(result).toBeDefined()', matcher: 'toBeDefined' }]
      };

      const issue = detector.detectWeakAssertion('/test/file.test.js', testCase);

      expect(issue).toBeDefined();
      expect(issue.details).toContain('toBeDefined');
    });
  });

  describe('detectMissingErrorTest', () => {
    it('should detect missing error test for validate functions', () => {
      const testCase = {
        name: 'validates input correctly',
        body: 'const result = validate(input); expect(result).toBe(true);',
        line: 1,
        assertions: [{ full: 'expect(result).toBe(true)', matcher: 'toBe' }]
      };

      const issue = detector.detectMissingErrorTest('/test/file.test.js', testCase);

      expect(issue).toBeDefined();
      expect(issue.type).toBe(WeakTestType.MISSING_ERROR_TEST);
      expect(issue.severity).toBe(Severity.MEDIUM);
    });

    it('should not flag tests that already have error tests', () => {
      const testCase = {
        name: 'validates input correctly',
        body: 'expect(() => validate(null)).toThrow();',
        line: 1,
        assertions: [{ full: 'expect(() => validate(null)).toThrow()', matcher: 'toThrow' }]
      };

      const issue = detector.detectMissingErrorTest('/test/file.test.js', testCase);

      expect(issue).toBeNull();
    });

    it('should not flag tests with error in name', () => {
      const testCase = {
        name: 'throws error for invalid input',
        body: 'expect(validate(null)).toBe(false);',
        line: 1,
        assertions: [{ full: 'expect(validate(null)).toBe(false)', matcher: 'toBe' }]
      };

      const issue = detector.detectMissingErrorTest('/test/file.test.js', testCase);

      expect(issue).toBeNull();
    });
  });

  describe('detectMagicNumbers', () => {
    it('should detect magic numbers in test', () => {
      const testCase = {
        name: 'test with magic numbers',
        body: 'expect(calculate(12345)).toBe(67890);',
        line: 1,
        assertions: []
      };

      const issues = detector.detectMagicNumbers('/test/file.test.js', testCase);

      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].type).toBe(WeakTestType.MAGIC_NUMBER);
      expect(issues[0].severity).toBe(Severity.LOW);
    });

    it('should not flag common values like 1000', () => {
      const testCase = {
        name: 'test with common values',
        body: 'expect(timeout).toBe(1000);',
        line: 1,
        assertions: []
      };

      const issues = detector.detectMagicNumbers('/test/file.test.js', testCase);

      expect(issues.length).toBe(0);
    });

    it('should not flag short numbers', () => {
      const testCase = {
        name: 'test with short numbers',
        body: 'expect(count).toBe(42);',
        line: 1,
        assertions: []
      };

      const issues = detector.detectMagicNumbers('/test/file.test.js', testCase);

      expect(issues.length).toBe(0);
    });
  });

  describe('detectDuplicateTests', () => {
    it('should detect duplicate tests', () => {
      const testCases = [
        { name: 'test A', body: 'expect(x).toBe(1)', line: 1, assertions: [{ matcher: 'toBe' }] },
        { name: 'test A', body: 'expect(x).toBe(1)', line: 10, assertions: [{ matcher: 'toBe' }] }
      ];

      const issues = detector.detectDuplicateTests('/test/file.test.js', testCases);

      expect(issues.length).toBe(1);
      expect(issues[0].type).toBe(WeakTestType.REDUNDANT_TEST);
      expect(issues[0].details).toContain('第 1 行');
    });

    it('should not flag different tests', () => {
      const testCases = [
        { name: 'test A', body: 'expect(x).toBe(1)', line: 1, assertions: [{ matcher: 'toBe' }] },
        { name: 'test B', body: 'expect(x).toBe(2)', line: 10, assertions: [{ matcher: 'toBe' }] }
      ];

      const issues = detector.detectDuplicateTests('/test/file.test.js', testCases);

      expect(issues.length).toBe(0);
    });
  });

  describe('generateImprovementPlan', () => {
    it('should generate improvement plan', () => {
      detector.weakTests = [
        { type: WeakTestType.NO_ASSERTION, severity: Severity.CRITICAL },
        { type: WeakTestType.WEAK_ASSERTION, severity: Severity.HIGH },
        { type: WeakTestType.WEAK_ASSERTION, severity: Severity.HIGH },
        { type: WeakTestType.MAGIC_NUMBER, severity: Severity.LOW }
      ];
      detector.stats = { totalFiles: 5, totalTests: 20, weakTestsFound: 4 };

      const plan = detector.generateImprovementPlan();

      expect(plan.summary.totalIssues).toBe(4);
      expect(plan.byType[WeakTestType.WEAK_ASSERTION]).toBe(2);
      expect(plan.bySeverity[Severity.HIGH]).toBe(2);
      expect(plan.criticalIssues.length).toBe(1);
      expect(plan.summary.estimatedEffortHours).toBeGreaterThan(0);
    });

    it('should handle empty issues', () => {
      detector.weakTests = [];
      detector.stats = { totalFiles: 5, totalTests: 20, weakTestsFound: 0 };

      const plan = detector.generateImprovementPlan();

      expect(plan.summary.totalIssues).toBe(0);
      expect(plan.criticalIssues).toEqual([]);
    });
  });

  describe('analyzeTestFile', () => {
    it('should analyze file and return issues', async () => {
      const mockContent = `
        describe('MyClass', () => {
          it('should work', () => {
            const result = calculate(12345);
          });
          
          it('validates input', () => {
            expect(validate('test')).toBeTruthy();
          });
        });
      `;

      fs.readFile.mockResolvedValue(mockContent);

      const issues = await detector.analyzeTestFile('/test/file.test.js');

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some(i => i.type === WeakTestType.NO_ASSERTION)).toBe(true);
      expect(issues.some(i => i.type === WeakTestType.WEAK_ASSERTION)).toBe(true);
    });
  });

  describe('scanDirectory', () => {
    it('should scan directory and find issues', async () => {
      fs.readdir.mockImplementation(async (dir) => {
        if (dir === '/test') {
          return [
            { isDirectory: () => false, name: 'file1.test.js' },
            { isDirectory: () => false, name: 'file2.test.js' }
          ];
        }
        return [];
      });

      fs.readFile.mockResolvedValue(`
        it('test A', () => {
          expect(result).toBeTruthy();
        });
      `);

      const issues = await detector.scanDirectory('/test');

      expect(detector.stats.totalFiles).toBe(2);
      expect(detector.weakTests.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('toJSON', () => {
    it('should return valid JSON', () => {
      detector.weakTests = [{ type: 'test', severity: 'low' }];
      detector.stats = { totalFiles: 1, totalTests: 1, weakTestsFound: 1 };

      const json = detector.toJSON();
      const parsed = JSON.parse(json);

      expect(parsed.stats.totalFiles).toBe(1);
      expect(parsed.weakTests.length).toBe(1);
    });
  });
});