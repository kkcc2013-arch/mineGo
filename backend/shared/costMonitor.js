// shared/costMonitor.js - 成本监控定时任务
'use strict';
const { createLogger } = require('./logger');
const { CloudCostCollector } = require('./cloudCostCollector');
const { BudgetManager } = require('./budgetManager');
const { CostPredictor } = require('./costPredictor');
const { costGauge, costByServiceGauge, predictedCostGauge } = require('./costMetrics');

const logger = createLogger('cost-monitor');

/**
 * 成本监控定时任务
 */
class CostMonitor {
  constructor(config = {}) {
    this.collector = new CloudCostCollector(config);
    this.budgetManager = new BudgetManager(config);
    this.predictor = new CostPredictor();
    this.isRunning = false;
    this.intervalId = null;
    this.db = config.db;
    this.historicalData = [];
  }

  /**
   * 启动定时监控
   */
  start(intervalMs = 3600000) { // 默认每小时
    if (this.isRunning) {
      logger.warn('Cost monitor already running');
      return;
    }
    
    // 立即执行一次
    this.collectAndReport().catch(err => {
      logger.error({ error: err.message }, 'Initial cost collection failed');
    });
    
    // 定时执行
    this.intervalId = setInterval(() => {
      this.collectAndReport().catch(err => {
        logger.error({ error: err.message }, 'Scheduled cost collection failed');
      });
    }, intervalMs);
    
    this.isRunning = true;
    logger.info({ intervalMs }, 'Cost monitor started');
  }

  /**
   * 停止监控
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Cost monitor stopped');
  }

  /**
   * 采集并上报成本数据
   */
  async collectAndReport() {
    try {
      logger.info('Starting cost collection...');
      
      // 采集云成本
      const costs = await this.collector.collectAllCosts();
      
      // 更新 Prometheus 指标
      for (const cost of costs) {
        const total = cost.total || this.collector.calculateTotalCost(cost.data);
        
        costGauge.set(
          { provider: cost.provider, resource_type: 'all', namespace: 'default', service: 'all' },
          total
        );
        
        // 保存到历史数据
        this.historicalData.push({
          date: new Date().toISOString().split('T')[0],
          cost: total,
          provider: cost.provider
        });
        
        // 保持最近 90 天数据
        if (this.historicalData.length > 90) {
          this.historicalData = this.historicalData.slice(-90);
        }
      }
      
      // 按服务维度采集
      const serviceCosts = await this.collector.collectCostByService('default');
      
      for (const [service, cost] of Object.entries(serviceCosts)) {
        const costData = typeof cost === 'object' ? cost : { total: cost, cpu: 0, memory: 0 };
        
        costByServiceGauge.set(
          { service_name: service, resource_type: 'cpu' },
          costData.cpu || costData.total * 0.6
        );
        costByServiceGauge.set(
          { service_name: service, resource_type: 'memory' },
          costData.memory || costData.total * 0.4
        );
      }
      
      // 检查预算
      const budgetStatus = await this.budgetManager.checkBudgetStatus(costs);
      
      // 更新预测器数据并预测
      this.predictor.setHistoricalData(this.historicalData);
      const prediction = this.predictor.predictLinearRegression(30);
      
      if (prediction) {
        predictedCostGauge.set({ service: 'all' }, prediction.monthlyTotal);
      }
      
      logger.info({
        providers: costs.length,
        services: Object.keys(serviceCosts).length,
        budgets: budgetStatus.length
      }, 'Cost collection completed');
      
      return {
        costs,
        serviceCosts,
        budgetStatus,
        prediction
      };
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Cost collection failed');
      throw error;
    }
  }

