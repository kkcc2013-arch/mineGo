/**
 * backend/shared/monitorReport/MonitorSummaryGenerator.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 智能摘要生成引擎
 */

'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('monitor-summary-generator');

/**
 * 智能摘要生成引擎
 * 
 * 功能：
 * - 关键指标变化检测
 * - 系统健康评分计算
 * - 趋势分析
 * - 智能洞察生成
 */
class MonitorSummaryGenerator {
  constructor(config) {
    this.thresholds = {
      // 错误率阈值
      errorRateWarning: 0.02,    // 2%
      errorRateCritical: 0.05,   // 5%
      
      // 响应时间阈值（ms）
      responseTimeWarning: 1500,
      responseTimeCritical: 3000,
      
      // 资源使用阈值
      resourceWarning: 0.7,      // 70%
      resourceCritical: 0.9,     // 90%
      
      // 变化率阈值（相比上周）
      changeWarning: 0.2,        // 20%
      changeCritical: 0.5        // 50%
    };
  }

  /**
   * 生成监控摘要
   * @param {Object} currentData - 当前监控数据
   * @param {Object} previousData - 上一周期监控数据（用于对比）
   * @returns {Object} 摘要数据
   */
  async generateSummary(currentData, previousData = null) {
    logger.info('Generating monitor summary');
    
    const summary = {
      timestamp: new Date(),
      timeRange: currentData.timeRange,
      healthScore: 0,
      overallStatus: 'healthy',
      keyFindings: [],
      criticalIssues: [],
      warnings: [],
      changes: [],
      trends: [],
      recommendations: [],
      serviceSummary: {},
      resourceSummary: null,
      businessSummary: null
    };
    
    try {
      // 1. 计算系统健康评分
      summary.healthScore = this.calculateHealthScore(currentData);
      
      // 2. 确定整体状态
      summary.overallStatus = this.determineOverallStatus(summary.healthScore, currentData);
      
      // 3. 生成服务摘要
      summary.serviceSummary = this.generateServiceSummary(currentData);
      
      // 4. 生成资源摘要
      summary.resourceSummary = this.generateResourceSummary(currentData);
      
      // 5. 生成业务摘要
      summary.businessSummary = this.generateBusinessSummary(currentData);
      
      // 6. 提取关键发现
      summary.keyFindings = this.extractKeyFindings(currentData);
      
      // 7. 识别关键问题
      summary.criticalIssues = this.identifyCriticalIssues(currentData);
      
      // 8. 识别警告
      summary.warnings = this.identifyWarnings(currentData);
      
      // 9. 检测变化（如果有历史数据）
      if (previousData) {
        summary.changes = this.detectChanges(currentData, previousData);
        summary.trends = this.analyzeTrends(currentData, previousData);
      }
      
      // 10. 生成建议
      summary.recommendations = this.generateRecommendations(summary);
      
      logger.info('Monitor summary generated', {
        healthScore: summary.healthScore,
        overallStatus: summary.overallStatus,
        criticalIssueCount: summary.criticalIssues.length,
        warningCount: summary.warnings.length
      });
      
      return summary;
    } catch (error) {
      logger.error('Failed to generate monitor summary', { error: error.message });
      throw error;
    }
  }

