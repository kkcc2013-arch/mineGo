// backend/shared/poolMetrics.js
// Enhanced Connection Pool Monitoring with Prometheus Metrics
'use strict';

const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('pool-metrics');

// ============================================================
// Prometheus Metrics
// ============================================================

const poolMetrics = {
  // Pool size metrics
  poolSize: new promClient.Gauge({
    name: 'db_pool_total_connections',
    help: 'Total connections in the pool',
    labelNames: ['service', 'database']
  }),
  
  idleConnections: new promClient.Gauge({
    name: 'db_pool_idle_connections',
    help: 'Number of idle connections',
    labelNames: ['service', 'database']
  }),
  
  waitingClients: new promClient.Gauge({
    name: 'db_pool_waiting_clients',
    help: 'Number of clients waiting for a connection',
    labelNames: ['service', 'database']
  }),
  
  utilizationRate: new promClient.Gauge({
    name: 'db_pool_utilization_rate',
    help: 'Connection pool utilization rate (0-1)',
    labelNames: ['service', 'database']
  }),
  
  // Wait time metrics
  avgWaitTime: new promClient.Histogram({
    name: 'db_pool_wait_time_seconds',
    help: 'Time spent waiting for a connection',
    labelNames: ['service', 'database'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
  }),
  
  // Connection lifecycle metrics
  connectionCreated: new promClient.Counter({
    name: 'db_pool_connections_created_total',
    help: 'Total number of connections created',
    labelNames: ['service', 'database']
  }),
  
  connectionDestroyed: new promClient.Counter({
    name: 'db_pool_connections_destroyed_total',
    help: 'Total number of connections destroyed',
    labelNames: ['service', 'database', 'reason']
  }),
  
  connectionLeaked: new promClient.Counter({
    name: 'db_pool_connections_leaked_total',
    help: 'Number of connections that may be leaked',
    labelNames: ['service', 'database']
  }),
  
  // Query performance metrics
  queryDuration: new promClient.Histogram({
    name: 'db_query_duration_detailed_seconds',
    help: 'Query execution time',
    labelNames: ['service', 'database', 'query_type'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  }),
  
  // Resource cost metrics
  connectionCost: new promClient.Gauge({
    name: 'db_pool_connection_cost_estimate',
    help: 'Estimated cost of connections in USD',
    labelNames: ['service', 'database']
  }),
  
  // Saturation indicator
  poolSaturation: new promClient.Gauge({
    name: 'db_pool_saturation_level',
    help: 'Pool saturation level (0=empty, 1=full, >1=overflow)',
    labelNames: ['service', 'database']
  })
};

// ============================================================
// PoolMonitor Class
// ============================================================

class PoolMonitor {
  constructor(pool, serviceName, database = 'default') {
    this.pool = pool;
    this.serviceName = serviceName;
    this.database = database;
    this.labels = { service: serviceName, database };
    
    // Connection tracking
    this.activeConnections = new Map();
    this.leakCheckInterval = null;
    this.metricsInterval = null;
    
    // Statistics
    this.stats = {
      totalQueries: 0,
      slowQueries: 0,
      leakedConnections: 0,
      avgUtilization: 0,
      utilizationHistory: []
    };
    
    this.setupMonitoring();
    this.startLeakDetection();
  }
  
  setupMonitoring() {
    // Collect metrics every second
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 1000);
    
    // Listen to pool events
    this.pool.on('connect', (client) => {
      poolMetrics.connectionCreated.inc(this.labels);
      this.trackConnection(client);
    });
    
    this.pool.on('acquire', (client) => {
      const info = this.activeConnections.get(client);
      if (info) {
        info.acquiredAt = Date.now();
        info.waitTime = Date.now() - info.requestedAt;
        poolMetrics.avgWaitTime.observe(this.labels, info.waitTime / 1000);
      }
    });
    
    this.pool.on('release', (client) => {
      const info = this.activeConnections.get(client);
      if (info) {
        info.releasedAt = Date.now();
        this.checkLeakedQuery(client, info);
      }
    });
    
    this.pool.on('remove', (client) => {
      poolMetrics.connectionDestroyed.inc({ ...this.labels, reason: 'normal' });
      this.activeConnections.delete(client);
    });
    
    this.pool.on('error', (err, client) => {
      poolMetrics.connectionDestroyed.inc({ ...this.labels, reason: 'error' });
      logger.error({ service: this.serviceName, error: err.message }, 'Pool error');
    });
  }
  
  collectMetrics() {
    const pool = this.pool;
    
    // Basic metrics
    const totalCount = pool.totalCount || 0;
    const idleCount = pool.idleCount || 0;
    const waitingCount = pool.waitingCount || 0;
    const maxSize = pool.options?.max || 0;
    
    poolMetrics.poolSize.set(this.labels, totalCount);
    poolMetrics.idleConnections.set(this.labels, idleCount);
    poolMetrics.waitingClients.set(this.labels, waitingCount);
    
    // Calculate utilization
    const utilization = totalCount > 0 ? (totalCount - idleCount) / totalCount : 0;
    poolMetrics.utilizationRate.set(this.labels, utilization);
    
    // Calculate saturation (active connections / max)
    const saturation = maxSize > 0 ? (totalCount - idleCount) / maxSize : 0;
    poolMetrics.poolSaturation.set(this.labels, saturation);
    
    // Estimate cost ($0.002 per connection per hour)
    const hourlyCost = totalCount * 0.002;
    poolMetrics.connectionCost.set(this.labels, hourlyCost);
    
    // Track utilization history
    this.stats.utilizationHistory.push(utilization);
    if (this.stats.utilizationHistory.length > 60) {
      this.stats.utilizationHistory.shift();
    }
    this.stats.avgUtilization = this.stats.utilizationHistory.reduce((a, b) => a + b, 0) 
      / this.stats.utilizationHistory.length;
    
    // Check saturation warning
    if (waitingCount > 0 && saturation > 0.9) {
      logger.warn('Connection pool near saturation', {
        service: this.serviceName,
        total: totalCount,
        idle: idleCount,
        waiting: waitingCount,
        utilization: (utilization * 100).toFixed(2) + '%',
        saturation: (saturation * 100).toFixed(2) + '%'
      });
    }
  }
  
  trackConnection(client) {
    this.activeConnections.set(client, {
      requestedAt: Date.now(),
      acquiredAt: null,
      releasedAt: null,
      queries: []
    });
  }
  
  trackQuery(client, queryText, startTime) {
    const info = this.activeConnections.get(client);
    if (info) {
      info.queries.push({
        text: queryText,
        startTime,
        endTime: null
      });
    }
  }
  
  endQuery(client, queryText, endTime) {
    const info = this.activeConnections.get(client);
    if (info && info.queries.length > 0) {
      const lastQuery = info.queries[info.queries.length - 1];
      if (lastQuery.text === queryText && lastQuery.endTime === null) {
        lastQuery.endTime = endTime;
      }
    }
  }
  
  checkLeakedQuery(client, info) {
    const pendingQueries = info.queries.filter(q => q.endTime === null);
    if (pendingQueries.length > 0) {
      poolMetrics.connectionLeaked.inc(this.labels);
      this.stats.leakedConnections++;
      logger.warn('Potential query leak detected', {
        service: this.serviceName,
        connectionAge: Date.now() - info.requestedAt,
        pendingQueries: pendingQueries.length
      });
    }
  }
  
  startLeakDetection() {
    // Check for long-held connections every 30 seconds
    this.leakCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [client, info] of this.activeConnections) {
        if (info.acquiredAt) {
          const age = now - info.acquiredAt;
          // Connection held > 30 seconds is suspicious
          if (age > 30000) {
            logger.warn('Long-held connection detected', {
              service: this.serviceName,
              connectionAge: age,
              queries: info.queries.length
            });
          }
        }
      }
    }, 30000);
  }
  
  // Query wrapper with tracking
  async query(client, queryText, params) {
    const startTime = Date.now();
    const queryType = this.getQueryType(queryText);
    
    this.trackQuery(client, queryText, startTime);
    
    try {
      const result = await client.query(queryText, params);
      const duration = (Date.now() - startTime) / 1000;
      
      poolMetrics.queryDuration.observe(
        { ...this.labels, query_type: queryType },
        duration
      );
      
      this.endQuery(client, queryText, Date.now());
      this.stats.totalQueries++;
      
      if (duration > 0.5) {
        this.stats.slowQueries++;
        logger.warn('Slow query detected', {
          service: this.serviceName,
          duration: (duration * 1000).toFixed(2) + 'ms',
          queryType,
          queryPreview: queryText.substring(0, 100)
        });
      }
      
      return result;
    } catch (error) {
      this.endQuery(client, queryText, Date.now());
      throw error;
    }
  }
  
  getQueryType(queryText) {
    const firstWord = queryText.trim().split(/\s+/)[0].toUpperCase();
    const typeMap = {
      'SELECT': 'select',
      'INSERT': 'insert',
      'UPDATE': 'update',
      'DELETE': 'delete',
      'BEGIN': 'transaction',
      'COMMIT': 'transaction',
      'ROLLBACK': 'transaction'
    };
    return typeMap[firstWord] || 'other';
  }
  
  getStats() {
    return {
      serviceName: this.serviceName,
      database: this.database,
      activeConnections: this.activeConnections.size,
      totalQueries: this.stats.totalQueries,
      slowQueries: this.stats.slowQueries,
      leakedConnections: this.stats.leakedConnections,
      avgUtilization: this.stats.avgUtilization
    };
  }
  
  destroy() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    if (this.leakCheckInterval) {
      clearInterval(this.leakCheckInterval);
    }
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = { PoolMonitor, poolMetrics };
