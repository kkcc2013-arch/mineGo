/**
 * REQ-00466: 成本异常监控定时任务
 */

const { CostAnomalyDetector } = require('../../shared/cost-alerting/CostAnomalyDetector');
const { CostAlertChannel } = require('../../shared/cost-alerting/CostAlertChannel');
const { AlertAggregator } = require('../../shared/cost-alerting/AlertAggregator');
const { CostAutoResponder } = require('../../shared/cost-alerting/CostAutoResponder');

class CostAnomalyMonitor {
  constructor(db, redis, options = {}) {
    this.db = db;
    this.redis = redis;
    
    this.detector = new CostAnomalyDetector(options.detector);
    this.alertChannel = new CostAlertChannel(options.alertChannel);
    this.aggregator = new AlertAggregator(options.aggregator);
    this.autoResponder = new CostAutoResponder(options.autoResponder);
    
    this.logger = options.logger || console;
    this.running = false;
  }

  /**
   * 执行监控检查
   */
  async run() {
    if (this.running) {
      this.logger.warn('[CostMonitor] Already running, skipping');
      return;
    }

    this.running = true;
    this.logger.info('[CostMonitor] Starting cost anomaly monitoring');

    try {
      // 1. 获取当前成本数据
      const currentCost = await this.getCurrentCost();
      this.logger.info(`[CostMonitor] Current cost: $${currentCost.toFixed(2)}`);

      // 2. 获取历史成本数据
      const historicalCosts = await this.getHistoricalCosts();
      this.logger.info(`[CostMonitor] Historical data points: ${historicalCosts.length}`);

      // 3. 检测异常
      const anomaly = this.detector.detect(historicalCosts, currentCost);

      if (anomaly.isAnomaly) {
        this.logger.warn('[CostMonitor] Cost anomaly detected:', anomaly);

        // 4. 聚合告警
        const aggregatedAlert = this.aggregator.process(anomaly);

        if (aggregatedAlert) {
          // 5. 发送告警
          await this.sendAlert(aggregatedAlert);

          // 6. 自动响应
          if (anomaly.severity === 'critical' || anomaly.severity === 'high') {
            const response = await this.autoResponder.respond(anomaly, {
              cost: currentCost,
              timestamp: new Date()
            });
            this.logger.info('[CostMonitor] Auto response:', response);
          }
        } else {
          this.logger.info('[CostMonitor] Alert aggregated (suppressed)');
        }
      } else {
        this.logger.info('[CostMonitor] No anomaly detected');
      }

      // 7. 检查预算状态
      await this.checkBudgetStatus(currentCost);

      // 8. 清理过期告警
      this.aggregator.cleanup();

      // 9. 保存监控结果
      await this.saveMonitorResult(anomaly, currentCost);

      this.logger.info('[CostMonitor] Monitoring completed');
      return anomaly;
    } catch (error) {
      this.logger.error('[CostMonitor] Monitoring failed:', error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * 获取当前成本
   */
  async getCurrentCost() {
    const today = new Date().toISOString().split('T')[0];
    
    // 尝试从 Redis 获取
    const cachedCost = await this.redis?.get(`cost:daily:${today}`);
    if (cachedCost) {
      return parseFloat(cachedCost);
    }

    // 从数据库计算
    if (this.db) {
      try {
        const result = await this.db.query(`
          SELECT SUM(cost) as daily_cost
          FROM resource_usage
          WHERE DATE(created_at) = CURRENT_DATE
        `);
        
        if (result.rows.length > 0 && result.rows[0].daily_cost) {
          return parseFloat(result.rows[0].daily_cost);
        }
      } catch (error) {
        this.logger.warn('[CostMonitor] Failed to query cost from DB:', error);
      }
    }

    // 返回默认值或模拟数据
    return 0;
  }

  /**
   * 获取历史成本
   */
  async getHistoricalCosts() {
    const costs = [];

    // 尝试从 Redis 获取
    for (let i = 1; i <= 30; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const cost = await this.redis?.get(`cost:daily:${dateStr}`);
      if (cost) {
        costs.push(parseFloat(cost));
      }
    }

    // 如果 Redis 数据不足，从数据库获取
    if (costs.length < 7 && this.db) {
      try {
        const result = await this.db.query(`
          SELECT DATE(created_at) as date, SUM(cost) as daily_cost
          FROM resource_usage
          WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY date
        `);

        for (const row of result.rows) {
          costs.push(parseFloat(row.daily_cost || 0));
        }
      } catch (error) {
        this.logger.warn('[CostMonitor] Failed to query historical costs:', error);
      }
    }

    return costs.reverse();
  }

  /**
   * 发送告警
   */
  async sendAlert(alert) {
    const channels = this.getChannelsForSeverity(alert.severity);
    
    try {
      const results = await this.alertChannel.send(alert, channels);
      this.logger.info('[CostMonitor] Alert sent:', results);
      return results;
    } catch (error) {
      this.logger.error('[CostMonitor] Failed to send alert:', error);
      throw error;
    }
  }

  /**
   * 根据严重程度选择告警渠道
   */
  getChannelsForSeverity(severity) {
    switch (severity) {
      case 'critical':
        return ['slack', 'email', 'pagerduty'];
      case 'high':
        return ['slack', 'email'];
      case 'medium':
        return ['slack'];
      default:
        return ['slack'];
    }
  }

  /**
   * 检查预算状态
   */
  async checkBudgetStatus(currentCost) {
    if (!this.db) return;

    try {
      const result = await this.db.query(`
        SELECT * FROM budget_config WHERE is_active = TRUE
      `);

      const budgets = result.rows;

      for (const budget of budgets) {
        const usage = currentCost / (budget.amount || 1);
        const thresholds = (budget.alert_thresholds || [0.8, 0.9, 1.0]).sort((a, b) => b - a);

        for (const threshold of thresholds) {
          if (usage >= threshold) {
            await this.sendBudgetAlert(budget, usage, threshold, currentCost);
            break;
          }
        }
      }
    } catch (error) {
      this.logger.warn('[CostMonitor] Failed to check budget:', error);
    }
  }

  /**
   * 发送预算告警
   */
  async sendBudgetAlert(budget, usage, threshold, currentCost) {
    const alert = {
      type: 'budget_threshold',
      severity: usage >= 1 ? 'critical' : usage >= 0.9 ? 'high' : 'medium',
      budgetName: budget.name,
      usagePercent: (usage * 100).toFixed(1),
      thresholdPercent: (threshold * 100).toFixed(1),
      currentCost,
      budgetLimit: budget.amount,
      timestamp: new Date().toISOString()
    };

    const aggregated = this.aggregator.process(alert);
    if (aggregated) {
      await this.alertChannel.send(aggregated, ['slack', 'email']);
    }
  }

  /**
   * 保存监控结果
   */
  async saveMonitorResult(anomaly, currentCost) {
    if (!this.db) return;

    try {
      await this.db.query(`
        INSERT INTO cost_monitoring_log (
          cost_value, is_anomaly, anomaly_type, severity,
          z_score, mean_value, std_dev, trend_direction,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [
        currentCost,
        anomaly.isAnomaly,
        anomaly.anomalyType,
        anomaly.severity,
        anomaly.zScore,
        anomaly.mean,
        anomaly.stdDev,
        anomaly.trendDirection
      ]);
    } catch (error) {
      this.logger.warn('[CostMonitor] Failed to save result:', error);
    }
  }

  /**
   * 定时启动
   */
  start(intervalMinutes = 5) {
    this.logger.info(`[CostMonitor] Starting with interval: ${intervalMinutes} minutes`);
    
    // 立即执行一次
    this.run().catch(err => this.logger.error('[CostMonitor] Initial run failed:', err));

    // 设置定时执行
    this.timerId = setInterval(() => {
      this.run().catch(err => this.logger.error('[CostMonitor] Scheduled run failed:', err));
    }, intervalMinutes * 60 * 1000);

    return this;
  }

  /**
   * 停止监控
   */
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.logger.info('[CostMonitor] Stopped');
  }
}

/**
 * 独立启动函数
 */
async function startMonitoring(db, redis, options = {}) {
  const monitor = new CostAnomalyMonitor(db, redis, options);
  return monitor.start(options.intervalMinutes || 5);
}

module.exports = { CostAnomalyMonitor, startMonitoring };