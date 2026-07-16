// backend/shared/PoolPreheater.js - REQ-00581: 数据库连接池智能预热与动态自适应管理系统
'use strict';

const cron = require('node-cron');
const { createLogger } = require('./logger');
const { getRedis } = require('./redis');

// ============================================================
// 预热策略配置
// ============================================================

const PREHEAT_CONFIG = {
  // 预热时间表（提前5分钟预热）
  schedule: [
    { time: '07:55', targetMinMultiplier: 2.0, reason: '早高峰前预热' },
    { time: '12:55', targetMinMultiplier: 1.5, reason: '午间高峰前预热' },
    { time: '17:55', targetMinMultiplier: 2.0, reason: '晚高峰前预热' },
    { time: '21:55', targetMinMultiplier: 1.5, reason: '夜间活跃时段前预热' },
  ],

  // 默认预热配置
  defaultPreheatTime: 5, // 提前5分钟
  cooldownPeriod: 10, // 预热后冷却期（分钟）
  
  // 流量分析窗口
  analysisWindowDays: 7, // 分析7天历史数据
  minDataPoints: 10, // 最少数据点数
  
  // 预热阈值
  minUtilizationThreshold: 0.3, // 利用率低于30%不预热
  maxUtilizationThreshold: 0.8, // 利用率高于80%立即扩容
};

// ============================================================
// PoolPreheater 类
// ============================================================

class PoolPreheater {
  constructor(poolManager, options = {}) {
    this.poolManager = poolManager;
    this.redis = getRedis();
    this.config = { ...PREHEAT_CONFIG, ...options };
    this.scheduledJobs = [];
    this.lastPreheatTime = new Map(); // poolName -> timestamp
    this.trafficHistory = new Map(); // poolName -> [{timestamp, qps, connections}]
    this.isRunning = false;
    this.logger = createLogger('pool-preheater');
  }

  /**
   * 启动预热系统
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('Pool preheater already running');
      return;
    }

    this.logger.info('Starting pool preheater system');

    // 启动定时预热任务
    this.startScheduledPreheating();

    // 启动流量分析任务（每小时分析一次）
    this.startTrafficAnalysis();

    // 启动实时监控任务（每分钟检查一次）
    this.startRealTimeMonitoring();

    this.isRunning = true;
    this.logger.info('Pool preheater started successfully');
  }

  /**
   * 停止预热系统
   */
  stop() {
    this.logger.info('Stopping pool preheater');

    for (const job of this.scheduledJobs) {
      job.stop();
    }

    this.scheduledJobs = [];
    this.isRunning = false;

    this.logger.info('Pool preheater stopped');
  }

