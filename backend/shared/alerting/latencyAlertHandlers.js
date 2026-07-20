/**
 * REQ-00599: 延迟异常告警处理器
 * 支持多种告警渠道：日志、Webhook、Slack、钉钉等
 */

const logger = require('../logger');
const axios = require('axios');
const { metrics } = require('../metrics');

/**
 * 告警处理器基类
 */
class AlertHandler {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.severityFilter = options.severityFilter || ['warning', 'critical'];
  }

  /**
   * 处理告警
   * @param {Object} alert - 告警对象
   */
  async handle(alert) {
    if (!this.enabled) {
      return;
    }
    
    if (!this.severityFilter.includes(alert.severity)) {
      return;
    }
    
    await this.process(alert);
  }

  /**
   * 处理告警（子类实现）
   * @param {Object} alert - 告警对象
   */
  async process(alert) {
    throw new Error('Subclass must implement process()');
  }
}

/**
 * 日志告警处理器
 */
class LogAlertHandler extends AlertHandler {
  async process(alert) {
    logger.error('LATENCY_ANOMALY_ALERT', {
      type: alert.type,
      severity: alert.severity,
      endpoint: alert.endpoint,
      latency: alert.latency,
      threshold: alert.baseline.threshold,
      deviation: alert.deviation,
      deviationPercent: alert.deviationPercent,
      timestamp: new Date(alert.timestamp).toISOString()
    });
    
    metrics.increment('latency_alerts_log_total', 1, {
      severity: alert.severity
    });
  }
}

/**
 * Webhook 告警处理器
 */
class WebhookAlertHandler extends AlertHandler {
  constructor(options = {}) {
    super(options);
    this.webhookUrl = options.webhookUrl;
    this.timeout = options.timeout || 5000;
    this.headers = options.headers || {};
  }

  async process(alert) {
    if (!this.webhookUrl) {
      logger.warn('Webhook URL not configured, skipping webhook alert');
      return;
    }
    
    try {
      const payload = {
        alert_type: alert.type,
        severity: alert.severity,
        endpoint: alert.endpoint,
        current_latency_ms: alert.latency,
        baseline: alert.baseline,
        deviation_ms: alert.deviation,
        deviation_percent: alert.deviationPercent,
        consecutive_count: alert.consecutiveCount,
        timestamp: alert.timestamp,
        message: `API latency anomaly detected: ${alert.endpoint} latency ${alert.latency}ms exceeds baseline threshold ${alert.baseline.threshold}ms by ${alert.deviationPercent}%`
      };
      
      await axios.post(this.webhookUrl, payload, {
        headers: this.headers,
        timeout: this.timeout
      });
      
      logger.info('Webhook alert sent', {
        endpoint: alert.endpoint,
        webhookUrl: this.webhookUrl
      });
      
      metrics.increment('latency_alerts_webhook_total', 1, {
        severity: alert.severity,
        status: 'success'
      });
    } catch (error) {
      logger.error('Failed to send webhook alert', {
        error: error.message,
        endpoint: alert.endpoint
      });
      
      metrics.increment('latency_alerts_webhook_total', 1, {
        severity: alert.severity,
        status: 'failed'
      });
    }
  }
}

/**
 * Slack 告警处理器
 */
class SlackAlertHandler extends AlertHandler {
  constructor(options = {}) {
    super(options);
    this.webhookUrl = options.webhookUrl;
    this.channel = options.channel;
    this.username = options.username || 'mineGo Alert Bot';
    this.iconEmoji = options.iconEmoji || ':warning:';
  }

  async process(alert) {
    if (!this.webhookUrl) {
      logger.warn('Slack webhook URL not configured, skipping Slack alert');
      return;
    }
    
    try {
      const color = alert.severity === 'critical' ? 'danger' : 'warning';
      const emoji = alert.severity === 'critical' ? '🚨' : '⚠️';
      
      const payload = {
        channel: this.channel,
        username: this.username,
        icon_emoji: this.iconEmoji,
        attachments: [{
          color,
          title: `${emoji} API Latency Anomaly Detected`,
          fields: [
            {
              title: 'Endpoint',
              value: alert.endpoint,
              short: true
            },
            {
              title: 'Severity',
              value: alert.severity.toUpperCase(),
              short: true
            },
            {
              title: 'Current Latency',
              value: `${alert.latency}ms`,
              short: true
            },
            {
              title: 'Threshold',
              value: `${alert.baseline.threshold}ms`,
              short: true
            },
            {
              title: 'Deviation',
              value: `${alert.deviation}ms (${alert.deviationPercent}%)`,
              short: true
            },
            {
              title: 'Baseline (P95/P99)',
              value: `${alert.baseline.p95}ms / ${alert.baseline.p99}ms`,
              short: true
            }
          ],
          footer: 'mineGo Latency Anomaly Detector',
          ts: Math.floor(alert.timestamp / 1000)
        }]
      };
      
      await axios.post(this.webhookUrl, payload, {
        timeout: 5000
      });
      
      logger.info('Slack alert sent', {
        endpoint: alert.endpoint,
        severity: alert.severity
      });
      
      metrics.increment('latency_alerts_slack_total', 1, {
        severity: alert.severity,
        status: 'success'
      });
    } catch (error) {
      logger.error('Failed to send Slack alert', {
        error: error.message,
        endpoint: alert.endpoint
      });
      
      metrics.increment('latency_alerts_slack_total', 1, {
        severity: alert.severity,
        status: 'failed'
      });
    }
  }
}

