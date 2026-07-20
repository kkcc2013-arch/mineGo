// backend/shared/testing/WeakTestDetector.js
// 弱测试检测器

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../logger');

const logger = createLogger('weak-test-detector');

/**
 * 弱测试类型枚举
 */
const WeakTestType = {
  NO_ASSERTION: 'no_assertion',
  WEAK_ASSERTION: 'weak_assertion',
  MISSING_ERROR_TEST: 'missing_error_test',
  MAGIC_NUMBER: 'magic_number',
  MISSING_BOUNDARY: 'missing_boundary',
  REDUNDANT_TEST: 'redundant_test',
  FLAKY_TEST: 'flaky_test'
};

/**
 * 严重程度枚举
 */
const Severity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

/**
 * 弱测试检测器
 * 自动识别无效测试、冗余测试、缺失断言等
 */
class WeakTestDetector {
  constructor(options = {}) {
    this.options = {
      testPattern: /\.test\.js$/,
      excludePatterns: [/node_modules/, /__mocks__/],
      ...options
    };
    
    this.weakTests = [];
    this.stats = {
      totalFiles: 0,
      totalTests: 0,
      weakTestsFound: 0
    };
  }

  /**
   * 扫描目录下所有测试文件
   * @param {string} testDir - 测试目录
   * @returns {Object[]} - 弱测试列表
   */
  async scanDirectory(testDir) {
    this.weakTests = [];
    this.stats = { totalFiles: 0, totalTests: 0, weakTestsFound: 0 };

    const files = await this.findTestFiles(testDir);
    
    for (const file of files) {
      try {
        const issues = await this.analyzeTestFile(file);
        this.weakTests.push(...issues);
        this.stats.totalFiles++;
      } catch (error) {
        logger.warn(`Failed to analyze file: ${file}`, { error: error.message });
      }
    }

    this.stats.weakTestsFound = this.weakTests.length;
    
    logger.info('Weak test detection completed', this.stats);
    
    return this.weakTests;
  }

