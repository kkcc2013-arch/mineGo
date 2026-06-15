/**
 * 数据生命周期清理定时任务
 * 
 * 定时执行数据清理、归档操作
 * 
 * @module cleanupJobs
 */

const cron = require('node-cron');
const DataLifecycleManager = require('../shared/DataLifecycleManager');
const logger = require('../shared/logger');

// 任务状态
const jobStatus = {
  temporaryCleanup: { lastRun: null, status: 'idle', lastResult: null },
  operationLogsCleanup: { lastRun: null, status: 'idle', lastResult: null },
  transactionArchive: { lastRun: null, status: 'idle', lastResult: null },
  historicalCleanup: { lastRun: null, status: 'idle', lastResult: null },
  userDeletionProcessor: { lastRun: null, status: 'idle', lastResult: null }
};

/**
 * 执行清理任务包装器
 */
async function runCleanupJob(jobName, category, jobStatusKey) {
  const job = jobStatus[jobStatusKey];
  
  if (job.status === 'running') {
    logger.warn(`Job ${jobName} already running, skipping`);
    return;
  }

  job.status = 'running';
  job.lastRun = new Date();

  try {
    logger.info(`Starting ${jobName}`);
    
    const result = await DataLifecycleManager.cleanupData(category, {
      reason: `Scheduled ${jobName}`,
      performedBy: 'system'
    });

    job.lastResult = result;
    job.status = 'success';
    
    logger.info(`Completed ${jobName}`, {
      totalRecords: result.totalRecords,
      status: result.status
    });
  } catch (err) {
    job.status = 'failed';
    job.lastResult = { error: err.message };
    logger.error(`Failed ${jobName}`, { error: err.message });
  }
}

/**
 * 处理计划删除的用户数据
 */
async function processScheduledDeletions() {
  const job = jobStatus.userDeletionProcessor;
  
  if (job.status === 'running') {
    logger.warn('User deletion processor already running, skipping');
    return;
  }

  job.status = 'running';
  job.lastRun = new Date();

  try {
    const db = require('../shared/db');
    
    // 获取待处理的删除请求
    const result = await db.query(`
      SELECT * FROM user_data_deletion_requests
      WHERE status = 'pending'
        AND scheduled_deletion_at <= NOW()
      LIMIT 100
    `);

    const requests = result.rows;
    let processed = 0;
    let failed = 0;

    for (const request of requests) {
      try {
        await DataLifecycleManager.deleteUserData(request.user_id, {
          reason: 'Scheduled deletion',
          performedBy: 'system'
        });

        await db.query(`
          UPDATE user_data_deletion_requests
          SET status = 'completed', completed_at = NOW()
          WHERE id = $1
        `, [request.id]);

        processed++;
      } catch (err) {
        failed++;
        logger.error('Failed to process user deletion', {
          userId: request.user_id,
          error: err.message
        });
      }
    }

    job.lastResult = { processed, failed };
    job.status = 'success';
    
    logger.info('User deletion processor completed', { processed, failed });
  } catch (err) {
    job.status = 'failed';
    job.lastResult = { error: err.message };
    logger.error('User deletion processor failed', { error: err.message });
  }
}

/**
 * 启动所有清理任务
 */
function startCleanupJobs() {
  logger.info('Starting data lifecycle cleanup jobs');

  // 每天凌晨 2 点清理临时数据
  cron.schedule('0 2 * * *', async () => {
    await runCleanupJob('Temporary data cleanup', 'TEMPORARY', 'temporaryCleanup');
  });

  // 每周日凌晨 3 点清理操作日志
  cron.schedule('0 3 * * 0', async () => {
    await runCleanupJob('Operation logs cleanup', 'OPERATION_LOGS', 'operationLogsCleanup');
  });

  // 每月 1 号凌晨 4 点归档交易记录
  cron.schedule('0 4 1 * *', async () => {
    await runCleanupJob('Transaction records archive', 'TRANSACTION_RECORDS', 'transactionArchive');
  });

  // 每月 15 号凌晨 5 点清理历史数据
  cron.schedule('0 5 15 * *', async () => {
    await runCleanupJob('Historical data cleanup', 'HISTORICAL_DATA', 'historicalCleanup');
  });

  // 每小时检查计划删除的用户数据
  cron.schedule('0 * * * *', async () => {
    await processScheduledDeletions();
  });

  logger.info('All cleanup jobs scheduled');
}

/**
 * 获取所有任务状态
 */
function getJobsStatus() {
  return jobStatus;
}

/**
 * 手动触发清理任务
 */
async function triggerCleanup(category) {
  const jobName = `Manual ${category} cleanup`;
  const jobStatusKey = `manual_${category}`;
  
  jobStatus[jobStatusKey] = { lastRun: null, status: 'idle', lastResult: null };
  
  await runCleanupJob(jobName, category, jobStatusKey);
  
  return jobStatus[jobStatusKey];
}

module.exports = {
  startCleanupJobs,
  getJobsStatus,
  triggerCleanup,
  jobStatus
};
