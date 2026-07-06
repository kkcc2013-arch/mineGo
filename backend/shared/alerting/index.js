'use strict';
/**
 * Alerting System for Circuit Breaker Events
 * REQ-00439: 熔断器事件告警系统集成
 */

const { createLogger } = require('../logger');
const AlertAggregator = require('./AlertAggregator');
const WebhookChannel = require('./channels/WebhookChannel');
const LogChannel = require('./channels/LogChannel');
const SlackChannel = require('./channels/SlackChannel');

const logger = createLogger('alerting');

/**
 * Alert Levels
 */
const AlertLevel = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info'
};

/**
 * Alert Manager
 */
class AlertManager {
  constructor(config = {}) {
    this.channels = [];
    this.rules = new Map();
    this.silences = new Map();
    this.aggregator = new AlertAggregator(config.aggregationWindowMs || 30000);
    this.history = [];
    this.maxHistorySize = config.maxHistorySize || 1000;
    
    this._initializeDefaultRules();
    
    // Periodically flush aggregated alerts
    setInterval(() => this._flushAggregatedAlerts(), this.aggregator.windowMs);
  }

  /**
   * Initialize default alert rules
   */
  _initializeDefaultRules() {
    this.rules.set('circuit-breaker-open', {
      level: AlertLevel.CRITICAL,
      channels: ['webhook', 'slack', 'log'],
      template: '熔断器打开: {service} 服务不可用'
    });

    this.rules.set('circuit-breaker-half-open', {
      level: AlertLevel.WARNING,
      channels: ['webhook', 'log'],
      template: '熔断器半开: {service} 恢复测试中'
    });

    this.rules.set('circuit-breaker-close', {
      level: AlertLevel.INFO,
      channels: ['log'],
      template: '熔断器关闭: {service} 已恢复'
    });
  }

  /**
   * Add alert channel
   * @param {AlertChannel} channel - Alert channel instance
   */
  addChannel(channel) {
    this.channels.push(channel);
    logger.info({ channelName: channel.name }, 'Alert channel added');
  }

  /**
   * Set alert rule
   * @param {string} name - Rule name
   * @param {Object} rule - Rule configuration
   */
  setRule(name, rule) {
    this.rules.set(name, rule);
    logger.info({ ruleName: name }, 'Alert rule set');
  }

  /**
   * Set silence pattern
   * @param {string} pattern - Pattern to match (service name or regex)
   * @param {number} durationMs - Silence duration in milliseconds
   */
  setSilence(pattern, durationMs) {
    this.silences.set(pattern, {
      startTime: Date.now(),
      durationMs,
      pattern
    });
    logger.info({ pattern, durationMs }, 'Silence rule set');
  }

  /**
   * Remove silence
   * @param {string} pattern - Silence pattern to remove
   */
  removeSilence(pattern) {
    this.silences.delete(pattern);
    logger.info({ pattern }, 'Silence rule removed');
  }

  /**
   * Check if alert should be silenced
   * @param {Object} alert - Alert object
   * @returns {boolean}
   */
  _isSilenced(alert) {
    const now = Date.now();
    
    for (const [pattern, silence] of this.silences) {
      // Check if silence is still active
      if (now - silence.startTime > silence.durationMs) {
        this.silences.delete(pattern);
        continue;
      }

      // Match service name
      if (alert.service && alert.service.match(pattern)) {
        logger.debug({ service: alert.service, pattern }, 'Alert silenced');
        return true;
      }
    }

    return false;
  }

  /**
   * Send alert
   * @param {Object} alert - Alert object
   * @param {string} alert.level - Alert level (critical/warning/info)
   * @param {string} alert.service - Service name
   * @param {string} alert.event - Event name
   * @param {string} alert.message - Alert message
   * @param {Object} alert.data - Additional data
   */
  async send(alert) {
    // Validate alert
    if (!alert.event || !alert.service) {
      logger.error({ alert }, 'Invalid alert: missing required fields');
      return false;
    }

    // Check silence
    if (this._isSilenced(alert)) {
      return true; // Silenced, but not an error
    }

    // Add to aggregator
    this.aggregator.add(alert);

    logger.info({
      level: alert.level,
      service: alert.service,
      event: alert.event
    }, 'Alert queued for aggregation');

    return true;
  }

