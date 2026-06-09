// tests/unit/cost-monitoring.test.js - 云成本监控与预算告警单元测试
'use strict';
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { CloudCostCollector, MockCostAdapter } = require('../../shared/cloudCostCollector');
const { BudgetManager } = require('../../shared/budgetManager');
const { CostPredictor } = require('../../shared/costPredictor');
const { CostMonitor } = require('../../shared/costMonitor');

describe('CloudCostCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new CloudCostCollector({ 
      mockMode: true,
      namespace: 'test'
    });
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      assert.ok(collector);
      assert.strictEqual(collector.config.namespace, 'test');
      assert.ok(collector.mockMode);
    });

    it('should accept custom cost rates', () => {
      const customCollector = new CloudCostCollector({
        nodeCostPerCore: 30,
        nodeCostPerMemoryGB: 5
      });
      assert.strictEqual(customCollector.config.nodeCostPerCore, 30);
      assert.strictEqual(customCollector.config.nodeCostPerMemoryGB, 5);
    });
  });

  describe('registerProvider', () => {
    it('should register a provider', () => {
      collector.registerProvider('test', new MockCostAdapter());
      assert.strictEqual(collector.providers.size, 1);
      assert.ok(collector.providers.has('test'));
    });
  });

  describe('collectAllCosts', () => {
    it('should collect costs from all providers', async () => {
      collector.registerProvider('mock1', new MockCostAdapter({ baseCost: 50 }));
      collector.registerProvider('mock2', new MockCostAdapter({ baseCost: 30 }));

      const costs = await collector.collectAllCosts();

      assert.ok(Array.isArray(costs));
      assert.strictEqual(costs.length, 2);
      assert.ok(costs[0].provider);
      assert.ok(costs[0].total > 0);
    });

    it('should return mock costs when no providers and mockMode enabled', async () => {
      const costs = await collector.collectAllCosts();
      assert.ok(Array.isArray(costs));
      assert.strictEqual(costs.length, 1);
      assert.strictEqual(costs[0].provider, 'mock');
    });
  });

  describe('collectCostByService', () => {
    it('should return service costs in mock mode', async () => {
      const costs = await collector.collectCostByService('default');
      
      assert.ok(typeof costs === 'object');
      assert.ok(Object.keys(costs).length > 0);
      
      // 检查服务成本结构
      const serviceNames = Object.keys(costs);
      for (const name of serviceNames) {
        const cost = costs[name];
        assert.ok(typeof cost === 'object');
        assert.ok(typeof cost.cpu === 'number');
        assert.ok(typeof cost.memory === 'number');
        assert.ok(typeof cost.total === 'number');
      }
    });
  });

  describe('parseCpu', () => {
    it('should parse CPU with m suffix', () => {
      assert.strictEqual(collector.parseCpu('100m'), 0.1);
      assert.strictEqual(collector.parseCpu('1000m'), 1);
    });

    it('should parse CPU without suffix', () => {
      assert.strictEqual(collector.parseCpu('1'), 1);
      assert.strictEqual(collector.parseCpu('0.5'), 0.5);
    });

    it('should parse CPU with n suffix', () => {
      assert.strictEqual(collector.parseCpu('1000000000n'), 1);
    });

    it('should handle empty values', () => {
      assert.strictEqual(collector.parseCpu('0'), 0);
      assert.strictEqual(collector.parseCpu(''), 0);
    });
  });

  describe('parseMemory', () => {
    it('should parse memory with Mi suffix', () => {
      assert.strictEqual(collector.parseMemory('512Mi'), 512 * 1024 * 1024);
    });

    it('should parse memory with Gi suffix', () => {
      assert.strictEqual(collector.parseMemory('1Gi'), 1024 * 1024 * 1024);
    });

    it('should parse memory with Ki suffix', () => {
      assert.strictEqual(collector.parseMemory('1024Ki'), 1024 * 1024);
    });

    it('should handle empty values', () => {
      assert.strictEqual(collector.parseMemory('0'), 0);
      assert.strictEqual(collector.parseMemory(''), 0);
    });
  });

  describe('calculateCpuCost', () => {
    it('should calculate monthly CPU cost', () => {
      const cost = collector.calculateCpuCost(1); // 1 core
      assert.strictEqual(cost, 20); // $20/month per core
    });

    it('should calculate fractional core cost', () => {
      const cost = collector.calculateCpuCost(0.5); // 0.5 core
      assert.strictEqual(cost, 10);
    });
  });

  describe('calculateMemoryCost', () => {
    it('should calculate memory cost per GB', () => {
      const oneGB = 1024 * 1024 * 1024;
      const cost = collector.calculateMemoryCost(oneGB);
      assert.strictEqual(cost, 3); // $3/month per GB
    });
  });

  describe('getTimePeriod', () => {
    it('should return correct date range', () => {
      const period = collector.getTimePeriod(7);
      
      assert.ok(period.Start);
      assert.ok(period.End);
      assert.ok(new Date(period.Start) < new Date(period.End));
    });
  });
});

