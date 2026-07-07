// jobs/indexMaintenanceJob.js - Automated Index Maintenance Job
'use strict';

const { createLogger } = require('../shared/logger');
const { indexMonitor, collectIndexStats, generateReport } = require('../shared/indexUsageMonitor');
const { query } = require('../shared/db');
const { getRedis, getJSON, setJSON, publish } = require('../shared/redis');
const nodemailer = require('nodemailer');

const logger = createLogger('index-maintenance-job');

// Job configuration
const JOB_CONFIG = {
  schedule: '0 2 * * 0', // Every Sunday at 2 AM
  enabled: process.env.INDEX_MAINTENANCE_ENABLED !== 'false',
  dryRun: process.env.INDEX_MAINTENANCE_DRY_RUN === 'true',
  autoRemoveCritical: process.env.INDEX_AUTO_REMOVE_CRITICAL === 'true',
  notificationEmail: process.env.INDEX_MAINTENANCE_EMAIL || 'dba@example.com',
  slackWebhook: process.env.INDEX_MAINTENANCE_SLACK_WEBHOOK
};

// Maintenance actions
const ACTIONS = {
  COLLECT_STATS: 'collect_stats',
  ANALYZE: 'analyze',
  GENERATE_REPORT: 'generate_report',
  REMOVE_UNUSED: 'remove_unused',
  CREATE_RECOMMENDED: 'create_recommended',
  CLEANUP: 'cleanup'
};

class IndexMaintenanceJob {
  constructor() {
    this.redis = null;
    this.transporter = null;
    this.running = false;
    this.lastRunTime = null;
    this.stats = {
      runs: 0,
      indexesAnalyzed: 0,
      indexesRemoved: 0,
      indexesCreated: 0,
      spaceSaved: 0,
      errors: 0
    };
  }

