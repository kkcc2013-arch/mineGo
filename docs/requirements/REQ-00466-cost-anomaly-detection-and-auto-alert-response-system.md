# REQ-00466：成本异常检测与自动告警响应系统

- **编号**：REQ-00466
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/cost-alerting、backend/jobs/cost-monitor、monitoring/alerts
- **创建时间**：2026-07-07 00:20 UTC
- **依赖需求**：REQ-00367（成本归因引擎已完成）、budgetManager.js（预算管理已存在）

## 1. 背景与问题

当前 mineGo 项目已有成本管理基础设施，但缺少主动的成本异常检测和告警响应机制：

1. **被动监控**：CostAttributionEngine 和 costMonitor 只记录成本，无主动告警
2. **预算超限无响应**：budgetManager 定义了阈值，但未实现自动防护动作
3. **缺少异常检测**：成本波动、异常峰值无智能检测算法
4. **告警渠道单一**：仅日志记录，无集成 Slack/PagerDuty 等告警系统
5. **无自动降级**：成本超标时缺少自动限流、降级等防护措施

**代码现状**：
- `CostAttributionEngine.js`：成本归因和优化建议生成
- `budgetManager.js`：预算配置和阈值定义
- `costMonitor.js`：基础成本监控
- `costPredictor.js`：成本预测（未集成告警）
- 缺少：异常检测、多渠道告警、自动响应

## 2. 目标

构建完整的成本异常检测与自动告警响应系统：

1. **智能异常检测**：使用统计学方法检测成本异常波动
2. **多渠道告警**：集成 Slack、Email、Webhook 等告警渠道
3. **分级告警策略**：根据严重程度采用不同告警频率和渠道
4. **自动响应机制**：成本超标时自动触发限流、降级等防护
5. **成本趋势分析**：预测成本趋势，提前预警预算风险

## 3. 范围

### 包含
- 成本异常检测算法实现
- 告警渠道集成（Slack、Email、Webhook）
- 告警聚合与降噪机制
- 自动响应策略（限流、降级、通知）
- 成本趋势预测与预警
- 预算超限自动防护
- 告警历史记录与审计

### 不包含
- 成本归因计算（REQ-00367 已完成）
- 预算管理配置（budgetManager 已存在）
- 成本可视化仪表板（待后续需求）

## 4. 详细需求

### 4.1 成本异常检测算法

创建 `backend/shared/cost-alerting/CostAnomalyDetector.js`：

```javascript
/**
 * 成本异常检测器
 * 使用统计学方法检测成本异常
 */
class CostAnomalyDetector {
  constructor(options = {}) {
    // Z-score 阈值（超出此值视为异常）
    this.zScoreThreshold = options.zScoreThreshold || 2.5;
    // 移动平均窗口大小
    this.windowSize = options.windowSize || 7;  // 7天
    // 最小数据点数量
    this.minDataPoints = options.minDataPoints || 5;
    // 季节性周期（小时）
    this.seasonalPeriod = options.seasonalPeriod || 24;
  }

  /**
   * 检测成本异常
   * @param {Array<number>} historicalCosts - 历史成本数据
   * @param {number} currentCost - 当前成本
   * @returns {Object} 检测结果
   */
  detect(historicalCosts, currentCost) {
    if (historicalCosts.length < this.minDataPoints) {
      return { isAnomaly: false, reason: 'Insufficient data points' };
    }

    // 计算 Z-score
    const mean = this.calculateMean(historicalCosts);
    const stdDev = this.calculateStdDev(historicalCosts, mean);
    const zScore = (currentCost - mean) / stdDev;

    // 检测异常
    const isAnomaly = Math.abs(zScore) > this.zScoreThreshold;

    // 检测趋势变化
    const trendDirection = this.detectTrend(historicalCosts);

    return {
      isAnomaly,
      zScore,
      mean,
      stdDev,
      currentCost,
      expectedRange: {
        min: mean - this.zScoreThreshold * stdDev,
        max: mean + this.zScoreThreshold * stdDev
      },
      trendDirection,
      anomalyType: this.classifyAnomaly(zScore, currentCost, mean),
      severity: this.calculateSeverity(zScore)
    };
  }

  /**
   * 分类异常类型
   */
  classifyAnomaly(zScore, currentCost, mean) {
    if (currentCost > mean * 2) return 'cost_spike';
    if (currentCost > mean * 1.5) return 'cost_increase';
    if (currentCost < mean * 0.5) return 'cost_decrease';
    if (zScore > this.zScoreThreshold) return 'high_variance';
    return 'normal';
  }

  /**
   * 计算严重程度
   */
  calculateSeverity(zScore) {
    const absZScore = Math.abs(zScore);
    if (absZScore > 4) return 'critical';
    if (absZScore > 3) return 'high';
    if (absZScore > 2.5) return 'medium';
    return 'low';
  }

  /**
   * 计算移动平均
   */
  calculateMovingAverage(data, windowSize) {
    if (data.length < windowSize) return this.calculateMean(data);
    
    const window = data.slice(-windowSize);
    return this.calculateMean(window);
  }

  /**
   * 检测趋势方向
   */
  detectTrend(data) {
    if (data.length < 3) return 'stable';
    
    const recent = data.slice(-3);
    const earlier = data.slice(-6, -3);
    
    const recentMean = this.calculateMean(recent);
    const earlierMean = this.calculateMean(earlier);
    
    const changeRate = (recentMean - earlierMean) / earlierMean;
    
    if (changeRate > 0.2) return 'increasing';
    if (changeRate < -0.2) return 'decreasing';
    return 'stable';
  }

  calculateMean(data) {
    return data.reduce((sum, val) => sum + val, 0) / data.length;
  }

  calculateStdDev(data, mean) {
    const squaredDiffs = data.map(val => Math.pow(val - mean, 2));
    return Math.sqrt(this.calculateMean(squaredDiffs));
  }
}
```

