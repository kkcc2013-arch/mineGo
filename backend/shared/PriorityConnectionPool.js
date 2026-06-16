// shared/PriorityConnectionPool.js - Priority-based Connection Pool with Adaptive Scheduling
'use strict';

const { Pool } = require('pg');
const promClient = require('prom-client');
const { createLogger } = require('./logger');

const logger = createLogger('priority-pool');

// ============================================================
// Priority Levels
// ============================================================

const PRIORITY_LEVELS = {
  CRITICAL: { level: 1, description: '支付、战斗', weight: 4 },
  HIGH: { level: 2, description: '捕捉、交易', weight: 3 },
  NORMAL: { level: 3, description: '常规查询', weight: 2 },
  LOW: { level: 4, description: '后台任务', weight: 1 }
};

// ============================================================
// Pool Configuration by Priority
// ============================================================

const PRIORITY_POOL_CONFIG = {
  CRITICAL: {
    minConnections: 3,
    maxConnections: 15,
    acquireTimeoutMs: 3000,
    idleTimeoutMs: 60000
  },
  HIGH: {
    minConnections: 5,
    maxConnections: 20,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 45000
  },
  NORMAL: {
    minConnections: 5,
    maxConnections: 25,
    acquireTimeoutMs: 8000,
    idleTimeoutMs: 30000
  },
  LOW: {
    minConnections: 2,
    maxConnections: 10,
    acquireTimeoutMs: 15000,
    idleTimeoutMs: 20000
  }
};

// ============================================================
// Adaptive Configuration
// ============================================================

const ADAPTIVE_CONFIG = {
  // Connection pool size ranges
  minConnectionsRange: { min: 2, max: 10 },
  maxConnectionsRange: { min: 15, max: 100 },
  
  // Scaling thresholds
  scaleUpThreshold: 0.80,    // Utilization > 80% triggers scale up
  scaleDownThreshold: 0.30,  // Utilization < 30% triggers scale down
  scaleCooldownMs: 60000,    // Cooldown between scaling operations
  
  // Borrowing thresholds
  borrowThreshold: 0.90,     // Allow borrowing when utilization > 90%
  
  // Queue settings
  maxQueueSize: 100,
  queueTimeoutMs: 30000
};

// ============================================================
// Prometheus Metrics
// ============================================================

