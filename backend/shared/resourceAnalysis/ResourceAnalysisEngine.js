/**
 * REQ-00506: 容器资源智能利用率分析系统
 * 资源分析引擎
 * 
 * 功能：
 * - 分析资源利用率数据
 * - 识别资源浪费和潜在瓶颈
 * - 生成优化建议
 * - 标记风险级别
 * 
 * @module backend/shared/resourceAnalysis/ResourceAnalysisEngine
 */

'use strict';

const { createLogger } = require('../logger');
const { executeQuery } = require('../db');

const logger = createLogger('resource-analysis-engine');

/**
 * 利用率阈值配置
 */
const THRESHOLDS = {
  cpu: {
    underUtilized: 0.3,      // 利用率 < 30% 视为浪费
    optimalMin: 0.3,          // 最优范围下限
    optimalMax: 0.7,          // 最优范围上限
    overUtilized: 0.8,        // 利用率 > 80% 视为高负载
    riskyUtilization: 0.9    // 利用率 > 90% 视为风险
  },
  memory: {
    underUtilized: 0.4,       // 利用率 < 40% 视为浪费
    optimalMin: 0.4,
    optimalMax: 0.8,
    overUtilized: 0.85,
    riskyUtilization: 0.95
  }
};

/**
 * 风险级别
 */
const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * 优化建议类型
 */
const RECOMMENDATION_TYPES = {
  REDUCE_REQUEST: 'reduce_request',
  INCREASE_LIMIT: 'increase_limit',
  ADJUST_BOTH: 'adjust_both',
  OPTIMAL: 'optimal',
  INVESTIGATE: 'investigate'
};

/**
 * 资源分析引擎类
 */
class ResourceAnalysisEngine {
  constructor(config = {}) {
    this.thresholds = config.thresholds || THRESHOLDS;
  }