/**
 * 钉钉告警处理器
 */
class DingTalkAlertHandler extends AlertHandler {
  constructor(options = {}) {
    super(options);
    this.webhookUrl = options.webhookUrl;
    this.secret = options.secret;
    this.atMobiles = options.atMobiles || [];
    this.isAtAll = options.isAtAll || false;
  }

  async process(alert) {
    if (!this.webhookUrl) {
      logger.warn('DingTalk webhook URL not configured, skipping DingTalk alert');
      return;
    }
    
    try {
      const emoji = alert.severity === 'critical' ? '🚨' : '⚠️';
      const title = `${emoji} API 延迟异常告警`;
      
      const text = `### ${title}
      
**端点**: ${alert.endpoint}
**严重程度**: ${alert.severity.toUpperCase()}
**当前延迟**: ${alert.latency}ms
**阈值**: ${alert.baseline.threshold}ms
**偏离**: ${alert.deviation}ms (${alert.deviationPercent}%)
**基准 (P95/P99)**: ${alert.baseline.p95}ms / ${alert.baseline.p99}ms
**连续异常次数**: ${alert.consecutiveCount}

**时间**: ${new Date(alert.timestamp).toISOString()}
`;
      
      const payload = {
        msgtype: 'markdown',
        markdown: {
          title,
          text
        },
        at: {
          atMobiles: this.atMobiles,
          isAtAll: this.isAtAll
        }
      };
      
      // 如果配置了密钥，添加签名
      if (this.secret) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${this.secret}`;
        const crypto = require('crypto');
        const hmac = crypto.createHmac('sha256', this.secret);
        hmac.update(stringToSign);
        const sign = hmac.digest('base64');
        
        payload.sign = sign;
        payload.timestamp = timestamp;
      }
      
      await axios.post(this.webhookUrl, payload, {
        timeout: 5000
      });
      
      logger.info('DingTalk alert sent', {
        endpoint: alert.endpoint,
        severity: alert.severity
      });
      
      metrics.increment('latency_alerts_dingtalk_total', 1, {
        severity: alert.severity,
        status: 'success'
      });
    } catch (error) {
      logger.error('Failed to send DingTalk alert', {
        error: error.message,
        endpoint: alert.endpoint
      });
      
      metrics.increment('latency_alerts_dingtalk_total', 1, {
        severity: alert.severity,
        status: 'failed'
      });
    }
  }
}

/**
 * 复合告警处理器
 * 支持同时配置多个告警渠道
 */
class CompositeAlertHandler extends AlertHandler {
  constructor(options = {}) {
    super(options);
    this.handlers = [];
  }

  /**
   * 添加告警处理器
   * @param {AlertHandler} handler - 告警处理器实例
   */
  addHandler(handler) {
    this.handlers.push(handler);
  }

  async process(alert) {
    // 并行调用所有处理器
    const promises = this.handlers.map(handler => {
      return handler.handle(alert).catch(error => {
        logger.error('Alert handler failed', {
          error: error.message,
          handler: handler.constructor.name
        });
      });
    });
    
    await Promise.all(promises);
  }
}

/**
 * 创建默认告警处理器
 */
function createDefaultAlertHandlers(config = {}) {
  const composite = new CompositeAlertHandler();
  
  // 总是添加日志处理器
  composite.addHandler(new LogAlertHandler());
  
  // 添加 Webhook 处理器
  if (config.webhookUrl) {
    composite.addHandler(new WebhookAlertHandler({
      webhookUrl: config.webhookUrl,
      headers: config.webhookHeaders
    }));
  }
  
  // 添加 Slack 处理器
  if (config.slackWebhookUrl) {
    composite.addHandler(new SlackAlertHandler({
      webhookUrl: config.slackWebhookUrl,
      channel: config.slackChannel,
      username: config.slackUsername,
      iconEmoji: config.slackIconEmoji
    }));
  }
  
  // 添加钉钉处理器
  if (config.dingtalkWebhookUrl) {
    composite.addHandler(new DingTalkAlertHandler({
      webhookUrl: config.dingtalkWebhookUrl,
      secret: config.dingtalkSecret,
      atMobiles: config.dingtalkAtMobiles,
      isAtAll: config.dingtalkIsAtAll
    }));
  }
  
  return composite;
}

module.exports = {
  AlertHandler,
  LogAlertHandler,
  WebhookAlertHandler,
  SlackAlertHandler,
  DingTalkAlertHandler,
  CompositeAlertHandler,
  createDefaultAlertHandlers
};
