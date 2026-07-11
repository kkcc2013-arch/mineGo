/**
 * 任务健康检查器 - 检测僵尸任务、超时任务、长期未运行任务
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const { EventEmitter } = require('events');

class JobHealthChecker extends EventEmitter {
  constructor(aggregator, options = {}) {
    super();
    this.aggregator = aggregator;
    this.defaultTimeoutMinutes = options.defaultTimeoutMinutes || 30;
    this.defaultStaleMinutes = options.defaultStaleMinutes || 60;
    this.timeoutThresholds = new Map(); // 各任务超时阈值
    this.staleThresholds = new Map(); // 各任务静默阈值
    this.healthScores = new Map(); // 健康评分缓存
  }

  /**
   * 设置任务超时阈值
   * @param {string} jobId 任务ID
   * @param {number} minutes 超时分钟数
   */
  setTimeoutThreshold(jobId, minutes) {
    this.timeoutThresholds.set(jobId, minutes);
  }

  /**
   * 设置任务静默阈值
   * @param {string} jobId 任务ID
   * @param {number} minutes 静默分钟数
   */
  setStaleThreshold(jobId, minutes) {
    this.staleThresholds.set(jobId, minutes);
  }

  /**
   * 检测僵尸任务（运行超过阈值）
   */
  async detectZombieJobs() {
    const allJobs = await this.aggregator.getAllJobsStatus();
    const zombieJobs = [];

    for (const job of allJobs) {
      if (!job.currentStatus || job.currentStatus.status !== 'running') continue;

      const startTime = new Date(job.currentStatus.startTime).getTime();
      if (!startTime) continue;

      const timeoutMinutes = this.timeoutThresholds.get(job.id) || this.defaultTimeoutMinutes;
      const runningMinutes = (Date.now() - startTime) / 60000;

      if (runningMinutes > timeoutMinutes) {
        zombieJobs.push({
          jobId: job.id,
          jobName: job.name,
          startTime: job.currentStatus.startTime,
          runningMinutes: Math.round(runningMinutes),
          timeoutThreshold: timeoutMinutes,
          severity: runningMinutes > timeoutMinutes * 2 ? 'critical' : 'high'
        });

        this.emit('zombieDetected', zombieJobs[zombieJobs.length - 1]);
      }
    }

    return zombieJobs;
  }

  /**
   * 检测长期未运行的任务
   * @param {number} staleMinutes 静默阈值
   */
  async detectStaleJobs(staleMinutes = null) {
    const allJobs = await this.aggregator.getAllJobsStatus();
    const staleJobs = [];

    for (const job of allJobs) {
      const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : null;
      const threshold = staleMinutes || this.staleThresholds.get(job.id) || this.defaultStaleMinutes;

      // 从未运行过
      if (!lastRun) {
        const registeredAt = new Date(job.registeredAt).getTime();
        const idleMinutes = (Date.now() - registeredAt) / 60000;

        if (idleMinutes > threshold) {
          staleJobs.push({
            jobId: job.id,
            jobName: job.name,
            lastRun: null,
            idleMinutes: Math.round(idleMinutes),
            reason: 'never_run',
            severity: 'medium'
          });
        }
        continue;
      }

      const idleMinutes = (Date.now() - lastRun) / 60000;

      if (idleMinutes > threshold) {
        staleJobs.push({
          jobId: job.id,
          jobName: job.name,
          lastRun: job.lastRun,
          idleMinutes: Math.round(idleMinutes),
          staleThreshold: threshold,
          reason: 'stale',
          severity: idleMinutes > threshold * 2 ? 'high' : 'medium'
        });

        this.emit('staleDetected', staleJobs[staleJobs.length - 1]);
      }
    }

    return staleJobs;
  }

  /**
   * 检测失败率过高的任务
   * @param {number} threshold 失败率阈值（0-1）
   * @param {number} minRuns 最小运行次数
   */
  async detectHighFailureRateJobs(threshold = 0.3, minRuns = 10) {
    const allJobs = await this.aggregator.getAllJobsStatus();
    const highFailureJobs = [];

    for (const job of allJobs) {
      if (job.runCount < minRuns) continue;

      const failureRate = job.failureCount / job.runCount;

      if (failureRate > threshold) {
        highFailureJobs.push({
          jobId: job.id,
          jobName: job.name,
          runCount: job.runCount,
          failureCount: job.failureCount,
          successCount: job.successCount,
          failureRate: Math.round(failureRate * 100),
          severity: failureRate > 0.5 ? 'critical' : 'high'
        });

        this.emit('highFailureRateDetected', highFailureJobs[highFailureJobs.length - 1]);
      }
    }

    return highFailureJobs;
  }

  /**
   * 计算健康评分（0-100）
   * @param {string} jobId 任务ID
   */
  async calculateHealthScore(jobId) {
    const job = await this.aggregator.getJobStatus(jobId);
    
    if (!job || !job.id) {
      return { jobId, score: 0, reason: 'not_found' };
    }

    // 基础评分
    let score = 100;
    const factors = [];

    // 成功率影响（权重 40%）
    const totalRuns = job.runCount || 0;
    const successRate = totalRuns > 0 ? (job.successCount || 0) / totalRuns : 1;
    const successFactor = Math.round(successRate * 40);
    score -= (40 - successFactor);
    factors.push({ name: 'successRate', value: successRate, weight: 40, contribution: successFactor });

    // 执行时长影响（权重 20%）
    const avgDuration = job.avgDurationMs || 0;
    const expectedDuration = this.getExpectedDuration(jobId);
    const durationRatio = expectedDuration > 0 ? Math.min(avgDuration / expectedDuration, 1) : 0.5;
    const durationFactor = Math.round((1 - durationRatio) * 20);
    score -= (20 - durationFactor);
    factors.push({ name: 'avgDuration', value: avgDuration, weight: 20, contribution: durationFactor });

    // 最近状态影响（权重 30%）
    const currentStatus = job.currentStatus?.status || 'idle';
    let statusFactor = 30;
    if (currentStatus === 'failed') {
      statusFactor = 0;
    } else if (currentStatus === 'timeout') {
      statusFactor = 10;
    } else if (currentStatus === 'running') {
      // 检查是否超时
      const isZombie = await this.isJobZombie(jobId);
      statusFactor = isZombie ? 10 : 25;
    } else if (currentStatus === 'success') {
      statusFactor = 30;
    }
    score -= (30 - statusFactor);
    factors.push({ name: 'currentStatus', value: currentStatus, weight: 30, contribution: statusFactor });

    // 静默度影响（权重 10%）
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : null;
    let staleFactor = 10;
    if (lastRun) {
      const idleMinutes = (Date.now() - lastRun) / 60000;
      const staleThreshold = this.staleThresholds.get(jobId) || this.defaultStaleMinutes;
      if (idleMinutes > staleThreshold) {
        staleFactor = Math.max(0, 10 - Math.floor(idleMinutes / staleThreshold) * 3);
      }
    } else {
      staleFactor = 5; // 从未运行
    }
    score -= (10 - staleFactor);
    factors.push({ name: 'staleness', value: lastRun, weight: 10, contribution: staleFactor });

    // 确保评分在 0-100 范围内
    score = Math.max(0, Math.min(100, score));

    // 缓存评分
    this.healthScores.set(jobId, {
      jobId,
      jobName: job.name,
      score,
      factors,
      timestamp: Date.now()
    });

    return {
      jobId,
      jobName: job.name,
      score,
      grade: this.getGrade(score),
      factors,
      recommendation: this.getRecommendation(score, factors)
    };
  }

  /**
   * 批量计算所有任务健康评分
   */
  async calculateAllHealthScores() {
    const allJobs = await this.aggregator.getAllJobsStatus();
    const scores = [];

    for (const job of allJobs) {
      try {
        const score = await this.calculateHealthScore(job.id);
        scores.push(score);
      } catch (error) {
        console.error(`[JobHealthChecker] Failed to calculate score for ${job.id}:`, error);
      }
    }

    // 按评分排序
    scores.sort((a, b) => a.score - b.score);

    return scores;
  }

  /**
   * 获取预期执行时长（可自定义）
   */
  getExpectedDuration(jobId) {
    // 根据任务类型设置预期时长
    const defaults = {
      'backup-*': 600000, // 10分钟
      'cleanup-*': 300000, // 5分钟
      'index-*': 180000, // 3分钟
      'partition-*': 120000, // 2分钟
      '*': 60000 // 默认 1分钟
    };

    for (const [pattern, duration] of Object.entries(defaults)) {
      if (pattern.endsWith('*') && jobId.startsWith(pattern.slice(0, -1))) {
        return duration;
      }
      if (pattern === jobId) {
        return duration;
      }
    }

    return 60000; // 默认 1分钟
  }

  /**
   * 检查任务是否僵尸
   */
  async isJobZombie(jobId) {
    const job = await this.aggregator.getJobStatus(jobId);
    
    if (!job.currentStatus || job.currentStatus.status !== 'running') {
      return false;
    }

    const startTime = new Date(job.currentStatus.startTime).getTime();
    if (!startTime) return false;

    const timeoutMinutes = this.timeoutThresholds.get(jobId) || this.defaultTimeoutMinutes;
    const runningMinutes = (Date.now() - startTime) / 60000;

    return runningMinutes > timeoutMinutes;
  }

  /**
   * 获取评分等级
   */
  getGrade(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    if (score >= 50) return 'E';
    return 'F';
  }

  /**
   * 获取健康建议
   */
  getRecommendation(score, factors) {
    const recommendations = [];

    for (const factor of factors) {
      if (factor.contribution < factor.weight * 0.5) {
        switch (factor.name) {
          case 'successRate':
            recommendations.push('Investigate recent failures and check error logs.');
            break;
          case 'avgDuration':
            recommendations.push('Optimize task execution time or increase timeout.');
            break;
          case 'currentStatus':
            if (factor.value === 'failed') {
              recommendations.push('Task currently failed. Restart or investigate root cause.');
            } else if (factor.value === 'running') {
              recommendations.push('Task is running long. Check if zombie or legitimately slow.');
            }
            break;
          case 'staleness':
            recommendations.push('Task has not run recently. Check scheduling configuration.');
            break;
        }
      }
    }

    return recommendations.length > 0 ? recommendations : ['No action needed.'];
  }

  /**
   * 获取健康检查摘要
   */
  async getHealthSummary() {
    const scores = await this.calculateAllHealthScores();
    const zombies = await this.detectZombieJobs();
    const stale = await this.detectStaleJobs();
    const highFailure = await this.detectHighFailureRateJobs();

    return {
      totalJobs: scores.length,
      averageScore: scores.length > 0 
        ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
        : 0,
      healthyCount: scores.filter(s => s.score >= 80).length,
      warningCount: scores.filter(s => s.score >= 60 && s.score < 80).length,
      criticalCount: scores.filter(s => s.score < 60).length,
      zombieJobs: zombies.length,
      staleJobs: stale.length,
      highFailureJobs: highFailure.length,
      details: {
        zombies,
        stale,
        highFailure,
        worstJobs: scores.slice(0, 5) // 最不健康的5个任务
      }
    };
  }
}

module.exports = { JobHealthChecker };