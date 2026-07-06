// backend/jobs/drillScheduler.js
// 灾备演练调度器
'use strict';

const logger = require('../shared/logger')('drill-scheduler');
const { DisasterRecoveryEngine, DrillManager } = require('../shared/disasterRecovery');

// 配置
const CONFIG = {
  scheduleIntervalDays: parseInt(process.env.DRILL_SCHEDULE_INTERVAL_DAYS) || 7,
  maxDrillDuration: parseInt(process.env.MAX_DRILL_DURATION_MINUTES) * 60 * 1000 || 1800000,
  autoRollback: process.env.AUTO_ROLLBACK_ENABLED !== 'false',
  notifyChannels: (process.env.NOTIFY_CHANNELS || 'slack,email').split(','),
  drillTypes: ['full', 'partial', 'dry-run']
};

// 引擎实例
let drEngine = null;
let drillManager = null;

/**
 * 初始化
 */
async function initialize() {
  try {
    logger.info('初始化演练调度器...');
    
    // 创建灾备引擎
    drEngine = new DisasterRecoveryEngine({
      primaryRegion: process.env.PRIMARY_REGION || 'beijing',
      standbyRegion: process.env.STANDBY_REGION || 'shanghai',
      rtoTarget: 300000,
      rpoTarget: 60000,
      healthCheckInterval: 10000,
      failureThreshold: 3,
      recoveryThreshold: 5
    });
    
    // 启动灾备引擎
    await drEngine.start();
    
    // 创建演练管理器
    drillManager = new DrillManager(drEngine.failoverController, CONFIG);
    
    logger.info('演练调度器初始化完成');
    
  } catch (error) {
    logger.error({ error: error.message }, '初始化失败');
    throw error;
  }
}

/**
 * 检查是否需要调度演练
 */
async function checkAndSchedule() {
  try {
    logger.info('检查演练调度需求...');
    
    // 获取上次演练时间
    const history = drillManager.getDrillHistory(1);
    const lastDrill = history[0];
    
    const now = Date.now();
    const scheduleThreshold = CONFIG.scheduleIntervalDays * 24 * 60 * 60 * 1000;
    
    if (!lastDrill) {
      logger.info('无演练历史，需要首次演练');
      return await scheduleNewDrill();
    }
    
    const lastDrillTime = new Date(lastDrill.startTime).getTime();
    const daysSinceLastDrill = (now - lastDrillTime) / (24 * 60 * 60 * 1000);
    
    logger.info({
      lastDrillTime: lastDrill.startTime,
      daysSinceLastDrill,
      threshold: CONFIG.scheduleIntervalDays
    }, '演练间隔检查');
    
    if (now - lastDrillTime > scheduleThreshold) {
      logger.info('超过调度间隔，启动新演练');
      return await scheduleNewDrill();
    }
    
    logger.info('未到调度间隔，无需启动演练');
    return null;
    
  } catch (error) {
    logger.error({ error: error.message }, '检查调度失败');
    throw error;
  }
}

/**
 * 调度新演练
 */
async function scheduleNewDrill() {
  try {
    // 检查是否有活跃演练
    const activeDrill = drillManager.getActiveDrill();
    if (activeDrill) {
      logger.warn({ drillId: activeDrill.id }, '已有演练正在进行');
      return null;
    }
    
    // 选择演练类型（轮换）
    const drillTypeIndex = Math.floor(Date.now() / CONFIG.scheduleIntervalDays) % CONFIG.drillTypes.length;
    const drillType = CONFIG.drillTypes[drillTypeIndex];
    
    logger.info({ drillType }, '调度新演练');
    
    // 调度演练
    const drill = await drillManager.scheduleDrill({
      type: drillType,
      duration: CONFIG.maxDrillDuration,
      autoRollback: CONFIG.autoRollback,
      notifyChannels: CONFIG.notifyChannels,
      createdBy: 'scheduler'
    });
    
    // 发送通知
    await sendNotification('drill-scheduled', {
      drillId: drill.id,
      scheduledTime: drill.scheduledTime,
      type: drillType,
      estimatedDuration: CONFIG.maxDrillDuration / 60000
    });
    
    // 自动开始演练（如果配置为立即开始）
    if (process.env.AUTO_START_DRILL === 'true') {
      logger.info({ drillId: drill.id }, '自动开始演练');
      await drillManager.startDrill(drill.id);
    }
    
    return drill;
    
  } catch (error) {
    logger.error({ error: error.message }, '调度演练失败');
    throw error;
  }
}

/**
 * 发送通知
 */
async function sendNotification(event, data) {
  logger.info({ event, data }, '发送通知');
  
  // 实际实现需要集成通知服务
  // 例如 Slack、Email、钉钉等
  try {
    const webhookUrl = process.env.DR_NOTIFICATION_WEBHOOK;
    
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          data,
          timestamp: new Date().toISOString(),
          source: 'drill-scheduler'
        })
      });
    }
  } catch (error) {
    logger.error({ error: error.message }, '发送通知失败');
  }
}

/**
 * 生成演练报告
 */
async function generateReport() {
  try {
    const history = drillManager.getDrillHistory(10);
    const activeDrill = drillManager.getActiveDrill();
    
    const report = {
      generatedAt: new Date().toISOString(),
      config: CONFIG,
      activeDrill,
      recentHistory: history,
      statistics: {
        totalDrills: history.length,
        successfulDrills: history.filter(d => d.status === 'completed').length,
        failedDrills: history.filter(d => d.status === 'failed').length,
        averageRTO: history.length > 0 
          ? history.reduce((sum, d) => sum + (d.rto || 0), 0) / history.length 
          : 0
      }
    };
    
    logger.info({ report }, '演练报告生成完成');
    return report;
    
  } catch (error) {
    logger.error({ error: error.message }, '生成报告失败');
    throw error;
  }
}

/**
 * 主执行流程
 */
async function main() {
  try {
    await initialize();
    await checkAndSchedule();
    
    // 如果作为定时任务运行，直接退出
    if (process.env.RUN_ONCE === 'true') {
      logger.info('单次运行模式，退出');
      process.exit(0);
    }
    
  } catch (error) {
    logger.critical({ error: error.message }, '演练调度失败');
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('收到 SIGTERM，准备关闭...');
  if (drEngine) {
    await drEngine.stop();
  }
  process.exit(0);
});

// 运行
if (require.main === module) {
  main();
}

module.exports = {
  initialize,
  checkAndSchedule,
  scheduleNewDrill,
  generateReport
};