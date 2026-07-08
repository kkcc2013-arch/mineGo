/**
 * Performance Report Generator Job
 * REQ-00502: 性能分析与深度优化框架设计
 * 
 * 定时任务：每日自动生成性能分析报告
 */

const cron = require('node-cron');
const { getPerformanceSampler } = require('../shared/PerformanceSampler');
const { PerformanceAnalyzer } = require('../shared/PerformanceAnalyzer');
const fs = require('fs').promises;

class PerformanceReportGenerator {
  constructor(options = {}) {
    this.sampler = getPerformanceSampler();
    this.analyzer = new PerformanceAnalyzer({
      storageDir: options.storageDir || '/tmp/perf-reports'
    });
    this.cronSchedule = options.cronSchedule || '0 6 * * *'; // 每天早上 6 点
    this.notifyWebhook = options.notifyWebhook || null;
    this.task = null;
  }

  /**
   * 启动定时任务
   */
  start() {
    if (this.task) {
      console.log('Performance report generator is already running');
      return;
    }

    this.task = cron.schedule(this.cronSchedule, async () => {
      console.log('[PerformanceReportGenerator] Starting daily report generation...');
      await this.generateDailyReport();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    console.log(`Performance report generator started, schedule: ${this.cronSchedule}`);
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('Performance report generator stopped');
    }
  }

  /**
   * 生成每日报告
   */
  async generateDailyReport() {
    try {
      // 1. 从采样器获取报告
      const samplerReport = this.sampler.generateReport();
      
      // 2. 深度分析样本
      const analysisResults = this.analyzer.analyzeSamples(this.sampler.samples);
      
      // 3. 获取趋势分析
      const trend = await this.analyzer.analyzeTrend(7);
      
      // 4. 组装完整报告
      const fullReport = {
        generatedAt: new Date().toISOString(),
        reportType: 'daily',
        summary: {
          totalRequests: samplerReport.stats.totalRequests,
          sampledRequests: samplerReport.stats.sampledRequests,
          actualSamplingRate: samplerReport.stats.actualSamplingRate,
          avgProcessingTimeMs: samplerReport.stats.avgProcessingTimeMs,
          avgDbTimeMs: samplerReport.stats.avgDbTimeMs,
          avgCacheTimeMs: samplerReport.stats.avgCacheTimeMs,
          avgApiTimeMs: samplerReport.stats.avgApiTimeMs
        },
        hotspots: samplerReport.hotspots.slice(0, 10),
        slowOperations: samplerReport.topSlowOperations,
        analysis: analysisResults,
        trend,
        recommendations: samplerReport.recommendations
      };

      // 5. 保存报告
      const filepath = await this.analyzer.saveReport(fullReport);
      console.log(`[PerformanceReportGenerator] Report saved to: ${filepath}`);

      // 6. 发送通知
      if (this.notifyWebhook) {
        await this.sendNotification(fullReport);
      }

      // 7. 重置采样器统计（新的一天重新开始）
      this.sampler.resetStats();

      return fullReport;
    } catch (error) {
      console.error('[PerformanceReportGenerator] Failed to generate report:', error);
      throw error;
    }
  }

  /**
   * 发送通知
   */
  async sendNotification(report) {
    try {
      const message = this.formatSlackMessage(report);
      
      const response = await fetch(this.notifyWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status}`);
      }

      console.log('[PerformanceReportGenerator] Notification sent successfully');
    } catch (error) {
      console.error('[PerformanceReportGenerator] Failed to send notification:', error);
    }
  }

  /**
   * 格式化 Slack 消息
   */
  formatSlackMessage(report) {
    const color = report.trend.trendDirection === 'improving' ? 'good' : 'warning';
    
    return {
      text: '📊 每日性能分析报告',
      attachments: [{
        color,
        title: '性能概览',
        fields: [
          {
            title: '总请求数',
            value: report.summary.totalRequests.toLocaleString(),
            short: true
          },
          {
            title: '采样率',
            value: report.summary.actualSamplingRate,
            short: true
          },
          {
            title: '平均响应时间',
            value: `${report.summary.avgProcessingTimeMs}ms`,
            short: true
          },
          {
            title: '趋势',
            value: report.trend.trendDirection === 'improving' ? '📈 改善中' : '📉 需关注',
            short: true
          }
        ]
      }, {
        color: 'warning',
        title: '性能热点 Top 5',
        fields: report.hotspots.slice(0, 5).map(h => ({
          title: h.endpoint,
          value: `${h.avgMs}ms (${h.bottleneckType})`,
          short: true
        }))
      }, {
        color: '#439FE0',
        title: '优化建议',
        text: report.recommendations.slice(0, 3).map((r, i) => 
          `${i + 1}. **${r.issue}**\n   - ${r.suggestions.slice(0, 2).join('\n   - ')}`
        ).join('\n\n')
      }]
    };
  }

  /**
   * 手动触发报告生成
   */
  async triggerManualReport() {
    console.log('[PerformanceReportGenerator] Manual report generation triggered');
    return await this.generateDailyReport();
  }
}

// 单例
let instance = null;

function getPerformanceReportGenerator(options = {}) {
  if (!instance) {
    instance = new PerformanceReportGenerator(options);
  }
  return instance;
}

module.exports = {
  PerformanceReportGenerator,
  getPerformanceReportGenerator
};