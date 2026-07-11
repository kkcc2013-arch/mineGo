/**
 * REQ-00538 单元测试：任务执行状态实时监控与智能告警系统
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const { JobStatusAggregator } = require('../shared/jobMonitor/jobStatusAggregator');
const { JobExecutionLogger } = require('../shared/jobMonitor/jobExecutionLogger');
const { SmartAlertEngine, NoiseSuppressor, AlertAggregator } = require('../shared/jobMonitor/smartAlertEngine');
const { JobHealthChecker } = require('../shared/jobMonitor/jobHealthChecker');
const { TrendAnalyzer } = require('../shared/jobMonitor/trendAnalyzer');

// Mock Redis
class MockRedis {
  constructor() {
    this.data = new Map();
  }

  async hset(key, field, value) {
    if (!this.data.has(key)) {
      this.data.set(key, new Map());
    }
    this.data.get(key).set(field, value);
  }

  async hget(key, field) {
    if (!this.data.has(key)) return null;
    return this.data.get(key).get(field);
  }

  async hgetall(key) {
    if (!this.data.has(key)) return {};
    const result = {};
    for (const [field, value] of this.data.get(key)) {
      result[field] = value;
    }
    return result;
  }

  async hdel(key, field) {
    if (!this.data.has(key)) return 0;
    return this.data.get(key).delete(field) ? 1 : 0;
  }

  async get(key) {
    return this.data.get(key);
  }

  async set(key, value, mode, duration) {
    this.data.set(key, value);
  }

  async del(key) {
    return this.data.delete(key) ? 1 : 0;
  }

  async zadd(key, score, member) {
    if (!this.data.has(key)) {
      this.data.set(key, []);
    }
    this.data.get(key).push({ score, member });
  }

  async zrangebyscore(key, min, max) {
    if (!this.data.has(key)) return [];
    return this.data.get(key)
      .filter(item => item.score >= min && item.score <= max)
      .map(item => item.member);
  }

  async zremrangebyscore(key, min, max) {
    if (!this.data.has(key)) return 0;
    const items = this.data.get(key);
    const removed = items.filter(item => item.score >= min && item.score <= max).length;
    this.data.set(key, items.filter(item => item.score < min || item.score > max));
    return removed;
  }

  async quit() {}
}

// Mock PostgreSQL Pool
class MockPool {
  constructor() {
    this.queryResults = [];
  }

  async query(sql, params) {
    return { rows: this.queryResults, rowCount: this.queryResults.length };
  }

  setResults(results) {
    this.queryResults = results;
  }

  async end() {}
}

describe('JobStatusAggregator', () => {
  let aggregator;
  let mockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    aggregator = new JobStatusAggregator({ redis: mockRedis, aggregateInterval: 5000 });
  });

  afterEach(async () => {
    if (aggregator.isRunning) {
      await aggregator.stop();
    }
  });

  it('should register a job correctly', async () => {
    await aggregator.registerJob('test-job-1', 'Test Job', '*/5 * * * *', 'general');

    expect(aggregator.jobs.has('test-job-1')).to.be.true;
    const job = aggregator.jobs.get('test-job-1');
    expect(job.name).to.equal('Test Job');
    expect(job.schedule).to.equal('*/5 * * * *');
    expect(job.category).to.equal('general');
  });

  it('should unregister a job correctly', async () => {
    await aggregator.registerJob('test-job-2', 'Test Job 2', '*/10 * * * *');
    expect(aggregator.jobs.has('test-job-2')).to.be.true;

    await aggregator.unregisterJob('test-job-2');
    expect(aggregator.jobs.has('test-job-2')).to.be.false;
  });

  it('should report job status correctly', async () => {
    await aggregator.registerJob('test-job-3', 'Test Job 3', '*/15 * * * *');

    await aggregator.reportStatus('test-job-3', 'running', {
      startTime: new Date().toISOString()
    });

    const status = await aggregator.getJobStatus('test-job-3');
    expect(status.currentStatus.status).to.equal('running');
    expect(status.lastStatus).to.equal('running');
  });

  it('should update statistics on success', async () => {
    await aggregator.registerJob('test-job-4', 'Test Job 4', '*/20 * * * *');

    await aggregator.reportStatus('test-job-4', 'success', {
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 5000
    });

    const job = aggregator.jobs.get('test-job-4');
    expect(job.successCount).to.equal(1);
    expect(job.runCount).to.equal(1);
    expect(job.avgDurationMs).to.equal(5000);
  });

  it('should get all jobs status', async () => {
    await aggregator.registerJob('job-a', 'Job A', '*/5 * * * *');
    await aggregator.registerJob('job-b', 'Job B', '*/10 * * * *');

    await aggregator.reportStatus('job-a', 'running', { startTime: new Date().toISOString() });
    await aggregator.reportStatus('job-b', 'idle', {});

    const allStatus = await aggregator.getAllJobsStatus();
    expect(allStatus.length).to.equal(2);
  });

  it('should get jobs by category', async () => {
    await aggregator.registerJob('job-cat-a', 'Job Cat A', '*/5 * * * *', 'backup');
    await aggregator.registerJob('job-cat-b', 'Job Cat B', '*/10 * * * *', 'cleanup');

    const backupJobs = await aggregator.getJobsByCategory('backup');
    expect(backupJobs.length).to.equal(1);
    expect(backupJobs[0].category).to.equal('backup');
  });

  it('should get failed jobs', async () => {
    await aggregator.registerJob('job-fail', 'Job Fail', '*/5 * * * *');
    await aggregator.registerJob('job-success', 'Job Success', '*/10 * * * *');

    await aggregator.reportStatus('job-fail', 'failed', { error: 'Test error' });
    await aggregator.reportStatus('job-success', 'success', {});

    const failedJobs = await aggregator.getFailedJobs();
    expect(failedJobs.length).to.equal(1);
    expect(failedJobs[0].id).to.equal('job-fail');
  });

  it('should get running jobs', async () => {
    await aggregator.registerJob('job-run', 'Job Running', '*/5 * * * *');
    await aggregator.registerJob('job-idle', 'Job Idle', '*/10 * * * *');

    await aggregator.reportStatus('job-run', 'running', { startTime: new Date().toISOString() });
    await aggregator.reportStatus('job-idle', 'idle', {});

    const runningJobs = await aggregator.getRunningJobs();
    expect(runningJobs.length).to.equal(1);
  });

  it('should calculate statistics correctly', async () => {
    await aggregator.registerJob('stat-1', 'Stat 1', '*/5 * * * *');
    await aggregator.registerJob('stat-2', 'Stat 2', '*/10 * * * *');

    await aggregator.reportStatus('stat-1', 'success', {});
    await aggregator.reportStatus('stat-2', 'running', {});

    const stats = await aggregator.getStatistics();
    expect(stats.total).to.equal(2);
    expect(stats.success).to.equal(1);
    expect(stats.running).to.equal(1);
  });
});