describe('BudgetManager', () => {
  let budgetManager;

  beforeEach(() => {
    budgetManager = new BudgetManager();
  });

  describe('addBudget', () => {
    it('should add a budget', () => {
      const budget = budgetManager.addBudget({
        name: 'test-budget',
        amount: 100,
        period: 'monthly',
        scope: 'all'
      });

      assert.ok(budget);
      assert.strictEqual(budget.name, 'test-budget');
      assert.strictEqual(budget.amount, 100);
      assert.strictEqual(budgetManager.budgets.size, 1);
    });

    it('should use default values', () => {
      const budget = budgetManager.addBudget({
        name: 'default-budget',
        amount: 200
      });

      assert.strictEqual(budget.currency, 'USD');
      assert.strictEqual(budget.period, 'monthly');
      assert.strictEqual(budget.scope, 'all');
    });

    it('should accept custom alert thresholds', () => {
      const budget = budgetManager.addBudget({
        name: 'custom-threshold',
        amount: 100,
        alertThresholds: [0.6, 0.8, 1.0]
      });

      assert.deepStrictEqual(budget.alertThresholds, [0.6, 0.8, 1.0]);
    });
  });

  describe('removeBudget', () => {
    it('should remove a budget', () => {
      budgetManager.addBudget({ name: 'to-remove', amount: 100 });
      
      const removed = budgetManager.removeBudget('to-remove');
      
      assert.ok(removed);
      assert.strictEqual(budgetManager.budgets.size, 0);
    });

    it('should return false for non-existent budget', () => {
      const removed = budgetManager.removeBudget('non-existent');
      assert.ok(!removed);
    });
  });

  describe('checkBudgetStatus', () => {
    it('should return budget status', async () => {
      budgetManager.addBudget({
        name: 'test-budget',
        amount: 100,
        period: 'monthly',
        scope: 'all'
      });

      const costs = [{ total: 50 }, { total: 30 }];
      const status = await budgetManager.checkBudgetStatus(costs);

      assert.ok(Array.isArray(status));
      assert.strictEqual(status.length, 1);
      assert.strictEqual(status[0].name, 'test-budget');
      assert.strictEqual(status[0].spent, 80);
      assert.strictEqual(status[0].budget, 100);
      assert.ok(status[0].percentage > 0);
    });

    it('should detect exceeded budget', async () => {
      budgetManager.addBudget({
        name: 'small-budget',
        amount: 10,
        period: 'monthly'
      });

      const costs = [{ total: 50 }];
      const status = await budgetManager.checkBudgetStatus(costs);

      assert.strictEqual(status[0].status, 'exceeded');
    });

    it('should detect warning status', async () => {
      budgetManager.addBudget({
        name: 'warning-budget',
        amount: 100,
        period: 'monthly'
      });

      const costs = [{ total: 92 }];
      const status = await budgetManager.checkBudgetStatus(costs);

      assert.strictEqual(status[0].status, 'warning');
    });
  });

  describe('checkThresholds', () => {
    it('should trigger threshold correctly', () => {
      budgetManager.addBudget({
        name: 'threshold-test',
        amount: 100,
        alertThresholds: [0.5, 0.8]
      });

      const threshold = budgetManager.checkThresholds('threshold-test', 0.9);
      assert.strictEqual(threshold, 0.8);
    });

    it('should not trigger duplicate alerts', () => {
      budgetManager.addBudget({
        name: 'no-duplicate',
        amount: 100,
        alertThresholds: [0.5, 0.8]
      });

      budgetManager.checkThresholds('no-duplicate', 0.9);
      const threshold = budgetManager.checkThresholds('no-duplicate', 0.95);
      
      assert.strictEqual(threshold, null);
    });
  });

  describe('getAlertLevel', () => {
    it('should return correct alert level', () => {
      assert.strictEqual(budgetManager.getAlertLevel(1.0), 'critical');
      assert.strictEqual(budgetManager.getAlertLevel(0.9), 'high');
      assert.strictEqual(budgetManager.getAlertLevel(0.8), 'warning');
      assert.strictEqual(budgetManager.getAlertLevel(0.5), 'info');
    });
  });

  describe('getCurrentPeriod', () => {
    it('should return daily period', () => {
      const budget = { period: 'daily' };
      const period = budgetManager.getCurrentPeriod(budget);
      
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(period));
    });

    it('should return monthly period', () => {
      const budget = { period: 'monthly' };
      const period = budgetManager.getCurrentPeriod(budget);
      
      assert.ok(/^\d{4}-\d{2}$/.test(period));
    });
  });

  describe('resetAlerts', () => {
    it('should reset alert states', () => {
      budgetManager.addBudget({
        name: 'reset-test',
        amount: 100,
        alertThresholds: [0.5]
      });

      budgetManager.checkThresholds('reset-test', 0.6);
      budgetManager.resetAlerts();

      const threshold = budgetManager.checkThresholds('reset-test', 0.6);
      assert.strictEqual(threshold, 0.5);
    });
  });
});

