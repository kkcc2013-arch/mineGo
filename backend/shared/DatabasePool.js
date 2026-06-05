// shared/DatabasePool.js - Database Connection Pool Manager
'use strict';

const { Pool } = require('pg');
const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('database-pool');

// ============================================================
// Prometheus Metrics
// ============================================================

const register = new promClient.Registry();

const metrics = {
  poolTotal: new promClient.Gauge({
    name: 'minego_db_pool_connections_total',
    help: 'Total database connections in pool',
    labelNames: ['pool_name', 'service'],
    registers: [register],
  }),

  poolIdle: new promClient.Gauge({
    name: 'minego_db_pool_connections_idle',
    help: 'Idle database connections in pool',
    labelNames: ['pool_name', 'service'],
    registers: [register],
  }),

  poolWaiting: new promClient.Gauge({
    name: 'minego_db_pool_connections_waiting',
    help: 'Waiting database connections in pool',
    labelNames: ['pool_name', 'service'],
    registers: [register],
  }),

  poolUsage: new promClient.Gauge({
    name: 'minego_db_pool_usage_percent',
    help: 'Database pool usage percentage',
    labelNames: ['pool_name', 'service'],
    registers: [register],
  }),

  poolMaxSize: new promClient.Gauge({
    name: 'minego_db_pool_max_size',
    help: 'Maximum pool size',
    labelNames: ['pool_name', 'service'],
    registers: [register],
  }),

  queryDuration: new promClient.Histogram({
    name: 'minego_db_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['pool_name', 'operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register],
  }),

  connectionAcquireDuration: new promClient.Histogram({
    name: 'minego_db_connection_acquire_seconds',
    help: 'Time to acquire a connection from pool',
    labelNames: ['pool_name'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
    registers: [register],
  }),

  poolScaleEvent: new promClient.Counter({
    name: 'minego_db_pool_scale_total',
    help: 'Pool scaling events',
    labelNames: ['pool_name', 'direction'], // 'up' or 'down'
    registers: [register],
  }),

  poolError: new promClient.Counter({
    name: 'minego_db_pool_error_total',
    help: 'Pool errors',
    labelNames: ['pool_name', 'error_type'],
    registers: [register],
  }),
};

// ============================================================
// Configuration
// ============================================================

// Service-specific pool configurations
const SERVICE_POOL_CONFIG = {
  // Core services - higher priority
  'user-service': { max: 12, min: 3, priority: 'high' },
  'catch-service': { max: 12, min: 3, priority: 'high' },
  'payment-service': { max: 10, min: 3, priority: 'high' },
  'gateway': { max: 8, min: 2, priority: 'high' },

  // Standard services
  'location-service': { max: 8, min: 2, priority: 'medium' },
  'pokemon-service': { max: 8, min: 2, priority: 'medium' },
  'gym-service': { max: 8, min: 2, priority: 'medium' },

  // Non-core services
  'reward-service': { max: 6, min: 1, priority: 'low' },
  'social-service': { max: 6, min: 1, priority: 'low' },

  // Default configuration
  'default': { max: 10, min: 2, priority: 'medium' },
};

// Pool manager configuration
const POOL_MANAGER_CONFIG = {
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
  
  // Dynamic scaling
  enableDynamicSizing: process.env.DB_POOL_DYNAMIC_SIZING === 'true',
  scaleUpThreshold: 0.80,   // Scale up when usage > 80%
  scaleDownThreshold: 0.30, // Scale down when usage < 30%
  scaleInterval: 60000,     // Check every minute
  scaleUpStep: 2,           // Add 2 connections when scaling up
  scaleDownStep: 1,         // Remove 1 connection when scaling down
  maxPoolLimit: 20,         // Maximum connections per pool
  minPoolLimit: 2,          // Minimum connections per pool
  
  // Metrics update interval
  metricsInterval: 5000,    // Update metrics every 5 seconds
};

// ============================================================
// DatabasePoolManager Class
// ============================================================

class DatabasePoolManager {
  constructor() {
    this.pools = new Map();
    this.config = POOL_MANAGER_CONFIG;
    this.serviceConfigs = SERVICE_POOL_CONFIG;
    this.metricsInterval = null;
    this.scaleInterval = null;
  }

