'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logger');

const logger = createLogger('incremental-coverage');

/**
 * 增量覆盖率分析器
 * 分析 PR 中变更文件的覆盖率，仅检查新增/修改代码
 */
class IncrementalCoverageAnalyzer {
  constructor(options = {}) {
    this.threshold = {
      lines: options.minLines || 80,
      statements: options.minStatements || 80,
      functions: options.minFunctions || 80,
      branches: options.minBranches || 70
    };
    this.rootDir = options.rootDir || process.cwd();
  }

  /**
   * 分析 PR 的增量覆盖率
   * @param {string} baseBranch - 基础分支
   * @param {string} headSha - PR HEAD commit SHA
   * @returns {Promise<object>} 增量覆盖率结果
   */
  async analyze(baseBranch, headSha) {
    const startTime = Date.now();

    logger.info({ baseBranch, headSha }, 'Starting incremental coverage analysis');

    // 1. 获取变更文件列表
    const changedFiles = this.getChangedFiles(baseBranch, headSha);

    // 2. 筛选需要覆盖率的 JS 文件
    const jsFiles = changedFiles.filter(f =>
      f.startsWith('backend/') &&
      f.endsWith('.js') &&
      !f.includes('.test.') &&
      !f.includes('.spec.') &&
      !f.includes('node_modules') &&
      !f.includes('__tests__') &&
      !f.includes('migrations/') &&
      !f.includes('config/')
    );

    if (jsFiles.length === 0) {
      return {
        hasJsChanges: false,
        message: 'No JavaScript files requiring coverage were changed',
        changedFiles,
        passes: true
      };
    }

    logger.info({ jsFileCount: jsFiles.length }, 'Found JS files to analyze');

    // 3. 加载覆盖率数据
    const coverageData = this.loadAllCoverageData();

    // 4. 分析每个变更文件的覆盖率
    const fileResults = [];

    for (const file of jsFiles) {
      const fileCoverage = this.analyzeFileCoverage(file, coverageData);

      if (fileCoverage) {
        const meetsThreshold = this.checkThreshold(fileCoverage);
        fileResults.push({
          file,
          ...fileCoverage,
          hasCoverage: true,
          meetsThreshold,
          coverageStatus: this.getCoverageStatus(fileCoverage.lines)
        });
      } else {
        fileResults.push({
          file,
          hasCoverage: false,
          message: 'No coverage data for this file (possibly new file)',
          coverageStatus: 'missing'
        });
      }
    }

    // 5. 汇总结果
    const filesWithCoverage = fileResults.filter(f => f.hasCoverage);
    const filesBelowThreshold = fileResults.filter(f => f.hasCoverage && !f.meetsThreshold);
    const filesWithoutCoverage = fileResults.filter(f => !f.hasCoverage);

    const avgCoverage = this.calculateAverageCoverage(filesWithCoverage);

    const duration = Date.now() - startTime;

    const result = {
      hasJsChanges: true,
      totalFiles: jsFiles.length,
      filesWithCoverage: filesWithCoverage.length,
      filesWithoutCoverage: filesWithoutCoverage.length,
      filesBelowThreshold: filesBelowThreshold.length,
      averageCoverage: avgCoverage,
      passes: filesBelowThreshold.length === 0 && filesWithoutCoverage.length === 0,
      threshold: this.threshold,
      fileResults,
      changedFiles,
      duration,
      analyzedAt: new Date().toISOString()
    };

    logger.info({
      passes: result.passes,
      filesBelowThreshold: filesBelowThreshold.length,
      avgLines: avgCoverage?.lines?.toFixed(1),
      duration
    }, 'Incremental coverage analysis completed');

    return result;
  }

