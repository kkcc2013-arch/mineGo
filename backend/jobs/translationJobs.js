'use strict';

/**
 * REQ-00398: 翻译检查定时任务启动器
 * 每天凌晨 2 点检查缺失翻译并发送告警
 */

const cron = require('node-cron');
const logger = require('../shared/logger');
const { checkMissingTranslations, cleanupOldAlerts } = require('./checkMissingTranslations');

// 存储所有任务
const scheduledTasks = [];

/**
 * 启动翻译检查定时任务
 */
function startTranslationJobs() {
  // 每天凌晨 2 点检查缺失翻译
  const checkTask = cron.schedule('0 2 * * *', async () => {
    try {
      logger.info('Running scheduled translation check job');
      await checkMissingTranslations();
      logger.info('Translation check job completed successfully');
    } catch (error) {
      logger.error('Translation check job failed', { error: error.message });
    }
  }, {
    name: 'translation-missing-check',
    timezone: 'UTC'
  });
  
  scheduledTasks.push(checkTask);
  logger.info('Translation check job scheduled: daily at 02:00 UTC');
  
  // 每周清理已确认的旧告警
  const cleanupTask = cron.schedule('0 3 * * 0', async () => {
    try {
      logger.info('Running scheduled translation alert cleanup');
      await cleanupOldAlerts();
      logger.info('Translation alert cleanup completed');
    } catch (error) {
      logger.error('Translation alert cleanup failed', { error: error.message });
    }
  }, {
    name: 'translation-alert-cleanup',
    timezone: 'UTC'
  });
  
  scheduledTasks.push(cleanupTask);
  logger.info('Translation alert cleanup scheduled: weekly on Sunday at 03:00 UTC');
  
  return scheduledTasks;
}

/**
 * 停止所有翻译定时任务
 */
function stopTranslationJobs() {
  for (const task of scheduledTasks) {
    if (task && task.stop) {
      task.stop();
    }
  }
  scheduledTasks.length = 0;
  logger.info('All translation jobs stopped');
}

/**
 * 获取所有任务状态
 */
function getTasksStatus() {
  return scheduledTasks.map(task => ({
    name: task.options?.name || 'unnamed',
    running: task.running
  }));
}

module.exports = {
  startTranslationJobs,
  stopTranslationJobs,
  getTasksStatus
};