const metrics = {
  poolConnectionsTotal: new promClient.Gauge({
    name: 'minego_priority_pool_connections_total',
    help: 'Total connections in priority pool',
    labelNames: ['service', 'priority', 'state'],
    registers: []
  }),

  poolUtilization: new promClient.Gauge({
    name: 'minego_priority_pool_utilization',
    help: 'Pool utilization percentage',
    labelNames: ['service', 'priority'],
    registers: []
  }),

  priorityQueueLength: new promClient.Gauge({
    name: 'minego_priority_queue_length',
    help: 'Priority queue length',
    labelNames: ['service', 'priority'],
    registers: []
  }),

  queryWaitTime: new promClient.Histogram({
    name: 'minego_priority_query_wait_seconds',
    help: 'Time queries wait in queue',
    labelNames: ['service', 'priority'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: []
  }),

  connectionBorrowed: new promClient.Counter({
    name: 'minego_priority_connection_borrowed_total',
    help: 'Connections borrowed from lower priority pools',
    labelNames: ['service', 'from_priority', 'to_priority'],
    registers: []
  }),

  poolScaleEvent: new promClient.Counter({
    name: 'minego_priority_pool_scale_total',
    help: 'Pool scale events',
    labelNames: ['service', 'priority', 'direction'],
    registers: []
  })
};

// ============================================================
// Priority Queue Implementation
// ============================================================

class PriorityQueue {
  constructor(maxSize = 100) {
    this.queues = {
      CRITICAL: [],
      HIGH: [],
      NORMAL: [],
      LOW: []
    };
    this.maxSize = maxSize;
  }

  enqueue(item) {
    const priority = item.priority || 'NORMAL';
    
    if (this.getTotalSize() >= this.maxSize) {
      throw new Error('Priority queue is full');
    }
    
    item.enqueuedAt = Date.now();
    this.queues[priority].push(item);
  }

  dequeue() {
    // Check priorities in order
    for (const priority of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      if (this.queues[priority].length > 0) {
        return this.queues[priority].shift();
      }
    }
    return null;
  }

  getQueueLength(priority) {
    return this.queues[priority]?.length || 0;
  }

  getTotalSize() {
    return Object.values(this.queues).reduce((sum, q) => sum + q.length, 0);
  }

  peek(priority) {
    return this.queues[priority]?.[0] || null;
  }
}

// ============================================================
// Priority Connection Pool Class
// ============================================================

class PriorityConnectionPool {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;
    this.config = { ...ADAPTIVE_CONFIG, ...config };
    
    // Create pools for each priority level
    this.pools = {};
    this.poolStates = {};
    
    for (const [priority, poolConfig] of Object.entries(PRIORITY_POOL_CONFIG)) {
      this.createPriorityPool(priority, poolConfig);
    }
    
    // Priority queue for waiting requests
    this.queue = new PriorityQueue(this.config.maxQueueSize);
    
    // Scaling state
    this.lastScaleTime = {};
    this.reservedConnections = { CRITICAL: 0, HIGH: 0, NORMAL: 0, LOW: 0 };
    
    // Start metrics collection
    this.metricsInterval = setInterval(() => this.updateMetrics(), 5000);
    
    logger.info({ serviceName }, 'Priority connection pool initialized');
  }

  /**
   * Create a pool for a specific priority level
   */
  createPriorityPool(priority, config) {
    const poolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: config.maxConnections,
      min: config.minConnections,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.acquireTimeoutMs,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    };

    const pool = new Pool(poolConfig);

    this.pools[priority] = pool;
    this.poolStates[priority] = {
      config: poolConfig,
      currentMax: config.maxConnections,
      currentMin: config.minConnections,
      totalAcquired: 0,
      totalErrors: 0
    };

    // Pool event handlers
    pool.on('error', (err) => {
      this.poolStates[priority].totalErrors++;
      logger.error({ serviceName: this.serviceName, priority, err }, 'Pool error');
    });

    logger.info({
      serviceName: this.serviceName,
      priority,
      max: config.maxConnections,
      min: config.minConnections
    }, 'Priority pool created');
  }

  /**
   * Acquire a connection with priority
   */
  async acquire(priority = 'NORMAL', queryFn) {
    const startTime = Date.now();
    
    // Validate priority
    if (!PRIORITY_LEVELS[priority]) {
      priority = 'NORMAL';
    }

    // Try to get connection from priority pool
    const pool = this.pools[priority];
    const poolState = this.poolStates[priority];
    
    // Check if pool has available connections
    if (pool.totalCount < poolState.currentMax || pool.idleCount > 0) {
      return await this.executeWithConnection(pool, queryFn, priority, startTime);
    }

    // High priority can borrow from lower priority pools
    if (PRIORITY_LEVELS[priority].level <= 2) { // CRITICAL or HIGH
      const borrowedPool = this.tryBorrowFromLower(priority);
      if (borrowedPool) {
        return await this.executeWithConnection(borrowedPool.pool, queryFn, priority, startTime, borrowedPool.level);
      }
    }

    // Add to queue and wait
    return await this.enqueueAndWait(priority, queryFn, startTime);
  }

  /**
   * Execute query with connection
   */
  async executeWithConnection(pool, queryFn, priority, startTime, borrowedFrom = null) {
    const client = await pool.connect();
    
    try {
      const result = await queryFn(client);
      
      // Record metrics
      const waitTime = (Date.now() - startTime) / 1000;
      metrics.queryWaitTime.observe(
        { service: this.serviceName, priority },
        waitTime
      );
      
      if (borrowedFrom) {
        metrics.connectionBorrowed.inc({
          service: this.serviceName,
          from_priority: borrowedFrom,
          to_priority: priority
        });
      }
      
      return result;
    } finally {
      client.release();
      
      // Process queue after releasing connection
      this.processQueue();
    }
  }

  /**
   * Try to borrow connection from lower priority pool
   */
  tryBorrowFromLower(priority) {
    const currentLevel = PRIORITY_LEVELS[priority].level;
    
    // Try lower priority levels
    for (const [level, config] of Object.entries(PRIORITY_LEVELS)) {
      if (config.level > currentLevel) {
        const pool = this.pools[level];
        const poolState = this.poolStates[level];
        const reserved = this.reservedConnections[level];
        
        // Check if pool has spare capacity
        const available = pool.idleCount - reserved;
        if (available > 0) {
          this.reservedConnections[level]++;
          
          logger.debug({
            serviceName: this.serviceName,
            from: level,
            to: priority
          }, 'Borrowing connection from lower priority');
          
          return { pool, level };
        }
      }
    }
    
    return null;
  }

  /**
   * Enqueue request and wait for connection
   */
  async enqueueAndWait(priority, queryFn, startTime) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection acquire timeout'));
      }, this.config.queueTimeoutMs);

      this.queue.enqueue({
        priority,
        queryFn,
        startTime,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      logger.debug({
        serviceName: this.serviceName,
        priority,
        queueSize: this.queue.getQueueLength(priority)
      }, 'Request queued');
    });
  }

  /**
   * Process waiting queue
   */
  processQueue() {
    while (this.queue.getTotalSize() > 0) {
      const item = this.queue.peek(item?.priority || 'NORMAL');
      if (!item) break;

      const pool = this.pools[item.priority];
      
      if (pool.idleCount > 0) {
        this.queue.dequeue();
        this.executeWithConnection(pool, item.queryFn, item.priority, item.startTime)
          .then(item.resolve)
          .catch(item.reject);
      } else {
        break;
      }
    }
  }

  /**
   * Adaptive scaling based on utilization
   */
  async performAdaptiveScaling() {
    const now = Date.now();

    for (const [priority, pool] of Object.entries(this.pools)) {
      // Check cooldown
      const lastScale = this.lastScaleTime[priority] || 0;
      if (now - lastScale < this.config.scaleCooldownMs) {
        continue;
      }

      const poolState = this.poolStates[priority];
      const utilization = this.calculateUtilization(pool, poolState);

      // Scale up
      if (utilization > this.config.scaleUpThreshold) {
        const newMax = Math.min(
          poolState.currentMax + 5,
          this.config.maxConnectionsRange.max
        );

        if (newMax > poolState.currentMax) {
          pool.options.max = newMax;
          poolState.currentMax = newMax;
          this.lastScaleTime[priority] = now;

          metrics.poolScaleEvent.inc({
            service: this.serviceName,
            priority,
            direction: 'up'
          });

          logger.info({
            serviceName: this.serviceName,
            priority,
            oldMax: poolState.currentMax,
            newMax: newMax,
            utilization: (utilization * 100).toFixed(2) + '%'
          }, 'Pool scaled up');
        }
      }

      // Scale down
      if (utilization < this.config.scaleDownThreshold) {
        const newMax = Math.max(
          poolState.currentMax - 2,
          this.config.maxConnectionsRange.min
        );

        if (newMax < poolState.currentMax) {
          pool.options.max = newMax;
          poolState.currentMax = newMax;
          this.lastScaleTime[priority] = now;

          metrics.poolScaleEvent.inc({
            service: this.serviceName,
            priority,
            direction: 'down'
          });

          logger.info({
            serviceName: this.serviceName,
            priority,
            oldMax: poolState.currentMax,
            newMax: newMax,
            utilization: (utilization * 100).toFixed(2) + '%'
          }, 'Pool scaled down');
        }
      }
    }
  }

  /**
   * Calculate pool utilization
   */
  calculateUtilization(pool, poolState) {
    if (poolState.currentMax === 0) return 0;
    return (pool.totalCount - pool.idleCount) / poolState.currentMax;
  }

  /**
   * Update Prometheus metrics
   */
  updateMetrics() {
    for (const [priority, pool] of Object.entries(this.pools)) {
      const poolState = this.poolStates[priority];
      const utilization = this.calculateUtilization(pool, poolState);

      metrics.poolConnectionsTotal.set(
        { service: this.serviceName, priority, state: 'total' },
        pool.totalCount
      );

      metrics.poolConnectionsTotal.set(
        { service: this.serviceName, priority, state: 'idle' },
        pool.idleCount
      );

      metrics.poolConnectionsTotal.set(
        { service: this.serviceName, priority, state: 'waiting' },
        pool.waitingCount
      );

      metrics.poolUtilization.set(
        { service: this.serviceName, priority },
        utilization * 100
      );

      metrics.priorityQueueLength.set(
        { service: this.serviceName, priority },
        this.queue.getQueueLength(priority)
      );
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const stats = {};

    for (const [priority, pool] of Object.entries(this.pools)) {
      const poolState = this.poolStates[priority];
      const utilization = this.calculateUtilization(pool, poolState);

      stats[priority] = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: poolState.currentMax,
        min: poolState.currentMin,
        utilization: (utilization * 100).toFixed(2) + '%',
        queueLength: this.queue.getQueueLength(priority),
        totalAcquired: poolState.totalAcquired,
        totalErrors: poolState.totalErrors
      };
    }

    return stats;
  }

  /**
   * Health check
   */
  async healthCheck() {
    const results = {};

    for (const [priority, pool] of Object.entries(this.pools)) {
      try {
        await pool.query('SELECT 1');
        results[priority] = {
          healthy: true,
          stats: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount
          }
        };
      } catch (err) {
        results[priority] = {
          healthy: false,
          error: err.message
        };
      }
    }

    return results;
  }

  /**
   * Close all pools
   */
  async close() {
    clearInterval(this.metricsInterval);

    const closePromises = Object.entries(this.pools).map(([priority, pool]) => 
      pool.end().then(() => {
        logger.info({ serviceName: this.serviceName, priority }, 'Pool closed');
      })
    );

    await Promise.all(closePromises);
    logger.info({ serviceName: this.serviceName }, 'All priority pools closed');
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  PriorityConnectionPool,
  PriorityQueue,
  PRIORITY_LEVELS,
  PRIORITY_POOL_CONFIG,
  ADAPTIVE_CONFIG,
  metrics
};
