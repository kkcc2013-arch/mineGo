// shared/ConnectionHealthChecker.js - Database Connection Health Monitoring
'use strict';

const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('connection-health');

// ============================================================
// Health Check Configuration
// ============================================================

const HEALTH_CONFIG = {
  // Check interval
  checkIntervalMs: 30000,        // Check every 30 seconds
  
  // Health criteria
  maxLatencyMs: 100,             // Max acceptable query latency
  maxErrorAgeMs: 60000,          // Consider connection unhealthy if error in last minute
  maxIdleTimeMs: 300000,         // Max idle time before considering stale
  
  // Recovery
  enableAutoRecovery: true,
  recoveryDelayMs: 5000,         // Wait before creating replacement connection
  minHealthyConnections: 2,      // Minimum healthy connections to maintain
  
  // Notification
  alertThreshold: 0.3,           // Alert if > 30% connections unhealthy
  alertCooldownMs: 300000        // 5 minute alert cooldown
};

// ============================================================
// Prometheus Metrics
// ============================================================

const metrics = {
  healthChecks: new promClient.Counter({
    name: 'minego_connection_health_checks_total',
    help: 'Connection health check count',
    labelNames: ['service', 'result'],
    registers: []
  }),

  unhealthyConnections: new promClient.Gauge({
    name: 'minego_connection_unhealthy_total',
    help: 'Unhealthy connections detected',
    labelNames: ['service', 'reason'],
    registers: []
  }),

  connectionLatency: new promClient.Histogram({
    name: 'minego_connection_health_latency_seconds',
    help: 'Connection health check latency',
    labelNames: ['service'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: []
  }),

  recoveryEvents: new promClient.Counter({
    name: 'minego_connection_recovery_events_total',
    help: 'Connection recovery events',
    labelNames: ['service', 'result'],
    registers: []
  }),

  healthScore: new promClient.Gauge({
    name: 'minego_connection_health_score',
    help: 'Overall connection health score (0-100)',
    labelNames: ['service'],
    registers: []
  })
};

// ============================================================
// Connection Health Checker Class
// ============================================================

class ConnectionHealthChecker {
  constructor(poolManager, config = {}) {
    this.poolManager = poolManager;
    this.config = { ...HEALTH_CONFIG, ...config };
    
    // Track unhealthy connections
    this.unhealthyConnections = new Map();
    this.connectionHealth = new Map();
    
    // State
    this.lastAlertTime = 0;
    this.healthStats = {
      totalChecks: 0,
      healthyChecks: 0,
      unhealthyChecks: 0,
      recoveredConnections: 0,
      removedConnections: 0
    };
    
    // Start health check loop
    this.checkInterval = setInterval(
      () => this.performHealthCheck(),
      this.config.checkIntervalMs
    );
    
    logger.info('Connection health checker initialized');
  }

  /**
   * Perform health check on all pools
   */
  async performHealthCheck() {
    const pools = this.poolManager.pools || new Map();
    const results = {};
    let totalHealthy = 0;
    let totalUnhealthy = 0;
    
    for (const [poolName, poolState] of pools) {
      const pool = poolState.pool || poolState;
      
      try {
        const poolResult = await this.checkPoolHealth(poolName, pool);
        results[poolName] = poolResult;
        
        totalHealthy += poolResult.healthy;
        totalUnhealthy += poolResult.unhealthy;
        
      } catch (err) {
        logger.error({ poolName, err }, 'Health check failed for pool');
        results[poolName] = { error: err.message };
      }
    }
    
    // Update health score
    const total = totalHealthy + totalUnhealthy;
    const healthScore = total > 0 ? (totalHealthy / total) * 100 : 100;
    
    metrics.healthScore.set({ service: 'database' }, healthScore);
    
    // Check if alert needed
    if (total > 0 && (totalUnhealthy / total) > this.config.alertThreshold) {
      this.sendAlert(totalHealthy, totalUnhealthy);
    }
    
    // Update stats
    this.healthStats.totalChecks++;
    this.healthStats.healthyChecks += totalHealthy;
    this.healthStats.unhealthyChecks += totalUnhealthy;
    
    return {
      healthScore,
      totalHealthy,
      totalUnhealthy,
      results
    };
  }

  /**
   * Check health of a single pool
   */
  async checkPoolHealth(poolName, pool) {
    const result = {
      healthy: 0,
      unhealthy: 0,
      details: [],
      removed: 0,
      recovered: 0
    };
    
    // Get pool clients (internal pg-pool structure)
    const clients = pool._clients || [];
    
    for (const client of clients) {
      const health = await this.checkClientHealth(poolName, client);
      
      if (health.healthy) {
        result.healthy++;
        this.connectionHealth.set(client, { healthy: true, lastCheck: Date.now() });
      } else {
        result.unhealthy++;
        result.details.push({
          reason: health.reason,
          latency: health.latency
        });
        
        // Track unhealthy connection
        this.unhealthyConnections.set(client, {
          reason: health.reason,
          timestamp: Date.now(),
          poolName
        });
        
        metrics.unhealthyConnections.inc({
          service: 'database',
          reason: health.reason
        });
        
        // Remove unhealthy connection if auto-recovery enabled
        if (this.config.enableAutoRecovery) {
          await this.removeAndReplaceConnection(pool, client, poolName);
          result.removed++;
        }
      }
    }
    
    // Also check pool-level health
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      const latency = Date.now() - start;
      
      metrics.connectionLatency.observe(
        { service: 'database' },
        latency / 1000
      );
      
      result.poolLatency = latency;
      
    } catch (err) {
      result.poolError = err.message;
      logger.error({ poolName, err }, 'Pool health check failed');
    }
    
    return result;
  }

  /**
   * Check health of a single client connection
   */
  async checkClientHealth(poolName, client) {
    const result = {
      healthy: true,
      reason: null,
      latency: 0
    };
    
    try {
      // Check if client is connected
      if (!client.connection || client.connection.stream?.destroyed) {
        return {
          healthy: false,
          reason: 'disconnected',
          latency: 0
        };
      }
      
      // Measure query latency
      const start = Date.now();
      
      // Use a simple query to check responsiveness
      await client.query('SELECT 1');
      
      result.latency = Date.now() - start;
      
      // Check latency threshold
      if (result.latency > this.config.maxLatencyMs) {
        return {
          healthy: false,
          reason: 'high_latency',
          latency: result.latency
        };
      }
      
      // Check for recent errors
      if (client.lastError) {
        const errorAge = Date.now() - client.lastError.timestamp;
        if (errorAge < this.config.maxErrorAgeMs) {
          return {
            healthy: false,
            reason: 'recent_error',
            latency: result.latency,
            error: client.lastError.message
          };
        }
      }
      
      // Check idle time
      if (client.lastQuery) {
        const idleTime = Date.now() - client.lastQuery;
        if (idleTime > this.config.maxIdleTimeMs) {
          // Stale but not necessarily unhealthy
          result.stale = true;
        }
      }
      
      metrics.healthChecks.inc({ service: 'database', result: 'healthy' });
      
      return result;
      
    } catch (err) {
      metrics.healthChecks.inc({ service: 'database', result: 'unhealthy' });
      
      return {
        healthy: false,
        reason: 'query_failed',
        error: err.message,
        latency: result.latency
      };
    }
  }

  /**
   * Remove unhealthy connection and create replacement
   */
  async removeAndReplaceConnection(pool, client, poolName) {
    try {
      // Remove from pool
      if (pool._removeClient) {
        pool._removeClient(client);
      }
      
      this.healthStats.removedConnections++;
      
      logger.warn({
        poolName,
        reason: this.unhealthyConnections.get(client)?.reason
      }, 'Removed unhealthy connection');
      
      // Wait before creating replacement
      await this.sleep(this.config.recoveryDelayMs);
      
      // Create new connection
      await pool.query('SELECT 1');
      
      this.healthStats.recoveredConnections++;
      
      metrics.recoveryEvents.inc({ service: 'database', result: 'success' });
      
      logger.info({ poolName }, 'Connection recovered');
      
    } catch (err) {
      metrics.recoveryEvents.inc({ service: 'database', result: 'failed' });
      
      logger.error({ poolName, err }, 'Failed to recover connection');
    }
    
    // Clean up tracking
    this.unhealthyConnections.delete(client);
    this.connectionHealth.delete(client);
  }

  /**
   * Send alert if too many unhealthy connections
   */
  sendAlert(healthy, unhealthy) {
    const now = Date.now();
    
    // Check cooldown
    if (now - this.lastAlertTime < this.config.alertCooldownMs) {
      return;
    }
    
    this.lastAlertTime = now;
    
    const total = healthy + unhealthy;
    const unhealthyPercent = ((unhealthy / total) * 100).toFixed(2);
    
    logger.warn({
      healthy,
      unhealthy,
      unhealthyPercent: unhealthyPercent + '%',
      threshold: (this.config.alertThreshold * 100) + '%'
    }, 'High unhealthy connection rate detected');
    
    // Emit event for external alerting
    this.emit('alert', {
      type: 'connection_health',
      severity: 'warning',
      healthy,
      unhealthy,
      unhealthyPercent
    });
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    const unhealthyByReason = {};
    
    for (const [, data] of this.unhealthyConnections) {
      const reason = data.reason;
      unhealthyByReason[reason] = (unhealthyByReason[reason] || 0) + 1;
    }
    
    return {
      stats: this.healthStats,
      unhealthyCount: this.unhealthyConnections.size,
      unhealthyByReason,
      lastAlert: this.lastAlertTime
    };
  }

  /**
   * Simple event emitter
   */
  on(event, handler) {
    if (!this.handlers) this.handlers = {};
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  emit(event, data) {
    if (!this.handlers?.[event]) return;
    for (const handler of this.handlers[event]) {
      handler(data);
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop health checker
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Connection health checker stopped');
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  ConnectionHealthChecker,
  HEALTH_CONFIG,
  metrics
};
