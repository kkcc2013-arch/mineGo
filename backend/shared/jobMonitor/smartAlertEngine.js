/**
 * 智能告警引擎 - 失败告警、噪音抑制、聚合发送
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const { EventEmitter } = require('events');
const Redis = require('ioredis');

class NoiseSuppressor {
  constructor(redis, suppressWindowMs = 600000) { // 默认10分钟抑制窗口
    this.redis = redis;
    this.suppressWindowMs = suppressWindowMs;
    this.alertHistoryKey = 'minego:alerts:history';
  }

  /**
   * 检查是否应该抑制告警
   * @param {string} alertKey 告警唯一标识
   */
  async shouldSuppress(alertKey) {
    const lastAlert = await this.redis.get(`${this.alertHistoryKey}:${alertKey}`);
    if (!lastAlert) return false;

    const lastTime = parseInt(lastAlert, 10);
    return Date.now() - lastTime < this.suppressWindowMs;
  }

  /**
   * 记录告警发送
   * @param {string} alertKey 告警唯一标识
   */
  async recordAlert(alertKey) {
    await this.redis.set(
      `${this.alertHistoryKey}:${alertKey}`,
      Date.now().toString(),
      'EX',
      Math.ceil(this.suppressWindowMs / 1000) + 60
    );
  }

  /**
   * 重置抑制状态
   */
  async reset(alertKey) {
    await this.redis.del(`${this.alertHistoryKey}:${alertKey}`);
  }
}

class AlertAggregator {
  constructor(redis, aggregateWindowMs = 300000) { // 默认5分钟聚合窗口
    this.redis = redis;
    this.aggregateWindowMs = aggregateWindowMs;
    this.pendingKey = 'minego:alerts:pending';
  }

  /**
   * 添加待聚合告警
   */
  async add(alert) {
    const score = Date.now();
    await this.redis.zadd(this.pendingKey, score, JSON.stringify(alert));
    
    // 清理过期的待聚合告警
    const cutoff = score - this.aggregateWindowMs;
    await this.redis.zremrangebyscore(this.pendingKey, '-inf', cutoff);
  }

  /**
   * 获取聚合的告警
   */
  async getAggregated() {
    const now = Date.now();
    const cutoff = now - this.aggregateWindowMs;
    
    const pending = await this.redis.zrangebyscore(this.pendingKey, cutoff, now);
    
    if (pending.length === 0) return null;

    const alerts = pending.map(p => JSON.parse(p));
    
    // 按严重级别和类别聚合
    const aggregated = {
      critical: alerts.filter(a => a.severity === 'critical'),
      high: alerts.filter(a => a.severity === 'high'),
      medium: alerts.filter(a => a.severity === 'medium'),
      low: alerts.filter(a => a.severity === 'low'),
      byCategory: {}
    };

    for (const alert of alerts) {
      const cat = alert.category || 'general';
      if (!aggregated.byCategory[cat]) {
        aggregated.byCategory[cat] = [];
      }
      aggregated.byCategory[cat].push(alert);
    }

    // 清理已处理的告警
    await this.redis.zremrangebyscore(this.pendingKey, '-inf', now);

    return aggregated;
  }
}

class AlertChannel {
  constructor(type, config) {
    this.type = type;
    this.config = config;
  }

  async send(alert) {
    switch (this.type) {
      case 'console':
        return this.sendConsole(alert);
      case 'webhook':
        return this.sendWebhook(alert);
      case 'slack':
        return this.sendSlack(alert);
      case 'email':
        return this.sendEmail(alert);
      default:
        console.warn(`[AlertChannel] Unknown channel type: ${this.type}`);
    }
  }

  async sendConsole(alert) {
    const emoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    }[alert.severity] || '⚪';