  /**
   * 计算系统健康评分（0-100）
   */
  calculateHealthScore(data) {
    let score = 100;
    
    // 扣分项：
    // - 错误率：每 1% 错误率扣 5 分
    // - 响应时间：P99 > 1s 扣 5 分，> 2s 扣 10 分
    // - 资源使用率：> 70% 扣 5 分，> 90% 扣 10 分
    // - 异常事件：每个异常扣 2-5 分
    
    // 服务健康评分
    const serviceScores = [];
    for (const [service, serviceData] of Object.entries(data.services)) {
      if (serviceData.metrics) {
        let serviceScore = 100;
        
        // 错误率扣分
        const errorRate = serviceData.metrics.errorRate || 0;
        serviceScore -= errorRate * 100 * 5;
        
        // 响应时间扣分
        const p99 = serviceData.metrics.responseTimeP99 || 0;
        if (p99 > 2000) {
          serviceScore -= 10;
        } else if (p99 > 1000) {
          serviceScore -= 5;
        }
        
        // CPU 扣分
        const cpu = serviceData.metrics.cpuUsage || 0;
        if (cpu > 0.9) {
          serviceScore -= 10;
        } else if (cpu > 0.7) {
          serviceScore -= 5;
        }
        
        // 内存扣分
        const memory = serviceData.metrics.memoryUsage || 0;
        if (memory > 0.9) {
          serviceScore -= 10;
        } else if (memory > 0.7) {
          serviceScore -= 5;
        }
        
        serviceScores.push(Math.max(0, serviceScore));
      }
    }
    
    if (serviceScores.length > 0) {
      const avgServiceScore = serviceScores.reduce((a, b) => a + b, 0) / serviceScores.length;
      score = (score + avgServiceScore) / 2;
    }
    
    // 异常事件扣分
    const anomalies = data.anomalies || [];
    for (const anomaly of anomalies) {
      if (anomaly.severity === 'critical') {
        score -= 5;
      } else if (anomaly.severity === 'warning') {
        score -= 2;
      }
    }
    
    // 系统健康状态扣分
    if (data.systemHealth && data.systemHealth.overall !== 'healthy') {
      score -= 10;
    }
    
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * 确定整体状态
   */
  determineOverallStatus(healthScore, data) {
    // 有严重异常
    const criticalAnomalies = (data.anomalies || []).filter(a => a.severity === 'critical');
    if (criticalAnomalies.length > 0) {
      return 'critical';
    }
    
    // 有服务状态为 critical
    for (const serviceData of Object.values(data.services)) {
      if (serviceData.status === 'critical') {
        return 'critical';
      }
    }
    
    // 健康评分低于 60
    if (healthScore < 60) {
      return 'critical';
    }
    
    // 有警告
    const warningAnomalies = (data.anomalies || []).filter(a => a.severity === 'warning');
    if (warningAnomalies.length > 0) {
      return 'warning';
    }
    
    // 有服务状态为 warning
    for (const serviceData of Object.values(data.services)) {
      if (serviceData.status === 'warning') {
        return 'warning';
      }
    }
    
    // 健康评分低于 80
    if (healthScore < 80) {
      return 'warning';
    }
    
    return 'healthy';
  }

  /**
   * 生成服务摘要
   */
  generateServiceSummary(data) {
    const summary = {
      total: Object.keys(data.services).length,
      healthy: 0,
      warning: 0,
      critical: 0,
      unknown: 0,
      topIssues: []
    };
    
    const issues = [];
    
    for (const [service, serviceData] of Object.entries(data.services)) {
      const status = serviceData.status;
      summary[status] = (summary[status] || 0) + 1;
      
      // 收集问题
      if (status !== 'healthy' && serviceData.metrics) {
        if (serviceData.metrics.errorRate > this.thresholds.errorRateWarning) {
          issues.push({
            service,
            type: 'high_error_rate',
            value: serviceData.metrics.errorRate,
            threshold: this.thresholds.errorRateWarning,
            severity: serviceData.metrics.errorRate > this.thresholds.errorRateCritical ? 'critical' : 'warning'
          });
        }
        
        if (serviceData.metrics.responseTimeP99 > this.thresholds.responseTimeWarning) {
          issues.push({
            service,
            type: 'high_latency',
            value: serviceData.metrics.responseTimeP99,
            threshold: this.thresholds.responseTimeWarning,
            severity: serviceData.metrics.responseTimeP99 > this.thresholds.responseTimeCritical ? 'critical' : 'warning'
          });
        }
        
        if (serviceData.metrics.cpuUsage > this.thresholds.resourceWarning) {
          issues.push({
            service,
            type: 'high_cpu',
            value: serviceData.metrics.cpuUsage,
            threshold: this.thresholds.resourceWarning,
            severity: serviceData.metrics.cpuUsage > this.thresholds.resourceCritical ? 'critical' : 'warning'
          });
        }
      }
    }
    
    // 取前 5 个最严重的问题
    summary.topIssues = issues
      .sort((a, b) => {
        if (a.severity === 'critical' && b.severity !== 'critical') return -1;
        if (a.severity !== 'critical' && b.severity === 'critical') return 1;
        return b.value - a.value;
      })
      .slice(0, 5);
    
    return summary;
  }

  /**
   * 生成资源摘要
   */
  generateResourceSummary(data) {
    if (!data.resourceUsage) return null;
    
    const usage = data.resourceUsage;
    
    return {
      cpu: {
        value: usage.cpuUsage,
        status: usage.cpuUsage > this.thresholds.resourceCritical ? 'critical' :
                usage.cpuUsage > this.thresholds.resourceWarning ? 'warning' : 'healthy'
      },
      memory: {
        value: usage.memoryUsage,
        status: usage.memoryUsage > this.thresholds.resourceCritical ? 'critical' :
                usage.memoryUsage > this.thresholds.resourceWarning ? 'warning' : 'healthy'
      },
      dbPool: {
        value: usage.dbPoolUsage,
        status: usage.dbPoolUsage > this.thresholds.resourceCritical ? 'critical' :
                usage.dbPoolUsage > this.thresholds.resourceWarning ? 'warning' : 'healthy'
      },
      redisPool: {
        value: usage.redisPoolUsage,
        status: usage.redisPoolUsage > this.thresholds.resourceCritical ? 'critical' :
                usage.redisPoolUsage > this.thresholds.resourceWarning ? 'warning' : 'healthy'
      }
    };
  }

  /**
   * 生成业务摘要
   */
  generateBusinessSummary(data) {
    if (!data.businessMetrics) return null;
    
    const metrics = data.businessMetrics;
    
    return {
      catchRate: {
        value: metrics.catchRate,
        attempts: metrics.catchAttempts,
        success: metrics.catchSuccess
      },
      gymBattles: metrics.gymBattles,
      paymentTransactions: metrics.paymentTransactions,
      estimatedActiveUsers: metrics.estimatedActiveUsers
    };
  }

  /**
   * 提取关键发现
   */
  extractKeyFindings(data) {
    const findings = [];
    
    // 检查整体健康评分
    if (data.systemHealth) {
      findings.push({
        type: 'system_health',
        message: `系统整体健康状态：${data.systemHealth.overall}`,
        severity: data.systemHealth.overall === 'healthy' ? 'info' : 'warning'
      });
    }
    
    // 检查服务状态分布
    if (data.services) {
      const criticalCount = Object.values(data.services).filter(s => s.status === 'critical').length;
      const warningCount = Object.values(data.services).filter(s => s.status === 'warning').length;
      
      if (criticalCount > 0) {
        findings.push({
          type: 'service_status',
          message: `${criticalCount} 个服务处于严重状态`,
          severity: 'critical'
        });
      } else if (warningCount > 0) {
        findings.push({
          type: 'service_status',
          message: `${warningCount} 个服务处于警告状态`,
          severity: 'warning'
        });
      }
    }
    
    // 检查异常事件
    if (data.anomalies && data.anomalies.length > 0) {
      findings.push({
        type: 'anomalies',
        message: `检测到 ${data.anomalies.length} 个异常事件`,
        severity: data.anomalies.some(a => a.severity === 'critical') ? 'critical' : 'warning'
      });
    }
    
    // 检查业务指标
    if (data.businessMetrics) {
      if (data.businessMetrics.catchRate) {
        findings.push({
          type: 'business',
          message: `精灵捕捉成功率：${(data.businessMetrics.catchRate * 100).toFixed(1)}%`,
          severity: 'info'
        });
      }
    }
    
    return findings;
  }

  /**
   * 识别关键问题
   */
  identifyCriticalIssues(data) {
    const issues = [];
    
    // 服务关键问题
    for (const [service, serviceData] of Object.entries(data.services)) {
      if (serviceData.status === 'critical') {
        issues.push({
          type: 'service_critical',
          service,
          metrics: serviceData.metrics,
          message: this.generateServiceCriticalMessage(service, serviceData.metrics)
        });
      }
    }
    
    // 异常事件关键问题
    const criticalAnomalies = (data.anomalies || []).filter(a => a.severity === 'critical');
    for (const anomaly of criticalAnomalies) {
      issues.push({
        type: 'anomaly',
        anomaly,
        message: `[${anomaly.service}] ${anomaly.message}`
      });
    }
    
    // 资源关键问题
    if (data.resourceUsage) {
      if (data.resourceUsage.cpuUsage > this.thresholds.resourceCritical) {
        issues.push({
          type: 'resource',
          resource: 'cpu',
          value: data.resourceUsage.cpuUsage,
          message: `CPU 使用率过高：${(data.resourceUsage.cpuUsage * 100).toFixed(1)}%`
        });
      }
      
      if (data.resourceUsage.memoryUsage > this.thresholds.resourceCritical) {
        issues.push({
          type: 'resource',
          resource: 'memory',
          value: data.resourceUsage.memoryUsage,
          message: `内存使用率过高：${(data.resourceUsage.memoryUsage * 100).toFixed(1)}%`
        });
      }
    }
    
    return issues;
  }

  /**
   * 识别警告
   */
  identifyWarnings(data) {
    const warnings = [];
    
    // 服务警告
    for (const [service, serviceData] of Object.entries(data.services)) {
      if (serviceData.status === 'warning') {
        warnings.push({
          type: 'service_warning',
          service,
          metrics: serviceData.metrics,
          message: this.generateServiceWarningMessage(service, serviceData.metrics)
        });
      }
    }
    
    // 异常事件警告
    const warningAnomalies = (data.anomalies || []).filter(a => a.severity === 'warning');
    for (const anomaly of warningAnomalies) {
      warnings.push({
        type: 'anomaly',
        anomaly,
        message: `[${anomaly.service}] ${anomaly.message}`
      });
    }
    
    // 资源警告
    if (data.resourceUsage) {
      if (data.resourceUsage.cpuUsage > this.thresholds.resourceWarning) {
        warnings.push({
          type: 'resource',
          resource: 'cpu',
          value: data.resourceUsage.cpuUsage,
          message: `CPU 使用率较高：${(data.resourceUsage.cpuUsage * 100).toFixed(1)}%`
        });
      }
      
      if (data.resourceUsage.dbPoolUsage > this.thresholds.resourceWarning) {
        warnings.push({
          type: 'resource',
          resource: 'db_pool',
          value: data.resourceUsage.dbPoolUsage,
          message: `数据库连接池使用率较高：${(data.resourceUsage.dbPoolUsage * 100).toFixed(1)}%`
        });
      }
    }
    
    return warnings;
  }

  /**
   * 检测变化（与上一周期对比）
   */
  detectChanges(currentData, previousData) {
    const changes = [];
    
    // 服务指标变化
    for (const [service, currentServiceData] of Object.entries(currentData.services)) {
      const previousServiceData = previousData.services[service];
      
      if (currentServiceData.metrics && previousServiceData && previousServiceData.metrics) {
        // 错误率变化
        const errorRateChange = currentServiceData.metrics.errorRate - previousServiceData.metrics.errorRate;
        if (Math.abs(errorRateChange) > 0.01) { // 变化 > 1%
          changes.push({
            type: 'error_rate_change',
            service,
            previous: previousServiceData.metrics.errorRate,
            current: currentServiceData.metrics.errorRate,
            change: errorRateChange,
            changePercent: errorRateChange / previousServiceData.metrics.errorRate,
            severity: errorRateChange > 0 ? 'warning' : 'info'
          });
        }
        
        // 响应时间变化
        const latencyChange = currentServiceData.metrics.responseTimeP99 - previousServiceData.metrics.responseTimeP99;
        if (Math.abs(latencyChange) > 100) { // 变化 > 100ms
          changes.push({
            type: 'latency_change',
            service,
            previous: previousServiceData.metrics.responseTimeP99,
            current: currentServiceData.metrics.responseTimeP99,
            change: latencyChange,
            severity: latencyChange > 0 ? 'warning' : 'info'
          });
        }
      }
    }
    
    // 业务指标变化
    if (currentData.businessMetrics && previousData.businessMetrics) {
      const catchRateChange = currentData.businessMetrics.catchRate - previousData.businessMetrics.catchRate;
      if (Math.abs(catchRateChange) > 0.05) { // 变化 > 5%
        changes.push({
          type: 'catch_rate_change',
          previous: previousData.businessMetrics.catchRate,
          current: currentData.businessMetrics.catchRate,
          change: catchRateChange,
          severity: catchRateChange < 0 ? 'warning' : 'info'
        });
      }
    }
    
    return changes;
  }

  /**
   * 分析趋势
   */
  analyzeTrends(currentData, previousData) {
    const trends = [];
    
    // 简单趋势分析（需要更多历史数据才能做更精确的趋势预测）
    for (const [service, currentServiceData] of Object.entries(currentData.services)) {
      const previousServiceData = previousData.services[service];
      
      if (currentServiceData.metrics && previousServiceData && previousServiceData.metrics) {
        // 响应时间趋势
        if (currentServiceData.metrics.responseTimeP99 > previousServiceData.metrics.responseTimeP99 * 1.2) {
          trends.push({
            type: 'latency_increasing',
            service,
            trend: 'increasing',
            message: `${service} 响应时间呈上升趋势，建议关注`
          });
        }
        
        // 错误率趋势
        if (currentServiceData.metrics.errorRate > previousServiceData.metrics.errorRate * 1.2) {
          trends.push({
            type: 'error_rate_increasing',
            service,
            trend: 'increasing',
            message: `${service} 错误率呈上升趋势，需要调查`
          });
        }
      }
    }
    
    return trends;
  }

  /**
   * 生成建议
   */
  generateRecommendations(summary) {
    const recommendations = [];
    
    // 基于关键问题生成建议
    for (const issue of summary.criticalIssues) {
      if (issue.type === 'service_critical') {
        recommendations.push({
          priority: 'high',
          type: 'service_investigation',
          message: `立即调查 ${issue.service} 服务的关键问题`,
          details: issue.message
        });
      }
    }
    
    // 基于警告生成建议
    for (const warning of summary.warnings) {
      if (warning.type === 'resource' && warning.resource === 'db_pool') {
        recommendations.push({
          priority: 'medium',
          type: 'resource_optimization',
          message: '考虑增加数据库连接池大小或优化查询',
          details: warning.message
        });
      }
    }
    
    // 基于趋势生成建议
    for (const trend of summary.trends) {
      if (trend.type === 'latency_increasing') {
        recommendations.push({
          priority: 'medium',
          type: 'performance_optimization',
          message: trend.message,
          details: '考虑使用 REQ-00545 性能分析系统进行深入分析'
        });
      }
    }
    
    // 基于健康评分生成建议
    if (summary.healthScore < 80) {
      recommendations.push({
        priority: 'high',
        type: 'health_improvement',
        message: '系统健康评分较低，建议优先处理上述问题',
        details: `当前健康评分：${summary.healthScore}/100`
      });
    }
    
    return recommendations;
  }

  /**
   * 生成服务关键问题消息
   */
  generateServiceCriticalMessage(service, metrics) {
    const messages = [];
    
    if (metrics.errorRate > this.thresholds.errorRateCritical) {
      messages.push(`错误率 ${(metrics.errorRate * 100).toFixed(1)}%`);
    }
    
    if (metrics.responseTimeP99 > this.thresholds.responseTimeCritical) {
      messages.push(`P99 响应时间 ${metrics.responseTimeP99.toFixed(0)}ms`);
    }
    
    if (metrics.cpuUsage > this.thresholds.resourceCritical) {
      messages.push(`CPU 使用率 ${(metrics.cpuUsage * 100).toFixed(1)}%`);
    }
    
    return `${service} 关键问题：${messages.join(', ')}`;
  }

  /**
   * 生成服务警告消息
   */
  generateServiceWarningMessage(service, metrics) {
    const messages = [];
    
    if (metrics.errorRate > this.thresholds.errorRateWarning) {
      messages.push(`错误率 ${(metrics.errorRate * 100).toFixed(1)}%`);
    }
    
    if (metrics.responseTimeP99 > this.thresholds.responseTimeWarning) {
      messages.push(`P99 响应时间 ${metrics.responseTimeP99.toFixed(0)}ms`);
    }
    
    if (metrics.cpuUsage > this.thresholds.resourceWarning) {
      messages.push(`CPU 使用率 ${(metrics.cpuUsage * 100).toFixed(1)}%`);
    }
    
    return `${service} 警告：${messages.join(', ')}`;
  }
}

module.exports = MonitorSummaryGenerator;