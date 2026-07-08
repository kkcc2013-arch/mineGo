'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logger');

const logger = createLogger('test-coverage-collector');

/**
 * 测试覆盖率收集器
 * 收集所有微服务的测试覆盖率数据并汇总
 */
class TestCoverageCollector {
  constructor() {
    this.services = [
      'gateway',
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];
    this.sharedModules = ['backend/shared'];
  }

  /**
   * 收集所有服务的覆盖率数据
   * @param {string} buildId - CI 构建 ID
   * @param {string} branch - 分支名
   * @param {string} commitSha - Git commit SHA
   * @param {object} options - 配置选项
   * @returns {Promise<object>} 汇总数据
   */
  async collectAll(buildId, branch, commitSha, options = {}) {
    const results = {};
    const startTime = Date.now();

    logger.info({ buildId, branch, commitSha }, 'Starting coverage collection');

    // 收集各服务覆盖率
    for (const service of this.services) {
      try {
        const coveragePath = path.join(
          process.cwd(),
          'backend/services',
          service,
          'coverage',
          'coverage-summary.json'
        );

        if (fs.existsSync(coveragePath)) {
          const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
          results[service] = this.parseCoverageData(data);
          logger.debug({ service, coverage: results[service].lines }, 'Coverage parsed');
        } else {
          results[service] = { 
            error: 'coverage_not_found',
            lines: 0, 
            statements: 0, 
            functions: 0, 
            branches: 0,
            filesCovered: 0 
          };
          logger.warn({ service, path: coveragePath }, 'Coverage file not found');
        }
      } catch (err) {
        results[service] = { error: 'parse_error', message: err.message };
        logger.error({ service, err }, 'Failed to parse coverage');
      }
    }

    // 收集 shared 模块覆盖率
    const sharedPath = path.join(
      process.cwd(),
      'backend/shared',
      'coverage',
      'coverage-summary.json'
    );
    
    if (fs.existsSync(sharedPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
        results['backend/shared'] = this.parseCoverageData(data);
      } catch (err) {
        results['backend/shared'] = { error: 'parse_error', message: err.message };
      }
    }

    // 计算总覆盖率
    const totalCoverage = this.calculateTotalCoverage(results);

    const duration = Date.now() - startTime;
    logger.info({ 
      buildId, 
      totalLines: totalCoverage.lines.toFixed(1),
      duration 
    }, 'Coverage collection completed');

    return {
      services: results,
      total: totalCoverage,
      buildId,
      branch,
      commitSha,
      timestamp: new Date().toISOString(),
      duration
    };
  }