describe('NoiseSuppressor', () => {
  let suppressor;
  let mockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    suppressor = new NoiseSuppressor(mockRedis, 60000); // 1 minute window
  });

  it('should not suppress first alert', async () => {
    const shouldSuppress = await suppressor.shouldSuppress('test-alert-1');
    expect(shouldSuppress).to.be.false;
  });

  it('should suppress repeated alert within window', async () => {
    await suppressor.recordAlert('test-alert-2');
    
    // Immediately after recording, should suppress
    const shouldSuppress = await suppressor.shouldSuppress('test-alert-2');
    expect(shouldSuppress).to.be.true;
  });

  it('should reset suppression state', async () => {
    await suppressor.recordAlert('test-alert-3');
    await suppressor.reset('test-alert-3');

    const shouldSuppress = await suppressor.shouldSuppress('test-alert-3');
    expect(shouldSuppress).to.be.false;
  });
});

describe('AlertAggregator', () => {
  let aggregator;
  let mockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    aggregator = new AlertAggregator(mockRedis, 300000); // 5 minute window
  });

  it('should add pending alerts', async () => {
    await aggregator.add({ jobId: 'test', severity: 'high' });
    
    const aggregated = await aggregator.getAggregated();
    expect(aggregated).to.not.be.null;
    expect(aggregated.high.length).to.equal(1);
  });

  it('should aggregate alerts by severity', async () => {
    await aggregator.add({ jobId: 'test-1', severity: 'critical' });
    await aggregator.add({ jobId: 'test-2', severity: 'high' });
    await aggregator.add({ jobId: 'test-3', severity: 'medium' });

    const aggregated = await aggregator.getAggregated();
    expect(aggregated.critical.length).to.equal(1);
    expect(aggregated.high.length).to.equal(1);
    expect(aggregated.medium.length).to.equal(1);
  });
});

