// gateway/src/routes/costReport.js - 成本报告 API 路由
'use strict';
const express = require('express');
const router = express.Router();
const { CloudCostCollector, MockCostAdapter } = require('../../shared/cloudCostCollector');
const { BudgetManager } = require('../../shared/budgetManager');
const { CostPredictor } = require('../../shared/costPredictor');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('cost-report');

// 初始化采集器和预算管理器
const costCollector = new CloudCostCollector({ 
  mockMode: process.env.COST_MOCK_MODE !== 'false'
});
const budgetManager = new BudgetManager();

// 注册 Mock 适配器（用于测试）
if (process.env.COST_MOCK_MODE !== 'false') {
  costCollector.registerProvider('mock', new MockCostAdapter({ baseCost: 50 }));
}

// 初始化默认预算
budgetManager.addBudget({
  name: 'monthly-total',
  amount: 1000,
  currency: 'USD',
  period: 'monthly',
  scope: 'all',
  notifications: [
    { type: 'log', recipient: 'ops' }
  ]
});

budgetManager.addBudget({
  name: 'gateway-budget',
  amount: 200,
  currency: 'USD',
  period: 'monthly',
  scope: 'service',
  services: ['gateway']
});

// 存储历史数据（生产环境应使用数据库）
let historicalCosts = [];

/**
 * GET /api/costs/summary
 * 获取成本概览
 */
