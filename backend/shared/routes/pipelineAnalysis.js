/**
 * Pipeline Analysis Routes
 * CI/CD 管道依赖分析 API 端点
 * 
 * REQ-00287: CI/CD 管道执行依赖分析与并行优化系统
 */

const express = require('express');
const router = express.Router();
const PipelineDependencyAnalyzer = require('../jobs/pipelineDependencyAnalyzer');
const PipelineParallelOptimizer = require('../jobs/pipelineParallelOptimizer');
const PipelineExecutionHistory = require('../jobs/pipelineExecutionHistory');

// 项目根目录路径
const getProjectRoot = () => {
  // 尝试不同的路径
  const possiblePaths = [
    '/data/mineGo',
    process.cwd(),
    path.join(process.cwd(), '..'),
    path.join(__dirname, '..', '..')
  ];
  
  for (const p of possiblePaths) {
    try {
      if (require('fs').existsSync(path.join(p, '.github', 'workflows'))) {
        return p;
      }
    } catch (e) {
      // 继续尝试下一个路径
    }
  }
  
  return process.cwd();
};

const path = require('path');

/**
 * GET /api/v1/pipeline/analysis
 * 获取完整的依赖分析报告
 */
router.get('/analysis', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    const report = await analyzer.generateReport();
    
    res.json({
      success: true,
      data: report,
      meta: {
        projectRoot,
        analyzedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * GET /api/v1/pipeline/dependency-graph
 * 获取依赖图（Mermaid 格式）
 */
router.get('/dependency-graph', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    res.json({
      success: true,
      data: {
        mermaid: analyzer.generateMermaidGraph(),
        nodes: Array.from(analyzer.dependencyGraph.entries()).map(([file, node]) => ({
          file,
          name: node.workflow.name,
          level: node.level,
          dependsOn: node.dependsOn,
          dependedBy: node.dependedBy
        })),
        levels: analyzer.identifyParallelizableWorkflows()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/optimization-suggestions
 * 获取优化建议
 */
router.get('/optimization-suggestions', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const suggestions = analyzer.generateOptimizationSuggestions();
    
    // 按优先级排序
    const sorted = suggestions.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
    
    res.json({
      success: true,
      data: {
        suggestions: sorted,
        count: sorted.length,
        criticalIssues: sorted.filter(s => s.priority === 'critical').length,
        highPriority: sorted.filter(s => s.priority === 'high').length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/parallel-optimization
 * 获取并行优化方案
 */
router.get('/parallel-optimization', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const optimizer = new PipelineParallelOptimizer(analyzer);
    const report = optimizer.generateOptimizationReport();
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/execution-history
 * 获取执行历史
 */
router.get('/execution-history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = new PipelineExecutionHistory();
    const report = await history.generateHistoryReport(days);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/workflows
 * 获取所有工作流列表
 */
router.get('/workflows', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    
    res.json({
      success: true,
      data: {
        workflows: Array.from(analyzer.workflows.entries()).map(([file, workflow]) => ({
          file,
          name: workflow.name,
          triggers: workflow.triggers,
          jobs: workflow.jobs.length,
          estimatedTime: analyzer.estimateExecutionTime(file)
        })),
        count: analyzer.workflows.size
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/critical-path
 * 获取关键路径分析
 */
router.get('/critical-path', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const criticalPath = analyzer.findCriticalPath();
    
    res.json({
      success: true,
      data: {
        path: criticalPath.nodes,
        totalTime: criticalPath.totalTime,
        bottleneck: criticalPath.nodes.length > 0 ? criticalPath.nodes[criticalPath.nodes.length - 1] : null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/cost-estimate
 * 获取成本估算
 */
router.get('/cost-estimate', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const optimizer = new PipelineParallelOptimizer(analyzer);
    const costSaving = optimizer.calculateCostSaving();
    
    res.json({
      success: true,
      data: {
        current: {
          sequentialTime: costSaving.sequentialTime,
          monthlyCost: costSaving.sequentialTime * 0.008 * 30,
          annualCost: costSaving.sequentialTime * 0.008 * 365
        },
        optimized: {
          parallelTime: costSaving.parallelTime,
          monthlyCost: costSaving.parallelTime * 0.008 * 30,
          annualCost: costSaving.parallelTime * 0.008 * 365
        },
        savings: {
          time: costSaving.savedMinutes,
          monthly: costSaving.savedCostMonthly,
          annual: costSaving.savedCostMonthly * 12
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/pipeline/report
 * 获取综合报告
 */
router.get('/report', async (req, res) => {
  try {
    const projectRoot = getProjectRoot();
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    
    const analyzer = new PipelineDependencyAnalyzer(workflowsDir);
    const analysisReport = await analyzer.generateReport();
    
    const optimizer = new PipelineParallelOptimizer(analyzer);
    const optimizationReport = optimizer.generateOptimizationReport();
    
    const history = new PipelineExecutionHistory();
    const historyReport = await history.generateHistoryReport(30);
    
    const combinedReport = {
      generatedAt: new Date().toISOString(),
      analysis: analysisReport,
      optimization: optimizationReport,
      history: historyReport,
      health: {
        hasCycles: analysisReport.cycles.length > 0 ? 'critical' : 'ok',
        parallelizationPotential: optimizationReport.summary.parallelizableGroups > 0 ? 'optimizable' : 'optimized',
        executionHealth: parseFloat(historyReport.summary.successRate) > 90 ? 'healthy' : 'needs_attention'
      }
    };
    
    res.json({
      success: true,
      data: combinedReport
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;