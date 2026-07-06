'use strict';
/**
 * Slack Channel - Sends alerts to Slack via webhook
 * REQ-00439: 熔断器事件告警系统集成
 */

const { createLogger } = require('../../logger');
const logger = createLogger('alert-slack-channel');

/**
 * Slack Alert Channel
 * Sends alerts to Slack using webhook URL
 */
class SlackChannel {
  constructor(webhookUrl, options = {}) {
    this.name = 'slack';
    this.webhookUrl = webhookUrl;
    this.enabled = true;
    this.channel = options.channel || '#ops-alerts';
    this.username = options.username || 'mineGo Alert';
    this.timeout = options.timeout || 5000;
  }

  /**
   * Send alert to Slack
   * @param {Object} alert - Alert object
   */
  async send(alert) {
    if (!this.webhookUrl) {
      logger.warn('Slack webhook URL not configured, alert not sent');
      return false;
    }

    const payload = this._formatSlackPayload(alert);

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: this.timeout
      });

      if (!response.ok) {
        logger.error({
          status: response.status,
          statusText: response.statusText,
          alert: alert.message
        }, 'Slack alert failed');
        return false;
      }

      logger.info({
        channel: this.channel,
        level: alert.level,
        event: alert.event
      }, 'Slack alert sent successfully');

      return true;
    } catch (error) {
      logger.error({
        error: error.message,
        webhookUrl: this.webhookUrl
      }, 'Slack alert failed');
      
      return false;
    }
  }

  /**
   * Format payload for Slack webhook
   * @param {Object} alert - Alert object
   * @returns {Object}
   */
  _formatSlackPayload(alert) {
    const color = this._getColor(alert.level);
    const emoji = this._getEmoji(alert.level);

    const attachment = {
      color,
      title: `${emoji} ${alert.event}`,
      text: alert.message,
      fields: [],
      ts: Math.floor(Date.now() / 1000)
    };

    // Add service field
    if (alert.services && alert.services.length > 0) {
      attachment.fields.push({
        title: '受影响服务',
        value: alert.services.join('\n'),
        short: false
      });
    }

    // Add count if aggregated
    if (alert.count && alert.count > 1) {
      attachment.fields.push({
        title: '告警数量',
        value: alert.count.toString(),
        short: true
      });
    }

    // Add environment
    attachment.fields.push({
      title: '环境',
      value: process.env.NODE_ENV || 'development',
      short: true
    });

    // Add details for each service
    if (alert.details && alert.details.length > 0) {
      const detailsText = alert.details
        .slice(0, 5) // Limit to 5 services
        .map(d => `• ${d.service}: ${d.data?.failures || 'N/A'} failures`)
        .join('\n');
      
      attachment.fields.push({
        title: '详细信息',
        value: detailsText,
        short: false
      });
    }

    return {
      channel: this.channel,
      username: this.username,
      attachments: [attachment]
    };
  }

  /**
   * Get color for Slack attachment based on level
   * @param {string} level - Alert level
   * @returns {string}
   */
  _getColor(level) {
    switch (level) {
      case 'critical':
        return '#FF0000'; // Red
      case 'warning':
        return '#FFA500'; // Orange
      case 'info':
        return '#36A64F'; // Green
      default:
        return '#808080'; // Gray
    }
  }

  /**
   * Get emoji for alert level
   * @param {string} level - Alert level
   * @returns {string}
   */
  _getEmoji(level) {
    switch (level) {
      case 'critical':
        return '🚨';
      case 'warning':
        return '⚠️';
      case 'info':
        return 'ℹ️';
      default:
        return '📢';
    }
  }

  /**
   * Check if channel is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled && this.webhookUrl !== null;
  }

  /**
   * Enable channel
   */
  enable() {
    this.enabled = true;
    logger.info('Slack channel enabled');
  }

  /**
   * Disable channel
   */
  disable() {
    this.enabled = false;
    logger.info('Slack channel disabled');
  }

  /**
   * Update webhook URL
   * @param {string} url - New webhook URL
   */
  setWebhookUrl(url) {
    this.webhookUrl = url;
    logger.info({ url }, 'Slack webhook URL updated');
  }
}

module.exports = SlackChannel;