  /**
   * Get Redis instance (lazy initialization)
   */
  getRedis() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this.redis;
  }

  /**
   * Get email transporter (lazy initialization)
   */
  getTransporter() {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'localhost',
        port: parseInt(process.env.SMTP_PORT) || 25,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        } : undefined
      });
    }
    return this.transporter;
  }

  /**
   * Main execution entry point
   */
  async run(action = null) {
    if (this.running) {
      logger.warn('Index maintenance job already running');
      return { status: 'skipped', reason: 'already_running' };
    }

    if (!JOB_CONFIG.enabled) {
      logger.info('Index maintenance job is disabled');
      return { status: 'disabled' };
    }

    this.running = true;
    const startTime = Date.now();
    const runId = `idx-maint-${Date.now()}`;

    logger.info({ runId, action, dryRun: JOB_CONFIG.dryRun }, 'Starting index maintenance job');

    try {
      let result;

      switch (action) {
        case ACTIONS.COLLECT_STATS:
          result = await this.collectStats();
          break;
        case ACTIONS.ANALYZE:
          result = await this.analyzeIndexes();
          break;
        case ACTIONS.GENERATE_REPORT:
          result = await this.generateAndSendReport();
          break;
        case ACTIONS.REMOVE_UNUSED:
          result = await this.removeUnusedIndexes();
          break;
        case ACTIONS.CREATE_RECOMMENDED:
          result = await this.createRecommendedIndexes();
          break;
        case ACTIONS.CLEANUP:
          result = await this.cleanupHistoricalData();
          break;
        default:
          // Run full maintenance cycle
          result = await this.runFullCycle();
      }

      const duration = Date.now() - startTime;
      this.lastRunTime = new Date().toISOString();
      this.stats.runs++;

      logger.info({
        runId,
        duration,
        result: result.status,
        indexesAnalyzed: result.indexesAnalyzed || 0,
        indexesRemoved: result.indexesRemoved || 0
      }, 'Index maintenance job completed');

      // Publish completion event
      await this.publishCompletionEvent(result, duration);

      return result;

    } catch (error) {
      this.stats.errors++;
      logger.error({ error: error.message, stack: error.stack }, 'Index maintenance job failed');
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Run full maintenance cycle
   */
  async runFullCycle() {
    logger.info('Running full index maintenance cycle');

    const results = {
      status: 'completed',
      steps: []
    };

    // Step 1: Collect stats
    const statsResult = await this.collectStats();
    results.steps.push({ step: 'collect_stats', result: statsResult });
    this.stats.indexesAnalyzed = statsResult.totalIndexes || 0;

    // Step 2: Analyze indexes
    const analyzeResult = await this.analyzeIndexes();
    results.steps.push({ step: 'analyze', result: analyzeResult });

    // Step 3: Remove unused (if enabled)
    if (JOB_CONFIG.autoRemoveCritical) {
      const removeResult = await this.removeUnusedIndexes();
      results.steps.push({ step: 'remove_unused', result: removeResult });
      this.stats.indexesRemoved = removeResult.removed || 0;
      this.stats.spaceSaved = removeResult.spaceSaved || 0;
    }

    // Step 4: Generate and send report
    const reportResult = await this.generateAndSendReport();
    results.steps.push({ step: 'generate_report', result: reportResult });

    // Step 5: Cleanup old data
    const cleanupResult = await this.cleanupHistoricalData();
    results.steps.push({ step: 'cleanup', result: cleanupResult });

    results.indexesAnalyzed = this.stats.indexesAnalyzed;
    results.indexesRemoved = this.stats.indexesRemoved;

    return results;
  }

  /**
   * Collect index statistics
   */
  async collectStats() {
    logger.info('Collecting index statistics');

    try {
      const stats = await collectIndexStats();

      return {
        status: 'success',
        totalIndexes: stats?.total || 0,
        unusedCount: stats?.unused?.length || 0,
        lowUsageCount: stats?.lowUsage?.length || 0,
        duplicateCount: stats?.duplicates?.length || 0,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to collect index stats');
      throw error;
    }
  }

  /**
   * Analyze indexes and generate recommendations
   */
  async analyzeIndexes() {
    logger.info('Analyzing indexes');

    try {
      const report = await generateReport();

      // Store analysis results
      const redis = this.getRedis();
      const analysisKey = `index:analysis:${Date.now()}`;
      await setJSON(analysisKey, {
        timestamp: new Date().toISOString(),
        recommendations: report.recommendations,
        summary: report.summary
      }, 7 * 24 * 3600); // Keep for 7 days

      // Count high priority recommendations
      const highPriorityCount = report.recommendations.filter(r => r.priority === 'HIGH').length;

      return {
        status: 'success',
        recommendationCount: report.recommendations.length,
        highPriorityCount,
        summary: report.summary
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to analyze indexes');
      throw error;
    }
  }

  /**
   * Remove unused indexes (only safe ones)
   */
  async removeUnusedIndexes() {
    logger.info({ dryRun: JOB_CONFIG.dryRun }, 'Removing unused indexes');

    const result = {
      status: 'success',
      removed: 0,
      failed: 0,
      spaceSaved: 0,
      actions: []
    };

    try {
      const report = await generateReport();

      // Only remove indexes with CRITICAL risk level and explicit DROP recommendation
      const toRemove = report.recommendations.filter(r =>
        r.priority === 'HIGH' &&
        r.type === 'REMOVE_INDEX' &&
        r.sql &&
        !r.index.includes('_pkey') &&
        !r.index.includes('_fk')
      );

      for (const item of toRemove) {
        try {
          if (!JOB_CONFIG.dryRun) {
            // Use CONCURRENTLY to avoid locking
            await query(item.sql);

            result.removed++;
            result.spaceSaved += parseInt(item.reason.match(/(\d+)/)?.[0] || 0);

            result.actions.push({
              index: item.index,
              table: item.table,
              sql: item.sql,
              status: 'removed'
            });

            logger.info({
              index: item.index,
              table: item.table
            }, 'Successfully removed unused index');
          } else {
            result.actions.push({
              index: item.index,
              table: item.table,
              sql: item.sql,
              status: 'dry_run_would_remove'
            });
          }
        } catch (error) {
          result.failed++;
          result.actions.push({
            index: item.index,
            table: item.table,
            error: error.message,
            status: 'failed'
          });

          logger.error({
            index: item.index,
            error: error.message
          }, 'Failed to remove index');
        }
      }

      // Record in history
      await this.recordMaintenanceHistory('remove_unused', result);

      return result;

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to remove unused indexes');
      throw error;
    }
  }

  /**
   * Create recommended indexes (requires approval)
   */
  async createRecommendedIndexes() {
    logger.info('Creating recommended indexes (requires approval)');

    // This is a placeholder for creating new indexes
    // In production, this would integrate with a change management system

    const result = {
      status: 'pending_approval',
      message: 'Index creation requires manual approval. Check index recommendations.',
      pendingIndexes: []
    };

    try {
      const stats = await indexMonitor.getLatestStats();

      if (stats?.stats?.lowUsage) {
        // Find tables that might benefit from new indexes
        // This is a simplified example
        result.pendingIndexes = stats.stats.lowUsage
          .filter(idx => idx.scanReadRatio > 10)
          .map(idx => ({
            table: idx.table,
            suggestion: `Consider adding index on frequently queried columns`
          }));
      }

      return result;

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create recommended indexes');
      throw error;
    }
  }

  /**
   * Generate and send report
   */
  async generateAndSendReport() {
    logger.info('Generating and sending maintenance report');

    try {
      const report = await generateReport();

      // Send email notification
      await this.sendEmailReport(report);

      // Send Slack notification if configured
      if (JOB_CONFIG.slackWebhook) {
        await this.sendSlackNotification(report);
      }

      return {
        status: 'success',
        emailSent: true,
        slackSent: !!JOB_CONFIG.slackWebhook,
        recommendationCount: report.recommendations.length
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to send report');
      return {
        status: 'partial_success',
        error: error.message
      };
    }
  }

  /**
   * Send email report
   */
  async sendEmailReport(report) {
    const transporter = this.getTransporter();

    const emailContent = this.formatEmailContent(report);

    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@minego.local',
      to: JOB_CONFIG.notificationEmail,
      subject: `[mineGo] Index Maintenance Report - ${new Date().toISOString().split('T')[0]}`,
      html: emailContent
    };

    try {
      await transporter.sendMail(mailOptions);
      logger.info({ to: JOB_CONFIG.notificationEmail }, 'Email report sent');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to send email report');
      throw error;
    }
  }

  /**
   * Format email content
   */
  formatEmailContent(report) {
    const highPriority = report.recommendations.filter(r => r.priority === 'HIGH');
    const mediumPriority = report.recommendations.filter(r => r.priority === 'MEDIUM');

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    h1 { color: #2c3e50; }
    h2 { color: #34495e; margin-top: 30px; }
    .summary { background: #ecf0f1; padding: 15px; border-radius: 5px; }
    .high-priority { background: #fee; border-left: 4px solid #e74c3c; padding: 10px; margin: 10px 0; }
    .medium-priority { background: #fff9e6; border-left: 4px solid #f39c12; padding: 10px; margin: 10px 0; }
    .sql { background: #f4f4f4; padding: 10px; font-family: monospace; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #3498db; color: white; }
    .metric { font-size: 2em; font-weight: bold; color: #2980b9; }
  </style>
</head>
<body>
  <h1>📊 mineGo Index Maintenance Report</h1>
  <p>Generated: ${new Date().toISOString()}</p>

  <div class="summary">
    <h2>Summary</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Indexes</td><td>${report.summary?.totalIndexes || 0}</td></tr>
      <tr><td>Total Size</td><td>${report.summary?.totalSize || 'N/A'}</td></tr>
      <tr><td>Unused Indexes</td><td>${report.summary?.unusedCount || 0}</td></tr>
      <tr><td>Potential Savings</td><td>${report.summary?.potentialSavings || '0 MB'}</td></tr>
      <tr><td>High Priority Actions</td><td>${highPriority.length}</td></tr>
    </table>
  </div>

  ${highPriority.length > 0 ? `
    <h2>🔴 High Priority Actions</h2>
    ${highPriority.map(r => `
      <div class="high-priority">
        <strong>${r.type}</strong>: ${r.index} on ${r.table}<br>
        Reason: ${r.reason}<br>
        ${r.sql ? `<div class="sql">${r.sql}</div>` : ''}
      </div>
    `).join('')}
  ` : ''}

  ${mediumPriority.length > 0 ? `
    <h2>🟡 Medium Priority Actions</h2>
    ${mediumPriority.map(r => `
      <div class="medium-priority">
        <strong>${r.type}</strong>: ${r.index || r.indexes?.join(', ')}<br>
        Reason: ${r.reason}
      </div>
    `).join('')}
  ` : ''}

  <h2>📈 Risk Distribution</h2>
  <table>
    <tr><th>Level</th><th>Count</th></tr>
    ${Object.entries(report.summary?.distributionByRisk || {}).map(([level, count]) =>
      `<tr><td>${level}</td><td>${count}</td></tr>`
    ).join('')}
  </table>

  <hr>
  <p><em>This is an automated report from mineGo Index Maintenance System.</em></p>
</body>
</html>
    `.trim();
  }

  /**
   * Send Slack notification
   */
  async sendSlackNotification(report) {
    const highPriority = report.recommendations.filter(r => r.priority === 'HIGH');

    const payload = {
      text: `📊 Index Maintenance Report`,
      attachments: [{
        color: highPriority.length > 0 ? 'danger' : 'good',
        fields: [
          {
            title: 'Total Indexes',
            value: report.summary?.totalIndexes || 0,
            short: true
          },
          {
            title: 'Unused',
            value: report.summary?.unusedCount || 0,
            short: true
          },
          {
            title: 'Potential Savings',
            value: report.summary?.potentialSavings || '0 MB',
            short: true
          },
          {
            title: 'High Priority',
            value: highPriority.length,
            short: true
          }
        ],
        footer: `mineGo Database | ${new Date().toISOString()}`,
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    try {
      const response = await fetch(JOB_CONFIG.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.status}`);
      }

      logger.info('Slack notification sent');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to send Slack notification');
    }
  }

  /**
   * Cleanup historical data
   */
  async cleanupHistoricalData() {
    logger.info('Cleaning up historical index data');

    const redis = this.getRedis();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90); // Keep 90 days

    let deleted = 0;

    try {
      // Cleanup analysis history
      const analysisPattern = 'index:analysis:*';
      const analysisKeys = await redis.keys(analysisPattern);

      for (const key of analysisKeys) {
        const timestamp = parseInt(key.split(':').pop());
        if (timestamp < cutoffDate.getTime()) {
          await redis.del(key);
          deleted++;
        }
      }

      // Cleanup maintenance history
      const historyPattern = 'index:maintenance:history:*';
      const historyKeys = await redis.keys(historyPattern);

      for (const key of historyKeys) {
        const dateStr = key.split(':').pop();
        const keyDate = new Date(dateStr);
        if (keyDate < cutoffDate) {
          await redis.del(key);
          deleted++;
        }
      }

      logger.info({ deleted }, 'Historical data cleanup completed');

      return {
        status: 'success',
        keysDeleted: deleted
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to cleanup historical data');
      throw error;
    }
  }

  /**
   * Record maintenance history
   */
  async recordMaintenanceHistory(action, result) {
    const redis = this.getRedis();
    const date = new Date().toISOString().split('T')[0];
    const key = `index:maintenance:history:${date}`;

    try {
      const existing = await getJSON(key) || { date, actions: [] };
      existing.actions.push({
        action,
        timestamp: new Date().toISOString(),
        result: {
          status: result.status,
          removed: result.removed,
          failed: result.failed
        }
      });

      await setJSON(key, existing, 90 * 24 * 3600); // Keep for 90 days
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to record maintenance history');
    }
  }

  /**
   * Publish completion event
   */
  async publishCompletionEvent(result, duration) {
    try {
      await publish('index:maintenance:completed', {
        timestamp: new Date().toISOString(),
        duration,
        status: result.status,
        indexesAnalyzed: result.indexesAnalyzed || 0,
        indexesRemoved: result.indexesRemoved || 0
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to publish completion event');
    }
  }

  /**
   * Get job statistics
   */
  getStats() {
    return {
      ...this.stats,
      lastRunTime: this.lastRunTime,
      config: {
        enabled: JOB_CONFIG.enabled,
        dryRun: JOB_CONFIG.dryRun,
        autoRemoveCritical: JOB_CONFIG.autoRemoveCritical,
        schedule: JOB_CONFIG.schedule
      }
    };
  }
}

// Export singleton instance
const indexMaintenanceJob = new IndexMaintenanceJob();

module.exports = {
  IndexMaintenanceJob,
  indexMaintenanceJob,
  run: (action) => indexMaintenanceJob.run(action),
  getStats: () => indexMaintenanceJob.getStats(),
  JOB_CONFIG,
  ACTIONS
};
