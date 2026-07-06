/**
 * 回归测试报告生成器
 * 生成 Markdown 格式的回归测试报告
 * 
 * @module RegressionReportGenerator
 */

const fs = require('fs').promises;
const path = require('path');

class RegressionReportGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, 'reports');
  }

  /**
   * 生成完整的回归测试报告
   */
  async generateReport(results) {
    await fs.mkdir(this.outputDir, { recursive: true });

    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalChecks: (results.breakingChanges?.length || 0) + 
                     (results.consistencyIssues?.length || 0),
        criticalIssues: results.breakingChanges?.filter(c => c.severity === 'critical').length || 0,
        warnings: results.breakingChanges?.filter(c => c.severity === 'warning').length || 0,
        performanceRegressions: results.performance?.comparison?.filter(c => c.degraded).length || 0,
        passed: this.evaluatePassStatus(results),
      },
      breakingChanges: results.breakingChanges || [],
      consistencyIssues: results.consistencyIssues || [],
      performance: results.performance || {},
      recommendations: this.generateRecommendations(results),
    };

    // 生成 Markdown 报告
    const markdown = this.generateMarkdown(report);
    const reportPath = path.join(this.outputDir, `regression-${Date.now()}.md`);
    await fs.writeFile(reportPath, markdown);

    // 同时保存 JSON 版本
    const jsonPath = path.join(this.outputDir, `regression-${Date.now()}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));

    // 更新 latest 链接
    await fs.writeFile(
      path.join(this.outputDir, 'latest.md'),
      markdown
    );
    await fs.writeFile(
      path.join(this.outputDir, 'latest.json'),
      JSON.stringify(report, null, 2)
    );

    return {
      report,
      markdownPath: reportPath,
      jsonPath,
    };
  }

  /**
   * 评估是否通过
   */
  evaluatePassStatus(results) {
    const criticalBreakingChanges = results.breakingChanges?.filter(
      c => c.severity === 'critical' && !c.approved
    ).length || 0;

    const performanceRegressions = results.performance?.comparison?.filter(
      c => c.degraded
    ).length || 0;

    const consistencyErrors = results.consistencyIssues?.filter(
      i => i.severity === 'error'
    ).length || 0;

    return criticalBreakingChanges === 0 && 
           performanceRegressions === 0 && 
           consistencyErrors === 0;
  }

  /**
   * 生成修复建议
   */
  generateRecommendations(results) {
    const recommendations = [];

    // Breaking Change 建议
    const criticalBreaking = results.breakingChanges?.filter(c => c.severity === 'critical') || [];
    if (criticalBreaking.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'breaking-change',
        message: `检测到 ${criticalBreaking.length} 个 Breaking Change，建议：`,
        actions: [
          '1. 评估影响范围并更新客户端代码',
          '2. 如确需变更，在 approved-breaking-changes.json 中添加审批记录',
          '3. 更新 API 版本号并发布迁移指南',
          '4. 在 CHANGELOG 中明确标注 Breaking Change',
        ],
      });
    }

    // 性能退化建议
    const degraded = results.performance?.comparison?.filter(c => c.degraded) || [];
    if (degraded.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'performance',
        message: `${degraded.length} 个接口性能退化超过阈值，建议：`,
        actions: [
          '1. 检查最近的代码变更',
          '2. 分析数据库查询计划',
          '3. 考虑添加缓存或优化索引',
          '4. 检查是否有 N+1 查询问题',
        ],
        affectedEndpoints: degraded.map(d => d.endpoint),
      });
    }

    // 文档一致性建议
    const undocumented = results.consistencyIssues?.filter(
      i => i.type === 'IMPLEMENTED_ROUTE_NOT_DOCUMENTED'
    ) || [];
    if (undocumented.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'documentation',
        message: `${undocumented.length} 个路由未在 OpenAPI 文档中声明，建议：`,
        actions: [
          '1. 使用 openapi-generator 自动生成基础文档',
          '2. 补充参数和响应定义',
          '3. 添加示例和描述',
        ],
        affectedRoutes: undocumented.map(i => `${i.method.toUpperCase()} ${i.path}`),
      });
    }

    // 安全配置建议
    const securityIssues = results.breakingChanges?.filter(c => c.type.includes('SECURITY')) || [];
    if (securityIssues.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'security',
        message: `检测到 ${securityIssues.length} 个安全配置变更：`,
        actions: [
          '1. 确认安全配置变更是否为预期行为',
          '2. 评估潜在的安全风险',
          '3. 如必要，更新客户端认证方式',
        ],
      });
    }

    return recommendations;
  }

  /**
   * 生成 Markdown 报告内容
   */
  generateMarkdown(report) {
    const lines = [
      '# API 回归测试报告',
      '',
      `**生成时间**: ${report.timestamp}`,
      `**测试结果**: ${report.summary.passed ? '✅ 通过' : '❌ 未通过'}`,
      '',
      '## 摘要',
      '',
      '| 指标 | 数量 |',
      '|------|------|',
      `| 总检查项 | ${report.summary.totalChecks} |`,
      `| 严重问题 | ${report.summary.criticalIssues} ❌ |`,
      `| 警告 | ${report.summary.warnings} ⚠️ |`,
      `| 性能退化 | ${report.summary.performanceRegressions} |`,
      '',
    ];

    // Breaking Change 部分
    lines.push('## Breaking Change 检测', '');
    if (report.breakingChanges.length > 0) {
      lines.push('| 严重级别 | 类型 | 路径 | 方法 | 消息 |');
      lines.push('|----------|------|------|------|------|');
      
      for (const change of report.breakingChanges) {
        const severityIcon = change.severity === 'critical' ? '❌' : 
                            change.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(
          `| ${severityIcon} ${change.severity} | ${change.type} | ` +
          `${change.path} | ${change.method?.toUpperCase() || '-'} | ${change.message} |`
        );
      }
    } else {
      lines.push('✅ 未检测到 Breaking Change');
    }
    lines.push('');

    // 性能基准部分
    if (report.performance?.results?.length > 0) {
      lines.push('## 性能基准', '');
      lines.push('| 接口 | 方法 | P50 延迟 | P95 延迟 | 最大延迟 | 状态 |');
      lines.push('|------|------|----------|----------|----------|------|');

      for (const r of report.performance.results) {
        const status = r.regression ? '❌ 退化' : '✅ 正常';
        lines.push(
          `| ${r.path} | ${r.method.toUpperCase()} | ` +
          `${r.p50Latency?.toFixed(2) || '-'}ms | ${r.p95Latency?.toFixed(2) || '-'}ms | ` +
          `${r.maxLatency?.toFixed(2) || '-'}ms | ${status} |`
        );
      }

      // 对比部分
      if (report.performance?.comparison?.length > 0) {
        lines.push('', '### 与历史基准对比', '');
        lines.push('| 接口 | 基准 P95 | 当前 P95 | 变化 | 状态 |');
        lines.push('|------|----------|----------|------|------|');

        for (const c of report.performance.comparison) {
          if (c.baselineP95 === null) continue;
          const status = c.degraded ? '❌ 退化' : '✅ 正常';
          lines.push(
            `| ${c.endpoint} | ${c.baselineP95?.toFixed(2) || '-'}ms | ` +
            `${c.currentP95?.toFixed(2) || '-'}ms | ${c.latencyChange}% | ${status} |`
          );
        }
      }
      lines.push('');
    }

    // 文档一致性部分
    if (report.consistencyIssues.length > 0) {
      lines.push('## OpenAPI 文档一致性', '');
      lines.push('| 严重级别 | 类型 | 路径 | 方法 | 消息 |');
      lines.push('|----------|------|------|------|------|');

      for (const issue of report.consistencyIssues) {
        const severityIcon = issue.severity === 'error' ? '❌' : 
                            issue.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(
          `| ${severityIcon} ${issue.severity} | ${issue.type} | ` +
          `${issue.path} | ${issue.method?.toUpperCase() || '-'} | ${issue.message} |`
        );
      }
      lines.push('');
    }

    // 建议部分
    if (report.recommendations.length > 0) {
      lines.push('## 修复建议', '');
      
      for (const rec of report.recommendations) {
        const priorityIcon = rec.priority === 'high' ? '🔴' : 
                             rec.priority === 'medium' ? '🟡' : '🟢';
        lines.push(`### ${priorityIcon} ${rec.category} (${rec.priority})`, '');
        lines.push(rec.message);
        
        if (rec.actions) {
          for (const action of rec.actions) {
            lines.push(action);
          }
        }
        
        if (rec.affectedEndpoints) {
          lines.push('', '**受影响接口**:');
          for (const endpoint of rec.affectedEndpoints) {
            lines.push(`- ${endpoint}`);
          }
        }
        lines.push('');
      }
    }

    // 环境信息
    if (report.performance?.environment) {
      lines.push('## 测试环境', '');
      lines.push(`- Node.js: ${report.performance.environment.node}`);
      lines.push(`- Platform: ${report.performance.environment.platform}`);
      lines.push(`- CPUs: ${report.performance.environment.cpus}`);
    }

    return lines.join('\n');
  }

  /**
   * 发送报告通知
   */
  async sendNotification(report, options = {}) {
    const { webhook, email } = options;

    if (!report.summary.passed) {
      // 发送告警
      if (webhook) {
        await this.sendWebhookNotification(webhook, report);
      }

      if (email) {
        await this.sendEmailNotification(email, report);
      }
    }

    // 记录到日志
    console.log('回归测试报告:', {
      passed: report.summary.passed,
      critical: report.summary.criticalIssues,
      timestamp: report.timestamp,
    });
  }

  /**
   * 发送 Webhook 通知
   */
  async sendWebhookNotification(webhookUrl, report) {
    try {
      const payload = {
        type: 'regression_test_alert',
        passed: report.summary.passed,
        critical: report.summary.criticalIssues,
        timestamp: report.timestamp,
        url: report.markdownPath,
      };

      // 实际实现需要使用 fetch 或 axios
      console.log('Webhook 通知:', webhookUrl, payload);
    } catch (error) {
      console.error('发送 webhook 失败:', error);
    }
  }

  /**
   * 发送邮件通知
   */
  async sendEmailNotification(emailConfig, report) {
    // 需要邮件服务配置
    console.log('邮件通知:', emailConfig, {
      subject: `API 回归测试报告 - ${report.summary.passed ? '通过' : '未通过'}`,
      critical: report.summary.criticalIssues,
    });
  }
}

module.exports = RegressionReportGenerator;