describe('CostPredictor', () => {
  let predictor;

  beforeEach(() => {
    // 生成 30 天模拟历史数据
    const historicalData = [];
    for (let i = 0; i < 30; i++) {
      historicalData.push({
        date: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        cost: 50 + Math.random() * 10
      });
    }
    predictor = new CostPredictor(historicalData);
  });

  describe('predictLinearRegression', () => {
    it('should predict future costs', () => {
      const prediction = predictor.predictLinearRegression(30);

      assert.ok(prediction);
      assert.ok(prediction.slope);
      assert.ok(prediction.intercept !== undefined);
      assert.ok(Array.isArray(prediction.predictions));
      assert.strictEqual(prediction.predictions.length, 30);
      assert.ok(prediction.monthlyTotal > 0);
      assert.ok(prediction.rSquared >= 0 && prediction.rSquared <= 1);
    });

    it('should include confidence score', () => {
      const prediction = predictor.predictLinearRegression(30);

      assert.ok(prediction.confidence >= 0);
      assert.ok(prediction.confidence <= 100);
    });

    it('should return null with insufficient data', () => {
      const shortPredictor = new CostPredictor([{ cost: 50 }]);
      const prediction = shortPredictor.predictLinearRegression(30);

      assert.strictEqual(prediction, null);
    });
  });

  describe('predictMovingAverage', () => {
    it('should predict using moving average', () => {
      const prediction = predictor.predictMovingAverage(7, 30);

      assert.ok(prediction);
      assert.strictEqual(prediction.method, 'moving_average');
      assert.strictEqual(prediction.windowSize, 7);
      assert.ok(prediction.averageCost > 0);
      assert.strictEqual(prediction.predictions.length, 30);
    });

    it('should return null with insufficient data', () => {
      const shortPredictor = new CostPredictor([1, 2, 3]);
      const prediction = shortPredictor.predictMovingAverage(7, 30);

      assert.strictEqual(prediction, null);
    });
  });

  describe('predictExponentialSmoothing', () => {
    it('should predict using exponential smoothing', () => {
      const prediction = predictor.predictExponentialSmoothing(0.3, 30);

      assert.ok(prediction);
      assert.strictEqual(prediction.method, 'exponential_smoothing');
      assert.ok(prediction.smoothingValue > 0);
      assert.strictEqual(prediction.predictions.length, 30);
    });
  });

  describe('detectAnomalies', () => {
    it('should detect anomalies', () => {
      // 添加异常数据
      const dataWithAnomaly = predictor.historicalData.slice();
      dataWithAnomaly.push({
        date: new Date().toISOString().split('T')[0],
        cost: 500 // 异常高值
      });
      predictor.setHistoricalData(dataWithAnomaly);

      const anomalies = predictor.detectAnomalies(2);

      assert.ok(Array.isArray(anomalies));
      assert.ok(anomalies.some(a => a.cost === 500));
    });

    it('should return empty array with insufficient data', () => {
      const shortPredictor = new CostPredictor([1, 2]);
      const anomalies = shortPredictor.detectAnomalies();

      assert.deepStrictEqual(anomalies, []);
    });
  });

  describe('generateOptimizationSuggestions', () => {
    it('should generate suggestions for underutilized resources', () => {
      const serviceCosts = {
        'low-usage-service': {
          total: 10,
          cpu: 5,
          memory: 5,
          utilization: 0.1 // 10% utilization
        }
      };

      const suggestions = predictor.generateOptimizationSuggestions(serviceCosts);

      assert.ok(Array.isArray(suggestions));
      assert.ok(suggestions.some(s => s.type === 'underutilized'));
    });

    it('should suggest reserved instances for stable usage', () => {
      const serviceCosts = {
        'stable-service': {
          total: 5,
          cpu: 3,
          memory: 2,
          variance: 0.05 // Low variance
        }
      };

      const suggestions = predictor.generateOptimizationSuggestions(serviceCosts);

      assert.ok(suggestions.some(s => s.type === 'reserved_instance'));
    });

    it('should sort by potential saving', () => {
      const serviceCosts = {
        'high-cost': { total: 100, cpu: 60, memory: 40 },
        'medium-cost': { total: 50, cpu: 30, memory: 20 }
      };

      const suggestions = predictor.generateOptimizationSuggestions(serviceCosts);

      for (let i = 1; i < suggestions.length; i++) {
        assert.ok(suggestions[i - 1].potentialSaving >= suggestions[i].potentialSaving);
      }
    });
  });

  describe('getTrendAnalysis', () => {
    it('should return trend analysis', () => {
      const trend = predictor.getTrendAnalysis();

      assert.ok(trend);
      assert.ok(trend.firstWeekAvg > 0);
      assert.ok(trend.lastWeekAvg > 0);
      assert.ok(typeof trend.changePercent === 'number');
      assert.ok(['increasing', 'decreasing', 'stable'].includes(trend.trend));
    });
  });
});