router.get('/summary', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    const costs = await costCollector.collectAllCosts();
    const byService = await costCollector.collectCostByService('default');
    
    const total = costs.reduce((sum, c) => sum + (c.total || 0), 0);
    
    // 更新历史数据
    historicalCosts.push({
      date: new Date().toISOString().split('T')[0],
      cost: total,
      timestamp: Date.now()
    });
    if (historicalCosts.length > 90) {
      historicalCosts = historicalCosts.slice(-90);
    }
    
    res.json({
      period,
      totalCost: Math.round(total * 100) / 100,
      currency: 'USD',
      byService: Object.entries(byService).map(([name, cost]) => ({
        name,
        ...(typeof cost === 'object' ? cost : { total: cost }),
        currency: 'USD'
      })),
      byProvider: costs.map(c => ({
        provider: c.provider,
        total: Math.round((c.total || 0) * 100) / 100,
        currency: 'USD'
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get cost summary');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/by-service
 * 按服务获取成本
 */
router.get('/by-service', async (req, res) => {
  try {
    const { namespace = 'default', days = 7 } = req.query;
    
    const costs = await costCollector.collectCostByService(namespace);
    
    const serviceList = Object.entries(costs).map(([name, cost]) => {
      const costData = typeof cost === 'object' ? cost : { total: cost, cpu: 0, memory: 0 };
      return {
        name,
        cpu: Math.round((costData.cpu || 0) * 100) / 100,
        memory: Math.round((costData.memory || 0) * 100) / 100,
        total: Math.round((costData.total || costData) * 100) / 100,
        currency: 'USD',
        monthlyProjection: Math.round((costData.total || costData) * 30 * 100) / 100
      };
    });
    
    res.json({
      namespace,
      period: `${days}d`,
      services: serviceList,
      totalCost: Math.round(serviceList.reduce((sum, s) => sum + s.total, 0) * 100) / 100,
      totalMonthlyProjection: Math.round(serviceList.reduce((sum, s) => sum + s.monthlyProjection, 0) * 100) / 100
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get service costs');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/budgets
 * 获取预算列表和状态
 */
router.get('/budgets', async (req, res) => {
  try {
    const costs = await costCollector.collectAllCosts();
    const status = await budgetManager.checkBudgetStatus(costs);
    
    const budgets = budgetManager.getAllBudgets();
    
    res.json({
      budgets: status,
      summary: {
        totalBudget: budgets.reduce((sum, b) => sum + b.amount, 0),
        totalSpent: status.reduce((sum, s) => sum + s.spent, 0),
        budgetCount: budgets.length,
        exceededCount: status.filter(s => s.status === 'exceeded').length,
        warningCount: status.filter(s => s.status === 'warning').length
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get budgets');
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/budgets
 * 创建新预算
 */
router.post('/budgets', async (req, res) => {
  try {
    const { name, amount, period, scope, services, notifications } = req.body;
    
    if (!name || !amount) {
      return res.status(400).json({ error: 'name and amount are required' });
    }
    
    const budget = budgetManager.addBudget({
      name,
      amount: parseFloat(amount),
      currency: req.body.currency || 'USD',
      period: period || 'monthly',
      scope: scope || 'all',
      services: services || [],
      namespaces: req.body.namespaces || [],
      notifications: notifications || []
    });
    
    logger.info({ budget: name, amount }, 'Budget created');
    
    res.status(201).json({ 
      message: 'Budget created', 
      budget: {
        name: budget.name,
        amount: budget.amount,
        period: budget.period,
        scope: budget.scope
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create budget');
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/budgets/:name
 * 删除预算
 */
router.delete('/budgets/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const removed = budgetManager.removeBudget(name);
    
    if (removed) {
      logger.info({ budget: name }, 'Budget removed');
      res.json({ message: 'Budget removed', name });
    } else {
      res.status(404).json({ error: 'Budget not found' });
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to remove budget');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/prediction
 * 获取成本预测
 */
router.get('/prediction', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    // 使用历史数据
    const predictor = new CostPredictor(historicalCosts);
    
    const linear = predictor.predictLinearRegression(parseInt(days));
    const movingAvg = predictor.predictMovingAverage(7, parseInt(days));
    const anomalies = predictor.detectAnomalies();
    const trend = predictor.getTrendAnalysis();
    
    // 获取优化建议
    const serviceCosts = await costCollector.collectCostByService('default');
    const suggestions = predictor.generateOptimizationSuggestions(serviceCosts);
    
    res.json({
      prediction: {
        linearRegression: linear,
        movingAverage: movingAvg,
        trend
      },
      anomalies,
      optimizationSuggestions: suggestions,
      potentialMonthlySaving: suggestions.reduce((sum, s) => sum + s.potentialSaving, 0),
      dataPoints: historicalCosts.length,
      confidence: linear?.confidence || 0
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get prediction');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/anomalies
 * 获取成本异常
 */
router.get('/anomalies', async (req, res) => {
  try {
    const { threshold = 2 } = req.query;
    
    const predictor = new CostPredictor(historicalCosts);
    const anomalies = predictor.detectAnomalies(parseFloat(threshold));
    
    res.json({
      anomalies,
      threshold: parseFloat(threshold),
      dataPoints: historicalCosts.length,
      hasAnomalies: anomalies.length > 0
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get anomalies');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/report
 * 生成成本报告
 */
router.get('/report', async (req, res) => {
  try {
    const { format = 'json', period = 'monthly' } = req.query;
    
    const costs = await costCollector.collectAllCosts();
    const byService = await costCollector.collectCostByService('default');
    const budgetStatus = await budgetManager.checkBudgetStatus(costs);
    
    const predictor = new CostPredictor(historicalCosts);
    const prediction = predictor.predictLinearRegression(30);
    const anomalies = predictor.detectAnomalies();
    const suggestions = predictor.generateOptimizationSuggestions(byService);
    const trend = predictor.getTrendAnalysis();
    
    const report = {
      generatedAt: new Date().toISOString(),
      period,
      summary: {
        totalCost: costs.reduce((sum, c) => sum + (c.total || 0), 0),
        byProvider: costs.map(c => ({ 
          provider: c.provider, 
          total: Math.round((c.total || 0) * 100) / 100 
        })),
        byService: Object.entries(byService).map(([name, cost]) => ({
          name,
          ...(typeof cost === 'object' ? cost : { total: cost })
        })),
        budgetStatus
      },
      prediction,
      trend,
      anomalies,
      recommendations: suggestions.slice(0, 10), // 最多返回 10 条建议
      nextSteps: generateNextSteps(suggestions, budgetStatus)
    };
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="cost-report-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(convertToCSV(report));
    } else {
      res.json(report);
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate report');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/history
 * 获取成本历史
 */
router.get('/history', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const history = historicalCosts.slice(-parseInt(days));
    
    res.json({
      history,
      days: parseInt(days),
      total: history.reduce((sum, h) => sum + h.cost, 0),
      average: history.length > 0 
        ? Math.round(history.reduce((sum, h) => sum + h.cost, 0) / history.length * 100) / 100
        : 0
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get history');
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/costs/collect
 * 手动触发成本采集
 */
router.post('/collect', async (req, res) => {
  try {
    const costs = await costCollector.collectAllCosts();
    const byService = await costCollector.collectCostByService('default');
    
    // 更新历史数据
    const total = costs.reduce((sum, c) => sum + (c.total || 0), 0);
    historicalCosts.push({
      date: new Date().toISOString().split('T')[0],
      cost: total,
      timestamp: Date.now()
    });
    
    res.json({
      message: 'Cost collection triggered',
      costs: costs.length,
      services: Object.keys(byService).length,
      totalCost: total
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to collect costs');
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/budgets/reset-alerts
 * 重置预算告警状态
 */
router.post('/budgets/reset-alerts', async (req, res) => {
  try {
    budgetManager.resetAlerts();
    res.json({ message: 'Budget alerts reset' });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to reset alerts');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 生成下一步建议
 */
function generateNextSteps(suggestions, budgetStatus) {
  const steps = [];
  
  // 检查超预算情况
  const exceededBudgets = budgetStatus.filter(b => b.status === 'exceeded');
  if (exceededBudgets.length > 0) {
    steps.push({
      priority: 'critical',
      action: 'budget_review',
      description: `${exceededBudgets.length} 个预算已超支，请立即检查并调整资源配置`
    });
  }
  
  // 检查优化建议
  const highPrioritySuggestions = suggestions.filter(s => s.priority === 'high');
  if (highPrioritySuggestions.length > 0) {
    steps.push({
      priority: 'high',
      action: 'optimization',
      description: `发现 ${highPrioritySuggestions.length} 个高优先级优化机会，预计可节省 $${Math.round(highPrioritySuggestions.reduce((sum, s) => sum + s.potentialSaving, 0))}/月`
    });
  }
  
  // 检查预留实例机会
  const reservedInstanceSuggestions = suggestions.filter(s => s.type === 'reserved_instance');
  if (reservedInstanceSuggestions.length > 0) {
    steps.push({
      priority: 'medium',
      action: 'reserved_instance',
      description: `${reservedInstanceSuggestions.length} 个服务适合购买预留实例，可节省约 30% 成本`
    });
  }
  
  return steps;
}

/**
 * 转换为 CSV 格式
 */
function convertToCSV(report) {
  const lines = [];
  
  lines.push('# Cloud Cost Report');
  lines.push(`# Generated At: ${report.generatedAt}`);
  lines.push(`# Period: ${report.period}`);
  lines.push('');
  
  // 总成本
  lines.push('## Summary');
  lines.push('Metric,Value,Currency');
  lines.push(`Total Cost,${report.summary.totalCost.toFixed(2)},USD`);
  lines.push('');
  
  // 按提供商
  lines.push('## Cost by Provider');
  lines.push('Provider,Amount (USD)');
  for (const p of report.summary.byProvider) {
    lines.push(`${p.provider},${p.total.toFixed(2)}`);
  }
  lines.push('');
  
  // 按服务
  lines.push('## Cost by Service');
  lines.push('Service,CPU (USD),Memory (USD),Total (USD)');
  for (const s of report.summary.byService) {
    lines.push(`${s.name},${(s.cpu || 0).toFixed(2)},${(s.memory || 0).toFixed(2)},${(s.total || 0).toFixed(2)}`);
  }
  lines.push('');
  
  // 预算状态
  lines.push('## Budget Status');
  lines.push('Budget,Spent,Limit,Percentage,Status');
  for (const b of report.summary.budgetStatus) {
    lines.push(`${b.name},${b.spent},${b.budget},${b.percentage}%,${b.status}`);
  }
  lines.push('');
  
  // 优化建议
  lines.push('## Optimization Recommendations');
  lines.push('Type,Service,Potential Saving (USD),Priority');
  for (const r of report.recommendations) {
    lines.push(`${r.type},${r.service},${r.potentialSaving.toFixed(2)},${r.priority}`);
  }
  
  return lines.join('\n');
}

module.exports = router;