    console.log(`\n${emoji} [ALERT] ${alert.severity.toUpperCase()}`);
    console.log(`   Job: ${alert.jobName} (${alert.jobId})`);
    console.log(`   Type: ${alert.alertType}`);
    console.log(`   Message: ${alert.message}`);
    if (alert.suggestion) {
      console.log(`   Suggestion: ${alert.suggestion}`);
    }
    console.log(`   Time: ${alert.timestamp}\n`);
  }

  async sendWebhook(alert) {
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...alert,
        channel: this.type,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }

    return response;
  }

  async sendSlack(alert) {
    const fetch = (await import('node-fetch')).default;

    const color = {
      critical: '#ff0000',
      high: '#ff9900',
      medium: '#ffcc00',
      low: '#36a64f'
    }[alert.severity] || '#cccccc';

    const body = {
      channel: this.config.channel,
      attachments: [{
        color,
        title: `⚠️ ${alert.severity.toUpperCase()}: ${alert.jobName}`,
        fields: [
          { title: 'Job ID', value: alert.jobId, short: true },
          { title: 'Alert Type', value: alert.alertType, short: true },
          { title: 'Message', value: alert.message, short: false },
          ...(alert.suggestion ? [{ title: '💡 Suggestion', value: alert.suggestion, short: false }] : [])
        ],
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    return response;
  }

  async sendEmail(alert) {
    // 简化实现，实际项目中应使用 nodemailer
    console.log(`[Email] Would send to ${this.config.to}:`, alert);
    return true;
  }
}

class SmartAlertEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.redis = options.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.noiseSuppressor = new NoiseSuppressor(this.redis, options.suppressWindowMs || 600000);
    this.aggregator = new AlertAggregator(this.redis, options.aggregateWindowMs || 300000);
    this.channels = new Map();
    this.rules = new Map();
    this.failureHistory = new Map();
    this.maxHistorySize = 100;
  }

  /**
   * 注册告警通道
   * @param {string} name 通道名称
   * @param {string} type 通道类型：console | webhook | slack | email
   * @param {object} config 通道配置
   */
  registerChannel(name, type, config) {
    this.channels.set(name, new AlertChannel(type, config));
    console.log(`[SmartAlertEngine] Registered channel: ${name} (${type})`);
  }

  /**
   * 添加告警规则
   * @param {object} rule 规则配置
   */
  addAlertRule(rule) {
    const { jobId, conditions, severity, channels } = rule;
    this.rules.set(jobId, {
      ...rule,
      conditions: {
        failureCount: conditions.failureCount || 1,
        timeoutMinutes: conditions.timeoutMinutes || 30,
        consecutiveFailures: conditions.consecutiveFailures || 3,
        ...conditions
      }
    });
  }

  /**
   * 检查并触发告警
   * @param {string} jobId 任务ID
   * @param {object} status 状态数据
   */
  async checkAndAlert(jobId, status) {
    // 记录失败历史
    if (status.status === 'failed') {
      this.recordFailure(jobId, status);
    }

    // 获取告警规则
    const rule = this.rules.get(jobId) || this.rules.get('*'); // '*' 为默认规则
    if (!rule) return;

    const shouldAlert = await this.evaluateConditions(jobId, status, rule.conditions);
    
    if (shouldAlert) {
      const alertKey = `${jobId}:${shouldAlert.type}`;
      
      // 噪音抑制检查
      if (await this.noiseSuppressor.shouldSuppress(alertKey)) {
        console.log(`[SmartAlertEngine] Suppressed duplicate alert: ${alertKey}`);
        return;
      }

      // 创建告警
      const alert = this.createAlert(jobId, status, shouldAlert, rule);
      
      // 添加到聚合器
      await this.aggregator.add(alert);

      // 发送告警
      await this.sendAlert(alert, rule.channels || Array.from(this.channels.keys()));

      // 记录已发送
      await this.noiseSuppressor.recordAlert(alertKey);

      this.emit('alert', alert);
    }
  }

  /**
   * 评估告警条件
   */
  async evaluateConditions(jobId, status, conditions) {
    const failures = this.failureHistory.get(jobId) || [];

    // 检查单次失败
    if (status.status === 'failed' && conditions.failureCount <= 1) {
      return { type: 'single_failure', severity: 'high' };
    }

    // 检查连续失败
    if (conditions.consecutiveFailures > 1) {
      const recentFailures = this.getConsecutiveFailures(jobId);
      if (recentFailures >= conditions.consecutiveFailures) {
        return { type: 'consecutive_failures', severity: 'critical', count: recentFailures };
      }
    }

    // 检查超时
    if (status.status === 'running' && status.startTime) {
      const runningMinutes = (Date.now() - new Date(status.startTime).getTime()) / 60000;
      if (runningMinutes > conditions.timeoutMinutes) {
        return { type: 'timeout', severity: 'high', minutes: Math.round(runningMinutes) };
      }
    }

    // 检查失败率
    if (conditions.failureRateThreshold && failures.length >= conditions.failureRateSampleSize) {
      const recentFailures = failures.slice(-conditions.failureRateSampleSize);
      const failureRate = recentFailures.filter(f => f.status === 'failed').length / recentFailures.length;
      if (failureRate > conditions.failureRateThreshold) {
        return { type: 'high_failure_rate', severity: 'high', rate: failureRate };
      }
    }

    return null;
  }

  /**
   * 记录失败
   */
  recordFailure(jobId, status) {
    let history = this.failureHistory.get(jobId) || [];
    history.push({
      status: status.status,
      timestamp: Date.now(),
      error: status.error
    });

    // 限制历史大小
    if (history.length > this.maxHistorySize) {
      history = history.slice(-this.maxHistorySize);
    }

    this.failureHistory.set(jobId, history);
  }

  /**
   * 获取连续失败次数
   */
  getConsecutiveFailures(jobId) {
    const history = this.failureHistory.get(jobId) || [];
    let count = 0;
    
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].status === 'failed') {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * 创建告警对象
   */
  createAlert(jobId, status, condition, rule) {
    const severity = condition.severity || 'medium';
    
    return {
      alertId: `alert-${jobId}-${Date.now()}`,
      jobId,
      jobName: status.jobName || jobId,
      category: status.category || 'general',
      alertType: condition.type,
      severity,
      message: this.generateMessage(jobId, status, condition),
      suggestion: this.analyzeRootCause(jobId, condition),
      status,
      timestamp: new Date().toISOString(),
      metadata: {
        condition,
        failureCount: this.getConsecutiveFailures(jobId)
      }
    };
  }

  /**
   * 生成告警消息
   */
  generateMessage(jobId, status, condition) {
    const jobName = status.jobName || jobId;
    
    switch (condition.type) {
      case 'single_failure':
        return `Task ${jobName} failed with error: ${status.error || 'Unknown error'}`;
      case 'consecutive_failures':
        return `Task ${jobName} has failed ${condition.count} times in a row`;
      case 'timeout':
        return `Task ${jobName} has been running for ${condition.minutes} minutes (threshold: 30 min)`;
      case 'high_failure_rate':
        return `Task ${jobName} has a high failure rate: ${Math.round(condition.rate * 100)}%`;
      default:
        return `Task ${jobName} triggered an alert: ${condition.type}`;
    }
  }

  /**
   * 根因分析建议
   */
  analyzeRootCause(jobId, condition) {
    const history = this.failureHistory.get(jobId) || [];
    const errors = history.filter(h => h.error).map(h => h.error);

    // 分析错误模式
    if (errors.length > 0) {
      // 检查常见错误类型
      const errorPatterns = {
        'ECONNREFUSED': 'Database connection refused. Check PostgreSQL service status.',
        'ETIMEDOUT': 'Connection timeout. Check network connectivity or increase timeout.',
        'ENOSPC': 'Disk space insufficient. Clean up old data or expand storage.',
        'ENOMEM': 'Memory allocation failed. Consider increasing container memory limits.',
        'connection': 'Connection error. Verify database/Redis connections.',
        'timeout': 'Operation timeout. Check for long-running queries or increase timeout.',
        'disk': 'Disk-related error. Check disk space and I/O performance.'
      };

      for (const [pattern, suggestion] of Object.entries(errorPatterns)) {
        const lastError = errors[errors.length - 1] || '';
        if (lastError.toLowerCase().includes(pattern.toLowerCase())) {
          return suggestion;
        }
      }
    }

    // 根据任务类型给出建议
    if (condition.type === 'consecutive_failures') {
      return `Check recent changes to ${jobId} task or its dependencies. Review logs for patterns.`;
    }

    if (condition.type === 'timeout') {
      return 'Consider optimizing task performance or increasing timeout threshold.';
    }

    return 'Review task logs for detailed error information.';
  }

  /**
   * 发送告警
   */
  async sendAlert(alert, channelNames) {
    for (const name of channelNames) {
      const channel = this.channels.get(name);
      if (!channel) {
        console.warn(`[SmartAlertEngine] Channel not found: ${name}`);
        continue;
      }

      try {
        await channel.send(alert);
        console.log(`[SmartAlertEngine] Alert sent via ${name}:`, alert.alertId);
      } catch (error) {
        console.error(`[SmartAlertEngine] Failed to send via ${name}:`, error.message);
        this.emit('sendError', { channel: name, alert, error });
      }
    }
  }

  /**
   * 手动触发告警（用于测试）
   */
  async triggerAlert(alert) {
    await this.sendAlert(alert, Array.from(this.channels.keys()));
  }

  /**
   * 关闭引擎
   */
  async close() {
    await this.redis.quit();
    console.log('[SmartAlertEngine] Closed');
  }
}

module.exports = { SmartAlertEngine, NoiseSuppressor, AlertAggregator, AlertChannel };
