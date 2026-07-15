/**
 * REQ-00555: 异常日志追踪 API 路由
 */

const express = require('express');
const ExceptionLogProcessor = require('./ExceptionLogProcessor');
const ExceptionFingerprintGenerator = require('./ExceptionFingerprintGenerator');

const router = express.Router();

// 全局实例（单例）
let processorInstance = null;

/**
 * 获取或创建处理器实例
 */
function getProcessor() {
  if (!processorInstance) {
    processorInstance = new ExceptionLogProcessor({
      clusterer: {
        windowSize: 300,
        similarityThreshold: 0.85,
        maxClusters: 1000
      },
      alertAggregator: {
        thresholds: {
          critical: { count: 1, windowSeconds: 60 },
          high: { count: 5, windowSeconds: 300 },
          medium: { count: 20, windowSeconds: 600 },
          low: { count: 50, windowSeconds: 1800 }
        },
        suppression: {
          maxAlertsPerHour: 100,
          duplicateSuppressionMinutes: 60
        }
      }
    });
  }
  return processorInstance;
}

/**
 * POST /api/exception-logs/ingest
 * 接收异常日志
 */
router.post('/ingest', async (req, res) => {
  try {
    const processor = getProcessor();
    const logs = Array.isArray(req.body) ? req.body : [req.body];
    
    const results = processor.processBatch(logs);
    
    res.json({
      success: true,
      processed: results.results.length,
      alertsTriggered: results.alerts.length,
      alerts: results.alerts.map(a => ({
        id: a.alertId,
        severity: a.severity,
        exceptionType: a.exceptionType
      }))
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/clusters
 * 获取聚类统计
 */
router.get('/clusters', async (req, res) => {
  try {
    const processor = getProcessor();
    const stats = processor.getClusterStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/clusters/:fingerprintId
 * 获取集群详情
 */
router.get('/clusters/:fingerprintId', async (req, res) => {
  try {
    const processor = getProcessor();
    const details = processor.getClusterDetails(req.params.fingerprintId);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Cluster not found'
      });
    }
    
    res.json({
      success: true,
      data: details
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/alerts
 * 获取告警历史
 */
router.get('/alerts', async (req, res) => {
  try {
    const processor = getProcessor();
    const { severity, since, limit } = req.query;
    
    const history = processor.getAlertHistory({
      severity,
      since,
      limit: parseInt(limit) || 50
    });
    
    res.json({
      success: true,
      data: history,
      count: history.length
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/stats
 * 获取处理统计
 */
router.get('/stats', async (req, res) => {
  try {
    const processor = getProcessor();
    const stats = processor.getProcessingStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/health
 * 健康检查
 */
router.get('/health', async (req, res) => {
  try {
    const processor = getProcessor();
    const health = processor.healthCheck();
    
    res.json({
      success: true,
      data: health
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/exception-logs/fingerprint
 * 手动生成指纹（调试用）
 */
router.post('/fingerprint', async (req, res) => {
  try {
    const generator = new ExceptionFingerprintGenerator();
    const fingerprint = generator.generateFingerprint(req.body);
    
    res.json({
      success: true,
      data: fingerprint
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/exception-logs/similarity
 * 计算两个日志的相似度（调试用）
 */
router.post('/similarity', async (req, res) => {
  try {
    const { log1, log2 } = req.body;
    const generator = new ExceptionFingerprintGenerator();
    
    const fp1 = generator.generateFingerprint(log1);
    const fp2 = generator.generateFingerprint(log2);
    const similarity = generator.calculateSimilarity(fp1, fp2);
    
    res.json({
      success: true,
      data: {
        fingerprint1: fp1,
        fingerprint2: fp2,
        similarity: {
          score: similarity,
          isSimilar: similarity >= 0.85
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/exception-logs/dashboard
 * 聚类详情展示页面数据
 */
router.get('/dashboard', async (req, res) => {
  try {
    const processor = getProcessor();
    const clusterStats = processor.getClusterStats();
    const processingStats = processor.getProcessingStats();
    const recentAlerts = processor.getAlertHistory({ limit: 10 });
    
    res.json({
      success: true,
      data: {
        overview: {
          totalClusters: clusterStats.totalClusters,
          totalMembers: clusterStats.totalMembers,
          totalAlerts: processingStats.alerts.total,
          logsProcessed: processingStats.logsProcessed,
          errorsProcessed: processingStats.errorsProcessed
        },
        topClusters: clusterStats.topClusters,
        recentAlerts,
        alertsBySeverity: {
          critical: recentAlerts.filter(a => a.severity === 'critical').length,
          high: recentAlerts.filter(a => a.severity === 'high').length,
          medium: recentAlerts.filter(a => a.severity === 'medium').length,
          low: recentAlerts.filter(a => a.severity === 'low').length
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = {
  router,
  getProcessor,
  ExceptionLogProcessor,
  ExceptionFingerprintGenerator
};