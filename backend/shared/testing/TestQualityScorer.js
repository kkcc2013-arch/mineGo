// backend/shared/testing/TestQualityScorer.js
// 测试质量评分引擎

'use strict';

const { createLogger } = require('../logger');
const logger = createLogger('test-quality-scorer');

/**
 * 测试质量评分器
 * 基于变异测试覆盖率、传统覆盖率、断言密度等指标计算测试质量分数
 */
class TestQualityScorer {
  constructor() {
    // 权重配置
    this.weights = {
      mutation: 0.35,    // 变异测试权重最高
      coverage: 0.25,    // 传统覆盖率
      assertion: 0.20,   // 断言质量
      boundary: 0.15,    // 边界覆盖
      performance: 0.05  // 性能
    };
  }

  /**
   * 计算测试质量分数（0-100）
   * @param {Object} metrics - 测试指标
   * @param {number} metrics.mutationScore - 变异测试覆盖率
   * @param {number} metrics.lineCoverage - 行覆盖率
   * @param {number} metrics.branchCoverage - 分支覆盖率
   * @param {number} metrics.assertionDensity - 断言密度
   * @param {number} metrics.boundaryCoverage - 边界覆盖率
   * @param {number} metrics.avgTestDuration - 平均测试时长（毫秒）
   * @returns {Object} - 质量分数和详情
   */
  calculateScore(metrics) {
    const {
      mutationScore = 0,
      lineCoverage = 0,
      branchCoverage = 0,
      assertionDensity = 0,
      boundaryCoverage = 0,
      avgTestDuration = 5000
    } = metrics;

    // 1. 变异测试得分（0-100）
    const mutationScoreNormal = Math.min(100, Math.max(0, mutationScore)) / 100;

    // 2. 覆盖率得分（行覆盖率和分支覆盖率加权平均）
    const coverageScore = (lineCoverage * 0.5 + branchCoverage * 0.5) / 100;

    // 3. 断言密度得分（每 10 行代码至少 1 个断言为满分）
    const assertionScore = Math.min(1, assertionDensity / 0.1);

    // 4. 边界覆盖得分
    const boundaryScore = Math.min(1, boundaryCoverage / 100);

    // 5. 性能得分（测试时长 < 5s 得满分）
    let performanceScore = 1;
    if (avgTestDuration > 5000) {
      performanceScore = Math.max(0.3, 1 - (avgTestDuration - 5000) / 20000);
    }

    // 总分计算
    const totalScore = 
      mutationScoreNormal * this.weights.mutation +
      coverageScore * this.weights.coverage +
      assertionScore * this.weights.assertion +
      boundaryScore * this.weights.boundary +
      performanceScore * this.weights.performance;

    const score = Math.round(totalScore * 100);

    const result = {
      score,
      grade: this.getGrade(score),
      breakdown: {
        mutation: {
          value: mutationScore,
          weight: this.weights.mutation,
          score: Math.round(mutationScoreNormal * 100),
          status: this.getStatus(mutationScore, 80, 60)
        },
        coverage: {
          value: { line: lineCoverage, branch: branchCoverage },
          weight: this.weights.coverage,
          score: Math.round(coverageScore * 100),
          status: this.getStatus((lineCoverage + branchCoverage) / 2, 80, 60)
        },
        assertion: {
          value: assertionDensity,
          weight: this.weights.assertion,
          score: Math.round(assertionScore * 100),
          status: assertionDensity >= 0.1 ? 'good' : assertionDensity >= 0.05 ? 'warning' : 'bad'
        },
        boundary: {
          value: boundaryCoverage,
          weight: this.weights.boundary,
          score: Math.round(boundaryScore * 100),
          status: this.getStatus(boundaryCoverage, 80, 60)
        },
        performance: {
          value: avgTestDuration,
          weight: this.weights.performance,
          score: Math.round(performanceScore * 100),
          status: avgTestDuration < 5000 ? 'good' : avgTestDuration < 10000 ? 'warning' : 'bad'
        }
      },
      recommendations: this.generateRecommendations(metrics, score)
    };

    logger.info('Test quality score calculated', {
      score,
      grade: result.grade,
      mutationScore
    });

    return result;
  }

  /**
   * 获取等级（A-F）
   */
  getGrade(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    if (score >= 50) return 'E';
    return 'F';
  }

  /**
   * 获取状态
   */
  getStatus(value, goodThreshold, warningThreshold) {
    if (value >= goodThreshold) return 'good';
    if (value >= warningThreshold) return 'warning';
    return 'bad';
  }

