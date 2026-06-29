// backend/jobs/indexOptimizationJob.js
'use strict';

const { IndexOptimizerManager } = require('../shared/indexOptimizer/IndexOptimizerManager');
const { getPool } = require('../shared/db');
const { createLogger } = require('../shared/logger');

const logger = createLogger('index-optimization-job');

/**
 * 索引优化定时任务
 */
class IndexOptimizationJob {
  constructor(config) {
    this.config = {
      dryRun: config.dryRun !== false,
      slowQueryThreshold: config.slowQueryThreshold || 500,
      executionWindow: config.executionWindow || { start: 2, end: 6 },
      notificationWebhook: config.notificationWebhook,
      reportOutputPath: config.reportOutputPath || './reports/index-optimization-report.json'
    };
    this.manager = null;
  }

  /**
   * 运行任务
   */
  async run() {
    logger.info('开始索引优化任务...');
    
    try {
      const pool = await getPool();
      
      this.manager = new IndexOptimizerManager({
        pool,
        dryRun: this.config.dryRun,
        slowQueryThreshold: this.config.slowQueryThreshold,
        executionWindow: this.config.executionWindow,
        notificationWebhook: this.config.notificationWebhook,
        collectionInterval: 0 // 单次执行，不启用定时收集
      });
      
      // 初始化
      await this.manager.initialize();
      
      // 执行完整优化流程
      const result = await this.manager.runFullOptimization();
      
      // 生成报告
      const report = {
        timestamp: new Date().toISOString(),
        summary: this.manager.getStatusSummary(),
        healthReport: result.healthReport,
        recommendations: result.recommendations.slice(0, 50), // 限制报告大小
        executionResults: result.executionResults,
        config: this.config
      };
      
      logger.info({
        slowQueries: report.summary.slowQueries.total,
        healthIssues: report.summary.health?.issuesFound || 0,
        recommendations: report.summary.recommendations.total,
        executed: report.executionResults.executed
      }, '索引优化任务完成');
      
      // 停止管理器
      this.manager.stop();
      
      return report;
      
    } catch (error) {
      logger.error({ error: error.message }, '索引优化任务失败');
      
      if (this.manager) {
        this.manager.stop();
      }
      
      throw error;
    }
  }
}

// CLI 入口
async function main() {
  const config = {
    dryRun: process.env.INDEX_OPT_DRY_RUN !== 'false',
    slowQueryThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 500,
    executionWindow: {
      start: parseInt(process.env.INDEX_OPT_WINDOW_START) || 2,
      end: parseInt(process.env.INDEX_OPT_WINDOW_END) || 6
    },
    notificationWebhook: process.env.INDEX_OPT_WEBHOOK,
    reportOutputPath: process.env.INDEX_OPT_REPORT_PATH || './reports/index-optimization-report.json'
  };
  
  const job = new IndexOptimizationJob(config);
  
  try {
    const result = await job.run();
    
    // 输出报告
    console.log(JSON.stringify(result, null, 2));
    
    // 写入文件
    if (config.reportOutputPath) {
      const fs = require('fs');
      const path = require('path');
      
      const reportDir = path.dirname(config.reportOutputPath);
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
      }
      
      fs.writeFileSync(config.reportOutputPath, JSON.stringify(result, null, 2));
      logger.info({ path: config.reportOutputPath }, '报告已写入文件');
    }
    
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// 定时调度入口（用于后台运行）
function scheduleJob(intervalMinutes = 60) {
  const config = {
    dryRun: process.env.INDEX_OPT_DRY_RUN !== 'false',
    slowQueryThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 500,
    executionWindow: {
      start: parseInt(process.env.INDEX_OPT_WINDOW_START) || 2,
      end: parseInt(process.env.INDEX_OPT_WINDOW_END) || 6
    },
    notificationWebhook: process.env.INDEX_OPT_WEBHOOK
  };
  
  const job = new IndexOptimizationJob(config);
  
  // 立即执行一次
  job.run().catch(logger.error);
  
  // 定时执行
  const timer = setInterval(() => {
    job.run().catch(logger.error);
  }, intervalMinutes * 60 * 1000);
  
  logger.info({ intervalMinutes }, '索引优化定时任务已启动');
  
  // 优雅关闭
  process.on('SIGTERM', () => {
    clearInterval(timer);
    job.manager?.stop();
    process.exit(0);
  });
  
  return job;
}

if (require.main === module) {
  // 判断是单次执行还是定时运行
  if (process.argv.includes('--schedule')) {
    const interval = parseInt(process.argv[3]) || 60;
    scheduleJob(interval);
  } else {
    main();
  }
}

module.exports = { IndexOptimizationJob, scheduleJob };