  /**
   * 启动定时预热
   */
  startScheduledPreheating() {
    for (const schedule of this.config.schedule) {
      const [hour, minute] = schedule.time.split(':').map(Number);
      
      // 创建 cron 任务 (每分钟检查是否到达预热时间)
      const job = cron.schedule('* * * * *', async () => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        if (currentHour === hour && currentMinute === minute) {
          await this.executePreheat(schedule);
        }
      });

      this.scheduledJobs.push(job);

      this.logger.info({
        schedule: schedule.time,
        reason: schedule.reason,
      }, 'Scheduled preheat job registered');
    }
  }

  /**
   * 执行预热
   */
  async executePreheat(schedule) {
    this.logger.info({ schedule }, 'Executing scheduled preheat');

    const stats = this.poolManager.getStats();

    for (const [poolName, poolStats] of Object.entries(stats)) {
      try {
        await this.preheatPool(poolName, poolStats, schedule);
      } catch (err) {
        this.logger.error({ poolName, err }, 'Failed to preheat pool');
      }
    }
  }

  /**
   * 预热单个连接池
   */
  async preheatPool(poolName, poolStats, schedule) {
    const lastPreheat = this.lastPreheatTime.get(poolName);
    const cooldownMs = this.config.cooldownPeriod * 60 * 1000;

    // 检查冷却期
    if (lastPreheat && (Date.now() - lastPreheat < cooldownMs)) {
      this.logger.debug({ poolName }, 'Skipping preheat - in cooldown period');
      return;
    }

    // 计算预热目标
    const currentMin = poolStats.idle;
    const targetMin = Math.ceil(currentMin * schedule.targetMinMultiplier);
    const maxAllowed = this.poolManager.config?.maxPoolLimit || 20;

    if (targetMin > maxAllowed) {
      this.logger.debug({ poolName, targetMin, maxAllowed }, 'Target exceeds max limit, adjusting');
    }

    // 执行预热
    const poolState = this.poolManager.pools.get(poolName);
    if (poolState) {
      await this.warmupConnections(poolState.pool, targetMin);
      
      this.lastPreheatTime.set(poolName, Date.now());

      // 记录预热事件到 Redis
      await this.recordPreheatEvent(poolName, {
        targetMin,
        previousMin: currentMin,
        reason: schedule.reason,
        timestamp: new Date().toISOString(),
      });

      this.logger.info({
        poolName,
        previousMin: currentMin,
        targetMin,
        reason: schedule.reason,
      }, 'Pool preheated successfully');
    }
  }

  /**
   * 预热连接（创建并保持空闲连接）
   */
  async warmupConnections(pool, targetCount) {
    const currentIdle = pool.idleCount;
    const needed = targetCount - currentIdle;

    if (needed <= 0) {
      return;
    }

    this.logger.debug({ needed, currentIdle, targetCount }, 'Warming up connections');

    // 批量创建连接
    const promises = [];
    for (let i = 0; i < needed; i++) {
      promises.push(
        pool.connect().then(client => {
          // 立即释放回池中，保持空闲状态
          client.release();
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * 启动流量分析任务
   */
  startTrafficAnalysis() {
    // 每小时分析一次历史流量模式
    const job = cron.schedule('0 * * * *', async () => {
      await this.analyzeTrafficPatterns();
    });

    this.scheduledJobs.push(job);
  }

  /**
   * 分析流量模式
   */
  async analyzeTrafficPatterns() {
    this.logger.debug('Analyzing traffic patterns');

    const stats = this.poolManager.getStats();

    for (const [poolName, poolStats] of Object.entries(stats)) {
      try {
        // 获取历史数据
        const history = await this.getTrafficHistory(poolName);

        if (history.length >= this.config.minDataPoints) {
          // 执行回归分析
          const prediction = this.predictTrafficTrend(history);

          // 根据预测调整预热策略
          await this.adjustPreheatStrategy(poolName, prediction);
        }
      } catch (err) {
        this.logger.error({ poolName, err }, 'Failed to analyze traffic pattern');
      }
    }
  }

  /**
   * 获取历史流量数据
   */
  async getTrafficHistory(poolName) {
    const key = `minego:traffic:${poolName}`;
    
    try {
      const data = await this.redis.lrange(key, 0, -1);
      return data.map(item => JSON.parse(item));
    } catch (err) {
      this.logger.error({ poolName, err }, 'Failed to get traffic history');
      return [];
    }
  }

  /**
   * 预测流量趋势（简单线性回归）
   */
  predictTrafficTrend(history) {
    if (history.length < 2) {
      return { trend: 'stable', nextHourQPS: 0, confidence: 0 };
    }

    // 提取时间序列数据
    const points = history.map((item, idx) => ({
      x: idx,
      y: item.qps || 0,
    }));

    // 简单线性回归
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumX2 += p.x * p.x;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // 预测下一小时
    const nextHourQPS = slope * n + intercept;

    // 计算置信度（R²）
    const meanY = sumY / n;
    let ssTotal = 0, ssResidual = 0;

    for (const p of points) {
      const predicted = slope * p.x + intercept;
      ssTotal += (p.y - meanY) ** 2;
      ssResidual += (p.y - predicted) ** 2;
    }

    const rSquared = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;

    return {
      trend: slope > 0.1 ? 'increasing' : slope < -0.1 ? 'decreasing' : 'stable',
      nextHourQPS: Math.max(0, nextHourQPS),
      slope,
      confidence: rSquared,
    };
  }

  /**
   * 调整预热策略
   */
  async adjustPreheatStrategy(poolName, prediction) {
    // 如果预测流量上升，提前预热
    if (prediction.trend === 'increasing' && prediction.confidence > 0.7) {
      this.logger.info({
        poolName,
        prediction,
      }, 'Traffic increasing, will preheat earlier');
    }
  }

  /**
   * 启动实时监控
   */
  startRealTimeMonitoring() {
    // 每分钟检查一次实时指标
    const job = cron.schedule('* * * * *', async () => {
      await this.monitorRealTimeMetrics();
    });

    this.scheduledJobs.push(job);
  }

  /**
   * 监控实时指标并动态调整
   */
  async monitorRealTimeMetrics() {
    const stats = this.poolManager.getStats();

    for (const [poolName, poolStats] of Object.entries(stats)) {
      const usage = poolStats.usage / 100; // 转换为比例
      const waiting = poolStats.waiting;

      // 检查是否需要立即扩容
      if (usage > this.config.maxUtilizationThreshold || waiting > 3) {
        await this.emergencyScaleUp(poolName, poolStats);
      }

      // 记录当前指标用于分析
      await this.recordTrafficMetric(poolName, poolStats);
    }
  }

  /**
   * 紧急扩容
   */
  async emergencyScaleUp(poolName, poolStats) {
    this.logger.warn({
      poolName,
      usage: poolStats.usage,
      waiting: poolStats.waiting,
    }, 'Emergency scale up triggered');

    const poolState = this.poolManager.pools.get(poolName);
    if (!poolState) return;

    const currentMax = poolState.pool.options.max;
    const newMax = Math.min(
      currentMax + 3,
      this.poolManager.config?.maxPoolLimit || 20
    );

    // 动态调整最大连接数
    poolState.pool.options.max = newMax;

    // 立即创建新连接
    const needed = newMax - currentMax;
    for (let i = 0; i < needed; i++) {
      try {
        const client = await poolState.pool.connect();
        client.release();
      } catch (err) {
        this.logger.error({ poolName, err }, 'Failed to create emergency connection');
      }
    }

    // 记录扩容事件
    await this.recordPreheatEvent(poolName, {
      type: 'emergency_scale_up',
      previousMax: currentMax,
      newMax,
      usage: poolStats.usage,
      waiting: poolStats.waiting,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 记录预热事件到 Redis
   */
  async recordPreheatEvent(poolName, event) {
    const key = `minego:preheat:events:${poolName}`;
    
    try {
      await this.redis.lpush(key, JSON.stringify(event));
      await this.redis.ltrim(key, 0, 99); // 保留最近100条记录
    } catch (err) {
      this.logger.error({ poolName, err }, 'Failed to record preheat event');
    }
  }

  /**
   * 记录流量指标
   */
  async recordTrafficMetric(poolName, poolStats) {
    const key = `minego:traffic:${poolName}`;
    const metric = {
      timestamp: new Date().toISOString(),
      qps: poolStats.acquired || 0, // 使用 acquire 计数作为 QPS 参考
      connections: poolStats.total,
      idle: poolStats.idle,
      waiting: poolStats.waiting,
      usage: poolStats.usage,
    };

    try {
      await this.redis.lpush(key, JSON.stringify(metric));
      
      // 保留7天数据（每小时一个数据点，约168个）
      await this.redis.ltrim(key, 0, 167);
    } catch (err) {
      this.logger.error({ poolName, err }, 'Failed to record traffic metric');
    }
  }

  /**
   * 获取预热统计信息
   */
  async getPreheatStats(poolName) {
    const eventKey = `minego:preheat:events:${poolName}`;
    const trafficKey = `minego:traffic:${poolName}`;

    try {
      const [events, traffic] = await Promise.all([
        this.redis.lrange(eventKey, 0, 9),
        this.redis.lrange(trafficKey, 0, 9),
      ]);

      return {
        recentEvents: events.map(e => JSON.parse(e)),
        recentTraffic: traffic.map(t => JSON.parse(t)),
        lastPreheat: this.lastPreheatTime.get(poolName),
      };
    } catch (err) {
      this.logger.error({ poolName, err }, 'Failed to get preheat stats');
      return null;
    }
  }
}

// ============================================================
// 自适应调节器
// ============================================================

class AdaptivePoolAdjuster {
  constructor(poolManager, preheater) {
    this.poolManager = poolManager;
    this.preheater = preheater;
    this.adjustmentHistory = new Map();
    this.logger = createLogger('adaptive-pool-adjuster');
  }

  /**
   * 根据实时负载动态调整连接池参数
   */
  async adjust(poolName) {
    const poolState = this.poolManager.pools.get(poolName);
    if (!poolState) return [];

    const stats = this.poolManager.getStats()[poolName];
    if (!stats) return [];

    const usage = stats.usage / 100;
    const waiting = stats.waiting;
    const idle = stats.idle;

    // 调整策略
    const adjustments = [];

    // 高负载：增加最小连接数
    if (usage > 0.7 && waiting > 0) {
      const newMin = Math.min(poolState.pool.options.min + 2, 10);
      adjustments.push({
        type: 'increase_min',
        from: poolState.pool.options.min,
        to: newMin,
        reason: 'High load detected',
      });
      poolState.pool.options.min = newMin;
    }

    // 低负载：减少最小连接数（节省资源）
    if (usage < 0.3 && idle > poolState.pool.options.min) {
      const newMin = Math.max(poolState.pool.options.min - 1, 2);
      adjustments.push({
        type: 'decrease_min',
        from: poolState.pool.options.min,
        to: newMin,
        reason: 'Low load detected',
      });
      poolState.pool.options.min = newMin;
    }

    // 记录调整历史
    if (adjustments.length > 0) {
      this.adjustmentHistory.set(poolName, {
        timestamp: Date.now(),
        adjustments,
      });

      this.logger.info({ poolName, adjustments }, 'Pool parameters adjusted');
    }

    return adjustments;
  }

  /**
   * 获取调整历史
   */
  getAdjustmentHistory(poolName) {
    return this.adjustmentHistory.get(poolName);
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  PoolPreheater,
  AdaptivePoolAdjuster,
  PREHEAT_CONFIG,
};