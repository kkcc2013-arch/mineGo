// shared/budgetManager.js - 预算管理器
'use strict';
const { createLogger } = require('./logger');
const { 
  budgetUsageGauge, 
  budgetSpentGauge, 
  budgetLimitGauge,
  costAlertCounter,
  recordThresholdTrigger,
  isThresholdTriggered,
  clearThresholdTriggers
} = require('./costMetrics');

const logger = createLogger('budget-manager');

/**
 * 预算管理器
 */
class BudgetManager {
  constructor(config = {}) {
    this.budgets = new Map();
    this.alertThresholds = config.alertThresholds || [0.5, 0.8, 0.9, 1.0];
    this.notifier = config.notifier || this.defaultNotifier;
  }

  /**
   * 添加预算配置
   */
  addBudget(budget) {
    const budgetConfig = {
      name: budget.name,
      amount: parseFloat(budget.amount),
      currency: budget.currency || 'USD',
      period: budget.period || 'monthly', // 'daily', 'weekly', 'monthly'
      scope: budget.scope || 'all', // 'all' | 'service' | 'namespace'
      services: budget.services || [],
      namespaces: budget.namespaces || [],
      alertThresholds: budget.alertThresholds || this.alertThresholds,
      notifications: budget.notifications || [],
      startDate: new Date(budget.startDate || Date.now()),
      endDate: budget.endDate ? new Date(budget.endDate) : null,
      createdAt: new Date()
    };
    
    this.budgets.set(budget.name, budgetConfig);
    
    logger.info({ 
      budget: budget.name, 
      amount: budgetConfig.amount,
      period: budgetConfig.period 
    }, 'Budget added');
    
    return budgetConfig;
  }

  /**
   * 移除预算
   */
  removeBudget(name) {
    const removed = this.budgets.delete(name);
    if (removed) {
      logger.info({ budget: name }, 'Budget removed');
    }
    return removed;
  }

  /**
   * 获取预算配置
   */
  getBudget(name) {
    return this.budgets.get(name);
  }

  /**
   * 获取所有预算
   */
  getAllBudgets() {
    return Array.from(this.budgets.values());
  }

  /**
   * 检查预算状态
   */
  async checkBudgetStatus(costs) {
    const results = [];
    
    for (const [name, budget] of this.budgets) {
      const period = this.getCurrentPeriod(budget);
      const spent = this.calculateSpent(costs, budget);
      const percentage = budget.amount > 0 ? spent / budget.amount : 0;
      
      // 更新 Prometheus 指标
      budgetUsageGauge.set({ budget_name: name, period }, percentage * 100);
      budgetSpentGauge.set({ budget_name: name, period }, spent);
      budgetLimitGauge.set({ budget_name: name, period }, budget.amount);
      
      // 检查告警阈值
      const thresholdHit = this.checkThresholds(name, percentage);
      
      if (thresholdHit) {
        await this.sendBudgetAlert(budget, spent, percentage, thresholdHit);
        costAlertCounter.inc({ budget_name: name, threshold: String(thresholdHit), level: this.getAlertLevel(thresholdHit) });
      }
      
      results.push({
        name,
        spent: Math.round(spent * 100) / 100,
        budget: budget.amount,
        percentage: Math.round(percentage * 10000) / 100, // 百分比保留两位小数
        thresholdHit,
        period,
        currency: budget.currency,
        status: percentage >= 1 ? 'exceeded' : percentage >= 0.9 ? 'warning' : 'ok'
      });
    }
    
    return results;
  }

  /**
   * 检查阈值触发
   */
  checkThresholds(budgetName, percentage) {
    const budget = this.budgets.get(budgetName);
    const thresholds = budget?.alertThresholds || this.alertThresholds;
    
    // 从高到低检查阈值
    for (const threshold of [...thresholds].sort((a, b) => b - a)) {
      if (percentage >= threshold) {
        // 检查是否已经触发过
        if (!isThresholdTriggered(budgetName, threshold)) {
          recordThresholdTrigger(budgetName, threshold);
          return threshold;
        }
      }
    }
    
    return null;
  }

  /**
   * 获取告警级别
   */
  getAlertLevel(threshold) {
    if (threshold >= 1.0) return 'critical';
    if (threshold >= 0.9) return 'high';
    if (threshold >= 0.8) return 'warning';
    return 'info';
  }

  /**
   * 发送预算告警
   */
  async sendBudgetAlert(budget, spent, percentage, threshold) {
    const alertLevel = this.getAlertLevel(threshold);
    
    const message = {
      type: 'budget_alert',
      level: alertLevel,
      budget: budget.name,
      spent: spent.toFixed(2),
      limit: budget.amount.toFixed(2),
      percentage: (percentage * 100).toFixed(1),
      threshold: (threshold * 100).toFixed(0),
      currency: budget.currency,
      timestamp: new Date().toISOString()
    };
    
    logger.warn(message, 'Budget alert triggered');
    
    // 多渠道通知
    const notifications = budget.notifications || [];
    
    for (const channel of notifications) {
      try {
        await this.notifier({
          channel: channel.type,
          recipient: channel.recipient,
          subject: `[${alertLevel.toUpperCase()}] 预算告警: ${budget.name}`,
          body: this.formatAlertMessage(message)
        });
      } catch (error) {
        logger.error({ 
          budget: budget.name, 
          channel: channel.type, 
          error: error.message 
        }, 'Failed to send budget alert');
      }
    }
    
    return message;
  }

