#!/usr/bin/env node

/**
 * 智能调度器启动脚本
 */

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const IntelligentScheduler = require('./index');
const logger = require('../../shared/logger');

// 加载配置
const configPath = path.join(__dirname, '../../config/intelligent-scheduler.yaml');
let config = {};

try {
  const configFile = fs.readFileSync(configPath, 'utf8');
  config = yaml.load(configFile);
  logger.info('Configuration loaded', { path: configPath });
} catch (error) {
  logger.warn('Failed to load config file, using defaults', { error: error.message });
  config = {
    scheduler: {
      enabled: true,
      schedulingInterval: 60000,
      predictionAccuracyThreshold: 0.85
    },
    scaling: {
      minReplicas: 2,
      maxReplicas: 50,
      scalingCooldown: 300000,
      proactiveScalingWindow: 900000
    }
  };
}

// 创建调度器实例
const scheduler = new IntelligentScheduler({
  ...config.scheduler,
  ...config.scaling,
  ...config.trafficAnalysis
});

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  await scheduler.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  await scheduler.stop();
  process.exit(0);
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});

// 启动调度器
async function main() {
  try {
    logger.info('Starting Intelligent Scheduler...');
    await scheduler.start();
    logger.info('Intelligent Scheduler started successfully');

    // 定期健康检查
    setInterval(async () => {
      const health = await scheduler.healthCheck();
      logger.info('Health check', { status: health.status });
    }, 60000);

    // 定期状态报告
    setInterval(async () => {
      const status = scheduler.getStatus();
      logger.info('Scheduler status', {
        isRunning: status.isRunning,
        totalCycles: status.stats.totalSchedulingCycles,
        successfulScalings: status.stats.successfulScalings
      });
    }, 300000);  // 每5分钟

  } catch (error) {
    logger.error('Failed to start Intelligent Scheduler', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// 启动
main();

// 导出供测试使用
module.exports = scheduler;
