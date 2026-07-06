'use strict';
/**
 * Alert Aggregator - Aggregates alerts within a time window
 * REQ-00439: 熔断器事件告警系统集成
 */

const { createLogger } = require('../logger');
const logger = createLogger('alert-aggregator');

/**
 * Alert Aggregator
 * Batches alerts of the same type/level within a configurable window
 */
class AlertAggregator {
  constructor(windowMs = 30000) {
    this.windowMs = windowMs;
    this.buffer = new Map();
    this.flushInterval = null;
  }

  /**
   * Add alert to buffer
   * @param {Object} alert - Alert to add
   */
  add(alert) {
    const key = `${alert.level}:${alert.event}`;
    
    if (!this.buffer.has(key)) {
      this.buffer.set(key, {
        level: alert.level,
        event: alert.event,
        alerts: [],
        firstTimestamp: Date.now()
      });
    }

    const bucket = this.buffer.get(key);
    bucket.alerts.push({
      ...alert,
      timestamp: Date.now()
    });

    logger.debug({
      key,
      count: bucket.alerts.length
    }, 'Alert added to aggregator');
  }

  /**
   * Flush all alerts from buffer
   * @returns {Array} - Aggregated alerts
   */
  flush() {
    const alerts = [];
    
    for (const [key, bucket] of this.buffer) {
      // Only flush if window has passed
      if (Date.now() - bucket.firstTimestamp >= this.windowMs || 
          bucket.alerts.length >= 5) { // Also flush if we have 5+ alerts
        alerts.push(...bucket.alerts);
        this.buffer.delete(key);
      }
    }

    if (alerts.length > 0) {
      logger.info({ count: alerts.length }, 'Alerts flushed from aggregator');
    }

    return alerts;
  }

  /**
   * Force flush all alerts regardless of window
   * @returns {Array}
   */
  forceFlush() {
    const alerts = [];
    
    for (const [key, bucket] of this.buffer) {
      alerts.push(...bucket.alerts);
    }

    this.buffer.clear();

    if (alerts.length > 0) {
      logger.info({ count: alerts.length }, 'All alerts force flushed');
    }

    return alerts;
  }

  /**
   * Get current buffer size
   * @returns {number}
   */
  size() {
    let total = 0;
    for (const bucket of this.buffer.values()) {
      total += bucket.alerts.length;
    }
    return total;
  }

  /**
   * Clear buffer
   */
  clear() {
    this.buffer.clear();
    logger.debug('Aggregator buffer cleared');
  }
}

module.exports = AlertAggregator;