describe('SmartAlertEngine', () => {
  let engine;
  let mockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    engine = new SmartAlertEngine({ redis: mockRedis });
    engine.registerChannel('console', 'console', {});
  });

  afterEach(async () => {
    await engine.close();
  });

  it('should register channel correctly', () => {
    expect(engine.channels.has('console')).to.be.true;
  });

  it('should add alert rule', () => {
    engine.addAlertRule({
      jobId: 'test-rule-job',
      conditions: { failureCount: 1, consecutiveFailures: 3 },
      severity: 'high',
      channels: ['console']
    });

    expect(engine.rules.has('test-rule-job')).to.be.true;
  });

  it('should detect single failure', async () => {
    engine.addAlertRule({
      jobId: 'single-fail-job',
      conditions: { failureCount: 1 },
      severity: 'high',
      channels: ['console']
    });

    await engine.checkAndAlert('single-fail-job', {
      status: 'failed',
      error: 'Test error'
    });

    expect(engine.failureHistory.has('single-fail-job')).to.be.true;
  });

  it('should track consecutive failures', () => {
    engine.recordFailure('consecutive-job', { status: 'failed', error: 'Error 1' });
    engine.recordFailure('consecutive-job', { status: 'failed', error: 'Error 2' });
    engine.recordFailure('consecutive-job', { status: 'failed', error: 'Error 3' });

    const consecutive = engine.getConsecutiveFailures('consecutive-job');
    expect(consecutive).to.equal(3);
  });

  it('should generate alert message', () => {
    const message = engine.generateMessage('test-job', { jobName: 'Test Job' }, {
      type: 'consecutive_failures',
      count: 5
    });

    expect(message).to.include('Test Job');
    expect(message).to.include('5 times');
  });

  it('should analyze root cause', () => {
    engine.recordFailure('root-job', { status: 'failed', error: 'ECONNREFUSED connection error' });

    const suggestion = engine.analyzeRootCause('root-job', { type: 'single_failure' });
    expect(suggestion).to.include('Database');
  });
});

describe('JobHealthChecker', () => {
  let healthChecker;
  let mockAggregator;

  beforeEach(() => {
    mockAggregator = {
      getAllJobsStatus: async () => [
        { id: 'job-1', name: 'Job 1', currentStatus: { status: 'success' }, runCount: 10, successCount: 9, failureCount: 1, avgDurationMs: 5000, lastRun: new Date() },
        { id: 'job-2', name: 'Job 2', currentStatus: { status: 'failed' }, runCount: 10, successCount: 5, failureCount: 5, avgDurationMs: 10000, lastRun: new Date() },
        { id: 'job-3', name: 'Job 3', currentStatus: { status: 'running', startTime: new Date(Date.now() - 3600000).toISOString() }, runCount: 5, successCount: 4, failureCount: 1, avgDurationMs: 30000 }
      ],
      getJobStatus: async (jobId) => {
        const jobs = await mockAggregator.getAllJobsStatus();
        return jobs.find(j => j.id === jobId);
      }
    };

    healthChecker = new JobHealthChecker(mockAggregator);
  });

  it('should detect zombie jobs', async () => {
    healthChecker.setTimeoutThreshold('job-3', 30); // 30 minutes timeout

    // Job 3 started 1 hour ago (3600000 ms)
    const zombies = await healthChecker.detectZombieJobs();
    
    expect(zombies.length).to.equal(1);
    expect(zombies[0].jobId).to.equal('job-3');
    expect(zombies[0].runningMinutes).to.be.above(30);
  });

  it('should detect stale jobs', async () => {
    healthChecker.setStaleThreshold('stale-job', 60);

    // Add a job with very old lastRun
    mockAggregator.getAllJobsStatus = async () => [
      { id: 'stale-job', name: 'Stale Job', lastRun: new Date(Date.now() - 7200000), registeredAt: new Date(Date.now() - 7200000), runCount: 1, successCount: 1, failureCount: 0 }
    ];

    const staleJobs = await healthChecker.detectStaleJobs(60);
    expect(staleJobs.length).to.equal(1);
  });

  it('should detect high failure rate jobs', async () => {
    const highFailureJobs = await healthChecker.detectHighFailureRateJobs(0.3, 10);
    
    // Job 2 has 50% failure rate (5/10)
    expect(highFailureJobs.length).to.equal(1);
    expect(highFailureJobs[0].jobId).to.equal('job-2');
  });

  it('should calculate health score', async () => {
    // Mock job with good stats
    mockAggregator.getJobStatus = async () => ({
      id: 'healthy-job',
      name: 'Healthy Job',
      currentStatus: { status: 'success' },
      runCount: 100,
      successCount: 95,
      failureCount: 5,
      avgDurationMs: 5000,
      lastRun: new Date()
    });

    const score = await healthChecker.calculateHealthScore('healthy-job');
    
    expect(score.score).to.be.above(80);
    expect(score.grade).to.equal('A');
  });

  it('should return grade correctly', () => {
    expect(healthChecker.getGrade(95)).to.equal('A');
    expect(healthChecker.getGrade(85)).to.equal('B');
    expect(healthChecker.getGrade(75)).to.equal('C');
    expect(healthChecker.getGrade(65)).to.equal('D');
    expect(healthChecker.getGrade(55)).to.equal('E');
    expect(healthChecker.getGrade(45)).to.equal('F');
  });

  it('should provide recommendations', () => {
    const recommendation = healthChecker.getRecommendation(50, [
      { name: 'successRate', value: 0.5, weight: 40, contribution: 20 }
    ]);

    expect(recommendation).to.have.length.above(0);
    expect(recommendation[0]).to.include('Investigate');
  });
});