  /**
   * 生成成本报告
   */
  async generateReport(type = 'daily') {
    const costs = await this.collector.collectAllCosts();
    const serviceCosts = await this.collector.collectCostByService('default');
    const budgetStatus = await this.budgetManager.checkBudgetStatus(costs);
    
    this.predictor.setHistoricalData(this.historicalData);
    const prediction = this.predictor.predictLinearRegression(30);
    const anomalies = this.predictor.detectAnomalies();
    const suggestions = this.predictor.generateOptimizationSuggestions(serviceCosts);
    const trend = this.predictor.getTrendAnalysis();
    
    const report = {
      generatedAt: new Date().toISOString(),
      type,
      summary: {
        totalCost: costs.reduce((sum, c) => sum + (c.total || 0), 0),
        byProvider: costs.map(c => ({
          provider: c.provider,
          total: c.total || 0
        })),
        byService: Object.entries(serviceCosts).map(([name, cost]) => ({
          name,
          ...(typeof cost === 'object' ? cost : { total: cost })
        })),
        budgetStatus
      },
      prediction,
      anomalies,
      trend,
      recommendations: suggestions,
      potentialMonthlySaving: suggestions.reduce((sum, s) => sum + s.potentialSaving, 0)
    };
    
    logger.info({ type, totalCost: report.summary.totalCost }, 'Cost report generated');
    
    return report;
  }

  /**
   * 生成周报
   */
  async generateWeeklyReport() {
    const report = await this.generateReport('weekly');
    
    // 可以在这里添加发送邮件等通知逻辑
    logger.info('Weekly cost report generated');
    
    return report;
  }

  /**
   * 生成月报
   */
  async generateMonthlyReport() {
    const report = await this.generateReport('monthly');
    
    logger.info('Monthly cost report generated');
    
    return report;
  }

  /**
   * 重置预算告警状态
   */
  resetBudgetAlerts() {
    this.budgetManager.resetAlerts();
    logger.info('Budget alerts reset');
  }

  /**
   * 添加预算
   */
  addBudget(budget) {
    return this.budgetManager.addBudget(budget);
  }

  /**
   * 获取预算状态
   */
  async getBudgetStatus() {
    const costs = await this.collector.collectAllCosts();
    return this.budgetManager.checkBudgetStatus(costs);
  }

  /**
   * 获取成本历史
   */
  getCostHistory(days = 30) {
    return this.historicalData.slice(-days);
  }

  /**
   * 获取优化建议
   */
  async getOptimizationSuggestions() {
    const serviceCosts = await this.collector.collectCostByService('default');
    return this.predictor.generateOptimizationSuggestions(serviceCosts);
  }

  /**
   * 导出为 CSV 格式
   */
  exportToCSV(report) {
    const lines = [];
    
    // 标题行
    lines.push('Cloud Cost Report');
    lines.push(`Generated At,${report.generatedAt}`);
    lines.push('');
    
    // 总成本
    lines.push('Total Cost');
    lines.push(`Amount,${report.summary.totalCost.toFixed(2)},USD`);
    lines.push('');
    
    // 按提供商
    lines.push('Cost by Provider');
    lines.push('Provider,Amount (USD)');
    for (const p of report.summary.byProvider) {
      lines.push(`${p.provider},${p.total.toFixed(2)}`);
    }
    lines.push('');
    
    // 按服务
    lines.push('Cost by Service');
    lines.push('Service,CPU (USD),Memory (USD),Total (USD)');
    for (const s of report.summary.byService) {
      lines.push(`${s.name},${(s.cpu || 0).toFixed(2)},${(s.memory || 0).toFixed(2)},${(s.total || 0).toFixed(2)}`);
    }
    lines.push('');
    
    // 预算状态
    lines.push('Budget Status');
    lines.push('Budget,Spent,Limit,Percentage,Status');
    for (const b of report.summary.budgetStatus) {
      lines.push(`${b.name},${b.spent.toFixed(2)},${b.budget.toFixed(2)},${b.percentage}%,${b.status}`);
    }
    lines.push('');
    
    // 优化建议
    lines.push('Optimization Recommendations');
    lines.push('Type,Service,Potential Saving (USD),Priority');
    for (const r of report.recommendations) {
      lines.push(`${r.type},${r.service},${r.potentialSaving.toFixed(2)},${r.priority}`);
    }
    
    return lines.join('\n');
  }
}

module.exports = { CostMonitor };
