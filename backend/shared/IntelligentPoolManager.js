// backend/shared/IntelligentPoolManager.js
// REQ-00559: Intelligent Pool Manager - Integrated System
'use strict';

const EventEmitter = require('events');
const { createLogger } = require('./logger');
const { PoolPreheater } = require('./PoolPreheater');
const { PoolHealthChecker } = require('./PoolHealthChecker');
const { AdaptivePoolManager } = require('./adaptivePoolManager');

const logger = createLogger('intelligent-pool-manager');

/**
 * IntelligentPoolManager - Unified pool management system
 * 
 * Integrates:
 * - PoolPreheater: Startup and time-based preheating
 * - PoolHealthChecker: Health monitoring and recovery
 * - AdaptivePoolManager: Auto-scaling based on load
 * 
 * Features:
 * - One-stop initialization
 * - Unified metrics export
 * - Admin API endpoints
 * - Graceful shutdown
 */
class IntelligentPoolManager extends EventEmitter {
  constructor(pool, serviceName, options = {}) {
    super();
    
    this.pool = pool;
    this.serviceName = serviceName;
    
    // Configuration
    this.config = {
      // Preheater
      minConnections: options.minConnections || 5,
      warmupQueries: options.warmupQueries || [],
      peakHours: options.peakHours || [
        { start: '08:00', end: '10:00' },
        { start: '18:00', end: '22:00' },
        { start: '12:00', end: '14:00' }
      ],
      preheatMinutes: options.preheatMinutes || 30,
      
      // Health Checker
      checkIntervalMs: options.checkIntervalMs || 30000,
      maxConnectionAge: options.maxConnectionAge || 300000,
      maxLeakedConnections: options.maxLeakedConnections || 3,
      
      // Adaptive Manager
      minPoolSize: options.minPoolSize || 5,
      maxPoolSize: options.maxPoolSize || 50,
      targetUtilization: options.targetUtilization || 0.7,
      scaleUpThreshold: options.scaleUpThreshold || 0.85,
      scaleDownThreshold: options.scaleDownThreshold || 0.3,
      
      ...options
    };
    
    // Subsystems
    this.preheater = null;
    this.healthChecker = null;
    this.adaptiveManager = null;
    
    // State
    this.initialized = false;
  }
  
  /**
   * Initialize all subsystems
   */
  async initialize() {
    if (this.initialized) {
      logger.warn({
        service: this.serviceName
      }, 'IntelligentPoolManager already initialized');
      return;
    }
    
    const startTime = Date.now();
    
    logger.info({
      service: this.serviceName,
      config: {
        minConnections: this.config.minConnections,
        minPoolSize: this.config.minPoolSize,
        maxPoolSize: this.config.maxPoolSize,
        peakHours: this.config.peakHours.length
      }
    }, 'Initializing IntelligentPoolManager');
    
    try {
      // 1. Initialize Preheater
      this.preheater = new PoolPreheater(this.pool, {
        serviceName: this.serviceName,
        minConnections: this.config.minConnections,
        warmupQueries: this.config.warmupQueries,
        peakHours: this.config.peakHours,
        preheatMinutes: this.config.preheatMinutes
      });
      
      // 2. Perform startup preheating
      await this.preheater.preheatOnStartup();
      
      // 3. Initialize Health Checker
      this.healthChecker = new PoolHealthChecker(this.pool, {
        serviceName: this.serviceName,
        checkIntervalMs: this.config.checkIntervalMs,
        maxConnectionAge: this.config.maxConnectionAge,
        maxLeakedConnections: this.config.maxLeakedConnections
      });
      
      this.healthChecker.start();
      
      // 4. Initialize Adaptive Manager
      this.adaptiveManager = new AdaptivePoolManager(this.pool, this.serviceName, {
        minSize: this.config.minPoolSize,
        maxSize: this.config.maxPoolSize,
        targetUtilization: this.config.targetUtilization,
        scaleUpThreshold: this.config.scaleUpThreshold,
        scaleDownThreshold: this.config.scaleDownThreshold
      });
      
      // 5. Setup event forwarding
      this._setupEventForwarding();
      
      this.initialized = true;
      
      const duration = Date.now() - startTime;
      
      logger.info({
        service: this.serviceName,
        duration
      }, 'IntelligentPoolManager initialized successfully');
      
      this.emit('initialized', {
        duration,
        config: this.config
      });
      
      return {
        success: true,
        duration
      };
      
    } catch (error) {
      logger.error({
        service: this.serviceName,
        error: error.message
      }, 'Failed to initialize IntelligentPoolManager');
      
      throw error;
    }
  }
  