describe('TrendAnalyzer', () => {
  let analyzer;
  let mockPool;

  beforeEach(() => {
    mockPool = new MockPool();
    analyzer = new TrendAnalyzer({ pool: mockPool });
  });

  afterEach(async () => {
    await analyzer.close();
  });

  it('should get success rate trend', async () => {
    mockPool.setResults([
      { period_start: new Date('2026-07-01'), total_runs: '10', success_count: '9', failure_count: '1', success_rate: '90.00' },
      { period_start: new Date('2026-07-02'), total_runs: '10', success_count: '8', failure_count: '2', success_rate: '80.00' }
    ]);

    const trend = await analyzer.getSuccessRateTrend('test-job');
    
    expect(trend.data.length).to.equal(2);
    expect(trend.data[0].successRate).to.equal(90);
  });

  it('should get duration trend', async () => {
    mockPool.setResults([
      { period_start: new Date('2026-07-01'), run_count: '10', avg_duration_ms: '5000', min_duration_ms: '1000', max_duration_ms: '10000', median_duration_ms: '4500', p95_duration_ms: '9000' }
    ]);

    const trend = await analyzer.getDurationTrend('test-job');
    
    expect(trend.data.length).to.equal(1);
    expect(trend.data[0].avgDurationMs).to.equal(5000);
  });

  it('should get failure type distribution', async () => {
    mockPool.setResults([
      { error_type: 'Connection timeout', count: '5', first_seen: new Date(), last_seen: new Date() },
      { error_type: 'Disk full', count: '3', first_seen: new Date(), last_seen: new Date() }
    ]);

    const distribution = await analyzer.getFailureTypeDistribution('test-job');
    
    expect(distribution.total).to.equal(8);
    expect(distribution.distribution.length).to.equal(2);
  });

  it('should predict next execution', async () => {
    mockPool.setResults([
      { start_time: new Date(), duration_ms: '5000', status: 'success' },
      { start_time: new Date(), duration_ms: '6000', status: 'success' },
      { start_time: new Date(), duration_ms: '5500', status: 'success' }
    ]);

    const prediction = await analyzer.predictNextExecution('test-job');
    
    expect(prediction.prediction).to.not.be.null;
    expect(prediction.confidence).to.be.above(0);
  });
});

describe('JobExecutionLogger', () => {
  let logger;
  let mockPool;

  beforeEach(() => {
    mockPool = new MockPool();
    logger = new JobExecutionLogger({ pool: mockPool });
    logger.isInitialized = true; // Skip initialization
  });

  afterEach(async () => {
    await logger.close();
  });

  it('should log execution', async () => {
    mockPool.setResults([{ id: 1 }]);
    
    const logId = await logger.log({
      jobId: 'test-job',
      jobName: 'Test Job',
      category: 'general',
      status: 'success',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 5000
    });
    
    expect(logId).to.equal(1);
  });

  it('should get history', async () => {
    mockPool.setResults([
      { id: 1, job_id: 'test-job', status: 'success', start_time: new Date() },
      { id: 2, job_id: 'test-job', status: 'failed', start_time: new Date() }
    ]);

    const history = await logger.getHistory('test-job', { limit: 10 });
    
    expect(history.length).to.equal(2);
  });

  it('should get statistics', async () => {
    mockPool.setResults([
      { total_runs: '100', success_count: '95', failure_count: '5', timeout_count: '0', avg_duration_ms: '5000', success_rate: '0.95' }
    ]);

    const stats = await logger.getStatistics('test-job');
    
    expect(stats.total_runs).to.equal('100');
    expect(stats.success_count).to.equal('95');
  });
});

describe('Integration Tests', () => {
  it('should integrate all components for end-to-end alert flow', async () => {
    const mockRedis = new MockRedis();
    
    // Create aggregator
    const aggregator = new JobStatusAggregator({ redis: mockRedis });
    await aggregator.registerJob('integration-job', 'Integration Test Job', '*/5 * * * *', 'test');

    // Create health checker
    const healthChecker = new JobHealthChecker(aggregator);
    
    // Report status
    await aggregator.reportStatus('integration-job', 'failed', {
      startTime: new Date().toISOString(),
      error: 'Test integration error'
    });

    // Check failure history
    const failedJobs = await aggregator.getFailedJobs();
    expect(failedJobs.length).to.equal(1);

    // Verify status updated
    const status = await aggregator.getJobStatus('integration-job');
    expect(status.lastStatus).to.equal('failed');
  });
});

// Run tests
if (require.main === module) {
  const mocha = new (require('mocha'))();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exit(failures ? 1 : 0);
  });
}

module.exports = {
  MockRedis,
  MockPool
};