describe('CostMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new CostMonitor({ mockMode: true });
  });

  afterEach(() => {
    if (monitor.isRunning) {
      monitor.stop();
    }
  });

  describe('start/stop', () => {
    it('should start monitoring', () => {
      monitor.start(60000);
      assert.ok(monitor.isRunning);
    });

    it('should stop monitoring', () => {
      monitor.start(60000);
      monitor.stop();
      assert.ok(!monitor.isRunning);
    });

    it('should not start twice', () => {
      monitor.start(60000);
      monitor.start(60000);
      assert.ok(monitor.isRunning);
    });
  });

  describe('collectAndReport', () => {
    it('should collect and report costs', async () => {
      const result = await monitor.collectAndReport();

      assert.ok(result);
      assert.ok(Array.isArray(result.costs));
      assert.ok(result.serviceCosts);
      assert.ok(Array.isArray(result.budgetStatus));
    });
  });

  describe('generateReport', () => {
    it('should generate daily report', async () => {
      const report = await monitor.generateReport('daily');

      assert.ok(report);
      assert.strictEqual(report.type, 'daily');
      assert.ok(report.generatedAt);
      assert.ok(report.summary);
      assert.ok(Array.isArray(report.recommendations));
    });
  });

  describe('addBudget', () => {
    it('should add budget', () => {
      monitor.addBudget({
        name: 'monitor-budget',
        amount: 500
      });

      const budgets = monitor.budgetManager.getAllBudgets();
      assert.ok(budgets.some(b => b.name === 'monitor-budget'));
    });
  });

  describe('getCostHistory', () => {
    it('should return cost history', async () => {
      await monitor.collectAndReport();
      const history = monitor.getCostHistory(30);

      assert.ok(Array.isArray(history));
    });
  });

  describe('exportToCSV', () => {
    it('should export report to CSV', async () => {
      const report = await monitor.generateReport('daily');
      const csv = monitor.exportToCSV(report);

      assert.ok(typeof csv === 'string');
      assert.ok(csv.includes('Cloud Cost Report'));
    });
  });
});

describe('MockCostAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockCostAdapter({ baseCost: 50 });
  });

  describe('getCost', () => {
    it('should return mock cost data', async () => {
      const period = {
        Start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        End: new Date().toISOString().split('T')[0]
      };

      const costs = await adapter.getCost({ timePeriod: period });

      assert.ok(Array.isArray(costs));
      assert.ok(costs.length > 0);
      assert.ok(costs[0].Total);
      assert.ok(costs[0].Total.UnblendedCost);
    });
  });
});

// 运行测试
console.log('Running cost monitoring unit tests...');
