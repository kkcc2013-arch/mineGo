/**
 * 任务状态聚合器 - 聚合所有定时任务的实时状态
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const Redis = require('ioredis');
const { EventEmitter } = require('events');

class JobStatusAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.redis = options.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.aggregateInterval = options.aggregateInterval || 30000; // 30秒聚合一次
    this.statusKey = 'minego:jobs:status';
    this.metadataKey = 'minego:jobs:metadata';
    this.jobs = new Map(); // 注册的任务
    this.aggregateTimer = null;
    this.isRunning = false;
  }

  /**
   * 启动聚合器
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // 启动定时聚合
    this.aggregateTimer = setInterval(() => {
      this.aggregate().catch(err => this.emit('error', err));
    }, this.aggregateInterval);

    // 首次立即聚合
    await this.aggregate();
    
    this.emit('started');
    console.log('[JobStatusAggregator] Started with interval', this.aggregateInterval, 'ms');
  }

  /**
   * 停止聚合器
   */
  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.aggregateTimer) {
      clearInterval(this.aggregateTimer);
      this.aggregateTimer = null;
    }

    await this.redis.quit();
    this.emit('stopped');
    console.log('[JobStatusAggregator] Stopped');
  }

  /**
   * 注册任务
   * @param {string} jobId 任务唯一标识
   * @param {string} jobName 任务名称
   * @param {string} schedule 调度表达式（cron）
   * @param {string} category 任务类别
   */
  async registerJob(jobId, jobName, schedule, category = 'general') {
    const jobMetadata = {
      id: jobId,
      name: jobName,
      schedule,
      category,
      registeredAt: new Date().toISOString(),
      lastRun: null,
      lastStatus: 'idle',
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0
    };

    this.jobs.set(jobId, jobMetadata);

    // 持久化到 Redis
    await this.redis.hset(this.metadataKey, jobId, JSON.stringify(jobMetadata));

    this.emit('registered', { jobId, jobName, category });
    console.log(`[JobStatusAggregator] Registered job: ${jobId} (${jobName})`);
  }

  /**
   * 注销任务
   * @param {string} jobId 任务唯一标识
   */
  async unregisterJob(jobId) {
    this.jobs.delete(jobId);
    await this.redis.hdel(this.metadataKey, jobId);
    await this.redis.hdel(this.statusKey, jobId);
    this.emit('unregistered', { jobId });
    console.log(`[JobStatusAggregator] Unregistered job: ${jobId}`);
  }

  /**
   * 上报任务状态
   * @param {string} jobId 任务唯一标识
   * @param {string} status 状态：idle | running | success | failed | timeout
   * @param {object} metadata 元数据
   */
  async reportStatus(jobId, status, metadata = {}) {
    const statusData = {
      jobId,
      status,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    // 更新 Redis 状态
    await this.redis.hset(this.statusKey, jobId, JSON.stringify(statusData));

    // 更新本地元数据
    const jobMeta = this.jobs.get(jobId);
    if (jobMeta) {
      jobMeta.lastStatus = status;
      jobMeta.lastRun = metadata.startTime || statusData.timestamp;

      if (status === 'success') {
        jobMeta.successCount++;
        this.updateAvgDuration(jobMeta, metadata.durationMs);
      } else if (status === 'failed') {
        jobMeta.failureCount++;
      }
      
      if (status !== 'idle') {
        jobMeta.runCount++;
      }

      await this.redis.hset(this.metadataKey, jobId, JSON.stringify(jobMeta));
    }

    this.emit('statusChange', { jobId, status, metadata: statusData });
  }

  /**
   * 更新平均执行时长
   */
  updateAvgDuration(jobMeta, durationMs) {
    if (!durationMs) return;
    const total = jobMeta.avgDurationMs * (jobMeta.successCount - 1) + durationMs;
    jobMeta.avgDurationMs = Math.round(total / jobMeta.successCount);
  }

  /**
   * 获取所有任务状态
   */
  async getAllJobsStatus() {
    const statusMap = await this.redis.hgetall(this.statusKey);
    const metadataMap = await this.redis.hgetall(this.metadataKey);
    
    const result = [];
    for (const [jobId, statusJson] of Object.entries(statusMap)) {
      const status = JSON.parse(statusJson);
      const metadata = metadataMap[jobId] ? JSON.parse(metadataMap[jobId]) : this.jobs.get(jobId) || {};
      
      result.push({
        ...metadata,
        currentStatus: status
      });
    }

    return result;
  }

  /**
   * 获取单个任务状态
   * @param {string} jobId 任务唯一标识
   */
  async getJobStatus(jobId) {
    const statusJson = await this.redis.hget(this.statusKey, jobId);
    const metadataJson = await this.redis.hget(this.metadataKey, jobId);

    return {
      ...JSON.parse(metadataJson || '{}'),
      currentStatus: statusJson ? JSON.parse(statusJson) : null
    };
  }

  /**
   * 按类别筛选任务
   * @param {string} category 任务类别
   */
  async getJobsByCategory(category) {
    const allJobs = await this.getAllJobsStatus();
    return allJobs.filter(job => job.category === category);
  }

  /**
   * 获取失败任务
   */
  async getFailedJobs() {
    const allJobs = await this.getAllJobsStatus();
    return allJobs.filter(job => 
      job.currentStatus && job.currentStatus.status === 'failed'
    );
  }

  /**
   * 获取正在运行的任务
   */
  async getRunningJobs() {
    const allJobs = await this.getAllJobsStatus();
    return allJobs.filter(job => 
      job.currentStatus && job.currentStatus.status === 'running'
    );
  }

  /**
   * 获取超时任务
   * @param {number} timeoutMinutes 超时阈值（分钟）
   */
  async getTimeoutJobs(timeoutMinutes = 30) {
    const runningJobs = await this.getRunningJobs();
    const timeoutThreshold = Date.now() - timeoutMinutes * 60 * 1000;
    
    return runningJobs.filter(job => {
      const startTime = new Date(job.currentStatus.startTime).getTime();
      return startTime < timeoutThreshold;
    });
  }

  /**
   * 获取统计数据
   */
  async getStatistics() {
    const allJobs = await this.getAllJobsStatus();
    
    const stats = {
      total: allJobs.length,
      running: 0,
      idle: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      byCategory: {}
    };

    for (const job of allJobs) {
      const status = job.currentStatus?.status || 'idle';
      stats[status] = (stats[status] || 0) + 1;

      // 按类别统计
      if (!stats.byCategory[job.category]) {
        stats.byCategory[job.category] = { total: 0, running: 0, idle: 0, success: 0, failed: 0 };
      }
      stats.byCategory[job.category].total++;
      stats.byCategory[job.category][status] = (stats.byCategory[job.category][status] || 0) + 1;
    }

    return stats;
  }

  /**
   * 执行状态聚合
   */
  async aggregate() {
    try {
      const status = await this.getAllJobsStatus();
      const stats = await this.getStatistics();
      
      this.emit('aggregated', {
        timestamp: new Date().toISOString(),
        jobs: status,
        statistics: stats
      });

      return { status, stats };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 获取已注册任务列表
   */
  getRegisteredJobs() {
    return Array.from(this.jobs.entries()).map(([id, meta]) => ({ id, ...meta }));
  }
}

module.exports = { JobStatusAggregator };