### 4.2 告警渠道集成

创建 `backend/shared/cost-alerting/CostAlertChannel.js`：

```javascript
/**
 * 告警渠道管理器
 * 支持多渠道告警发送
 */
class CostAlertChannel {
  constructor(options = {}) {
    this.channels = {
      slack: new SlackChannel(options.slack),
      email: new EmailChannel(options.email),
      webhook: new WebhookChannel(options.webhook),
      pagerduty: new PagerDutyChannel(options.pagerduty)
    };
  }

  /**
   * 发送告警到指定渠道
   * @param {Object} alert - 告警内容
   * @param {Array<string>} targetChannels - 目标渠道列表
   */
  async send(alert, targetChannels = ['slack', 'email']) {
    const results = [];
    
    for (const channelName of targetChannels) {
      const channel = this.channels[channelName];
      if (!channel) {
        console.warn(`Unknown channel: ${channelName}`);
        continue;
      }
      
      try {
        await channel.send(alert);
        results.push({ channel: channelName, success: true });
      } catch (error) {
        results.push({ channel: channelName, success: false, error: error.message });
      }
    }
    
    return results;
  }
}

/**
 * Slack 告警渠道
 */
class SlackChannel {
  constructor(config) {
    this.webhookUrl = config?.webhookUrl;
    this.channel = config?.channel || '#cost-alerts';
  }

  async send(alert) {
    if (!this.webhookUrl) return;

    const payload = {
      channel: this.channel,
      attachments: [{
        color: this.getColor(alert.severity),
        title: `Cost Alert: ${alert.type}`,
        fields: [
          { title: 'Severity', value: alert.severity, short: true },
          { title: 'Current Cost', value: `$${alert.currentCost.toFixed(2)}`, short: true },
          { title: 'Expected Range', value: `$${alert.expectedRange.min.toFixed(2)} - $${alert.expectedRange.max.toFixed(2)}`, short: false },
          { title: 'Anomaly Score', value: alert.zScore.toFixed(2), short: true },
          { title: 'Time', value: new Date().toISOString(), short: true }
        ],
        footer: 'mineGo Cost Alerting System'
      }]
    };

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  getColor(severity) {
    switch (severity) {
      case 'critical': return 'danger';
      case 'high': return 'warning';
      case 'medium': return '#FFA500';
      default: return 'good';
    }
  }
}

/**
 * Email 告警渠道
 */
class EmailChannel {
  constructor(config) {
    this.recipients = config?.recipients || [];
    this.from = config?.from;
  }

  async send(alert) {
    // 使用现有的邮件服务发送
    const subject = `[Cost Alert] ${alert.severity.toUpperCase()}: ${alert.type}`;
    const body = `
Cost anomaly detected:

Severity: ${alert.severity}
Type: ${alert.type}
Current Cost: $${alert.currentCost.toFixed(2)}
Expected Range: $${alert.expectedRange.min.toFixed(2)} - $${alert.expectedRange.max.toFixed(2)}
Z-Score: ${alert.zScore.toFixed(2)}

