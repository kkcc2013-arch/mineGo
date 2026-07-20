/**
 * 反作弊规则 A/B 测试分析器
 * 支持统计学显著性分析和智能推荐
 * REQ-00608
 */

'use strict';

const { logger } = require('../../shared/logging');

class ABTestAnalyzer {
  constructor(db) {
    this.db = db;
    this.minSampleSize = 1000; // 最小样本量
    this.significanceLevel = 0.05; // 显著性水平
  }

  /**
   * 创建 A/B 测试
   */
  async createABTest(ruleId, testId, variants) {
    // 验证变体配置
    const totalPercentage = variants.reduce((sum, v) => sum + (v.percentage || 0), 0);
    if (Math.abs(totalPercentage - 100) > 1) {
      throw new Error(`Variant percentages must sum to 100, got ${totalPercentage}`);
    }

    // 验证至少有 control 和 treatment
    const variantIds = variants.map(v => v.id);
    if (!variantIds.includes('control')) {
      throw new Error('Must include a "control" variant');
    }
    if (!variantIds.includes('treatment')) {
      throw new Error('Must include a "treatment" variant');
    }

    // 更新规则配置
    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        ab_test_enabled = TRUE,
        ab_test_variants = $1,
        updated_at = NOW()
      WHERE rule_id = $2
    `, [JSON.stringify(variants), ruleId]);

    logger.info('A/B test created', { ruleId, testId, variants: variants.map(v => v.id) });

    return {
      testId,
      ruleId,
      variants,
      status: 'running',
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 记录 A/B 测试结果
   */
  async recordTestResult(testId, ruleId, variantId, userId, result, score = null, details = {}) {
    await this.db.query(`
      INSERT INTO anti_cheat_ab_test_results (
        test_id, rule_id, variant_id, user_id, result, score, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [testId, ruleId, variantId, userId, result, score, JSON.stringify(details)]);
  }

  /**
   * 分析 A/B 测试结果
   */
  async analyzeTestResults(testId, ruleId) {
    const result = await this.db.query(`
      SELECT 
        variant_id,
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE result = 'matched') as matched_count,
        COUNT(*) FILTER (WHERE result = 'not_matched') as not_matched_count,
        COUNT(*) FILTER (WHERE result = 'error') as error_count,
        AVG(score) FILTER (WHERE result = 'matched') as avg_score,
        AVG(score) FILTER (WHERE result = 'not_matched') as avg_normal_score
      FROM anti_cheat_ab_test_results
      WHERE test_id = $1 AND rule_id = $2
      GROUP BY variant_id
    `, [testId, ruleId]);

    const stats = {};
    for (const row of result.rows) {
      const totalUsers = parseInt(row.total_users);
      const matchedCount = parseInt(row.matched_count);
      
      stats[row.variant_id] = {
        totalUsers,
        matchedCount,
        notMatchedCount: parseInt(row.not_matched_count),
        errorCount: parseInt(row.error_count),
        matchedRate: totalUsers > 0 ? matchedCount / totalUsers : 0,
        avgScore: parseFloat(row.avg_score) || 0,
        avgNormalScore: parseFloat(row.avg_normal_score) || 0
      };
    }

    // 检查样本量是否足够
    const totalSample = Object.values(stats).reduce((sum, s) => sum + s.totalUsers, 0);
    if (totalSample < this.minSampleSize) {
      return {
        testId,
        ruleId,
        stats,
        analysis: {
          significant: false,
          reason: `Insufficient sample size: ${totalSample} < ${this.minSampleSize}`,
          sampleSize: totalSample,
          minSampleSize: this.minSampleSize
        },
        recommendation: {
          action: 'continue_test',
          reason: 'Collect more data before making a decision'
        }
      };
    }

    // 计算显著性差异
    const analysis = this.calculateSignificance(stats);

    return {
      testId,
      ruleId,
      stats,
      analysis,
      recommendation: this.generateRecommendation(stats, analysis)
    };
  }

  /**
   * 计算统计学显著性
   */
  calculateSignificance(stats) {
    if (!stats.control || !stats.treatment) {
      return { 
        significant: false, 
        reason: 'Missing control or treatment group' 
      };
    }

    const control = stats.control;
    const treatment = stats.treatment;

    // 使用 Z-test 检测比例差异（双样本）
    const controlRate = control.matchedRate;
    const treatmentRate = treatment.matchedRate;
    const controlN = control.totalUsers;
    const treatmentN = treatment.totalUsers;

    // 合并比例
    const pooledRate = (control.matchedCount + treatment.matchedCount) / 
                       (controlN + treatmentN);
    
    // 标准误差
    const se = Math.sqrt(
      pooledRate * (1 - pooledRate) * (1/controlN + 1/treatmentN)
    );
    
    // Z 分数
    const zScore = se > 0 ? (treatmentRate - controlRate) / se : 0;
    
    // 双尾 p 值
    const pValue = 2 * this.normalCDF(-Math.abs(zScore));

    // 置信区间（95%）
    const marginOfError = 1.96 * Math.sqrt(
      controlRate * (1 - controlRate) / controlN +
      treatmentRate * (1 - treatmentRate) / treatmentN
    );
    
    const confidenceInterval = {
      lower: (treatmentRate - controlRate) - marginOfError,
      upper: (treatmentRate - controlRate) + marginOfError
    };

    // 效应量（Cohen's h）
    const effectSize = this.calculateEffectSize(controlRate, treatmentRate);

    // 改进百分比
    const improvement = controlRate > 0 
      ? ((treatmentRate - controlRate) / controlRate * 100).toFixed(2)
      : 0;

    return {
      significant: pValue < this.significanceLevel,
      pValue: parseFloat(pValue.toFixed(4)),
      zScore: parseFloat(zScore.toFixed(4)),
      improvement: parseFloat(improvement),
      confidenceInterval: {
        lower: parseFloat(confidenceInterval.lower.toFixed(4)),
        upper: parseFloat(confidenceInterval.upper.toFixed(4))
      },
      effectSize: parseFloat(effectSize.toFixed(4)),
      effectSizeInterpretation: this.interpretEffectSize(effectSize)
    };
  }

