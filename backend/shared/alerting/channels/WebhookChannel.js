'use strict';
/**
 * Webhook Channel - Sends alerts to configured webhook URL
 * REQ-00439: 熔断器事件告警系统集成
 */

const { createLogger } = require('../../logger');
const logger = createLogger('alert-webhook-channel');

/**
 * Webhook Alert Channel
 * POSTs alerts to a webhook URL (supports OpsGenie, PagerDuty, etc.)
 */
class WebhookChannel {
  constructor(url, options = {}) {
    this.name = 'webhook';
    this.url = url;
    this.enabled = true;
    this.timeout = options.timeout || 5000;
    this.headers = options.headers || {
      'Content-Type': 'application/json'
    };
    
    // Optional authentication
    if (options.apiKey) {
      this.headers['Authorization'] = `Bearer ${options.apiKey}`;
    }
  }

  /**
   * Send alert to webhook
   * @param {Object} alert - Alert object
   */
  async send(alert) {
    if (!this.url) {
      logger.warn('Webhook URL not configured, alert not sent');
      return false;
    }

    const payload = this._formatPayload(alert);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        timeout: this.timeout
      });

      if (!response.ok) {
        logger.error({
          status: response.status,
          statusText: response.statusText,
          alert: alert.message
        }, 'Webhook alert failed');
        return false;
      }

      logger.info({
        url: this.url,
        level: alert.level,
        event: alert.event
      }, 'Webhook alert sent successfully');

      return true;
    } catch (error) {
      logger.error({
        error: error.message,
        url: this.url
      }, 'Webhook alert failed');
      
      return false;
    }
  }

  /**
   * Format alert payload for webhook
   * @param {Object} alert - Alert object
   * @returns {Object}
   */
  _formatPayload(alert) {
    return {
      alert_type: this._getAlertType(alert.level),
      event: alert.event,
      message: alert.message,
      severity: this._getSeverity(alert.level),
      service: alert.services ? alert.services[0] : alert.service,
      services: alert.services,
      count: alert.count,
      timestamp: alert.timestamp,
      details: alert.details,
      source: 'mineGo-circuit-breaker',
      metadata: {
        environment: process.env.NODE_ENV || 'development',
        version: process.env.APP_VERSION || 'unknown'
      }
    };
  }

  /**
   * Get OpsGenie/PagerDuty compatible alert type
   * @param {string} level - Alert level
   * @returns {string}
   */
  _getAlertType(level) {
    switch (level) {
      case 'critical':
        return 'critical';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'info';
    }
  }

  /**
   * Get severity string
   * @param {string} level - Alert level
   * @returns {string}
   */
  _getSeverity(level) {
    switch (level) {
      case 'critical':
        return 'P1';
      case 'warning':
        return 'P2';
      case 'info':
        return 'P3';
      default:
        return 'P3';
    }
  }

  /**
   * Check if channel is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled && this.url !== null;
  }

  /**
   * Enable channel
   */
  enable() {
    this.enabled = true;
    logger.info('Webhook channel enabled');
  }

  /**
   * Disable channel
   */
  disable() {
    this.enabled = false;
    logger.info('Webhook channel disabled');
  }

  /**
   * Update webhook URL
   * @param {string} url - New URL
   */
  setUrl(url) {
    this.url = url;
    logger.info({ url }, 'Webhook URL updated');
  }
}

module.exports = WebhookChannel;