Timestamp: ${new Date().toISOString()}

---
mineGo Cost Alerting System
    `;

    // 调用邮件服务
    // await sendEmail(this.recipients, subject, body);
  }
}

/**
 * Webhook 告警渠道
 */
class WebhookChannel {
  constructor(config) {
    this.url = config?.url;
  }

  async send(alert) {
    if (!this.url) return;

    await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'mineGo',
        type: 'cost_alert',
        severity: alert.severity,
        data: alert,
        timestamp: new Date().toISOString()
      })
    });
  }
}
```

### 4.3 告警聚合与降噪

创建 `backend/shared/cost-alerting/AlertAggregator.js`：

```javascript
/**
 * 告警聚合器
 * 避免告警风暴，实现告警降噪
 */
class AlertAggregator {
  constructor(options = {}) {
    // 聚合窗口（秒）
    this.windowSeconds = options.windowSeconds || 300;  // 5分钟
    // 相同告警阈值（窗口内超过此数量才发送）
    this.threshold = options.threshold || 3;
    // 冷却期（秒）
    this.coolDownSeconds = options.coolDownSeconds || 900;  // 15分钟
    // 历史告警缓存
    this.alertHistory = new Map();
  }

  /**
   * 处理告警
   * @param {Object} alert - 原始告警
   * @returns {Object|null} 聚合后的告警或 null（被降噪）
   */
  process(alert) {
    const key = this.generateAlertKey(alert);
    const now = Date.now();

    // 获取历史记录
    let history = this.alertHistory.get(key) || {
      count: 0,
      firstTime: now,
      lastSent: 0,
      aggregatedAlerts: []
    };

    // 检查冷却期
    if (now - history.lastSent < this.coolDownSeconds * 1000) {
      history.aggregatedAlerts.push(alert);
      this.alertHistory.set(key, history);
      return null;  // 冷却期内，不发送
    }

    // 更新计数
    history.count++;
    history.aggregatedAlerts.push(alert);

    // 检查是否需要发送
    if (history.count >= this.threshold) {
      // 创建聚合告警
      const aggregatedAlert = {
        ...alert,
        count: history.count,
        firstOccurrence: new Date(history.firstTime).toISOString(),
        lastOccurrence: new Date().toISOString(),
        aggregatedFrom: history.aggregatedAlerts.length,
        isAggregated: true
      };

      // 重置历史
      history.lastSent = now;
      history.count = 0;
      history.firstTime = now;
      history.aggregatedAlerts = [];
      this.alertHistory.set(key, history);

      return aggregatedAlert;
    }

    // 保存历史
    this.alertHistory.set(key, history);
    return null;
  }

  /**
   * 生成告警键
   */
  generateAlertKey(alert) {
    return `${alert.type}:${alert.severity}:${alert.scope || 'global'}`;
  }

  /**
   * 清理过期告警历史
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.windowSeconds * 1000 * 10;  // 10个窗口周期

    for (const [key, history] of this.alertHistory.entries()) {
      if (now - history.firstTime > maxAge) {
        this.alertHistory.delete(key);
      }
    }
  }
}
```

### 4.4 自动响应策略

创建 `backend/shared/cost-alerting/CostAutoResponder.js`：

