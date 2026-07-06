'use strict';
/**
 * Log Channel - Sends alerts to logging system
 * REQ-00439: 熔断器事件告警系统集成
 */

const { createLogger } = require('../../logger');
const logger = createLogger('alert-log-channel');

/**
 * Log Alert Channel
 * Writes alerts to log file
 */
class LogChannel {
  constructor() {
    this.name = 'log';
    this.enabled = true;
  }

  /**
   * Send alert to log
   * @param {Object} alert - Alert object
   */
  async send(alert) {
    const logMethod = this._getLogMethod(alert.level);

    logMethod({
      level: alert.level,
      event: alert.event,
      service: alert.services ? alert.services.join(',') : alert.service,
      message: alert.message,
      count: alert.count,
      timestamp: alert.timestamp,
      details: alert.details ? alert.details.map(d => ({
        service: d.service,
        data: d.data
      })) : undefined
    }, `[ALERT] ${alert.message}`);

    return true;
  }

  /**
   * Get log method based on level
   * @param {string} level - Alert level
   * @returns {Function}
   */
  _getLogMethod(level) {
    switch (level) {
      case 'critical':
        return logger.error;
      case 'warning':
        return logger.warn;
      case 'info':
        return logger.info;
      default:
        return logger.info;
    }
  }

  /**
   * Check if channel is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Enable channel
   */
  enable() {
    this.enabled = true;
    logger.info('Log channel enabled');
  }

  /**
   * Disable channel
   */
  disable() {
    this.enabled = false;
    logger.info('Log channel disabled');
  }
}

module.exports = LogChannel;