  /**
   * 获取变更文件列表
   */
  getChangedFiles(baseBranch, headSha) {
    try {
      // 尝试使用 git diff
      const output = execSync(
        `git diff --name-only origin/${baseBranch} ${headSha}`,
        { encoding: 'utf8', cwd: this.rootDir }
      );

      return output.trim().split('\n').filter(f => f);
    } catch (err) {
      // 回退到 HEAD 比较最后 N 个 commit
      try {
        const output = execSync(
          `git diff --name-only HEAD~10 HEAD`,
          { encoding: 'utf8', cwd: this.rootDir }
        );
        return output.trim().split('\n').filter(f => f);
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr }, 'Failed to get changed files');
        return [];
      }
    }
  }

  /**
   * 加载所有服务的覆盖率数据
   */
  loadAllCoverageData() {
    const data = {};

    // 加载各服务覆盖率
    const services = [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];

    for (const service of services) {
      const coveragePath = path.join(
        this.rootDir,
        'backend/services',
        service,
        'coverage',
        'coverage-final.json'
      );

      if (fs.existsSync(coveragePath)) {
        try {
          const serviceData = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

          for (const [filePath, coverage] of Object.entries(serviceData)) {
            // 规范化路径
            const normalizedPath = this.normalizePath(filePath, service, 'service');
            data[normalizedPath] = coverage;
          }
        } catch (err) {
          logger.warn({ service, err: err.message }, 'Failed to load coverage');
        }
      }
    }

    // 加载 backend/shared 覆盖率
    const sharedPath = path.join(
      this.rootDir,
      'backend/shared',
      'coverage',
      'coverage-final.json'
    );

    if (fs.existsSync(sharedPath)) {
      try {
        const sharedData = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
        for (const [filePath, coverage] of Object.entries(sharedData)) {
          const normalizedPath = this.normalizePath(filePath, 'shared', 'shared');
          data[normalizedPath] = coverage;
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to load shared coverage');
      }
    }

    logger.info({ fileCount: Object.keys(data).length }, 'Coverage data loaded');

    return data;
  }

  /**
   * 规范化文件路径
   */
  normalizePath(filePath, module, type) {
    // 处理 Jest 输出的路径格式
    let normalized = filePath;

    // 移除前缀路径
    if (normalized.includes('/backend/')) {
      normalized = normalized.substring(normalized.indexOf('/backend/') + 1);
    }

    // 确保以 backend/ 开头
    if (!normalized.startsWith('backend/')) {
      if (type === 'service') {
        normalized = path.join('backend/services', module, normalized);
      } else if (type === 'shared') {
        normalized = path.join('backend/shared', normalized);
      }
    }

    return path.normalize(normalized);
  }

  /**
   * 分析单个文件的覆盖率
   */
  analyzeFileCoverage(filePath, coverageData) {
    // 尝试多种路径格式匹配
    const possiblePaths = [
      filePath,
      path.normalize(filePath),
      filePath.replace(/^\.\//, ''),
      path.join(this.rootDir, filePath)
    ];

    let fileCoverage = null;

    for (const p of possiblePaths) {
      if (coverageData[p]) {
        fileCoverage = coverageData[p];
        break;
      }
    }

    if (!fileCoverage) {
      // 尝试部分匹配
      for (const [dataPath, coverage] of Object.entries(coverageData)) {
        if (dataPath.endsWith(filePath) || filePath.endsWith(dataPath)) {
          fileCoverage = coverage;
          break;
        }
      }
    }

    if (!fileCoverage) return null;

    // 计算覆盖率百分比
    const lines = fileCoverage.l || {};
    const functions = fileCoverage.f || {};
    const branches = fileCoverage.b || {};

    return {
      lines: this.calculatePercentage(lines),
      statements: this.calculatePercentage(lines), // Jest 中 statements ≈ lines
      functions: this.calculatePercentageFromValues(functions),
      branches: this.calculateBranchPercentage(branches),
      totalLines: Object.keys(lines).length,
      coveredLines: Object.values(lines).filter(c => c > 0).length,
      totalFunctions: Object.keys(functions).length,
      coveredFunctions: Object.values(functions).filter(c => c > 0).length
    };
  }

  /**
   * 计算覆盖率百分比
   */
  calculatePercentage(coverage) {
    const values = Object.values(coverage);
    if (values.length === 0) return 0;

    const covered = values.filter(v => v > 0).length;
    return (covered / values.length) * 100;
  }

  /**
   * 从值数组计算百分比
   */
  calculatePercentageFromValues(obj) {
    const values = Object.values(obj);
    if (values.length === 0) return 0;

    const covered = values.filter(v => v > 0).length;
    return (covered / values.length) * 100;
  }

  /**
   * 计算分支覆盖率
   */
  calculateBranchPercentage(branches) {
    const allCounts = Object.values(branches).flat();
    if (allCounts.length === 0) return 0;

    const covered = allCounts.filter(c => c > 0).length;
    return (covered / allCounts.length) * 100;
  }

  /**
   * 检查是否满足阈值
   */
  checkThreshold(coverage) {
    return (
      coverage.lines >= this.threshold.lines &&
      coverage.statements >= this.threshold.statements &&
      coverage.functions >= this.threshold.functions &&
      coverage.branches >= this.threshold.branches
    );
  }

  /**
   * 获取覆盖率状态
   */
  getCoverageStatus(coverage) {
    if (coverage >= 80) return 'good';
    if (coverage >= 60) return 'acceptable';
    if (coverage >= 40) return 'low';
    return 'critical';
  }

  /**
   * 计算平均覆盖率
   */
  calculateAverageCoverage(files) {
    if (files.length === 0) return null;

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      lines: avg(files.map(f => f.lines || 0)),
      statements: avg(files.map(f => f.statements || 0)),
      functions: avg(files.map(f => f.functions || 0)),
      branches: avg(files.map(f => f.branches || 0))
    };
  }

  /**
   * 生成覆盖率报告摘要
   */
  generateSummary(result) {
    const lines = [];

    lines.push('## 📊 Incremental Coverage Report');
    lines.push('');

    if (!result.hasJsChanges) {
      lines.push('✅ No JavaScript files requiring coverage were changed.');
      return lines.join('\n');
    }

    lines.push(`| Metric | Value | Threshold | Status |`);
    lines.push(`|--------|-------|-----------|--------|`);

    const coverage = result.averageCoverage || {};
    const thresholds = this.threshold;

    const formatMetric = (name, value, threshold) => {
      const status = value >= threshold ? '✅' : '❌';
      return `| ${name} | ${(value || 0).toFixed(1)}% | ${threshold}% | ${status} |`;
    };

    lines.push(formatMetric('Lines', coverage.lines, thresholds.lines));
    lines.push(formatMetric('Functions', coverage.functions, thresholds.functions));
    lines.push(formatMetric('Branches', coverage.branches, thresholds.branches));

    lines.push('');
    lines.push(`**Files analyzed:** ${result.totalFiles}`);
    lines.push(`**Files with coverage:** ${result.filesWithCoverage}`);
    lines.push(`**Files without coverage:** ${result.filesWithoutCoverage}`);
    lines.push(`**Files below threshold:** ${result.filesBelowThreshold}`);

    if (result.filesBelowThreshold > 0) {
      lines.push('');
      lines.push('### ⚠️ Files below threshold');
      lines.push('');

      const belowThreshold = result.fileResults.filter(f => f.hasCoverage && !f.meetsThreshold);
      for (const file of belowThreshold.slice(0, 10)) {
        lines.push(`- \`${file.file}\` - Lines: ${file.lines.toFixed(1)}%, Functions: ${file.functions.toFixed(1)}%`);
      }
    }

    lines.push('');
    lines.push(`**Result:** ${result.passes ? '✅ PASSED' : '❌ FAILED'}`);

    return lines.join('\n');
  }
}

module.exports = IncrementalCoverageAnalyzer;