```javascript
/**
 * 成本自动响应器
 * 当成本异常时自动触发防护措施
 */
class CostAutoResponder {
  constructor(options = {}) {
    this.rateLimiter = options.rateLimiter;
    this.degradationManager = options.degradationManager;
    this.notificationService = options.notificationService;

    // 响应策略配置
    this.strategies = {
      critical: {
        actions: ['throttle', 'degrade', 'notify_admin'],
        throttlePercent: 50,  // 限流50%
        degradeLevel: 'minimal'
      },
      high: {
        actions: ['throttle', 'notify'],
        throttlePercent: 30,
        degradeLevel: 'normal'
      },
      medium: {
        actions: ['notify'],
        throttlePercent: 0,
        degradeLevel: null
      },
      low: {
        actions: ['log'],
        throttlePercent: 0,
        degradeLevel: null
      }
    };
  }

  /**
   * 执行自动响应
   * @param {Object} anomaly - 异常检测结果
   * @param {Object} context - 上下文信息
   */
  async respond(anomaly, context) {
    const strategy = this.strategies[anomaly.severity];
    if (!strategy) {
      console.warn(`Unknown severity: ${anomaly.severity}`);
      return { executed: false };
    }

    const results = [];

    // 执行策略动作
    for (const action of strategy.actions) {
      try {
        const result = await this.executeAction(action, strategy, anomaly, context);
        results.push({ action, success: true, result });
      } catch (error) {
        results.push({ action, success: false, error: error.message });
      }
    }

    return {
      executed: true,
      severity: anomaly.severity,
      strategy: strategy.actions,
      results
    };
  }

  /**
   * 执行具体动作
   */
  async executeAction(action, strategy, anomaly, context) {
    switch (action) {
      case 'throttle':
        return await this.applyThrottle(strategy.throttlePercent, context);

      case 'degrade':
        return await this.applyDegradation(strategy.degradeLevel, context);

      case 'notify_admin':
        return await this.notifyAdmins(anomaly, context);

      case 'notify':
        return await this.notifyTeam(anomaly, context);

      case 'log':
        return await this.logAnomaly(anomaly, context);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * 应用限流
   */
  async applyThrottle(percent, context) {
    if (!this.rateLimiter) {
      throw new Error('Rate limiter not configured');
    }

    // 设置全局限流百分比
    await this.rateLimiter.setGlobalThrottle(percent);

    return {
      throttlePercent: percent,
      duration: '30m',
      reason: 'Cost anomaly detected'
    };
  }

  /**
   * 应用降级
   */
  async applyDegradation(level, context) {
    if (!this.degradationManager) {
      throw new Error('Degradation manager not configured');
    }

    await this.degradationManager.activateDegradation(level);

    return {
      degradeLevel: level,
      featuresDisabled: this.getFeaturesForLevel(level)
    };
  }

  /**
   * 通知管理员
   */
  async notifyAdmins(anomaly, context) {
    if (!this.notificationService) return;

    await this.notificationService.sendAdminAlert({
      type: 'cost_anomaly',
      severity: anomaly.severity,
      message: `Critical cost anomaly detected. Current cost: $${anomaly.currentCost.toFixed(2)}`,
      anomaly
    });
  }

  /**
   * 通知团队
   */
  async notifyTeam(anomaly, context) {
    if (!this.notificationService) return;

    await this.notificationService.sendTeamAlert({
      type: 'cost_warning',
      severity: anomaly.severity,
      message: `Cost anomaly detected. Please review usage.`
    });
  }

  /**
   * 记录异常日志
   */
  async logAnomaly(anomaly, context) {
    console.log('Cost anomaly logged:', {
      severity: anomaly.severity,
      type: anomaly.anomalyType,
      currentCost: anomaly.currentCost,
      zScore: anomaly.zScore,
      timestamp: new Date().toISOString()
    });
  }

  getFeaturesForLevel(level) {
    switch (level) {
      case 'minimal':
        return ['battle', 'trade', 'social'];
      case 'normal':
        return ['social'];
      default:
        return [];
    }
  }
}
```

### 4.5 定时监控任务

创建 `backend/jobs/cost-monitor/costAnomalyMonitor.js`：

