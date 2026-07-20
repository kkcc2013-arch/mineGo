/**
 * Schema Risk Assessor - 数据库 Schema 变更风险评估引擎
 * REQ-00601: 数据库 Schema 变更智能影响分析与风险评估系统
 * 
 * 功能：
 * - 评估 schema 变更的风险等级
 * - 基于规则的智能风险判断
 * - 生成风险报告和预警
 * 
 * @module backend/shared/schemaRiskAssessor
 * @version 1.0.0
 */

'use strict';

const logger = require('./logger');

/**
 * 风险等级
 */
const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * 风险因素枚举
 */
const RiskFactor = {
  DATA_LOSS: 'data_loss',
  TYPE_CHANGE: 'type_change',
  CONSTRAINT_VIOLATION: 'constraint_violation',
  PERFORMANCE_IMPACT: 'performance_impact',
  LOCK_DURATION: 'lock_duration',
  DEPENDENT_OBJECTS: 'dependent_objects',
  IRREVERSIBLE: 'irreversible',
  LARGE_TABLE: 'large_table'
};

/**
 * 风险评估引擎
 */
class SchemaRiskAssessor {
  constructor(options = {}) {
    this.options = {
      largeTableThreshold: options.largeTableThreshold || 1000000, // 100万行
      criticalLockDuration: options.criticalLockDuration || 30000, // 30秒
      ...options
    };

    // 风险规则配置
    this.riskRules = {
      // DDL 操作风险规则
      'DROP_TABLE': { level: RiskLevel.CRITICAL, factors: [RiskFactor.DATA_LOSS, RiskFactor.IRREVERSIBLE] },
      'DROP_COLUMN': { level: RiskLevel.CRITICAL, factors: [RiskFactor.DATA_LOSS, RiskFactor.IRREVERSIBLE] },
      'DROP_INDEX': { level: RiskLevel.MEDIUM, factors: [RiskFactor.PERFORMANCE_IMPACT] },
      
      'ALTER_COLUMN_TYPE': { level: RiskLevel.HIGH, factors: [RiskFactor.TYPE_CHANGE, RiskFactor.DATA_LOSS] },
      'ADD_NOT_NULL_CONSTRAINT': { level: RiskLevel.HIGH, factors: [RiskFactor.CONSTRAINT_VIOLATION] },
      'SET_NOT_NULL': { level: RiskLevel.HIGH, factors: [RiskFactor.CONSTRAINT_VIOLATION] },
      
      'ADD_FOREIGN_KEY': { level: RiskLevel.MEDIUM, factors: [RiskFactor.CONSTRAINT_VIOLATION] },
      'ADD_CHECK_CONSTRAINT': { level: RiskLevel.MEDIUM, factors: [RiskFactor.CONSTRAINT_VIOLATION] },
      'ADD_UNIQUE_CONSTRAINT': { level: RiskLevel.MEDIUM, factors: [RiskFactor.CONSTRAINT_VIOLATION] },
      
      'ADD_COLUMN': { level: RiskLevel.LOW, factors: [] },
      'DROP_CONSTRAINT': { level: RiskLevel.LOW, factors: [] },
      'ADD_INDEX': { level: RiskLevel.LOW, factors: [RiskFactor.LOCK_DURATION] },
      
      'CREATE_TABLE': { level: RiskLevel.LOW, factors: [] },
      'CREATE_VIEW': { level: RiskLevel.LOW, factors: [] },
      'CREATE_INDEX': { level: RiskLevel.LOW, factors: [RiskFactor.LOCK_DURATION] },
      'CREATE_UNIQUE_INDEX': { level: RiskLevel.MEDIUM, factors: [RiskFactor.CONSTRAINT_VIOLATION] }
    };

    // 风险因素权重
    this.factorWeights = {
      [RiskFactor.DATA_LOSS]: 10,
      [RiskFactor.IRREVERSIBLE]: 8,
      [RiskFactor.TYPE_CHANGE]: 6,
      [RiskFactor.CONSTRAINT_VIOLATION]: 5,
      [RiskFactor.PERFORMANCE_IMPACT]: 4,
      [RiskFactor.LOCK_DURATION]: 3,
      [RiskFactor.DEPENDENT_OBJECTS]: 3,
      [RiskFactor.LARGE_TABLE]: 2
    };

    this.stats = {
      totalAssessments: 0,
      riskDistribution: {
        [RiskLevel.LOW]: 0,
        [RiskLevel.MEDIUM]: 0,
        [RiskLevel.HIGH]: 0,
        [RiskLevel.CRITICAL]: 0
      }
    };
  }