  /**
   * 生成改进建议
   */
  generateRecommendations(metrics, score) {
    const recommendations = [];

    // 变异测试建议
    if (metrics.mutationScore < 80) {
      recommendations.push({
        type: 'mutation',
        priority: 'high',
        message: `变异测试覆盖率 (${metrics.mutationScore.toFixed(1)}%) 低于目标 (80%)`,
        details: '增强测试断言，添加更多边界值和异常场景测试',
        effort: this.estimateEffort(80 - metrics.mutationScore)
      });
    }

    // 覆盖率建议
    const avgCoverage = (metrics.lineCoverage + metrics.branchCoverage) / 2;
    if (avgCoverage < 80) {
      recommendations.push({
        type: 'coverage',
        priority: 'high',
        message: `代码覆盖率 (${avgCoverage.toFixed(1)}%) 低于目标 (80%)`,
        details: `行覆盖率: ${metrics.lineCoverage.toFixed(1)}%, 分支覆盖率: ${metrics.branchCoverage.toFixed(1)}%`,
        effort: this.estimateEffort(80 - avgCoverage)
      });
    }

    // 断言密度建议
    if (metrics.assertionDensity < 0.1) {
      recommendations.push({
        type: 'assertion',
        priority: metrics.assertionDensity < 0.05 ? 'high' : 'medium',
        message: `断言密度 (${metrics.assertionDensity.toFixed(3)}) 低于推荐值 (0.1)`,
        details: '平均每 10 行代码应至少有 1 个断言，检查是否存在无效测试',
        effort: this.estimateEffort((0.1 - metrics.assertionDensity) * 1000)
      });
    }

    // 边界覆盖建议
    if (metrics.boundaryCoverage < 80) {
      recommendations.push({
        type: 'boundary',
        priority: 'medium',
        message: `边界值覆盖率 (${metrics.boundaryCoverage.toFixed(1)}%) 低于目标 (80%)`,
        details: '添加 MIN、MAX、零值、空值、null/undefined 等边界测试',
        effort: this.estimateEffort(80 - metrics.boundaryCoverage)
      });
    }

    // 性能建议
    if (metrics.avgTestDuration > 10000) {
      recommendations.push({
        type: 'performance',
        priority: 'low',
        message: `测试执行时间 (${(metrics.avgTestDuration / 1000).toFixed(1)}s) 较长`,
        details: '考虑优化测试用例、使用 mock、增加并行度',
        effort: 2
      });
    }

    // 总体评估
    if (score < 60) {
      recommendations.push({
        type: 'overall',
        priority: 'critical',
        message: `测试质量评分 (${score}) 不合格，需要紧急改进`,
        details: '建议优先处理高优先级问题，建立测试质量改进计划',
        effort: 20
      });
    } else if (score < 80) {
      recommendations.push({
        type: 'overall',
        priority: 'medium',
        message: `测试质量评分 (${score}) 有提升空间`,
        details: '建议按优先级逐步改进测试质量',
        effort: 10
      });
    }

    return recommendations;
  }

  /**
   * 估算改进工作量（小时）
   */
  estimateEffort(gap) {
    if (gap <= 5) return 1;
    if (gap <= 10) return 2;
    if (gap <= 20) return 4;
    if (gap <= 40) return 8;
    return 16;
  }

  /**
   * 批量计算多个模块的测试质量
   * @param {Object} modulesMetrics - 各模块指标
   * @returns {Object} - 聚合结果
   */
  calculateBatchScore(modulesMetrics) {
    const results = {};
    let totalScore = 0;
    let count = 0;

    for (const [module, metrics] of Object.entries(modulesMetrics)) {
      results[module] = this.calculateScore(metrics);
      totalScore += results[module].score;
      count++;
    }

    return {
      modules: results,
      average: Math.round(totalScore / count),
      summary: this.generateSummary(results)
    };
  }

  /**
   * 生成摘要
   */
  generateSummary(results) {
    const grades = {};
    const critical = [];

    for (const [module, result] of Object.entries(results)) {
      grades[result.grade] = (grades[result.grade] || 0) + 1;
      
      if (result.score < 60) {
        critical.push(module);
      }
    }

    return {
      gradeDistribution: grades,
      criticalModules: critical,
      totalModules: Object.keys(results).length
    };
  }

  /**
   * 计算趋势
   * @param {Object[]} history - 历史数据
   * @returns {Object} - 趋势分析
   */
  calculateTrend(history) {
    if (history.length < 2) {
      return { direction: 'stable', change: 0 };
    }

    const recent = history.slice(-10);
    const older = history.slice(-20, -10);

    const recentAvg = recent.reduce((sum, h) => sum + h.score, 0) / recent.length;
    const olderAvg = older.length > 0 
      ? older.reduce((sum, h) => sum + h.score, 0) / older.length 
      : recentAvg;

    const change = recentAvg - olderAvg;
    const direction = change > 2 ? 'improving' : change < -2 ? 'declining' : 'stable';

    return {
      direction,
      change: Math.round(change * 10) / 10,
      recentAvg: Math.round(recentAvg),
      olderAvg: Math.round(olderAvg)
    };
  }
}

module.exports = TestQualityScorer;
