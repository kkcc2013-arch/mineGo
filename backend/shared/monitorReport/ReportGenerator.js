/**
 * backend/shared/monitorReport/ReportGenerator.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 报告生成器
 */

'use strict';

const { createLogger } = require('../logger');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('report-generator');

/**
 * 报告生成器
 * 
 * 支持多种报告格式：
 * - Markdown（适合 Git/GitLab）
 * - HTML（适合邮件）
 * - JSON（适合 API）
 */
class ReportGenerator {
  constructor(config) {
    this.templateDir = config.templateDir || path.join(__dirname, 'templates');
    this.outputDir = config.outputDir || path.join(__dirname, 'reports');
  }

  /**
   * 生成报告
   * @param {string} reportType - 'daily' | 'weekly' | 'incident'
   * @param {Object} summary - 监控摘要
   * @param {Object} rawData - 原始监控数据
   * @param {string} format - 'markdown' | 'html' | 'json'
   * @returns {string} 报告内容
   */
  async generateReport(reportType, summary, rawData, format = 'markdown') {
    logger.info('Generating report', { reportType, format });
    
    let content;
    
    switch (format) {
      case 'markdown':
        content = await this.generateMarkdown(reportType, summary, rawData);
        break;
      case 'html':
        content = await this.generateHTML(reportType, summary, rawData);
        break;
      case 'json':
        content = await this.generateJSON(reportType, summary, rawData);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
    
    return content;
  }

  /**
   * 生成 Markdown 格式报告
   */
  async generateMarkdown(reportType, summary, rawData) {
    const lines = [];
    const timestamp = new Date().toISOString();
    
    // 标题
    lines.push(`# mineGo 监控报告 - ${this.getReportTitle(reportType)}`);
    lines.push('');
    lines.push(`> 生成时间: ${timestamp}`);
    lines.push(`> 报告周期: ${rawData.timeRange.start.toISOString()} - ${rawData.timeRange.end.toISOString()}`);
    lines.push('');
    
    // 执行摘要
    lines.push('## 📊 执行摘要');
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| 健康评分 | ${summary.healthScore}/100 |`);
    lines.push(`| 整体状态 | ${this.getStatusEmoji(summary.overallStatus)} ${summary.overallStatus} |`);
    lines.push(`| 服务健康 | ✅ ${summary.serviceSummary.healthy} / ⚠️ ${summary.serviceSummary.warning} / 🚨 ${summary.serviceSummary.critical} |`);
    lines.push(`| 异常事件 | ${summary.criticalIssues.length + summary.warnings.length} |`);
    lines.push('');
    
    // 关键发现
    if (summary.keyFindings.length > 0) {
      lines.push('## 🔍 关键发现');
      lines.push('');
      for (const finding of summary.keyFindings) {
        lines.push(`- ${this.getSeverityEmoji(finding.severity)} ${finding.message}`);
      }
      lines.push('');
    }
    
    // 关键问题
    if (summary.criticalIssues.length > 0) {
      lines.push('## 🚨 关键问题');
      lines.push('');
      for (const issue of summary.criticalIssues) {
        lines.push(`### ${issue.type === 'service_critical' ? issue.service : issue.type}`);
        lines.push('');
        lines.push(`${issue.message}`);
        lines.push('');
        
        if (issue.metrics) {
          lines.push('| 指标 | 值 |');
          lines.push('|------|-----|');
          if (issue.metrics.errorRate) {
            lines.push(`| 错误率 | ${(issue.metrics.errorRate * 100).toFixed(2)}% |`);
          }
          if (issue.metrics.responseTimeP99) {
            lines.push(`| P99 响应时间 | ${issue.metrics.responseTimeP99.toFixed(0)}ms |`);
          }
          if (issue.metrics.cpuUsage) {
            lines.push(`| CPU 使用率 | ${(issue.metrics.cpuUsage * 100).toFixed(1)}% |`);
          }
          lines.push('');
        }
      }
    }
    
    // 警告
    if (summary.warnings.length > 0) {
      lines.push('## ⚠️ 警告');
      lines.push('');
      for (const warning of summary.warnings) {
        lines.push(`- ${warning.message}`);
      }
      lines.push('');
    }
    