  /**
   * Setup event forwarding from subsystems
   */
  _setupEventForwarding() {
    // Preheater events
    this.preheater.on('preheated', (data) => {
      this.emit('preheated', data);
    });
    
    // Health Checker events
    this.healthChecker.on('health_changed', (data) => {
      this.emit('health_changed', data);
    });
    
    this.healthChecker.on('recovered', (data) => {
      this.emit('recovered', data);
    });
    
    this.healthChecker.on('recovery_failed', (data) => {
      this.emit('recovery_failed', data);
    });
    
    this.healthChecker.on('metrics', (data) => {
      this.emit('metrics', data);
    });
    
    // Adaptive Manager events
    this.adaptiveManager.on('scale_up', (data) => {
      this.emit('scale_up', data);
    });
    
    this.adaptiveManager.on('scale_down', (data) => {
      this.emit('scale_down', data);
    });
  }
  
  /**
   * Get comprehensive status
   */
  getStatus() {
    if (!this.initialized) {
      return {
        serviceName: this.serviceName,
        initialized: false
      };
    }
    
    const preheaterStatus = this.preheater.getStatus();
    const healthStatus = this.healthChecker.getStatus();
    const adaptiveStatus = this.adaptiveManager.getStatus();
    
    return {
      serviceName: this.serviceName,
      initialized: this.initialized,
      
      // Pool metrics
      pool: {
        total: adaptiveStatus.totalConnections,
        idle: adaptiveStatus.idleConnections,
        waiting: adaptiveStatus.waitingClients,
        utilization: adaptiveStatus.utilization,
        currentSize: adaptiveStatus.currentSize
      },
      
      // Preheater status
      preheater: {
        isPreheated: preheaterStatus.isPreheated,
        minConnections: preheaterStatus.minConnections
      },
      
      // Health status
      health: {
        isHealthy: healthStatus.isHealthy,
        recoveryAttempts: healthStatus.recoveryAttempts,
        leakedConnections: healthStatus.leakedConnections.length
      },
      
      // Adaptive status
      adaptive: {
        currentSize: adaptiveStatus.currentSize,
        minSize: adaptiveStatus.minSize,
        maxSize: adaptiveStatus.maxSize,
        avgUtilization: adaptiveStatus.avgUtilization,
        timeMultiplier: adaptiveStatus.timeMultiplier
      },
      
      // Configuration
      config: {
        peakHours: this.config.peakHours,
        preheatMinutes: this.config.preheatMinutes
      }
    };
  }
  
  /**
   * Manual preheat (for admin API)
   */
  async manualPreheat(connections = this.config.minConnections) {
    if (!this.initialized || !this.preheater) {
      throw new Error('IntelligentPoolManager not initialized');
    }
    
    return await this.preheater.manualPreheat(connections);
  }
  
  /**
   * Preheat for event (for admin API)
   */
  async preheatForEvent(eventConfig) {
    if (!this.initialized || !this.preheater) {
      throw new Error('IntelligentPoolManager not initialized');
    }
    
    return await this.preheater.preheatForEvent(eventConfig);
  }
  
  /**
   * Force health check (for admin API)
   */
  async forceHealthCheck() {
    if (!this.initialized || !this.healthChecker) {
      throw new Error('IntelligentPoolManager not initialized');
    }
    
    return await this.healthChecker.forceCheck();
  }
  
