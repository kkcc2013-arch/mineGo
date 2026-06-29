// backend/shared/ConnectionPoolScheduler.js
// REQ-00362: 连接池预分配调度器

'use strict';

const { getConnectionPoolPredictor } = require('./ConnectionPoolPredictor');
const { getPoolManager } = require('./DatabasePool');
const { query } = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('pool-scheduler');

// ============================================================
// 配置
// ============================================================

const SCHEDULER_CONFIG = {
  minConnections: 5,
  maxConnections: 100,
  scaleUpStep: 10, // 每次扩容步长
  scaleUpRate: 5, // 每秒最多新增连接数
  scaleDownStep: 5, // 每次缩容步长
  scaleDownCooldown: 60 * 1000, // 缩容冷却期（毫秒）
  preheatLeadTime: 5 * 60 * 1000, // 提前预热时间（5分钟）
  predictionInterval: 5 * 60 * 1000, // 预测间隔（5分钟）
  executionInterval: 60 * 1000, // 执行间隔（1分钟）
  
  // 服务优先级（故障恢复顺序）
  servicePriority: {
    'user-service': 1,
    'gateway': 2,
    'location-service': 3,
    'catch-service': 4,
    'pokemon-service': 5,
    'payment-service': 6,
    'gym-service': 7,
    'reward-service': 8,
    'social-service': 9
  }
};

// ============================================================
// 连接池调度器类
// ============================================================

class ConnectionPoolScheduler {
  constructor(config = {}) {
    this.config = { ...SCHEDULER_CONFIG, ...config };
    this.predictor = getConnectionPoolPredictor();
    this.poolManager = null;
    this.schedules = new Map();
    this.lastScaleDown = new Map();
    this.running = false;
    this.timers = [];
  }

  /**
   * 初始化
   */
  async init() {
    this.poolManager = getPoolManager();
    logger.info('Connection pool scheduler initialized');
  }

  /**
   * 启动调度循环
   */
  start() {
    if (this.running) return;
    this.running = true;

    // 预测循环
    const predictionTimer = setInterval(
      () => this.runPredictionCycle(),
      this.config.predictionInterval
    );
    this.timers.push(predictionTimer);

    // 执行循环
    const executionTimer = setInterval(
      () => this.runScheduleExecution(),
      this.config.executionInterval
    );
    this.timers.push(executionTimer);

    // 模式学习循环（每10分钟）
    const learningTimer = setInterval(
      () => this.runPatternLearning(),
      10 * 60 * 1000
    );
    this.timers.push(learningTimer);

    logger.info('Connection pool scheduler started');

    // 立即执行一次预测
    this.runPredictionCycle().catch(err => 
      logger.error({ err }, 'Initial prediction cycle failed')
    );
  }

  /**
   * 停止调度
   */
  stop() {
    this.running = false;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    logger.info('Connection pool scheduler stopped');
  }

  /**
   * 获取活跃服务列表
   */
  getActiveServices() {
    if (!this.poolManager) return [];
    return Array.from(this.poolManager.pools.keys())
      .map(key => key.replace('pool-', ''));
  }

  /**
   * 预测循环
   */
  async runPredictionCycle() {
    const services = this.getActiveServices();

    for (const serviceName of services) {
      try {
        // 获取当前连接池状态
        const poolStats = this.poolManager.getStats();
        const poolKey = `pool-${serviceName}`;
        const stats = poolStats[poolKey];

        if (!stats) continue;

        // 检查是否需要预分配
        const decision = await this.predictor.shouldPreallocate(
          serviceName,
          stats.total
        );

        if (decision.needPreallocate) {
          // 调度预分配
          await this.schedulePreallocation(serviceName, {
            targetConnections: decision.targetConnections,
            currentConnections: decision.currentConnections,
            triggerReason: 'prediction',
            executeAt: Date.now() + 60 * 1000 // 1分钟后执行
          });

          logger.info({
            serviceName,
            current: decision.currentConnections,
            target: decision.targetConnections,
            confidence: decision.confidence
          }, 'Preallocation scheduled');
        }

        // 检查是否需要缩容
        const scaleDownDecision = await this.predictor.shouldScaleDown(
          serviceName,
          stats.total
        );

        if (scaleDownDecision.shouldScaleDown) {
          // 检查冷却期
          const lastScaleDown = this.lastScaleDown.get(serviceName) || 0;
          if (Date.now() - lastScaleDown > this.config.scaleDownCooldown) {
            await this.scheduleScaledown(serviceName, {
              targetConnections: scaleDownDecision.targetConnections,
              currentConnections: scaleDownDecision.currentConnections,
              triggerReason: 'prediction',
              executeAt: Date.now() + 10 * 60 * 1000 // 10分钟后执行
            });
          }
        }

      } catch (err) {
        logger.error({ serviceName, err: err.message }, 'Prediction cycle failed');
      }
    }
  }