  /**
   * Flush aggregated alerts
   */
  async _flushAggregatedAlerts() {
    const alerts = this.aggregator.flush();
    
    if (alerts.length === 0) {
      return;
    }

    logger.info({ count: alerts.length }, 'Flushing aggregated alerts');

    // Group by level
    const grouped = this._groupAlerts(alerts);

    // Send each group
    for (const [level, levelAlerts] of Object.entries(grouped)) {
      await this._sendGroupedAlerts(level, levelAlerts);
    }
  }

  /**
   * Group alerts by level
   * @param {Array} alerts - Alerts to group
   * @returns {Object}
   */
  _groupAlerts(alerts) {
    return alerts.reduce((acc, alert) => {
      const level = alert.level || AlertLevel.INFO;
      if (!acc[level]) {
        acc[level] = [];
      }
      acc[level].push(alert);
      return acc;
    }, {});
  }

  /**
   * Send grouped alerts
   * @param {string} level - Alert level
   * @param {Array} alerts - Alerts to send
   */
  async _sendGroupedAlerts(level, alerts) {
    const rule = this.rules.get(alerts[0].event);
    
    if (!rule) {
      logger.warn({ event: alerts[0].event }, 'No rule found for event');
      return;
    }

    // Create aggregated message
    const services = [...new Set(alerts.map(a => a.service))];
    const message = alerts.length === 1
      ? alerts[0].message
      : `${alerts.length} 个服务告警: ${services.join(', ')}`;

    const aggregatedAlert = {
      level,
      event: alerts[0].event,
      message,
      services,
      count: alerts.length,
      timestamp: new Date().toISOString(),
      details: alerts
    };

    // Store in history
    this._addToHistory(aggregatedAlert);

    // Send to enabled channels
    const channelNames = rule.channels || ['log'];
    
    for (const channel of this.channels) {
      if (channelNames.includes(channel.name) && channel.isEnabled()) {
        try {
          await channel.send(aggregatedAlert);
          logger.debug({ channel: channel.name }, 'Alert sent to channel');
        } catch (error) {
          logger.error({ 
            channel: channel.name, 
            error: error.message 
          }, 'Failed to send alert to channel');
        }
      }
    }
  }

  /**
   * Add alert to history
   * @param {Object} alert - Alert to add
   */
  _addToHistory(alert) {
    this.history.push(alert);
    
    // Keep history bounded
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * Get alert history
   * @param {Object} options - Query options
   * @returns {Array}
   */
  getHistory(options = {}) {
    let result = [...this.history];

    // Filter by level
    if (options.level) {
      result = result.filter(a => a.level === options.level);
    }

    // Filter by service
    if (options.service) {
      result = result.filter(a => a.services && a.services.includes(options.service));
    }

    // Limit results
    if (options.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /**
   * Get active silences
   * @returns {Array}
   */
  getSilences() {
    const now = Date.now();
    const active = [];

    for (const [pattern, silence] of this.silences) {
      const remaining = silence.durationMs - (now - silence.startTime);
      
      if (remaining > 0) {
        active.push({
          pattern,
          remainingMs: remaining,
          startTime: new Date(silence.startTime).toISOString()
        });
      } else {
        this.silences.delete(pattern);
      }
    }

    return active;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create AlertManager instance
 * @param {Object} config - Configuration
 * @returns {AlertManager}
 */
function getAlertManager(config = {}) {
  if (!instance) {
    instance = new AlertManager(config);
  }
  return instance;
}

/**
 * Initialize AlertManager with config
 * @param {Object} config - Configuration
 * @returns {AlertManager}
 */
function initializeAlertManager(config = {}) {
  const manager = new AlertManager(config);

  // Add default log channel
  manager.addChannel(new LogChannel());

  // Add webhook channel if configured
  if (config.webhookUrl) {
    manager.addChannel(new WebhookChannel(config.webhookUrl));
  }

  // Add Slack channel if configured
  if (config.slackWebhookUrl) {
    manager.addChannel(new SlackChannel(config.slackWebhookUrl));
  }

  instance = manager;
  return manager;
}

module.exports = {
  AlertManager,
  AlertLevel,
  getAlertManager,
  initializeAlertManager
};
