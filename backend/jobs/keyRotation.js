/**
 * Key Rotation Scheduler - 密钥轮换定时任务
 * 
 * 定期检查并自动轮换到期密钥。
 * 
 * @module jobs/keyRotation
 */

'use strict';

const path = require('path');

// 添加项目根目录到 module.paths
const projectRoot = path.resolve(__dirname, '..');
module.paths.unshift(path.join(projectRoot, 'shared'));

const { getKeyRotationService } = require('../shared/kms');
const logger = require('../shared/logger');

/**
 * 密钥轮换调度器
 */
class KeyRotationScheduler {
  constructor(options = {}) {
    this.rotationService = getKeyRotationService({
      notificationCallback: this.handleNotification.bind(this)
    });
    
    this.jobs = [];
    this.running = false;
    this.options = {
      checkIntervalMs: options.checkIntervalMs || 60 * 60 * 1000, // 默认每小时检查一次
      enabled: options.enabled !== false
    };
  }

  /**
   * 启动调度器
   */
  start() {
    if (!this.options.enabled) {
      logger.info('[KeyRotationScheduler] Scheduler disabled');
      return;
    }

    if (this.running) {
      logger.warn('[KeyRotationScheduler] Scheduler already running');
      return;
    }

    this.running = true;

    // 启动时立即检查一次
    this.checkAndRotate().catch(err => {
      logger.error('[KeyRotationScheduler] Initial check failed:', err);
    });

    // 启动定时任务
    const intervalJob = setInterval(async () => {
      await this.checkAndRotate();
    }, this.options.checkIntervalMs);

    this.jobs.push(intervalJob);

    logger.info('[KeyRotationScheduler] Scheduler started', {
      checkInterval: `${this.options.checkIntervalMs / 1000 / 60} minutes`
    });
  }

  /**
   * 停止调度器
   */
  stop() {
    this.running = false;
    
    for (const job of this.jobs) {
      clearInterval(job);
    }
    
    this.jobs = [];
    
    logger.info('[KeyRotationScheduler] Scheduler stopped');
  }

  /**
   * 检查并轮换到期密钥
   */
  async checkAndRotate() {
    logger.info('[KeyRotationScheduler] Checking for keys to rotate...');

    try {
      const results = await this.rotationService.checkAndRotateExpired();

      if (results.length === 0) {
        logger.info('[KeyRotationScheduler] No keys need rotation');
        return;
      }

      // 统计结果
      const success = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('[KeyRotationScheduler] Rotation complete', {
        total: results.length,
        success,
        failed
      });

      // 发送汇总通知
      if (success > 0) {
        await this.sendSummaryNotification(results);
      }
    } catch (error) {
      logger.error('[KeyRotationScheduler] Check failed:', error);
      await this.sendErrorNotification(error);
    }
  }

  /**
   * 处理轮换通知
   */
  async handleNotification(notification) {
    logger.info('[KeyRotationScheduler] Notification:', notification);

    // 发送到监控系统
    try {
      const metrics = require('../shared/metrics');
      
      if (notification.event === 'key_rotated') {
        metrics.increment('kms.keys_rotated', 1);
      } else if (notification.level === 'critical') {
        metrics.increment('kms.rotation_failures', 1);
      }
    } catch (err) {
      // 忽略监控错误
    }

    // 发送到告警系统
    try {
      const alertCorrelator = require('../shared/alertCorrelator');
      
      if (notification.level === 'critical') {
        await alertCorrelator.correlateAlert({
          level: 'critical',
          source: 'kms',
          message: `Key rotation failed: ${notification.keyName}`,
          details: notification
        });
      }
    } catch (err) {
      // 忽略告警错误
    }
  }

  /**
   * 发送汇总通知
   */
  async sendSummaryNotification(results) {
    const successKeys = results.filter(r => r.success).map(r => r.keyName);
    const failedKeys = results.filter(r => !r.success).map(r => r.keyName);

    logger.info('[KeyRotationScheduler] Rotation summary', {
      successKeys: successKeys.join(', '),
      failedKeys: failedKeys.join(', ') || 'none'
    });
  }

  /**
   * 发送错误通知
   */
  async sendErrorNotification(error) {
    logger.error('[KeyRotationScheduler] Error notification:', {
      error: error.message,
      stack: error.stack
    });
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      running: this.running,
      jobs: this.jobs.length,
      checkInterval: this.options.checkIntervalMs
    };
  }
}

// 单例
let schedulerInstance = null;

function getKeyRotationScheduler(options) {
  if (!schedulerInstance) {
    schedulerInstance = new KeyRotationScheduler(options);
  }
  return schedulerInstance;
}

// 启动函数（用于 jobs 入口）
function start() {
  const scheduler = getKeyRotationScheduler();
  scheduler.start();
  return scheduler;
}

// 停止函数
function stop() {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
}

module.exports = {
  KeyRotationScheduler,
  getKeyRotationScheduler,
  start,
  stop
};