  /**
   * 正态分布累积分布函数（CDF）
   */
  normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * 计算效应量（Cohen's h）
   */
  calculateEffectSize(p1, p2) {
    const phi1 = 2 * Math.asin(Math.sqrt(p1));
    const phi2 = 2 * Math.asin(Math.sqrt(p2));
    return phi2 - phi1;
  }

  /**
   * 解释效应量
   */
  interpretEffectSize(h) {
    const absH = Math.abs(h);
    if (absH < 0.2) return 'negligible';
    if (absH < 0.5) return 'small';
    if (absH < 0.8) return 'medium';
    return 'large';
  }

  /**
   * 生成推荐
   */
  generateRecommendation(stats, analysis) {
    if (!analysis.significant) {
      return {
        action: 'continue_test',
        confidence: 'low',
        reason: 'No significant difference detected yet. Continue collecting data.',
        suggestedDuration: '7-14 more days'
      };
    }

    const improvement = parseFloat(analysis.improvement);
    
    if (improvement > 10) {
      return {
        action: 'adopt_treatment',
        confidence: 'high',
        reason: `Treatment shows ${improvement}% improvement with statistical significance. Recommend full rollout.`,
        expectedImpact: {
          additionalDetections: Math.round(stats.control.matchedCount * improvement / 100),
          falsePositiveRisk: 'low'
        }
      };
    } else if (improvement > 5) {
      return {
        action: 'adopt_treatment',
        confidence: 'medium',
        reason: `Treatment shows moderate improvement (${improvement}%). Consider gradual rollout.`,
        expectedImpact: {
          additionalDetections: Math.round(stats.control.matchedCount * improvement / 100),
          falsePositiveRisk: 'low'
        }
      };
    } else if (improvement > 0) {
      return {
        action: 'adopt_treatment',
        confidence: 'low',
        reason: `Treatment shows small improvement (${improvement}%). Consider cost-benefit analysis.`,
        expectedImpact: {
          additionalDetections: Math.round(stats.control.matchedCount * improvement / 100),
          falsePositiveRisk: 'medium'
        }
      };
    } else {
      return {
        action: 'keep_control',
        confidence: 'high',
        reason: 'Treatment performs worse than control. Keep current configuration.',
        expectedImpact: {
          additionalDetections: 0,
          falsePositiveRisk: 'high if adopted'
        }
      };
    }
  }

  /**
   * 结束 A/B 测试
   */
  async endABTest(ruleId, keepWinner = 'control') {
    // 获取最终分析结果
    const result = await this.db.query(`
      SELECT ab_test_variants 
      FROM anti_cheat_rules 
      WHERE rule_id = $1
    `, [ruleId]);

    const variants = typeof result.rows[0].ab_test_variants === 'string'
      ? JSON.parse(result.rows[0].ab_test_variants)
      : result.rows[0].ab_test_variants;

    // 找到获胜变体
    const winner = variants.find(v => v.id === keepWinner);
    if (!winner) {
      throw new Error(`Winner variant not found: ${keepWinner}`);
    }

    // 更新规则配置
    await this.db.query(`
      UPDATE anti_cheat_rules 
      SET 
        ab_test_enabled = FALSE,
        config = $1,
        updated_at = NOW()
      WHERE rule_id = $2
    `, [JSON.stringify(winner.config), ruleId]);

    logger.info('A/B test ended', { ruleId, winner: keepWinner });

    return {
      success: true,
      winner: keepWinner,
      appliedConfig: winner.config
    };
  }

  /**
   * 获取测试进度
   */
  async getTestProgress(testId, ruleId) {
    const result = await this.db.query(`
      SELECT 
        variant_id,
        COUNT(*) as count
      FROM anti_cheat_ab_test_results
      WHERE test_id = $1 AND rule_id = $2
      GROUP BY variant_id
    `, [testId, ruleId]);

    const progress = {};
    let total = 0;
    
    for (const row of result.rows) {
      progress[row.variant_id] = parseInt(row.count);
      total += parseInt(row.count);
    }

    return {
      testId,
      ruleId,
      totalSamples: total,
      progressByVariant: progress,
      minSampleSize: this.minSampleSize,
      completionRate: (total / (this.minSampleSize * 2) * 100).toFixed(1) + '%'
    };
  }
}

module.exports = { ABTestAnalyzer };
