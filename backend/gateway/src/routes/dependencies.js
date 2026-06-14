/**
 * Dependencies API Routes
 * 提供微服务依赖关系查询接口
 */

const express = require('express');
const router = express.Router();
const { DependencyAnalyzer } = require('../../../shared/dependencyAnalyzer');

// 缓存依赖分析结果（每小时刷新）
let cachedAnalysis = null;
let lastAnalysisTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 小时

/**
 * 获取或刷新分析结果
 */
async function getAnalysis() {
  const now = Date.now();
  if (!cachedAnalysis || (now - lastAnalysisTime) > CACHE_TTL) {
    const analyzer = new DependencyAnalyzer();
    cachedAnalysis = await analyzer.analyzeAll();
    lastAnalysisTime = now;
  }
  return cachedAnalysis;
}

/**
 * GET /api/admin/dependencies
 * 获取完整依赖图
 */
router.get('/', async (req, res) => {
  try {
    const analysis = await getAnalysis();
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze dependencies',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/dependencies/:service
 * 获取单个服务的依赖详情
 */
router.get('/:service', async (req, res) => {
  try {
    const { service } = req.params;
    const analyzer = new DependencyAnalyzer();
    
    // 先执行完整分析
    await analyzer.analyzeAll();
    
    // 获取单个服务的依赖
    const serviceDeps = analyzer.getServiceDependencies(service);
    
    res.json({
      success: true,
      data: serviceDeps
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get service dependencies',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/dependencies/cycles
 * 检测循环依赖
 */
router.get('/cycles', async (req, res) => {
  try {
    const analysis = await getAnalysis();
    
    res.json({
      success: true,
      data: {
        has_cycles: analysis.cycles.length > 0,
        cycles: analysis.cycles,
        count: analysis.cycles.length,
        recommendation: analysis.cycles.length > 0
          ? 'CRITICAL: Circular dependencies detected. This may cause cascading failures.'
          : 'OK: No circular dependencies detected.'
      }
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to detect cycles',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/dependencies/startup-order
 * 获取服务启动顺序
 */
router.get('/startup-order', async (req, res) => {
  try {
    const analysis = await getAnalysis();
    
    res.json({
      success: true,
      data: {
        startup_order: analysis.startupOrder,
        total_services: analysis.startupOrder.length,
        recommendation: 'Start services in the specified order to avoid dependency failures.'
      }
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get startup order',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/dependencies/graph
 * 获取 Mermaid 格式依赖图
 */
router.get('/graph', async (req, res) => {
  try {
    const format = req.query.format || 'mermaid';
    const analyzer = new DependencyAnalyzer();
    await analyzer.analyzeAll();
    
    let graph;
    if (format === 'dot') {
      graph = analyzer.generateDotGraph();
      res.set('Content-Type', 'text/plain');
    } else {
      graph = analyzer.generateMermaidGraph();
      res.set('Content-Type', 'text/plain');
    }
    
    res.send(graph);
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate dependency graph',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/dependencies/impact/:service
 * 分析服务故障影响范围
 */
router.get('/impact/:service', async (req, res) => {
  try {
    const { service } = req.params;
    const analyzer = new DependencyAnalyzer();
    await analyzer.analyzeAll();
    
    const impact = analyzer.analyzeImpact(service);
    
    res.json({
      success: true,
      data: impact
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze impact',
      message: error.message
    });
  }
});

/**
 * POST /api/admin/dependencies/refresh
 * 强制刷新依赖分析缓存
 */
router.post('/refresh', async (req, res) => {
  try {
    cachedAnalysis = null;
    lastAnalysisTime = 0;
    
    const analysis = await getAnalysis();
    
    res.json({
      success: true,
      message: 'Dependency analysis cache refreshed',
      data: {
        services: analysis.services.length,
        dependencies: analysis.dependencies.length,
        cycles: analysis.cycles.length
      }
    });
  } catch (error) {
    console.error('[Dependencies API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh analysis',
      message: error.message
    });
  }
});

module.exports = router;