  /**
   * 执行循环
   */
  async runScheduleExecution() {
    const now = Date.now();

    for (const [scheduleId, schedule] of this.schedules) {
      if (schedule.executeAt <= now && schedule.status === 'pending') {
        try {
          await this.executeSchedule(scheduleId, schedule);
        } catch (err) {
          logger.error({ scheduleId, err: err.message }, 'Schedule execution failed');
          schedule.status = 'failed';
          schedule.errorMessage = err.message;
        }
      }
    }

    // 清理已完成的调度记录
    this.cleanupSchedules();
  }

  /**
   * 模式学习循环
   */
  async runPatternLearning() {
    const services = this.getActiveServices();

    for (const serviceName of services) {
      try {
        const poolStats = this.poolManager.getStats();
        const poolKey = `pool-${serviceName}`;
        const stats = poolStats[poolKey];

        if (stats) {
          await this.predictor.recordCurrentStats(
            serviceName,
            stats.total,
            stats.usage
          );
        }
      } catch (err) {
        logger.warn({ serviceName, err: err.message }, 'Pattern learning failed');
      }
    }
  }

  /**
   * 调度预分配
   */
  async schedulePreallocation(serviceName, options) {
    const scheduleId = `prealloc-${serviceName}-${Date.now()}`;

    const schedule = {
      id: scheduleId,
      serviceName,
      action: 'scale_up',
      targetConnections: Math.min(options.targetConnections, this.config.maxConnections),
      currentConnections: options.currentConnections,
      triggerReason: options.triggerReason,
      status: 'pending',
      executeAt: options.executeAt || Date.now(),
      createdAt: Date.now()
    };

    this.schedules.set(scheduleId, schedule);

    // 保存到数据库
    await this.saveSchedule(schedule);

    logger.info({
      scheduleId,
      serviceName,
      target: schedule.targetConnections,
      reason: schedule.triggerReason
    }, 'Preallocation scheduled');

    return scheduleId;
  }

  /**
   * 调度缩容
   */
  async scheduleScaledown(serviceName, options) {
    const scheduleId = 'scaledown-' + serviceName + '-' + Date.now();

    const schedule = {
      id: scheduleId,
      serviceName,
      action: 'scale_down',
      targetConnections: Math.max(options.targetConnections, this.config.minConnections),
      currentConnections: options.currentConnections,
      triggerReason: options.triggerReason,
      status: 'pending',
      executeAt: options.executeAt || Date.now(),
      createdAt: Date.now()
    };

    this.schedules.set(scheduleId, schedule);
    await this.saveSchedule(schedule);

    logger.info({
      scheduleId,
      serviceName,
      target: schedule.targetConnections
    }, 'Scaledown scheduled');

    return scheduleId;
  }

  /**
   * 执行调度
   */
  async executeSchedule(scheduleId, schedule) {
    schedule.status = 'running';
    schedule.startedAt = new Date();

    const { serviceName, targetConnections, action } = schedule;
    const poolKey = 'pool-' + serviceName;
    const poolState = this.poolManager.pools.get(poolKey);

    if (!poolState) {
      throw new Error('Pool not found: ' + serviceName);
    }

    const pool = poolState.pool;
    const currentMax = pool.options.max;
    const startTime = Date.now();

    if (action === 'scale_up') {
      // 阶梯式扩容
      const steps = Math.ceil((targetConnections - currentMax) / this.config.scaleUpStep);
      
      for (let i = 0; i < steps; i++) {
        const stepTarget = Math.min(
          currentMax + (i + 1) * this.config.scaleUpStep,
          targetConnections
        );

        pool.options.max = stepTarget;

        // 记录扩容事件
        this.recordScaleEvent(serviceName, 'up', currentMax, stepTarget);

        // 限速
        if (i < steps - 1) {
          await this.sleep(1000 / this.config.scaleUpRate);
        }
      }
    } else if (action === 'scale_down') {
      // 渐进式缩容
      const steps = Math.ceil((currentMax - targetConnections) / this.config.scaleDownStep);
      
      for (let i = 0; i < steps; i++) {
        const stepTarget = Math.max(
          currentMax - (i + 1) * this.config.scaleDownStep,
          targetConnections,
          this.config.minConnections
        );

        pool.options.max = stepTarget;

        this.recordScaleEvent(serviceName, 'down', currentMax, stepTarget);

        if (i < steps - 1) {
          await this.sleep(2000); // 缩容更慢
        }
      }

      this.lastScaleDown.set(serviceName, Date.now());
    }

    schedule.status = 'completed';
    schedule.completedAt = new Date();
    schedule.duration = Date.now() - startTime;

    // 更新数据库记录
    await this.updateScheduleRecord(scheduleId, schedule);

    logger.info({
      scheduleId,
      serviceName,
      action,
      targetConnections,
      duration: schedule.duration + 'ms'
    }, 'Schedule executed');

    return schedule;
  }

