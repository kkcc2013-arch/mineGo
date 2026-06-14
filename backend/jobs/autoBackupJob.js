// backend/jobs/autoBackupJob.js
'use strict';

/**
 * Auto Backup Job
 * REQ-00129: 自动备份定时任务
 * 
 * 运行每日和每周自动备份，清理过期备份
 */

const cron = require('node-cron');
const { createLogger } = require('../shared/logger');
const { getBackupService, BACKUP_TYPES } = require('../shared/pokemonBackupService');
const { query } = require('../shared/db');

const logger = createLogger('auto-backup-job');

class AutoBackupJob {
  constructor(options = {}) {
    this.db = options.db;
    this.redis = options.redis;
    this.running = false;
    this.jobs = [];
  }

  /**
   * 启动定时任务
   */
  start() {
    if (this.running) {
      logger.warn('Auto backup job is already running');
      return;
    }

    logger.info('Starting auto backup job scheduler');

    // 每日备份 - 凌晨3点
    const dailyJob = cron.schedule('0 3 * * *', async () => {
      await this.runDailyBackup();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
    this.jobs.push(dailyJob);

    // 每周备份 - 周日凌晨3点
    const weeklyJob = cron.schedule('0 3 * * 0', async () => {
      await this.runWeeklyBackup();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
    this.jobs.push(weeklyJob);

    // 清理过期备份 - 每小时
    const cleanupJob = cron.schedule('0 * * * *', async () => {
      await this.cleanupExpiredBackups();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
    this.jobs.push(cleanupJob);

    this.running = true;
    logger.info('Auto backup job scheduler started');
  }

  /**
   * 停止定时任务
   */
  stop() {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    this.running = false;
    logger.info('Auto backup job scheduler stopped');
  }

  /**
   * 执行每日备份
   */
  async runDailyBackup() {
    logger.info('Starting daily backup run');
    const startTime = Date.now();

    try {
      // 获取所有启用每日自动备份的用户
      const result = await query(`
        SELECT user_id FROM user_auto_backup_config
        WHERE enabled = true AND schedule = 'daily'
      `);

      const users = result.rows;
      let successCount = 0;
      let failCount = 0;

      const backupService = getBackupService(this.db, this.redis);

      for (const { user_id } of users) {
        try {
          await backupService.createBackup(user_id, BACKUP_TYPES.AUTO_DAILY);
          successCount++;

          // 更新最后运行时间
          await query(`
            UPDATE user_auto_backup_config
            SET last_run_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
          `, [user_id]);

        } catch (error) {
          failCount++;
          logger.error('Daily backup failed for user', {
            userId: user_id,
            error: error.message
          });
        }
      }

      const duration = Date.now() - startTime;
      logger.info('Daily backup run completed', {
        totalUsers: users.length,
        successCount,
        failCount,
        durationMs: duration
      });

    } catch (error) {
      logger.error('Daily backup run failed', { error: error.message });
    }
  }

  /**
   * 执行每周备份
   */
  async runWeeklyBackup() {
    logger.info('Starting weekly backup run');
    const startTime = Date.now();

    try {
      const result = await query(`
        SELECT user_id FROM user_auto_backup_config
        WHERE enabled = true AND schedule = 'weekly'
      `);

      const users = result.rows;
      let successCount = 0;
      let failCount = 0;

      const backupService = getBackupService(this.db, this.redis);

      for (const { user_id } of users) {
        try {
          await backupService.createBackup(user_id, BACKUP_TYPES.AUTO_WEEKLY);
          successCount++;

          await query(`
            UPDATE user_auto_backup_config
            SET last_run_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
          `, [user_id]);

        } catch (error) {
          failCount++;
          logger.error('Weekly backup failed for user', {
            userId: user_id,
            error: error.message
          });
        }
      }

      const duration = Date.now() - startTime;
      logger.info('Weekly backup run completed', {
        totalUsers: users.length,
        successCount,
        failCount,
        durationMs: duration
      });

    } catch (error) {
      logger.error('Weekly backup run failed', { error: error.message });
    }
  }

  /**
   * 清理过期备份
   */
  async cleanupExpiredBackups() {
    logger.info('Starting expired backup cleanup');

    try {
      const backupService = getBackupService(this.db, this.redis);
      const result = await backupService.cleanupExpiredBackups(100);

      logger.info('Expired backup cleanup completed', {
        cleanedCount: result.cleaned_count
      });

    } catch (error) {
      logger.error('Expired backup cleanup failed', { error: error.message });
    }
  }

  /**
   * 手动触发备份（用于测试）
   */
  async triggerBackup(userId, schedule = 'daily') {
    const backupService = getBackupService(this.db, this.redis);
    const backupType = schedule === 'daily' ? BACKUP_TYPES.AUTO_DAILY : BACKUP_TYPES.AUTO_WEEKLY;

    return backupService.createBackup(userId, backupType);
  }
}

// 单例
let jobInstance = null;

function getAutoBackupJob(options) {
  if (!jobInstance) {
    jobInstance = new AutoBackupJob(options);
  }
  return jobInstance;
}

module.exports = {
  AutoBackupJob,
  getAutoBackupJob
};