  /**
   * 查找测试文件
   */
  async findTestFiles(dir) {
    const files = [];
    
    const traverse = async (currentDir) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        // 排除模式
        if (this.options.excludePatterns.some(p => p.test(fullPath))) {
          continue;
        }
        
        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (this.options.testPattern.test(entry.name)) {
          files.push(fullPath);
        }
      }
    };
    
    await traverse(dir);
    return files;
  }

  /**
   * 分析单个测试文件
   * @param {string} testFilePath - 测试文件路径
   * @returns {Object[]} - 检测到的问题
   */
  async analyzeTestFile(testFilePath) {
    const content = await fs.readFile(testFilePath, 'utf-8');
    const issues = [];
    
    // 解析测试用例
    const testCases = this.extractTestCases(content);
    this.stats.totalTests += testCases.length;
    
    for (const testCase of testCases) {
      // 检测 1: 无断言测试
      const noAssertionIssue = this.detectNoAssertion(testFilePath, testCase);
      if (noAssertionIssue) {
        issues.push(noAssertionIssue);
        continue; // 无断言的情况下不再检查其他问题
      }
      
      // 检测 2: 弱断言
      const weakAssertionIssue = this.detectWeakAssertion(testFilePath, testCase);
      if (weakAssertionIssue) {
        issues.push(weakAssertionIssue);
      }
      
      // 检测 3: 缺少错误场景测试
      const errorTestIssue = this.detectMissingErrorTest(testFilePath, testCase);
      if (errorTestIssue) {
        issues.push(errorTestIssue);
      }
      
      // 检测 4: 硬编码值（魔法数字）
      const magicNumberIssues = this.detectMagicNumbers(testFilePath, testCase);
      issues.push(...magicNumberIssues);
    }
    
    // 检测 5: 文件级别的重复测试
    const duplicateTests = this.detectDuplicateTests(testFilePath, testCases);
    issues.push(...duplicateTests);
    
    return issues;
  }

  /**
   * 提取测试用例
   */
  extractTestCases(content) {
    const testCases = [];
    
    // 匹配 it()、test()、describe() 块
    const testRegex = /(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\(?([^)]*)\)?\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
    const matches = content.matchAll(testRegex);
    
    let matchIndex = 0;
    for (const match of matches) {
      const [fullMatch, testName, params, body] = match;
      const lines = content.substring(0, match.index).split('\n');
      const lineNumber = lines.length;
      
      testCases.push({
        name: testName,
        body: body,
        fullMatch: fullMatch,
        line: lineNumber,
        assertions: this.extractAssertions(body),
        index: matchIndex++
      });
    }
    
    return testCases;
  }

  /**
   * 提取断言
   */
  extractAssertions(body) {
    const assertions = [];
    
    // 匹配 expect().toBe() 等断言
    const expectRegex = /expect\s*\([^)]+\)\s*\.\s*(\w+)\s*\([^)]*\)/g;
    const matches = body.matchAll(expectRegex);
    
    for (const match of matches) {
      assertions.push({
        full: match[0],
        matcher: match[1]
      });
    }
    
    return assertions;
  }

  /**
   * 检测无断言测试
   */
  detectNoAssertion(filePath, testCase) {
    if (testCase.assertions.length === 0) {
      return {
        type: WeakTestType.NO_ASSERTION,
        severity: Severity.CRITICAL,
        file: filePath,
        test: testCase.name,
        line: testCase.line,
        message: '测试用例没有任何断言',
        suggestion: '添加 expect() 或 assert() 语句验证实际结果'
      };
    }
    return null;
  }

  /**
   * 检测弱断言
   */
  detectWeakAssertion(filePath, testCase) {
    // 弱断言列表
    const weakMatchers = ['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNaN'];
    
    const weakAssertions = testCase.assertions.filter(a => 
      weakMatchers.includes(a.matcher)
    );
    
    // 如果所有断言都是弱断言
    if (weakAssertions.length > 0 && weakAssertions.length === testCase.assertions.length) {
      return {
        type: WeakTestType.WEAK_ASSERTION,
        severity: Severity.HIGH,
        file: filePath,
        test: testCase.name,
        line: testCase.line,
        message: '断言过于宽松，无法精确验证结果',
        details: `弱断言: ${weakAssertions.map(a => a.matcher).join(', ')}`,
        suggestion: '使用 toBe、toEqual、toMatchSnapshot 等更严格的断言'
      };
    }
    
    return null;
  }

  /**
   * 检测缺少错误场景测试
   */
  detectMissingErrorTest(filePath, testCase) {
    // 检查测试名称是否暗示需要错误测试
    const functionPatterns = [
      /validate/i, /parse/i, /calculate/i, /process/i,
      /create/i, /update/i, /delete/i, /handle/i
    ];
    
    const isErrorRelated = /error|fail|throw|invalid|exception/i.test(testCase.name);
    const shouldHaveErrorTest = functionPatterns.some(p => p.test(testCase.name));
    
    // 检查是否有错误处理测试
    const hasErrorTest = /throw|catch|error|reject/i.test(testCase.body);
    
    if (shouldHaveErrorTest && !isErrorRelated && !hasErrorTest) {
      return {
        type: WeakTestType.MISSING_ERROR_TEST,
        severity: Severity.MEDIUM,
        file: filePath,
        test: testCase.name,
        line: testCase.line,
        message: '缺少错误场景测试',
        suggestion: '添加无效输入、null、undefined、边界值等异常场景测试'
      };
    }
    
    return null;
  }

  /**
   * 检测硬编码值（魔法数字）
   */
  detectMagicNumbers(filePath, testCase) {
    const issues = [];
    
    // 检测魔法数字（不在常量定义中的数字）
    const magicNumberRegex = /(?:\b|[,\(])(\d{3,})(?:\b|[,\)])/g;
    const matches = testCase.body.matchAll(magicNumberRegex);
    
    const magicNumbers = [];
    for (const match of matches) {
      const num = parseInt(match[1]);
      // 排除常见合理值
      if (num !== 1000 && num !== 2000 && num !== 3000) {
        magicNumbers.push(num);
      }
    }
    
    if (magicNumbers.length > 0) {
      issues.push({
        type: WeakTestType.MAGIC_NUMBER,
        severity: Severity.LOW,
        file: filePath,
        test: testCase.name,
        line: testCase.line,
        message: '测试使用硬编码值（魔法数字）',
        details: `发现数字: ${magicNumbers.join(', ')}`,
        suggestion: '使用命名常量或变量，提高可读性和可维护性'
      });
    }
    
    return issues;
  }

  /**
   * 检测重复测试
   */
  detectDuplicateTests(filePath, testCases) {
    const issues = [];
    const seen = new Map();
    
    for (const testCase of testCases) {
      // 使用测试名称和断言作为指纹
      const fingerprint = `${testCase.name}:${testCase.assertions.map(a => a.matcher).join(',')}`;
      
      if (seen.has(fingerprint)) {
        issues.push({
          type: WeakTestType.REDUNDANT_TEST,
          severity: Severity.LOW,
          file: filePath,
          test: testCase.name,
          line: testCase.line,
          message: '检测到重复或相似的测试用例',
          details: `与第 ${seen.get(fingerprint)} 行的测试相似`,
          suggestion: '合并重复测试或为每个测试添加不同的断言'
        });
      } else {
        seen.set(fingerprint, testCase.line);
      }
    }
    
    return issues;
  }

  /**
   * 生成改进计划
   * @returns {Object} - 改进计划
   */
  generateImprovementPlan() {
    const byType = {};
    const bySeverity = {};
    
    for (const issue of this.weakTests) {
      byType[issue.type] = (byType[issue.type] || 0) + 1;
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    }
    
    const effort = {
      [Severity.CRITICAL]: 0.5,
      [Severity.HIGH]: 0.3,
      [Severity.MEDIUM]: 0.2,
      [Severity.LOW]: 0.1
    };
    
    const totalEffort = this.weakTests.reduce((sum, issue) => 
      sum + (effort[issue.severity] || 0.2), 0
    );
    
    return {
      summary: {
        totalIssues: this.weakTests.length,
        totalFiles: this.stats.totalFiles,
        totalTests: this.stats.totalTests,
        estimatedEffortHours: Math.round(totalEffort * 10) / 10
      },
      byType,
      bySeverity,
      criticalIssues: this.weakTests.filter(i => i.severity === Severity.CRITICAL),
      highPriorityIssues: this.weakTests.filter(i => i.severity === Severity.HIGH),
      allIssues: this.weakTests
    };
  }

  /**
   * 输出 JSON 报告
   */
  toJSON() {
    return JSON.stringify({
      stats: this.stats,
      weakTests: this.weakTests
    }, null, 2);
  }
}

module.exports = {
  WeakTestDetector,
  WeakTestType,
  Severity
};