// backend/shared/PoolHealthChecker.js
// REQ-00559: Database Connection Pool Health Checker
'use strict';

const EventEmitter = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('pool-health-checker');

/**
 * PoolHealthChecker - Monitors connection pool health and auto-recovers
 * 
 * Features:
 * - Periodic health checks
 * - Connection leak detection
 * - Auto-recovery on failure
 * - Prometheus metrics export
 */
class PoolHealthChecker extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.serviceName = options.serviceName || 'unknown';
    
    // Configuration
    this.config = {
      checkIntervalMs: options.checkIntervalMs || 30000, // 30 seconds
      maxConnectionAge: options.maxConnectionAge || 300000, // 5 minutes
      maxLeakedConnections: options.maxLeakedConnections || 3,
      recoveryAttempts: options.recoveryAttempts || 3,
      recoveryDelayMs: options.recoveryDelayMs || 5000,
      ...options
    };
    
    // State
    this.isHealthy = true;
    this.checkInterval = null;
    this.leakedConnections = new Map(); // connectionId -> metadata
    this.healthHistory = [];
    this.recoveryAttempts = 0;
  }
  
  /**
   * Start health checking
   */
  start() {
    if (this.checkInterval) {
      logger.warn({
        service: this.serviceName
      }, 'Health checker already running');
      return;
    }
    
    this.checkInterval = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);
    
    logger.info({
      service: this.serviceName,
      interval: this.config.checkIntervalMs
    }, 'Pool health checker started');
    
    // Initial check
    this.check();
  }
  
  /**
   * Perform health check
   */
  async check() {
    const startTime = Date.now();
    
    try {
      // 1. Basic availability check
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      // 2. Check for connection leaks
      const leakCount = this._detectLeaks();
      
      // 3. Check pool metrics
      const metrics = this._collectMetrics();
      
      // 4. Determine health status
      const isHealthy = leakCount <= this.config.maxLeakedConnections;
      
      // Update state
      if (isHealthy !== this.isHealthy) {
        this.isHealthy = isHealthy;
        
        logger.info({
          service: this.serviceName,
          isHealthy,
          leakCount
        }, 'Pool health status changed');
        
        this.emit('health_changed', {
          isHealthy,
          leakCount,
          metrics
        });
      }
      
      const duration = Date.now() - startTime;
      
      // Record health check
      this.healthHistory.push({
        timestamp: new Date().toISOString(),
        healthy: isHealthy,
        duration,
        leakCount,
        ...metrics
      });
      
      // Keep last 100 records
      if (this.healthHistory.length > 100) {
        this.healthHistory.shift();
      }
      
      // Reset recovery attempts on successful check
      if (isHealthy) {
        this.recoveryAttempts = 0;
      }
      
      this._emitMetrics(isHealthy, leakCount, metrics);
      
      logger.debug({
        service: this.serviceName,
        healthy: isHealthy,
        leakCount,
        duration
      }, 'Health check completed');
      
      return {
        healthy: isHealthy,
        leakCount,
        duration,
        metrics
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        service: this.serviceName,
        error: error.message,
        duration
      }, 'Health check failed');
      
      this.isHealthy = false;
      
      this.healthHistory.push({
        timestamp: new Date().toISOString(),
        healthy: false,
        duration,
        error: error.message
      });
      
      this._emitMetrics(false, 0, {});
      
      // Attempt recovery
      await this._attemptRecovery(error);
      
      return {
        healthy: false,
        error: error.message,
        duration
      };
    }
  }
  
  /**
   * Detect connection leaks
   */
  _detectLeaks() {
    // In pg-pool, we can't directly access connection creation time
    // This is a simplified implementation
    const pool = this.pool;
    
    let leakCount = 0;
    
    // Check if pool has _clients property (internal)
    if (pool._clients && Array.isArray(pool._clients)) {
      for (const client of pool._clients) {
        // Check if connection has been held too long
        if (client._connectedAt) {
          const age = Date.now() - client._connectedAt;
          if (age > this.config.maxConnectionAge) {
            leakCount++;
            
            // Track leaked connection
            this.leakedConnections.set(client.processID || 'unknown', {
              connectedAt: new Date(client._connectedAt).toISOString(),
              age,
              lastChecked: new Date().toISOString()
            });
            
            logger.warn({
              service: this.serviceName,
              connectionId: client.processID,
              age
            }, 'Potential connection leak detected');
          }
        }
      }
    }
    
    return leakCount;
  }
  
  /**
   * Collect pool metrics
   */
  _collectMetrics() {
    const pool = this.pool;
    
    return {
      totalCount: pool.totalCount || 0,
      idleCount: pool.idleCount || 0,
      waitingCount: pool.waitingCount || 0,
      utilization: pool.totalCount > 0 
        ? (pool.totalCount - pool.idleCount) / pool.totalCount 
        : 0
    };
  }
  
  /**
   * Emit Prometheus metrics
   */
  _emitMetrics(isHealthy, leakCount, metrics) {
    // These will be collected by Prometheus scraper
    this.emit('metrics', {
      healthy: isHealthy ? 1 : 0,
      leak_count: leakCount,
      total_connections: metrics.totalCount || 0,
      idle_connections: metrics.idleCount || 0,
      waiting_connections: metrics.waitingCount || 0,
      utilization: metrics.utilization || 0
    });
  }
  
  /**
   * Attempt recovery
   */
  async _attemptRecovery(error) {
    if (this.recoveryAttempts >= this.config.recoveryAttempts) {
      logger.error({
        service: this.serviceName,
        attempts: this.recoveryAttempts,
        error: error.message
      }, 'Recovery attempts exhausted');
      
      this.emit('recovery_failed', {
        attempts: this.recoveryAttempts,
        error: error.message
      });
      
      return;
    }
    
    this.recoveryAttempts++;
    
    logger.info({
      service: this.serviceName,
      attempt: this.recoveryAttempts
    }, 'Attempting pool recovery');
    
    // Wait before recovery attempt
    await new Promise(resolve => setTimeout(resolve, this.config.recoveryDelayMs));
    
    try {
      // Try to create a new connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      logger.info({
        service: this.serviceName,
        attempt: this.recoveryAttempts
      }, 'Pool recovery successful');
      
      this.isHealthy = true;
      this.recoveryAttempts = 0;
      
      this.emit('recovered', {
        attempt: this.recoveryAttempts
      });
      
    } catch (recoveryError) {
      logger.error({
        service: this.serviceName,
        attempt: this.recoveryAttempts,
        error: recoveryError.message
      }, 'Recovery attempt failed');
      
      // Recursively attempt recovery
      await this._attemptRecovery(error);
    }
  }
  
  /**
   * Force health check (for admin API)
   */
  async forceCheck() {
    logger.info({
      service: this.serviceName
    }, 'Force health check triggered');
    
    return await this.check();
  }
  
  /**
   * Get health status
   */
  getStatus() {
    return {
      serviceName: this.serviceName,
      isHealthy: this.isHealthy,
      recoveryAttempts: this.recoveryAttempts,
      leakedConnections: Array.from(this.leakedConnections.entries()),
      recentHistory: this.healthHistory.slice(-10),
      metrics: this._collectMetrics()
    };
  }
  
  /**
   * Get health history
   */
  getHistory(limit = 20) {
    return this.healthHistory.slice(-limit);
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    logger.info({
      service: this.serviceName
    }, 'Pool health checker destroyed');
  }
}

module.exports = { PoolHealthChecker };