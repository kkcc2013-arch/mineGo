/**
 * DistributedLock Prometheus Metrics
 * 
 * 分布式锁的 Prometheus 指标定义
 * 
 * @module backend/shared/distributedLockMetrics
 */

'use strict';

let promClient;
try {
  promClient = require('prom-client');
} catch (e) {
  // 如果 prom-client 不可用，提供空操作实现
  promClient = {
    Counter: class { constructor() { this.inc = () => {}; } },
    Histogram: class { constructor() { this.observe = () => {}; } },
    Gauge: class { constructor() { this.inc = () => {}; this.dec = () => {}; this.set = () => {}; } },
    register: { getSingleMetric: () => null }
  };
}

/**
 * 检查指标是否已注册，避免重复注册
 */
function getOrCreateCounter(name, options) {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing;
  
  return new promClient.Counter({
    name,
    ...options
  });
}

function getOrCreateHistogram(name, options) {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing;
  
  return new promClient.Histogram({
    name,
    ...options
  });
}

function getOrCreateGauge(name, options) {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing;
  
  return new promClient.Gauge({
    name,
    ...options
  });
}

// 锁获取成功次数
const locksAcquired = getOrCreateCounter('minego_distributed_lock_acquired_total', {
  help: 'Total number of distributed locks acquired',
  labelNames: ['resource']
});

// 锁释放次数
const locksReleased = getOrCreateCounter('minego_distributed_lock_released_total', {
  help: 'Total number of distributed locks released',
  labelNames: ['resource']
});

// 锁获取失败次数
const locksFailed = getOrCreateCounter('minego_distributed_lock_failed_total', {
  help: 'Total number of failed lock acquisitions',
  labelNames: ['resource']
});

// 锁续期次数
const locksExtended = getOrCreateCounter('minego_distributed_lock_extended_total', {
  help: 'Total number of lock extensions',
  labelNames: ['resource']
});

// 锁等待时间
const lockWaitTime = getOrCreateHistogram('minego_distributed_lock_wait_time_ms', {
  help: 'Time spent waiting to acquire a lock',
  labelNames: ['resource'],
  buckets: [10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
});

// 锁持有时间
const lockHeldTime = getOrCreateHistogram('minego_distributed_lock_held_time_ms', {
  help: 'Time a lock was held',
  labelNames: ['resource'],
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000]
});

// 当前活跃锁数量
const activeLocks = getOrCreateGauge('minego_distributed_lock_active_count', {
  help: 'Number of currently active locks',
  labelNames: ['resource']
});

// 死锁检测次数
const deadlocksDetected = getOrCreateCounter('minego_distributed_lock_deadlock_detected_total', {
  help: 'Total number of deadlocks detected'
});

// 锁获取重试次数
const lockRetries = getOrCreateCounter('minego_distributed_lock_retry_total', {
  help: 'Total number of lock acquisition retries',
  labelNames: ['resource']
});

// Redis 实例健康状态
const redisInstanceHealth = getOrCreateGauge('minego_distributed_lock_redis_instance_health', {
  help: 'Health status of Redis instances (1 = healthy, 0 = unhealthy)',
  labelNames: ['server', 'index']
});

// 看门狗启动次数
const watchdogStarted = getOrCreateCounter('minego_distributed_lock_watchdog_started_total', {
  help: 'Total number of watchdogs started',
  labelNames: ['resource']
});

// 看门狗停止次数
const watchdogStopped = getOrCreateCounter('minego_distributed_lock_watchdog_stopped_total', {
  help: 'Total number of watchdogs stopped',
  labelNames: ['resource', 'reason']
});

module.exports = {
  // 计数器
  locksAcquired,
  locksReleased,
  locksFailed,
  locksExtended,
  lockRetries,
  deadlocksDetected,
  watchdogStarted,
  watchdogStopped,
  
  // 直方图
  lockWaitTime,
  lockHeldTime,
  
  // 仪表盘
  activeLocks,
  redisInstanceHealth,
  
  // 辅助函数
  incrementCounter: (name, labels = {}) => {
    switch (name) {
      case 'distributed_lock_acquired_total':
        locksAcquired.inc(labels);
        break;
      case 'distributed_lock_released_total':
        locksReleased.inc(labels);
        break;
      case 'distributed_lock_failed_total':
        locksFailed.inc(labels);
        break;
      case 'distributed_lock_extended_total':
        locksExtended.inc(labels);
        break;
      case 'distributed_lock_deadlock_detected_total':
        deadlocksDetected.inc();
        break;
    }
  },
  
  observeHistogram: (name, labels, value) => {
    switch (name) {
      case 'distributed_lock_wait_time_ms':
        lockWaitTime.observe(labels, value);
        break;
      case 'distributed_lock_held_time_ms':
        lockHeldTime.observe(labels, value);
        break;
    }
  }
};