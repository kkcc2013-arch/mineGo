/**
 * REQ-00127: 用户数据删除请求管理系统
 * 定时任务处理器
 */

'use strict';

const cron = require('node-cron');
const { DataDeletionService } = require('../shared/dataDeletionService');
const logger = require('../shared/logger');

let db = null;
let eventBus = null;
let deletionService = null;

/**
 * 初始化任务处理器
 */
function init(dbConnection, eventBusInstance) {
  db = dbConnection;
  eventBus = eventBusInstance;
  deletionService = new DataDeletionService(db, eventBus);
}

/**
 * 处理已批准的删除请求（30天延迟后执行）
 */
async function processScheduledDeletions() {
  logger.info('Processing scheduled data deletions');

  try {
    // 查找已批准且到达执行时间的请求
    const result = await db.query(`
      SELECT * FROM data_deletion_requests
      WHERE status = 'approved'
        AND approved_at < NOW() - INTERVAL '30 days'
        AND processing_started_at IS NULL
      ORDER BY approved_at ASC
      LIMIT 10
    `);

    for (const request of result.rows) {
      try {
        await deletionService.executeDeletion(request.id);
      } catch (error) {
        logger.error('Failed to process deletion request', {
          requestId: request.id,
          error: error.message
        });
      }
    }

    logger.info('Scheduled deletions processed', {
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error processing scheduled deletions', {
      error: error.message
    });
  }
}

/**
 * 重试失败的删除任务
 */
async function retryFailedTasks() {
  logger.info('Retrying failed deletion tasks');

  try {
    // 查找有失败任务且重试次数未超限的请求
    const result = await db.query(`
      SELECT DISTINCT r.* 
      FROM data_deletion_requests r
      JOIN data_deletion_tasks t ON t.request_id = r.id
      WHERE r.status = 'processing'
        AND t.status = 'failed'
        AND t.retry_count < t.max_retries
    `);

    for (const request of result.rows) {
      try {
        await deletionService.executeDeletion(request.id);
      } catch (error) {
        logger.error('Failed to retry deletion', {
          requestId: request.id,
          error: error.message
        });
      }
    }

    logger.info('Failed tasks retried', {
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error retrying failed tasks', {
      error: error.message
    });
  }
}

/**
 * 清理过期验证码
 */
async function cleanupExpiredCodes() {
  try {
    const result = await db.query(`
      UPDATE data_deletion_requests
      SET status = 'cancelled'
      WHERE status = 'pending'
        AND verification_expires_at < NOW()
    `);

    if (result.rowCount > 0) {
      logger.info('Expired verification codes cleaned', {
        count: result.rowCount
      });
    }
  } catch (error) {
    logger.error('Error cleaning up expired codes', {
      error: error.message
    });
  }
}

/**
 * 发送即将过期提醒
 */
async function sendExpirationReminders() {
  try {
    // 查找7天内即将过期的待审批请求
    const result = await db.query(`
      SELECT r.*, u.email, u.username
      FROM data_deletion_requests r
      JOIN users u ON r.user_id = u.id
      WHERE r.status = 'approved'
        AND r.approved_at < NOW() - INTERVAL '23 days'
        AND r.approved_at >= NOW() - INTERVAL '30 days'
        AND r.processing_started_at IS NULL
    `);

    for (const request of result.rows) {
      // 发送提醒
      if (eventBus) {
        await eventBus.publish('notification.email', {
          to: request.email,
          template: 'deletion_reminder',
          data: {
            username: request.username,
            daysLeft: 30 - Math.floor((Date.now() - new Date(request.approved_at).getTime()) / (1000 * 60 * 60 * 24))
          }
        });
      }
    }

    if (result.rows.length > 0) {
      logger.info('Expiration reminders sent', {
        count: result.rows.length
      });
    }
  } catch (error) {
    logger.error('Error sending expiration reminders', {
      error: error.message
    });
  }
}

/**
 * 生成每日统计报告
 */
async function generateDailyReport() {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) as today_requests,
        COUNT(*) FILTER (WHERE DATE(completed_at) = CURRENT_DATE) as today_completed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_total,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_total,
        COUNT(*) FILTER (WHERE status = 'processing') as processing_total
      FROM data_deletion_requests
    `);

    const summary = stats.rows[0];

    logger.info('Daily deletion report', summary);

    // 发送到监控系统
    if (eventBus) {
      await eventBus.publish('metrics.report', {
        type: 'data_deletion',
        data: summary
      });
    }

    return summary;
  } catch (error) {
    logger.error('Error generating daily report', {
      error: error.message
    });
  }
}

/**
 * 启动定时任务
 */
function start() {
  // 每小时检查待执行的删除请求
  cron.schedule('0 * * * *', processScheduledDeletions);

  // 每6小时重试失败任务
  cron.schedule('0 */6 * * *', retryFailedTasks);

  // 每天清理过期验证码
  cron.schedule('0 0 * * *', cleanupExpiredCodes);

  // 每天发送即将过期提醒
  cron.schedule('0 9 * * *', sendExpirationReminders);

  // 每天生成统计报告
  cron.schedule('0 8 * * *', generateDailyReport);

  logger.info('Data deletion processor started');
}

/**
 * 停止所有定时任务
 */
function stop() {
  // node-cron 的任务会在进程退出时自动停止
  logger.info('Data deletion processor stopped');
}

module.exports = {
  init,
  start,
  stop,
  processScheduledDeletions,
  retryFailedTasks,
  cleanupExpiredCodes,
  sendExpirationReminders,
  generateDailyReport
};
