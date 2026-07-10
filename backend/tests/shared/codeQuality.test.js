// backend/tests/shared/codeQuality.test.js
// Unit tests for Code Quality Analysis modules
'use strict';

const { expect } = require('chai');
const path = require('path');
const fs = require('fs').promises;

const {
  CodeComplexityAnalyzer,
  RefactoringRecommender,
  TechnicalDebtScore
} = require('../../shared/codeQuality');

describe('CodeComplexityAnalyzer', function () {
  this.timeout(10000);

  let analyzer;
  let testFilePath;

  before(async () => {
    analyzer = new CodeComplexityAnalyzer();
    
    // Create a test file
    testFilePath = path.join(__dirname, 'test-sample.js');
    const testCode = `
'use strict';

function simpleFunction() {
  return 42;
}

function complexFunction(x, y, z, w, v) {
  if (x > 0) {
    if (y > 0) {
      if (z > 0) {
        if (w > 0) {
          if (v > 0) {
            return x + y + z + w + v;
          }
        }
      }
    }
  } else if (x < 0) {
    for (let i = 0; i < y; i++) {
      while (z > 0) {
        z--;
      }
    }
  } else {
    switch (y) {
      case 1:
        return 1;
      case 2:
        return 2;
      default:
        return 0;
    }
  }
  return 0;
}

class TestClass {
  constructor(name) {
    this.name = name;
  }

  methodA() {
    if (this.name === 'test') {
      return true;
    }
    return false;
  }
}

module.exports = { simpleFunction, complexFunction, TestClass };
`;
    await fs.writeFile(testFilePath, testCode);
  });

  after(async () => {
    await fs.unlink(testFilePath).catch(() => {});
  });

  describe('analyzeFile', () => {
    it('should analyze a single file and return metrics', async () => {
      const results = await analyzer.analyzeFile(testFilePath);

      expect(results).to.have.property('path');
      expect(results).to.have.property('linesOfCode');
      expect(results).to.have.property('cyclomaticComplexity');
      expect(results).to.have.property('cognitiveComplexity');
      expect(results).to.have.property('maintainabilityIndex');
      expect(results).to.have.property('functions');
      expect(results.functions).to.be.an('array');
    });

    it('should correctly count lines of code', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      expect(results.linesOfCode).to.be.greaterThan(10);
    });

    it('should detect function definitions', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      expect(results.functions.length).to.be.greaterThan(0);
    });
  });

  describe('_calculateCyclomaticComplexity', () => {
    it('should calculate complexity for simple function', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      const simpleFunc = results.functions.find(f => f.name === 'simpleFunction');
      
      if (simpleFunc) {
        expect(simpleFunc.cyclomaticComplexity).to.equal(1);
      }
    });

    it('should calculate higher complexity for complex function', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      const complexFunc = results.functions.find(f => f.name === 'complexFunction');
      
      if (complexFunc) {
        expect(complexFunc.cyclomaticComplexity).to.be.greaterThan(5);
      }
    });
  });

  describe('_calculateNestingDepth', () => {
    it('should detect deep nesting', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      
      // complexFunction has 5 levels of nesting
      expect(results.maxNestingDepth).to.be.greaterThanOrEqual(4);
    });
  });

  describe('_calculateMaintainabilityIndex', () => {
    it('should return maintainability index between 0 and 100', async () => {
      const results = await analyzer.analyzeFile(testFilePath);
      expect(results.maintainabilityIndex).to.be.at.least(0);
      expect(results.maintainabilityIndex).to.be.at.most(100);
    });
  });

  describe('generateReport', () => {
    it('should generate JSON report', async () => {
      await analyzer.analyzeFile(testFilePath);
      const report = analyzer.generateReport('json');
      
      expect(report).to.be.a('string');
      const parsed = JSON.parse(report);
      expect(parsed).to.have.property('files');
    });

    it('should generate text report', async () => {
      await analyzer.analyzeFile(testFilePath);
      const report = analyzer.generateReport('text');
      
      expect(report).to.be.a('string');
      expect(report).to.include('Code Complexity Analysis Report');
    });
  });
});