  /**
   * Get or create a database connection pool
   * @param {string} serviceName - Name of the service
   * @param {object} options - Pool options
   * @returns {Pool} PostgreSQL connection pool
   */
  getPool(serviceName = 'default', options = {}) {
    const poolName = this.getPoolName(serviceName);
    
    if (!this.pools.has(poolName)) {
      this.createPool(serviceName, options);
    }
    
    return this.pools.get(poolName).pool;
  }

  /**
   * Create a new connection pool
   */
  createPool(serviceName, options = {}) {
    const poolName = this.getPoolName(serviceName);
    
    // Get service-specific config
    const serviceConfig = this.serviceConfigs[serviceName] || this.serviceConfigs['default'];
    
    // Merge configurations
    const poolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: options.max || serviceConfig.max,
      min: options.min || serviceConfig.min,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };

    // Create pool
    const pool = new Pool(poolConfig);

    // Track pool state
    const poolState = {
      pool,
      serviceName,
      poolName,
      config: poolConfig,
      stats: {
        total: 0,
        idle: 0,
        waiting: 0,
        acquired: 0,
        errors: 0,
      },
    };

    // Event listeners
    pool.on('connect', () => {
      poolState.stats.total++;
      logger.debug({ poolName }, 'Connection created');
    });

    pool.on('acquire', () => {
      poolState.stats.acquired++;
    });

    pool.on('release', () => {
      // Connection returned to pool
    });

    pool.on('remove', () => {
      poolState.stats.total--;
      logger.debug({ poolName }, 'Connection removed');
    });

    pool.on('error', (err) => {
      poolState.stats.errors++;
      metrics.poolError.inc({ pool_name: poolName, error_type: 'pool_error' });
      logger.error({ poolName, err }, 'Pool error');
    });

    this.pools.set(poolName, poolState);
    
    logger.info({
      poolName,
      serviceName,
      max: poolConfig.max,
      min: poolConfig.min,
    }, 'Database pool created');

    // Start metrics collection if this is the first pool
    if (this.pools.size === 1) {
      this.startMetricsCollection();
      
      if (this.config.enableDynamicSizing) {
        this.startDynamicScaling();
      }
    }