  /**
   * Resize pool (for admin API)
   */
  async resizePool(newSize) {
    if (!this.initialized || !this.adaptiveManager) {
      throw new Error('IntelligentPoolManager not initialized');
    }
    
    logger.info({
      service: this.serviceName,
      newSize
    }, 'Manual pool resize requested');
    
    // Update adaptive manager's current size
    const oldSize = this.adaptiveManager.currentSize;
    this.adaptiveManager.currentSize = Math.min(
      Math.max(newSize, this.config.minPoolSize),
      this.config.maxPoolSize
    );
    
    await this.adaptiveManager.resizePool(this.adaptiveManager.currentSize);
    
    return {
      success: true,
      from: oldSize,
      to: this.adaptiveManager.currentSize
    };
  }
  
  /**
   * Export Prometheus metrics
   */
  getPrometheusMetrics() {
    if (!this.initialized) {
      return '';
    }
    
    const status = this.getStatus();
    
    const metrics = [
      `# HELP db_pool_healthy Database connection pool health status`,
      `# TYPE db_pool_healthy gauge`,
      `db_pool_healthy{service="${this.serviceName}"} ${status.health.isHealthy ? 1 : 0}`,
      
      `# HELP db_pool_total_connections Total database connections`,
      `# TYPE db_pool_total_connections gauge`,
      `db_pool_total_connections{service="${this.serviceName}"} ${status.pool.total}`,
      
      `# HELP db_pool_idle_connections Idle database connections`,
      `# TYPE db_pool_idle_connections gauge`,
      `db_pool_idle_connections{service="${this.serviceName}"} ${status.pool.idle}`,
      
      `# HELP db_pool_waiting_connections Waiting for database connections`,
      `# TYPE db_pool_waiting_connections gauge`,
      `db_pool_waiting_connections{service="${this.serviceName}"} ${status.pool.waiting}`,
      
      `# HELP db_pool_utilization Database connection pool utilization`,
      `# TYPE db_pool_utilization gauge`,
      `db_pool_utilization{service="${this.serviceName}"} ${status.pool.utilization}`,
      
      `# HELP db_pool_current_size Current target pool size`,
      `# TYPE db_pool_current_size gauge`,
      `db_pool_current_size{service="${this.serviceName}"} ${status.pool.currentSize}`,
      
      `# HELP db_pool_leak_detected Detected connection leaks`,
      `# TYPE db_pool_leak_detected gauge`,
      `db_pool_leak_detected{service="${this.serviceName}"} ${status.health.leakedConnections}`,
      
      `# HELP db_pool_preheated Pool preheating status`,
      `# TYPE db_pool_preheated gauge`,
      `db_pool_preheated{service="${this.serviceName}"} ${status.preheater.isPreheated ? 1 : 0}`
    ];
    
    return metrics.join('\n') + '\n';
  }
  
  /**
   * Get history (for admin API)
   */
  getHistory() {
    if (!this.initialized) {
      return {
        health: [],
        scale: [],
        preheat: []
      };
    }
    
    return {
      health: this.healthChecker.getHistory(20),
      scale: this.adaptiveManager.getScaleHistory(20),
      preheat: this.preheater.preheatHistory.slice(-20)
    };
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info({
      service: this.serviceName
    }, 'Shutting down IntelligentPoolManager');
    
    // Destroy subsystems
    if (this.preheater) {
      this.preheater.destroy();
    }
    
    if (this.healthChecker) {
      this.healthChecker.destroy();
    }
    
    if (this.adaptiveManager) {
      this.adaptiveManager.destroy();
    }
    
    this.initialized = false;
    
    this.emit('shutdown');
    
    logger.info({
      service: this.serviceName
    }, 'IntelligentPoolManager shutdown complete');
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create and initialize an IntelligentPoolManager
 */
async function createIntelligentPoolManager(pool, serviceName, options = {}) {
  const manager = new IntelligentPoolManager(pool, serviceName, options);
  await manager.initialize();
  return manager;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  IntelligentPoolManager,
  createIntelligentPoolManager,
  PoolPreheater,
  PoolHealthChecker
};