  /**
   * 解析覆盖率数据
   * @param {object} data - Jest coverage-summary.json 数据
   * @returns {object} 解析后的覆盖率
   */
  parseCoverageData(data) {
    const total = data.total || {};

    return {
      lines: total.lines?.pct || 0,
      statements: total.statements?.pct || 0,
      functions: total.functions?.pct || 0,
      branches: total.branches?.pct || 0,
      filesCovered: Object.keys(data).filter(k => k !== 'total').length,
      totalLines: total.lines?.total || 0,
      coveredLines: total.lines?.covered || 0,
      totalBranches: total.branches?.total || 0,
      coveredBranches: total.branches?.covered || 0,
      totalFunctions: total.functions?.total || 0,
      coveredFunctions: total.functions?.covered || 0,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 计算总覆盖率
   * @param {object} results - 各服务覆盖率结果
   * @returns {object} 总覆盖率
   */
  calculateTotalCoverage(results) {
    const validServices = Object.entries(results)
      .filter(([, data]) => !data.error && data.totalLines > 0)
      .map(([name, data]) => ({ name, ...data }));

    if (validServices.length === 0) {
      return {
        lines: 0,
        statements: 0,
        functions: 0,
        branches: 0,
        servicesCovered: 0,
        totalServices: Object.keys(results).length
      };
    }

    // 加权平均（按代码行数）
    const totalLines = validServices.reduce((sum, s) => sum + s.totalLines, 0);
    const coveredLines = validServices.reduce((sum, s) => sum + s.coveredLines, 0);
    
    const totalFunctions = validServices.reduce((sum, s) => sum + s.totalFunctions, 0);
    const coveredFunctions = validServices.reduce((sum, s) => sum + s.coveredFunctions, 0);
    
    const totalBranches = validServices.reduce((sum, s) => sum + s.totalBranches, 0);
    const coveredBranches = validServices.reduce((sum, s) => sum + s.coveredBranches, 0);

    return {
      lines: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      statements: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      functions: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
      branches: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0,
      servicesCovered: validServices.length,
      totalServices: Object.keys(results).length,
      totalLines,
      coveredLines,
      totalFunctions,
      coveredFunctions,
      totalBranches,
      coveredBranches
    };
  }

  /**
   * 获取覆盖率历史趋势
   * @param {object} db - 数据库连接
   * @param {string|null} service - 服务名（可选）
   * @param {number} days - 查询天数
   * @returns {Promise<array>} 历史记录
   */
  async getHistory(db, service = null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    if (service) {
      const { rows } = await db.query(`
        SELECT 
          build_id, branch, 
          lines_pct, statements_pct, functions_pct, branches_pct,
          total_lines, covered_lines,
          created_at
        FROM test_coverage_records
        WHERE service_name = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT 100
      `, [service, since]);

      return rows.map(r => this.formatHistoryRow(r));
    }

    const { rows } = await db.query(`
      SELECT 
        build_id, branch, 
        avg_lines_pct, avg_statements_pct, avg_functions_pct, avg_branches_pct,
        services_covered, total_services,
        created_at
      FROM test_coverage_summary
      WHERE created_at >= $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [since]);

    return rows.map(r => ({
      buildId: r.build_id,
      branch: r.branch,
      lines: parseFloat(r.avg_lines_pct),
      statements: parseFloat(r.avg_statements_pct),
      functions: parseFloat(r.avg_functions_pct),
      branches: parseFloat(r.avg_branches_pct),
      servicesCovered: r.services_covered,
      totalServices: r.total_services,
      timestamp: r.created_at.toISOString()
    }));
  }

  /**
   * 格式化历史记录行
   */
  formatHistoryRow(row) {
    return {
      buildId: row.build_id,
      branch: row.branch,
      lines: parseFloat(row.lines_pct),
      statements: parseFloat(row.statements_pct),
      functions: parseFloat(row.functions_pct),
      branches: parseFloat(row.branches_pct),
      totalLines: row.total_lines,
      coveredLines: row.covered_lines,
      timestamp: row.created_at.toISOString()
    };
  }

  /**
   * 分析覆盖率缺口
   * @param {string} service - 服务名
   * @returns {object} 缺口分析结果
   */
  async analyzeGaps(service) {
    const coveragePath = path.join(
      process.cwd(),
      'backend/services',
      service,
      'coverage',
      'coverage-final.json'
    );

    if (!fs.existsSync(coveragePath)) {
      return { service, error: 'coverage_file_not_found' };
    }

    const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    const gaps = [];

    for (const [filePath, fileCoverage] of Object.entries(data)) {
      const uncoveredFunctions = [];
      const uncoveredBranches = [];

      // 分析未覆盖函数
      if (fileCoverage.f) {
        for (const [fnId, count] of Object.entries(fileCoverage.f)) {
          if (count === 0) {
            const fnMap = fileCoverage.fnMap?.[fnId];
            if (fnMap) {
              uncoveredFunctions.push({
                name: fnMap.name || `anonymous_${fnId}`,
                line: fnMap.loc?.start?.line || 0
              });
            }
          }
        }
      }

      // 分析未覆盖分支
      if (fileCoverage.b) {
        for (const [branchId, counts] of Object.entries(fileCoverage.b)) {
          const allZero = counts.every(c => c === 0);
          if (allZero) {
            const branchMap = fileCoverage.branchMap?.[branchId];
            if (branchMap) {
              uncoveredBranches.push({
                type: branchMap.type || 'unknown',
                line: branchMap.loc?.start?.line || 0
              });
            }
          }
        }
      }

      // 计算文件覆盖率严重度
      const severity = this.calculateGapSeverity(fileCoverage);

      if (uncoveredFunctions.length > 0 || uncoveredBranches.length > 0 || severity > 50) {
        gaps.push({
          file: filePath.replace(process.cwd() + '/', ''),
          uncoveredFunctions,
          uncoveredBranches,
          severity,
          totalLines: Object.keys(fileCoverage.l || {}).length,
          coveredLines: Object.values(fileCoverage.l || {}).filter(c => c > 0).length
        });
      }
    }

    // 按严重程度排序
    gaps.sort((a, b) => b.severity - a.severity);

    return {
      service,
      totalFiles: Object.keys(data).length,
      filesWithGaps: gaps.length,
      gaps: gaps.slice(0, 50), // 返回前 50 个最严重的缺口
      analyzedAt: new Date().toISOString()
    };
  }

  /**
   * 计算缺口严重程度
   * @param {object} fileCoverage - 文件覆盖率数据
   * @returns {number} 严重度分数 (0-100)
   */
  calculateGapSeverity(fileCoverage) {
    const lines = fileCoverage.l || {};
    const totalLines = Object.keys(lines).length;
    
    if (totalLines === 0) return 0;

    const coveredLines = Object.values(lines).filter(c => c > 0).length;
    const uncoveredRatio = 1 - (coveredLines / totalLines);

    // 未覆盖率越高，严重程度越高
    return Math.round(uncoveredRatio * 100);
  }

  /**
   * 生成覆盖率 Badge
   * @param {number} coverage - 覆盖率百分比
   * @returns {object} Badge 信息
   */
  generateBadge(coverage) {
    let color = 'red';
    let label = 'coverage';

    if (coverage >= 80) {
      color = 'brightgreen';
    } else if (coverage >= 60) {
      color = 'yellow';
    } else if (coverage >= 40) {
      color = 'orange';
    }

    return {
      schemaVersion: 1,
      label,
      message: `${coverage.toFixed(1)}%`,
      color,
      url: `https://img.shields.io/badge/${label}-${coverage.toFixed(1)}%25-${color}`
    };
  }
}

module.exports = TestCoverageCollector;