  /**
   * 格式化告警消息
   */
  formatAlertMessage(message) {
    const emoji = message.level === 'critical' ? '🚨' : 
                  message.level === 'high' ? '⚠️' : 
                  message.level === 'warning' ? '⚡' : '📊';
    
    return `
${emoji} 预算告警通知

预算名称: ${message.budget}
告警等级: ${message.level.toUpperCase()}
使用金额: $${message.spent} ${message.currency}
预算限额: $${message.limit} ${message.currency}
使用比例: ${message.percentage}%
触发阈值: ${message.threshold}%

时间: ${message.timestamp}

请及时检查云资源使用情况，必要时调整预算或优化资源。
    `.trim();
  }

  /**
   * 获取当前周期
   */
  getCurrentPeriod(budget) {
    const now = new Date();
    
    if (budget.period === 'daily') {
      return now.toISOString().split('T')[0];
    } else if (budget.period === 'weekly') {
      const week = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
      return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
    } else { // monthly
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
  }

  /**
   * 计算已花费金额
   */
  calculateSpent(costs, budget) {
    if (!costs || costs.length === 0) {
      // 尝试从服务成本计算
      if (budget.services && budget.services.length > 0) {
        return budget.services.reduce((sum, s) => {
          const serviceCost = typeof s === 'object' ? s.cost || 0 : 0;
          return sum + serviceCost;
        }, 0);
      }
      return 0;
    }
    
    if (budget.scope === 'all') {
      return costs.reduce((sum, c) => {
        const amount = typeof c === 'object' ? c.total || c.amount || 0 : c;
        return sum + amount;
      }, 0);
    } else if (budget.scope === 'service' && budget.services) {
      return costs
        .filter(c => {
          const serviceName = c.service || c.service_name || c.name;
          return budget.services.includes(serviceName);
        })
        .reduce((sum, c) => sum + (c.total || c.amount || 0), 0);
    } else if (budget.scope === 'namespace' && budget.namespaces) {
      return costs
        .filter(c => budget.namespaces.includes(c.namespace))
        .reduce((sum, c) => sum + (c.total || c.amount || 0), 0);
    }
    
    return 0;
  }

  /**
   * 默认通知器
   */
  async defaultNotifier(notification) {
    logger.info(notification, 'Budget notification');
  }

  /**
   * 重置告警状态（新周期）
   */
  resetAlerts() {
    clearThresholdTriggers();
    logger.info('Budget alert states reset');
  }

  /**
   * 从数据库加载预算配置
   */
  async loadFromDatabase(db) {
    try {
      const result = await db.query(`
        SELECT name, amount, currency, period, scope, 
               scope_values, alert_thresholds, notifications, 
               start_date, end_date
        FROM budget_configs
        WHERE end_date IS NULL OR end_date > NOW()
      `);
      
      for (const row of result.rows) {
        this.addBudget({
          name: row.name,
          amount: row.amount,
          currency: row.currency,
          period: row.period,
          scope: row.scope,
          services: row.scope_values?.services || [],
          namespaces: row.scope_values?.namespaces || [],
          alertThresholds: row.alert_thresholds || this.alertThresholds,
          notifications: row.notifications || [],
          startDate: row.start_date,
          endDate: row.end_date
        });
      }
      
      logger.info({ count: result.rows.length }, 'Budgets loaded from database');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to load budgets from database');
    }
  }

  /**
   * 保存预算到数据库
   */
  async saveToDatabase(db, budget) {
    try {
      await db.query(`
        INSERT INTO budget_configs 
          (name, amount, currency, period, scope, scope_values, alert_thresholds, notifications, start_date, end_date)
        VALUES 
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (name) DO UPDATE SET
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          period = EXCLUDED.period,
          scope = EXCLUDED.scope,
          scope_values = EXCLUDED.scope_values,
          alert_thresholds = EXCLUDED.alert_thresholds,
          notifications = EXCLUDED.notifications,
          end_date = EXCLUDED.end_date,
          updated_at = NOW()
      `, [
        budget.name,
        budget.amount,
        budget.currency || 'USD',
        budget.period || 'monthly',
        budget.scope || 'all',
        JSON.stringify({
          services: budget.services || [],
          namespaces: budget.namespaces || []
        }),
        JSON.stringify(budget.alertThresholds || this.alertThresholds),
        JSON.stringify(budget.notifications || []),
        budget.startDate || new Date(),
        budget.endDate || null
      ]);
      
      logger.info({ budget: budget.name }, 'Budget saved to database');
    } catch (error) {
      logger.error({ budget: budget.name, error: error.message }, 'Failed to save budget to database');
      throw error;
    }
  }
}

module.exports = { BudgetManager };
