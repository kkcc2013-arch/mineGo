/**
 * REQ-00466: 成本告警渠道管理器
 * 支持多渠道告警发送
 */

const fetch = require('node-fetch');

class CostAlertChannel {
  constructor(options = {}) {
    this.channels = {};
    
    if (options.slack) {
      this.channels.slack = new SlackChannel(options.slack);
    }
    if (options.email) {
      this.channels.email = new EmailChannel(options.email);
    }
    if (options.webhook) {
      this.channels.webhook = new WebhookChannel(options.webhook);
    }
    if (options.pagerduty) {
      this.channels.pagerduty = new PagerDutyChannel(options.pagerduty);
    }
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
        console.warn(`[CostAlert] Unknown channel: ${channelName}`);
        continue;
      }
      
      try {
        await channel.send(alert);
        results.push({ channel: channelName, success: true });
      } catch (error) {
        console.error(`[CostAlert] Failed to send via ${channelName}:`, error.message);
        results.push({ channel: channelName, success: false, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * 添加渠道
   */
  addChannel(name, channel) {
    this.channels[name] = channel;
  }
}

/**
 * Slack 告警渠道
 */
class SlackChannel {
  constructor(config) {
    this.webhookUrl = config?.webhookUrl || process.env.SLACK_COST_WEBHOOK;
    this.channel = config?.channel || '#cost-alerts';
  }

  async send(alert) {
    if (!this.webhookUrl) {
      throw new Error('Slack webhook URL not configured');
    }

    const payload = {
      channel: this.channel,
      attachments: [{
        color: this.getColor(alert.severity),
        title: `💰 Cost Alert: ${alert.type}`,
        fields: [
          { title: 'Severity', value: alert.severity.toUpperCase(), short: true },
          { title: 'Current Cost', value: `$${(alert.currentCost || 0).toFixed(2)}`, short: true },
          { 
            title: 'Expected Range', 
            value: alert.expectedRange 
              ? `$${alert.expectedRange.min.toFixed(2)} - $${alert.expectedRange.max.toFixed(2)}` 
              : 'N/A',
            short: false 
          },
          { title: 'Anomaly Score', value: (alert.zScore || 0).toFixed(2), short: true },
          { title: 'Trend', value: alert.trendDirection || 'stable', short: true },
          { title: 'Time', value: new Date().toISOString(), short: false }
        ],
        footer: 'mineGo Cost Alerting System',
        footer_icon: 'https://minego.game/favicon.ico'
      }]
    };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }
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
    this.from = config?.from || 'noreply@minego.game';
  }

  async send(alert) {
    if (this.recipients.length === 0) {
      throw new Error('No email recipients configured');
    }

    const subject = `[Cost Alert] ${alert.severity.toUpperCase()}: ${alert.type}`;
    const body = this.formatEmailBody(alert);

    // 这里调用现有的邮件服务
    // 实际部署时需要集成邮件发送服务
    console.log(`[CostAlert] Email would be sent to ${this.recipients.join(', ')}`);
    console.log(`Subject: ${subject}`);
    console.log(body);

    return { sent: true, recipients: this.recipients };
  }

  formatEmailBody(alert) {
    return `
Cost anomaly detected:

Severity: ${alert.severity.toUpperCase()}
Type: ${alert.type}
Current Cost: $${(alert.currentCost || 0).toFixed(2)}
Expected Range: ${alert.expectedRange 
  ? `$${alert.expectedRange.min.toFixed(2)} - $${alert.expectedRange.max.toFixed(2)}`
  : 'N/A'}
Z-Score: ${(alert.zScore || 0).toFixed(2)}
Trend: ${alert.trendDirection || 'stable'}

Timestamp: ${new Date().toISOString()}

---
mineGo Cost Alerting System
    `.trim();
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
    if (!this.url) {
      throw new Error('Webhook URL not configured');
    }

    const response = await fetch(this.url, {
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

    if (!response.ok) {
      throw new Error(`Webhook error: ${response.status}`);
    }
  }
}

/**
 * PagerDuty 告警渠道
 */
class PagerDutyChannel {
  constructor(config) {
    this.serviceKey = config?.serviceKey;
    this.api_url = 'https://events.pagerduty.com/v2/enqueue';
  }

  async send(alert) {
    if (!this.serviceKey) {
      throw new Error('PagerDuty service key not configured');
    }

    // 仅对 critical 级别告警发送到 PagerDuty
    if (alert.severity !== 'critical') {
      return { skipped: true, reason: 'Not critical severity' };
    }

    const payload = {
      routing_key: this.serviceKey,
      event_action: 'trigger',
      dedup_key: `cost-alert-${Date.now()}`,
      payload: {
        summary: `Critical Cost Alert: ${alert.type} - $${(alert.currentCost || 0).toFixed(2)}`,
        severity: 'critical',
        source: 'mineGo-cost-monitor',
        custom_details: alert
      }
    };

    const response = await fetch(this.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`PagerDuty API error: ${response.status}`);
    }
  }
}

module.exports = { 
  CostAlertChannel, 
  SlackChannel, 
  EmailChannel, 
  WebhookChannel, 
  PagerDutyChannel 
};