  /**
   * 记录扩缩容事件
   */
  async recordScaleEvent(serviceName, direction, fromSize, toSize) {
    try {
      await query(`
        INSERT INTO connection_pool_schedules 
          (service_name, action, target_connections, current_connections, trigger_reason, started_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [serviceName, 'scale_' + direction, toSize, fromSize, 'prediction']);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to record scale event');
    }
  }

  /**
   * 保存调度记录
   */
  async saveSchedule(schedule) {
    try {
      await query(`
        INSERT INTO connection_pool_schedules 
          (id, service_name, action, target_connections, current_connections, trigger_reason, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [
        schedule.id,
        schedule.serviceName,
        schedule.action,
        schedule.targetConnections,
        schedule.currentConnections,
        schedule.triggerReason,
        schedule.status
      ]);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to save schedule');
    }
  }

  /**
   * 更新调度记录
   */
  async updateScheduleRecord(scheduleId, schedule) {
    try {
      await query(`
        UPDATE connection_pool_schedules 
        SET status = $1, completed_at = $2
        WHERE id = $3
      `, [schedule.status, schedule.completedAt, scheduleId]);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to update schedule');
    }
  }

  /**
   * 活动预热
   */
  async preheatForEvent(event) {
    const preheatTime = new Date(
      new Date(event.start_time).getTime() - event.preheat_minutes * 60 * 1000
    );
    const now = new Date();

    if (preheatTime <= now) {
      logger.warn({ event: event.event_id }, 'Event preheat time has passed');
      return;
    }

    const timeUntilPreheat = preheatTime - now;
    const timeUntilEvent = new Date(event.start_time) - now;

    // 多级预热策略
    const stages = [
      { time: timeUntilPreheat, factor: 0.3 }, // 30% 目标连接数
      { time: timeUntilEvent - 5 * 60 * 1000, factor: 0.7 }, // 70%
      { time: timeUntilEvent - 2 * 60 * 1000, factor: 1.0 } // 100%
    ];

    for (const [service, targetConnections] of Object.entries(event.services || {})) {
      for (const stage of stages) {
        const stageTarget = Math.ceil(targetConnections * stage.factor);

        setTimeout(async () => {
          try {
            await this.warmupPool(service, stageTarget);
            logger.info({
              service,
              event: event.event_id,
              stageTarget
            }, 'Event preheat stage executed');
          } catch (err) {
            logger.error({ err, service }, 'Event preheat failed');
          }
        }, stage.time);
      }
    }

    // 更新活动状态
    try {
      await query(`
        UPDATE event_preheat_configs 
        SET status = 'preheating'
        WHERE event_id = $1
      `, [event.event_id]);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to update event status');
    }
  }

  /**
   * 预热连接池
   */
  async warmupPool(serviceName, targetConnections) {
    const poolKey = 'pool-' + serviceName;
    const poolState = this.poolManager.pools.get(poolKey);

    if (!poolState) {
      throw new Error('Pool not found: ' + serviceName);
    }

    const pool = poolState.pool;
    const currentMax = pool.options.max;
    const newMax = Math.max(currentMax, targetConnections);
    pool.options.max = newMax;

    // 预创建连接
    const precreateCount = Math.min(targetConnections, 20);
    const clients = await Promise.all(
      Array(precreateCount).fill(0).map(() => pool.connect())
    );

    // 立即释放连接回池中
    for (const client of clients) {
      client.release();
    }

    logger.info({
      serviceName,
      newMax,
      precreated: precreateCount
    }, 'Pool warmed up');
  }

  /**
   * 故障恢复优化
   */
  async recoverFromFailure(serviceName) {
    const priority = this.config.servicePriority[serviceName] || 99;
    const baseDelay = priority * 100; // 按优先级延迟

    await this.sleep(baseDelay);

    // 核心服务优先重建
    const targetConnections = this.config.servicePriority[serviceName] <= 3 
      ? 15 
      : 8;

    try {
      await this.warmupPool(serviceName, targetConnections);
      logger.info({ serviceName, priority, targetConnections }, 'Service recovered');
    } catch (err) {
      logger.error({ err, serviceName }, 'Recovery failed');
    }
  }

  /**
   * 批量故障恢复
   */
  async batchRecoverFromFailure(services) {
    // 按优先级排序
    const sorted = services.sort((a, b) => {
      const pa = this.config.servicePriority[a] || 99;
      const pb = this.config.servicePriority[b] || 99;
      return pa - pb;
    });

    for (const serviceName of sorted) {
      await this.recoverFromFailure(serviceName);
      await this.sleep(500); // 错开恢复时间
    }
  }

  /**
   * 清理已完成的调度
   */
  cleanupSchedules() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24小时

    for (const [scheduleId, schedule] of this.schedules) {
      if (schedule.status === 'completed' || schedule.status === 'failed') {
        if (now - schedule.createdAt > maxAge) {
          this.schedules.delete(scheduleId);
        }
      }
    }
  }

  /**
   * 获取调度状态
   */
  getScheduleStats() {
    const stats = {
      total: this.schedules.size,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0
    };

    for (const schedule of this.schedules.values()) {
      stats[schedule.status]++;
    }

    return stats;
  }

  /**
   * 辅助方法：休眠
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  ConnectionPoolScheduler,
  SCHEDULER_CONFIG
};