  /**
   * 评估 schema 变更的风险等级
   * @param {SchemaChange[]} changes - 变更列表
   * @param {ImpactAnalysis} impactAnalysis - 影响分析结果
   * @returns {RiskAssessment}
   */
  assessRisk(changes, impactAnalysis) {
    this.stats.totalAssessments++;

    const assessment = {
      timestamp: new Date().toISOString(),
      overallRisk: RiskLevel.LOW,
      riskScore: 0,
      changeRisks: [],
      riskFactors: [],
      warnings: [],
      blockers: [],
      requiresApproval: false,
      canProceed: true,
      summary: ''
    };

    // 评估每个变更
    for (const change of changes) {
      const changeRisk = this.assessChange(change, impactAnalysis);
      assessment.changeRisks.push(changeRisk);
    }

    // 计算综合风险分数
    assessment.riskScore = this.calculateRiskScore(assessment.changeRisks);

    // 确定综合风险等级
    assessment.overallRisk = this.determineRiskLevel(assessment.riskScore);

    // 收集风险因素
    assessment.riskFactors = this.collectRiskFactors(assessment.changeRisks);

    // 生成警告和阻断项
    assessment.warnings = this.generateWarnings(assessment);
    assessment.blockers = this.generateBlockers(assessment);

    // 确定是否需要审批
    assessment.requiresApproval = this.requiresApproval(assessment);

    // 确定是否可以执行
    assessment.canProceed = assessment.blockers.length === 0;

    // 生成摘要
    assessment.summary = this.generateSummary(assessment);

    // 更新统计
    this.stats.riskDistribution[assessment.overallRisk]++;

    return assessment;
  }

  /**
   * 评估单个变更的风险
   */
  assessChange(change, impactAnalysis) {
    const changeType = change.type;
    const rule = this.riskRules[changeType] || { level: RiskLevel.LOW, factors: [] };
    
    const risk = {
      changeType,
      objectName: change.objectName,
      objectType: change.objectType,
      baseRiskLevel: rule.level,
      adjustedRiskLevel: rule.level,
      factors: [...rule.factors],
      factorDetails: {},
      score: 0,
      warnings: [],
      blockers: []
    };

    // 根据调整因素调整风险等级
    this.applyRiskAdjustments(risk, change, impactAnalysis);

    // 计算风险分数
    risk.score = this.calculateChangeRiskScore(risk);

    return risk;
  }

  /**
   * 应用风险调整因素
   */
  applyRiskAdjustments(risk, change, impactAnalysis) {
    // 不可逆变更
    if (!change.isReversible) {
      risk.factors.push(RiskFactor.IRREVERSIBLE);
      risk.warnings.push(`Change is irreversible: ${change.type}`);
    }

    // 依赖对象影响
    const dependentCount = impactAnalysis.indirectImpact.filter(
      i => i.object === change.objectName
    ).length;
    
    if (dependentCount > 5) {
      risk.factors.push(RiskFactor.DEPENDENT_OBJECTS);
      risk.adjustedRiskLevel = this.upgradeRiskLevel(risk.adjustedRiskLevel);
      risk.factorDetails.dependentObjects = dependentCount;
      risk.warnings.push(`Affects ${dependentCount} dependent objects`);
    }

    // 大表操作
    if (change.details?.tableSize > this.options.largeTableThreshold) {
      risk.factors.push(RiskFactor.LARGE_TABLE);
      risk.factorDetails.tableSize = change.details.tableSize;
      risk.warnings.push(`Large table operation: ${change.details.tableSize} rows`);
    }

    // 特定变更类型的风险调整
    switch (change.type) {
      case 'ALTER_TABLE_ADD_COLUMN':
        if (change.details?.isNotNull && !change.details?.hasDefault) {
          risk.adjustedRiskLevel = RiskLevel.HIGH;
          risk.blockers.push('Adding NOT NULL column without DEFAULT may fail for existing data');
        }
        break;

      case 'ALTER_TABLE_MODIFY_COLUMN':
        risk.adjustedRiskLevel = RiskLevel.HIGH;
        if (change.details?.newType && change.details?.oldType) {
          risk.factorDetails.typeChange = {
            from: change.details.oldType,
            to: change.details.newType
          };
        }
        break;

      case 'ADD_UNIQUE_INDEX':
        risk.adjustedRiskLevel = RiskLevel.MEDIUM;
        risk.warnings.push('Creating unique index may fail if duplicates exist');
        break;

      case 'ALTER_TABLE_ADD_CONSTRAINT':
        if (change.details?.constraintType === 'FOREIGN KEY') {
          risk.adjustedRiskLevel = RiskLevel.MEDIUM;
          risk.warnings.push('Adding foreign key may fail if referential integrity is violated');
        }
        break;
    }
  }

