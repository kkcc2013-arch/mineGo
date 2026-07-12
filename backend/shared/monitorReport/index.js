/**
 * backend/shared/monitorReport/index.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 模块入口
 */

'use strict';

const MonitorDataCollector = require('./MonitorDataCollector');
const MonitorSummaryGenerator = require('./MonitorSummaryGenerator');
const ReportGenerator = require('./ReportGenerator');

/**
 * 监控报告系统
 */
class MonitorReportSystem {
  constructor(config = {}) {
    this.collector = new MonitorDataCollector(config.collector || {});
    this.generator = new MonitorSummaryGenerator(config.generator || {});
    this.reporter = new ReportGenerator(config.reporter || {});
  }

  /**
   * 生成监控报告
   * @param {string} reportType - 'daily' | 'weekly' | 'incident'
   * @param {Object} timeRange - { start: Date, end: Date }
   * @param {Object} previousData - 上一周期数据（用于对比）
   * @param {string} format - 'markdown' | 'html' | 'json'
   * @returns {Object} { summary, report, rawData }
   */
  async generateReport(reportType, timeRange, previousData = null, format = 'markdown') {
    // 1. 采集监控数据
    const rawData = await this.collector.collect(timeRange);
    
    // 2. 生成摘要
    const summary = await this.generator.generateSummary(rawData, previousData);
    
    // 3. 生成报告
    const report = await this.reporter.generateReport(reportType, summary, rawData, format);
    
    return {
      summary,
      report,
      rawData
    };
  }

  /**
   * 快速健康检查
   */
  async quickHealthCheck() {
    const now = new Date();
    const start = new Date(now.getTime() - 15 * 60 * 1000); // 最近 15 分钟
    
    const rawData = await this.collector.collect({ start, end: now });
    const summary = await this.generator.generateSummary(rawData);
    
    return {
      healthScore: summary.healthScore,
      overallStatus: summary.overallStatus,
      criticalIssues: summary.criticalIssues.length,
      warnings: summary.warnings.length
    };
  }
}

module.exports = {
  MonitorReportSystem,
  MonitorDataCollector,
  MonitorSummaryGenerator,
  ReportGenerator
};