    // 变化
    if (summary.changes.length > 0) {
      lines.push('## 📈 变化分析');
      lines.push('');
      lines.push('与上一周期相比：');
      lines.push('');
      for (const change of summary.changes) {
        const changeEmoji = change.change > 0 ? '📈' : '📉';
        lines.push(`- ${changeEmoji} **${change.service || '系统'}**: ${this.getChangeDescription(change)}`);
      }
      lines.push('');
    }
    
    // 趋势
    if (summary.trends.length > 0) {
      lines.push('## 📊 趋势分析');
      lines.push('');
      for (const trend of summary.trends) {
        lines.push(`- ${trend.message}`);
      }
      lines.push('');
    }
    
    // 建议
    if (summary.recommendations.length > 0) {
      lines.push('## 💡 建议');
      lines.push('');
      const sortedRecommendations = [...summary.recommendations].sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
      
      for (const rec of sortedRecommendations) {
        const priorityEmoji = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢';
        lines.push(`${priorityEmoji} **[${rec.priority.toUpperCase()}]** ${rec.message}`);
        if (rec.details) {
          lines.push(`  - ${rec.details}`);
        }
      }
      lines.push('');
    }
    
    // 服务详情
    lines.push('## 🖥️ 服务详情');
    lines.push('');
    lines.push('| 服务 | 状态 | 错误率 | P99 (ms) | CPU | 内存 |');
    lines.push('|------|------|--------|----------|-----|------|');
    
    for (const [service, serviceData] of Object.entries(rawData.services)) {
      const statusEmoji = this.getStatusEmoji(serviceData.status);
      const metrics = serviceData.metrics || {};
      lines.push(`| ${service} | ${statusEmoji} | ${(metrics.errorRate * 100 || 0).toFixed(2)}% | ${metrics.responseTimeP99?.toFixed(0) || '-'} | ${(metrics.cpuUsage * 100 || 0).toFixed(1)}% | ${(metrics.memoryUsage * 100 || 0).toFixed(1)}% |`);
    }
    lines.push('');
    
    // 资源使用
    if (summary.resourceSummary) {
      lines.push('## 💾 资源使用');
      lines.push('');
      lines.push('| 资源 | 使用率 | 状态 |');
      lines.push('|------|--------|------|');
      
      for (const [resource, data] of Object.entries(summary.resourceSummary)) {
        lines.push(`| ${resource} | ${(data.value * 100).toFixed(1)}% | ${this.getStatusEmoji(data.status)} |`);
      }
      lines.push('');
    }
    
    // 业务指标
    if (summary.businessSummary) {
      lines.push('## 🎮 业务指标');
      lines.push('');
      lines.push('| 指标 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| 捕捉成功率 | ${(summary.businessSummary.catchRate.value * 100).toFixed(1)}% |`);
      lines.push(`| 捕捉尝试次数 | ${summary.businessSummary.catchRate.attempts.toFixed(0)}/h |`);
      lines.push(`| 道馆战斗次数 | ${summary.businessSummary.gymBattles.toFixed(0)}/h |`);
      lines.push(`| 支付交易次数 | ${summary.businessSummary.paymentTransactions.toFixed(0)}/h |`);
      lines.push('');
    }
    
    // 异常事件列表
    if (rawData.anomalies && rawData.anomalies.length > 0) {
      lines.push('## 📋 异常事件列表');
      lines.push('');
      lines.push('| 时间 | 类型 | 服务 | 严重性 | 消息 |');
      lines.push('|------|------|------|--------|------|');
      
      for (const anomaly of rawData.anomalies.slice(0, 20)) { // 只显示前 20 条
        lines.push(`| ${anomaly.lastOccurrence.toISOString()} | ${anomaly.type} | ${anomaly.service} | ${anomaly.severity} | ${anomaly.message.slice(0, 50)}... |`);
      }
      lines.push('');
    }
    
    // 页脚
    lines.push('---');
    lines.push('');
    lines.push('*此报告由 mineGo 监控数据智能摘要系统自动生成*');
    lines.push(`*报告编号: ${reportType}-${Date.now()}*`);
    
    return lines.join('\n');
  }