  /**
   * 计算变更风险分数
   */
  calculateChangeRiskScore(risk) {
    let score = 0;

    // 基础风险分数
    const baseScores = {
      [RiskLevel.LOW]: 10,
      [RiskLevel.MEDIUM]: 30,
      [RiskLevel.HIGH]: 60,
      [RiskLevel.CRITICAL]: 100
    };

    score += baseScores[risk.adjustedRiskLevel] || 10;

    // 风险因素加权
    for (const factor of risk.factors) {
      score += this.factorWeights[factor] || 0;
    }

    // 警告惩罚
    score += risk.warnings.length * 2;

    // 阻断项惩罚
    score += risk.blockers.length * 10;

    return Math.min(score, 100);
  }

  /**
   * 计算综合风险分数
   */
  calculateRiskScore(changeRisks) {
    if (changeRisks.length === 0) return 0;

    // 取最高分 + 平均分的加权和
    const maxScore = Math.max(...changeRisks.map(r => r.score));
    const avgScore = changeRisks.reduce((sum, r) => sum + r.score, 0) / changeRisks.length;

    return Math.round(maxScore * 0.7 + avgScore * 0.3);
  }

  /**
   * 根据分数确定风险等级
   */
  determineRiskLevel(score) {
    if (score >= 80) return RiskLevel.CRITICAL;
    if (score >= 60) return RiskLevel.HIGH;
    if (score >= 30) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /**
   * 升级风险等级
   */
  upgradeRiskLevel(currentLevel) {
    const levels = [RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL];
    const currentIndex = levels.indexOf(currentLevel);
    return currentIndex < levels.length - 1 ? levels[currentIndex + 1] : currentLevel;
  }

  /**
   * 收集所有风险因素
   */
  collectRiskFactors(changeRisks) {
    const factorMap = new Map();

    for (const risk of changeRisks) {
      for (const factor of risk.factors) {
        if (!factorMap.has(factor)) {
          factorMap.set(factor, { factor, count: 0 });
        }
        factorMap.get(factor).count++;
      }
    }

    return Array.from(factorMap.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * 生成警告
   */
  generateWarnings(assessment) {
    const warnings = [];

    // 从变更风险中收集警告
    for (const risk of assessment.changeRisks) {
      warnings.push(...risk.warnings.map(w => ({
        source: `${risk.objectType}:${risk.objectName}`,
        message: w,
        level: 'warning'
      })));
    }

    // 根据风险等级添加警告
    if (assessment.overallRisk === RiskLevel.HIGH) {
      warnings.push({
        source: 'system',
        message: 'High risk operation requires manual review',
        level: 'warning'
      });
    }

    if (assessment.riskScore > 50) {
      warnings.push({
        source: 'system',
        message: 'Consider scheduling this change during low-traffic period',
        level: 'info'
      });
    }

    return warnings;
  }

  /**
   * 生成阻断项
   */
  generateBlockers(assessment) {
    const blockers = [];

    // 从变更风险中收集阻断项
    for (const risk of assessment.changeRisks) {
      blockers.push(...risk.blockers.map(b => ({
        source: `${risk.objectType}:${risk.objectName}`,
        message: b,
        severity: 'error'
      })));
    }

    // 风险等级过高
    if (assessment.overallRisk === RiskLevel.CRITICAL) {
      blockers.push({
        source: 'system',
        message: 'Critical risk changes must be manually approved',
        severity: 'error'
      });
    }

    return blockers;
  }

  /**
   * 判断是否需要审批
   */
  requiresApproval(assessment) {
    return assessment.overallRisk === RiskLevel.HIGH || 
           assessment.overallRisk === RiskLevel.CRITICAL ||
           assessment.changeRisks.some(r => !r.isReversible);
  }

  /**
   * 生成摘要
   */
  generateSummary(assessment) {
    const parts = [];

    parts.push(`Risk Assessment Summary:`);
    parts.push(`- Overall Risk: ${assessment.overallRisk.toUpperCase()}`);
    parts.push(`- Risk Score: ${assessment.riskScore}/100`);
    parts.push(`- Changes Analyzed: ${assessment.changeRisks.length}`);
    parts.push(`- Warnings: ${assessment.warnings.length}`);
    
    if (assessment.blockers.length > 0) {
      parts.push(`- Blockers: ${assessment.blockers.length}`);
      parts.push(`- Can Proceed: NO`);
    } else {
      parts.push(`- Can Proceed: YES`);
    }

    if (assessment.requiresApproval) {
      parts.push(`- Requires Approval: YES`);
    }

    return parts.join('\n');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      totalAssessments: 0,
      riskDistribution: {
        [RiskLevel.LOW]: 0,
        [RiskLevel.MEDIUM]: 0,
        [RiskLevel.HIGH]: 0,
        [RiskLevel.CRITICAL]: 0
      }
    };
  }
}

module.exports = {
  SchemaRiskAssessor,
  RiskLevel,
  RiskFactor
};