    return pool;
  }

  /**
   * Get pool name from service name
   */
  getPoolName(serviceName) {
    // For shared pools, use service name as pool identifier
    return `pool-${serviceName}`;
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const stats = {};
    
    for (const [poolName, state] of this.pools) {
      const pool = state.pool;
      const usage = pool.totalCount > 0 
        ? ((pool.totalCount - pool.idleCount) / pool.options.max * 100).toFixed(2)
        : 0;

      stats[poolName] = {
        serviceName: state.serviceName,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: pool.options.max,
        usage: parseFloat(usage),
        acquired: state.stats.acquired,
        errors: state.stats.errors,
      };
    }

    return stats;
  }

  /**
   * Get aggregate statistics across all pools
   */
  getAggregateStats() {
    const allStats = Object.values(this.getStats());
    
    return {
      totalPools: allStats.length,
      totalConnections: allStats.reduce((sum, s) => sum + s.total, 0),
      totalIdle: allStats.reduce((sum, s) => sum + s.idle, 0),
      totalWaiting: allStats.reduce((sum, s) => sum + s.waiting, 0),
      maxConnections: allStats.reduce((sum, s) => sum + s.max, 0),
      averageUsage: allStats.reduce((sum, s) => sum + s.usage, 0) / allStats.length,
      monthlyCostEstimate: allStats.reduce((sum, s) => sum + s.max, 0) * 2, // $2 per connection
    };
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    if (this.metricsInterval) return;

    this.metricsInterval = setInterval(() => {
      this.updateMetrics();
    }, this.config.metricsInterval);

    logger.info('Metrics collection started');
  }

  /**
   * Update Prometheus metrics
   */
  updateMetrics() {
    for (const [poolName, state] of this.pools) {
      const pool = state.pool;
      const usage = pool.totalCount > 0 
        ? (pool.totalCount - pool.idleCount) / pool.options.max
        : 0;

      metrics.poolTotal.set(
        { pool_name: poolName, service: state.serviceName },
        pool.totalCount
      );
      
      metrics.poolIdle.set(
        { pool_name: poolName, service: state.serviceName },
        pool.idleCount
      );
      
      metrics.poolWaiting.set(
        { pool_name: poolName, service: state.serviceName },
        pool.waitingCount
      );
      
      metrics.poolUsage.set(
        { pool_name: poolName, service: state.serviceName },
        usage * 100
      );
      
      metrics.poolMaxSize.set(
        { pool_name: poolName, service: state.serviceName },
        pool.options.max
      );
    }
  }

  /**
   * Start dynamic pool scaling
   */
  startDynamicScaling() {
    if (this.scaleInterval) return;

    this.scaleInterval = setInterval(async () => {
      await this.performScaling();
    }, this.config.scaleInterval);

    logger.info('Dynamic scaling enabled');
  }

  /**
   * Perform pool scaling based on usage
   */
  async performScaling() {
    for (const [poolName, state] of this.pools) {
      const pool = state.pool;
      const usage = pool.totalCount > 0 
        ? (pool.totalCount - pool.idleCount) / pool.options.max
        : 0;

      const currentMax = pool.options.max;

      // Scale up
      if (usage > this.config.scaleUpThreshold && currentMax < this.config.maxPoolLimit) {
        const newSize = Math.min(
          currentMax + this.config.scaleUpStep,
          this.config.maxPoolLimit
        );
        
        pool.options.max = newSize;
        metrics.poolScaleEvent.inc({ pool_name: poolName, direction: 'up' });
        
        logger.info({
          poolName,
          oldSize: currentMax,
          newSize,
          usage: (usage * 100).toFixed(2) + '%',
        }, 'Pool scaled up');
      }

      // Scale down
      if (usage < this.config.scaleDownThreshold && currentMax > this.config.minPoolLimit) {
        const newSize = Math.max(
          currentMax - this.config.scaleDownStep,
          this.config.minPoolLimit
        );
        
        pool.options.max = newSize;
        metrics.poolScaleEvent.inc({ pool_name: poolName, direction: 'down' });
        
        logger.info({
          poolName,
          oldSize: currentMax,
          newSize,
          usage: (usage * 100).toFixed(2) + '%',
        }, 'Pool scaled down');
      }
    }
  }

  /**
   * Execute a query on a specific pool
   */
  async query(serviceName, text, params) {
    const pool = this.getPool(serviceName);
    const start = Date.now();
    const operation = text.trim().split(' ')[0].toUpperCase();
    const poolName = this.getPoolName(serviceName);

    try {
      const result = await pool.query(text, params);
      const duration = (Date.now() - start) / 1000;
      
      metrics.queryDuration.observe(
        { pool_name: poolName, operation },
        duration
      );

      if (duration > 0.5) {
        logger.warn({
          poolName,
          duration,
          query: text.substring(0, 100),
        }, 'Slow query detected');
      }

      return result;
    } catch (err) {
      metrics.poolError.inc({ pool_name: poolName, error_type: 'query_error' });
      throw err;
    }
  }

  /**
   * Execute a transaction on a specific pool
   */
  async transaction(serviceName, callback) {
    const pool = this.getPool(serviceName);
    const poolName = this.getPoolName(serviceName);
    const start = Date.now();

    const client = await pool.connect();
    
    metrics.connectionAcquireDuration.observe(
      { pool_name: poolName },
      (Date.now() - start) / 1000
    );

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      metrics.poolError.inc({ pool_name: poolName, error_type: 'transaction_error' });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get Prometheus metrics registry
   */
  getMetricsRegistry() {
    return register;
  }

  /**
   * Close all pools
   */
  async closeAll() {
    logger.info('Closing all database pools...');

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    if (this.scaleInterval) {
      clearInterval(this.scaleInterval);
    }

    const closePromises = [];
    
    for (const [poolName, state] of this.pools) {
      closePromises.push(
        state.pool.end().then(() => {
          logger.info({ poolName }, 'Pool closed');
        })
      );
    }

    await Promise.all(closePromises);
    this.pools.clear();
  }

  /**
   * Health check for all pools
   */
  async healthCheck() {
    const results = {};

    for (const [poolName, state] of this.pools) {
      try {
        const result = await state.pool.query('SELECT 1');
        results[poolName] = {
          healthy: true,
          stats: {
            total: state.pool.totalCount,
            idle: state.pool.idleCount,
            waiting: state.pool.waitingCount,
          },
        };
      } catch (err) {
        results[poolName] = {
          healthy: false,
          error: err.message,
        };
      }
    }

    return results;
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let instance = null;

function getPoolManager() {
  if (!instance) {
    instance = new DatabasePoolManager();
  }
  return instance;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  DatabasePoolManager,
  getPoolManager,
  metrics,
  SERVICE_POOL_CONFIG,
  POOL_MANAGER_CONFIG,
};
