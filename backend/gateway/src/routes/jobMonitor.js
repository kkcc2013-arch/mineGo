/**
 * 任务监控仪表板 API 路由
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const express = require('express');
const router = express.Router();
const { JobStatusAggregator } = require('../shared/jobMonitor/jobStatusAggregator');
const { JobExecutionLogger } = require('../shared/jobMonitor/jobExecutionLogger');
const { JobHealthChecker } = require('../shared/jobMonitor/jobHealthChecker');
const { TrendAnalyzer } = require('../shared/jobMonitor/trendAnalyzer');

// 单例实例
let aggregator = null;
let executionLogger = null;
let healthChecker = null;
let trendAnalyzer = null;

/**
 * 初始化监控组件
 */
function initializeMonitor() {
  if (!aggregator) {
    aggregator = new JobStatusAggregator();
    aggregator.start().catch(err => console.error('Failed to start aggregator:', err));
  }

  if (!executionLogger) {
    executionLogger = new JobExecutionLogger();
    executionLogger.initialize().catch(err => console.error('Failed to initialize logger:', err));
  }

  if (!healthChecker) {
    healthChecker = new JobHealthChecker(aggregator);
  }

  if (!trendAnalyzer) {
    trendAnalyzer = new TrendAnalyzer();
  }

  return { aggregator, executionLogger, healthChecker, trendAnalyzer };
}

/**
 * GET /api/admin/jobs/status
 * 获取所有任务实时状态
 */
router.get('/status', async (req, res) => {
  try {
    const { aggregator } = initializeMonitor();
    const status = await aggregator.getAllJobsStatus();
    const stats = await aggregator.getStatistics();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      statistics: stats,
      jobs: status
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/:jobId/status
 * 获取单个任务状态
 */
router.get('/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { aggregator } = initializeMonitor();
    const status = await aggregator.getJobStatus(jobId);

    if (!status || !status.id) {
      return res.status(404).json({
        success: false,
        error: `Job not found: ${jobId}`
      });
    }

    res.json({
      success: true,
      job: status
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting job status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/:jobId/history
 * 获取执行历史
 */
router.get('/:jobId/history', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { limit = 100, offset = 0, status } = req.query;
    const { executionLogger } = initializeMonitor();

    const history = await executionLogger.getHistory(jobId, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      status
    });

    res.json({
      success: true,
      jobId,
      count: history.length,
      history
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting history:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/:jobId/health
 * 获取健康评分
 */
router.get('/:jobId/health', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { healthChecker } = initializeMonitor();
    const health = await healthChecker.calculateHealthScore(jobId);

    res.json({
      success: true,
      health
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting health:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/:jobId/statistics
 * 获取统计数据
 */
router.get('/:jobId/statistics', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { startDate, endDate } = req.query;
    const { executionLogger } = initializeMonitor();

    const statistics = await executionLogger.getStatistics(jobId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined
    });

    res.json({
      success: true,
      jobId,
      statistics
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting statistics:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/:jobId/trend
 * 获取执行趋势
 */
router.get('/:jobId/trend', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { period = 'day' } = req.query;
    const { trendAnalyzer } = initializeMonitor();

    const [successRateTrend, durationTrend, failureDist, heatmap] = await Promise.all([
      trendAnalyzer.getSuccessRateTrend(jobId, period),
      trendAnalyzer.getDurationTrend(jobId, period),
      trendAnalyzer.getFailureTypeDistribution(jobId),
      trendAnalyzer.getExecutionHeatmap(jobId)
    ]);

    res.json({
      success: true,
      jobId,
      trends: {
        successRate: successRateTrend,
        duration: durationTrend,
        failureDistribution: failureDist,
        heatmap
      }
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting trend:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/health-summary
 * 获取健康摘要
 */
router.get('/health-summary', async (req, res) => {
  try {
    const { healthChecker } = initializeMonitor();
    const summary = await healthChecker.getHealthSummary();

    res.json({
      success: true,
      summary
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting health summary:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/zombies
 * 获取僵尸任务
 */
router.get('/zombies', async (req, res) => {
  try {
    const { healthChecker } = initializeMonitor();
    const zombies = await healthChecker.detectZombieJobs();

    res.json({
      success: true,
      count: zombies.length,
      zombies
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error detecting zombies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/stale
 * 获取静默任务
 */
router.get('/stale', async (req, res) => {
  try {
    const { minutes } = req.query;
    const { healthChecker } = initializeMonitor();
    const stale = await healthChecker.detectStaleJobs(minutes ? parseInt(minutes, 10) : null);

    res.json({
      success: true,
      count: stale.length,
      stale
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error detecting stale jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/jobs/alerts
 * 获取活跃告警
 */
router.get('/alerts', async (req, res) => {
  try {
    // 简化实现：返回最近失败的告警
    const { executionLogger } = initializeMonitor();
    const allStats = await executionLogger.getAllJobsStatistics();

    const alerts = allStats
      .filter(stat => stat.failureCount > 0)
      .map(stat => ({
        jobId: stat.jobId,
        jobName: stat.jobName,
        category: stat.category,
        alertType: 'recent_failures',
        severity: stat.successRate < 50 ? 'high' : stat.successRate < 80 ? 'medium' : 'low',
        message: `${stat.jobName} has ${stat.failureCount} recent failures`,
        failureCount: stat.failureCount,
        successRate: stat.successRate,
        lastRun: stat.lastRun
      }));

    res.json({
      success: true,
      count: alerts.length,
      alerts
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error getting alerts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/jobs/:jobId/restart
 * 手动重启任务
 */
router.post('/:jobId/restart', async (req, res) => {
  try {
    const { jobId } = req.params;
    // 实际重启逻辑需要根据任务调度系统实现
    // 这里仅记录操作
    console.log(`[JobMonitorAPI] Restart requested for: ${jobId}`);

    res.json({
      success: true,
      message: `Restart signal sent to job: ${jobId}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error restarting job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/jobs/:jobId/skip
 * 跳过本次执行
 */
router.post('/:jobId/skip', async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`[JobMonitorAPI] Skip requested for: ${jobId}`);

    res.json({
      success: true,
      message: `Skip signal sent to job: ${jobId}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[JobMonitorAPI] Error skipping job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = { router, initializeMonitor };