  /**
   * 分析单个容器的资源使用情况
   * @param {Object} containerStats - 容器统计信息
   * @returns {Object} 分析结果
   */
  analyzeContainer(containerStats) {
    const { podName, containerName, cpu, memory } = containerStats;

    const cpuAnalysis = this.analyzeResource(cpu, 'cpu');
    const memoryAnalysis = this.analyzeResource(memory, 'memory');

    // 综合评分
    const score = this.calculateOverallScore(cpuAnalysis, memoryAnalysis);

    // 生成建议
    const recommendation = this.generateRecommendation(
      cpuAnalysis,
      memoryAnalysis
    );

    return {
      podName,
      containerName,
      cpu: cpuAnalysis,
      memory: memoryAnalysis,
      score,
      recommendation,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 分析单个资源类型（CPU 或 Memory）
   * @param {Object} stats - 资源统计信息
   * @param {string} resourceType - 资源类型（cpu/memory）
   * @returns {Object} 分析结果
   */
  analyzeResource(stats, resourceType) {
    const thresholds = this.thresholds[resourceType];
    const analysis = {
      resourceType,
      avgUsage: stats.avg || 0,
      maxUsage: stats.max || 0,
      minUsage: stats.min || 0,
      request: stats.request || 0,
      limit: stats.limit || 0,
      avgUtilization: stats.avgUtilization || 0,
      maxUtilization: stats.maxUtilization || 0
    };

    // 判断利用率状态
    if (analysis.avgUtilization < thresholds.underUtilized) {
      analysis.status = 'under-utilized';
      analysis.riskLevel = RISK_LEVELS.LOW;
      analysis.wastePercentage = (1 - analysis.avgUtilization) * 100;
    } else if (analysis.avgUtilization > thresholds.riskyUtilization) {
      analysis.status = 'risky';
      analysis.riskLevel = RISK_LEVELS.CRITICAL;
      analysis.overloadRisk = ((analysis.avgUtilization - thresholds.optimalMax) / thresholds.optimalMax) * 100;
    } else if (analysis.avgUtilization > thresholds.overUtilized) {
      analysis.status = 'over-utilized';
      analysis.riskLevel = RISK_LEVELS.HIGH;
      analysis.overloadRisk = ((analysis.avgUtilization - thresholds.optimalMax) / thresholds.optimalMax) * 100;
    } else if (analysis.avgUtilization >= thresholds.optimalMin && 
               analysis.avgUtilization <= thresholds.optimalMax) {
      analysis.status = 'optimal';
      analysis.riskLevel = RISK_LEVELS.LOW;
    } else {
      analysis.status = 'acceptable';
      analysis.riskLevel = RISK_LEVELS.MEDIUM;
    }

    // 检查 limit 是否接近或超过
    if (analysis.limit > 0 && analysis.maxUsage > 0) {
      const limitUtilization = analysis.maxUsage / analysis.limit;
      if (limitUtilization > 0.9) {
        analysis.limitRisk = 'high';
        analysis.limitUtilization = limitUtilization;
      }
    }

    return analysis;
  }

  /**
   * 计算综合评分
   * @param {Object} cpuAnalysis - CPU 分析结果
   * @param {Object} memoryAnalysis - Memory 分析结果
   * @returns {number} 综合评分（0-100）
   */
  calculateOverallScore(cpuAnalysis, memoryAnalysis) {
    let score = 100;

    // CPU 评分
    const cpuScore = this.calculateResourceScore(cpuAnalysis, 'cpu');
    
    // Memory 评分
    const memoryScore = this.calculateResourceScore(memoryAnalysis, 'memory');

    // 综合评分（CPU 权重 40%，Memory 权重 60%）
    score = cpuScore * 0.4 + memoryScore * 0.6;

    return Math.round(score);
  }

  /**
   * 计算单个资源评分
   * @param {Object} analysis - 资源分析结果
   * @param {string} resourceType - 资源类型
   * @returns {number} 评分（0-100）
   */
  calculateResourceScore(analysis, resourceType) {
    const thresholds = this.thresholds[resourceType];
    let score = 100;

    // 根据状态扣分
    switch (analysis.status) {
      case 'optimal':
        score = 100;
        break;
      case 'acceptable':
        score = 80;
        break;
      case 'under-utilized':
        // 浪费越严重，分数越低
        score = Math.max(30, 80 - analysis.wastePercentage * 0.5);
        break;
      case 'over-utilized':
        score = Math.max(20, 60 - analysis.overloadRisk * 0.5);
        break;
      case 'risky':
        score = Math.max(0, 40 - analysis.overloadRisk);
        break;
    }

    // limit 风险额外扣分
    if (analysis.limitRisk === 'high') {
      score -= 20;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 生成优化建议
   * @param {Object} cpuAnalysis - CPU 分析结果
   * @param {Object} memoryAnalysis - Memory 分析结果
   * @returns {Object} 优化建议
   */
  generateRecommendation(cpuAnalysis, memoryAnalysis) {
    const recommendations = [];

    // CPU 建议
    if (cpuAnalysis.status === 'under-utilized' && cpuAnalysis.request > 0) {
      const suggestedRequest = cpuAnalysis.avgUsage * 1.5; // 留 50% 缓冲
      const reduction = ((cpuAnalysis.request - suggestedRequest) / cpuAnalysis.request) * 100;
      
      recommendations.push({
        type: RECOMMENDATION_TYPES.REDUCE_REQUEST,
        resource: 'cpu',
        current: cpuAnalysis.request,
        suggested: suggestedRequest,
        savings: reduction.toFixed(2) + '%',
        priority: 'medium',
        reason: `CPU 利用率仅 ${this.formatPercent(cpuAnalysis.avgUtilization)}，可降低 request 节省成本`,
        impact: `预计可节省 ${reduction.toFixed(1)}% CPU 资源配额`
      });
    } else if (cpuAnalysis.status === 'over-utilized' || cpuAnalysis.status === 'risky') {
      if (cpuAnalysis.limit > 0 && cpuAnalysis.limitUtilization > 0.9) {
        const suggestedLimit = cpuAnalysis.maxUsage * 1.3; // 留 30% 缓冲
        recommendations.push({
          type: RECOMMENDATION_TYPES.INCREASE_LIMIT,
          resource: 'cpu',
          current: cpuAnalysis.limit,
          suggested: suggestedLimit,
          priority: 'high',
          reason: `CPU 使用接近 limit（${this.formatPercent(cpuAnalysis.limitUtilization)}），存在 OOM 风险`,
          impact: '避免 CPU throttling 和服务降级'
        });
      }
    }

    // Memory 建议
    if (memoryAnalysis.status === 'under-utilized' && memoryAnalysis.request > 0) {
      const suggestedRequest = memoryAnalysis.maxUsage * 1.2; // 留 20% 缓冲
      const reduction = ((memoryAnalysis.request - suggestedRequest) / memoryAnalysis.request) * 100;
      
      recommendations.push({
        type: RECOMMENDATION_TYPES.REDUCE_REQUEST,
        resource: 'memory',
        current: memoryAnalysis.request,
        suggested: suggestedRequest,
        savings: reduction.toFixed(2) + '%',
        priority: 'medium',
        reason: `Memory 利用率仅 ${this.formatPercent(memoryAnalysis.avgUtilization)}，可降低 request 节省成本`,
        impact: `预计可节省 ${reduction.toFixed(1)}% 内存资源配额`
      });
    } else if (memoryAnalysis.status === 'over-utilized' || memoryAnalysis.status === 'risky') {
      if (memoryAnalysis.limit > 0 && memoryAnalysis.limitUtilization > 0.9) {
        const suggestedLimit = memoryAnalysis.maxUsage * 1.5; // Memory 需要更大缓冲
        recommendations.push({
          type: RECOMMENDATION_TYPES.INCREASE_LIMIT,
          resource: 'memory',
          current: memoryAnalysis.limit,
          suggested: suggestedLimit,
          priority: 'critical',
          reason: `Memory 使用接近 limit（${this.formatPercent(memoryAnalysis.limitUtilization)}），OOM 风险极高`,
          impact: '防止 OOM Killer 导致服务中断'
        });
      }
    }

    // 如果都在最优范围
    if (cpuAnalysis.status === 'optimal' && memoryAnalysis.status === 'optimal') {
      recommendations.push({
        type: RECOMMENDATION_TYPES.OPTIMAL,
        resource: 'both',
        priority: 'info',
        reason: '资源配置合理，无需调整',
        impact: '继续保持当前配置'
      });
    }

    return {
      count: recommendations.length,
      items: recommendations,
      highestPriority: this.getHighestPriority(recommendations)
    };
  }

  /**
   * 批量分析多个容器
   * @param {Array} containerStatsList - 容器统计列表
   * @returns {Object} 批量分析结果
   */
  async analyzeAllContainers(containerStatsList) {
    const results = [];
    const summary = {
      total: containerStatsList.length,
      underUtilized: 0,
      optimal: 0,
      overUtilized: 0,
      risky: 0,
      totalSavingsPotential: {
        cpu: 0,
        memory: 0
      },
      highRiskCount: 0
    };

    for (const stats of containerStatsList) {
      const analysis = this.analyzeContainer(stats);
      results.push(analysis);

      // 统计汇总
      if (analysis.cpu.status === 'under-utilized' || 
          analysis.memory.status === 'under-utilized') {
        summary.underUtilized++;
        
        // 计算节省潜力
        if (analysis.recommendation.items) {
          analysis.recommendation.items.forEach(rec => {
            if (rec.type === RECOMMENDATION_TYPES.REDUCE_REQUEST) {
              if (rec.resource === 'cpu') {
                summary.totalSavingsPotential.cpu += rec.current - rec.suggested;
              } else {
                summary.totalSavingsPotential.memory += rec.current - rec.suggested;
              }
            }
          });
        }
      } else if (analysis.cpu.status === 'optimal' && 
                 analysis.memory.status === 'optimal') {
        summary.optimal++;
      } else if (analysis.cpu.status === 'over-utilized' || 
                 analysis.memory.status === 'over-utilized') {
        summary.overUtilized++;
      } else if (analysis.cpu.status === 'risky' || 
                 analysis.memory.status === 'risky') {
        summary.risky++;
        summary.highRiskCount++;
      }
    }

    return {
      results,
      summary,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 生成分析报告
   * @param {Object} analysisResults - 分析结果
   * @returns {Object} 分析报告
   */
  async generateReport(analysisResults) {
    const { results, summary } = analysisResults;

    const report = {
      title: '容器资源利用率分析报告',
      generatedAt: new Date().toISOString(),
      summary: {
        totalContainers: summary.total,
        underUtilized: summary.underUtilized,
        optimal: summary.optimal,
        overUtilized: summary.overUtilized,
        risky: summary.risky,
        highRiskContainers: summary.highRiskCount,
        potentialSavings: {
          cpu: this.formatCpu(summary.totalSavingsPotential.cpu),
          memory: this.formatMemory(summary.totalSavingsPotential.memory)
        }
      },
      recommendations: {
        immediate: [],
        scheduled: [],
        lowPriority: []
      },
      details: results
    };

    // 分类建议
    results.forEach(result => {
      if (result.recommendation.items) {
        result.recommendation.items.forEach(rec => {
          const item = {
            container: `${result.podName}/${result.containerName}`,
            ...rec,
            score: result.score
          };

          if (rec.priority === 'critical' || rec.priority === 'high') {
            report.recommendations.immediate.push(item);
          } else if (rec.priority === 'medium') {
            report.recommendations.scheduled.push(item);
          } else {
            report.recommendations.lowPriority.push(item);
          }
        });
      }
    });

    // 持久化报告
    await this.saveReport(report);

    return report;
  }

  /**
   * 保存报告到数据库
   * @param {Object} report - 分析报告
   * @returns {Promise<void>}
   */
  async saveReport(report) {
    await executeQuery(
      `INSERT INTO resource_analysis_reports (
        report_data, generated_at
      ) VALUES ($1, $2)`,
      [JSON.stringify(report), new Date()]
    );

    logger.info({ summary: report.summary }, 'Analysis report saved');
  }

  /**
   * 获取历史报告
   * @param {number} limit - 返回条数
   * @returns {Promise<Array>} 历史报告列表
   */
  async getHistoricalReports(limit = 10) {
    const result = await executeQuery(
      `SELECT id, report_data, generated_at 
       FROM resource_analysis_reports 
       ORDER BY generated_at DESC 
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  /**
   * 辅助方法：格式化百分比
   */
  formatPercent(value) {
    return (value * 100).toFixed(1) + '%';
  }

  /**
   * 辅助方法：格式化 CPU
   */
  formatCpu(cores) {
    if (cores < 1) {
      return (cores * 1000).toFixed(0) + 'm';
    }
    return cores.toFixed(2) + ' cores';
  }

  /**
   * 辅助方法：格式化 Memory
   */
  formatMemory(bytes) {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb < 1) {
      return (bytes / (1024 * 1024)).toFixed(0) + 'MB';
    }
    return gb.toFixed(2) + 'GB';
  }

  /**
   * 辅助方法：获取最高优先级
   */
  getHighestPriority(recommendations) {
    const priorityOrder = ['critical', 'high', 'medium', 'low', 'info'];
    for (const priority of priorityOrder) {
      if (recommendations.some(r => r.priority === priority)) {
        return priority;
      }
    }
    return 'info';
  }
}

module.exports = ResourceAnalysisEngine;