  /**
   * 生成 HTML 格式报告
   */
  async generateHTML(reportType, summary, rawData) {
    const timestamp = new Date().toISOString();
    
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mineGo 监控报告 - ${this.getReportTitle(reportType)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2c3e50;
      border-bottom: 3px solid #3498db;
      padding-bottom: 10px;
    }
    h2 {
      color: #34495e;
      margin-top: 30px;
    }
    .header {
      margin-bottom: 30px;
      padding: 15px;
      background: #ecf0f1;
      border-radius: 5px;
    }
    .health-score {
      font-size: 48px;
      font-weight: bold;
      text-align: center;
      padding: 20px;
      margin: 20px 0;
      border-radius: 8px;
      background: ${this.getHealthColor(summary.healthScore)};
      color: white;
    }
    .status-healthy { color: #27ae60; }
    .status-warning { color: #f39c12; }
    .status-critical { color: #e74c3c; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 12px;
      text-align: left;
    }
    th {
      background: #3498db;
      color: white;
    }
    tr:nth-child(even) { background: #f9f9f9; }
    .issue-critical {
      background: #fee !important;
      border-left: 4px solid #e74c3c;
    }
    .issue-warning {
      background: #fffbe6 !important;
      border-left: 4px solid #f39c12;
    }
    .recommendation {
      padding: 10px;
      margin: 10px 0;
      border-radius: 5px;
    }
    .rec-high { background: #ffebee; border-left: 4px solid #e74c3c; }
    .rec-medium { background: #fff8e1; border-left: 4px solid #f39c12; }
    .rec-low { background: #e8f5e9; border-left: 4px solid #27ae60; }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      text-align: center;
      color: #999;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 mineGo 监控报告 - ${this.getReportTitle(reportType)}</h1>
    
    <div class="header">
      <strong>报告周期:</strong> ${rawData.timeRange.start.toISOString()} - ${rawData.timeRange.end.toISOString()}<br>
      <strong>生成时间:</strong> ${timestamp}
    </div>
    
    <div class="health-score">
      健康评分: ${summary.healthScore}/100
    </div>
    
    <h2>📋 执行摘要</h2>
    <table>
      <tr><th>指标</th><th>值</th></tr>
      <tr><td>整体状态</td><td class="status-${summary.overallStatus}">${summary.overallStatus.toUpperCase()}</td></tr>
      <tr><td>服务健康</td><td>✅ ${summary.serviceSummary.healthy} / ⚠️ ${summary.serviceSummary.warning} / 🚨 ${summary.serviceSummary.critical}</td></tr>
      <tr><td>异常事件</td><td>${summary.criticalIssues.length + summary.warnings.length}</td></tr>
    </table>
    
    ${this.generateKeyFindingsHTML(summary.keyFindings)}
    ${this.generateCriticalIssuesHTML(summary.criticalIssues)}
    ${this.generateWarningsHTML(summary.warnings)}
    ${this.generateChangesHTML(summary.changes)}
    ${this.generateRecommendationsHTML(summary.recommendations)}
    ${this.generateServiceTableHTML(rawData.services)}
    
    <div class="footer">
      此报告由 mineGo 监控数据智能摘要系统自动生成<br>
      报告编号: ${reportType}-${Date.now()}
    </div>
  </div>
</body>
</html>`;
    
    return html;
  }

  /**
   * 生成 JSON 格式报告
   */
  async generateJSON(reportType, summary, rawData) {
    return JSON.stringify({
      reportType,
      timestamp: new Date().toISOString(),
      timeRange: rawData.timeRange,
      summary: {
        healthScore: summary.healthScore,
        overallStatus: summary.overallStatus,
        serviceSummary: summary.serviceSummary,
        resourceSummary: summary.resourceSummary,
        businessSummary: summary.businessSummary
      },
      keyFindings: summary.keyFindings,
      criticalIssues: summary.criticalIssues,
      warnings: summary.warnings,
      changes: summary.changes,
      trends: summary.trends,
      recommendations: summary.recommendations,
      services: rawData.services,
      anomalies: rawData.anomalies,
      resourceUsage: rawData.resourceUsage,
      businessMetrics: rawData.businessMetrics
    }, null, 2);
  }

  /**
   * 保存报告到文件
   */
  async saveReport(content, filename) {
    const filePath = path.join(this.outputDir, filename);
    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    logger.info('Report saved', { filePath });
    return filePath;
  }

  // Helper methods
  getReportTitle(reportType) {
    const titles = {
      daily: '每日监控摘要',
      weekly: '每周监控深度报告',
      incident: '异常事件报告'
    };
    return titles[reportType] || '监控报告';
  }

  getStatusEmoji(status) {
    const emojis = {
      healthy: '✅',
      warning: '⚠️',
      critical: '🚨',
      unknown: '❓'
    };
    return emojis[status] || '❓';
  }

  getSeverityEmoji(severity) {
    const emojis = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨'
    };
    return emojis[severity] || 'ℹ️';
  }

  getHealthColor(score) {
    if (score >= 80) return '#27ae60';
    if (score >= 60) return '#f39c12';
    return '#e74c3c';
  }

  getChangeDescription(change) {
    const descriptions = {
      error_rate_change: `错误率变化 ${(change.change * 100).toFixed(1)}%`,
      latency_change: `响应时间变化 ${change.change.toFixed(0)}ms`,
      throughput_change: `吞吐量变化 ${(change.change * 100).toFixed(1)}%`,
      catch_rate_change: `捕捉成功率变化 ${(change.change * 100).toFixed(1)}%`
    };
    return descriptions[change.type] || change.type;
  }

  generateKeyFindingsHTML(findings) {
    if (!findings || findings.length === 0) return '';
    const items = findings.map(f => `<li>${this.getSeverityEmoji(f.severity)} ${f.message}</li>`).join('');
    return `<h2>🔍 关键发现</h2><ul>${items}</ul>`;
  }

  generateCriticalIssuesHTML(issues) {
    if (!issues || issues.length === 0) return '<h2>🚨 关键问题</h2><p>无关键问题</p>';
    const items = issues.map(i => `<div class="issue-critical"><strong>${i.message}</strong></div>`).join('');
    return `<h2>🚨 关键问题</h2>${items}`;
  }

  generateWarningsHTML(warnings) {
    if (!warnings || warnings.length === 0) return '<h2>⚠️ 警告</h2><p>无警告</p>';
    const items = warnings.map(w => `<div class="issue-warning">${w.message}</div>`).join('');
    return `<h2>⚠️ 警告</h2>${items}`;
  }

  generateChangesHTML(changes) {
    if (!changes || changes.length === 0) return '';
    const rows = changes.map(c => `<tr><td>${c.service || '系统'}</td><td>${c.type}</td><td>${c.change > 0 ? '+' : ''}${(c.change * 100).toFixed(1)}%</td></tr>`).join('');
    return `<h2>📈 变化分析</h2><table><tr><th>对象</th><th>指标</th><th>变化</th></tr>${rows}</table>`;
  }

  generateRecommendationsHTML(recommendations) {
    if (!recommendations || recommendations.length === 0) return '';
    const items = recommendations.map(r => 
      `<div class="rec-${r.priority}"><strong>[${r.priority.toUpperCase()}]</strong> ${r.message}${r.details ? `<br><small>${r.details}</small>` : ''}</div>`
    ).join('');
    return `<h2>💡 建议</h2>${items}`;
  }

  generateServiceTableHTML(services) {
    const rows = Object.entries(services).map(([name, data]) => {
      const m = data.metrics || {};
      return `<tr class="${data.status === 'critical' ? 'issue-critical' : data.status === 'warning' ? 'issue-warning' : ''}">
        <td>${name}</td>
        <td class="status-${data.status}">${data.status}</td>
        <td>${(m.errorRate * 100 || 0).toFixed(2)}%</td>
        <td>${m.responseTimeP99?.toFixed(0) || '-'}</td>
        <td>${(m.cpuUsage * 100 || 0).toFixed(1)}%</td>
      </tr>`;
    }).join('');
    
    return `<h2>🖥️ 服务详情</h2>
<table>
  <tr><th>服务</th><th>状态</th><th>错误率</th><th>P99 (ms)</th><th>CPU</th></tr>
  ${rows}
</table>`;
  }
}

module.exports = ReportGenerator;