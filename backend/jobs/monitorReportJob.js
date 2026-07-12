/**
 * backend/jobs/monitorReportJob.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 定时报告任务
 */

'use strict';

const { MonitorReportSystem } = require('../shared/monitorReport');
const { createLogger } = require('../shared/logger');
const { query } = require('../shared/db');
const axios = require('axios');

const logger = createLogger('monitor-report-job');

/**
 * 监控报告定时任务
 */
class MonitorReportJob {
  constructor(config = {}) {
    this.reportSystem = new MonitorReportSystem(config);
    this.webhookUrl = config.webhookUrl || process.env.MONITOR_REPORT_WEBHOOK;
    this.emailRecipients = config.emailRecipients || [];
    this.adminDashboardUrl = config.adminDashboardUrl || 'http://admin-dashboard:8080';
  }

  /**
   * 生成每日监控报告
   */
  async generateDailyReport() {
    logger.info('Starting daily monitor report generation');
    
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 最近 24 小时
      
      // 获取昨天的数据用于对比
      const previousStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      const previousEnd = start;
      
      let previousData = null;
      try {
        previousData = await this.loadHistoricalData(previousStart, previousEnd);
      } catch (error) {
        logger.warn('Failed to load previous data for comparison', { error: error.message });
      }
      
      // 生成报告
      const result = await this.reportSystem.generateReport(
        'daily',
        { start, end: now },
        previousData,
        'markdown'
      );
      
      // 保存报告
      const reportId = await this.saveReport('daily', result);
      
      // 发送通知
      await this.sendNotifications('daily', result, reportId);
      
      // 推送到管理后台
      await this.pushToDashboard('daily', result);
      
      logger.info('Daily monitor report generated successfully', { reportId });
      
      return {
        success: true,
        reportId,
        healthScore: result.summary.healthScore,
        overallStatus: result.summary.overallStatus
      };
    } catch (error) {
      logger.error('Failed to generate daily monitor report', { error: error.message });
      throw error;
    }
  }

  /**
   * 生成每周监控报告
   */
  async generateWeeklyReport() {
    logger.info('Starting weekly monitor report generation');
    
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 最近 7 天
      
      // 生成报告
      const result = await this.reportSystem.generateReport(
        'weekly',
        { start, end: now },
        null,
        'html'
      );
      
      // 保存报告
      const reportId = await this.saveReport('weekly', result);
      
      // 发送通知
      await this.sendNotifications('weekly', result, reportId);
      
      // 推送到管理后台
      await this.pushToDashboard('weekly', result);
      
      logger.info('Weekly monitor report generated successfully', { reportId });
      
      return {
        success: true,
        reportId,
        healthScore: result.summary.healthScore
      };
    } catch (error) {
      logger.error('Failed to generate weekly monitor report', { error: error.message });
      throw error;
    }
  }

  /**
   * 生成异常事件报告
   */
  async generateIncidentReport(incident) {
    logger.info('Starting incident report generation', { incidentType: incident.type });
    
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 最近 1 小时
      
      // 生成报告
      const result = await this.reportSystem.generateReport(
        'incident',
        { start, end: now },
        null,
        'markdown'
      );
      
      // 添加事件详情
      result.incident = incident;
      
      // 保存报告
      const reportId = await this.saveReport('incident', result);
      
      // 发送紧急通知
      await this.sendUrgentNotification('incident', result, reportId, incident);
      
      logger.info('Incident report generated successfully', { reportId });
      
      return {
        success: true,
        reportId
      };
    } catch (error) {
      logger.error('Failed to generate incident report', { error: error.message });
      throw error;
    }
  }

  /**
   * 加载历史数据
   */
  async loadHistoricalData(start, end) {
    try {
      const result = await query(`
        SELECT data
        FROM monitor_reports
        WHERE report_type = 'daily'
          AND created_at >= $1
          AND created_at <= $2
        ORDER BY created_at DESC
        LIMIT 1
      `, [start, end]);
      
      if (result.rows.length > 0) {
        return JSON.parse(result.rows[0].data);
      }
      
      return null;
    } catch (error) {
      logger.warn('Failed to load historical data', { error: error.message });
      return null;
    }
  }

  /**
   * 保存报告到数据库
   */
  async saveReport(reportType, result) {
    try {
      const queryResult = await query(`
        INSERT INTO monitor_reports (report_type, health_score, overall_status, summary, data, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING id
      `, [
        reportType,
        result.summary.healthScore,
        result.summary.overallStatus,
        JSON.stringify(result.summary),
        JSON.stringify(result.rawData)
      ]);
      
      return queryResult.rows[0].id;
    } catch (error) {
      logger.error('Failed to save report', { error: error.message });
      throw error;
    }
  }

  /**
   * 发送通知
   */
  async sendNotifications(reportType, result, reportId) {
    const summary = result.summary;
    
    // 发送到 Slack/钉钉/企业微信
    if (this.webhookUrl) {
      try {
        const message = this.formatWebhookMessage(reportType, summary, reportId);
        await axios.post(this.webhookUrl, message);
        logger.info('Webhook notification sent', { reportId });
      } catch (error) {
        logger.warn('Failed to send webhook notification', { error: error.message });
      }
    }
    
    // 发送邮件
    if (this.emailRecipients.length > 0) {
      try {
        // TODO: 集成邮件服务
        logger.info('Email notification would be sent', { recipients: this.emailRecipients.length });
      } catch (error) {
        logger.warn('Failed to send email notification', { error: error.message });
      }
    }
  }

  /**
   * 发送紧急通知
   */
  async sendUrgentNotification(reportType, result, reportId, incident) {
    // 紧急通知会重复发送到所有渠道
    if (this.webhookUrl) {
      try {
        const message = {
          text: `🚨 紧急：${incident.message}`,
          attachments: [
            {
              color: 'danger',
              title: '异常事件报告',
              fields: [
                { title: '事件类型', value: incident.type, short: true },
                { title: '健康评分', value: `${result.summary.healthScore}/100`, short: true },
                { title: '时间', value: new Date().toISOString(), short: false }
              ]
            }
          ]
        };
        
        await axios.post(this.webhookUrl, message);
        logger.info('Urgent webhook notification sent', { reportId });
      } catch (error) {
        logger.error('Failed to send urgent webhook notification', { error: error.message });
      }
    }
  }

  /**
   * 推送到管理后台
   */
  async pushToDashboard(reportType, result) {
    try {
      await axios.post(`${this.adminDashboardUrl}/api/monitor-reports`, {
        reportType,
        healthScore: result.summary.healthScore,
        overallStatus: result.summary.overallStatus,
        summary: result.summary,
        timestamp: new Date().toISOString()
      });
      
      logger.info('Report pushed to dashboard', { reportType });
    } catch (error) {
      logger.warn('Failed to push report to dashboard', { error: error.message });
    }
  }

  /**
   * 格式化 Webhook 消息
   */
  formatWebhookMessage(reportType, summary, reportId) {
    const color = summary.overallStatus === 'healthy' ? 'good' : 
                  summary.overallStatus === 'warning' ? 'warning' : 'danger';
    
    const title = {
      daily: '📊 每日监控摘要',
      weekly: '📈 每周监控深度报告',
      incident: '🚨 异常事件报告'
    }[reportType] || '📊 监控报告';
    
    return {
      text: title,
      attachments: [
        {
          color,
          fields: [
            { title: '健康评分', value: `${summary.healthScore}/100`, short: true },
            { title: '整体状态', value: summary.overallStatus.toUpperCase(), short: true },
            { title: '服务健康', value: `✅ ${summary.serviceSummary.healthy} / ⚠️ ${summary.serviceSummary.warning} / 🚨 ${summary.serviceSummary.critical}`, short: false },
            { title: '关键问题', value: summary.criticalIssues.length.toString(), short: true },
            { title: '警告', value: summary.warnings.length.toString(), short: true }
          ],
          footer: `报告编号: ${reportId} | 生成时间: ${new Date().toISOString()}`
        }
      ]
    };
  }
}

/**
 * 任务入口
 */
async function run() {
  const job = new MonitorReportJob();
  
  const args = process.argv.slice(2);
  const reportType = args[0] || 'daily';
  
  let result;
  
  switch (reportType) {
    case 'daily':
      result = await job.generateDailyReport();
      break;
    case 'weekly':
      result = await job.generateWeeklyReport();
      break;
    default:
      throw new Error(`Unknown report type: ${reportType}`);
  }
  
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// 如果直接运行此脚本
if (require.main === module) {
  run().catch(error => {
    console.error('Job failed:', error);
    process.exit(1);
  });
}

module.exports = MonitorReportJob;