```javascript
/**
 * 成本异常监控定时任务
 */
const CostAnomalyDetector = require('../../shared/cost-alerting/CostAnomalyDetector');
const CostAlertChannel = require('../../shared/cost-alerting/CostAlertChannel');
const AlertAggregator = require('../../shared/cost-alerting/AlertAggregator');
const CostAutoResponder = require('../../shared/cost-alerting/CostAutoResponder');
const CostAttributionEngine = require('../../shared/CostAttributionEngine');
const BudgetManager = require('../../shared/budgetManager');
const { getRedis } = require('../../shared/redis');
const logger = require('../../shared/logger').createLogger('cost-monitor');

class CostAnomalyMonitor {
  constructor() {
    this.detector = new CostAnomalyDetector();
    this.alertChannel = new CostAlertChannel({
      slack: { webhookUrl: process.env.SLACK_COST_WEBHOOK },
      email: { recipients: ['ops@minego.game'] }
    });
    this.aggregator = new AlertAggregator();
    this.autoResponder = new CostAutoResponder({
      rateLimiter: global.rateLimiter,
      degradationManager: global.degradationManager
    });
    this.costEngine = new CostAttributionEngine();
    this.budgetManager = new BudgetManager();
    this.redis = getRedis();
  }

  /**
   * 执行监控检查
   */
  async run() {
    logger.info('Starting cost anomaly monitoring');

    try {
      // 1. 获取当前成本数据
      const currentCost = await this.getCurrentCost();

      // 2. 获取历史成本数据
      const historicalCosts = await this.getHistoricalCosts();

      // 3. 检测异常
      const anomaly = this.detector.detect(historicalCosts, currentCost);

      if (anomaly.isAnomaly) {
        logger.warn('Cost anomaly detected', anomaly);

        // 4. 聚合告警
        const aggregatedAlert = this.aggregator.process(anomaly);

        if (aggregatedAlert) {
          // 5. 发送告警
          await this.sendAlert(aggregatedAlert);

          // 6. 自动响应
          if (anomaly.severity === 'critical' || anomaly.severity === 'high') {
            await this.autoResponder.respond(anomaly, {
              cost: currentCost,
              timestamp: new Date()
            });
          }
        }
      }

      // 7. 检查预算状态
      await this.checkBudgetStatus(currentCost);

      // 8. 清理过期告警
      this.aggregator.cleanup();

      logger.info('Cost anomaly monitoring completed');
    } catch (error) {
      logger.error('Cost monitoring failed', { error: error.message });
    }
  }

  /**
   * 获取当前成本
   */
  async getCurrentCost() {
    const today = new Date().toISOString().split('T')[0];
    const costData = await this.redis.get(`cost:daily:${today}`);
    return parseFloat(costData) || 0;
  }

  /**
   * 获取历史成本
   */
  async getHistoricalCosts() {
    const costs = [];
    for (let i = 1; i <= 30; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const cost = await this.redis.get(`cost:daily:${dateStr}`);
      if (cost) costs.push(parseFloat(cost));
    }
    return costs.reverse();
  }

  /**
   * 发送告警
   */
  async sendAlert(alert) {
    const channels = this.getChannelsForSeverity(alert.severity);
    await this.alertChannel.send(alert, channels);
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
    const budgets = await this.budgetManager.getAllBudgets();

    for (const budget of budgets) {
      const usage = currentCost / budget.amount;
      const thresholds = budget.alertThresholds.sort((a, b) => b - a);

      for (const threshold of thresholds) {
        if (usage >= threshold) {
          await this.sendBudgetAlert(budget, usage, threshold);
          break;
        }
      }
    }
  }

  /**
   * 发送预算告警
   */
  async sendBudgetAlert(budget, usage, threshold) {
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

    await this.alertChannel.send(alert, ['slack', 'email']);
  }
}

// 定时任务入口
async function startMonitoring() {
  const monitor = new CostAnomalyMonitor();

  // 每5分钟执行一次
  setInterval(() => monitor.run(), 5 * 60 * 1000);

  // 立即执行一次
  await monitor.run();
}

module.exports = { CostAnomalyMonitor, startMonitoring };
```

## 5. 验收标准（可测试）

- [ ] CostAnomalyDetector 实现并通过单元测试
- [ ] CostAlertChannel 实现并通过单元测试（Slack、Email、Webhook）
- [ ] AlertAggregator 实现并通过单元测试
- [ ] CostAutoResponder 实现并通过单元测试
- [ ] 定时监控任务启动并运行正常
- [ ] 异常检测准确率 > 80%（基于测试数据集）
- [ ] 告警发送成功率 > 95%
- [ ] 告警聚合减少告警数量 > 50%（对比无聚合）
- [ ] 预算超限告警自动触发
- [ ] 成本数据存储到 Redis（每日成本记录）

## 6. 工作量估算

**L（Large）** - 约 12-16 小时

**理由：**
- 异常检测算法实现（2-3h）
- 告警渠道集成（2-3h）
- 告警聚合与降噪（1-2h）
- 自动响应策略（2-3h）
- 定时监控任务（2-3h）
- 单元测试和集成测试（3h）

## 7. 优先级理由

**P1 理由：**

1. **成本控制关键**：云服务成本是生产环境的重要考量，异常成本可能导致预算超限
2. **主动防护**：自动响应机制可防止成本失控，避免财务风险
3. **告警必要**：运维团队需要及时了解成本异常，快速响应
4. **已有基础**：成本归因引擎已完成，告警系统是必要补充

**不为 P0 的原因：**
- 当前有基础监控，只是缺少主动告警
- 不属于阻塞性问题，但建议尽快实施