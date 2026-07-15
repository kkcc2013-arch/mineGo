// backend/shared/PoolPreheater.js
// REQ-00559: Database Connection Pool Intelligent Preheat and Adaptive Management
'use strict';

const EventEmitter = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('pool-preheater');

/**
 * PoolPreheater - Intelligent pool preheating system
 * 
 * Features:
 * - Startup preheating: Creates minimum connections before accepting traffic
 * - Time-based preheating: Pre-heats before peak hours
 * - Event-based preheating: Pre-heats for planned activities
 * - Warm query execution: Runs warmup queries to optimize query plans
 */
class PoolPreheater extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.serviceName = options.serviceName || 'unknown';
    
    // Configuration
    this.config = {
      minConnections: options.minConnections || 5,
      warmupQueries: options.warmupQueries || [
        'SELECT 1',
        'SELECT NOW()',
        'SELECT 1 FROM pg_database LIMIT 1'
      ],
      warmupTimeoutMs: options.warmupTimeoutMs || 10000,
      peakHours: options.peakHours || [
        { start: '08:00', end: '10:00', timezone: 'Asia/Shanghai' },
        { start: '18:00', end: '22:00', timezone: 'Asia/Shanghai' },
        { start: '12:00', end: '14:00', timezone: 'Asia/Shanghai' }
      ],
      preheatMinutes: options.preheatMinutes || 30,
      checkIntervalMs: options.checkIntervalMs || 60000, // 1 minute
      ...options
    };
    
    // State
    this.isPreheated = false;
    this.preheatHistory = [];
    this.scheduledPreheat = null;
    this.checkInterval = null;
  }
  
  /**
   * Startup preheating - call this when service starts
   */
  async preheatOnStartup() {
    const startTime = Date.now();
    
    logger.info({
      service: this.serviceName,
      minConnections: this.config.minConnections
    }, 'Starting pool preheating');
    
    try {
      // 1. Create minimum connections
      const connectionPromises = [];
      for (let i = 0; i < this.config.minConnections; i++) {
        connectionPromises.push(this._createAndWarmupConnection());
      }
      
      await Promise.all(connectionPromises);
      
      // 2. Execute warmup queries
      await this._executeWarmupQueries();
      
      // 3. Mark as preheated
      this.isPreheated = true;
      
      const duration = Date.now() - startTime;
      
      logger.info({
        service: this.serviceName,
        duration,
        connections: this.config.minConnections,
        poolSize: this.pool.totalCount
      }, 'Pool preheated successfully');
      
      // Record history
      this.preheatHistory.push({
        timestamp: new Date().toISOString(),
        type: 'startup',
        duration,
        connections: this.config.minConnections,
        success: true
      });
      
      this.emit('preheated', {
        type: 'startup',
        duration,
        connections: this.config.minConnections
      });
      
      // 4. Start time-based preheating scheduler
      this._startTimeBasedScheduler();
      
      return {
        success: true,
        duration,
        connections: this.config.minConnections
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        service: this.serviceName,
        error: error.message,
        duration
      }, 'Pool preheating failed');
      
      this.preheatHistory.push({
        timestamp: new Date().toISOString(),
        type: 'startup',
        duration,
        connections: this.config.minConnections,
        success: false,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Create and warmup a single connection
   */
  async _createAndWarmupConnection() {
    const client = await this.pool.connect();
    
    try {
      // Execute a simple query to warm up the connection
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  }
  
  /**
   * Execute warmup queries
   */
  async _executeWarmupQueries() {
    const promises = this.config.warmupQueries.map(query => {
      return this.pool.query(query).catch(err => {
        logger.warn({
          service: this.serviceName,
          query,
          error: err.message
        }, 'Warmup query failed (non-critical)');
      });
    });
    
    await Promise.all(promises);
  }
  
  /**
   * Time-based preheating scheduler
   */
  _startTimeBasedScheduler() {
    // Check every minute if we need to preheat
    this.checkInterval = setInterval(() => {
      this._checkAndSchedulePreheat();
    }, this.config.checkIntervalMs);
    
    // Initial check
    this._checkAndSchedulePreheat();
  }
  
  /**
   * Check if preheating is needed based on peak hours
   */
  _checkAndSchedulePreheat() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    for (const peak of this.config.peakHours) {
      const peakStart = this._parseTime(peak.start);
      const peakEnd = this._parseTime(peak.end);
      
      // Calculate preheat time (30 minutes before peak)
      const preheatTime = peakStart - this.config.preheatMinutes;
      
      // Check if we're approaching peak hours
      if (currentTime >= preheatTime && currentTime < peakStart) {
        if (!this.scheduledPreheat) {
          this._schedulePreheat(peak);
        }
      }
    }
  }
  
  /**
   * Parse time string (HH:MM) to minutes
   */
  _parseTime(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }
  
  /**
   * Schedule preheating for a peak hour
   */
  _schedulePreheat(peak) {
    this.scheduledPreheat = setTimeout(async () => {
      logger.info({
        service: this.serviceName,
        peak: peak.start
      }, 'Scheduled preheating for peak hours');
      
      try {
        await this.preheatForPeak(peak);
      } catch (error) {
        logger.error({
          service: this.serviceName,
          error: error.message
        }, 'Scheduled preheating failed');
      }
      
      this.scheduledPreheat = null;
    }, 1000); // Execute in 1 second
  }
  
  /**
   * Preheat for peak hours
   */
  async preheatForPeak(peak) {
    const startTime = Date.now();
    
    logger.info({
      service: this.serviceName,
      peak: peak.start
    }, 'Preheating for peak hours');
    
    try {
      // Increase connections for peak
      const peakConnections = Math.ceil(this.config.minConnections * 1.5);
      
      const connectionPromises = [];
      for (let i = 0; i < peakConnections; i++) {
        connectionPromises.push(this._createAndWarmupConnection());
      }
      
      await Promise.all(connectionPromises);
      
      // Execute warmup queries
      await this._executeWarmupQueries();
      
      const duration = Date.now() - startTime;
      
      logger.info({
        service: this.serviceName,
        peak: peak.start,
        duration,
        connections: peakConnections
      }, 'Peak preheating completed');
      
      this.preheatHistory.push({
        timestamp: new Date().toISOString(),
        type: 'peak',
        peak: peak.start,
        duration,
        connections: peakConnections,
        success: true
      });
      
      this.emit('preheated', {
        type: 'peak',
        peak: peak.start,
        duration,
        connections: peakConnections
      });
      
      return {
        success: true,
        duration,
        connections: peakConnections
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        service: this.serviceName,
        peak: peak.start,
        error: error.message,
        duration
      }, 'Peak preheating failed');
      
      throw error;
    }
  }
  
  /**
   * Manual preheat - for admin API
   */
  async manualPreheat(connections = this.config.minConnections) {
    const startTime = Date.now();
    
    logger.info({
      service: this.serviceName,
      connections
    }, 'Manual preheating triggered');
    
    try {
      const connectionPromises = [];
      for (let i = 0; i < connections; i++) {
        connectionPromises.push(this._createAndWarmupConnection());
      }
      
      await Promise.all(connectionPromises);
      await this._executeWarmupQueries();
      
      const duration = Date.now() - startTime;
      
      logger.info({
        service: this.serviceName,
        connections,
        duration
      }, 'Manual preheating completed');
      
      this.preheatHistory.push({
        timestamp: new Date().toISOString(),
        type: 'manual',
        duration,
        connections,
        success: true
      });
      
      return {
        success: true,
        duration,
        connections
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        service: this.serviceName,
        error: error.message,
        duration
      }, 'Manual preheating failed');
      
      throw error;
    }
  }
  
  /**
   * Preheat for event - for planned activities
   */
  async preheatForEvent(eventConfig) {
    const startTime = Date.now();
    
    const connections = eventConfig.connections || this.config.minConnections * 2;
    
    logger.info({
      service: this.serviceName,
      event: eventConfig.name,
      connections
    }, 'Event preheating triggered');
    
    try {
      const connectionPromises = [];
      for (let i = 0; i < connections; i++) {
        connectionPromises.push(this._createAndWarmupConnection());
      }
      
      await Promise.all(connectionPromises);
      await this._executeWarmupQueries();
      
      const duration = Date.now() - startTime;
      
      logger.info({
        service: this.serviceName,
        event: eventConfig.name,
        connections,
        duration
      }, 'Event preheating completed');
      
      this.preheatHistory.push({
        timestamp: new Date().toISOString(),
        type: 'event',
        event: eventConfig.name,
        duration,
        connections,
        success: true
      });
      
      this.emit('preheated', {
        type: 'event',
        event: eventConfig.name,
        duration,
        connections
      });
      
      return {
        success: true,
        duration,
        connections
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        service: this.serviceName,
        event: eventConfig.name,
        error: error.message,
        duration
      }, 'Event preheating failed');
      
      throw error;
    }
  }
  
  /**
   * Get preheat status
   */
  getStatus() {
    return {
      serviceName: this.serviceName,
      isPreheated: this.isPreheated,
      minConnections: this.config.minConnections,
      peakHours: this.config.peakHours,
      preheatMinutes: this.config.preheatMinutes,
      poolSize: this.pool.totalCount || 0,
      recentHistory: this.preheatHistory.slice(-10)
    };
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    
    if (this.scheduledPreheat) {
      clearTimeout(this.scheduledPreheat);
    }
    
    logger.info({
      service: this.serviceName
    }, 'Pool preheater destroyed');
  }
}

module.exports = { PoolPreheater };