describe('RefactoringRecommender', function () {
  let recommender;

  before(() => {
    recommender = new RefactoringRecommender();
  });

  describe('generateRecommendations', () => {
    it('should generate prioritized recommendations', async () => {
      const analysisResults = {
        files: [
          {
            path: '/test/high-complexity.js',
            fileName: 'high-complexity.js',
            cyclomaticComplexity: 25,
            cognitiveComplexity: 30,
            maintainabilityIndex: 45,
            technicalDebtScore: 30,
            linesOfCode: 300,
            maxNestingDepth: 6,
            functions: [
              { name: 'bigFunction', linesOfCode: 80, cyclomaticComplexity: 18, parameters: [] }
            ],
            imports: [],
            exports: ['main'],
            classes: [],
            issues: [{ type: 'high_complexity', severity: 'high' }]
          },
          {
            path: '/test/simple.js',
            fileName: 'simple.js',
            cyclomaticComplexity: 5,
            cognitiveComplexity: 3,
            maintainabilityIndex: 85,
            technicalDebtScore: 2,
            linesOfCode: 50,
            maxNestingDepth: 2,
            functions: [],
            imports: [],
            exports: [],
            classes: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 2,
          totalLines: 350,
          avgCyclomaticComplexity: 15,
          avgCognitiveComplexity: 16.5,
          avgMaintainabilityIndex: 65,
          technicalDebtScore: 32,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      };

      const recommendations = await recommender.generateRecommendations(analysisResults);

      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
    });

    it('should sort recommendations by priority', async () => {
      const analysisResults = {
        files: [
          {
            path: '/test/critical.js',
            fileName: 'critical.js',
            cyclomaticComplexity: 35,
            cognitiveComplexity: 40,
            maintainabilityIndex: 30,
            technicalDebtScore: 50,
            linesOfCode: 500,
            maxNestingDepth: 8,
            functions: [],
            imports: [],
            exports: [],
            classes: [],
            issues: []
          },
          {
            path: '/test/medium.js',
            fileName: 'medium.js',
            cyclomaticComplexity: 10,
            cognitiveComplexity: 8,
            maintainabilityIndex: 70,
            technicalDebtScore: 10,
            linesOfCode: 100,
            maxNestingDepth: 3,
            functions: [],
            imports: [],
            exports: [],
            classes: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 2,
          totalLines: 600,
          avgCyclomaticComplexity: 22.5,
          avgCognitiveComplexity: 24,
          avgMaintainabilityIndex: 50,
          technicalDebtScore: 60,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      };

      const recommendations = await recommender.generateRecommendations(analysisResults);

      if (recommendations.length >= 2) {
        expect(recommendations[0].priority).to.be.greaterThan(recommendations[1].priority);
      }
    });
  });

  describe('_estimateEffort', () => {
    it('should estimate effort in hours', async () => {
      const file = {
        cyclomaticComplexity: 20,
        linesOfCode: 200,
        functions: [
          { linesOfCode: 60 },
          { linesOfCode: 40 }
        ],
        maxNestingDepth: 5,
        issues: [{ type: 'high_complexity' }]
      };

      const effort = recommender._estimateEffort(file);
      
      expect(effort).to.have.property('hours');
      expect(effort.hours).to.be.greaterThan(0);
      expect(effort).to.have.property('level');
    });
  });

  describe('generateActionPlan', () => {
    it('should categorize recommendations by priority', async () => {
      // First generate some recommendations
      await recommender.generateRecommendations({
        files: [
          {
            path: '/test/file.js',
            fileName: 'file.js',
            cyclomaticComplexity: 20,
            cognitiveComplexity: 15,
            maintainabilityIndex: 55,
            technicalDebtScore: 25,
            linesOfCode: 150,
            maxNestingDepth: 5,
            functions: [],
            imports: [],
            exports: [],
            classes: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 1,
          totalLines: 150,
          avgCyclomaticComplexity: 20,
          avgCognitiveComplexity: 15,
          avgMaintainabilityIndex: 55,
          technicalDebtScore: 25,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      });

      const plan = recommender.generateActionPlan();
      
      expect(plan).to.have.property('plan');
      expect(plan).to.have.property('summary');
      expect(plan.plan).to.have.property('critical');
      expect(plan.plan).to.have.property('high');
      expect(plan.plan).to.have.property('medium');
      expect(plan.plan).to.have.property('low');
    });
  });

  describe('export', () => {
    it('should export to JSON', async () => {
      await recommender.generateRecommendations({
        files: [],
        summary: { totalFiles: 0, totalLines: 0, avgCyclomaticComplexity: 0, avgCognitiveComplexity: 0, avgMaintainabilityIndex: 100, technicalDebtScore: 0, highComplexityFiles: [], highComplexityFunctions: [] }
      });

      const exported = recommender.export('json');
      expect(exported).to.be.a('string');
      
      const parsed = JSON.parse(exported);
      expect(parsed).to.be.an('array');
    });

    it('should export to markdown', async () => {
      await recommender.generateRecommendations({
        files: [],
        summary: { totalFiles: 0, totalLines: 0, avgCyclomaticComplexity: 0, avgCognitiveComplexity: 0, avgMaintainabilityIndex: 100, technicalDebtScore: 0, highComplexityFiles: [], highComplexityFunctions: [] }
      });

      const exported = recommender.export('markdown');
      expect(exported).to.be.a('string');
      expect(exported).to.include('# Refactoring Recommendations');
    });
  });
});

describe('TechnicalDebtScore', function () {
  let debtScorer;

  before(() => {
    debtScorer = new TechnicalDebtScore();
  });

  describe('calculate', () => {
    it('should calculate debt score for project', () => {
      const analysisResults = {
        files: [
          {
            path: '/test/high-debt.js',
            fileName: 'high-debt.js',
            cyclomaticComplexity: 30,
            cognitiveComplexity: 35,
            maintainabilityIndex: 40,
            technicalDebtScore: 25,
            linesOfCode: 400,
            maxNestingDepth: 6,
            functions: [
              { name: 'func1', linesOfCode: 80, parameters: ['a', 'b', 'c', 'd', 'e', 'f'] }
            ],
            issues: []
          },
          {
            path: '/test/low-debt.js',
            fileName: 'low-debt.js',
            cyclomaticComplexity: 5,
            cognitiveComplexity: 3,
            maintainabilityIndex: 85,
            technicalDebtScore: 2,
            linesOfCode: 50,
            maxNestingDepth: 2,
            functions: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 2,
          totalLines: 450,
          avgCyclomaticComplexity: 17.5,
          avgCognitiveComplexity: 19,
          avgMaintainabilityIndex: 62.5,
          technicalDebtScore: 27,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      };

      const result = debtScorer.calculate(analysisResults);

      expect(result).to.have.property('files');
      expect(result).to.have.property('summary');
      expect(result.summary).to.have.property('totalScore');
      expect(result.summary).to.have.property('healthScore');
      expect(result.summary).to.have.property('grade');
    });

    it('should identify debt violations', () => {
      const analysisResults = {
        files: [
          {
            path: '/test/violation.js',
            fileName: 'violation.js',
            cyclomaticComplexity: 30,
            cognitiveComplexity: 40,
            maintainabilityIndex: 35,
            technicalDebtScore: 30,
            linesOfCode: 600,
            maxNestingDepth: 7,
            functions: [
              { name: 'bigFunc', linesOfCode: 120, parameters: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }
            ],
            issues: []
          }
        ],
        summary: {
          totalFiles: 1,
          totalLines: 600,
          avgCyclomaticComplexity: 30,
          avgCognitiveComplexity: 40,
          avgMaintainabilityIndex: 35,
          technicalDebtScore: 30,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      };

      const result = debtScorer.calculate(analysisResults);

      expect(result.files[0].violations.length).to.be.greaterThan(0);
    });

    it('should calculate health score correctly', () => {
      const analysisResults = {
        files: [
          {
            path: '/test/good.js',
            fileName: 'good.js',
            cyclomaticComplexity: 5,
            cognitiveComplexity: 3,
            maintainabilityIndex: 85,
            technicalDebtScore: 2,
            linesOfCode: 50,
            maxNestingDepth: 2,
            functions: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 1,
          totalLines: 50,
          avgCyclomaticComplexity: 5,
          avgCognitiveComplexity: 3,
          avgMaintainabilityIndex: 85,
          technicalDebtScore: 2,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      };

      const result = debtScorer.calculate(analysisResults);
      
      expect(result.summary.healthScore).to.be.greaterThan(50);
    });
  });

  describe('_calculateGrade', () => {
    it('should return A for health score >= 90', () => {
      const grade = debtScorer._calculateGrade(92);
      expect(grade).to.equal('A');
    });

    it('should return B for health score >= 80', () => {
      const grade = debtScorer._calculateGrade(85);
      expect(grade).to.equal('B');
    });

    it('should return C for health score >= 70', () => {
      const grade = debtScorer._calculateGrade(72);
      expect(grade).to.equal('C');
    });

    it('should return D for health score >= 60', () => {
      const grade = debtScorer._calculateGrade(65);
      expect(grade).to.equal('D');
    });

    it('should return F for health score < 50', () => {
      const grade = debtScorer._calculateGrade(40);
      expect(grade).to.equal('F');
    });
  });

  describe('generateReductionPlan', () => {
    it('should generate prioritized debt reduction plan', () => {
      // First calculate debt
      debtScorer.calculate({
        files: [
          {
            path: '/test/file1.js',
            fileName: 'file1.js',
            cyclomaticComplexity: 20,
            cognitiveComplexity: 15,
            maintainabilityIndex: 55,
            technicalDebtScore: 25,
            linesOfCode: 200,
            maxNestingDepth: 5,
            functions: [],
            issues: []
          },
          {
            path: '/test/file2.js',
            fileName: 'file2.js',
            cyclomaticComplexity: 15,
            cognitiveComplexity: 10,
            maintainabilityIndex: 65,
            technicalDebtScore: 15,
            linesOfCode: 150,
            maxNestingDepth: 3,
            functions: [],
            issues: []
          }
        ],
        summary: {
          totalFiles: 2,
          totalLines: 350,
          avgCyclomaticComplexity: 17.5,
          avgCognitiveComplexity: 12.5,
          avgMaintainabilityIndex: 60,
          technicalDebtScore: 40,
          highComplexityFiles: [],
          highComplexityFunctions: []
        }
      });

      const plan = debtScorer.generateReductionPlan(40);
      
      expect(plan).to.have.property('plan');
      expect(plan).to.have.property('summary');
    });
  });

  describe('export', () => {
    it('should export to JSON', () => {
      debtScorer.calculate({
        files: [],
        summary: { totalFiles: 0, totalLines: 0, avgCyclomaticComplexity: 0, avgCognitiveComplexity: 0, avgMaintainabilityIndex: 100, technicalDebtScore: 0, highComplexityFiles: [], highComplexityFunctions: [] }
      });

      const exported = debtScorer.export('json');
      expect(exported).to.be.a('string');
    });

    it('should export to markdown', () => {
      debtScorer.calculate({
        files: [],
        summary: { totalFiles: 0, totalLines: 0, avgCyclomaticComplexity: 0, avgCognitiveComplexity: 0, avgMaintainabilityIndex: 100, technicalDebtScore: 0, highComplexityFiles: [], highComplexityFunctions: [] }
      });

      const exported = debtScorer.export('markdown');
      expect(exported).to.include('# Technical Debt Report');
    });
  });
});